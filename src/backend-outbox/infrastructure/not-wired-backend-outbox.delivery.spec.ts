import { Logger } from '@nestjs/common';
import type { BackendOutboxEntry } from '../domain/backend-outbox';
import { NotWiredBackendOutboxDelivery } from './not-wired-backend-outbox.delivery';

const entry = (kind: BackendOutboxEntry['kind']): BackendOutboxEntry => ({
  id: '1',
  conversationRef: 'wa:5215550001111',
  seq: 1,
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

describe('NotWiredBackendOutboxDelivery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retries every kind (nothing is lost) and logs once per kind per minute', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    let now = 0;
    const delivery = new NotWiredBackendOutboxDelivery(() => now);
    await expect(delivery.deliver(entry('MESSAGE_MIRROR'))).resolves.toEqual({
      outcome: 'RETRY',
      error: 'backend outbox delivery not wired for kind MESSAGE_MIRROR',
    });
    await delivery.deliver(entry('MESSAGE_MIRROR'));
    await delivery.deliver(entry('SESSION_ACK'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'backend outbox delivery not wired for kind MESSAGE_MIRROR; will retry',
    );
    now = 60_000;
    await delivery.deliver(entry('MESSAGE_MIRROR'));
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
