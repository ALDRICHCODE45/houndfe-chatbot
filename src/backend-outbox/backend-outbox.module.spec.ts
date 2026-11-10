import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PG_POOL } from '../database/postgres-pool.provider';
import { BackendOutboxService } from './application/backend-outbox.service';
import {
  BackendOutboxDrainLifecycle,
  BackendOutboxModule,
} from './backend-outbox.module';
import {
  BACKEND_OUTBOX_DELIVERY,
  BACKEND_OUTBOX_STORE,
} from './domain/backend-outbox';
import { InMemoryBackendOutboxStore } from './infrastructure/in-memory-backend-outbox.store';
import { NotWiredBackendOutboxDelivery } from './infrastructure/not-wired-backend-outbox.delivery';
import { PostgresBackendOutboxStore } from './infrastructure/postgres-backend-outbox.store';

const fakePool = () => ({
  end: jest.fn(() => Promise.resolve()),
  query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
});

describe('BackendOutboxModule', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('wires the Postgres store and the not-wired delivery by default', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BackendOutboxModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool())
      .compile();
    expect(moduleRef.get(BACKEND_OUTBOX_STORE)).toBeInstanceOf(
      PostgresBackendOutboxStore,
    );
    expect(moduleRef.get(BACKEND_OUTBOX_DELIVERY)).toBeInstanceOf(
      NotWiredBackendOutboxDelivery,
    );
    expect(moduleRef.get(BackendOutboxService)).toBeInstanceOf(
      BackendOutboxService,
    );
    await moduleRef.close();
  });

  it('starts the drain on bootstrap, retries unwired rows, and stops before the pool closes', async () => {
    const store = new InMemoryBackendOutboxStore();
    const pool = fakePool();
    const app = await Test.createTestingModule({
      imports: [BackendOutboxModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(BACKEND_OUTBOX_STORE)
      .useValue(store)
      .compile();
    const service = app.get(BackendOutboxService);
    await service.enqueue({
      conversationRef: 'wa:5215550001111',
      kind: 'MESSAGE_MIRROR',
      idempotencyKey: 'wamid.1',
      payload: { waMessageId: 'wamid.1' },
    });
    await app.init();
    for (let i = 0; i < 200 && store.snapshot()[0].attempts === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.snapshot()[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'backend outbox delivery not wired for kind MESSAGE_MIRROR',
    });
    const stop = jest.spyOn(
      BackendOutboxDrainLifecycle.prototype,
      'onModuleDestroy',
    );
    await app.close();
    expect(stop).toHaveBeenCalled();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      pool.end.mock.invocationCallOrder[0],
    );
  });
});
