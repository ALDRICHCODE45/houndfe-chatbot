import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
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
import { MirrorMediaService } from './application/mirror-media.service';
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
 * No worker or timer starts here; the outbox drain is wired elsewhere.
 */
@Module({
  imports: [ConfigModule, DatabaseModule, ChatbotApiModule],
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
  ],
  exports: [MirrorMediaService],
})
export class ConversationMirrorModule {}
