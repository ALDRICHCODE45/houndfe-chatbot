/** WU14C composition root, extended by WU14E and ODD-3A: composes the existing
 * adapters (WU2B store, WU4B Meta client, WU5A S3 adapter), the
 * WU7/WU10C/WU11C application services, the WU8A processor, the WU6D1
 * authorizer, and the WU6D2 access controller behind validated
 * receipt-media configuration — and, when enabled, starts the WU9
 * notification drain AND the ODD-3A ingestion drain through module-local
 * lifecycle coordinators that privately own their workers (the WU14A outbox
 * store/notification worker, and the WU7/WU10C dispatcher/WU8B2 ingestion
 * worker respectively). Neither worker is a DI token. No
 * `ReceiptOutboxService`/`ReceiptTx2CommitPort` path, and no outbox intent
 * production — the notification drain consumes already-committed intents
 * only, and the ingestion drain claims the existing receipt_media states.
 * Enabled mode decodes the configured
 * base64 keyring exactly here; absent/malformed keyrings fail closed at
 * boot via CapabilityService validation. Disabled mode
 * (`RECEIPT_MEDIA_ENABLED=false` with no receipt-specific settings) boots
 * inert: module-local fail-closed Meta/S3/lookup seams replace the
 * configured adapters, the authorizer maps every lookup rejection to its
 * existing `unavailable` result without touching storage, and the
 * notification lifecycle performs no claims, polling, sends, or alerts.
 * Enable/disable takes effect by graceful restart/redeploy, never by live
 * runtime toggling. */
import { Module } from '@nestjs/common';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
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
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import type { WhatsappSenderPort } from '../whatsapp/domain/whatsapp-sender.port';
import { WhatsappSenderModule } from '../whatsapp/whatsapp-sender.module';
import { CapabilityService } from './application/capability.service';
import { ReceiptAmountRouterService } from './application/receipt-amount-router.service';
import { ReceiptAttachmentService } from './application/receipt-attachment.service';
import {
  RECEIPT_CAPABILITY_LOOKUP,
  ReceiptCapabilityAuthorizerService,
  type ReceiptCapabilityLookup,
} from './application/receipt-capability-authorizer.service';
import { ReceiptIngestionProcessor } from './application/receipt-ingestion.processor';
import { ReceiptIngressService } from './application/receipt-ingress.service';
import { ReceiptProcessingDispatcher } from './application/receipt-processing-dispatcher.service';
import {
  META_MEDIA,
  MetaMediaError,
  type MetaMediaPort,
} from './domain/meta-media.port';
import {
  OBJECT_STORAGE_PORT,
  ObjectStorageError,
  type ObjectStoragePort,
} from './domain/object-storage.port';
import {
  MetaMediaClient,
  type MetaMediaClientConfig,
} from './infrastructure/meta-media.client';
import { PostgresReceiptMediaStore } from './infrastructure/postgres-receipt-media.store';
import {
  S3ObjectStorageAdapter,
  type S3ObjectStorageConfig,
} from './infrastructure/s3-object-storage.adapter';
import { PostgresReceiptOutboxStore } from './infrastructure/postgres-receipt-outbox.store';
import { ReceiptMediaIngestionWorker } from './infrastructure/receipt-media-ingestion.worker';
import {
  ReceiptMediaNotificationWorker,
  type NotificationAlertSeam,
} from './infrastructure/receipt-media-notification.worker';
import { ReceiptMediaAccessController } from './presentation/receipt-media-access.controller';
import { ReceiptMetricsAuthGuard } from './presentation/receipt-metrics-auth.guard';
import { ReceiptMetricsController } from './presentation/receipt-metrics.controller';
import {
  PrometheusReceiptTelemetry,
  RECEIPT_TELEMETRY,
} from './infrastructure/prometheus-receipt-telemetry';

