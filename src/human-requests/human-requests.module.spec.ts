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
import { HumanRequestDeliveryService } from './application/human-request-delivery.service';
import { HUMAN_REQUEST_FEED_STORE } from './domain/human-request-feed';
import {
  HumanRequestFeedLifecycle,
  HumanRequestsModule,
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

const compile = (pool: ReturnType<typeof fakePool>['pool']) =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ meta: { phoneNumberId: 'phone-1' } })],
      }),
      HumanRequestsModule,
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
    expect(moduleRef.get(HumanRequestFeedLifecycle)).toBeDefined();
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
