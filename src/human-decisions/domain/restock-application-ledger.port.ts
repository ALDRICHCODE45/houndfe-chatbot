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

/** Persistence only: no start/send permission, historical/provider proof, or CAS.
 * Coordinator must independently bind exact ACTIVE reservation, source POST
 * receipt, subject, current decision and WhatsApp eligibility; later transitions
 * require a transaction boundary. No reservation join is supplied here. */
export interface RestockApplicationLedgerPort {
  readByDecision(decisionId: string): Promise<RestockApplicationRead>;
  insertPending(row: Pending): Promise<RestockApplicationInsert>;
}
