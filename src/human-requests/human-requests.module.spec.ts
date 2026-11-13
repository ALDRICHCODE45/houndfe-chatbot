import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CHATBOT_API_CLIENT,
  HUMAN_REQUESTS_CLIENT,
} from '../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { PG_POOL } from '../database/postgres-pool.provider';
import { WHATSAPP_SENDER } from '../whatsapp/domain/whatsapp-sender.port';
import type { BackendOutboxEntry } from '../backend-outbox/domain/backend-outbox';
import { RoutingBackendOutboxDelivery } from '../backend-outbox/infrastructure/routing-backend-outbox.delivery';
import {
  LIVE_RECONCILE_REF,
  type LiveReconcileRef,
} from '../conversation/domain/live-reconcile-ref';
import { LiveConversationReconcileWorker } from './application/live-conversation-reconcile.worker';
import { HumanRequestCreateService } from './application/human-request-create.service';
import { HumanRequestDeliveryService } from './application/human-request-delivery.service';
import { LiveConversationService } from './application/live-conversation.service';
import { HUMAN_REQUEST_FEED_STORE } from './domain/human-request-feed';
import {
  HumanRequestFeedLifecycle,
  HumanRequestsModule,
  HumanRequestsServicesModule,
} from './human-requests.module';
import { PostgresHumanRequestFeedStore } from './infrastructure/postgres-human-request-feed.store';

const fakePool = () => {
  const client = {
    query: jest.fn(() => Promise.resolve({ rows: [{ locked: false }] })),
    on: jest.fn(),
    off: jest.fn(),
    removeAllListeners: jest.fn(),
    release: jest.fn(),
  };
  return {
    client,
    pool: {
      end: jest.fn(() => Promise.resolve()),
      query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
      connect: jest.fn(() => Promise.resolve(client)),
    },
  };
};

const createHumanRequest = jest.fn(() =>
  Promise.resolve({ kind: 'NOT_FOUND' as const }),
);

const compile = (
  pool: ReturnType<typeof fakePool>['pool'],
  feature: typeof HumanRequestsModule = HumanRequestsModule,
) =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ meta: { phoneNumberId: 'phone-1' } })],
      }),
      feature,
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(CONVERSATION_STORE)
    .useValue({ get: jest.fn(), getHandoff: jest.fn() })
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue({})
    .overrideProvider(HUMAN_REQUESTS_CLIENT)
    .useValue({
      readFeed: jest.fn(() => new Promise(() => undefined)),
      recordDeliveryOutcome: jest.fn(),
      listPendingDeliveries: jest.fn(),
      createHumanRequest,
      cancelHumanRequest: jest.fn(),
    })
    .overrideProvider(WHATSAPP_SENDER)
    .useValue({ sendText: jest.fn() })
    .compile();

