/**
 * R3b3-c4 bot-only, INERT RESTOCK intake coordinator. It composes the committed
 * `SharedReservationPort` + `RestockPostLedgerPort` + the `submitRestockIntake`
 * backend seam into ONE ordered attempt: reserve RESTOCK → beginPost → (only on
 * `authorize_post`) a SINGLE backend POST → strict historical receipt
 * normalization → atomic `recordReceipt`. No DI, route, Meta, or customer send.
 *
 * `sourceRequestId` is CALLER-OWNED: it is normalized from the caller's intake
 * and reused verbatim as the reservation key and backend idempotency key. The
 * service never mints an id and never assumes webhook dedup proves one; wiring a
 * caller is a later cut, after a durable inbound-event mapping exists.
 *
 * Success is only a durable recorded id. The returned id is a HISTORICAL poll
 * key, never current decision state or device delivery; an ambiguous outcome
 * yields a conservative hold and never a fabricated durable claim.
 */
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  normalizeRestockIntake,
  normalizeRestockIntakeReceipt,
  type RestockIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import type {
  RestockPostDecision,
  RestockPostLedgerPort,
} from '../domain/restock-post-ledger';
import type {
  ReservationDecision,
  SharedReservationPort,
} from '../domain/shared-reservation';

export interface RestockIntakeRequest {
  readonly senderId: string;
  readonly intake: unknown;
}

export type RestockIntakeHoldReason =
  | 'post_in_flight'
  | 'unknown_hold'
  | 'record_unconfirmed';
export type RestockIntakeBlockReason =
  | 'malformed_input'
  | 'occupied'
  | 'collision'
  | 'reservation_blocked';

export type RestockIntakeOutcome =
  | { readonly decision: 'recorded'; readonly historicalPollId: string }
  | { readonly decision: 'existing'; readonly historicalPollId: string }
  | { readonly decision: 'hold'; readonly reason: RestockIntakeHoldReason }
  | { readonly decision: 'blocked'; readonly reason: RestockIntakeBlockReason };

/** DI token for the inert, bot-only RESTOCK intake coordinator. */
export const RESTOCK_INTAKE_SERVICE = Symbol('RESTOCK_INTAKE_SERVICE');

export class RestockIntakeService {
  constructor(
    private readonly reservations: SharedReservationPort,
    private readonly ledger: RestockPostLedgerPort,
    private readonly client: Pick<ChatbotApiClient, 'submitRestockIntake'>,
    private readonly onReceiptRecorded?: (
      senderId: string,
      sourceRequestId: string,
    ) => void,
  ) {}

  async coordinate(
    request: RestockIntakeRequest,
  ): Promise<RestockIntakeOutcome> {
    const intake = normalizeRestockIntake(request.intake);
    if (intake === null) {
      return { decision: 'blocked', reason: 'malformed_input' };
    }
    const senderId = request.senderId;
    const sourceRequestId = intake.sourceRequestId;

    let reservation: ReservationDecision;
    try {
      reservation = await this.reservations.reserve({
        senderId,
        route: 'RESTOCK',
        requestKey: sourceRequestId,
        intake,
      });
    } catch {
      return { decision: 'hold', reason: 'unknown_hold' };
    }
    if (
      reservation.action === 'occupied' ||
      reservation.action === 'occupied_legacy'
    ) {
      return { decision: 'blocked', reason: 'occupied' };
    }
    if (reservation.action === 'conflict') {
      return { decision: 'blocked', reason: 'collision' };
    }
    if (reservation.action === 'blocked') {
      return { decision: 'blocked', reason: 'reservation_blocked' };
    }
    // 'claim' or an exact 'replay' may proceed to the ledger step.

    let begun: RestockPostDecision;
    try {
      begun = await this.ledger.beginPost({ senderId, sourceRequestId });
    } catch {
      await this.markUnknownQuietly(senderId, sourceRequestId);
      return { decision: 'hold', reason: 'unknown_hold' };
    }
    if (begun.action === 'historical_receipt') {
      return {
        decision: 'existing',
        historicalPollId: begun.backendDecisionId,
      };
    }
    if (begun.action === 'hold') {
      return {
        decision: 'hold',
        reason:
          begun.reason === 'post_in_flight' ? 'post_in_flight' : 'unknown_hold',
      };
    }
    if (begun.action === 'blocked') {
      return { decision: 'blocked', reason: 'reservation_blocked' };
    }
    if (begun.action !== 'authorize_post') {
      return { decision: 'hold', reason: 'unknown_hold' };
    }
    return this.postAndRecord(senderId, sourceRequestId, intake);
  }

  private async postAndRecord(
    senderId: string,
    sourceRequestId: string,
    intake: RestockIntakeInput,
  ): Promise<RestockIntakeOutcome> {
    let response: unknown;
    try {
      response = await this.client.submitRestockIntake(intake);
    } catch {
      await this.markUnknownQuietly(senderId, sourceRequestId);
      return { decision: 'hold', reason: 'unknown_hold' };
    }
    const receipt = normalizeRestockIntakeReceipt(response, intake);
    if (receipt === null) {
      await this.markUnknownQuietly(senderId, sourceRequestId);
      return { decision: 'hold', reason: 'unknown_hold' };
    }
    const backendDecisionId = receipt.id;

    let recorded: RestockPostDecision;
    try {
      recorded = await this.ledger.recordReceipt({
        senderId,
        sourceRequestId,
        backendDecisionId,
      });
    } catch {
      return this.afterAmbiguousRecord(
        senderId,
        sourceRequestId,
        backendDecisionId,
      );
    }
    if (
      recorded.action === 'record_receipt' &&
      recorded.backendDecisionId === backendDecisionId
    ) {
      // Synchronous enqueue-only hint, never sender authority or delivery proof.
      try {
        this.onReceiptRecorded?.(senderId, sourceRequestId);
      } catch {
        // Enqueue failure cannot undo the confirmed durable receipt.
      }
      return { decision: 'recorded', historicalPollId: backendDecisionId };
    }
    if (
      recorded.action === 'replay_receipt' &&
      recorded.backendDecisionId === backendDecisionId
    ) {
      return { decision: 'existing', historicalPollId: backendDecisionId };
    }
    return this.afterAmbiguousRecord(
      senderId,
      sourceRequestId,
      backendDecisionId,
    );
  }

  /** An ambiguous record is held, never claimed; a safe readback may still
   * surface the SAME historical id, otherwise the outcome stays unconfirmed. */
  private async afterAmbiguousRecord(
    senderId: string,
    sourceRequestId: string,
    backendDecisionId: string,
  ): Promise<RestockIntakeOutcome> {
    await this.markUnknownQuietly(senderId, sourceRequestId);
    try {
      const readback: RestockPostDecision = await this.ledger.beginPost({
        senderId,
        sourceRequestId,
      });
      if (
        readback.action === 'historical_receipt' &&
        readback.backendDecisionId === backendDecisionId
      ) {
        return { decision: 'existing', historicalPollId: backendDecisionId };
      }
    } catch {
      // fall through to the unconfirmed hold
    }
    return { decision: 'hold', reason: 'record_unconfirmed' };
  }

  private async markUnknownQuietly(
    senderId: string,
    sourceRequestId: string,
  ): Promise<void> {
    try {
      await this.ledger.markUnknown({ senderId, sourceRequestId });
    } catch {
      // ignored: the caller still receives a conservative hold, never a claim
    }
  }
}
