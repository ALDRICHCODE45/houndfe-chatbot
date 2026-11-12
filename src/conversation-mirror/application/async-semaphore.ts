/** Bounds how many async tasks run at once (S1: at most N transfers against
 *  Meta / the CDN and the backend). FIFO; a throwing task releases its permit. */
export class AsyncSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('AsyncSemaphore limit must be a positive integer');
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    // The permit is handed over directly by release(), so `active` stays put.
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) next();
    else this.active -= 1;
  }
}
