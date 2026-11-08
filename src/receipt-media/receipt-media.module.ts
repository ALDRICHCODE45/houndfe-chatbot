/** Receipt payment flow composition root (always on, R3/S7).
 *
 * Inbound media is admitted by ReceiptIngressService; the ingestion drain
 * downloads the WhatsApp media, reads it with the vision pre-fill
 * (RECEIPT_EXTRACTION over the shared LlmCoreModule seams) and uploads it to
 * the backend, which stores the file (S2). The notification drain sends the
 * committed customer intents, and the outcome poller (R5/S5) relays the human
 * confirm/reject decision. The bot never confirms or rejects a payment (S1).
 *
 * Each drain is owned by a module-local lifecycle coordinator (never a DI
 * token): it starts once on bootstrap, never restarts after shutdown, and
 * drains before the real PostgresPoolLifecycle (DatabaseModule, farther from
 * the root) closes the pool. */
import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import type { ChatbotApiClient } from '../chatbot-api/domain/chatbot-api.client';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ConversationModule } from '../conversation/conversation.module';
import type { ConversationStore } from '../conversation/domain/conversation-store';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { CustomerProfileService } from '../customer-profile/application/customer-profile.service';
import { CustomerProfileModule } from '../customer-profile/customer-profile.module';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { PostgresCustomerInboundObservationStore } from '../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import { CostGuardService } from '../llm-agent/application/cost-guard.service';
import {
  GENERATE_TEXT,
  type GenerateTextFn,
} from '../llm-agent/infrastructure/generate-text.provider';
import { LlmCoreModule } from '../llm-agent/infrastructure/llm-core.module';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import type { WhatsappSenderPort } from '../whatsapp/domain/whatsapp-sender.port';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { ReceiptAttachmentService } from './application/receipt-attachment.service';
import { ReceiptIngestionProcessor } from './application/receipt-ingestion.processor';
import { ReceiptIngressService } from './application/receipt-ingress.service';
import { ReceiptOutcomePoller } from './application/receipt-outcome.poller';
import { ReceiptProcessingDispatcher } from './application/receipt-processing-dispatcher.service';
import { META_MEDIA, type MetaMediaPort } from './domain/meta-media.port';
import { readCustomerWindowOpen } from './domain/receipt-outcome';
import {
  RECEIPT_EXTRACTION,
  type ReceiptExtractionPort,
} from './domain/receipt-extraction.port';
import { LlmReceiptExtractionAdapter } from './infrastructure/llm-receipt-extraction.adapter';
import {
  MetaMediaClient,
  type MetaMediaClientConfig,
} from './infrastructure/meta-media.client';
import { PostgresReceiptMediaStore } from './infrastructure/postgres-receipt-media.store';
import { PostgresReceiptOutboxStore } from './infrastructure/postgres-receipt-outbox.store';
import {
  PrometheusReceiptTelemetry,
  RECEIPT_TELEMETRY,
} from './infrastructure/prometheus-receipt-telemetry';
import { ReceiptMediaIngestionWorker } from './infrastructure/receipt-media-ingestion.worker';
import {
  ReceiptMediaNotificationWorker,
  type NotificationAlertSeam,
} from './infrastructure/receipt-media-notification.worker';
import {
  isConfiguredMetricsToken,
  ReceiptMetricsAuthGuard,
} from './presentation/receipt-metrics-auth.guard';
import { ReceiptMetricsController } from './presentation/receipt-metrics.controller';

/** Constant, non-PII exhaustion alert: no row, sender, or provider/error
 * content ever leaves through this seam. */
const EXHAUSTION_ALERT_TEXT =
  'receipt-media: notification intent exhausted after max attempts';

/** WU14E approved poll floor: the validated environment accepts a poll
 * interval in [1, 59999) ms and the workers require at least 50 ms, so
 * 1–49 ms is normalized UP to 50 ms and larger values are kept. */
const WORKER_MIN_POLL_MS = 50;

/** Validated worker fields: concurrency is the batch size and the max
 * concurrency; the fixed 60-second lease lives in the adapters' SQL. */
