import {
  MetaMediaError,
  type MetaMediaRequest,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import {
  ObjectStorageError,
  type PutObjectInput,
} from '../domain/object-storage.port';
import type {
  AmountBootstrapInput,
  AmountBootstrapOutcome,
  AttemptStartResult,
  DownloadCommitInput,
  DownloadCommitOutcome,
  LeaseFenceInput,
} from '../domain/receipt-media-store.port';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../domain/receipt-media.types';
import {
  CapabilityService,
  type CapabilityTokenResult,
} from './capability.service';
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

const fixture = (
  over: Partial<ReceiptMediaRow> = {},
  capability: Pick<CapabilityService, 'issue'> = {
    issue: jest.fn<CapabilityTokenResult, [string]>(() => ({
      token: 'raw-capability-token',
      tokenHash: Buffer.alloc(32, 8),
      keyVersion: 2,
    })),
  },
) => {
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
  const store = {
    startMetaAttempt: jest.fn<
      Promise<AttemptStartResult | null>,
      [LeaseFenceInput]
    >(() => Promise.resolve({ attempt: 1, version: '2' })),
    startStorageAttempt: jest.fn<
      Promise<AttemptStartResult | null>,
      [LeaseFenceInput]
    >(() => Promise.resolve({ attempt: 1, version: '3' })),
    commitDownload: jest.fn<
      Promise<DownloadCommitOutcome>,
      [DownloadCommitInput]
    >(() => Promise.resolve({ kind: 'committed' })),
    bootstrapAmount: jest.fn<
      Promise<AmountBootstrapOutcome>,
      [AmountBootstrapInput]
    >(() =>
      Promise.resolve({
        kind: 'bootstrapped',
        receipt,
        intent: {} as ReceiptMediaOutboxRow,
      }),
    ),
  };

  const processor = new ReceiptIngestionProcessor(
    meta,
    storage,
    store,
    capability,
  );
  return {
    receipt,
    cleanup,
    file,
    processor,
    meta,
    storage,
    store,
    capability,
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
    expect(f.store.commitDownload).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    releaseCleanup();
    const seq = [
      f.store.startMetaAttempt.mock.invocationCallOrder[0],
      f.meta.resolveAndDownload.mock.invocationCallOrder[0],
    ];
    seq.push(
      f.cleanup.mock.invocationCallOrder[0],
      f.store.commitDownload.mock.invocationCallOrder[0],
    );
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    await expect(run).resolves.toEqual({ kind: 'downloaded' });
  });

  it('commits only validated download evidence after cleanup with no R2 behavior', async () => {
    const f = fixture();
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'downloaded',
    });
    expect(f.store.commitDownload).toHaveBeenCalledWith({
      id: 'r1',
      owner: 'w1',
      expectedVersion: '2',
      responseMimeType: 'image/jpeg',
      detectedMimeType: 'image/jpeg',
      byteCount: 5,
      contentSha256: Buffer.alloc(32, 7),
    });
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.store.bootstrapAmount).not.toHaveBeenCalled();
  });

  it('propagates a store error only after required cleanup', async () => {
    const f = fixture();
    f.store.commitDownload.mockRejectedValue(new Error('db-down'));
    await expect(f.processor.process(f.receipt, 'w1')).rejects.toThrow(
      'db-down',
    );
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.storage.put).not.toHaveBeenCalled();
  });

  it('treats a proven store replay as a closed download success', async () => {
    const f = fixture();
    f.store.commitDownload.mockResolvedValue({ kind: 'replayed' });
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'downloaded',
    });
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.store.bootstrapAmount).not.toHaveBeenCalled();
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
    expect(f.store.commitDownload).toHaveBeenCalledTimes(3);
  });

  it('fails safe with no transition when temp cleanup rejects', async () => {
    const f = fixture();
    f.cleanup.mockRejectedValue(new Error('raw-unlink-diagnostics'));
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'cleanup-failed',
    });
    expect(f.store.commitDownload).not.toHaveBeenCalled();
  });

  it('cleans up and stops without stale mutation when the fence is lost', async () => {
    const f = fixture();
    f.store.commitDownload.mockResolvedValue({ kind: 'fenced' });
    expect(await f.processor.process(f.receipt, 'w1')).toEqual({
      kind: 'fence-lost',
      stage: 'download',
    });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.store.startMetaAttempt).toHaveBeenCalledTimes(1);
    expect(f.store.commitDownload).toHaveBeenCalledTimes(1);
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
    expect(f.store.commitDownload).not.toHaveBeenCalled();
  });
});

