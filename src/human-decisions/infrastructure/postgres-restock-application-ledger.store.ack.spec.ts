import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';

const decisionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const sourceRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const common = () => ({
  senderId: 'whatsapp:+5215500000001',
  branchId: ' branch-e\u0301 ',
  decisionId,
  sourceRequestId,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId)!,
  resolutionVersion: 2,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-25T11:00:00.000Z',
});
const terminal = (state = 'PROVIDER_ACCEPTED') => ({
  ...common(),
  state,
  ...(state === 'STALE'
    ? { staleObservedAt: common().applyBefore }
    : {
        sendToken: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
        attemptedAt: common().resolvedAt,
        providerMessageId: ' Provider-e\u0301 ',
        providerAcceptedObservedAt:
          state === 'PROVIDER_ACCEPTED_LATE'
            ? common().applyBefore
            : common().resolvedAt,
      }),
});
const receipt = (outcome = 'PROVIDER_ACCEPTED') => ({
  id: decisionId,
  version: 2,
  attemptId: common().attemptId,
  outcome,
  ackReceivedAt: '2020-01-01T00:00:00Z',
});
const projection = (row = terminal(), ack: unknown = receipt()) => ({
  decision_id: row.decisionId.toLowerCase(),
  source_request_id: row.sourceRequestId,
  attempt_id: row.attemptId,
  sender_id: row.senderId,
  branch_id: row.branchId,
  row_data: row,
  ack_receipt: ack,
});
const result = (...rows: unknown[]) => ({ rows, rowCount: rows.length });
const hold = { action: 'hold' };
function harness(...replies: unknown[]) {
  const query = jest.fn();
  for (const reply of replies) {
    if (reply instanceof Error) query.mockRejectedValueOnce(reply);
    else query.mockResolvedValueOnce(reply);
  }
  const store = new PostgresRestockApplicationLedgerStore({ query });
  const record = (row: unknown = terminal(), ack: unknown = receipt()) =>
    store.recordOutcomeAck(
      row as Parameters<typeof store.recordOutcomeAck>[0],
      ack as Parameters<typeof store.recordOutcomeAck>[1],
    );
  return { query, record };
}