const workerOptions = (config: ConfigService) => {
  const concurrency =
    config.get<number>('receiptMedia.worker.concurrency') ?? 0;
  return {
    // Stable per process-instance coordinator: one owner for every claim.
    owner: `receipt-media:${randomUUID()}`,
    pollIntervalMs: Math.max(
      WORKER_MIN_POLL_MS,
      config.get<number>('receiptMedia.worker.pollIntervalMs') ?? 0,
    ),
    batchSize: concurrency,
    maxConcurrency: concurrency,
  };
};

/** The Meta receiving phone: the outcome poller and the notification drain
 * read the customer window for this exact phone (same rule as DELIVERY_ZONE). */
const receivingPhone = (config: ConfigService): string => {
  const phone = config.get<string>('meta.phoneNumberId');
  if (typeof phone !== 'string' || !phone.trim())
    throw new Error(
      'receipt outcome poller requires the Meta receiving phone identity',
    );
  return phone;
};

/** WU14E notification drain: privately owns the outbox drain store and the
 * WU9 worker; starts once, awaits in-flight sends on shutdown. */
@Injectable()
class ReceiptMediaNotificationLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker: ReceiptMediaNotificationWorker | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(WHATSAPP_SENDER)
    private readonly sender: Pick<WhatsappSenderPort, 'sendText'>,
    // S1: notices in the recipient's stored style (usted when unknown).
    @Optional() private readonly profiles?: CustomerProfileService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const profiles = this.profiles;
    const outbox = new PostgresReceiptOutboxStore(this.pool);
    const inbound = new PostgresCustomerInboundObservationStore(this.pool);
    const phone = receivingPhone(this.config);
    this.worker = new ReceiptMediaNotificationWorker(
      outbox,
      this.sender,
      this.exhaustionAlert(),
      workerOptions(this.config),
      // R5: a queued outcome text is sent only while the 24 h window is open.
      {
        isOpen: (recipientId) =>
          readCustomerWindowOpen(inbound, recipientId, phone, new Date()),
        markNotDelivered: (id, owner, lease) =>
          outbox.markNotDelivered(id, owner, lease),
      },
      profiles === undefined
        ? undefined
        : (recipientId) => profiles.styleFor(recipientId),
    );
    this.worker.onApplicationBootstrap();
  }

  /** The `stopped` latch is set even when no worker was ever constructed,
   * so a later bootstrap cannot restart after shutdown/pool close. */
  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.worker?.onModuleDestroy() ?? Promise.resolve();
  }

  private exhaustionAlert(): NotificationAlertSeam {
    return {
      onExhausted: (): Promise<void> => {
        Logger.error(EXHAUSTION_ALERT_TEXT);
        return Promise.resolve();
      },
    };
  }
}

/** ODD-3A ingestion drain: privately owns the dispatcher and the WU8B2
 * worker; starts once, gracefully drains in-flight work on shutdown. */
@Injectable()
class ReceiptMediaIngestionLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker: ReceiptMediaIngestionWorker | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly store: PostgresReceiptMediaStore,
    private readonly processor: ReceiptIngestionProcessor,
  ) {}

  onApplicationBootstrap(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.worker = new ReceiptMediaIngestionWorker(
      this.store,
      new ReceiptProcessingDispatcher(this.processor),
      workerOptions(this.config),
    );
    this.worker.onApplicationBootstrap();
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.worker?.onModuleDestroy() ?? Promise.resolve();
  }
}

/** R5 outcome poller: privately owns the durable poller over ATTACHED
 * receipts; starts once on boot, drains the active tick on shutdown. */