describe('ReceiptIngestionProcessor DOWNLOADED pass (WU8A2a)', () => {
  it('bootstraps hash-only capability evidence after cleanup', async () => {
    const id = '1c0fac1e-5f0e-4a1e-9c1d-2b3c4d5e6f70';
    const capability = new CapabilityService(
      new Map([[1, Buffer.alloc(32, 1)]]),
      1,
    );
    const issue = jest.spyOn(capability, 'issue');
    const f = fixture({ id, status: 'DOWNLOADED' }, capability);
    f.storage.put.mockResolvedValue({ etag: 'first-etag', versionId: 'v1' });

    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'stored',
    });

    const issued = issue.mock.results[0]?.value as CapabilityTokenResult;
    const input = f.store.bootstrapAmount.mock.calls[0][0];
    expect(input).toEqual({
      id,
      owner: 'w1',
      expectedVersion: '3',
      objectEtag: 'first-etag',
      objectVersionId: 'v1',
      capabilityTokenHash: issued.tokenHash,
      capabilityKeyVersion: 1,
    });
    expect(input).not.toHaveProperty('token');
    const reconstructed = capability.reconstruct(
      id,
      input.capabilityKeyVersion,
      input.capabilityTokenHash,
    );
    expect(reconstructed?.token).toBe(issued.token);
    expect(f.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      issue.mock.invocationCallOrder[0],
    );
    expect(issue.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.bootstrapAmount.mock.invocationCallOrder[0],
    );
  });

  it('uses the retry winner evidence and a fresh stream', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    const issue = jest.spyOn(f.capability, 'issue');
    let firstStream: PutObjectInput['content'] | null = null;
    f.storage.put.mockImplementation((input) => {
      if (firstStream === null) {
        firstStream = input.content;
        return Promise.reject(
          new ObjectStorageError('OBJECT_STORAGE', 'HTTP_RETRYABLE'),
        );
      }
      input.content.destroy();
      return Promise.resolve({ etag: 'retry-etag', versionId: null });
    });
    f.store.startStorageAttempt
      .mockResolvedValueOnce({ attempt: 1, version: '3' })
      .mockResolvedValueOnce({ attempt: 2, version: '4' });

    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'stored',
    });

    const streams = f.storage.put.mock.calls.map(([input]) => input.content);
    expect(streams[0].destroyed).toBe(true);
    expect(new Set(streams).size).toBe(2);
    expect(f.store.bootstrapAmount).toHaveBeenCalledWith({
      id: 'r1',
      owner: 'w1',
      expectedVersion: '4',
      objectEtag: 'retry-etag',
      objectVersionId: null,
      capabilityTokenHash: Buffer.alloc(32, 8),
      capabilityKeyVersion: 2,
    });
    expect(f.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      issue.mock.invocationCallOrder[0],
    );
  });

  it('maps bootstrap replay to stored and a fenced bootstrap to fence-lost/tx2', async () => {
    const replayed = fixture({ status: 'DOWNLOADED' });
    replayed.store.bootstrapAmount.mockResolvedValue({
      kind: 'replayed',
      receipt: replayed.receipt,
      intent: {} as ReceiptMediaOutboxRow,
    });
    await expect(
      replayed.processor.process(replayed.receipt, 'w1'),
    ).resolves.toEqual({ kind: 'stored' });

    const fenced = fixture({ status: 'DOWNLOADED' });
    fenced.store.bootstrapAmount.mockResolvedValue({ kind: 'fenced' });
    await expect(
      fenced.processor.process(fenced.receipt, 'w1'),
    ).resolves.toEqual({
      kind: 'fence-lost',
      stage: 'tx2',
    });
  });

  it('stops after cleanup failure without issuing or bootstrapping', async () => {
    const f = fixture({ status: 'DOWNLOADED' });
    const issue = jest.spyOn(f.capability, 'issue');
    f.cleanup.mockRejectedValue(new Error('raw-unlink-diagnostics'));
    await expect(f.processor.process(f.receipt, 'w1')).resolves.toEqual({
      kind: 'cleanup-failed',
    });
    expect(issue).not.toHaveBeenCalled();
    expect(f.store.bootstrapAmount).not.toHaveBeenCalled();
  });

  it('propagates capability and bootstrap failures only after cleanup', async () => {
    const capabilityFailure = fixture({ status: 'DOWNLOADED' });
    const issue = jest
      .spyOn(capabilityFailure.capability, 'issue')
      .mockImplementation(() => {
        throw new Error('capability-down');
      });
    await expect(
      capabilityFailure.processor.process(capabilityFailure.receipt, 'w1'),
    ).rejects.toThrow('capability-down');
    expect(capabilityFailure.cleanup).toHaveBeenCalledTimes(1);
    expect(capabilityFailure.store.bootstrapAmount).not.toHaveBeenCalled();
    expect(issue.mock.invocationCallOrder[0]).toBeGreaterThan(
      capabilityFailure.cleanup.mock.invocationCallOrder[0],
    );

    const bootstrapFailure = fixture({ status: 'DOWNLOADED' });
    bootstrapFailure.store.bootstrapAmount.mockRejectedValue(
      new Error('bootstrap-down'),
    );
    await expect(
      bootstrapFailure.processor.process(bootstrapFailure.receipt, 'w1'),
    ).rejects.toThrow('bootstrap-down');
    expect(bootstrapFailure.cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves null-meta, retry, and storage fence gates before bootstrap', async () => {
    const meta = fixture({ status: 'DOWNLOADED' });
    meta.store.startMetaAttempt.mockResolvedValue(null);
    await expect(meta.processor.process(meta.receipt, 'w1')).resolves.toEqual({
      kind: 'blocked',
      stage: 'meta',
    });
    expect(meta.cleanup).not.toHaveBeenCalled();

    const retry = fixture({ status: 'DOWNLOADED' });
    retry.storage.put.mockRejectedValue(
      new ObjectStorageError('OBJECT_STORAGE', 'HTTP_RETRYABLE'),
    );
    retry.store.startStorageAttempt
      .mockResolvedValueOnce({ attempt: 1, version: '3' })
      .mockResolvedValueOnce({ attempt: 2, version: '4' })
      .mockResolvedValueOnce({ attempt: 3, version: '5' })
      .mockResolvedValue(null);
    await expect(retry.processor.process(retry.receipt, 'w1')).resolves.toEqual(
      { kind: 'blocked', stage: 'storage' },
    );
    expect(retry.store.bootstrapAmount).not.toHaveBeenCalled();
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
    expect(f.store.commitDownload).not.toHaveBeenCalled();
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
    expect(f.store.bootstrapAmount).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(put.abortSignal).toBe(controller.signal);
    expect(put.cleanupSignal).not.toBe(controller.signal);
    expect(put.cleanupSignal.aborted).toBe(false);
  });
});
