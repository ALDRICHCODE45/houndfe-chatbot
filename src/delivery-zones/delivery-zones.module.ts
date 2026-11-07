import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { ConversationModule } from '../conversation/conversation.module';
import { CustomerProfileModule } from '../customer-profile/customer-profile.module';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { PostgresCustomerInboundObservationStore } from '../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import {
  DELIVERY_ZONE_INTAKE,
  DeliveryZoneIntakeService,
} from './application/delivery-zone-intake.service';
import {
  DELIVERY_ZONE_REQUESTER_STORE,
  type DeliveryZoneRequesterStore,
} from './domain/delivery-zone-requester';
import {
  DELIVERY_ZONE_POLLER_OPTIONS,
  DeliveryZoneRuntime,
  receivingPhone,
} from './delivery-zone.runtime';
import { PostgresDeliveryZoneRequesterStore } from './infrastructure/postgres-delivery-zone-requester.store';

/**
 * DeliveryZonesModule (always on, S5/S8)
 *
 *   - `DELIVERY_ZONE_INTAKE` → registers a PENDING-zone quote as a
 *     DELIVERY_ZONE requester (used by MinimalShippingService).
 *   - `DeliveryZoneRuntime` → durable poller: poll, notify (text or the
 *     `zona_entrega_revisada` template) and ACK.
 *   - `DELIVERY_ZONE_REQUESTER_STORE` → `delivery_zone_requesters` table.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ChatbotApiModule,
    ConversationModule,
    WhatsappSenderModule,
    CustomerProfileModule,
  ],
  providers: [
    {
      provide: DELIVERY_ZONE_REQUESTER_STORE,
      useClass: PostgresDeliveryZoneRequesterStore,
    },
    { provide: DELIVERY_ZONE_POLLER_OPTIONS, useValue: {} },
    {
      provide: DELIVERY_ZONE_INTAKE,
      inject: [
        DELIVERY_ZONE_REQUESTER_STORE,
        CHATBOT_API_CLIENT,
        PG_POOL,
        ConfigService,
      ],
      useFactory: (
        store: DeliveryZoneRequesterStore,
        client: ChatbotApiClient,
        pool: Pool,
        config: ConfigService,
      ) =>
        new DeliveryZoneIntakeService(
          store,
          client,
          new PostgresCustomerInboundObservationStore(pool),
          receivingPhone(config),
        ),
    },
    DeliveryZoneRuntime,
  ],
  exports: [DELIVERY_ZONE_INTAKE],
})
export class DeliveryZonesModule {}
