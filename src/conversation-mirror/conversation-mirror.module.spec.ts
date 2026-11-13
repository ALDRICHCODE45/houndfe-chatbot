import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CHATBOT_API_CLIENT,
  HUMAN_REQUESTS_CLIENT,
} from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { LiveConversationReconcileWorker } from '../human-requests/application/live-conversation-reconcile.worker';
import { HumanRequestsModule } from '../human-requests/human-requests.module';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import { CONVERSATION_MIRROR_CLIENT } from '../chatbot-api/domain/conversation-mirror.port';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { RoutingBackendOutboxDelivery } from '../backend-outbox/infrastructure/routing-backend-outbox.delivery';
import {
  LIVE_RECONCILE_REF,
  type LiveReconcileRef,
} from '../conversation/domain/live-reconcile-ref';
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

  interface HintDeps {
    deps: {
      onHandoffHint?: (
        ref: string,
        hint: { mode: 'BOT' | 'HUMAN'; handoffEpoch: number },
      ) => void;
    };
  }

  describe('messages:batch handoff hint wiring (live conversation T7)', () => {
    const boot = async (enabled: boolean) => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            load: [
              () => ({ conversationMirror: { deliveryEnabled: enabled } }),
            ],
          }),
          ConversationMirrorModule,
        ],
      })
        .overrideProvider(PG_POOL)
        .useValue(pool())
        .compile();
      const delivery: unknown = moduleRef.get(MirrorMessagesDelivery);
      const hook = (delivery as HintDeps).deps.onHandoffHint;
      return {
        moduleRef,
        hook,
        holder: moduleRef.get<LiveReconcileRef>(LIVE_RECONCILE_REF, {
          strict: false,
        }),
      };
    };

    it('delivery on: the hint reaches the worker bound later in the shared holder', async () => {
      const { moduleRef, hook, holder } = await boot(true);
      expect(hook).toBeDefined();
      const worker = { hint: jest.fn(), reconcileOne: jest.fn() };
      // Before the worker exists (and after it stops) a hint is a no-op.
      expect(() =>
        hook?.('wa:1', { mode: 'HUMAN', handoffEpoch: 2 }),
      ).not.toThrow();
      holder.current = worker;
      hook?.('wa:5215550001111', { mode: 'HUMAN', handoffEpoch: 4 });
      expect(worker.hint).toHaveBeenCalledWith('wa:5215550001111', {
        mode: 'HUMAN',
        handoffEpoch: 4,
      });
      holder.current = undefined;
      hook?.('wa:5215550001111', { mode: 'BOT', handoffEpoch: 5 });
      expect(worker.hint).toHaveBeenCalledTimes(1);
      await moduleRef.close();
    });

    it('delivery off: the hint hook does not exist (rows are not mirrored, so nothing to hint)', async () => {
      const { moduleRef, hook } = await boot(false);
      expect(hook).toBeUndefined();
      await moduleRef.close();
    });

    // L13 d: the singleton is only proven when BOTH modules boot together:
    // the mirror delivery's hook must reach the worker the human-requests
    // lifecycle binds on bootstrap.
    it('booted with HumanRequestsModule: a messages:batch hint reaches the worker bound on bootstrap (one LIVE_RECONCILE_REF)', async () => {
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const client = {
        query: jest.fn(() => Promise.resolve({ rows: [{ locked: false }] })),
        on: jest.fn(),
        off: jest.fn(),
        removeAllListeners: jest.fn(),
        release: jest.fn(),
      };
      const livePool = {
        end: jest.fn(() => Promise.resolve()),
        query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
        connect: jest.fn(() => Promise.resolve(client)),
      };
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            load: [
              () => ({
                conversationMirror: { deliveryEnabled: true },
                meta: { phoneNumberId: 'phone-1' },
              }),
            ],
          }),
          ConversationMirrorModule,
          HumanRequestsModule,
        ],
      })
        .overrideProvider(PG_POOL)
        .useValue(livePool)
        .overrideProvider(CONVERSATION_STORE)
        .useValue({ get: jest.fn(), getHandoff: jest.fn() })
        .overrideProvider(CHATBOT_API_CLIENT)
        .useValue({})
        .overrideProvider(HUMAN_REQUESTS_CLIENT)
        .useValue({
          readFeed: jest.fn(() => new Promise(() => undefined)),
          recordDeliveryOutcome: jest.fn(),
          listPendingDeliveries: jest.fn(),
          createHumanRequest: jest.fn(),
          cancelHumanRequest: jest.fn(),
        })
        .overrideProvider(WHATSAPP_SENDER)
        .useValue({ sendText: jest.fn() })
        .compile();
      await moduleRef.init();
      const holder = moduleRef.get<LiveReconcileRef>(LIVE_RECONCILE_REF, {
        strict: false,
      });
      const worker = holder.current;
      expect(worker).toBeInstanceOf(LiveConversationReconcileWorker);
      const hint = jest
        .spyOn(worker as LiveConversationReconcileWorker, 'hint')
        .mockImplementation(() => undefined);
      const delivery: unknown = moduleRef.get(MirrorMessagesDelivery);
      (delivery as HintDeps).deps.onHandoffHint?.('wa:5215550001111', {
        mode: 'HUMAN',
        handoffEpoch: 6,
      });
      expect(hint).toHaveBeenCalledWith('wa:5215550001111', {
        mode: 'HUMAN',
        handoffEpoch: 6,
      });
      await moduleRef.close();
      // Released on shutdown: the same hook is a no-op afterwards.
      (delivery as HintDeps).deps.onHandoffHint?.('wa:5215550001111', {
        mode: 'BOT',
        handoffEpoch: 7,
      });
      expect(hint).toHaveBeenCalledTimes(1);
      log.mockRestore();
      warn.mockRestore();
    });

    it('the holder is the single instance of ConversationModule (no cycle with human-requests)', async () => {
      const { moduleRef, holder } = await boot(true);
      expect(holder).toEqual({});
      await moduleRef.close();
    });
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