describe('local reporting ACK CAS (mocked Pool, not HTTP or DB proof)', () => {
  it.each(['PROVIDER_ACCEPTED', 'PROVIDER_ACCEPTED_LATE', 'STALE'])(
    'records and replays the complete %s record',
    async (state) => {
      const row = terminal(state);
      const ack = receipt(state);
      const h = harness(
        result(projection(row, ack)),
        result(),
        result(projection(row, ack)),
      );
      expect(await h.record(row, ack)).toEqual({
        action: 'recorded',
        record: { row, receipt: ack },
      });
      expect(await h.record(row, ack)).toEqual({
        action: 'replay',
        record: { row, receipt: ack },
      });
      expect(h.query).toHaveBeenCalledTimes(3);
      const [sql, values] = h.query.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ').trim()).toBe(
        'UPDATE restock_application_ledger SET ack_receipt = $7::jsonb ' +
          'WHERE decision_id = $1::uuid AND source_request_id = $2::uuid ' +
          'AND attempt_id = $3::uuid AND sender_id = $4 AND branch_id = $5 ' +
          'AND row_data = $6::jsonb AND ack_receipt IS NULL ' +
          'RETURNING decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data, ack_receipt',
      );
      expect(values).toEqual([
        row.decisionId,
        row.sourceRequestId,
        row.attemptId,
        row.senderId,
        row.branchId,
        JSON.stringify(row),
        JSON.stringify(ack),
      ]);
      expect(h.query.mock.calls[2]).toEqual([
        expect.stringMatching(/^SELECT /),
        [decisionId],
      ]);
    },
  );

  it.each([
    { ...common(), state: 'PENDING_DELIVERY' },
    {
      ...common(),
      state: 'SEND_STARTED',
      sendToken: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
      attemptedAt: common().resolvedAt,
    },
    { ...terminal(), state: 'DELIVERY_UNKNOWN' },
    { ...terminal(), attemptId: decisionId },
    { ...terminal(), applyBefore: common().resolvedAt },
    { ...terminal(), extra: true },
  ])('holds invalid/nonterminal row before querying: %j', async (row) => {
    const h = harness();
    expect(await h.record(row)).toEqual(hold);
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([
    { id: sourceRequestId },
    { attemptId: decisionId },
    { version: 3 },
    { outcome: 'STALE' },
    { outcome: 'DELIVERY_UNKNOWN' },
    { ackReceivedAt: 'invalid' },
    { extra: true },
    { id: undefined },
  ])('holds invalid receipt before querying: %j', async (patch) => {
    const h = harness();
    expect(await h.record(terminal(), { ...receipt(), ...patch })).toEqual(
      hold,
    );
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each([
    { ack_receipt: null },
    {
      ack_receipt: { ...receipt(), ackReceivedAt: '2020-01-01T00:00:00.000Z' },
    },
    { ack_receipt: { ...receipt(), id: decisionId.toLowerCase() } },
    { ack_receipt: { ...receipt(), outcome: 'STALE' } },
    { decision_id: sourceRequestId },
    { source_request_id: decisionId },
    { attempt_id: decisionId },
    { sender_id: 'other' },
    { branch_id: 'other' },
    { row_data: { ...terminal(), branchId: 'other' }, branch_id: 'other' },
    { row_data: { ...terminal(), providerMessageId: 'different' } },
    { row_data: { ...terminal(), sendToken: sourceRequestId } },
    { row_data: { ...terminal(), decisionId: decisionId.toLowerCase() } },
  ])(
    'holds contradictory projection on write and replay: %j',
    async (patch) => {
      for (const replay of [false, true]) {
        const response = result({ ...projection(), ...patch });
        const h = harness(...(replay ? [result(), response] : [response]));
        expect(await h.record()).toEqual(hold);
        expect(h.query).toHaveBeenCalledTimes(replay ? 2 : 1);
      }
    },
  );

  it.each([result(), result(projection(terminal(), null))])(
    'holds missing row or empty ACK after CAS loss',
    async (read) => {
      const h = harness(result(), read);
      expect(await h.record()).toEqual(hold);
      expect(h.query).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    null,
    { rows: [], rowCount: 1 },
    result(projection(), projection()),
    result(null),
  ])(
    'throws malformed cardinality/projection without recovery: %j',
    async (reply) => {
      const h = harness(reply);
      await expect(h.record()).rejects.toThrow(/ledger/);
      expect(h.query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'propagates DB errors without retry, read=%s',
    async (read) => {
      const error = new Error('may have committed');
      const h = harness(...(read ? [result(), error] : [error]));
      await expect(h.record()).rejects.toBe(error);
      expect(h.query).toHaveBeenCalledTimes(read ? 2 : 1);
    },
  );

  it('detaches validated input before awaiting and freezes the returned nested record', async () => {
    const row = terminal();
    const ack = receipt();
    const stored = projection();
    const expected = { row: terminal(), receipt: receipt() };
    const h = harness(result(stored));
    const pending = h.record(row, ack);
    row.branchId = 'mutated';
    ack.ackReceivedAt = '2030-01-01T00:00:00Z';
    const response = await pending;
    expect(response).toEqual({ action: 'recorded', record: expected });
    const [, parameters] = h.query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([
      decisionId,
      sourceRequestId,
      expected.row.attemptId,
      expected.row.senderId,
      expected.row.branchId,
      JSON.stringify(expected.row),
      JSON.stringify(expected.receipt),
    ]);
    stored.row_data.branchId = 'changed after decode';
    (stored.ack_receipt as ReturnType<typeof receipt>).ackReceivedAt =
      'changed';
    expect(response).toEqual({ action: 'recorded', record: expected });
    if (response.action === 'hold') throw new Error('expected record');
    for (const value of [
      response,
      response.record,
      response.record.row,
      response.record.receipt,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
});
