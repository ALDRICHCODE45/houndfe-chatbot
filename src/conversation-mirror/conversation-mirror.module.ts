import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { BackendOutboxService } from '../backend-outbox/application/backend-outbox.service';
import { BackendOutboxEnqueueModule } from '../backend-outbox/backend-outbox.module';
import { RoutingBackendOutboxDelivery } from '../backend-outbox/infrastructure/routing-backend-outbox.delivery';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  CONVERSATION_MIRROR_CLIENT,
  type ConversationMirrorClient,
} from '../chatbot-api/domain/conversation-mirror.port';
import { DatabaseModule } from '../database/database.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import {
  MetaMediaClient,
  type MetaMediaClientConfig,
} from '../receipt-media/infrastructure/meta-media.client';
import { MirrorDeliveryGate } from './application/mirror-delivery-gate';
import { MirrorMediaService } from './application/mirror-media.service';
import { MirrorMessagesDelivery } from './application/mirror-messages.delivery';
import { MirrorStatusesDelivery } from './application/mirror-statuses.delivery';
import {
  MIRROR_LINK_FETCHER,
  MIRROR_META_DOWNLOADER,
  type MirrorLinkFetcher,
  type MirrorMetaDownloader,
} from './domain/mirror-media';
import {
  MIRROR_MEDIA_CACHE_STORE,
  type MirrorMediaCacheStore,
} from './domain/mirror-media-cache.store';
import { LinkMirrorFetcher } from './infrastructure/link-mirror-fetcher';
import { MetaMirrorDownloader } from './infrastructure/meta-mirror-downloader';
import { PostgresMirrorMediaCacheStore } from './infrastructure/postgres-mirror-media-cache.store';

/** Registers the MESSAGE_MIRROR / MESSAGE_STATUS batch adapters on the outbox
 *  router when `conversationMirror.deliveryEnabled` is true
 *  (CONVERSATION_MIRROR_DELIVERY_ENABLED, default off); runs at init, before
 *  the drain worker starts on bootstrap. When off, those kinds keep the
 *  not-wired fallback (no HTTP call; rows stay in the outbox and retry), like
 *  every other unregistered kind. */
@Injectable()
export class MirrorOutboxRoutes implements OnModuleInit {
  private readonly logger = new Logger(MirrorOutboxRoutes.name);

  constructor(
    private readonly router: RoutingBackendOutboxDelivery,
    private readonly messages: MirrorMessagesDelivery,
    private readonly statuses: MirrorStatusesDelivery,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (
      this.config.get<boolean>('conversationMirror.deliveryEnabled') !== true
    ) {
      this.logger.log(
        'conversation mirror delivery disabled (CONVERSATION_MIRROR_DELIVERY_ENABLED=false): mirror rows are kept until enabled',
      );
      return;
    }
    this.router.register(['MESSAGE_MIRROR'], this.messages);
    this.router.register(['MESSAGE_STATUS'], this.statuses);
  }
}

/**
 * ConversationMirrorModule (backend unit 9, media): provides and exports
 * `MirrorMediaService`, which the MESSAGE_MIRROR delivery adapter injects to
 * turn a payload's media into a backend `mediaId`.
 *
 *   - IN (Meta media id): a MetaMediaClient built from the same config as the
 *     receipt path (allowed hosts, timeouts), used under the wider mirror
 *     profile only.
 *   - OUT (public link): `LinkMirrorFetcher` (https, public IPs pinned, no
 *     credentials). Same download timeout as Meta; no host allowlist is
 *     configured (the URL comes from the bot's own catalog).
 *   - Cache: `mirror_media_cache` (migration 4800000000000).
 *
 * Delivery (T4/T5): `MirrorMessagesDelivery` (MESSAGE_MIRROR, ≤ 50 per call)
 * and `MirrorStatusesDelivery` (MESSAGE_STATUS, ≤ 100 per call) are
 * registered on the shared outbox router at init, only when
 * CONVERSATION_MIRROR_DELIVERY_ENABLED=true (default off). They share one
 * `MirrorDeliveryGate` (the `conversation:write` credential policy).
 *
 * No worker or timer starts here; the drain worker belongs to
 * `BackendOutboxModule`.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ChatbotApiModule,
    BackendOutboxEnqueueModule,
  ],
  providers: [
    {
      provide: MIRROR_MEDIA_CACHE_STORE,
      useFactory: (pool: Pool): MirrorMediaCacheStore =>
        new PostgresMirrorMediaCacheStore(pool),
      inject: [PG_POOL],
    },
    {
      provide: MIRROR_META_DOWNLOADER,
      useFactory: (config: ConfigService): MirrorMetaDownloader =>
        new MetaMirrorDownloader(
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
        ),
      inject: [ConfigService],
    },
    {
      provide: MIRROR_LINK_FETCHER,
      useFactory: (config: ConfigService): MirrorLinkFetcher =>
        new LinkMirrorFetcher({
          timeoutMs:
            config.get<number>('receiptMedia.meta.downloadTimeoutMs') ?? 0,
        }),
      inject: [ConfigService],
    },
    {
      provide: MirrorMediaService,
      useFactory: (
        client: ConversationMirrorClient,
        meta: MirrorMetaDownloader,
        links: MirrorLinkFetcher,
        cache: MirrorMediaCacheStore,
      ): MirrorMediaService =>
        new MirrorMediaService({ client, meta, links, cache }),
      inject: [
        CONVERSATION_MIRROR_CLIENT,
        MIRROR_META_DOWNLOADER,
        MIRROR_LINK_FETCHER,
        MIRROR_MEDIA_CACHE_STORE,
      ],
    },
    { provide: MirrorDeliveryGate, useFactory: () => new MirrorDeliveryGate() },
    {
      provide: MirrorMessagesDelivery,
      useFactory: (
        client: ConversationMirrorClient,
        media: MirrorMediaService,
        gate: MirrorDeliveryGate,
      ) => new MirrorMessagesDelivery({ client, media, gate }),
      inject: [
        CONVERSATION_MIRROR_CLIENT,
        MirrorMediaService,
        MirrorDeliveryGate,
      ],
    },
    {
      provide: MirrorStatusesDelivery,
      useFactory: (
        client: ConversationMirrorClient,
        outbox: BackendOutboxService,
        gate: MirrorDeliveryGate,
      ) => new MirrorStatusesDelivery({ client, outbox, gate }),
      inject: [
        CONVERSATION_MIRROR_CLIENT,
        BackendOutboxService,
        MirrorDeliveryGate,
      ],
    },
    MirrorOutboxRoutes,
  ],
  exports: [MirrorMediaService],
})
export class ConversationMirrorModule {}
