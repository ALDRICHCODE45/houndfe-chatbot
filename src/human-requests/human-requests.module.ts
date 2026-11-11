import {
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  HUMAN_REQUESTS_CLIENT,
  type HumanRequestsClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { HandoffModeService } from '../conversation/application/handoff-mode.service';
import { ConversationModule } from '../conversation/conversation.module';
import { CustomerProfileService } from '../customer-profile/application/customer-profile.service';
import { CustomerProfileModule } from '../customer-profile/customer-profile.module';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { PostgresCustomerInboundObservationStore } from '../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import { readCustomerWindowOpen } from '../receipt-media/domain/receipt-outcome';
import {
  WHATSAPP_SENDER,
  type WhatsappSenderPort,
} from '../whatsapp/domain/whatsapp-sender.port';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { HumanRequestDeliveryService } from './application/human-request-delivery.service';
import { HumanRequestFeedConsumer } from './application/human-request-feed.consumer';
import { HumanRequestMaintenanceWorker } from './application/human-request-maintenance.worker';
import {
  HUMAN_REQUEST_FEED_STORE,
  type HumanRequestFeedStore,
} from './domain/human-request-feed';
import { PostgresFeedConsumerLock } from './infrastructure/postgres-feed-consumer.lock';
import { PostgresHumanRequestFeedStore } from './infrastructure/postgres-human-request-feed.store';

/**
 * Owns the feed consumer and the ledger sweeps: starts once on bootstrap,
 * never restarts after shutdown, and stops in onModuleDestroy (the consumer
 * releases its advisory-lock connection) before PostgresPoolLifecycle
 * (DatabaseModule, farther from the root) closes the pool.
 */
@Injectable()
export class HumanRequestFeedLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private consumer: HumanRequestFeedConsumer | undefined;
  private maintenance: HumanRequestMaintenanceWorker | undefined;
  private stopped = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(HUMAN_REQUEST_FEED_STORE)
    private readonly store: HumanRequestFeedStore,
    @Inject(HUMAN_REQUESTS_CLIENT)
    private readonly client: HumanRequestsClient,
    private readonly delivery: HumanRequestDeliveryService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.consumer || this.stopped) return;
    this.consumer = new HumanRequestFeedConsumer({
      store: this.store,
      client: this.client,
      delivery: this.delivery,
      lock: new PostgresFeedConsumerLock(this.pool),
    });
    this.maintenance = new HumanRequestMaintenanceWorker(this.delivery);
    this.consumer.start();
    this.maintenance.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.consumer?.stop(), this.maintenance?.stop()]);
  }
}

/**
 * HumanRequestsModule (backend unit 5b, docs/human-request-feed.md)
 *
 *   - `HUMAN_REQUEST_FEED_STORE` → cursor, delivery ledger and request
 *     registry (migration 4300); exported for the create path (T3).
 *   - `HumanRequestDeliveryService` → per-item handling, durable ACKs and
 *     `onCustomerInbound` (window / HUMAN replay); exported.
 *   - Runs the feed consumer (one per database, advisory lock) and the
 *     ledger sweeps; imported by `AppModule`.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    ChatbotApiModule,
    WhatsappSenderModule,
    CustomerProfileModule,
  ],
  providers: [
    {
      provide: HUMAN_REQUEST_FEED_STORE,
      useFactory: (pool: Pool) => new PostgresHumanRequestFeedStore(pool),
      inject: [PG_POOL],
    },
    {
      provide: HumanRequestDeliveryService,
      useFactory: (
        store: HumanRequestFeedStore,
        client: HumanRequestsClient,
        sender: WhatsappSenderPort,
        // S4: required, so a missing provider fails the boot.
        handoff: HandoffModeService,
        config: ConfigService,
        pool: Pool,
        profiles?: CustomerProfileService,
      ) => {
        const inbound = new PostgresCustomerInboundObservationStore(pool);
        return new HumanRequestDeliveryService({
          store,
          client,
          sender,
          handoff: { isHumanMode: (id) => handoff.isHumanMode(id) },
          isWindowOpen: (senderId) => {
            const phone = config.get<string>('meta.phoneNumberId');
            if (typeof phone !== 'string' || !phone.trim())
              return Promise.reject(
                new Error('the Meta receiving phone identity is missing'),
              );
            return readCustomerWindowOpen(inbound, senderId, phone, new Date());
          },
          ...(profiles === undefined
            ? {}
            : { customerStyle: (id: string) => profiles.styleFor(id) }),
        });
      },
      inject: [
        HUMAN_REQUEST_FEED_STORE,
        HUMAN_REQUESTS_CLIENT,
        WHATSAPP_SENDER,
        HandoffModeService,
        ConfigService,
        PG_POOL,
        { token: CustomerProfileService, optional: true },
      ],
    },
    HumanRequestFeedLifecycle,
  ],
  exports: [HUMAN_REQUEST_FEED_STORE, HumanRequestDeliveryService],
})
export class HumanRequestsModule {}
