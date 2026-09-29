import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import type { RestockApplicationCandidateService } from './restock-application-candidate.service';
import type { PostgresRestockApplicationPreparationStore } from '../infrastructure/postgres-restock-application-preparation.store';
import type { PostgresRestockApplicationClaimStore } from '../infrastructure/postgres-restock-application-claim.store';
import type { PostgresRestockApplicationCompletionStore } from '../infrastructure/postgres-restock-application-completion.store';
import type { RestockApplicationLedgerPort } from '../domain/restock-application-ledger.port';
import { classifyRestockApplication } from '../domain/restock-application-policy';
import { normalizeRestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import { classifyRestockApplicationAcceptance } from '../domain/restock-application-ledger-acceptance';
import { prepareRestockApplicationOutcome } from '../domain/restock-application-ledger-ack-preparation';
import { classifyRestockApplicationAckRecord } from '../domain/restock-application-ledger-ack-record';
import type { RestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import type { RestockCandidateResult } from './restock-application-candidate.service';
import type { RestockDecisionResolved } from '../../chatbot-api/domain/dtos/human-decisions.dto';

type Ports = Pick<RestockApplicationCandidateService, 'pollForSender'> &
  Pick<PostgresRestockApplicationPreparationStore, 'preparePending'> &
  Pick<PostgresRestockApplicationClaimStore, 'claimPending'> &
  Pick<RestockApplicationLedgerPort, 'recordAcceptance' | 'recordOutcomeAck'> &
  Partial<Pick<RestockApplicationLedgerPort, 'readByDecision'>> &
  Pick<PostgresRestockApplicationCompletionStore, 'closeAcknowledged'> &
  Pick<ChatbotApiClient, 'recordRestockApplicationOutcome'> &
  Pick<WhatsappSenderPort, 'sendText'>;
type TerminalRow = Extract<
  RestockApplicationLedgerRow,
  { state: 'PROVIDER_ACCEPTED' | 'PROVIDER_ACCEPTED_LATE' | 'STALE' }
>;
type PendingRow = Extract<
  RestockApplicationLedgerRow,
  { state: 'PENDING_DELIVERY' }
>;
type Candidate = Extract<RestockCandidateResult, { action: 'candidate' }>;
const HOLD = Object.freeze({ action: 'hold' as const });
const PENDING = Object.freeze({ action: 'pending' as const });
const ACK = Object.freeze({ action: 'ack_recorded' as const });

function format(decision: RestockDecisionResolved): string {
  const { productName, sku } = decision.snapshot;
  const subject = sku ? `${productName} (SKU: ${sku})` : productName;
  if (decision.resolution.action !== 'PROVIDE_RESTOCK_ESTIMATE') {
    return (
      '¡Gracias por la espera! 😊 Por ahora el equipo no pudo confirmar un ' +
      `estimado de reposición para «${subject}».`
    );
  }
  const days = decision.resolution.restockDays;
  const label = days === 1 ? '1 día' : `${days} días`;
  return (
    `¡Gracias por la espera! 😊 El equipo nos confirmó un estimado de ${label} ` +
    `para la reposición de «${subject}», contados desde su confirmación. ` +
    'La fecha puede variar. ¡Que esté muy bien!'
  );
}

/** Trusted-adapter orchestration, not Meta fencing/device delivery.
 * No retries or legacy markers. Closes only after a matching durable ACK;
 * ambiguous SEND_STARTED remains started. History/owner guarantees belong to adapters. */
export class RestockApplicationCoordinator {
  constructor(
    private readonly ports: Ports,
    private readonly branchId: string,
    private readonly receivingPhoneNumberId: string,
    private readonly clock: () => Date,
    private readonly tokenFactory: () => string = randomUUID,
  ) {}

  async applyOnce(
    senderId: string,
    sourceRequestId: string,
  ): Promise<typeof HOLD | typeof PENDING | typeof ACK> {
    const branchId = this.branchId;
    const phone = this.receivingPhoneNumberId;
    const ports = this.ports;
    const clock = this.clock;
    const tokenFactory = this.tokenFactory;
    try {
      const candidate = await ports.pollForSender(senderId, sourceRequestId);
      if (candidate.action === 'pending') return PENDING;
      if (candidate.action !== 'candidate') return HOLD;
      const { decision, context } = candidate;
      if (
        context.reservation.senderId !== senderId ||
        context.reservation.requestKey !== sourceRequestId ||
        decision.sourceRequestId !== sourceRequestId ||
        decision.snapshot.branchId !== branchId
      )
        return HOLD;
      const text = format(decision);
      if (!text.trim() || text.length > 4096) return HOLD;
      const prepared = await ports.preparePending(candidate);
      if (prepared.action !== 'prepared') return HOLD;
      const sendToken = tokenFactory();
      const claimed = await ports.claimPending(
        candidate,
        prepared.row,
        sendToken,
      );
      if (claimed.action !== 'started' && claimed.action !== 'stale')
        return HOLD;
      let terminal;
      if (claimed.action === 'stale') terminal = claimed.row;
      else {
        const { row, evidence } = claimed;
        const now = Date.prototype.toISOString.call(clock());
        const nowMs = Date.parse(now);
        const providerMs = Number(evidence.providerTimestampSeconds) * 1000;
        const policy = classifyRestockApplication({
          senderId,
          branchId,
          reservation: context.reservation,
          backendDecisionId: context.backendDecisionId,
          decision,
          now,
        });
        if (
          policy.action !== 'ready' ||
          candidate.classification.action !== 'ready' ||
          policy.attemptId !== candidate.classification.attemptId ||
          policy.decisionId !== candidate.classification.decisionId
        )
          return HOLD;
        const expected = normalizeRestockApplicationLedgerRow({
          state: 'SEND_STARTED',
          senderId,
          sourceRequestId,
          branchId,
          decisionId: decision.id,
          resolutionVersion: 2,
          attemptId: policy.attemptId,
          resolvedAt: decision.resolution.resolvedAt,
          applyBefore: decision.applyBefore,
          sendToken,
          attemptedAt: row.attemptedAt,
        });
        if (
          !expected ||
          !isDeepStrictEqual(row, expected) ||
          policy.decisionId !== row.decisionId ||
          evidence.senderId !== senderId ||
          evidence.sourceRequestId !== sourceRequestId ||
          evidence.receivingPhoneNumberId !== phone ||
          !(nowMs >= Date.parse(row.attemptedAt)) ||
          !(providerMs <= nowMs && nowMs < providerMs + 86_400_000) ||
          !(Date.parse(evidence.observedAt) <= nowMs)
        )
          return HOLD;
        // Nothing asynchronous may intervene between the final check and send.
        const receipt = await ports.sendText({ to: senderId, text });
        const providerAcceptedObservedAt =
          Date.prototype.toISOString.call(clock());
        const event = Object.freeze({
          kind: 'provider_accepted' as const,
          attemptId: row.attemptId,
          sendToken,
          providerMessageId: receipt.providerMessageId,
          providerAcceptedObservedAt,
        });
        const acceptance = classifyRestockApplicationAcceptance({ row, event });
        if (acceptance.action !== 'propose_cas') return HOLD;
        const recorded = await ports.recordAcceptance({ row, event });
        if (
          (recorded.action !== 'updated' && recorded.action !== 'replay') ||
          !isDeepStrictEqual(recorded.row, acceptance.next)
        )
          return HOLD;
        terminal = recorded.row;
      }
      return this.finish(
        terminal,
        senderId,
        sourceRequestId,
        decision.id,
        context.backendDecisionId,
      );
    } catch {
      return HOLD;
    }
  }

  /**
   * Expired-only on-demand reconciliation. It NEVER sends Meta: only an
   * already-expired (`stale`) candidate is eligible, and every persisted or
   * freshly claimed terminal is `STALE`. SEND_STARTED / PROVIDER_ACCEPTED / a
   * claim race therefore hold without resend, expiry fabrication or closure.
   * The old request identity is taken only from the trusted recorded snapshot
   * (`pollForSender`), never from the current customer/product/source turn.
   */
  async reconcileExpiredOnce(
    senderId: string,
    sourceRequestId: string,
  ): Promise<typeof HOLD | typeof ACK> {
    const branchId = this.branchId;
    const ports = this.ports;
    try {
      const candidate = await ports.pollForSender(senderId, sourceRequestId);
      if (candidate.action !== 'candidate') return HOLD;
      const { decision, context } = candidate;
      if (
        context.reservation.senderId !== senderId ||
        context.reservation.requestKey !== sourceRequestId ||
        decision.sourceRequestId !== sourceRequestId ||
        decision.snapshot.branchId !== branchId
      )
        return HOLD;
      if (candidate.classification.action !== 'stale') return HOLD;
      let pending: PendingRow | undefined;
      const read = ports.readByDecision;
      if (typeof read === 'function') {
        const found = await read(context.backendDecisionId);
        if (found.action === 'hold') return HOLD;
        if (found.action === 'found') {
          if (found.row.state === 'STALE') {
            if (!this.matchesExpiredSnapshot(found.row, candidate)) return HOLD;
            return this.finish(
              found.row,
              senderId,
              sourceRequestId,
              decision.id,
              context.backendDecisionId,
            );
          }
          if (found.row.state !== 'PENDING_DELIVERY') return HOLD;
          pending = found.row;
        }
      }
      if (!pending) {
        const prepared = await ports.preparePending(candidate);
        if (prepared.action !== 'prepared') return HOLD;
        pending = prepared.row;
      }
      const claimed = await ports.claimPending(
        candidate,
        pending,
        this.tokenFactory(),
      );
      if (claimed.action !== 'stale') return HOLD;
      if (!this.matchesExpiredSnapshot(claimed.row, candidate)) return HOLD;
      return this.finish(
        claimed.row,
        senderId,
        sourceRequestId,
        decision.id,
        context.backendDecisionId,
      );
    } catch {
      return HOLD;
    }
  }

  /** A persisted STALE row must equal the derived snapshot in every field; a
   * `normalize` round-trip also proves a valid stale timestamp, not just a
   * matching decision id. */
  private matchesExpiredSnapshot(
    row: RestockApplicationLedgerRow,
    candidate: Candidate,
  ): boolean {
    if (row.state !== 'STALE') return false;
    const derived = normalizeRestockApplicationLedgerRow({
      state: 'STALE',
      senderId: candidate.context.reservation.senderId,
      sourceRequestId: candidate.context.reservation.requestKey,
      branchId: this.branchId,
      decisionId: candidate.decision.id,
      resolutionVersion: 2,
      attemptId: candidate.classification.attemptId,
      resolvedAt: candidate.decision.resolution.resolvedAt,
      applyBefore: candidate.decision.applyBefore,
      staleObservedAt: row.staleObservedAt,
    });
    return derived !== null && isDeepStrictEqual(row, derived);
  }

  /** Shared terminal tail: report the outcome, durably ACK it, then close the
   * exact local record. Used by `applyOnce` (send or stale) and the expired-only
   * reconciliation; it never sends and never retries. */
  private async finish(
    terminal: TerminalRow,
    senderId: string,
    sourceRequestId: string,
    expectedDecisionId: string,
    expectedBackendDecisionId: string,
  ): Promise<typeof HOLD | typeof ACK> {
    const ports = this.ports;
    const branchId = this.branchId;
    try {
      // Bind the exact terminal to the trusted candidate before any report.
      if (
        terminal.senderId !== senderId ||
        terminal.sourceRequestId !== sourceRequestId ||
        terminal.branchId !== branchId ||
        terminal.decisionId !== expectedDecisionId ||
        terminal.decisionId !== expectedBackendDecisionId
      )
        return HOLD;
      const outcome = prepareRestockApplicationOutcome(terminal);
      if (outcome.action !== 'prepared') return HOLD;
      const receipt = await ports.recordRestockApplicationOutcome(
        outcome.decisionId,
        outcome.request,
      );
      const ack = await ports.recordOutcomeAck(terminal, receipt);
      if (ack.action !== 'recorded' && ack.action !== 'replay') return HOLD;
      const verified = classifyRestockApplicationAckRecord(
        terminal,
        receipt,
        ack.record,
      );
      if (verified.action !== 'replay') return HOLD;
      const { record } = verified;
      const { row } = record;
      if (
        row.senderId !== senderId ||
        row.sourceRequestId !== sourceRequestId ||
        row.branchId !== branchId ||
        row.decisionId !== expectedDecisionId ||
        row.decisionId !== expectedBackendDecisionId
      )
        return HOLD;
      const closed = await ports.closeAcknowledged(record);
      return closed.action === 'closed' || closed.action === 'replay'
        ? ACK
        : HOLD;
    } catch {
      return HOLD;
    }
  }
}
