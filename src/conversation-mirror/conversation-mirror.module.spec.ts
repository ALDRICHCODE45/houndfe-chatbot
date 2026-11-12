import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { CONVERSATION_MIRROR_CLIENT } from '../chatbot-api/domain/conversation-mirror.port';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { RoutingBackendOutboxDelivery } from '../backend-outbox/infrastructure/routing-backend-outbox.delivery';
import { MirrorDeliveryGate } from './application/mirror-delivery-gate';
import { MirrorMediaService } from './application/mirror-media.service';
import { MirrorMessagesDelivery } from './application/mirror-messages.delivery';
import { MirrorStatusesDelivery } from './application/mirror-statuses.delivery';
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

  it('registers the MESSAGE_MIRROR and MESSAGE_STATUS batch adapters on the outbox router at init when delivery is enabled (T4/T5)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          load: [() => ({ conversationMirror: { deliveryEnabled: true } })],
        }),
        ConversationMirrorModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    await moduleRef.init();
    const router = moduleRef.get(RoutingBackendOutboxDelivery);
    expect(router.batchLimit('MESSAGE_MIRROR')).toBe(50);
    expect(router.batchLimit('MESSAGE_STATUS')).toBe(100);
    // Everything else is untouched: single rows, not-wired fallback.
    expect(router.batchLimit('REQUEST_CREATE')).toBe(1);
    expect(router.batchLimit('SESSION_ACK')).toBe(1);
    await expect(
      router.deliver({
        id: '1',
        conversationRef: 'wa:5215550001111',
        seq: 1,
        kind: 'SESSION_ACK',
        idempotencyKey: 'k',
        payload: {},
        status: 'IN_FLIGHT',
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseOwner: 'o',
        leaseExpiresAt: new Date(),
        lastError: null,
        createdAt: new Date(),
        doneAt: null,
      }),
    ).resolves.toMatchObject({
      outcome: 'RETRY',
      error: 'backend outbox delivery not wired for kind SESSION_ACK',
    });
    await moduleRef.close();
  });

  it('both adapters share one credential gate and the outbox enqueue service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        ConversationMirrorModule,
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool())
      .compile();
    expect(moduleRef.get(MirrorDeliveryGate)).toBeInstanceOf(
      MirrorDeliveryGate,
    );
    expect(moduleRef.get(MirrorMessagesDelivery)).toBeInstanceOf(
      MirrorMessagesDelivery,
    );
    expect(moduleRef.get(MirrorStatusesDelivery)).toBeInstanceOf(
      MirrorStatusesDelivery,
    );
    await moduleRef.close();
  });

  describe('CONVERSATION_MIRROR_DELIVERY_ENABLED flag', () => {
    const row = (kind: string) => ({
      id: '1',
      conversationRef: 'wa:5215550001111',
      seq: 1,
      kind: kind as never,
      idempotencyKey: 'k',
      payload: {},
      status: 'IN_FLIGHT' as const,
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseOwner: 'o',
      leaseExpiresAt: new Date(),
      lastError: null,
      createdAt: new Date(),
      doneAt: null,
    });
    const boot = async (load: Array<() => Record<string, unknown>>) => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load }),
          ConversationMirrorModule,
        ],
      })
        .overrideProvider(PG_POOL)
        .useValue(pool())
        .compile();
      await moduleRef.init();
      return moduleRef;
    };

    it.each([
      ['false', [() => ({ conversationMirror: { deliveryEnabled: false } })]],
      ['unset (default off)', []],
    ])(
      'flag %s: adapters are not registered; mirror/status rows fall back to not-wired and logs once at info',
      async (_label, load) => {
        const info = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);
        const moduleRef = await boot(load);
        const router = moduleRef.get(RoutingBackendOutboxDelivery);
        expect(router.batchLimit('MESSAGE_MIRROR')).toBe(1);
        expect(router.batchLimit('MESSAGE_STATUS')).toBe(1);
        await expect(
          router.deliver(row('MESSAGE_MIRROR')),
        ).resolves.toMatchObject({
          outcome: 'RETRY',
          error: 'backend outbox delivery not wired for kind MESSAGE_MIRROR',
        });
        await expect(
          router.deliver(row('MESSAGE_STATUS')),
        ).resolves.toMatchObject({
          outcome: 'RETRY',
          error: 'backend outbox delivery not wired for kind MESSAGE_STATUS',
        });
        const disabledLogs = info.mock.calls.filter(([m]) =>
          String(m).includes('conversation mirror delivery disabled'),
        );
        expect(disabledLogs).toEqual([
          [
            'conversation mirror delivery disabled (CONVERSATION_MIRROR_DELIVERY_ENABLED=false): mirror rows are kept until enabled',
          ],
        ]);
        await moduleRef.close();
        info.mockRestore();
      },
    );

    it('flag true: registers the adapters and does not log the disabled notice', async () => {
      const info = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const moduleRef = await boot([
        () => ({ conversationMirror: { deliveryEnabled: true } }),
      ]);
      const router = moduleRef.get(RoutingBackendOutboxDelivery);
      expect(router.batchLimit('MESSAGE_MIRROR')).toBe(50);
      expect(router.batchLimit('MESSAGE_STATUS')).toBe(100);
      expect(
        info.mock.calls.some(([m]) =>
          String(m).includes('conversation mirror delivery disabled'),
        ),
      ).toBe(false);
      await moduleRef.close();
      info.mockRestore();
    });
  });
});
