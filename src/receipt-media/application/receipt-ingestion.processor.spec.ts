import {
  MetaMediaError,
  type MetaMediaRequest,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import {
  ObjectStorageError,
  type PutObjectInput,
} from '../domain/object-storage.port';
import { ReceiptMediaError } from '../domain/receipt-media.errors';
import type {
  AttemptStartResult,
  LeaseFenceInput,
  OutboxIntentInput,
  StatusCasInput,
} from '../domain/receipt-media-store.port';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';
import type {
  ReceiptTx2CommitResult,
  ReceiptTx2Request,
} from './receipt-outbox.service';
import { ReceiptIngestionProcessor } from './receipt-ingestion.processor';

const flush = () => new Promise<void>((r) => setImmediate(r));

const row = (over: Partial<ReceiptMediaRow> = {}): ReceiptMediaRow =>
  ({
    id: 'r1',
    webhookMessageId: 'wamid',
    providerMediaId: 'm1',
    senderId: 's1',
    objectKey: 'receipts/1c0fac1e-5f0e-4a1e-9c1d-2b3c4d5e6f70',
    status: 'RESERVED',
    version: '1',
    declaredMimeType: 'image/jpeg',
    ...over,
  }) as ReceiptMediaRow;

const fixture = (over: Partial<ReceiptMediaRow> = {}) => {
  const receipt = row(over);
  const cleanup = jest.fn(() => Promise.resolve());
  const file = {
    filePath: 'package.json',
    mimeType: 'image/jpeg',
    byteCount: 5,
    providerDeclaredBytes: 5,
    sha256: Buffer.alloc(32, 7),
    cleanup,
  } as ValidatedMediaFile;
  const meta = {
    resolveAndDownload: jest.fn<
      Promise<ValidatedMediaFile>,
      [MetaMediaRequest]
    >(() => Promise.resolve(file)),
  };
  const storage = {
    put: jest.fn<
      Promise<{ etag: string; versionId: string | null }>,
      [PutObjectInput]
    >((input) => {
      input.content.destroy();
      return Promise.resolve({ etag: 'e', versionId: null });
    }),
  };
  const tx2 = {
    commitTransitionWithIntent: jest.fn<
      Promise<ReceiptTx2CommitResult>,
      [ReceiptTx2Request & { intent: OutboxIntentInput }]
    >(() => {
      return Promise.resolve({
        kind: 'committed',
        created: true,
        intent: {} as ReceiptMediaOutboxRow,
      });
    }),
  };
  const store = {
    startMetaAttempt: jest.fn<
      Promise<AttemptStartResult | null>,
      [LeaseFenceInput]
    >(() => Promise.resolve({ attempt: 1, version: '2' })),
    startStorageAttempt: jest.fn<
      Promise<AttemptStartResult | null>,
      [LeaseFenceInput]
    >(() => Promise.resolve({ attempt: 1, version: '3' })),
    transitionStatus: jest.fn<Promise<boolean>, [StatusCasInput]>(() =>
      Promise.resolve(true),
    ),
  };
  const processor = new ReceiptIngestionProcessor(meta, storage, store, tx2);
  return {
    receipt,
    cleanup,
    file,
    processor,
    meta,
    storage,
    store,
    tx2,
  };
};

describe('ReceiptIngestionProcessor RESERVED pass (WU8A1)', () => {
  it('processes only a claimed RESERVED row', async () => {
    const f = fixture({ status: 'STORED' });
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'unsupported-claimed-status',
      status: 'STORED',
    });
    expect(f.store.startMetaAttempt).not.toHaveBeenCalled();
    expect(f.meta.resolveAndDownload).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  // Seam proof: Meta and cleanup run between store transactions; cleanup precedes the fence.
  it('calls no Meta while the CAS seam is pending and awaits temp cleanup', async () => {
    const f = fixture();
    let release!: (value: AttemptStartResult | null) => void;
    const gate = new Promise<AttemptStartResult | null>((r) => (release = r));
    f.store.startMetaAttempt.mockImplementationOnce(() => gate);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((r) => (releaseCleanup = r));
    f.cleanup.mockImplementation(() => cleanupGate);
    let settled = false;
    const run = f.processor.process(f.receipt, 'w1');
    void run.then(() => (settled = true));
    await flush();
    expect(f.meta.resolveAndDownload).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    release({ attempt: 1, version: '2' });
    await flush();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.store.transitionStatus).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    releaseCleanup();
    const seq = [
      f.store.startMetaAttempt.mock.invocationCallOrder[0],
      f.meta.resolveAndDownload.mock.invocationCallOrder[0],
    ];
    seq.push(
      f.cleanup.mock.invocationCallOrder[0],
      f.store.transitionStatus.mock.invocationCallOrder[0],
    );
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    await expect(run).resolves.toEqual({ kind: 'downloaded' });
  });

  it('runs Meta on attempts 1/2/3 and a null CAS blocks the fourth', async () => {
    const f = fixture();
    f.store.startMetaAttempt
      .mockResolvedValueOnce({ attempt: 1, version: '2' })
      .mockResolvedValueOnce({ attempt: 2, version: '3' })
      .mockResolvedValueOnce({ attempt: 3, version: '4' })
      .mockResolvedValue(null);
    for (let i = 0; i < 3; i += 1) await f.processor.process(f.receipt, 'w1');
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'blocked',
      stage: 'meta',
    });
    expect(f.store.startMetaAttempt).toHaveBeenCalledTimes(4);
    expect(f.meta.resolveAndDownload).toHaveBeenCalledTimes(3);
    expect(f.store.transitionStatus).toHaveBeenCalledTimes(3);
  });

  it('fails safe with no transition when temp cleanup rejects', async () => {
    const f = fixture();
    f.cleanup.mockRejectedValue(new Error('raw-unlink-diagnostics'));
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'cleanup-failed',
    });
    expect(f.store.transitionStatus).not.toHaveBeenCalled();
  });

  it('cleans up and stops without stale mutation when the fence is lost', async () => {
    const f = fixture();
    f.store.transitionStatus.mockResolvedValue(false);
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'fence-lost',
      stage: 'download',
    });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.store.startMetaAttempt).toHaveBeenCalledTimes(1);
    expect(f.store.transitionStatus).toHaveBeenCalledTimes(1);
  });

  it('maps Meta validation failure to a fixed meta-failed stage', async () => {
    const f = fixture();
    f.meta.resolveAndDownload.mockRejectedValue(
      new MetaMediaError('MEDIA_VALIDATION', 'MIME_MISMATCH'),
    );
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'meta-failed',
      code: 'MIME_MISMATCH',
    });
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.store.transitionStatus).not.toHaveBeenCalled();
  });
});

