import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import type {
  DeliveryZoneIntakeInput,
  DeliveryZoneRequester,
} from '../../chatbot-api/domain/dtos/human-decisions-delivery-zone.dto';
import type { CustomerInboundObservationLatest } from '../../human-decisions/domain/customer-inbound-observation-store.port';
import { InMemoryDeliveryZoneRequesterStore } from '../infrastructure/in-memory-delivery-zone-requester.store';
import { DeliveryZoneIntakeService } from './delivery-zone-intake.service';

const SENDER = '5215512345678';
const PHONE_ID = '123456789';
const NOW = '2026-11-05T10:05:00.000Z';
const REQUESTER = 'c41b2c3d-1111-4222-8333-444455556666';
const DECISION = '8a2f0000-1111-4222-8333-444455556666';
const ids = [
  '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b',
  '7f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b',
];
const destination = {
  senderId: SENDER,
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};
function requester(
  sent: DeliveryZoneIntakeInput,
  patch: Partial<DeliveryZoneRequester> = {},
): DeliveryZoneRequester {
  return {
    id: REQUESTER,
    sourceRequestId: sent.sourceRequestId,
    type: 'DELIVERY_ZONE',
    status: 'PENDING',
    version: 1,
    createdAt: NOW,
    decisionId: DECISION,
    snapshot: {
      branchName: 'Centro',
      zipCode: sent.zipCode,
      state: sent.state,
      municipality: sent.municipality,
      neighborhood: sent.neighborhood,
    },
    resolution: null,
    applyBefore: null,
    ...patch,
  } as DeliveryZoneRequester;
}

function setup(
  latest: CustomerInboundObservationLatest = {
    kind: 'found',
    observation: {
      senderId: SENDER,
      receivingPhoneNumberId: PHONE_ID,
      messageId: 'wamid.1',
      providerTimestampSeconds: '1793872800', // 2026-11-05T10:00:00Z
      observedAt: '2026-11-05T10:00:01.000Z',
    },
  },
) {
  const store = new InMemoryDeliveryZoneRequesterStore();
  const submit = jest.fn((sent: DeliveryZoneIntakeInput) =>
    Promise.resolve(requester(sent)),
  );
  const readLatest = jest.fn().mockResolvedValue(latest);
  const queue = [...ids];
  const service = new DeliveryZoneIntakeService(
    store,
    { submitDeliveryZoneIntake: submit },
    { readLatest },
    PHONE_ID,
    () => new Date(NOW),
    () => queue.shift()!,
  );
  return { store, submit, readLatest, service };
}

describe('DeliveryZoneIntakeService', () => {
  it('registers the exact contract body and stores the PENDING requester', async () => {
    const { store, submit, readLatest, service } = setup();
    await service.register(destination);
    expect(readLatest).toHaveBeenCalledWith(SENDER, PHONE_ID);
    expect(submit).toHaveBeenCalledWith({
      sourceRequestId: ids[0],
      type: 'DELIVERY_ZONE',
      zipCode: '06700',
      state: 'Ciudad de México',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Roma Norte',
      phoneCountryCode: '52',
      phone: '5512345678',
      conversationRef: `wa:${SENDER}`,
      lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
    });
    expect(store.rows.get(ids[0])).toMatchObject({
      status: 'PENDING',
      requesterId: REQUESTER,
      lastPolledAt: NOW,
    });
  });

  it('falls back to now when no inbound observation exists', async () => {
    const { submit, service } = setup({ kind: 'missing' });
    await service.register(destination);
    expect(submit.mock.calls[0][0].lastCustomerMessageAt).toBe(NOW);
  });

  it('keeps one requester per sender+ZIP while it is open', async () => {
    const { store, submit, service } = setup();
    await service.register(destination);
    await service.register({ ...destination, neighborhood: 'Otra' });
    expect(store.rows.size).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('replays the same sourceRequestId and body after a transient failure', async () => {
    const { store, submit, service } = setup();
    submit.mockRejectedValueOnce(new UpstreamError('down', 503));
    await expect(service.register(destination)).resolves.toBeUndefined();
    expect(store.rows.get(ids[0])).toMatchObject({
      status: 'INTAKE_PENDING',
      lastPolledAt: NOW,
    });
    await service.register({ ...destination, neighborhood: 'Otra' });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0]);
    expect(store.rows.get(ids[0])?.status).toBe('PENDING');
  });

  it('a different ZIP opens a new requester', async () => {
    const { store, service } = setup();
    await service.register(destination);
    await service.register({ ...destination, zipCode: '06600' });
    expect([...store.rows.keys()]).toEqual(ids);
  });

  it('marks a permanently rejected intake FAILED without throwing', async () => {
    const { store, submit, service } = setup();
    submit.mockRejectedValueOnce(
      new ChatbotApiError('bad', 409, {}, 'IDEMPOTENCY_CONFLICT'),
    );
    await service.register(destination);
    expect(store.rows.get(ids[0])?.status).toBe('FAILED');
  });

  it('stores an EXISTING_ZONE answer as RESOLVED at once', async () => {
    const { store, submit, service } = setup();
    submit.mockImplementationOnce((sent) =>
      Promise.resolve(
        requester(sent, {
          status: 'RESOLVED',
          version: 2,
          decisionId: null,
          resolution: {
            source: 'EXISTING_ZONE',
            zoneType: 'FREE',
            resolvedAt: NOW,
          },
          applyBefore: '2026-11-06T10:05:00.000Z',
        }),
      ),
    );
    await service.register(destination);
    expect(store.rows.get(ids[0])).toMatchObject({
      status: 'RESOLVED',
      requesterId: REQUESTER,
      resolution: { source: 'EXISTING_ZONE', zoneType: 'FREE' },
      applyBefore: '2026-11-06T10:05:00.000Z',
    });
  });

  it('skips a destination the contract cannot carry, without throwing', async () => {
    const { store, submit, service } = setup();
    await service.register({ ...destination, municipality: '' });
    await service.register({ ...destination, senderId: 'not-a-phone' });
    expect(submit).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });
});
