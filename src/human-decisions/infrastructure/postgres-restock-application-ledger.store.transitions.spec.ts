import type { Pool } from 'pg';
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
const begin = () => ({
  kind: 'begin_send' as const,
  sendToken: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
  attemptedAt: pending().resolvedAt,
});
const expire = () => ({
  kind: 'expire_unsent' as const,
  observedAt: pending().applyBefore,
});
const started = () => ({
  ...pending(),
  state: 'SEND_STARTED',
  sendToken: begin().sendToken,
  attemptedAt: begin().attemptedAt,
});
const stale = () => ({
  ...pending(),
  state: 'STALE',
  staleObservedAt: expire().observedAt,
});
const projection = (row = started(), patch = {}) => ({
  decision_id: decisionId.toLowerCase(),
  source_request_id: sourceRequestId,
  attempt_id: pending().attemptId,
  sender_id: row.senderId,
  branch_id: row.branchId,
  row_data: row,
  ack_receipt: null,
  ...patch,
});
const result = (...rows: unknown[]) => ({ rows, rowCount: rows.length });
function harness(reply: unknown) {
  const query = jest.fn().mockImplementation(() => {
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  });
  const store = new PostgresRestockApplicationLedgerStore({
    query,
  } as unknown as Pool);
  const transition = (input: unknown) =>
    store.transitionPending(
      input as Parameters<typeof store.transitionPending>[0],
    );
  return { transition, query };
}
const hold = { action: 'hold' };

describe('unwired pending local CAS (mocked Pool, not database proof)', () => {
  it.each([
    [begin(), started()],
    [expire(), stale()],
  ])('updates at the inclusive boundary: %j', async (event, next) => {
    const h = harness(result(projection(started(), { row_data: next })));
    expect(await h.transition({ row: pending(), event })).toEqual({
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
      pending().attemptId,
      pending().senderId,
      ' branch ',
      JSON.stringify(pending()),
      JSON.stringify(next),
    ]);
  });

  it.each([
    null,
    { row: pending(), event: begin(), authority: 'ready' },
    { row: pending(), event: begin(), next: started() },
    { row: pending(), event: { ...begin(), extra: true } },
    { row: { ...pending(), extra: true }, event: begin() },
    { row: pending(), event: { ...begin(), sendToken: 'bad' } },
    { row: pending(), event: { ...begin(), sendToken: pending().attemptId } },
    { row: pending(), event: { ...begin(), attemptedAt: 'bad' } },
    {
      row: pending(),
      event: { ...begin(), attemptedAt: pending().applyBefore },
    },
    {
      row: pending(),
      event: { ...expire(), observedAt: pending().resolvedAt },
    },
    { row: pending(), event: { kind: 'ready' } },
    { row: { ...pending(), applyBefore: 'bad' }, event: begin() },
  ])(
    'holds invalid envelopes/transitions without querying: %j',
    async (input) => {
      const h = harness(result());
      expect(await h.transition(input)).toEqual(hold);
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    started(),
    { ...started(), sendToken: sourceRequestId },
    { ...started(), attemptedAt: '2026-09-25T10:30:00.000Z' },
    stale(),
    {
      ...started(),
      state: 'PROVIDER_ACCEPTED',
      providerMessageId: 'provider',
      providerAcceptedObservedAt: pending().resolvedAt,
    },
    {
      ...started(),
      state: 'PROVIDER_ACCEPTED_LATE',
      providerMessageId: 'provider',
      providerAcceptedObservedAt: pending().applyBefore,
    },
  ])('never recovers or retries a nonpending row: %j', async (row) => {
    for (const event of [begin(), expire()]) {
      const h = harness(result());
      expect(await h.transition({ row, event })).toEqual(hold);
      expect(h.query).not.toHaveBeenCalled();
    }
  });

  it.each([
    ...[
      'decision_id',
      'source_request_id',
      'attempt_id',
      'sender_id',
      'branch_id',
    ].map((key) => ({ [key]: 'drift' })),
    { ack_receipt: {} },
    { ack_receipt: undefined },
    { row_data: { ...started(), sendToken: sourceRequestId } },
    { row_data: { ...started(), attemptedAt: '2026-09-25T10:30:00.000Z' } },
    { row_data: { ...started(), decisionId: decisionId.toLowerCase() } },
    { row_data: { ...started(), extra: true } },
    { row_data: pending() },
    { row_data: stale() },
    {
      row_data: {
        ...started(),
        state: 'PROVIDER_ACCEPTED',
        providerMessageId: 'provider',
        providerAcceptedObservedAt: pending().resolvedAt,
      },
    },
  ])('holds invalid or different returned projections: %j', async (patch) => {
    const h = harness(result(projection(started(), patch)));
    expect(await h.transition({ row: pending(), event: begin() })).toEqual(
      hold,
    );
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('holds a CAS miss without a reread or replay success', async () => {
    const h = harness(result());
    expect(await h.transition({ row: pending(), event: begin() })).toEqual(
      hold,
    );
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
  ])(
    'throws for malformed results or contradictory counts: %j',
    async (reply) => {
      const h = harness(reply);
      await expect(
        h.transition({ row: pending(), event: begin() }),
      ).rejects.toThrow();
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates an uncertain database failure without retry', async () => {
    const error = new Error('connection lost after possible commit');
    const h = harness(error);
    await expect(h.transition({ row: pending(), event: begin() })).rejects.toBe(
      error,
    );
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('detaches expected/next before awaiting and freezes returned snapshots', async () => {
    const raw = started();
    const h = harness(result(projection(raw)));
    const row = pending();
    const event = begin();
    const promise = h.transition({ row, event });
    row.branchId = 'changed';
    event.sendToken = sourceRequestId;
    const updated = await promise;
    expect(updated).toEqual({ action: 'updated', row: started() });
    expect(Object.isFrozen(updated)).toBe(true);
    if (updated.action !== 'updated') throw new Error('not updated');
    expect(Object.isFrozen(updated.row)).toBe(true);
    expect(updated.row).not.toBe(raw);
    raw.branchId = 'driver mutation';
    expect(updated.row.branchId).toBe(' branch ');
    const [, values] = h.query.mock.calls[0] as [string, string[]];
    expect(JSON.parse(values[5])).toEqual(pending());
    expect(JSON.parse(values[6])).toEqual(started());
  });
});
