import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';

const sourceRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const decisionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const pending = () => ({
  senderId: 'whatsapp:+5215500000001',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2 as const,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-25T11:00:00.000Z',
  state: 'PENDING_DELIVERY' as const,
});
const started = () => ({
  ...pending(),
  state: 'SEND_STARTED' as const,
  sendToken: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
  attemptedAt: pending().resolvedAt,
});
const event = (late = false) => ({
  kind: 'provider_accepted' as const,
  attemptId: started().attemptId,
  sendToken: started().sendToken.toLowerCase(),
  providerMessageId: ' Provider-ID ',
  providerAcceptedObservedAt: late
    ? pending().applyBefore
    : pending().resolvedAt,
});
const accepted = (late = false) => ({
  ...started(),
  state: late ? 'PROVIDER_ACCEPTED_LATE' : 'PROVIDER_ACCEPTED',
  providerMessageId: event().providerMessageId,
  providerAcceptedObservedAt: event(late).providerAcceptedObservedAt,
});
const projection = (row = accepted(), patch = {}) => ({
  decision_id: row.decisionId.toLowerCase(),
  source_request_id: row.sourceRequestId,
  attempt_id: row.attemptId,
  sender_id: row.senderId,
  branch_id: row.branchId,
  row_data: row,
  ack_receipt: null,
  ...patch,
});
const result = (...rows: unknown[]) => ({ rows, rowCount: rows.length });
const hold = { action: 'hold' };
function harness(reply: unknown) {
  const query = jest
    .fn()
    .mockImplementation(() =>
      reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
    );
  const store = new PostgresRestockApplicationLedgerStore({
    query,
  });
  const record = (input: unknown) =>
    store.recordAcceptance(
      input as Parameters<typeof store.recordAcceptance>[0],
    );
  return { query, record };
}

