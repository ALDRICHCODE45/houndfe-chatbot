import { Logger } from '@nestjs/common';
import type {
  BackendOutboxDeliveryPort,
  BackendOutboxDeliveryResult,
  BackendOutboxEntry,
} from '../domain/backend-outbox';
import { InMemoryBackendOutboxStore } from '../infrastructure/in-memory-backend-outbox.store';
import { BackendOutboxDrainWorker } from './backend-outbox-drain.worker';

const A = 'wa:5215550001111';
const B = 'wa:5215550002222';

class ScriptedDelivery implements BackendOutboxDeliveryPort {
  readonly delivered: string[] = [];
  constructor(
    private readonly script: (
      entry: BackendOutboxEntry,
    ) => BackendOutboxDeliveryResult | Error,
  ) {}
  deliver(entry: BackendOutboxEntry): Promise<BackendOutboxDeliveryResult> {
    this.delivered.push(entry.idempotencyKey);
    const out = this.script(entry);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

const enqueue = (
  store: InMemoryBackendOutboxStore,
  conversationRef: string,
  key: string,
) =>
  store.enqueue({
    conversationRef,
    kind: 'MESSAGE_MIRROR',
    idempotencyKey: key,
    payload: { key },
  });

const worker = (
  store: InMemoryBackendOutboxStore,
  delivery: BackendOutboxDeliveryPort,
) =>
  new BackendOutboxDrainWorker(store, delivery, {
    owner: 'backend-outbox:test',
    random: () => 1,
  });

describe('BackendOutboxDrainWorker', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('delivers heads and marks them DONE, then the next seq', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    await enqueue(store, A, 'a2');
    await enqueue(store, B, 'b1');
    const delivery = new ScriptedDelivery(() => ({ outcome: 'DELIVERED' }));
    const drain = worker(store, delivery);
    await expect(drain.tick()).resolves.toBe(2);
    expect(delivery.delivered.sort()).toEqual(['a1', 'b1']);
    await expect(drain.tick()).resolves.toBe(1);
    expect(delivery.delivered).toContain('a2');
    await expect(drain.tick()).resolves.toBe(0);
    expect(store.snapshot().map((e) => e.status)).toEqual([
      'DONE',
      'DONE',
      'DONE',
    ]);
  });

  it('a retryable failure reschedules with backoff and blocks only its conversation', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    await enqueue(store, A, 'a2');
    await enqueue(store, B, 'b1');
    await enqueue(store, B, 'b2');
    const delivery = new ScriptedDelivery((entry) =>
      entry.conversationRef === A
        ? { outcome: 'RETRY', error: '503' }
        : { outcome: 'DELIVERED' },
    );
    const drain = worker(store, delivery);
    const before = Date.now();
    await drain.tick();
    await drain.tick();
    expect(delivery.delivered.sort()).toEqual(['a1', 'b1', 'b2']);
    const a1 = store.snapshot().find((e) => e.idempotencyKey === 'a1')!;
    expect(a1).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: '503',
    });
    // random() = 1 → the full 1 s first step.
    expect(a1.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 1_000);
    expect(
      store.snapshot().find((e) => e.idempotencyKey === 'a2')!.status,
    ).toBe('PENDING');
  });

  it('a thrown error is retryable', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    const drain = worker(
      store,
      new ScriptedDelivery(() => new Error('ECONNRESET')),
    );
    await drain.tick();
    expect(store.snapshot()[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Error: ECONNRESET',
    });
  });

  it('honors Retry-After', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    const drain = worker(
      store,
      new ScriptedDelivery(() => ({
        outcome: 'RETRY',
        error: '429',
        retryAfterMs: 120_000,
      })),
    );
    const before = Date.now();
    await drain.tick();
    expect(store.snapshot()[0].nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 120_000,
    );
  });

  it('a permanent failure marks DEAD, logs an error and lets the next seq proceed', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    await enqueue(store, A, 'a2');
    const delivery = new ScriptedDelivery((entry) =>
      entry.idempotencyKey === 'a1'
        ? { outcome: 'PERMANENT', error: '422 VALIDATION_ERROR' }
        : { outcome: 'DELIVERED' },
    );
    const drain = worker(store, delivery);
    await drain.tick();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('DEAD'),
    );
    await drain.tick();
    expect(store.snapshot().map((e) => [e.idempotencyKey, e.status])).toEqual([
      ['a1', 'DEAD'],
      ['a2', 'DONE'],
    ]);
    expect(store.snapshot()[0].lastError).toBe('422 VALIDATION_ERROR');
  });

  it('a failing claim does not crash the tick', async () => {
    const store = new InMemoryBackendOutboxStore();
    jest.spyOn(store, 'claimHeads').mockRejectedValue(new Error('db down'));
    const drain = worker(
      store,
      new ScriptedDelivery(() => ({ outcome: 'DELIVERED' })),
    );
    await expect(drain.tick()).resolves.toBe(0);
  });

  it('purges old DONE rows on the purge interval', async () => {
    const store = new InMemoryBackendOutboxStore();
    const purge = jest.spyOn(store, 'purgeDone');
    const drain = new BackendOutboxDrainWorker(
      store,
      new ScriptedDelivery(() => ({ outcome: 'DELIVERED' })),
      { owner: 'o', purgeIntervalMs: 60_000, purgeBatchSize: 2 },
    );
    await drain.tick();
    await drain.tick();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith(7 * 24 * 3_600_000, 2);
  });

  it('start runs the loop until stop, and never restarts after stop', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    const delivery = new ScriptedDelivery(() => ({ outcome: 'DELIVERED' }));
    const drain = new BackendOutboxDrainWorker(store, delivery, {
      owner: 'o',
      idleDelayMs: 5,
    });
    drain.start();
    for (let i = 0; i < 100 && store.snapshot()[0].status !== 'DONE'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.snapshot()[0].status).toBe('DONE');
    await drain.stop();
    await enqueue(store, A, 'a2');
    drain.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.snapshot()[1].status).toBe('PENDING');
  });
});
