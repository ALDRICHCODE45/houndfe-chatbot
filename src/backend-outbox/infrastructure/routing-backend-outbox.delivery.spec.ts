import type {
  BackendOutboxBatchDeliveryPort,
  BackendOutboxDeliveryPort,
  BackendOutboxEntry,
} from '../domain/backend-outbox';
import { RoutingBackendOutboxDelivery } from './routing-backend-outbox.delivery';

const entry = (kind: BackendOutboxEntry['kind']): BackendOutboxEntry => ({
  id: '1',
  conversationRef: 'wa:5215550001111',
  seq: 3,
  kind,
  idempotencyKey: 'k',
  payload: {},
  status: 'IN_FLIGHT',
  attempts: 0,
  nextAttemptAt: new Date(),
  leaseOwner: 'o',
  leaseExpiresAt: new Date(),
  lastError: null,
  createdAt: new Date(),
  doneAt: null,
});

const port = (): jest.Mocked<BackendOutboxDeliveryPort> => ({
  deliver: jest.fn().mockResolvedValue({ outcome: 'DELIVERED' }),
});

describe('RoutingBackendOutboxDelivery', () => {
  it('delegates registered kinds and sends the rest to the fallback', async () => {
    const fallback = port();
    fallback.deliver.mockResolvedValue({ outcome: 'RETRY', error: 'nw' });
    const requests = port();
    const router = new RoutingBackendOutboxDelivery(fallback);
    router.register(['REQUEST_CREATE', 'REQUEST_CANCEL'], requests);

    await expect(router.deliver(entry('REQUEST_CREATE'))).resolves.toEqual({
      outcome: 'DELIVERED',
    });
    await router.deliver(entry('REQUEST_CANCEL'));
    expect(requests.deliver).toHaveBeenCalledTimes(2);
    for (const kind of [
      'MESSAGE_MIRROR',
      'MESSAGE_STATUS',
      'SESSION_ACK',
      'DELIVERY_OUTCOME',
    ] as const)
      await expect(router.deliver(entry(kind))).resolves.toEqual({
        outcome: 'RETRY',
        error: 'nw',
      });
    expect(fallback.deliver).toHaveBeenCalledTimes(4);
  });

  it('defaults to the not-wired retry for unregistered kinds', async () => {
    const router = new RoutingBackendOutboxDelivery();
    await expect(router.deliver(entry('MESSAGE_MIRROR'))).resolves.toEqual({
      outcome: 'RETRY',
      error: 'backend outbox delivery not wired for kind MESSAGE_MIRROR',
    });
  });

  it('refuses a second adapter for the same kind', () => {
    const router = new RoutingBackendOutboxDelivery(port());
    const first = port();
    router.register(['REQUEST_CREATE'], first);
    router.register(['REQUEST_CREATE'], first);
    expect(() => router.register(['REQUEST_CREATE'], port())).toThrow(
      /REQUEST_CREATE/,
    );
  });

  describe('batches', () => {
    const batchPort = (): jest.Mocked<BackendOutboxBatchDeliveryPort> => ({
      deliver: jest.fn().mockResolvedValue({ outcome: 'DELIVERED' }),
      batchLimit: jest.fn().mockReturnValue(50),
      deliverBatch: jest
        .fn()
        .mockResolvedValue([
          { outcome: 'DELIVERED' },
          { outcome: 'DELIVERED' },
        ]),
    });

    it('reports the adapter batch limit for its kinds and 1 for the rest', () => {
      const router = new RoutingBackendOutboxDelivery(port());
      const mirror = batchPort();
      router.register(['MESSAGE_MIRROR'], mirror);
      router.register(['REQUEST_CREATE'], port());
      expect(router.batchLimit('MESSAGE_MIRROR')).toBe(50);
      expect(mirror.batchLimit).toHaveBeenCalledWith('MESSAGE_MIRROR');
      expect(router.batchLimit('REQUEST_CREATE')).toBe(1);
      expect(router.batchLimit('SESSION_ACK')).toBe(1);
    });

    it('delegates a batch to the adapter of the run kind with the options', async () => {
      const router = new RoutingBackendOutboxDelivery(port());
      const mirror = batchPort();
      router.register(['MESSAGE_MIRROR'], mirror);
      const entries = [entry('MESSAGE_MIRROR'), entry('MESSAGE_MIRROR')];
      const signal = new AbortController().signal;
      await expect(router.deliverBatch(entries, { signal })).resolves.toEqual([
        { outcome: 'DELIVERED' },
        { outcome: 'DELIVERED' },
      ]);
      expect(mirror.deliverBatch).toHaveBeenCalledWith(entries, { signal });
    });

    it('a batch for a kind without a batch adapter falls back row by row', async () => {
      const fallback = port();
      fallback.deliver
        .mockResolvedValueOnce({ outcome: 'RETRY', error: 'nw' })
        .mockResolvedValueOnce({ outcome: 'DELIVERED' });
      const router = new RoutingBackendOutboxDelivery(fallback);
      await expect(
        router.deliverBatch([entry('SESSION_ACK'), entry('SESSION_ACK')]),
      ).resolves.toEqual([
        { outcome: 'RETRY', error: 'nw' },
        { outcome: 'DELIVERED' },
      ]);
    });
  });
});
