import type { ExpirationApplicationLedgerRow } from './expiration-application-ledger-row';

/** The only stored shape this read accepts today: a RESOLVED v2 decision pending
 * delivery. It is a local snapshot, not send authority or history. */
export type ExpirationApplicationPendingRow = Extract<
  ExpirationApplicationLedgerRow,
  { state: 'PENDING_DELIVERY' }
>;

/** Pending-only observation. It is persistence, not authority: it proves neither
 * original inquiry/sender/branch binding nor a current reservation, send
 * eligibility, ACK or closure. History and provenance stay unknown, and every
 * non-pending or otherwise non-canonical stored row holds. */
export type ExpirationApplicationRead =
  | Readonly<{ action: 'missing' }>
  | Readonly<{ action: 'foundPending'; row: ExpirationApplicationPendingRow }>
  | Readonly<{ action: 'hold' }>;

export interface ExpirationApplicationLedgerPort {
  /** One SELECT by decision id. SQL/projection failures propagate unchanged and
   * imply no rollback or retry; a corrupt stored row holds, never a fake
   * missing. No branch/sender authorization, reservation or send/ACK/closure
   * authority is claimed. */
  readByDecision(decisionId: string): Promise<ExpirationApplicationRead>;
}
