/** State-aware dispatcher routing one receipt exactly once to the correct
 * collaborator, or explicitly declining dispatch with no collaborator calls. */
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import type { ReceiptAttachmentService } from './receipt-attachment.service';
import type { ReceiptIngestionProcessor } from './receipt-ingestion.processor';

/** Narrow collaborator interfaces — only the methods the dispatcher calls. */
type Ingestion = Pick<ReceiptIngestionProcessor, 'process'>;
type Attachment = Pick<ReceiptAttachmentService, 'attach'>;

/** Statuses that delegate to ingestion. */
const INGESTION_STATUSES = new Set(['RESERVED', 'DOWNLOADED']);

/** Dispatched once to the correct collaborator. */
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
 * State-aware router: for every receipt status it either delegates exactly
 * once to `ReceiptIngestionProcessor` (RESERVED/DOWNLOADED) or
 * `ReceiptAttachmentService` (ATTACHING), or returns an explicit
 * non-dispatch result with no collaborator calls.
 *
 * Construction is inert. Errors from collaborators propagate unchanged.
 * Signal is forwarded unchanged; the dispatcher has no cancellation policy.
 */
export class ReceiptProcessingDispatcher {
  constructor(
    private readonly ingestion: Ingestion,
    private readonly attachment: Attachment,
  ) {}

  async dispatch(
    receipt: ReceiptMediaRow,
    owner: string,
    signal?: AbortSignal,
  ): Promise<DispatchOutcome> {
    if (INGESTION_STATUSES.has(receipt.status)) {
      const outcome = await this.ingestion.process(receipt, owner, signal);
      return { kind: 'dispatched', outcome };
    }

    if (receipt.status === 'ATTACHING') {
      const outcome = await this.attachment.attach({ receipt, owner, signal });
      return { kind: 'dispatched', outcome };
    }

    return { kind: 'non-dispatched', status: receipt.status };
  }
}