/** Decodes validated `version:base64` keyring entries into raw key bytes. */
const decodeKeyring = (
  entries: readonly string[] | undefined,
): Map<string, Uint8Array> => {
  const keys = new Map<string, Uint8Array>();
  for (const entry of entries ?? []) {
    const colon = entry.indexOf(':');
    keys.set(
      colon < 1 ? entry : entry.slice(0, colon),
      colon < 1
        ? new Uint8Array()
        : Buffer.from(entry.slice(colon + 1), 'base64'),
    );
  }
  return keys;
};

/** Narrow enabled/disabled gate over the validated receiptMedia subtree. */
const isEnabled = (config: ConfigService): boolean =>
  config.get<boolean>('receiptMedia.enabled') === true;

/** R3-cleanup-rollout-gate: the ingestion lifecycle starts only when receipt
 * media is broadly enabled AND the dedicated, default-false ingestion rollout
 * gate (`receiptMedia.worker.enabled`) is exactly true. Notification and every
 * other receipt-media feature stay governed by `isEnabled` alone. */
const isIngestionEnabled = (config: ConfigService): boolean =>
  isEnabled(config) &&
  config.get<boolean>('receiptMedia.worker.enabled') === true;

/** Fixed inert keyring for the disabled capability stand-in: never
 * configured, never persisted, and unusable for real tokens because the
 * disabled lookup seam rejects before any verification. */
const DISABLED_CAPABILITY_KEYRING = new Map<string, Uint8Array>([
  ['1', new Uint8Array(32)],
]);

/** Fail-closed disabled Meta seam: no Graph API access is ever attempted. */
const disabledMetaMedia = (): MetaMediaPort => ({
  resolveAndDownload: () =>
    Promise.reject(new MetaMediaError('META_TRANSPORT', 'HTTP_PERMANENT')),
});

/** Fail-closed disabled storage seam: no object-storage access is ever
 * attempted; every operation is the same fixed permanent rejection. */
const permanentStorageRejection = (): Promise<never> =>
  Promise.reject(new ObjectStorageError('OBJECT_STORAGE', 'PERMANENT_FAILURE'));

const disabledObjectStorage = (): ObjectStoragePort => ({
  put: permanentStorageRejection,
  getStream: permanentStorageRejection,
  head: permanentStorageRejection,
  deleteTechnicalObject: permanentStorageRejection,
});

/** Fail-closed disabled lookup seam: the authorizer maps this rejection
 * to its existing `unavailable` result without any store query. */
const disabledCapabilityLookup: ReceiptCapabilityLookup = {
  lookupByCapabilityHash: () =>
    Promise.reject(new Error('RECEIPT_MEDIA_DISABLED')),
};

/** Constant, non-PII exhaustion alert: no row, sender, or provider/error
 * content ever leaves through this seam. */
const EXHAUSTION_ALERT_TEXT =
  'receipt-media: notification intent exhausted after max attempts';

/** WU14E approved poll floor (confirmed by the maintainer, not inferred):
 * the validated receipt-media environment accepts a poll interval in
 * [1, 59999) ms and the worker's own invariant requires at least 50 ms,
 * so configured 1–49 ms is normalized UP to 50 ms and any configured
 * value at or above 50 ms is preserved unchanged. Proven at the 1/49/50
 * boundaries and above-floor by observed claim timing in the spec. */
const WORKER_MIN_POLL_MS = 50;

/** WU14E module-local singleton lifecycle coordinator: when the validated
 * receipt-media configuration is enabled, it privately constructs the
 * WU14A outbox drain store and the WU9 notification worker (they are never
 * registered as DI tokens) and forwards start/drain exactly once — the
 * start guard makes repeated bootstrap invocations AND a bootstrap after
 * shutdown no-ops, so no second claim loop can be orphaned and no restart
 * can happen after stop. On Nest shutdown its `onModuleDestroy` awaits
 * the worker's in-flight sends and stops the claim loop BEFORE the real
 * PostgresPoolLifecycle (in DatabaseModule, strictly farther from the
 * root) invokes `pool.end`, so no notification transaction can run
 * against a closed pool. In disabled mode both hooks are inert: no
 * worker, no store, no claims, no timers, no sends, no alerts. Enable/
 * disable is configuration + graceful restart/redeploy, never a live
 * runtime toggle. */
