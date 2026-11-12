import { Logger } from '@nestjs/common';
import type {
  BackendOutboxBatchDeliveryPort,
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

  it('a delivery that outlives the timeout is retryable', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    const hanging: BackendOutboxDeliveryPort = {
      deliver: () => new Promise<BackendOutboxDeliveryResult>(() => {}),
    };
    const drain = new BackendOutboxDrainWorker(store, hanging, {
      owner: 'o',
      deliveryTimeoutMs: 20,
      random: () => 1,
    });
    await drain.tick();
    expect(store.snapshot()[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'backend outbox delivery timed out after 20 ms',
    });
  });

  it('the delivery timeout defaults below the lease and must stay below it', () => {
    const store = new InMemoryBackendOutboxStore();
    const delivery = new ScriptedDelivery(() => ({ outcome: 'DELIVERED' }));
    expect(
      new BackendOutboxDrainWorker(store, delivery, { owner: 'o' })
        .deliveryTimeoutMs,
    ).toBe(45_000);
    expect(
      new BackendOutboxDrainWorker(store, delivery, {
        owner: 'o',
        leaseMs: 20_000,
      }).deliveryTimeoutMs,
    ).toBe(15_000);
    expect(
      () =>
        new BackendOutboxDrainWorker(store, delivery, {
          owner: 'o',
          leaseMs: 1_000,
          deliveryTimeoutMs: 1_000,
        }),
    ).toThrow(RangeError);
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
    const dead = (Logger.prototype.error as jest.Mock).mock.calls
      .map(([line]) => String(line))
      .join('\n');
    expect(dead).not.toContain('5215550001111');
    expect(dead).toContain('wa:…1111#');
    await drain.tick();
    expect(store.snapshot().map((e) => [e.idempotencyKey, e.status])).toEqual([
      ['a1', 'DEAD'],
      ['a2', 'DONE'],
    ]);
    expect(store.snapshot()[0].lastError).toBe('422 VALIDATION_ERROR');
  });

  it('a lost lease is logged with the masked conversation only', async () => {
    const store = new InMemoryBackendOutboxStore();
    await enqueue(store, A, 'a1');
    jest.spyOn(store, 'markDone').mockResolvedValue(false);
    const drain = worker(
      store,
      new ScriptedDelivery(() => ({ outcome: 'DELIVERED' })),
    );
    await drain.tick();
    const lost = (Logger.prototype.warn as jest.Mock).mock.calls
      .map(([line]) => String(line))
      .join('\n');
    expect(lost).toContain('lease lost');
    expect(lost).not.toContain('5215550001111');
    expect(lost).toContain('wa:…1111#');
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

class ScriptedBatchDelivery implements BackendOutboxBatchDeliveryPort {
  readonly calls: BackendOutboxEntry[][] = [];
  readonly singles: string[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  constructor(
    private readonly limits: Partial<Record<string, number>>,
    private readonly script: (
      entries: readonly BackendOutboxEntry[],
    ) => BackendOutboxDeliveryResult[] | Error = (entries) =>
      entries.map(() => ({ outcome: 'DELIVERED' as const })),
  ) {}
  batchLimit(kind: string): number {
    return this.limits[kind] ?? 1;
  }
  deliver(entry: BackendOutboxEntry): Promise<BackendOutboxDeliveryResult> {
    this.singles.push(entry.idempotencyKey);
    return Promise.resolve({ outcome: 'DELIVERED' });
  }
  deliverBatch(
    entries: readonly BackendOutboxEntry[],
    options?: { signal?: AbortSignal },
  ): Promise<BackendOutboxDeliveryResult[]> {
    this.calls.push([...entries]);
    this.signals.push(options?.signal);
    const out = this.script(entries);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  }
}

describe('BackendOutboxDrainWorker batches (unit 9)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const fill = async (
    store: InMemoryBackendOutboxStore,
    count: number,
    conversation = A,
  ) => {
    for (let n = 1; n <= count; n++)
      await enqueue(store, conversation, `${conversation}-${n}`);
  };

  it('delivers 120 mirror rows of one conversation in 3 calls (50 + 50 + 20)', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 120);
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 });
    const drain = worker(store, delivery);
    await drain.tick();
    await drain.tick();
    await drain.tick();
    await expect(drain.tick()).resolves.toBe(0);
    expect(delivery.calls.map((call) => call.length)).toEqual([50, 50, 20]);
    expect(delivery.singles).toEqual([]);
    // Seq order is kept inside and across batches.
    expect(delivery.calls.flat().map((e) => e.seq)).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
    expect(store.snapshot().every((e) => e.status === 'DONE')).toBe(true);
  });

  it('applies DELIVERED / PERMANENT / RETRY per row of a batch', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 4);
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 }, () => [
      { outcome: 'DELIVERED' },
      { outcome: 'PERMANENT', error: '422 MEDIA_TYPE_MISMATCH' },
      { outcome: 'RETRY', error: '503', retryAfterMs: 90_000 },
      { outcome: 'DELIVERED' },
    ]);
    const drain = worker(store, delivery);
    const before = Date.now();
    await drain.tick();
    const rows = store.snapshot();
    expect(rows.map((r) => r.status)).toEqual([
      'DONE',
      'DEAD',
      'PENDING',
      'DONE',
    ]);
    expect(rows[1].lastError).toBe('422 MEDIA_TYPE_MISMATCH');
    expect(rows[2].nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(
      89_000,
    );
    expect(rows[2].lastError).toBe('503');
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('wa:…1111#2'),
    );
    expect(Logger.prototype.error).not.toHaveBeenCalledWith(
      expect.stringContaining('5215550001111'),
    );
  });

  it('a thrown batch call retries every row with backoff', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 3);
    const delivery = new ScriptedBatchDelivery(
      { MESSAGE_MIRROR: 50 },
      () => new Error('socket hang up'),
    );
    await worker(store, delivery).tick();
    const rows = store.snapshot();
    expect(rows.map((r) => r.status)).toEqual([
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(rows[0].lastError).toMatch(/socket hang up/);
  });

  it('a result array of the wrong length retries every row (never trusts it)', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 3);
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 }, () => [
      { outcome: 'DELIVERED' },
    ]);
    await worker(store, delivery).tick();
    expect(store.snapshot().map((r) => r.status)).toEqual([
      'PENDING',
      'PENDING',
      'PENDING',
    ]);
  });

  it('a batch call that hangs is aborted and retried (signal fires before the hard timeout)', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 2);
    let seen: AbortSignal | undefined;
    const delivery: BackendOutboxBatchDeliveryPort = {
      batchLimit: () => 50,
      deliver: () => Promise.reject(new Error('unused')),
      deliverBatch: (_entries, options) => {
        seen = options?.signal;
        return new Promise(() => undefined);
      },
    };
    const drain = new BackendOutboxDrainWorker(store, delivery, {
      owner: 'backend-outbox:test',
      leaseMs: 400,
      deliveryTimeoutMs: 100,
      random: () => 1,
    });
    await drain.tick();
    expect(seen?.aborted).toBe(true);
    expect(store.snapshot().map((r) => r.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(store.snapshot()[0].lastError).toMatch(/timed out/);
  });

  it('kinds without a batch limit keep the single-row path', async () => {
    const store = new InMemoryBackendOutboxStore();
    await store.enqueue({
      conversationRef: A,
      kind: 'REQUEST_CREATE',
      idempotencyKey: 'c1',
      payload: {},
    });
    await store.enqueue({
      conversationRef: A,
      kind: 'REQUEST_CREATE',
      idempotencyKey: 'c2',
      payload: {},
    });
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 });
    const drain = worker(store, delivery);
    await drain.tick();
    await drain.tick();
    expect(delivery.calls).toEqual([]);
    expect(delivery.singles).toEqual(['c1', 'c2']);
  });

  it('a plain delivery port (no deliverBatch) stays on the single-row path', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 3);
    const delivery = new ScriptedDelivery(() => ({ outcome: 'DELIVERED' }));
    const drain = worker(store, delivery);
    await drain.tick();
    expect(delivery.delivered).toEqual([`${A}-1`]);
  });

  it('different conversations batch independently in one tick', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 3, A);
    await fill(store, 2, B);
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 });
    await expect(worker(store, delivery).tick()).resolves.toBe(2);
    expect(
      delivery.calls
        .map((call) => [call[0].conversationRef, call.length])
        .sort(),
    ).toEqual([
      [A, 3],
      [B, 2],
    ]);
  });

  it('a lost lease on one row of a batch is logged and does not undo the others', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 2);
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 });
    const original = store.completeMany.bind(store);
    jest.spyOn(store, 'completeMany').mockImplementation(async (items) => {
      const results = await original(items);
      return results.map((ok, index) => (index === 0 ? false : ok));
    });
    await worker(store, delivery).tick();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('lease lost'),
    );
  });

  it('a failing run claim falls back to delivering the head alone (no stuck lease)', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 3);
    jest.spyOn(store, 'claimRun').mockRejectedValue(new Error('db down'));
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 50 });
    await worker(store, delivery).tick();
    expect(delivery.calls).toEqual([]);
    expect(delivery.singles).toEqual([`${A}-1`]);
    expect(store.snapshot().map((r) => r.status)).toEqual([
      'DONE',
      'PENDING',
      'PENDING',
    ]);
  });

  it('a full batch makes the loop go again immediately', async () => {
    const store = new InMemoryBackendOutboxStore();
    await fill(store, 4);
    const delivery = new ScriptedBatchDelivery({ MESSAGE_MIRROR: 2 });
    const drain = new BackendOutboxDrainWorker(store, delivery, {
      owner: 'backend-outbox:test',
      idleDelayMs: 60_000,
      random: () => 1,
    });
    drain.start();
    for (let i = 0; i < 200 && delivery.calls.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await drain.stop();
    // Two full batches ran back to back although the idle delay is 60 s.
    expect(delivery.calls.map((c) => c.length)).toEqual([2, 2]);
  });
});
