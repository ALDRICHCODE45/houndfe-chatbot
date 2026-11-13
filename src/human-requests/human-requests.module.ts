import {
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { BackendOutboxService } from '../backend-outbox/application/backend-outbox.service';
import { BackendOutboxEnqueueModule } from '../backend-outbox/backend-outbox.module';
import {
  OUTBOX_DRAIN_WAKER,
  type OutboxDrainWaker,
} from '../backend-outbox/domain/backend-outbox';
import { RoutingBackendOutboxDelivery } from '../backend-outbox/infrastructure/routing-backend-outbox.delivery';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  HUMAN_REQUESTS_CLIENT,
  type HumanRequestsClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { LIVE_CONVERSATION_CLIENT } from '../chatbot-api/domain/live-conversation.port';
import type { LiveConversationClient } from '../chatbot-api/domain/live-conversation.port';
import { HandoffModeService } from '../conversation/application/handoff-mode.service';
import {
  LIVE_RECONCILE_REF,
  type LiveReconcileRef,
} from '../conversation/domain/live-reconcile-ref';
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
import {
  HUMAN_REQUEST_OUTBOX_KINDS,
  HumanRequestCreateService,
} from './application/human-request-create.service';
import { HumanRequestDeliveryService } from './application/human-request-delivery.service';
import {
  LIVE_RECONCILE_LOCK_KEY,
  LiveConversationReconcileWorker,
} from './application/live-conversation-reconcile.worker';
import { LiveConversationSafety } from './application/live-conversation-safety';
import { LiveConversationService } from './application/live-conversation.service';
import { HumanRequestFeedConsumer } from './application/human-request-feed.consumer';
import {
  SCHEDULED_APPOINTMENT_READER,
  ScheduledConversationService,
  type ScheduledAppointmentReader,
} from './application/scheduled-conversation.service';
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
  private reconcile: LiveConversationReconcileWorker | undefined;
  private stopped = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(HUMAN_REQUEST_FEED_STORE)
    private readonly store: HumanRequestFeedStore,
    @Inject(HUMAN_REQUESTS_CLIENT)
    private readonly client: HumanRequestsClient,
    private readonly delivery: HumanRequestDeliveryService,
    // Live conversation T7 (reconcile + safety notice).
    private readonly handoff: HandoffModeService,
    @Inject(LIVE_CONVERSATION_CLIENT)
    private readonly live: LiveConversationClient,
    @Inject(WHATSAPP_SENDER) private readonly sender: WhatsappSenderPort,
    private readonly config: ConfigService,
    @Inject(LIVE_RECONCILE_REF) private readonly reconcileRef: LiveReconcileRef,
    @Optional() private readonly profiles?: CustomerProfileService,
    // Wakes the outbox drain after the safety notice (optional: no-op).
    @Optional()
    @Inject(OUTBOX_DRAIN_WAKER)
    private readonly waker?: OutboxDrainWaker,
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

    // Unit 11 T7: the reconcile (start-up + every ~5 min) and the safety
    // notice run whatever CONVERSATION_MIRROR_DELIVERY_ENABLED says (they
    // are unit 11, not unit 9). The worker is bound into the shared holder
    // so the refused-ack signal and the messages:batch hint can reach it.
    const ports = customerPorts(
      this.handoff,
      this.config,
      this.pool,
      this.profiles,
    );
    const sender = this.sender;
    const waker = this.waker;
    const safety = new LiveConversationSafety({
      feedSyncedAt: () => this.store.readSyncedAt(),
      listHuman: (limit) => this.handoff.listHuman(limit),
      isWindowOpen: ports.isWindowOpen,
      claim: (senderId, epoch) =>
        this.handoff.claimSafetyNotice(senderId, epoch),
      // A BOT message (default origin): mirrored like any bot message.
      send: async (senderId, text) => {
        await sender.sendText({ to: senderId, text });
      },
      ...(ports.customerStyle === undefined
        ? {}
        : { customerStyle: ports.customerStyle }),
      ...(waker === undefined ? {} : { wake: () => waker.wake() }),
    });
    this.reconcile = new LiveConversationReconcileWorker({
      mode: this.handoff,
      client: this.live,
      replay: (ref) => this.delivery.onCustomerInbound(ref),
      lock: new PostgresFeedConsumerLock(this.pool, LIVE_RECONCILE_LOCK_KEY),
      safety,
    });
    this.reconcileRef.current = this.reconcile;
    this.reconcile.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    // Signals stop reaching the worker before it stops.
    if (
      this.reconcile !== undefined &&
      this.reconcileRef.current === this.reconcile
    )
      this.reconcileRef.current = undefined;
    await Promise.all([
      this.consumer?.stop(),
      this.maintenance?.stop(),
      this.reconcile?.stop(),
    ]);
  }
}

/** Registers the REQUEST_CREATE / REQUEST_CANCEL adapter on the outbox
 *  router; runs at init, before the drain worker starts on bootstrap. */
@Injectable()
export class HumanRequestOutboxRoutes implements OnModuleInit {
  constructor(
    private readonly router: RoutingBackendOutboxDelivery,
    private readonly create: HumanRequestCreateService,
  ) {}

  onModuleInit(): void {
    this.router.register(HUMAN_REQUEST_OUTBOX_KINDS, this.create);
  }
}

