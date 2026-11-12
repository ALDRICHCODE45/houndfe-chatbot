import { Logger } from '@nestjs/common';
import type {
  BackendOutboxDeliveryResult,
  BackendOutboxEnqueueInput,
} from '../../backend-outbox/domain/backend-outbox';
import type {
  MirrorStatusInput,
  MirrorStatusesResult,
} from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import { InMemoryBackendOutboxStore } from '../../backend-outbox/infrastructure/in-memory-backend-outbox.store';
import { MirrorDeliveryGate } from './mirror-delivery-gate';
import { MirrorStatusesDelivery } from './mirror-statuses.delivery';
import { NOW, REF, rowEntry } from './mirror-test-support';

type Call = MirrorStatusInput[];
type Script = (call: Call, index: number) => MirrorStatusesResult;

const contains = (text: string): string =>
  expect.stringContaining(text) as string;
const okAck = (unknown: string[] = []): MirrorStatusesResult => ({
  kind: 'ok',
  applied: 1,
  ignored: 0,
  unknown,
});

function build(script: Script = () => okAck(), enqueueFails = false) {
  const calls: Call[] = [];
  const recordMessageStatuses = jest.fn((statuses: MirrorStatusInput[]) => {
    calls.push(structuredClone(statuses));
    return Promise.resolve(script(statuses, calls.length - 1));
  });
  const enqueued: BackendOutboxEnqueueInput[] = [];
  const enqueue = jest.fn((input: BackendOutboxEnqueueInput) => {
    if (enqueueFails) return Promise.reject(new Error('db down'));
    enqueued.push(input);
    return Promise.resolve({} as never);
  });
  const gate = new MirrorDeliveryGate({ random: () => 0 });
  const delivery = new MirrorStatusesDelivery({
    client: { recordMessageStatuses },
    outbox: { enqueue },
    gate,
    clock: () => NOW,
  });
  return { delivery, calls, enqueued, enqueue, recordMessageStatuses };
}

const statusPayload = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  providerMessageId: `wamid.${id}`,
  status: 'DELIVERED',
  occurredAt: '2026-11-12T16:02:19.000Z',
  ...overrides,
});
const rows = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) =>
    rowEntry(from + i, statusPayload(String(from + i)), 'MESSAGE_STATUS'),
  );
const outcomes = (results: BackendOutboxDeliveryResult[]) =>
  results.map((r) => r.outcome);

