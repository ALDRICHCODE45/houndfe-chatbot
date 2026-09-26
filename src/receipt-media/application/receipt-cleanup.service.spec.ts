import {
  ObjectStorageError,
  type DeleteTechnicalObjectInput,
  type ObjectStorageErrorCode,
  type ObjectStoragePort,
} from '../domain/object-storage.port';
import type {
  CleanupDispositionInput,
  CleanupDispositionOutcome,
  ReceiptMediaStorePort,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import { ReceiptCleanupService } from './receipt-cleanup.service';

const OWNER = 'cleanup-owner-1';
const LIMIT = 7;

const RECEIPT_A = '11111111-1111-4111-8111-111111111111';
const RECEIPT_B = '22222222-2222-4222-8222-222222222222';
const RECEIPT_C = '33333333-3333-4333-8333-333333333333';

const KEY_A = 'receipts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'receipts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY_C = 'receipts/cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const RETRYABLE_CODES = [
  'ABORTED',
  'HTTP_RETRYABLE',
  'NETWORK_FAILURE',
] as const satisfies readonly ObjectStorageErrorCode[];

const PERMANENT_CODES = [
  'OBJECT_KEY_INVALID',
  'REQUEST_INVALID',
  'HTTP_PERMANENT',
  'PERMANENT_FAILURE',
] as const satisfies readonly ObjectStorageErrorCode[];

const NON_CLEANUP_CODES = [
  'RESPONSE_INVALID',
  'CLEANUP_PENDING',
  'OBJECT_NOT_FOUND',
] as const satisfies readonly ObjectStorageErrorCode[];

const claimedRow = (over: Partial<ReceiptMediaRow> = {}): ReceiptMediaRow =>
  ({
    id: RECEIPT_A,
    objectKey: KEY_A,
    status: 'FAILED',
    failureStage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
    version: '4',
    cleanupPending: true,
    cleanupAttempts: 1,
    ...over,
  }) as ReceiptMediaRow;

const cleaned = (receipt: ReceiptMediaRow): CleanupDispositionOutcome => ({
  kind: 'cleaned',
  attempt: 1,
  version: '5',
  receipt,
});

const retryScheduled = (
  receipt: ReceiptMediaRow,
): CleanupDispositionOutcome => ({
  kind: 'retry-scheduled',
  attempt: 1,
  version: '5',
  receipt,
});

const manualHold = (receipt: ReceiptMediaRow): CleanupDispositionOutcome => ({
  kind: 'manual-hold',
  attempt: 3,
  version: '5',
  receipt,
});

const FENCED: CleanupDispositionOutcome = { kind: 'fenced' };

type StoreKeys = 'claimCleanupBatch' | 'commitCleanupDisposition';
type StoreMock = jest.Mocked<Pick<ReceiptMediaStorePort, StoreKeys>>;
type StorageMock = jest.Mocked<
  Pick<ObjectStoragePort, 'deleteTechnicalObject'>
>;

