import type { RestockApplicationOutcomeAck } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type { RestockApplicationLedgerRow } from './restock-application-ledger-row';

type Pending = Extract<
  RestockApplicationLedgerRow,
  { state: 'PENDING_DELIVERY' }
>;
export type RestockApplicationRead =
  | Readonly<{ action: 'missing' }>
  | Readonly<{
      action: 'found';
      row: RestockApplicationLedgerRow;
      ack: Readonly<RestockApplicationOutcomeAck> | null;
    }>
  | Readonly<{ action: 'hold' }>;
export type RestockApplicationInsert =
  | Readonly<{ action: 'inserted' | 'replay'; row: Pending }>
  | Readonly<{ action: 'hold' }>;

export type RestockApplicationPendingTransition = Readonly<{
  row: Pending;
  event:
    | Readonly<{ kind: 'begin_send'; sendToken: string; attemptedAt: string }>
    | Readonly<{ kind: 'expire_unsent'; observedAt: string }>;
}>;
export type RestockApplicationTransition =
  | Readonly<{
      action: 'updated';
      row: Extract<
        RestockApplicationLedgerRow,
        { state: 'SEND_STARTED' | 'STALE' }
      >;
    }>
  | Readonly<{ action: 'hold' }>;

type Accepted = Extract<
  RestockApplicationLedgerRow,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' }
>;
export type RestockApplicationAcceptanceInput = Readonly<{
  row:
    | Extract<RestockApplicationLedgerRow, { state: 'SEND_STARTED' }>
    | Accepted;
  event: Readonly<{
    kind: 'provider_accepted';
    attemptId: string;
    sendToken: string;
    providerMessageId: string;
    providerAcceptedObservedAt: string;
  }>;
}>;
export type RestockApplicationAcceptanceResult =
  | Readonly<{ action: 'updated' | 'replay'; row: Accepted }>
  | Readonly<{ action: 'hold' }>;

/** Persistence only: local ledger CAS, not send permission or provider proof.
 * Unwired: does NOT satisfy start policy's active-reservation + expected-row
 * atomicity requirement. Before integration, a coordinator must resolve the
 * transaction/owner boundary, exact ACTIVE reservation and case-sensitive source
 * binding, RECEIPT_RECORDED source POST, backend decision, frozen subject,
 * current GET + policy and WhatsApp 24h eligibility. No reservation join here.
 * Neither SEND_STARTED nor a CAS winner authorizes Meta or outcome reporting;
 * pure ready/stale policy results are not authority. Tokens fence local writes,
 * not external HTTP. Errors may follow a committed write: never infer rollback
 * or retry; recovered SEND_STARTED always holds. */
export interface RestockApplicationLedgerPort {
  /** Local acceptance only: caller must correlate the real provider response to
   * the original send attempt/current owner, establish live authority and
   * coordinate reservations. Frozen input + CAS prove neither provenance nor
   * device delivery, and grant no ACK/send permission. Stable attempt identity
   * and distinct claim token are not HTTP fences. No timeout recovery evidence.
   * Terminal replay proves a read snapshot, not a lock or historical origin. */
  recordAcceptance(
    input: RestockApplicationAcceptanceInput,
  ): Promise<RestockApplicationAcceptanceResult>;
  readByDecision(decisionId: string): Promise<RestockApplicationRead>;
  insertPending(row: Pending): Promise<RestockApplicationInsert>;
  transitionPending(
    input: RestockApplicationPendingTransition,
  ): Promise<RestockApplicationTransition>;
}