describe('MirrorStatusesDelivery (T5)', () => {
  let errorLog: jest.SpyInstance;
  let debugLog: jest.SpyInstance;
  beforeEach(() => {
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    debugLog = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('batches up to 100 MESSAGE_STATUS rows and nothing else', () => {
    const { delivery } = build();
    expect(delivery.batchLimit('MESSAGE_STATUS')).toBe(100);
    expect(delivery.batchLimit('MESSAGE_MIRROR')).toBe(1);
  });

  describe('mapping', () => {
    it('sends the run in order in ONE call with the contract fields', async () => {
      const { delivery, calls } = build();
      const entries = [
        ...rows(2),
        rowEntry(
          3,
          statusPayload('3', { status: 'FAILED', errorCode: '131047' }),
          'MESSAGE_STATUS',
        ),
      ];
      const results = await delivery.deliverBatch(entries);
      expect(outcomes(results)).toEqual(Array(3).fill('DELIVERED'));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        {
          providerMessageId: 'wamid.1',
          status: 'DELIVERED',
          occurredAt: '2026-11-12T16:02:19.000Z',
        },
        {
          providerMessageId: 'wamid.2',
          status: 'DELIVERED',
          occurredAt: '2026-11-12T16:02:19.000Z',
        },
        {
          providerMessageId: 'wamid.3',
          status: 'FAILED',
          occurredAt: '2026-11-12T16:02:19.000Z',
          errorCode: '131047',
        },
      ]);
    });

    it('upper-cases Meta statuses and cuts an errorCode to 64 characters', async () => {
      const { delivery, calls } = build();
      await delivery.deliverBatch([
        rowEntry(1, statusPayload('1', { status: 'read' }), 'MESSAGE_STATUS'),
        rowEntry(
          2,
          statusPayload('2', { status: 'failed', errorCode: 'e'.repeat(80) }),
          'MESSAGE_STATUS',
        ),
      ]);
      expect(calls[0][0].status).toBe('READ');
      expect(calls[0][1].status).toBe('FAILED');
      expect(calls[0][1].errorCode).toHaveLength(64);
    });

    it('a missing occurredAt is backfilled with the row creation time', async () => {
      const { delivery, calls } = build();
      await delivery.deliverBatch([
        rowEntry(
          1,
          { providerMessageId: 'wamid.1', status: 'SENT' },
          'MESSAGE_STATUS',
        ),
      ]);
      expect(calls[0][0].occurredAt).toBe('2026-11-12T16:30:00.000Z');
    });

    it.each(['QUEUED', 'DEFERRED', 'UNKNOWN', 'queued'])(
      '%s is the backend’s own status: dropped as DONE, no HTTP for it',
      async (status) => {
        const { delivery, calls } = build();
        const results = await delivery.deliverBatch([
          rowEntry(1, statusPayload('1', { status }), 'MESSAGE_STATUS'),
          ...rows(1, 2),
        ]);
        expect(outcomes(results)).toEqual(['DELIVERED', 'DELIVERED']);
        expect(calls).toHaveLength(1);
        expect(calls[0].map((s) => s.providerMessageId)).toEqual(['wamid.2']);
      },
    );

    it('a run made only of dropped statuses makes no call', async () => {
      const { delivery, recordMessageStatuses } = build();
      const results = await delivery.deliverBatch([
        rowEntry(1, statusPayload('1', { status: 'QUEUED' }), 'MESSAGE_STATUS'),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED']);
      expect(recordMessageStatuses).not.toHaveBeenCalled();
    });

    it('an unmappable row is DEAD alone and never parks its neighbours', async () => {
      const { delivery, calls } = build();
      const results = await delivery.deliverBatch([
        ...rows(1),
        rowEntry(2, { status: 'READ' }, 'MESSAGE_STATUS'),
        rowEntry(3, statusPayload('3', { status: 'weird' }), 'MESSAGE_STATUS'),
        ...rows(1, 4),
      ]);
      expect(outcomes(results)).toEqual([
        'DELIVERED',
        'PERMANENT',
        'PERMANENT',
        'DELIVERED',
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(2);
    });
  });

  describe('unknown ids never block the lane (S5 #7)', () => {
    const requeueRow = (
      attempt: number,
      overrides: Record<string, unknown> = {},
    ) =>
      rowEntry(
        1,
        statusPayload('9', {
          firstSeenAt: '2026-11-12T10:00:00.000Z',
          attempt,
          retryBaseKey: 'status:orig',
          ...overrides,
        }),
        'MESSAGE_STATUS',
        { idempotencyKey: `status:orig:u${attempt}` },
      );

    it('ACKs the rows and re-enqueues each unknown one at the lane tail, NO delay, with firstSeenAt and attempt 2', async () => {
      const { delivery, enqueued } = build(() => okAck(['wamid.2']));
      const results = await delivery.deliverBatch(rows(3));
      expect(outcomes(results)).toEqual(Array(3).fill('DELIVERED'));
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toEqual({
        conversationRef: REF,
        kind: 'MESSAGE_STATUS',
        idempotencyKey: 'status:2:u2',
        payload: {
          providerMessageId: 'wamid.2',
          status: 'DELIVERED',
          occurredAt: '2026-11-12T16:02:19.000Z',
          firstSeenAt: '2026-11-12T16:30:00.000Z',
          attempt: 2,
          retryBaseKey: 'status:2',
        },
      });
      expect(enqueued[0].delayMs ?? 0).toBe(0);
    });

    it('the second re-enqueue (attempt 3) carries the original firstSeenAt and base key, still with no delay', async () => {
      const { delivery, enqueued } = build(() => okAck(['wamid.9']));
      await delivery.deliverBatch([requeueRow(2)]);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].idempotencyKey).toBe('status:orig:u3');
      expect(enqueued[0].delayMs ?? 0).toBe(0);
      expect(enqueued[0].payload).toMatchObject({
        firstSeenAt: '2026-11-12T10:00:00.000Z',
        attempt: 3,
        retryBaseKey: 'status:orig',
      });
    });

    it('gives up after 3 total attempts: DONE, no re-enqueue, a masked debug log', async () => {
      const { delivery, enqueue } = build(() => okAck(['wamid.9']));
      const results = await delivery.deliverBatch([requeueRow(3)]);
      expect(outcomes(results)).toEqual(['DELIVERED']);
      expect(enqueue).not.toHaveBeenCalled();
      expect(debugLog).toHaveBeenCalledWith(contains('3 attempts'));
      expect(debugLog).toHaveBeenCalledWith(contains('wa:…1111'));
      expect(JSON.stringify(debugLog.mock.calls)).not.toContain(
        '5215550001111',
      );
    });

    it('a count above the cap (corrupt payload) also gives up', async () => {
      const { delivery, enqueue } = build(() => okAck(['wamid.9']));
      await delivery.deliverBatch([requeueRow(40)]);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('a row without a counter is the first attempt', async () => {
      const { delivery, enqueued } = build(() => okAck(['wamid.1']));
      await delivery.deliverBatch(rows(1));
      expect(enqueued[0].payload.attempt).toBe(2);
      expect(enqueued[0].idempotencyKey).toBe('status:1:u2');
    });

    it('gives up after 24 h since firstSeenAt even with attempts left: DONE, no re-enqueue, a masked debug log', async () => {
      const { delivery, enqueue } = build(() => okAck(['wamid.9']));
      const results = await delivery.deliverBatch([
        requeueRow(2, { firstSeenAt: '2026-11-11T16:59:00.000Z' }),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED']);
      expect(enqueue).not.toHaveBeenCalled();
      expect(debugLog).toHaveBeenCalledWith(contains('24 h'));
      expect(debugLog).toHaveBeenCalledWith(contains('wa:…1111'));
    });

    it('still re-enqueues just under 24 h', async () => {
      const { delivery, enqueue } = build(() => okAck(['wamid.9']));
      await delivery.deliverBatch([
        requeueRow(2, { firstSeenAt: '2026-11-11T17:01:00.000Z' }),
      ]);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('a failed re-enqueue retries only that row', async () => {
      const { delivery } = build(() => okAck(['wamid.2']), true);
      const results = await delivery.deliverBatch(rows(3));
      expect(outcomes(results)).toEqual(['DELIVERED', 'RETRY', 'DELIVERED']);
    });

    it('an over-long derived key gives up that status instead of throwing', async () => {
      const { delivery, enqueue } = build(() => okAck(['wamid.1']));
      const results = await delivery.deliverBatch([
        rowEntry(
          1,
          statusPayload('1', { retryBaseKey: 'k'.repeat(199) }),
          'MESSAGE_STATUS',
        ),
      ]);
      expect(outcomes(results)).toEqual(['DELIVERED']);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('with the real outbox: the re-enqueued status is due at once and a mirror row queued behind the original is NOT held back', async () => {
      const store = new InMemoryBackendOutboxStore();
      const status = await store.enqueue({
        conversationRef: REF,
        kind: 'MESSAGE_STATUS',
        idempotencyKey: 'status:wamid.7:DELIVERED',
        payload: statusPayload('7'),
      });
      await store.enqueue({
        conversationRef: REF,
        kind: 'MESSAGE_MIRROR',
        idempotencyKey: 'mirror:wamid.7',
        payload: { waMessageId: 'wamid.7' },
      });
      const delivery = new MirrorStatusesDelivery({
        client: {
          recordMessageStatuses: () => Promise.resolve(okAck(['wamid.7'])),
        },
        outbox: store,
        gate: new MirrorDeliveryGate({ random: () => 0 }),
      });
      const [head] = await store.claimHeads(10, 'o', 60_000);
      expect(head.idempotencyKey).toBe('status:wamid.7:DELIVERED');
      const [result] = await delivery.deliverBatch([head]);
      expect(result).toEqual({ outcome: 'DELIVERED' });
      await store.markDone(head);
      // The mirror row is next, immediately (no delayed row ahead of it)…
      const [mirror] = await store.claimHeads(10, 'o', 60_000);
      expect(mirror.idempotencyKey).toBe('mirror:wamid.7');
      expect(mirror.seq).toBe(status.entry.seq + 1);
      await store.markDone(mirror);
      // …and the re-enqueued status sits behind it, already due.
      const [retried] = await store.claimHeads(10, 'o', 60_000);
      expect(retried).toMatchObject({
        kind: 'MESSAGE_STATUS',
        idempotencyKey: 'status:wamid.7:DELIVERED:u2',
        seq: status.entry.seq + 2,
        payload: { attempt: 2 },
      });
    });
  });

  describe('S4 reactions (same as messages)', () => {
    it('413 halves the batch', async () => {
      const { delivery, calls } = build((call) =>
        call.length > 2
          ? { kind: 'BATCH_TOO_LARGE', limit: 2, local: false }
          : okAck(),
      );
      const results = await delivery.deliverBatch(rows(4));
      expect(outcomes(results)).toEqual(Array(4).fill('DELIVERED'));
      expect(calls.map((c) => c.length)).toEqual([4, 2, 2]);
    });

    it('400 isolates the offending status, DEADs only it and delivers the rest', async () => {
      const { delivery } = build((call) =>
        call.some((s) => s.providerMessageId === 'wamid.3')
          ? { kind: 'VALIDATION_ERROR', message: null, local: false }
          : okAck(),
      );
      const results = await delivery.deliverBatch(rows(6));
      expect(outcomes(results)).toEqual([
        'DELIVERED',
        'DELIVERED',
        'PERMANENT',
        'DELIVERED',
        'DELIVERED',
        'DELIVERED',
      ]);
    });

    it('401 STOPs without killing rows and alerts once; later batches wait without a call', async () => {
      const { delivery, recordMessageStatuses } = build(() => ({
        kind: 'UNAUTHORIZED',
      }));
      const first = await delivery.deliverBatch(rows(2));
      expect(first).toEqual(
        Array(2).fill({
          outcome: 'RETRY',
          error: '401 UNAUTHORIZED',
          retryAfterMs: 15 * 60_000,
        }),
      );
      const second = await delivery.deliverBatch(rows(2));
      expect(outcomes(second)).toEqual(['RETRY', 'RETRY']);
      expect(recordMessageStatuses).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('429 RETRYs with Retry-After; 5xx retries the same body', async () => {
      const limited = build(() => ({
        kind: 'RATE_LIMITED',
        retryAfterSeconds: 3,
      }));
      expect((await limited.delivery.deliverBatch(rows(2)))[0]).toMatchObject({
        outcome: 'RETRY',
        retryAfterMs: 3000,
      });
      const down = build(() => ({
        kind: 'RETRYABLE',
        cause: 'http_5xx',
        status: 502,
        retryAfterSeconds: null,
      }));
      const results = await down.delivery.deliverBatch(rows(2));
      expect(outcomes(results)).toEqual(['RETRY', 'RETRY']);
      expect(down.calls).toHaveLength(1);
    });

    it('S6: no phone or conversationRef in results or logs', async () => {
      const { delivery } = build(() => ({
        kind: 'UNEXPECTED',
        status: 500,
        code: null,
      }));
      const results = await delivery.deliverBatch([
        ...rows(1),
        rowEntry(2, { broken: 1 }, 'MESSAGE_STATUS'),
      ]);
      const everything = JSON.stringify([results, errorLog.mock.calls]);
      expect(everything).not.toContain('5215550001111');
    });
  });
});