/** The customer-side ports both services share: HUMAN hold, 24 h window and
 *  the stored customer style. */
function customerPorts(
  handoff: HandoffModeService,
  config: ConfigService,
  pool: Pool,
  profiles?: CustomerProfileService,
) {
  const inbound = new PostgresCustomerInboundObservationStore(pool);
  return {
    handoff: { isHumanMode: (id: string) => handoff.isHumanMode(id) },
    isWindowOpen: (senderId: string) => {
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
  };
}

const CUSTOMER_PORT_TOKENS = [
  // S4: required, so a missing provider fails the boot.
  HandoffModeService,
  ConfigService,
  PG_POOL,
  { token: CustomerProfileService, optional: true },
];

/**
 * HumanRequestsServicesModule (docs/human-request-feed.md): the services
 * only, for feature graphs (WhatsApp dispatcher, LLM agent). It never starts
 * the feed consumer or the sweeps.
 *
 *   - `HUMAN_REQUEST_FEED_STORE` → cursor, delivery ledger and request
 *     registry (migration 4300).
 *   - `HumanRequestDeliveryService` → per-item handling, durable ACKs and
 *     `onCustomerInbound` (window / HUMAN replay).
 *   - `HumanRequestCreateService` → the UNKNOWN_QUESTION create path (S6) and
 *     the REQUEST_CREATE / REQUEST_CANCEL outbox adapter.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    ChatbotApiModule,
    WhatsappSenderModule,
    CustomerProfileModule,
    BackendOutboxEnqueueModule,
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
        live: LiveConversationClient,
        sender: WhatsappSenderPort,
        reconcile: LiveReconcileRef,
        handoff: HandoffModeService,
        config: ConfigService,
        pool: Pool,
        profiles?: CustomerProfileService,
        waker?: OutboxDrainWaker,
        appointments?: ScheduledAppointmentReader,
      ) => {
        const ports = customerPorts(handoff, config, pool, profiles);
        return new HumanRequestDeliveryService({
          store,
          client,
          sender,
          ...ports,
          // Scheduled conversations (unit 14): reminder / reschedule
          // notices. The stored-appointment reader is optional (parent
          // wires it): without it the version check is skipped.
          scheduled: new ScheduledConversationService({
            store,
            isWindowOpen: ports.isWindowOpen,
            ...(ports.customerStyle === undefined
              ? {}
              : { customerStyle: ports.customerStyle }),
            ...(appointments === undefined ? {} : { appointments }),
          }),
          // Live conversation T4/T5: started / reassigned / ended and the
          // staff message / template relays.
          live: new LiveConversationService({
            mode: handoff,
            client: live,
            sender,
            isWindowOpen: ports.isWindowOpen,
            ...(ports.customerStyle === undefined
              ? {}
              : { customerStyle: ports.customerStyle }),
            // A refused session-ack STARTED: reconcile that conversation
            // now (late-bound; a no-op before the worker exists / after it
            // stops). reconcileOne never rejects.
            onAckRefused: (ref: string) => {
              void reconcile.current?.reconcileOne(ref);
            },
            // Bot live notices mirror right away (ordering vs staff).
            ...(waker === undefined ? {} : { wakeOutbox: () => waker.wake() }),
          }),
        });
      },
      inject: [
        HUMAN_REQUEST_FEED_STORE,
        HUMAN_REQUESTS_CLIENT,
        LIVE_CONVERSATION_CLIENT,
        WHATSAPP_SENDER,
        LIVE_RECONCILE_REF,
        ...CUSTOMER_PORT_TOKENS,
        { token: OUTBOX_DRAIN_WAKER, optional: true },
        { token: SCHEDULED_APPOINTMENT_READER, optional: true },
      ],
    },
    {
      provide: HumanRequestCreateService,
      useFactory: (
        store: HumanRequestFeedStore,
        client: HumanRequestsClient,
        sender: WhatsappSenderPort,
        outbox: BackendOutboxService,
        handoff: HandoffModeService,
        config: ConfigService,
        pool: Pool,
        profiles?: CustomerProfileService,
      ) =>
        new HumanRequestCreateService({
          store,
          client,
          sender,
          outbox,
          ...customerPorts(handoff, config, pool, profiles),
        }),
      inject: [
        HUMAN_REQUEST_FEED_STORE,
        HUMAN_REQUESTS_CLIENT,
        WHATSAPP_SENDER,
        BackendOutboxService,
        ...CUSTOMER_PORT_TOKENS,
      ],
    },
  ],
  exports: [
    HUMAN_REQUEST_FEED_STORE,
    HumanRequestDeliveryService,
    HumanRequestCreateService,
  ],
})
export class HumanRequestsServicesModule {}

/**
 * HumanRequestsModule (backend unit 5b), imported by `AppModule` only:
 * re-exports the services, runs the feed consumer (one per database,
 * advisory lock) and the ledger sweeps, and registers the request kinds on
 * the backend outbox router.
 */
@Module({
  imports: [
    HumanRequestsServicesModule,
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    ChatbotApiModule,
    WhatsappSenderModule,
    CustomerProfileModule,
    BackendOutboxEnqueueModule,
  ],
  providers: [HumanRequestFeedLifecycle, HumanRequestOutboxRoutes],
  exports: [HumanRequestsServicesModule],
})
export class HumanRequestsModule {}