@Injectable()
class ReceiptOutcomeLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private poller: ReceiptOutcomePoller | undefined;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly store: PostgresReceiptMediaStore,
    @Inject(CHATBOT_API_CLIENT) private readonly client: ChatbotApiClient,
  ) {}

  onApplicationBootstrap(): void {
    if (this.poller || this.stopped) return;
    const inbound = new PostgresCustomerInboundObservationStore(this.pool);
    this.poller = new ReceiptOutcomePoller(
      this.store,
      {
        // Late-bound: the ports resolve at call time, never at boot.
        getReceiptOutcome: (id) => this.client.getReceiptOutcome(id),
        readLatest: (senderId, phoneId) =>
          inbound.readLatest(senderId, phoneId),
      },
      receivingPhone(this.config),
    );
    this.poller.start();
  }

  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.poller?.stop() ?? Promise.resolve();
  }
}

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    ChatbotApiModule,
    WhatsappSenderModule,
    LlmCoreModule,
    CustomerProfileModule,
  ],
  controllers: [ReceiptMetricsController],
  providers: [
    {
      provide: PostgresReceiptMediaStore,
      useFactory: (pool: Pool) => new PostgresReceiptMediaStore(pool),
      inject: [PG_POOL],
    },
    {
      provide: META_MEDIA,
      useFactory: (config: ConfigService): MetaMediaPort =>
        new MetaMediaClient(
          {
            graphApiBaseUrl: config.get<string>('meta.graphApiBaseUrl') ?? '',
            allowedHosts:
              config.get<string[]>('receiptMedia.meta.allowedHosts') ?? [],
            metadataTimeoutMs:
              config.get<number>('receiptMedia.meta.metadataTimeoutMs') ?? 0,
            downloadTimeoutMs:
              config.get<number>('receiptMedia.meta.downloadTimeoutMs') ?? 0,
          } satisfies MetaMediaClientConfig,
          () => config.get<string>('meta.accessToken') ?? '',
        ),
      inject: [ConfigService],
    },
    {
      provide: ReceiptIngressService,
      useFactory: (
        conversations: ConversationStore,
        store: PostgresReceiptMediaStore,
      ): ReceiptIngressService =>
        new ReceiptIngressService(
          { getState: (senderId: string) => conversations.get(senderId) },
          store,
        ),
      inject: [CONVERSATION_STORE, PostgresReceiptMediaStore],
    },
    {
      // R4 vision pre-fill: same GENERATE_TEXT seam, model and cost guard as
      // the agent; it never confirms or rejects a payment (S1).
      provide: RECEIPT_EXTRACTION,
      useFactory: (
        generateTextFn: GenerateTextFn,
        config: ConfigService,
        costGuard: CostGuardService,
      ): ReceiptExtractionPort =>
        new LlmReceiptExtractionAdapter(
          generateTextFn,
          config.get<string>('llm.model') ?? '',
          { costGuard },
        ),
      inject: [GENERATE_TEXT, ConfigService, CostGuardService],
    },
    {
      // R2: the backend stores the receipt (S2); multipart upload keyed by
      // the WhatsApp media id.
      provide: ReceiptAttachmentService,
      useFactory: (
        store: PostgresReceiptMediaStore,
        client: ChatbotApiClient,
      ): ReceiptAttachmentService =>
        new ReceiptAttachmentService(store, client),
      inject: [PostgresReceiptMediaStore, CHATBOT_API_CLIENT],
    },
    {
      provide: ReceiptIngestionProcessor,
      useFactory: (
        meta: MetaMediaPort,
        store: PostgresReceiptMediaStore,
        extraction: ReceiptExtractionPort,
        attachment: ReceiptAttachmentService,
        conversations: ConversationStore,
      ): ReceiptIngestionProcessor =>
        new ReceiptIngestionProcessor(
          meta,
          store,
          extraction,
          attachment,
          conversations,
        ),
      inject: [
        META_MEDIA,
        PostgresReceiptMediaStore,
        RECEIPT_EXTRACTION,
        ReceiptAttachmentService,
        CONVERSATION_STORE,
      ],
    },
    ReceiptMediaNotificationLifecycle,
    ReceiptMediaIngestionLifecycle,
    ReceiptOutcomeLifecycle,
    // WU15-2 telemetry: the adapter's record() is a no-op when no metrics
    // token is configured and never escapes failures. No Prometheus scrape
    // causes provider I/O.
    ReceiptMetricsAuthGuard,
    {
      provide: RECEIPT_TELEMETRY,
      useFactory: (config: ConfigService): PrometheusReceiptTelemetry =>
        new PrometheusReceiptTelemetry(
          isConfiguredMetricsToken(
            config.get<string>('receiptMedia.metricsToken'),
          ),
        ),
      inject: [ConfigService],
    },
  ],
  exports: [ReceiptIngressService, RECEIPT_TELEMETRY],
})
export class ReceiptMediaModule {}
