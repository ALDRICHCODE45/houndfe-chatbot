import type { ExpirationApplicationLedgerRow } from './expiration-application-ledger-row';
import type { ExpirationApplicationAckBinding } from './expiration-application-ledger-ack-binding';

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

/** Insert/replay observation for one local pending row. It is persistence, not
 * authority: neither insertion nor replay proves a current reservation, send
 * eligibility, provenance, provider acceptance, ACK or closure. Replay proves a
 * read snapshot only, never a lock or history. */
export type ExpirationApplicationInsert =
  | Readonly<{
      action: 'inserted' | 'replay';
      row: ExpirationApplicationPendingRow;
    }>
  | Readonly<{ action: 'hold' }>;

/** A successful local CAS observation, not committed transaction or send authority. */
export type ExpirationApplicationTransition =
  | Readonly<{
      action: 'updated';
      row: Extract<ExpirationApplicationLedgerRow, { state: 'SEND_STARTED' }>;
    }>
  | Readonly<{ action: 'hold' }>;

/** Local acceptance CAS observation, not transaction COMMIT, delivery or ACK. */
export type ExpirationApplicationAcceptance =
  | Readonly<{
      action: 'updated';
      row: Extract<
        ExpirationApplicationLedgerRow,
        { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' }
      >;
    }>
  | Readonly<{ action: 'hold' }>;

type BoundAck = Extract<ExpirationApplicationAckBinding, { action: 'bound' }>;
/** Local ACK CAS observation; not outer COMMIT, delivery or closure authority. */
export type ExpirationApplicationAckWrite =
  | Readonly<{
      action: 'updated';
      row: BoundAck['expected'];
      receipt: BoundAck['receipt'];
    }>
  | Readonly<{ action: 'hold' }>;

export interface ExpirationApplicationLedgerPort {
  /** One exact terminal-row CAS into an absent ACK slot, using trusted response
   * evidence. Invalid input holds before SQL. Zero rows, including identical
   * replay, hold without reread/retry. SQL/inconsistent-result failures propagate;
   * neither failure nor hold proves rollback. Caller owns HTTP provenance and
   * any outer transaction; updated never grants automatic closure or resend. */
  recordOutcomeAck(
    row: unknown,
    receipt: unknown,
  ): Promise<ExpirationApplicationAckWrite>;
  /** One exact SEND_STARTED CAS using trusted provider acceptance evidence.
   * Classification uses the supplied observation time, never the write clock.
   * Zero rows (including identical replay) hold without reread or retry.
   * SQL/projection failures propagate; neither failure nor hold proves rollback.
   * Caller owns evidence provenance and any outer transaction; updated does not
   * establish COMMIT, reservation ownership, delivery, ACK or closure authority. */
  recordAcceptance(input: unknown): Promise<ExpirationApplicationAcceptance>;
  /** Begin-send only, via the pure start policy and one exact expected-row CAS.
   * Zero rows (even identical-token replay) hold without reread or retry.
   * SQL/projection failures propagate; neither failure nor hold proves rollback.
   * Caller owns reservation/identity/clock revalidation and any outer transaction;
   * even updated is not committed evidence, WhatsApp eligibility or send authority. */
  transitionPending(input: unknown): Promise<ExpirationApplicationTransition>;
  /** One SELECT by decision id. SQL/projection failures propagate unchanged and
   * imply no rollback or retry; a corrupt stored row holds, never a fake
   * missing. No branch/sender authorization, reservation or send/ACK/closure
   * authority is claimed. */
  readByDecision(decisionId: string): Promise<ExpirationApplicationRead>;
  /** One conflict-safe INSERT ... ON CONFLICT DO NOTHING RETURNING, then at most
   * one conflict read when RETURNING is empty. SQL/driver failures propagate
   * unchanged and imply no rollback or retry (the write may have committed); an
   * existing row is never updated or overwritten. Invalid or non-pending input
   * holds before any query. No reservation, provenance or send/ACK authority is
   * claimed. */
  insertPending(
    row: ExpirationApplicationPendingRow,
  ): Promise<ExpirationApplicationInsert>;
}
