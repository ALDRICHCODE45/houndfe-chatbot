import type { RestockApplicationCoordinator } from './restock-application-coordinator';

interface Options {
  intervalMs?: number;
  maxPolls?: number;
  maxAgeMs?: number;
  maxTrackedKeys?: number;
}
interface Job {
  senderId: string;
  sourceRequestId: string;
  enqueuedAt: number;
  lastObservedAt: number;
  polls: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unwired, process-local watcher: only new receipt hints should enqueue.
 * Terminal keys consume capacity forever; admission may need a fresh process.
 * No durable dedup/recovery: shutdown drops waiting jobs. Bounds stop watching,
 * not backend requests; fresh send authority remains the coordinator's job. */
export class RestockApplicationPoller {
  private readonly options: Required<Options>;
  private readonly seen = new Set<string>();
  private readonly queue: Job[] = [];
  private started = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    private readonly coordinator: Pick<
      RestockApplicationCoordinator,
      'applyOnce'
    >,
    options: Options = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.options = {
      intervalMs: 5_000,
      maxPolls: 17_280,
      maxAgeMs: 86_400_000,
      maxTrackedKeys: 100,
      ...options,
    };
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('Poller bounds must be positive safe integers');
    }
    if (this.options.intervalMs > 2 ** 31 - 1)
      throw new RangeError('Poller interval exceeds timer range');
  }

  start(): void {
    if (!this.stopped) this.started = true;
  }
  onApplicationBootstrap(): void {
    this.start();
  }

  enqueue(senderId: string, sourceRequestId: string): boolean {
    if (
      !this.started ||
      this.stopped ||
      typeof senderId !== 'string' ||
      !senderId ||
      senderId.trim() !== senderId ||
      senderId.length > 200 ||
      typeof sourceRequestId !== 'string' ||
      !UUID.test(sourceRequestId)
    )
      return false;
    const key = JSON.stringify([senderId, sourceRequestId]);
    if (this.seen.has(key) || this.seen.size >= this.options.maxTrackedKeys)
      return false;
    const now = this.now();
    if (!Number.isFinite(now)) return false;
    this.seen.add(key);
    this.queue.push({
      senderId,
      sourceRequestId,
      enqueuedAt: now,
      lastObservedAt: now,
      polls: 0,
    });
    this.schedule();
    return true;
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    return (this.stopping ??= this.inFlight ?? Promise.resolve());
  }
  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  private now(): number {
    try {
      return this.clock();
    } catch {
      return NaN;
    }
  }

  private schedule(): void {
    if (
      this.stopped ||
      this.timer !== undefined ||
      this.inFlight ||
      !this.queue.length
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Defer execution until inFlight is assigned, including synchronous throws.
      this.inFlight = Promise.resolve()
        .then(() => this.tick())
        .finally(() => {
          this.inFlight = undefined;
          this.schedule();
        });
    }, this.options.intervalMs);
  }

  private async tick(): Promise<void> {
    const job = this.queue.shift();
    if (this.stopped || !job) return;
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      now < job.lastObservedAt ||
      now - job.enqueuedAt >= this.options.maxAgeMs ||
      job.polls >= this.options.maxPolls
    )
      return;
    job.lastObservedAt = now;
    job.polls++;
    try {
      const result = await this.coordinator.applyOnce(
        job.senderId,
        job.sourceRequestId,
      );
      if (
        !this.stopped &&
        result?.action === 'pending' &&
        job.polls < this.options.maxPolls
      )
        this.queue.push(job);
    } catch {
      // Errors are terminal here; no send/ACK retry or ambiguous-state recovery.
    }
  }
}