describe('ReceiptIngestionProcessor DOWNLOADED pass (WU8A2a)', () => {
  it('re-downloads a DOWNLOADED row and uploads once on the reserved key', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    let firstStream: PutObjectInput['content'] | null = null;
    const destroyedAtRetry: boolean[] = [];
    f.storage.put.mockImplementation((input: PutObjectInput) => {
      destroyedAtRetry.push(firstStream?.destroyed ?? false);
      if (firstStream === null) {
        firstStream = input.content;
        return Promise.reject(
          new ObjectStorageError('OBJECT_STORAGE', 'HTTP_RETRYABLE'),
        );
      }
      input.content.destroy();
      return Promise.resolve({ etag: 'e', versionId: null });
    });
    let release!: (value: AttemptStartResult | null) => void;
    const gate = new Promise<AttemptStartResult | null>((r) => (release = r));
    f.store.startStorageAttempt
      .mockImplementationOnce(() => gate)
      .mockResolvedValueOnce({ attempt: 2, version: '4' });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((r) => (releaseCleanup = r));
    f.cleanup.mockImplementation(() => cleanupGate);
    const run = f.processor.process(f.receipt, 'w1');
    await flush();
    expect(f.storage.put).not.toHaveBeenCalled();
    release({ attempt: 1, version: '3' });
    await flush();
    expect(f.tx2.commitTransitionWithIntent).not.toHaveBeenCalled();
    releaseCleanup();
    await expect(run).resolves.toEqual({ kind: 'stored' });
    expect(destroyedAtRetry[1]).toBe(true);
    const tx2 = f.tx2.commitTransitionWithIntent.mock.calls[0][0];
    expect(tx2.transition).toEqual({
      id: 'r1',
      owner: 'w1',
      expectedStatus: 'DOWNLOADED',
      expectedVersion: '4',
      nextStatus: 'STORED',
    });
    expect(tx2).toMatchObject({
      templateKey: 'RECEIPT_AMOUNT_PROMPT',
      sourceWebhookMessageId: 'wamid',
      recipientId: 's1',
    });
    expect(tx2.intent.dedupeKey).toBe(
      'receipt:RECEIPT_AMOUNT_PROMPT:wamid:r1:4',
    );
    expect(f.storage.put.mock.calls.map(([input]) => input.key)).toEqual([
      f.receipt.objectKey,
      f.receipt.objectKey,
    ]);
    const seq = [
      f.store.startMetaAttempt.mock.invocationCallOrder[0],
      f.meta.resolveAndDownload.mock.invocationCallOrder[0],
      f.store.startStorageAttempt.mock.invocationCallOrder[0],
      f.storage.put.mock.invocationCallOrder[0],
      f.cleanup.mock.invocationCallOrder[0],
    ];
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    const put = f.storage.put.mock.calls[0][0];
    expect(put).toMatchObject({
      key: f.receipt.objectKey,
      byteCount: 5,
      mimeType: 'image/jpeg',
      sha256: Buffer.alloc(32, 7),
    });
    expect((put.content as unknown as { path: unknown }).path).toBe(
      'package.json',
    );
    expect(put.abortSignal).toBeInstanceOf(AbortSignal);
    expect(put.cleanupSignal).toBeInstanceOf(AbortSignal);
    expect(put.abortSignal).not.toBe(put.cleanupSignal);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('blocks Meta and storage on a null reconstruction CAS', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    f.store.startMetaAttempt.mockResolvedValue(null);
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'blocked',
      stage: 'meta',
    });
    expect(f.meta.resolveAndDownload).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it('consumes storage attempts 1/2/3; a null CAS blocks the fourth put', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    f.storage.put.mockRejectedValue(
      new ObjectStorageError('OBJECT_STORAGE', 'PERMANENT_FAILURE'),
    );
    f.store.startStorageAttempt
      .mockResolvedValueOnce({ attempt: 1, version: '3' })
      .mockResolvedValueOnce({ attempt: 2, version: '4' })
      .mockResolvedValueOnce({ attempt: 3, version: '5' })
      .mockResolvedValue(null);
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'storage-failed',
      code: 'PERMANENT_FAILURE',
    });
    for (let i = 0; i < 2; i += 1) await f.processor.process(f.receipt, 'w1');
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'blocked',
      stage: 'storage',
    });
    expect(f.store.startStorageAttempt).toHaveBeenCalledTimes(4);
    expect(f.storage.put).toHaveBeenCalledTimes(3);
    expect(f.meta.resolveAndDownload).toHaveBeenCalledTimes(4);
    expect(f.cleanup).toHaveBeenCalledTimes(4);
  });

  it('returns cleanup-failed with no retry when temp cleanup rejects', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    f.cleanup.mockRejectedValue(new Error('raw-unlink-diagnostics'));
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'cleanup-failed',
    });
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.tx2.commitTransitionWithIntent).not.toHaveBeenCalled();
  });

  it('yields fence-lost/tx2 without stale follow-up when TX2 loses', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    f.tx2.commitTransitionWithIntent.mockResolvedValue({
      kind: 'transition-lost',
    });
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'fence-lost',
      stage: 'tx2',
    });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.tx2.commitTransitionWithIntent).toHaveBeenCalledTimes(1);
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.store.startStorageAttempt).toHaveBeenCalledTimes(1);
  });

  it('propagates TX2 commit failures after cleanup for the worker retry', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    f.tx2.commitTransitionWithIntent.mockRejectedValue(
      new ReceiptMediaError('RECEIPT_OUTBOX_TX2_FAILED', 'TX2_COMMIT_FAILED'),
    );
    await expect(f.processor.process(f.receipt, 'w1')).rejects.toThrow(
      'receipt-media:RECEIPT_OUTBOX_TX2_FAILED/TX2_COMMIT_FAILED',
    );
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('awaits cleanup exactly once and rethrows unexpected post-Meta errors', async () => {
    const cas = fixture({ status: 'DOWNLOADED' });
    cas.store.startStorageAttempt.mockRejectedValue(new Error('db-down'));
    await expect(cas.processor.process(cas.receipt, 'w1')).rejects.toThrow(
      'db-down',
    );
    expect(cas.cleanup).toHaveBeenCalledTimes(1);
    const str = fixture({ status: 'DOWNLOADED' });
    str.file.filePath = Number.NaN as unknown as string;
    await expect(str.processor.process(str.receipt, 'w1')).rejects.toThrow(
      'path',
    );
    expect(str.cleanup).toHaveBeenCalledTimes(1);
    const put = fixture({ status: 'DOWNLOADED' });
    put.storage.put.mockRejectedValue(new Error('s3-sdk-boom'));
    await expect(put.processor.process(put.receipt, 'w1')).rejects.toThrow(
      's3-sdk-boom',
    );
    expect(put.cleanup).toHaveBeenCalledTimes(1);
  });

  it('exhausts three same-key puts then blocks on a null CAS', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    f.storage.put.mockRejectedValue(
      new ObjectStorageError('OBJECT_STORAGE', 'HTTP_RETRYABLE'),
    );
    f.store.startStorageAttempt
      .mockResolvedValueOnce({ attempt: 1, version: '3' })
      .mockResolvedValueOnce({ attempt: 2, version: '4' })
      .mockResolvedValueOnce({ attempt: 3, version: '5' })
      .mockResolvedValue(null);
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'blocked',
      stage: 'storage',
    });
    expect(f.store.startStorageAttempt.mock.calls).toEqual([
      [{ id: 'r1', owner: 'w1', expectedVersion: '2' }],
      [{ id: 'r1', owner: 'w1', expectedVersion: '3' }],
      [{ id: 'r1', owner: 'w1', expectedVersion: '4' }],
      [{ id: 'r1', owner: 'w1', expectedVersion: '5' }],
    ]);
    const streams = f.storage.put.mock.calls.map(([input]) => input.content);
    expect(new Set(streams).size).toBe(3);
    streams.forEach((s) => expect(s.destroyed).toBe(true));
    expect(f.storage.put.mock.calls.map(([input]) => input.key)).toEqual([
      f.receipt.objectKey,
      f.receipt.objectKey,
      f.receipt.objectKey,
    ]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
});

