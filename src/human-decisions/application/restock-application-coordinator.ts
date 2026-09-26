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
import type { RestockDecisionResolved } from '../../chatbot-api/domain/dtos/human-decisions.dto';

type Ports = Pick<RestockApplicationCandidateService, 'pollForSender'> &
  Pick<PostgresRestockApplicationPreparationStore, 'preparePending'> &
  Pick<PostgresRestockApplicationClaimStore, 'claimPending'> &
  Pick<RestockApplicationLedgerPort, 'recordAcceptance' | 'recordOutcomeAck'> &
  Pick<PostgresRestockApplicationCompletionStore, 'closeAcknowledged'> &
  Pick<ChatbotApiClient, 'recordRestockApplicationOutcome'> &
  Pick<WhatsappSenderPort, 'sendText'>;
const HOLD = Object.freeze({ action: 'hold' as const });
const PENDING = Object.freeze({ action: 'pending' as const });
const ACK = Object.freeze({ action: 'ack_recorded' as const });

function format(decision: RestockDecisionResolved): string {
  const { productName, sku } = decision.snapshot;
  const subject = sku ? `${productName} (SKU: ${sku})` : productName;
  return decision.resolution.action === 'PROVIDE_RESTOCK_ESTIMATE'
    ? `${subject}: el equipo confirmó un estimado de reposición de ${decision.resolution.restockDays} días desde su confirmación. Es un estimado, no una fecha garantizada.`
    : `${subject}: el equipo no pudo confirmar un estimado de reposición.`;
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
        row.decisionId !== decision.id ||
        row.decisionId !== context.backendDecisionId
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
