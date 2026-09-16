/** WU14C non-worker composition root: composes the existing adapters (WU2B
 * store, WU4B Meta client, WU5A S3 adapter), the WU7/WU10C/WU11C application
 * services, the WU8A processor, the WU6D1 authorizer, and the WU6D2 access
 * controller behind validated receipt-media configuration. No worker
 * registration, no receipt-outbox composition, and no `ReceiptTx2CommitPort`
 * path — that work stays deferred. Enabled mode decodes the configured
 * base64 keyring exactly here; absent/malformed keyrings fail closed at boot
 * via CapabilityService validation. Disabled mode (`RECEIPT_MEDIA_ENABLED`
 * `=false` with no receipt-specific settings) boots inert: module-local
 * fail-closed Meta/S3/lookup seams replace the configured adapters and the
 * authorizer maps every lookup rejection to its existing `unavailable`
 * result without touching storage. */
import { Module } from '@nestjs/common';
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
import { ReceiptMediaAccessController } from './presentation/receipt-media-access.controller';

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

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ConversationModule,
    ChatbotApiModule,
    WhatsappSenderModule,
  ],
  controllers: [ReceiptMediaAccessController],
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
  ],
  exports: [ReceiptIngressService, ReceiptAmountRouterService],
})
export class ReceiptMediaModule {}