describe('ReceiptCleanupService (ODD-2D2b)', () => {
  let store: StoreMock;
  let storage: StorageMock;
  let service: ReceiptCleanupService;

  beforeEach(() => {
    store = {
      claimCleanupBatch: jest.fn<
        Promise<ReceiptMediaRow[]>,
        [number, string]
      >(),
      commitCleanupDisposition: jest.fn<
        Promise<CleanupDispositionOutcome>,
        [CleanupDispositionInput]
      >(),
    };
    storage = {
      deleteTechnicalObject: jest.fn<
        Promise<void>,
        [DeleteTechnicalObjectInput]
      >(),
    };
    store.claimCleanupBatch.mockResolvedValue([]);
    service = new ReceiptCleanupService(store, storage);
  });

  it('claims one bounded batch with the exact limit and owner', async () => {
    store.claimCleanupBatch.mockResolvedValue([claimedRow()]);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(cleaned(claimedRow()));

    await service.runBatch(LIMIT, OWNER);

    expect(store.claimCleanupBatch).toHaveBeenCalledTimes(1);
    expect(store.claimCleanupBatch).toHaveBeenCalledWith(LIMIT, OWNER);
  });

  it('returns all-zero counts and touches nothing when the batch is empty', async () => {
    store.claimCleanupBatch.mockResolvedValue([]);

    const report = await service.runBatch(LIMIT, OWNER);

    expect(report).toEqual({
      claimed: 0,
      cleaned: 0,
      retryScheduled: 0,
      manualHold: 0,
      fenced: 0,
    });
    expect(storage.deleteTechnicalObject).not.toHaveBeenCalled();
    expect(store.commitCleanupDisposition).not.toHaveBeenCalled();
  });

  it('processes every claimed row sequentially in claim order', async () => {
    const rows = [
      claimedRow({ id: RECEIPT_A, objectKey: KEY_A }),
      claimedRow({ id: RECEIPT_B, objectKey: KEY_B }),
      claimedRow({ id: RECEIPT_C, objectKey: KEY_C }),
    ];
    store.claimCleanupBatch.mockResolvedValue(rows);
    const events: string[] = [];
    storage.deleteTechnicalObject.mockImplementation(async (input) => {
      events.push(`delete:${input.key}`);
    });
    store.commitCleanupDisposition.mockImplementation(async (input) => {
      events.push(`disposition:${input.id}`);
      return cleaned(claimedRow());
    });

    const report = await service.runBatch(LIMIT, OWNER);

    expect(events).toEqual([
      `delete:${KEY_A}`,
      `disposition:${RECEIPT_A}`,
      `delete:${KEY_B}`,
      `disposition:${RECEIPT_B}`,
      `delete:${KEY_C}`,
      `disposition:${RECEIPT_C}`,
    ]);
    expect(report.claimed).toBe(3);
    expect(report.cleaned).toBe(3);
  });

  it('forwards the exact retention tuple and caller signal, then commits deleted', async () => {
    const signal = new AbortController().signal;
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(cleaned(row));

    const report = await service.runBatch(LIMIT, OWNER, signal);

    expect(storage.deleteTechnicalObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteTechnicalObject).toHaveBeenCalledWith({
      key: KEY_A,
      status: 'FAILED',
      failureStage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      abortSignal: signal,
    });
    expect(store.commitCleanupDisposition).toHaveBeenCalledTimes(1);
    expect(store.commitCleanupDisposition).toHaveBeenCalledWith({
      id: RECEIPT_A,
      owner: OWNER,
      expectedVersion: '4',
      outcome: 'deleted',
    });
    expect(report).toEqual({
      claimed: 1,
      cleaned: 1,
      retryScheduled: 0,
      manualHold: 0,
      fenced: 0,
    });
  });

  it('supplies a fresh non-aborted signal when the caller supplies none', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(cleaned(row));

    await service.runBatch(LIMIT, OWNER);

    const input = storage.deleteTechnicalObject.mock.calls[0][0];
    expect(input.abortSignal).toBeInstanceOf(AbortSignal);
    expect(input.abortSignal.aborted).toBe(false);
    expect(store.commitCleanupDisposition).toHaveBeenCalledWith({
      id: RECEIPT_A,
      owner: OWNER,
      expectedVersion: '4',
      outcome: 'deleted',
    });
  });

  it('forwards an already-aborted caller signal unchanged rather than substituting one', async () => {
    const controller = new AbortController();
    controller.abort();
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(cleaned(row));

    await service.runBatch(LIMIT, OWNER, controller.signal);

    expect(storage.deleteTechnicalObject.mock.calls[0][0].abortSignal).toBe(
      controller.signal,
    );
  });

  it('treats a resolved delete (adapter-folded exact 404) as success without re-modelling it', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    // The adapter folds an exact structured 404 into an idempotent resolve.
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(cleaned(row));

    const report = await service.runBatch(LIMIT, OWNER);

    expect(store.commitCleanupDisposition).toHaveBeenCalledTimes(1);
    expect(store.commitCleanupDisposition.mock.calls[0][0]).toEqual({
      id: RECEIPT_A,
      owner: OWNER,
      expectedVersion: '4',
      outcome: 'deleted',
    });
    expect(report.cleaned).toBe(1);
    expect(report.manualHold).toBe(0);
  });

  it.each(RETRYABLE_CODES)(
    'forwards the retryable code %s unchanged and counts the scheduled retry',
    async (code) => {
      const row = claimedRow();
      store.claimCleanupBatch.mockResolvedValue([row]);
      storage.deleteTechnicalObject.mockRejectedValue(
        new ObjectStorageError('OBJECT_STORAGE', code),
      );
      store.commitCleanupDisposition.mockResolvedValue(retryScheduled(row));

      const report = await service.runBatch(LIMIT, OWNER);

      expect(store.commitCleanupDisposition).toHaveBeenCalledWith({
        id: RECEIPT_A,
        owner: OWNER,
        expectedVersion: '4',
        outcome: 'failed',
        category: 'OBJECT_STORAGE',
        code,
      });
      expect(report).toEqual({
        claimed: 1,
        cleaned: 0,
        retryScheduled: 1,
        manualHold: 0,
        fenced: 0,
      });
    },
  );

  it.each(PERMANENT_CODES)(
    'forwards the permanent code %s unchanged and counts the manual hold',
    async (code) => {
      const row = claimedRow();
      store.claimCleanupBatch.mockResolvedValue([row]);
      storage.deleteTechnicalObject.mockRejectedValue(
        new ObjectStorageError('OBJECT_STORAGE', code),
      );
      store.commitCleanupDisposition.mockResolvedValue(manualHold(row));

      const report = await service.runBatch(LIMIT, OWNER);

      expect(store.commitCleanupDisposition).toHaveBeenCalledWith({
        id: RECEIPT_A,
        owner: OWNER,
        expectedVersion: '4',
        outcome: 'failed',
        category: 'OBJECT_STORAGE',
        code,
      });
      expect(report.manualHold).toBe(1);
      expect(report.retryScheduled).toBe(0);
    },
  );

  it('maps retry, manual-hold, and fenced store outcomes into their aggregate counts', async () => {
    const rows = [
      claimedRow({ id: RECEIPT_A, objectKey: KEY_A }),
      claimedRow({ id: RECEIPT_B, objectKey: KEY_B }),
      claimedRow({ id: RECEIPT_C, objectKey: KEY_C }),
    ];
    store.claimCleanupBatch.mockResolvedValue(rows);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition
      .mockResolvedValueOnce(retryScheduled(rows[0]))
      .mockResolvedValueOnce(manualHold(rows[1]))
      .mockResolvedValueOnce(FENCED);

    const report = await service.runBatch(LIMIT, OWNER);

    expect(report).toEqual({
      claimed: 3,
      cleaned: 0,
      retryScheduled: 1,
      manualHold: 1,
      fenced: 1,
    });
  });

  it.each(NON_CLEANUP_CODES)(
    'normalizes the non-cleanup ObjectStorageError code %s to a PERMANENT_FAILURE manual hold',
    async (code) => {
      const row = claimedRow();
      store.claimCleanupBatch.mockResolvedValue([row]);
      storage.deleteTechnicalObject.mockRejectedValue(
        new ObjectStorageError('OBJECT_STORAGE', code),
      );
      store.commitCleanupDisposition.mockResolvedValue(manualHold(row));

      const report = await service.runBatch(LIMIT, OWNER);

      expect(store.commitCleanupDisposition).toHaveBeenCalledWith({
        id: RECEIPT_A,
        owner: OWNER,
        expectedVersion: '4',
        outcome: 'failed',
        category: 'OBJECT_STORAGE',
        code: 'PERMANENT_FAILURE',
      });
      expect(report.manualHold).toBe(1);
    },
  );

  it('normalizes an arbitrary thrown value to a safe PERMANENT_FAILURE disposition without leaking provider text', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockRejectedValue(
      new Error('raw provider secret body: access-key=abc123'),
    );
    store.commitCleanupDisposition.mockResolvedValue(manualHold(row));

    const report = await service.runBatch(LIMIT, OWNER);

    expect(store.commitCleanupDisposition).toHaveBeenCalledWith({
      id: RECEIPT_A,
      owner: OWNER,
      expectedVersion: '4',
      outcome: 'failed',
      category: 'OBJECT_STORAGE',
      code: 'PERMANENT_FAILURE',
    });
    expect(JSON.stringify(report)).not.toContain('access-key');
    expect(JSON.stringify(report)).not.toContain('abc123');
  });

  it('normalizes a non-Error thrown value to a safe PERMANENT_FAILURE disposition', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockRejectedValue('unexpected-string');
    store.commitCleanupDisposition.mockResolvedValue(manualHold(row));

    await service.runBatch(LIMIT, OWNER);

    expect(store.commitCleanupDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failed',
        category: 'OBJECT_STORAGE',
        code: 'PERMANENT_FAILURE',
      }),
    );
  });

  it('forwards each claimed row its own key, retention tuple, and version fence', async () => {
    const rows = [
      claimedRow({
        id: RECEIPT_A,
        objectKey: KEY_A,
        version: '4',
        status: 'FAILED',
        failureStage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      }),
      claimedRow({
        id: RECEIPT_B,
        objectKey: KEY_B,
        version: '11',
        status: 'FAILED',
        failureStage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      }),
    ];
    store.claimCleanupBatch.mockResolvedValue(rows);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(cleaned(rows[0]));

    await service.runBatch(LIMIT, OWNER);

    const deletes = storage.deleteTechnicalObject.mock.calls.map(
      ([request]) => request,
    );
    expect(deletes.map((request) => request.key)).toEqual([KEY_A, KEY_B]);
    expect(deletes.map((request) => request.status)).toEqual([
      'FAILED',
      'FAILED',
    ]);
    expect(deletes.map((request) => request.failureStage)).toEqual([
      'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
    ]);
    for (const request of deletes) {
      expect(request.abortSignal).toBeInstanceOf(AbortSignal);
    }
    expect(
      store.commitCleanupDisposition.mock.calls.map(([input]) => ({
        id: input.id,
        expectedVersion: input.expectedVersion,
      })),
    ).toEqual([
      { id: RECEIPT_A, expectedVersion: '4' },
      { id: RECEIPT_B, expectedVersion: '11' },
    ]);
  });

  it('propagates a claim failure and performs no delete or disposition', async () => {
    store.claimCleanupBatch.mockRejectedValue(new Error('claim unavailable'));

    await expect(service.runBatch(LIMIT, OWNER)).rejects.toThrow(
      'claim unavailable',
    );
    expect(storage.deleteTechnicalObject).not.toHaveBeenCalled();
    expect(store.commitCleanupDisposition).not.toHaveBeenCalled();
  });

  it('propagates a disposition failure after a resolved delete', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockRejectedValue(
      new Error('disposition unavailable'),
    );

    await expect(service.runBatch(LIMIT, OWNER)).rejects.toThrow(
      'disposition unavailable',
    );
    expect(storage.deleteTechnicalObject).toHaveBeenCalledTimes(1);
    expect(store.commitCleanupDisposition).toHaveBeenCalledTimes(1);
  });

  it('propagates a disposition failure after a delete failure', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockRejectedValue(
      new ObjectStorageError('OBJECT_STORAGE', 'NETWORK_FAILURE'),
    );
    store.commitCleanupDisposition.mockRejectedValue(
      new Error('disposition unavailable'),
    );

    await expect(service.runBatch(LIMIT, OWNER)).rejects.toThrow(
      'disposition unavailable',
    );
  });

  it('does not retry in process after a fenced disposition', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockRejectedValue(
      new ObjectStorageError('OBJECT_STORAGE', 'ABORTED'),
    );
    store.commitCleanupDisposition.mockResolvedValue(FENCED);

    const report = await service.runBatch(LIMIT, OWNER);

    expect(storage.deleteTechnicalObject).toHaveBeenCalledTimes(1);
    expect(store.commitCleanupDisposition).toHaveBeenCalledTimes(1);
    expect(report).toEqual({
      claimed: 1,
      cleaned: 0,
      retryScheduled: 0,
      manualHold: 0,
      fenced: 1,
    });
  });

  it('does not retry in process after a retry-scheduled disposition', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockRejectedValue(
      new ObjectStorageError('OBJECT_STORAGE', 'HTTP_RETRYABLE'),
    );
    store.commitCleanupDisposition.mockResolvedValue(retryScheduled(row));

    await service.runBatch(LIMIT, OWNER);

    expect(storage.deleteTechnicalObject).toHaveBeenCalledTimes(1);
    expect(store.commitCleanupDisposition).toHaveBeenCalledTimes(1);
  });

  it('counts a fenced disposition after a resolved delete as terminal', async () => {
    const row = claimedRow();
    store.claimCleanupBatch.mockResolvedValue([row]);
    storage.deleteTechnicalObject.mockResolvedValue(undefined);
    store.commitCleanupDisposition.mockResolvedValue(FENCED);

    const report = await service.runBatch(LIMIT, OWNER);

    expect(report).toEqual({
      claimed: 1,
      cleaned: 0,
      retryScheduled: 0,
      manualHold: 0,
      fenced: 1,
    });
  });
});