@Injectable()
class ReceiptMediaNotificationLifecycle
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker: ReceiptMediaNotificationWorker | undefined;
  private started = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(WHATSAPP_SENDER)
    private readonly sender: Pick<WhatsappSenderPort, 'sendText'>,
  ) {}

  /** Starts the drain exactly once per coordinator instance — repeated
   * and post-shutdown invocations are no-ops (the worker reference alone
   * cannot protect a NEW instance, so a latched flag guards both).
   * Disabled mode constructs nothing and performs no I/O. */
  onApplicationBootstrap(): void {
    if (this.started || !isEnabled(this.config)) return;
    this.started = true;
    // Validated worker fields only: concurrency supplies batch size and
    // max concurrency; the validated poll interval (normalized up to
    // the maintainer-approved 50 ms floor) supplies polling; the fixed
    // 60-second lease lives in the adapter's SQL alone — no second
    // lease knob exists here.
    const concurrency =
      this.config.get<number>('receiptMedia.worker.concurrency') ?? 0;
    const pollIntervalMs = Math.max(
      WORKER_MIN_POLL_MS,
      this.config.get<number>('receiptMedia.worker.pollIntervalMs') ?? 0,
    );
    this.worker = new ReceiptMediaNotificationWorker(
      new PostgresReceiptOutboxStore(this.pool),
      this.sender,
      this.exhaustionAlert(),
      {
        // Stable per process-instance coordinator: one owner for every
        // claim this instance ever makes.
        owner: `receipt-media:${randomUUID()}`,
        pollIntervalMs,
        batchSize: concurrency,
        maxConcurrency: concurrency,
      },
    );
    this.worker.onApplicationBootstrap();
  }

  /** Drains in-flight sends and stops claims exactly once; disabled mode
   * has nothing to drain. */
  onModuleDestroy(): Promise<void> {
    return this.worker?.onModuleDestroy() ?? Promise.resolve();
  }

  /** Constant non-PII exhaustion alert: never the row, sender, or
   * provider/error content. */
  private exhaustionAlert(): NotificationAlertSeam {
    return {
      onExhausted: (): Promise<void> => {
        Logger.error(EXHAUSTION_ALERT_TEXT);
        return Promise.resolve();
      },
    };
  }
}

