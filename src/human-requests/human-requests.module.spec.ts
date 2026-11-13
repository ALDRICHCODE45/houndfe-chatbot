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
});
