/** State-aware dispatcher routing one receipt exactly once to the ingestion
 * processor, or explicitly declining dispatch with no collaborator calls. */
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { ReceiptIngestionProcessor } from './receipt-ingestion.processor';

/** Narrow collaborator interface — only the method the dispatcher calls. */
type Ingestion = Pick<ReceiptIngestionProcessor, 'process'>;

/** RESERVED is the first download + upload pass; DOWNLOADED is a same-key
 * upload retry (R2). */
const INGESTION_STATUSES = new Set(['RESERVED', 'DOWNLOADED']);

/** Dispatched once to the processor. */
export interface DispatchedOutcome {
  readonly kind: 'dispatched';
  readonly outcome: unknown;
}

/** Explicitly not dispatched — no collaborator was called. */
export interface NonDispatchedOutcome {
  readonly kind: 'non-dispatched';
  readonly status: string;
}

export type DispatchOutcome = DispatchedOutcome | NonDispatchedOutcome;

/**
 * Construction is inert. Errors from the processor propagate unchanged.
 * Signal is forwarded unchanged; the dispatcher has no cancellation policy.
 * The legacy ATTACHING state (amount dialog) is no longer produced and is
 * never dispatched.
 */
export class ReceiptProcessingDispatcher {
  constructor(private readonly ingestion: Ingestion) {}

  async dispatch(
    receipt: ReceiptMediaRow,
    owner: string,
    signal?: AbortSignal,
  ): Promise<DispatchOutcome> {
    if (!INGESTION_STATUSES.has(receipt.status))
      return { kind: 'non-dispatched', status: receipt.status };
    const outcome = await this.ingestion.process(receipt, owner, signal);
    return { kind: 'dispatched', outcome };
  }
}