/** ODD-3A module-local singleton lifecycle coordinator: when receipt media is
 * broadly enabled AND the dedicated ingestion rollout gate is true it
 * privately constructs exactly one
 * WU7/WU10C dispatcher from the existing processor + attachment service and
 * exactly one WU8B2 ingestion worker from the existing PostgresReceiptMediaStore
 * plus validated options — neither the dispatcher nor the worker is ever
 * registered as a DI token — and forwards start/drain exactly once. The start
 * guard makes repeated bootstrap invocations AND a bootstrap after shutdown
 * no-ops, so no second claim loop can be orphaned and no restart can happen
 * after stop. On Nest shutdown `onModuleDestroy` awaits the worker's graceful
 * drain (aborting active dispatch signals and waiting for in-flight work)
 * BEFORE the real PostgresPoolLifecycle (in DatabaseModule, strictly farther
 * from the root) invokes `pool.end`, so no ingestion transaction can run
 * against a closed pool. Disabled mode is fully inert: no dispatcher, no
 * worker, no claims, no timers, no external calls. Enable/disable is
 * configuration + graceful restart/redeploy, never a live runtime toggle. */
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
    private readonly attachment: ReceiptAttachmentService,
  ) {}

  /** Starts exactly once per coordinator instance — repeated and
   * post-shutdown invocations are no-ops (the worker reference alone cannot
   * protect a NEW instance, so a latched flag guards both; the `stopped`
   * latch also covers destruction BEFORE the first bootstrap, when no worker
   * exists yet). Disabled mode (broad flag off OR the dedicated ingestion
   * rollout gate off) constructs nothing and performs no I/O. */
  onApplicationBootstrap(): void {
    if (this.started || this.stopped || !isIngestionEnabled(this.config))
      return;
    this.started = true;
    // Validated worker fields only: concurrency supplies batch size and
    // max concurrency; the validated poll interval (normalized up to the
    // maintainer-approved 50 ms floor) supplies polling; the fixed
    // 60-second lease lives in the adapter's SQL alone — no second lease
    // knob exists here.
    const concurrency =
      this.config.get<number>('receiptMedia.worker.concurrency') ?? 0;
    const pollIntervalMs = Math.max(
      WORKER_MIN_POLL_MS,
      this.config.get<number>('receiptMedia.worker.pollIntervalMs') ?? 0,
    );
    this.worker = new ReceiptMediaIngestionWorker(
      this.store,
      new ReceiptProcessingDispatcher(this.processor, this.attachment),
      {
        // Stable per process-instance coordinator: one owner for every
        // claim this instance ever makes.
        owner: `receipt-media:${randomUUID()}`,
        pollIntervalMs,
        batchSize: concurrency,
        maxConcurrency: concurrency,
      },
    );
    this.worker.onApplicationBootstrap();
  }

  /** Gracefully drains in-flight ingestion work and stops claims exactly
   * once; disabled mode has nothing to drain. The `stopped` latch is set even
   * when no worker was ever constructed, so a later bootstrap cannot restart
   * the lifecycle after shutdown/pool close. */
  onModuleDestroy(): Promise<void> {
    this.stopped = true;
    return this.worker?.onModuleDestroy() ?? Promise.resolve();
  }
}

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    ChatbotApiModule,
    WhatsappSenderModule,
  ],
  controllers: [ReceiptMediaAccessController, ReceiptMetricsController],
  providers: [
    // One shared store singleton; the capability lookup aliases it.
    {
      provide: PostgresReceiptMediaStore,
      useFactory: (pool: Pool) => new PostgresReceiptMediaStore(pool),
      inject: [PG_POOL],
    },
    {
      provide: RECEIPT_CAPABILITY_LOOKUP,
      useExisting: PostgresReceiptMediaStore,
    },
    {
      provide: META_MEDIA,
      useFactory: (config: ConfigService): MetaMediaPort =>
        isEnabled(config)
          ? new MetaMediaClient(
              {
                graphApiBaseUrl:
                  config.get<string>('meta.graphApiBaseUrl') ?? '',
                allowedHosts:
                  config.get<string[]>('receiptMedia.meta.allowedHosts') ?? [],
                metadataTimeoutMs:
                  config.get<number>('receiptMedia.meta.metadataTimeoutMs') ??
                  0,
                downloadTimeoutMs:
                  config.get<number>('receiptMedia.meta.downloadTimeoutMs') ??
                  0,
              } satisfies MetaMediaClientConfig,
              () => config.get<string>('meta.accessToken') ?? '',
            )
          : disabledMetaMedia(),
      inject: [ConfigService],
    },
    {
      provide: OBJECT_STORAGE_PORT,
      useFactory: (config: ConfigService): ObjectStoragePort =>
        isEnabled(config)
          ? new S3ObjectStorageAdapter(
              config.get<S3ObjectStorageConfig>('receiptMedia.storage') ??
                ({} as S3ObjectStorageConfig),
            )
          : disabledObjectStorage(),
      inject: [ConfigService],
    },
    {
      provide: CapabilityService,
      useFactory: (config: ConfigService): CapabilityService =>
        isEnabled(config)
          ? new CapabilityService(
              decodeKeyring(
                config.get<string[]>('receiptMedia.capability.keys'),
              ),
              config.get<string>('receiptMedia.capability.activeVersion') ?? '',
            )
          : new CapabilityService(DISABLED_CAPABILITY_KEYRING, '1'),
      inject: [ConfigService],
    },
    {
      provide: ReceiptIngressService,
      useFactory: (
        config: ConfigService,
        conversations: ConversationStore,
        store: PostgresReceiptMediaStore,
      ): ReceiptIngressService =>
        new ReceiptIngressService(
          { enabled: isEnabled(config) },
          { getState: (senderId: string) => conversations.get(senderId) },
          store,
        ),
      inject: [ConfigService, CONVERSATION_STORE, PostgresReceiptMediaStore],
    },
    {
      provide: ReceiptAmountRouterService,
      useFactory: (
        conversations: ConversationStore,
        store: PostgresReceiptMediaStore,
      ): ReceiptAmountRouterService =>
        new ReceiptAmountRouterService(conversations, store),
      inject: [CONVERSATION_STORE, PostgresReceiptMediaStore],
    },
    {
      provide: ReceiptAttachmentService,
      useFactory: (
        store: PostgresReceiptMediaStore,
        client: ChatbotApiClient,
        config: ConfigService,
      ): ReceiptAttachmentService =>
        new ReceiptAttachmentService(store, client, {
          receiptMedia: {
            publicBaseUrl:
              config.get<string>('receiptMedia.publicBaseUrl') ?? '',
          },
        }),
      inject: [PostgresReceiptMediaStore, CHATBOT_API_CLIENT, ConfigService],
    },
    {
      provide: ReceiptIngestionProcessor,
      useFactory: (
        meta: MetaMediaPort,
        storage: ObjectStoragePort,
        store: PostgresReceiptMediaStore,
        capability: CapabilityService,
      ): ReceiptIngestionProcessor =>
        new ReceiptIngestionProcessor(meta, storage, store, capability),
      inject: [
        META_MEDIA,
        OBJECT_STORAGE_PORT,
        PostgresReceiptMediaStore,
        CapabilityService,
      ],
    },
    {
      provide: ReceiptCapabilityAuthorizerService,
      useFactory: (
        config: ConfigService,
        capabilityService: CapabilityService,
        lookup: unknown,
      ): ReceiptCapabilityAuthorizerService =>
        new ReceiptCapabilityAuthorizerService(
          capabilityService,
          isEnabled(config) ? (lookup as never) : disabledCapabilityLookup,
        ),
      inject: [ConfigService, CapabilityService, RECEIPT_CAPABILITY_LOOKUP],
    },
    // WU14E module-local lifecycle coordinator: privately owns the
    // notification drain; never exported — worker/store stay unexposed
    // as DI tokens. In disabled mode its hooks are fully inert.
    ReceiptMediaNotificationLifecycle,
    // ODD-3A module-local lifecycle coordinator: privately owns the
    // ingestion dispatcher/worker; never exported — the worker stays
    // unexposed as a DI token. In disabled mode its hooks are fully inert.
    ReceiptMediaIngestionLifecycle,
    // WU15-2 telemetry: singleton adapter + guard. The telemetry adapter
    // carries its own isolated Registry; two instances with the same Registry
    // resolve to the same object (singleton DI). The adapter's record()
    // method is a no-op when metricsFlag is false and never escapes failures.
    // No Prometheus scrape causes storage/provider I/O.
    ReceiptMetricsAuthGuard,
    {
      provide: RECEIPT_TELEMETRY,
      useFactory: (config: ConfigService): PrometheusReceiptTelemetry =>
        new PrometheusReceiptTelemetry(
          config.get<boolean>('receiptMedia.metricsEnabled') === true,
        ),
      inject: [ConfigService],
    },
  ],
  exports: [
    ReceiptIngressService,
    ReceiptAmountRouterService,
    RECEIPT_TELEMETRY,
  ],
})
export class ReceiptMediaModule {}
