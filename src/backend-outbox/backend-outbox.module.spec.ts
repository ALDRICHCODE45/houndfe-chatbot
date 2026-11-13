import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PG_POOL } from '../database/postgres-pool.provider';
import { BackendOutboxService } from './application/backend-outbox.service';
import {
  BackendOutboxDrainLifecycle,
  BackendOutboxEnqueueModule,
  BackendOutboxModule,
} from './backend-outbox.module';
import {
  BACKEND_OUTBOX_DELIVERY,
  BACKEND_OUTBOX_STORE,
  OUTBOX_DRAIN_WAKER,
  type OutboxDrainWaker,
} from './domain/backend-outbox';
import { InMemoryBackendOutboxStore } from './infrastructure/in-memory-backend-outbox.store';
import { RoutingBackendOutboxDelivery } from './infrastructure/routing-backend-outbox.delivery';
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

  it('wires the Postgres store and the per-kind delivery router', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BackendOutboxModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool())
      .compile();
    expect(moduleRef.get(BACKEND_OUTBOX_STORE)).toBeInstanceOf(
      PostgresBackendOutboxStore,
    );
    const router = moduleRef.get<unknown>(BACKEND_OUTBOX_DELIVERY);
    expect(router).toBeInstanceOf(RoutingBackendOutboxDelivery);
    // Feature modules register on the same router instance.
    expect(moduleRef.get(RoutingBackendOutboxDelivery)).toBe(router);
    expect(moduleRef.get(BackendOutboxService)).toBeInstanceOf(
      BackendOutboxService,
    );
    await moduleRef.close();
  });

  it('the enqueue-only module never runs a drain worker', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BackendOutboxEnqueueModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(fakePool())
      .compile();
    expect(moduleRef.get(BackendOutboxService)).toBeInstanceOf(
      BackendOutboxService,
    );
    expect(() => moduleRef.get(BackendOutboxDrainLifecycle)).toThrow();
    expect(() => moduleRef.get<unknown>(BACKEND_OUTBOX_DELIVERY)).toThrow();
    // The router is shared so feature modules can register their kinds.
    expect(moduleRef.get(RoutingBackendOutboxDelivery)).toBeInstanceOf(
      RoutingBackendOutboxDelivery,
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

  describe('OUTBOX_DRAIN_WAKER', () => {
    it('the enqueue-only module provides a safe no-op waker (no worker runs)', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BackendOutboxEnqueueModule],
      })
        .overrideProvider(PG_POOL)
        .useValue(fakePool())
        .compile();
      const waker = moduleRef.get<OutboxDrainWaker>(OUTBOX_DRAIN_WAKER);
      expect(() => waker.wake()).not.toThrow();
      await moduleRef.close();
    });

    it('the full module binds the running worker: a wake drains right away', async () => {
      const store = new InMemoryBackendOutboxStore();
      const app = await Test.createTestingModule({
        imports: [BackendOutboxModule],
      })
        .overrideProvider(PG_POOL)
        .useValue(fakePool())
        .overrideProvider(BACKEND_OUTBOX_STORE)
        .useValue(store)
        .compile();
      const router = app.get(RoutingBackendOutboxDelivery);
      const delivered: string[] = [];
      router.register(['MESSAGE_MIRROR'], {
        deliver: (entry) => {
          delivered.push(entry.idempotencyKey);
          return Promise.resolve({ outcome: 'DELIVERED' as const });
        },
      });
      const claim = jest.spyOn(store, 'claimHeads');
      await app.init();
      for (let i = 0; i < 200 && claim.mock.calls.length < 1; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.get(BackendOutboxService).enqueue({
        conversationRef: 'wa:5215550001111',
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'notice',
        payload: {},
      });
      // The idle delay is 1 s: only the wake can deliver this quickly.
      app.get<OutboxDrainWaker>(OUTBOX_DRAIN_WAKER).wake();
      for (let i = 0; i < 100 && delivered.length < 1; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(delivered).toEqual(['notice']);
      await app.close();
      // After shutdown a wake is a harmless no-op.
      expect(() =>
        app.get<OutboxDrainWaker>(OUTBOX_DRAIN_WAKER).wake(),
      ).not.toThrow();
    });
  });
});