// WU8B1: narrow signal-aware seam so a lifecycle worker can stop this
// processor safely; the default signal keeps existing callers unchanged.
describe('ReceiptIngestionProcessor cancellation seam (WU8B1)', () => {
  it('returns aborted/meta with no CAS attempt on a pre-aborted signal', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.processor.process(f.receipt, 'w1', controller.signal),
    ).toEqual({ kind: 'aborted', stage: 'meta' });
    expect(f.store.startMetaAttempt).not.toHaveBeenCalled();
    expect(f.meta.resolveAndDownload).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  });

  it('passes the parent signal to Meta and maps ABORTED to aborted/meta', async () => {
    const f = fixture();
    const controller = new AbortController();
    let seen!: AbortSignal;
    f.meta.resolveAndDownload.mockImplementationOnce((input) => {
      seen = input.signal;
      return Promise.reject(new MetaMediaError('META_TRANSPORT', 'ABORTED'));
    });
    expect(
      await f.processor.process(f.receipt, 'w1', controller.signal),
    ).toEqual({ kind: 'aborted', stage: 'meta' });
    expect(seen).toBe(controller.signal);
    expect(f.store.transitionStatus).not.toHaveBeenCalled();
  });

  it('aborts the storage retry loop without consuming further attempts', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    const controller = new AbortController();
    let put!: PutObjectInput;
    f.storage.put.mockImplementation((input: PutObjectInput) => {
      put = input;
      input.content.destroy();
      controller.abort();
      return Promise.reject(
        new ObjectStorageError('OBJECT_STORAGE', 'HTTP_RETRYABLE'),
      );
    });
    expect(
      await f.processor.process(f.receipt, 'w1', controller.signal),
    ).toEqual({ kind: 'aborted', stage: 'storage' });
    expect(f.store.startStorageAttempt).toHaveBeenCalledTimes(1);
    expect(f.storage.put).toHaveBeenCalledTimes(1);
    expect(f.tx2.commitTransitionWithIntent).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(put.abortSignal).toBe(controller.signal);
    expect(put.cleanupSignal).not.toBe(controller.signal);
    expect(put.cleanupSignal.aborted).toBe(false);
  });
});