describe('HumanRequestsModule', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('wires the Postgres store and exports the delivery service', async () => {
    const { pool } = fakePool();
    const moduleRef = await compile(pool);
    expect(moduleRef.get(HUMAN_REQUEST_FEED_STORE)).toBeInstanceOf(
      PostgresHumanRequestFeedStore,
    );
    expect(moduleRef.get(HumanRequestDeliveryService)).toBeInstanceOf(
      HumanRequestDeliveryService,
    );
    expect(moduleRef.get(HumanRequestCreateService)).toBeInstanceOf(
      HumanRequestCreateService,
    );
    expect(moduleRef.get(HumanRequestFeedLifecycle)).toBeDefined();
    await moduleRef.close();
  });

  it('wires the live conversation handler into the delivery service (T4)', async () => {
    const { pool } = fakePool();
    const moduleRef = await compile(pool, HumanRequestsServicesModule);
    const delivery = moduleRef.get(HumanRequestDeliveryService);
    const ports = (delivery as unknown as { ports: { live: unknown } }).ports;
    expect(ports.live).toBeInstanceOf(LiveConversationService);
    await moduleRef.close();
  });

  it('gives the live conversation handler the WhatsApp sender for staff relays (T5)', async () => {
    const { pool } = fakePool();
    const moduleRef = await compile(pool, HumanRequestsServicesModule);
    const delivery = moduleRef.get(HumanRequestDeliveryService);
    const live = (
      delivery as unknown as {
        ports: { live: { ports: { sender: unknown } } };
      }
    ).ports.live;
    expect(live.ports.sender).toBe(moduleRef.get(WHATSAPP_SENDER));
    await moduleRef.close();
  });

  it('the services-only module never runs the feed consumer', async () => {
    const { pool } = fakePool();
    const moduleRef = await compile(pool, HumanRequestsServicesModule);
    expect(moduleRef.get(HumanRequestCreateService)).toBeInstanceOf(
      HumanRequestCreateService,
    );
    expect(moduleRef.get(HumanRequestDeliveryService)).toBeInstanceOf(
      HumanRequestDeliveryService,
    );
    expect(() => moduleRef.get(HumanRequestFeedLifecycle)).toThrow();
    await moduleRef.init();
    await new Promise((resolve) => setImmediate(resolve));
    expect(pool.connect).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('registers REQUEST_CREATE / REQUEST_CANCEL on the outbox router at init', async () => {
    const { pool } = fakePool();
    const moduleRef = await compile(pool);
    await moduleRef.init();
    const router = moduleRef.get(RoutingBackendOutboxDelivery);
    const entry = (kind: BackendOutboxEntry['kind']): BackendOutboxEntry => ({
      id: '1',
      conversationRef: 'wa:5215550001111',
      seq: 9,
      kind,
      idempotencyKey: 'k',
      payload: { subtype: 'NOPE' },
      status: 'IN_FLIGHT',
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseOwner: 'o',
      leaseExpiresAt: new Date(),
      lastError: null,
      createdAt: new Date(),
      doneAt: null,
    });
    // Routed to the create adapter: a malformed envelope is PERMANENT.
    await expect(router.deliver(entry('REQUEST_CREATE'))).resolves.toEqual({
      outcome: 'PERMANENT',
      error: 'invalid payload',
    });
    await expect(router.deliver(entry('REQUEST_CANCEL'))).resolves.toEqual({
      outcome: 'PERMANENT',
      error: 'invalid payload',
    });
    // Other kinds keep the not-wired retry.
    await expect(
      router.deliver(entry('MESSAGE_MIRROR')),
    ).resolves.toMatchObject({ outcome: 'RETRY' });
    await moduleRef.close();
  });

  it('starts the consumer on bootstrap and stops it before the pool closes', async () => {
    const { pool } = fakePool();
    const moduleRef = await compile(pool);
    await moduleRef.init();
    // The consumer tried the advisory lock on a dedicated connection.
    for (let i = 0; i < 20 && pool.connect.mock.calls.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(pool.connect).toHaveBeenCalled();
    await moduleRef.close();
    expect(pool.end).toHaveBeenCalled();
  });

  describe('live conversation reconcile wiring (T6/T7)', () => {
    const liveOf = (moduleRef: Awaited<ReturnType<typeof compile>>) => {
      const delivery: unknown = moduleRef.get(HumanRequestDeliveryService);
      return (
        delivery as {
          ports: { live: { ports: { onAckRefused: (ref: string) => void } } };
        }
      ).ports.live;
    };
    const holderOf = (moduleRef: Awaited<ReturnType<typeof compile>>) =>
      moduleRef.get<LiveReconcileRef>(LIVE_RECONCILE_REF, { strict: false });

    it('binds the reconcile worker into the shared holder on bootstrap and releases it on shutdown', async () => {
      const start = jest.spyOn(
        LiveConversationReconcileWorker.prototype,
        'start',
      );
      const stop = jest.spyOn(
        LiveConversationReconcileWorker.prototype,
        'stop',
      );
      const { pool } = fakePool();
      const moduleRef = await compile(pool);
      expect(holderOf(moduleRef).current).toBeUndefined();
      await moduleRef.init();
      const holder = holderOf(moduleRef);
      expect(holder.current).toBeInstanceOf(LiveConversationReconcileWorker);
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      await moduleRef.close();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(holder.current).toBeUndefined();
    });

    it('runs whatever CONVERSATION_MIRROR_DELIVERY_ENABLED says (unit 11, not unit 9)', async () => {
      const { pool } = fakePool();
      const moduleRef = await compile(pool);
      await moduleRef.init();
      expect(holderOf(moduleRef).current).toBeInstanceOf(
        LiveConversationReconcileWorker,
      );
      await moduleRef.close();
    });

    it('a refused session-ack asks the bound worker to reconcile that conversation', async () => {
      const { pool } = fakePool();
      const moduleRef = await compile(pool);
      await moduleRef.init();
      const worker = holderOf(moduleRef)
        .current as LiveConversationReconcileWorker;
      const reconcileOne = jest
        .spyOn(worker, 'reconcileOne')
        .mockResolvedValue({ kind: 'in_sync' });
      const live = liveOf(moduleRef);
      live.ports.onAckRefused('wa:5215550001111');
      expect(reconcileOne).toHaveBeenCalledWith('wa:5215550001111');
      await moduleRef.close();
      // After shutdown the signal is a no-op, never an error.
      expect(() => live.ports.onAckRefused('wa:5215550001111')).not.toThrow();
      expect(reconcileOne).toHaveBeenCalledTimes(1);
    });

    it('the services-only module never builds the worker', async () => {
      const { pool } = fakePool();
      const moduleRef = await compile(pool, HumanRequestsServicesModule);
      await moduleRef.init();
      expect(holderOf(moduleRef).current).toBeUndefined();
      await moduleRef.close();
    });

    it('a signal before the worker exists is a no-op', async () => {
      const { pool } = fakePool();
      const moduleRef = await compile(pool, HumanRequestsServicesModule);
      const live = liveOf(moduleRef);
      expect(() => live.ports.onAckRefused('wa:5215550001111')).not.toThrow();
      await moduleRef.close();
    });
  });
});
