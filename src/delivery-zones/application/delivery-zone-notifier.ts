import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { RestockApplicationOutcomeRequest } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import type { CustomerInboundObservationStore } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import {
  checkHandoffSendHold,
  type HandoffModeReader,
} from '../../conversation/application/handoff-send-hold';
import {
  applyCustomerStyle,
  type CustomerStyle,
} from '../../customer-profile/domain/notice-style';
import {
  DELIVERY_ZONE_TEMPLATE,
  deliveryZoneResolvedText,
  type DeliveryZoneDeliveryOutcome,
  type DeliveryZoneRequesterRow,
  type DeliveryZoneRequesterStore,
} from '../domain/delivery-zone-requester';
import type { DeliveryZoneIntakeService } from './delivery-zone-intake.service';

/** The fixed copy in the stored style; unchanged usted without one. */
const styled = (text: string, style: CustomerStyle | null): string =>
  style === null ? text : applyCustomerStyle(text, style);

/** WhatsApp customer service window. */
const CUSTOMER_WINDOW_MS = 86_400_000;

export type DeliveryZoneNotifierPorts = Pick<
  ChatbotApiClient,
  'getDeliveryZoneRequester' | 'recordRestockApplicationOutcome'
> &
  Pick<WhatsappSenderPort, 'sendText' | 'sendTemplate'> &
  Pick<CustomerInboundObservationStore, 'readLatest'> &
  Pick<DeliveryZoneIntakeService, 'submit'> & {
    /** Drop a stored PENDING-zone quote so the next request re-quotes. */
    clearPendingQuote(senderId: string): Promise<void>;
    /** S1: the stored customer style; null/failure keeps the usted text. */
    customerStyle?(senderId: string): Promise<CustomerStyle | null>;
  } & Partial<HandoffModeReader>;

/**
 * Advances one requester row by one step chain:
 * intake retry → poll → (RESOLVED) mark SEND_STARTED → send text or template
 * → NOTIFIED → ACK → CLOSED. Every step is a status CAS, so a send happens at
 * most once per row; a crash after SEND_STARTED is recovered as
 * DELIVERY_UNKNOWN, never resent.
 *
 * Outcome convention (same as RESTOCK): PROVIDER_ACCEPTED when the provider
 * accepted before `applyBefore`, PROVIDER_ACCEPTED_LATE after it. The backend
 * rejects an ACK outside [resolvedAt, applyBefore), so a late outcome is
 * recorded locally only.
 */
export class DeliveryZoneNotifier {
  private readonly logger = new Logger(DeliveryZoneNotifier.name);

  constructor(
    private readonly store: DeliveryZoneRequesterStore,
    private readonly ports: DeliveryZoneNotifierPorts,
    private readonly receivingPhoneNumberId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly attemptIdFactory: () => string = randomUUID,
  ) {}

