import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../conversation/domain/conversation-store';
import { PG_POOL } from '../database/postgres-pool.provider';
import { CustomerProfileService } from '../customer-profile/application/customer-profile.service';
import { PostgresCustomerInboundObservationStore } from '../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import {
  WHATSAPP_SENDER,
  type WhatsappSenderPort,
} from '../whatsapp/domain/whatsapp-sender.port';
import {
  DELIVERY_ZONE_INTAKE,
  DeliveryZoneIntakeService,
} from './application/delivery-zone-intake.service';
import { DeliveryZoneNotifier } from './application/delivery-zone-notifier';
import {
  DeliveryZonePoller,
  type DeliveryZonePollerOptions,
} from './application/delivery-zone-poller';
import {
  DELIVERY_ZONE_REQUESTER_STORE,
  type DeliveryZoneRequesterStore,
} from './domain/delivery-zone-requester';
import { clearPendingZoneQuote } from './infrastructure/clear-pending-zone-quote';

export const DELIVERY_ZONE_POLLER_OPTIONS = Symbol(
  'DELIVERY_ZONE_POLLER_OPTIONS',
);

/** Always-on DELIVERY_ZONE runtime: starts the durable poller on boot and
 * drains it before the shared pool closes. */
@Injectable()
export class DeliveryZoneRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private poller?: DeliveryZonePoller;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DELIVERY_ZONE_REQUESTER_STORE)
    private readonly store: DeliveryZoneRequesterStore,
    @Inject(DELIVERY_ZONE_INTAKE)
    private readonly intake: DeliveryZoneIntakeService,
    @Inject(CHATBOT_API_CLIENT) private readonly client: ChatbotApiClient,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsappSenderPort,
    @Inject(CONVERSATION_STORE)
    private readonly conversations: ConversationStore,
    @Inject(DELIVERY_ZONE_POLLER_OPTIONS)
    private readonly options: DeliveryZonePollerOptions,
    // S1: the resolved-zone text in the customer's stored style.
    @Optional() private readonly profiles?: CustomerProfileService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.poller || this.stopped) return;
    const phone = receivingPhone(this.config);
    const inbound = new PostgresCustomerInboundObservationStore(this.pool);
    const notifier = new DeliveryZoneNotifier(
      this.store,
      {
        // Late-bound: the ports resolve at call time, never at boot.
        getDeliveryZoneRequester: (id) =>
          this.client.getDeliveryZoneRequester(id),
        // DELIVERY_ZONE ACK is identical to RESTOCK (contract §4.3).
        recordRestockApplicationOutcome: (id, request) =>
          this.client.recordRestockApplicationOutcome(id, request),
        sendText: (message) => this.sender.sendText(message),
        sendTemplate: (message) => this.sender.sendTemplate(message),
        readLatest: (senderId, phoneId) =>
          inbound.readLatest(senderId, phoneId),
        submit: (row) => this.intake.submit(row),
        clearPendingQuote: (senderId) =>
          clearPendingZoneQuote(this.conversations, senderId),
        customerStyle: (senderId) =>
          this.profiles?.styleFor(senderId) ?? Promise.resolve(null),
      },
      phone,
    );
    this.poller = new DeliveryZonePoller(this.store, notifier, this.options);
    this.poller.start();
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.poller?.stop() ?? Promise.resolve();
  }
}

export function receivingPhone(config: ConfigService): string {
  const phone = config.get<string>('meta.phoneNumberId');
  if (typeof phone !== 'string' || !phone.trim())
    throw new Error(
      'DELIVERY_ZONE runtime requires the Meta receiving phone identity',
    );
  return phone;
}
