import type {
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
});
