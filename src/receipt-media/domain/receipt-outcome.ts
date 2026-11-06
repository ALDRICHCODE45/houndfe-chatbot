/** R5 (S5): the human outcome of an uploaded receipt reaches the customer.
 *
 * An ATTACHED receipt with a backend receipt id and no recorded outcome is
 * polled until the backend says CONFIRMED or REJECTED. The outcome is then
 * recorded once together with its notification: a queued outbox message when
 * the 24 h WhatsApp window is open, or `OUTSIDE_WINDOW` (not delivered, no
 * retry loop) when it closed. No time horizon: a review may take days. */
import type { ReceiptOutcome } from '../../chatbot-api/domain/dtos/receipt-outcome.dto';
import type { CustomerInboundObservationStore } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import type { ReceiptMediaOutboxRow } from './receipt-media.types';

export interface ReceiptOutcomePollPolicy {
  /** Minimum gap between backend reads for a young receipt. */
  intervalMs: number;
  /** Age (since attached) after which a receipt counts as long-pending. */
  slowAfterMs: number;
  /** Minimum gap between backend reads for a long-pending receipt. */
  slowIntervalMs: number;
}

export const DEFAULT_RECEIPT_OUTCOME_POLL_POLICY: ReceiptOutcomePollPolicy = {
  intervalMs: 60_000,
  slowAfterMs: 3_600_000,
  slowIntervalMs: 900_000,
};

/** One receipt awaiting its human outcome. */
export interface ReceiptOutcomeCandidate {
  id: string;
  senderId: string;
  backendReceiptId: string;
  saleFolio: string | null;
  attachedAt: Date;
  outcomePolledAt: Date | null;
}

export type ReceiptOutcomeDelivery = 'QUEUED' | 'OUTSIDE_WINDOW';

export type ReceiptOutcomeTemplateKey =
  | 'RECEIPT_PAYMENT_CONFIRMED'
  | 'RECEIPT_PAYMENT_PARTIAL'
  | 'RECEIPT_PAYMENT_REJECTED';

export interface ReceiptOutcomeTemplateArgs {
  folio?: string;
  debtCents?: number;
  reason?: string;
}

export interface ReceiptOutcomeCommitInput {
  id: string;
  status: 'CONFIRMED' | 'REJECTED';
  customerReason: string | null;
  debtCents: number;
  delivery: ReceiptOutcomeDelivery;
  templateKey: ReceiptOutcomeTemplateKey;
  templateArgs: ReceiptOutcomeTemplateArgs;
}

/** `already-notified` is the loser of a race (or a replay): nothing changes. */
export type ReceiptOutcomeCommitResult =
  | { kind: 'committed'; intent: ReceiptMediaOutboxRow | null }
  | { kind: 'already-notified' };

export interface ReceiptOutcomeStore {
  /** Due candidates, never-polled and oldest-polled first, at most `limit`. */
  listOutcomeDue(
    limit: number,
    policy: ReceiptOutcomePollPolicy,
  ): Promise<ReceiptOutcomeCandidate[]>;
  /** Stamps the backend read (PENDING or failed) for the backoff. */
  markOutcomePolled(id: string): Promise<void>;
  /** Records the outcome and its notification exactly once, atomically. */
  commitOutcome(
    input: ReceiptOutcomeCommitInput,
  ): Promise<ReceiptOutcomeCommitResult>;
}

/** The customer text for a decided outcome; null while PENDING. */
export function outcomeTemplate(
  outcome: ReceiptOutcome,
  folio: string | null,
): {
  templateKey: ReceiptOutcomeTemplateKey;
  templateArgs: ReceiptOutcomeTemplateArgs;
} | null {
  const folioArgs = folio === null ? {} : { folio };
  switch (outcome.status) {
    case 'PENDING':
      return null;
    case 'CONFIRMED':
      return outcome.sale.debtCents === 0
        ? { templateKey: 'RECEIPT_PAYMENT_CONFIRMED', templateArgs: folioArgs }
        : {
            templateKey: 'RECEIPT_PAYMENT_PARTIAL',
            templateArgs: { ...folioArgs, debtCents: outcome.sale.debtCents },
          };
    case 'REJECTED':
      return {
        templateKey: 'RECEIPT_PAYMENT_REJECTED',
        templateArgs:
          outcome.customerReason === null
            ? folioArgs
            : { ...folioArgs, reason: outcome.customerReason },
      };
  }
}

/** WhatsApp customer service window. */
const CUSTOMER_WINDOW_MS = 86_400_000;

/** The 24 h window rule shared by the outcome poller (commit time) and the
 * notification worker (send time): open only when the latest recorded
 * inbound message is at most 24 h old. Rejects when the read fails, so the
 * send-time caller can retry instead of treating it as closed. */
export async function readCustomerWindowOpen(
  observations: Pick<CustomerInboundObservationStore, 'readLatest'>,
  senderId: string,
  receivingPhoneNumberId: string,
  now: Date,
): Promise<boolean> {
  const nowMs = now.getTime();
  const latest = await observations.readLatest(
    senderId,
    receivingPhoneNumberId,
  );
  if (latest.kind !== 'found') return false;
  const providerMs = Number(latest.observation.providerTimestampSeconds) * 1000;
  return (
    Number.isSafeInteger(providerMs) &&
    providerMs <= nowMs &&
    nowMs < providerMs + CUSTOMER_WINDOW_MS
  );
}

/** Commit-time variant: a failed read counts as closed. */
export function isCustomerWindowOpen(
  observations: Pick<CustomerInboundObservationStore, 'readLatest'>,
  senderId: string,
  receivingPhoneNumberId: string,
  now: Date,
): Promise<boolean> {
  return readCustomerWindowOpen(
    observations,
    senderId,
    receivingPhoneNumberId,
    now,
  ).catch(() => false);
}
