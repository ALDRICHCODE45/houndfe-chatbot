import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  normalizeDeliveryZoneIntake,
  type DeliveryZoneRequester,
} from '../../chatbot-api/domain/dtos/human-decisions-delivery-zone.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import type { CustomerInboundObservationStore } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import { parseMexicanWhatsAppPhone } from '../../sale-flow/domain/mexican-whatsapp-phone';
import type {
  DeliveryZoneRequesterRow,
  DeliveryZoneRequesterStore,
} from '../domain/delivery-zone-requester';

/** Destination used for the PENDING quote (saved address fields or the
 * confirmed new-address fields). */
export interface DeliveryZoneIntakeRequest {
  senderId: string;
  zipCode: string | null;
  state: string | null;
  municipality: string | null;
  neighborhood: string | null;
}

/** Never throws: a failed intake must not break the customer reply. */
export interface DeliveryZoneIntakePort {
  register(request: DeliveryZoneIntakeRequest): Promise<void>;
}

export const DELIVERY_ZONE_INTAKE = Symbol('DELIVERY_ZONE_INTAKE');

/** Backend answers that a replay of the same body can never fix. */
const PERMANENT_STATUSES = new Set([400, 404, 409, 422]);

/**
 * Registers the customer as a requester of the ZIP's DELIVERY_ZONE
 * validation (S5). The row is persisted before the POST, so a failed or
 * ambiguous intake is retried later by the poller with the same
 * `sourceRequestId` and the exact same body (backend replay → 200).
 */
export class DeliveryZoneIntakeService implements DeliveryZoneIntakePort {
  private readonly logger = new Logger(DeliveryZoneIntakeService.name);

  constructor(
    private readonly store: DeliveryZoneRequesterStore,
    private readonly client: Pick<ChatbotApiClient, 'submitDeliveryZoneIntake'>,
    private readonly inbound: Pick<
      CustomerInboundObservationStore,
      'readLatest'
    >,
    private readonly receivingPhoneNumberId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  async register(request: DeliveryZoneIntakeRequest): Promise<void> {
    try {
      const { senderId, zipCode } = request;
      if (zipCode === null) return;
      const open = await this.store.findOpen(senderId, zipCode);
      if (open) {
        if (open.status === 'INTAKE_PENDING') await this.submit(open);
        return;
      }
      const phone = parseMexicanWhatsAppPhone(senderId);
      if (phone === null) return;
      const now = this.clock().toISOString();
      const intake = normalizeDeliveryZoneIntake({
        sourceRequestId: this.idFactory(),
        type: 'DELIVERY_ZONE',
        zipCode,
        state: request.state,
        municipality: request.municipality,
        neighborhood: request.neighborhood,
        phoneCountryCode: phone.phoneCountryCode,
        phone: phone.phone,
        conversationRef: `wa:${senderId}`,
        lastCustomerMessageAt: await this.lastCustomerMessageAt(senderId, now),
      });
      if (intake === null) {
        this.logger.warn(
          'DELIVERY_ZONE intake skipped: destination does not meet the contract',
        );
        return;
      }
      const row = await this.store.createOrGetOpen(
        emptyRow(senderId, intake, now),
      );
      if (row.status === 'INTAKE_PENDING') await this.submit(row);
    } catch (error) {
      this.logger.warn(`DELIVERY_ZONE intake deferred: ${describe(error)}`);
    }
  }

  /**
   * One POST of the stored body. PENDING/RESOLVED answers advance the row; a
   * permanent rejection closes it as FAILED; anything else only records the
   * attempt time so the poller retries with backoff.
   */
  async submit(row: DeliveryZoneRequesterRow): Promise<void> {
    const now = this.clock().toISOString();
    let requester: DeliveryZoneRequester;
    try {
      requester = await this.client.submitDeliveryZoneIntake(row.intake);
    } catch (error) {
      const permanent =
        error instanceof ChatbotApiError &&
        error.statusCode !== null &&
        PERMANENT_STATUSES.has(error.statusCode);
      await this.store.transition(row.sourceRequestId, 'INTAKE_PENDING', {
        ...(permanent ? { status: 'FAILED' as const } : {}),
        lastPolledAt: now,
        updatedAt: now,
      });
      this.logger.warn(
        `DELIVERY_ZONE intake ${permanent ? 'rejected' : 'failed'}: ${describe(error)}`,
      );
      return;
    }
    await this.store.transition(
      row.sourceRequestId,
      'INTAKE_PENDING',
      requester.status === 'PENDING'
        ? {
            status: 'PENDING',
            requesterId: requester.id,
            lastPolledAt: now,
            updatedAt: now,
          }
        : {
            status: 'RESOLVED',
            requesterId: requester.id,
            resolution: requester.resolution,
            applyBefore: requester.applyBefore,
            lastPolledAt: now,
            updatedAt: now,
          },
    );
  }

  /** Provider time of the latest verified inbound, else now. */
  private async lastCustomerMessageAt(
    senderId: string,
    now: string,
  ): Promise<string> {
    try {
      const latest = await this.inbound.readLatest(
        senderId,
        this.receivingPhoneNumberId,
      );
      if (latest.kind !== 'found') return now;
      const ms = Number(latest.observation.providerTimestampSeconds) * 1000;
      return Number.isSafeInteger(ms) && ms <= Date.parse(now)
        ? new Date(ms).toISOString()
        : now;
    } catch {
      return now;
    }
  }
}

function emptyRow(
  senderId: string,
  intake: DeliveryZoneRequesterRow['intake'],
  now: string,
): DeliveryZoneRequesterRow {
  return {
    sourceRequestId: intake.sourceRequestId,
    senderId,
    zipCode: intake.zipCode,
    intake,
    requesterId: null,
    status: 'INTAKE_PENDING',
    lastPolledAt: null,
    resolution: null,
    applyBefore: null,
    channel: null,
    attemptId: null,
    attemptedAt: null,
    deliveryOutcome: null,
    providerMessageId: null,
    providerAcceptedObservedAt: null,
    notifiedAt: null,
    ackOutcome: null,
    ackedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function describe(error: unknown): string {
  if (error instanceof ChatbotApiError)
    return `${error.name} ${error.statusCode ?? '-'} ${error.errorCode ?? '-'}`;
  return error instanceof Error ? error.name : 'unknown error';
}