describe('local acceptance persistence (mocked Pool, not provider/DB proof)', () => {
  it.each([false, true])(
    'CAS acceptance, late=%s at exact deadline',
    async (late) => {
      const next = accepted(late);
      const h = harness(result(projection(next)));
      expect(await h.record({ row: started(), event: event(late) })).toEqual({
        action: 'updated',
        row: next,
      });
      expect(h.query).toHaveBeenCalledTimes(1);
      const [sql, values] = h.query.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ').trim()).toBe(
        'UPDATE restock_application_ledger SET row_data = $7::jsonb ' +
          'WHERE decision_id = $1::uuid AND source_request_id = $2::uuid ' +
          'AND attempt_id = $3::uuid AND sender_id = $4 AND branch_id = $5 ' +
          'AND row_data = $6::jsonb AND ack_receipt IS NULL ' +
          'RETURNING decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data, ack_receipt',
      );
      expect(values).toEqual([
        decisionId,
        sourceRequestId,
        started().attemptId,
        started().senderId,
        ' branch ',
        JSON.stringify(started()),
        JSON.stringify(next),
      ]);
    },
  );

  it.each([
    null,
    { row: started(), event: event(), extra: true },
    { row: { ...started(), extra: true }, event: event() },
    ...[
      { attemptId: sourceRequestId },
      { sendToken: sourceRequestId },
      { sendToken: 'bad' },
      { extra: true },
      { providerMessageId: '' },
      { providerAcceptedObservedAt: 'bad' },
      { providerAcceptedObservedAt: '2026-09-25T09:59:59.999Z' },
    ].map((patch) => ({ row: started(), event: { ...event(), ...patch } })),
    { row: pending(), event: event() },
    {
      row: {
        ...pending(),
        state: 'STALE',
        staleObservedAt: pending().applyBefore,
      },
      event: event(),
    },
    {
      row: accepted(),
      event: { ...event(), providerMessageId: 'replacement' },
    },
  ])('holds invalid input without queries: %j', async (input) => {
    const h = harness(result());
    expect(await h.record(input)).toEqual(hold);
    expect(h.query).not.toHaveBeenCalled();
  });

  const drift = [
    ...[
      'decision_id',
      'source_request_id',
      'attempt_id',
      'sender_id',
      'branch_id',
    ].map((key) => ({ [key]: 'drift' })),
    { ack_receipt: {} },
    { ack_receipt: undefined },
    ...[
      { sendToken: sourceRequestId },
      { providerMessageId: 'replacement' },
      { providerAcceptedObservedAt: '2026-09-25T10:30:00.000Z' },
      { attemptedAt: '2026-09-25T10:30:00.000Z' },
      { decisionId: decisionId.toLowerCase() },
      { sendToken: started().sendToken.toLowerCase() },
      {
        resolvedAt: '2026-09-25T09:30:00.000Z',
        applyBefore: '2026-09-25T10:30:00.000Z',
      },
      { extra: true },
    ].map((patch) => ({ row_data: { ...accepted(), ...patch } })),
    { row_data: accepted(true) },
    { row_data: started() },
  ];
  it.each(drift)('holds contradictory UPDATE return: %j', async (patch) => {
    const h = harness(result(projection(accepted(), patch)));
    expect(await h.record({ row: started(), event: event() })).toEqual(hold);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('holds CAS miss without reread, replay success or retry', async () => {
    const h = harness(result());
    expect(await h.record({ row: started(), event: event() })).toEqual(hold);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { rows: [], rowCount: 1 },
    { rows: [projection()], rowCount: 0 },
    { rows: [], rowCount: null },
    { rows: {}, rowCount: 0 },
    result(projection(), projection()),
    result(null),
    result([]),
  ])('throws malformed results without retry: %j', async (reply) => {
    for (const row of [started(), accepted()]) {
      const h = harness(reply);
      await expect(h.record({ row, event: event() })).rejects.toThrow();
      expect(h.query).toHaveBeenCalledTimes(1);
    }
  });

  it.each([started(), accepted()])(
    'propagates uncertain write/read error: %j',
    async (row) => {
      const error = new Error('connection lost, commit may have happened');
      const h = harness(error);
      await expect(h.record({ row, event: event() })).rejects.toBe(error);
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [false, true].flatMap((late) =>
      ['Provider-ID', ' provider-e\u0301 '].map((providerMessageId) => ({
        late,
        providerMessageId,
      })),
    ),
  )(
    'replays exact persisted terminal with optional bound ACK: %j',
    async ({ late, providerMessageId }) => {
      const row = { ...accepted(late), providerMessageId };
      const observed = {
        ...event(late),
        providerMessageId: row.providerMessageId,
      };
      const ack = {
        id: decisionId.toLowerCase(),
        version: 2,
        attemptId: row.attemptId,
        outcome: row.state,
        ackReceivedAt: '2026-09-25T12:00:00Z',
      };
      const update = harness(result(projection(row, { ack_receipt: ack })));
      expect(await update.record({ row: started(), event: observed })).toEqual(
        hold,
      );
      expect(update.query).toHaveBeenCalledTimes(1);
      for (const receipt of [null, ack]) {
        const h = harness(result(projection(row, { ack_receipt: receipt })));
        const before = JSON.stringify(receipt);
        const replay = await h.record({ row, event: observed });
        expect(replay).toEqual({ action: 'replay', row });
        if (replay.action !== 'replay') throw new Error('Expected replay');
        expect(replay.row.providerMessageId).toBe(providerMessageId);
        expect(h.query).toHaveBeenCalledTimes(1);
        expect(h.query.mock.calls[0]).toEqual([
          'SELECT decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data, ack_receipt FROM restock_application_ledger WHERE decision_id = $1',
          [decisionId],
        ]);
        expect(JSON.stringify(receipt)).toBe(before);
      }
    },
  );

  it.each([
    result(),
    ...drift.map((patch) => result(projection(accepted(), patch))),
    result(projection({ ...accepted(), branchId: 'other valid branch' })),
    result(
      projection({
        ...accepted(),
        sourceRequestId: decisionId,
        attemptId: deriveRestockAttemptId(decisionId, decisionId)!,
      }),
    ),
    result(projection(accepted(), { row_data: pending() })),
    result(
      projection(accepted(), {
        row_data: {
          ...pending(),
          state: 'STALE',
          staleObservedAt: pending().applyBefore,
        },
      }),
    ),
    result(
      projection(accepted(), {
        ack_receipt: {
          id: decisionId,
          version: 2,
          attemptId: accepted().attemptId,
          outcome: 'STALE',
          ackReceivedAt: '2026-09-25T12:00:00Z',
        },
      }),
    ),
  ])(
    'does not trust caller terminal or rewrite persisted evidence: %j',
    async (reply) => {
      const h = harness(reply);
      expect(await h.record({ row: accepted(), event: event() })).toEqual(hold);
      expect(h.query).toHaveBeenCalledTimes(1);
      const [sql] = h.query.mock.calls[0] as [string];
      expect(sql).toMatch(/^SELECT /);
    },
  );

  it.each([false, true])(
    'detaches inputs before await and freezes outputs, replay=%s',
    async (replay) => {
      const raw = accepted();
      const row = replay ? accepted() : started();
      const observed = event();
      const h = harness(result(projection(raw)));
      const promise = h.record({ row, event: observed });
      row.branchId = 'mutated';
      observed.providerMessageId = 'mutated';
      const output = await promise;
      expect(output).toEqual({
        action: replay ? 'replay' : 'updated',
        row: accepted(),
      });
      expect(Object.isFrozen(output)).toBe(true);
      if (output.action === 'hold') throw new Error('unexpected hold');
      expect(Object.isFrozen(output.row)).toBe(true);
      expect(output.row).not.toBe(raw);
      raw.branchId = 'driver mutation';
      expect(output.row.branchId).toBe(' branch ');
      if (!replay) {
        const [, values] = h.query.mock.calls[0] as [string, string[]];
        expect(JSON.parse(values[5])).toEqual(started());
        expect(JSON.parse(values[6])).toEqual(accepted());
      }
    },
  );
});
