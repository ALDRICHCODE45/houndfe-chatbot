import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { CONVERSATION_MIRROR_CLIENT } from '../chatbot-api/domain/conversation-mirror.port';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { MirrorMediaService } from './application/mirror-media.service';
import { ConversationMirrorModule } from './conversation-mirror.module';
import {
  MIRROR_LINK_FETCHER,
  MIRROR_META_DOWNLOADER,
} from './domain/mirror-media';
import { MIRROR_MEDIA_CACHE_STORE } from './domain/mirror-media-cache.store';
import { LinkMirrorFetcher } from './infrastructure/link-mirror-fetcher';
import { MetaMirrorDownloader } from './infrastructure/meta-mirror-downloader';
import { PostgresMirrorMediaCacheStore } from './infrastructure/postgres-mirror-media-cache.store';

const pool = () => ({
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
});

describe('ConversationMirrorModule wiring (T3)', () => {
  it('ChatbotApiModule provides the mirror client port as the HTTP client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ChatbotApiModule,
      ],
    }).compile();
    expect(moduleRef.get(CONVERSATION_MIRROR_CLIENT)).toBe(
      moduleRef.get(ChatbotApiHttpClient),
    );
    await moduleRef.close();
  });

  it('provides MirrorMediaService over the Postgres cache, the Meta downloader and the link fetcher', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ConversationMirrorModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    expect(moduleRef.get(MirrorMediaService)).toBeInstanceOf(
      MirrorMediaService,
    );
    expect(moduleRef.get(MIRROR_MEDIA_CACHE_STORE)).toBeInstanceOf(
      PostgresMirrorMediaCacheStore,
    );
    expect(moduleRef.get(MIRROR_META_DOWNLOADER)).toBeInstanceOf(
      MetaMirrorDownloader,
    );
    expect(moduleRef.get(MIRROR_LINK_FETCHER)).toBeInstanceOf(
      LinkMirrorFetcher,
    );
    await moduleRef.close();
  });

  it('exports the service so a consumer module can inject it', async () => {
    const { Module, Injectable } = await import('@nestjs/common');
    @Injectable()
    class Consumer {
      constructor(readonly media: MirrorMediaService) {}
    }
    @Module({
      imports: [ConversationMirrorModule],
      providers: [Consumer],
    })
    class ConsumerModule {}
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ConsumerModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    expect(moduleRef.get(Consumer).media).toBeInstanceOf(MirrorMediaService);
    await moduleRef.close();
  });
});
