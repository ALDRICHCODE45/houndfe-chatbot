import {
  DEFAULT_DELIVERY_ZONE_POLL_POLICY,
  isDeliveryZoneRequesterDue,
  type DeliveryZoneRequesterRow,
} from '../domain/delivery-zone-requester';
import { InMemoryDeliveryZoneRequesterStore } from '../infrastructure/in-memory-delivery-zone-requester.store';
import { DeliveryZonePoller } from './delivery-zone-poller';

const CREATED = '2026-11-05T10:00:00.000Z';
const at = (offsetMs: number) =>
  new Date(Date.parse(CREATED) + offsetMs).toISOString();
const MIN = 60_000;
const processFn = () =>
  jest
    .fn<Promise<void>, [DeliveryZoneRequesterRow]>()
    .mockResolvedValue(undefined);
const HOUR = 3_600_000;

function row(
  id: string,
  patch: Partial<DeliveryZoneRequesterRow> = {},
): DeliveryZoneRequesterRow {
  return {
    sourceRequestId: id,
    senderId: '5215512345678',
    zipCode: '06700',
    intake: {} as DeliveryZoneRequesterRow['intake'],
    requesterId: null,
    status: 'PENDING',
    lastPolledAt: null,
    resolution: null,
    applyBefore: null,
    channel: null,
    attemptId: null,
    attemptedAt: null,
    deliveryOutcome: null,
    providerMessageId: null,
    providerAcceptedObservedAt: null,
    notifiedAt: null,
    ackOutcome: null,
    ackedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...patch,
  };
}

describe('isDeliveryZoneRequesterDue (backoff selection)', () => {
  const policy = DEFAULT_DELIVERY_ZONE_POLL_POLICY;
  const due = (patch: Partial<DeliveryZoneRequesterRow>, now: number) =>
    isDeliveryZoneRequesterDue(row('a', patch), Date.parse(at(now)), policy);

  it('a never-polled requester is due', () => {
    expect(due({}, 0)).toBe(true);
  });
  it('a young requester is due again after the base interval', () => {
    expect(due({ lastPolledAt: at(10 * MIN) }, 10 * MIN + 59_999)).toBe(false);
    expect(due({ lastPolledAt: at(10 * MIN) }, 11 * MIN)).toBe(true);
  });
  it('after one hour a requester backs off to every 5 minutes', () => {
    expect(due({ lastPolledAt: at(2 * HOUR) }, 2 * HOUR + MIN)).toBe(false);
    expect(due({ lastPolledAt: at(2 * HOUR) }, 2 * HOUR + 5 * MIN)).toBe(true);
  });
  it('a requester pending for days is still selected (no horizon)', () => {
    expect(due({ lastPolledAt: at(72 * HOUR) }, 72 * HOUR + 5 * MIN)).toBe(
      true,
    );
  });
  it('resolved, started and notified rows are always due', () => {
    for (const status of ['RESOLVED', 'SEND_STARTED', 'NOTIFIED'] as const)
      expect(due({ status, lastPolledAt: at(0) }, 1)).toBe(true);
  });
  it('closed and failed rows are never due', () => {
    for (const status of ['CLOSED', 'FAILED'] as const)
      expect(due({ status }, 10 * HOUR)).toBe(false);
  });
});

describe('DeliveryZonePoller', () => {
  afterEach(() => jest.useRealTimers());

  it('processes due rows on start, bounded by the batch size', async () => {
    const store = new InMemoryDeliveryZoneRequesterStore();
    for (const id of ['a', 'b', 'c']) store.rows.set(id, row(id));
    const process = processFn();
    const poller = new DeliveryZonePoller(
      store,
      { process },
      { batchSize: 2 },
      () => new Date(at(0)),
    );
    await poller.tick();
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('a fresh poller over the same durable store resumes open requesters (restart)', async () => {
    const store = new InMemoryDeliveryZoneRequesterStore();
    store.rows.set('a', row('a', { lastPolledAt: at(0) }));
    store.rows.set('b', row('b', { status: 'SEND_STARTED' }));
    store.rows.set('c', row('c', { status: 'CLOSED' }));
    const first = processFn();
    await new DeliveryZonePoller(
      store,
      { process: first },
      {},
      () => new Date(at(30_000)),
    ).tick();
    expect(first.mock.calls.map(([r]) => r.sourceRequestId)).toEqual(['b']);
    const second = processFn();
    await new DeliveryZonePoller(
      store,
      { process: second },
      {},
      () => new Date(at(2 * MIN)),
    ).tick();
    expect(second.mock.calls.map(([r]) => r.sourceRequestId).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('runs on boot and then every intervalMs until stopped', async () => {
    jest.useFakeTimers();
    const store = new InMemoryDeliveryZoneRequesterStore();
    store.rows.set('a', row('a', { status: 'RESOLVED' }));
    const process = processFn();
    const poller = new DeliveryZonePoller(
      store,
      { process },
      { intervalMs: 1_000 },
    );
    poller.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(process).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(process).toHaveBeenCalledTimes(2);
    await poller.stop();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('a failing row does not stop the batch', async () => {
    const store = new InMemoryDeliveryZoneRequesterStore();
    store.rows.set('a', row('a'));
    store.rows.set('b', row('b'));
    const process = processFn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    await new DeliveryZonePoller(
      store,
      { process },
      {},
      () => new Date(at(0)),
    ).tick();
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-positive interval', () => {
    expect(
      () =>
        new DeliveryZonePoller(
          new InMemoryDeliveryZoneRequesterStore(),
          { process: jest.fn() },
          { intervalMs: 0 },
        ),
    ).toThrow(RangeError);
  });
});
