import { AsyncSemaphore } from './async-semaphore';

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe('AsyncSemaphore', () => {
  it('never runs more than the limit at once and runs everything', async () => {
    const semaphore = new AsyncSemaphore(2);
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, gate);
    const runs = gates.map((g) =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await g.promise;
        active -= 1;
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(active).toBe(2);
    for (const g of gates) {
      g.open();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('starts waiting tasks in FIFO order', async () => {
    const semaphore = new AsyncSemaphore(1);
    const order: number[] = [];
    const first = gate();
    const runs = [
      semaphore.run(async () => {
        order.push(1);
        await first.promise;
      }),
      semaphore.run(() => Promise.resolve(order.push(2))),
      semaphore.run(() => Promise.resolve(order.push(3))),
    ];
    first.open();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the permit when a task throws and propagates the error', async () => {
    const semaphore = new AsyncSemaphore(1);
    await expect(
      semaphore.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(semaphore.run(() => Promise.resolve('next'))).resolves.toBe(
      'next',
    );
  });

  it('rejects a non-positive or fractional limit', () => {
    expect(() => new AsyncSemaphore(0)).toThrow();
    expect(() => new AsyncSemaphore(1.5)).toThrow();
  });
});