  async process(row: DeliveryZoneRequesterRow): Promise<void> {
    try {
      let current: DeliveryZoneRequesterRow | null = row;
      if (current.status === 'INTAKE_PENDING') {
        await this.ports.submit(current);
        return;
      }
      if (current.status === 'PENDING') current = await this.poll(current);
      if (current?.status === 'RESOLVED') current = await this.deliver(current);
      if (current?.status === 'SEND_STARTED')
        current = await this.recover(current);
      if (current?.status === 'NOTIFIED') await this.acknowledge(current);
    } catch (error) {
      this.logger.warn(
        `DELIVERY_ZONE requester step failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async poll(
    row: DeliveryZoneRequesterRow,
  ): Promise<DeliveryZoneRequesterRow | null> {
    const now = this.now();
    if (row.requesterId === null) return null;
    let requester;
    try {
      requester = await this.ports.getDeliveryZoneRequester(row.requesterId);
    } catch {
      await this.store.transition(row.sourceRequestId, 'PENDING', {
        lastPolledAt: now,
        updatedAt: now,
      });
      return null;
    }
    if (requester.status === 'PENDING')
      return this.store.transition(row.sourceRequestId, 'PENDING', {
        lastPolledAt: now,
        updatedAt: now,
      });
    return this.store.transition(row.sourceRequestId, 'PENDING', {
      status: 'RESOLVED',
      resolution: requester.resolution,
      applyBefore: requester.applyBefore,
      lastPolledAt: now,
      updatedAt: now,
    });
  }

  private async insideCustomerWindow(
    senderId: string,
    nowMs: number,
  ): Promise<boolean> {
    try {
      const latest = await this.ports.readLatest(
        senderId,
        this.receivingPhoneNumberId,
      );
      if (latest.kind !== 'found') return false;
      const providerMs =
        Number(latest.observation.providerTimestampSeconds) * 1000;
      return (
        Number.isSafeInteger(providerMs) &&
        providerMs <= nowMs &&
        nowMs < providerMs + CUSTOMER_WINDOW_MS
      );
    } catch {
      return false;
    }
  }

  private async deliver(
    row: DeliveryZoneRequesterRow,
  ): Promise<DeliveryZoneRequesterRow | null> {
    const { resolution, applyBefore } = row;
    if (resolution === null || applyBefore === null) return null;
    // S7: no notice while the conversation is HUMAN (or the mode is
    // unreadable). The row stays RESOLVED, so a later tick retries it; the
    // poll time only moves it behind the other due rows.
    if ((await this.handoffHold(row.senderId)).hold) {
      const now = this.now();
      await this.store.transition(row.sourceRequestId, 'RESOLVED', {
        lastPolledAt: now,
        updatedAt: now,
      });
      return null;
    }
    const attemptedAt = this.now();
    const text = await this.insideCustomerWindow(
      row.senderId,
      Date.parse(attemptedAt),
    );
    // S1: read before the durable marker; nothing async between it and send.
    const style = text ? await this.customerStyle(row.senderId) : null;
    // Durable marker BEFORE the provider call: a crash after it never resends.
    const started = await this.store.transition(
      row.sourceRequestId,
      'RESOLVED',
      {
        status: 'SEND_STARTED',
        channel: text ? 'TEXT' : 'TEMPLATE',
        attemptId: this.attemptIdFactory(),
        attemptedAt,
        updatedAt: attemptedAt,
      },
    );
    if (started === null) return null;
    let providerMessageId: string | null = null;
    try {
      const receipt = text
        ? await this.ports.sendText({
            to: row.senderId,
            text: styled(
              deliveryZoneResolvedText(row.zipCode, resolution.zoneType),
              style,
            ),
          })
        : await this.ports.sendTemplate({
            to: row.senderId,
            ...DELIVERY_ZONE_TEMPLATE,
            bodyParameters: [row.zipCode],
          });
      providerMessageId = receipt.providerMessageId;
    } catch (error) {
      this.logger.warn(
        `DELIVERY_ZONE ${text ? 'text' : 'template'} send failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    const observed = this.now();
    const outcome: DeliveryZoneDeliveryOutcome =
      providerMessageId === null
        ? 'DELIVERY_UNKNOWN'
        : Date.parse(observed) < Date.parse(applyBefore)
          ? 'PROVIDER_ACCEPTED'
          : 'PROVIDER_ACCEPTED_LATE';
    const notified = await this.store.transition(
      row.sourceRequestId,
      'SEND_STARTED',
      {
        status: 'NOTIFIED',
        deliveryOutcome: outcome,
        providerMessageId,
        providerAcceptedObservedAt:
          providerMessageId === null ? null : observed,
        notifiedAt: observed,
        updatedAt: observed,
      },
    );
    try {
      await this.ports.clearPendingQuote(row.senderId);
    } catch {
      // The stale PENDING quote is never orderable; clearing is a courtesy.
    }
    return notified;
  }

  private handoffHold(senderId: string) {
    const { isHumanMode } = this.ports;
    return checkHandoffSendHold(
      isHumanMode === undefined
        ? undefined
        : { isHumanMode: (id) => isHumanMode.call(this.ports, id) },
      senderId,
    );
  }

  /** Never throws: a missing or failed profile read sends the usted text. */
  private async customerStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }

  /** SEND_STARTED found on a later pass = crashed mid-send: unknown, no resend. */
  private recover(
    row: DeliveryZoneRequesterRow,
  ): Promise<DeliveryZoneRequesterRow | null> {
    const now = this.now();
    return this.store.transition(row.sourceRequestId, 'SEND_STARTED', {
      status: 'NOTIFIED',
      deliveryOutcome: 'DELIVERY_UNKNOWN',
      providerMessageId: null,
      providerAcceptedObservedAt: null,
      notifiedAt: now,
      updatedAt: now,
    });
  }

  private async acknowledge(row: DeliveryZoneRequesterRow): Promise<void> {
    const now = this.now();
    const request = ackRequest(row);
    const insideAckWindow =
      row.applyBefore !== null &&
      row.resolution !== null &&
      Date.parse(now) >= Date.parse(row.resolution.resolvedAt) &&
      Date.parse(now) < Date.parse(row.applyBefore);
    if (
      request === null ||
      row.requesterId === null ||
      row.deliveryOutcome === 'PROVIDER_ACCEPTED_LATE' ||
      !insideAckWindow
    ) {
      await this.close(row, null, now);
      return;
    }
    try {
      await this.ports.recordRestockApplicationOutcome(
        row.requesterId,
        request,
      );
    } catch (error) {
      // 4xx (conflict, window, not found) will never succeed: close locally.
      // Transport/5xx/429 stay NOTIFIED for the next pass (same attemptId).
      if (
        error instanceof ChatbotApiError &&
        error.statusCode !== null &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        error.statusCode !== 429
      )
        await this.close(row, null, now);
      return;
    }
    await this.close(row, request.outcome as DeliveryZoneDeliveryOutcome, now);
  }

  private async close(
    row: DeliveryZoneRequesterRow,
    ackOutcome: DeliveryZoneDeliveryOutcome | null,
    now: string,
  ): Promise<void> {
    await this.store.transition(row.sourceRequestId, 'NOTIFIED', {
      status: 'CLOSED',
      ackOutcome,
      ackedAt: ackOutcome === null ? null : now,
      updatedAt: now,
    });
  }
}

/** RESTOCK-identical ACK body built only from persisted evidence. */
function ackRequest(
  row: DeliveryZoneRequesterRow,
): RestockApplicationOutcomeRequest | null {
  const { attemptId, attemptedAt, deliveryOutcome } = row;
  if (attemptId === null || attemptedAt === null || deliveryOutcome === null)
    return null;
  if (deliveryOutcome === 'DELIVERY_UNKNOWN')
    return {
      attemptId,
      expectedResolutionVersion: 2,
      outcome: 'DELIVERY_UNKNOWN',
      attemptedAt,
      ...(row.providerMessageId === null
        ? {}
        : { providerMessageId: row.providerMessageId }),
    };
  if (row.providerMessageId === null || row.providerAcceptedObservedAt === null)
    return null;
  return {
    attemptId,
    expectedResolutionVersion: 2,
    outcome: deliveryOutcome,
    attemptedAt,
    providerMessageId: row.providerMessageId,
    providerAcceptedObservedAt: row.providerAcceptedObservedAt,
  };
}
