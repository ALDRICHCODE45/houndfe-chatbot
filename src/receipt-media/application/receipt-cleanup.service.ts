/** ODD-2D2b cleanup application service: owns one bounded cleanup batch and
 * composes the ODD-2D2a claim/disposition primitives with the retention-gated
 * idempotent `deleteTechnicalObject`. The delete always runs outside every
 * database transaction because claim is already committed, the delete goes
 * through the object-storage port, and the disposition is a separate store
 * call — there is deliberately no transaction wrapper here. */
import {
  ObjectStorageError,
  type ObjectStoragePort,
} from '../domain/object-storage.port';
import type {
  CleanupDispositionCode,
  CleanupDispositionInput,
  CleanupDispositionOutcome,
  ReceiptMediaStorePort,
} from '../domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';

/** Bounded aggregate result of one cleanup batch: counts only, no per-item
 * payload, so no provider or receipt evidence widens the caller's surface. */
export interface CleanupBatchReport {
  readonly claimed: number;
  readonly cleaned: number;
  readonly retryScheduled: number;
  readonly manualHold: number;
  readonly fenced: number;
}

/** The seven safe cleanup delete codes. Every other category/code pair is a
 * malformed/unknown provider failure and must become a conservative
 * `PERMANENT_FAILURE` manual hold instead of a silent retry. */
const CLEANUP_CODES: ReadonlySet<string> = new Set([
  'ABORTED',
  'HTTP_RETRYABLE',
  'NETWORK_FAILURE',
  'OBJECT_KEY_INVALID',
  'REQUEST_INVALID',
  'HTTP_PERMANENT',
  'PERMANENT_FAILURE',
]);

/** Fold one delete-provider failure into the fixed safe cleanup taxonomy. */
const cleanupCode = (error: unknown): CleanupDispositionCode =>
  error instanceof ObjectStorageError && CLEANUP_CODES.has(error.code)
    ? (error.code as CleanupDispositionCode)
    : 'PERMANENT_FAILURE';

type CleanupStore = Pick<
  ReceiptMediaStorePort,
  'claimCleanupBatch' | 'commitCleanupDisposition'
>;
type CleanupStorage = Pick<ObjectStoragePort, 'deleteTechnicalObject'>;

export class ReceiptCleanupService {
  constructor(
    private readonly store: CleanupStore,
    private readonly storage: CleanupStorage,
  ) {}

  /**
   * Claim and process one bounded batch sequentially (v1). Each claimed row's
   * exact key, status, failure stage, and caller signal are forwarded to the
   * retention-gated delete, then its exact id/owner/version fence is committed
   * through the disposition primitive. A `fenced` disposition is terminal for
   * this invocation: it is counted and never retried in process. Delete-
   * provider failures are durably dispositioned; claim and disposition store
   * failures propagate so the operational caller can observe them.
   */
  async runBatch(
    limit: number,
    owner: string,
    signal?: AbortSignal,
  ): Promise<CleanupBatchReport> {
    const rows = await this.store.claimCleanupBatch(limit, owner);
    const report = {
      claimed: rows.length,
      cleaned: 0,
      retryScheduled: 0,
      manualHold: 0,
      fenced: 0,
    };
    if (rows.length === 0) return report;
    const abortSignal = signal ?? new AbortController().signal;
    for (const row of rows) {
      const outcome = await this.commit(row, owner, abortSignal);
      switch (outcome.kind) {
        case 'cleaned':
          report.cleaned += 1;
          break;
        case 'retry-scheduled':
          report.retryScheduled += 1;
          break;
        case 'manual-hold':
          report.manualHold += 1;
          break;
        case 'fenced':
          report.fenced += 1;
          break;
      }
    }
    return report;
  }

  private async commit(
    row: ReceiptMediaRow,
    owner: string,
    abortSignal: AbortSignal,
  ): Promise<CleanupDispositionOutcome> {
    const fence = { id: row.id, owner, expectedVersion: row.version };
    let input: CleanupDispositionInput;
    try {
      await this.storage.deleteTechnicalObject({
        key: row.objectKey,
        status: row.status,
        failureStage: row.failureStage,
        abortSignal,
      });
      input = { ...fence, outcome: 'deleted' };
    } catch (error) {
      input = {
        ...fence,
        outcome: 'failed',
        category: 'OBJECT_STORAGE',
        code: cleanupCode(error),
      };
    }
    return this.store.commitCleanupDisposition(input);
  }
}
