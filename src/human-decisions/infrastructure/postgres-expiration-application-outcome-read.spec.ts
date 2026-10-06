import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationLedgerStore as Store } from './postgres-expiration-application-ledger.store';

const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const source = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const pending = {
  state: 'PENDING_DELIVERY',
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId: source,
  decisionId: id,
  resolutionVersion: 2,
  attemptId: deriveExpirationAttemptId(source, id)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-26T10:00:00.000Z',
};
const started = {
  ...pending,
  state: 'SEND_STARTED',
  sendToken: id,
  attemptedAt: pending.resolvedAt,
};
const states = [
  'PROVIDER_ACCEPTED',
  'PROVIDER_ACCEPTED_LATE',
  'STALE',
] as const;
type Terminal = (typeof states)[number];
const terminal = (state: Terminal) =>
  state === 'STALE'
    ? { ...pending, state, staleObservedAt: pending.applyBefore }
    : {
        ...started,
        state,
        providerMessageId: ' opaque ',
        providerAcceptedObservedAt:
          state === 'PROVIDER_ACCEPTED'
            ? pending.resolvedAt
            : pending.applyBefore,
      };
const ack = (state: Terminal) => ({
  id,
  version: 2,
  attemptId: pending.attemptId,
  outcome: state,
  ackReceivedAt: '2026-09-26T04:01:00-06:00',
});
const projection = (
  state: Terminal = 'PROVIDER_ACCEPTED',
  receipt: unknown = ack(state),
): Record<string, unknown> => ({
  decision_id: id,
  source_request_id: source,
  attempt_id: pending.attemptId,
  sender_id: pending.senderId,
  branch_id: pending.branchId,
  row_data: terminal(state),
  ack_receipt: receipt,
  ack_absent: receipt === null,
});
function harness(raw = projection()) {
  const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [raw] });
  return { query, raw, store: new Store({ query }) };
}
const hold = { action: 'hold' };

describe('inactive EXPIRATION outcome/ACK read', () => {
  it.each(
    states.flatMap((state) =>
      [true, false].map((absent) => ({ state, absent })),
    ),
  )(
    'reads $state with SQL-null ACK=$absent in one SELECT, without mutating data',
    async ({ state, absent }) => {
      const receipt = absent ? null : ack(state);
      const h = harness(projection(state, receipt));
      const before = structuredClone(h.raw);
      const result = await h.store.readOutcomeByDecision(id);
      expect(result).toEqual({
        action: 'foundOutcome',
        row: terminal(state),
        receipt,
      });
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(h.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /^SELECT .*ack_receipt.*ack_receipt IS NULL.*ack_absent.*WHERE decision_id = \$1$/,
        ),
        [id],
      );
      expect(h.raw).toEqual(before);
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'foundOutcome') throw new Error('Outcome required');
      expect(Object.isFrozen(result.row)).toBe(true);
      expect(result.row).not.toBe(h.raw.row_data);
      if (result.receipt) {
        expect(Object.isFrozen(result.receipt)).toBe(true);
        expect(result.receipt).not.toBe(receipt);
        expect(result.receipt.ackReceivedAt).toBe('2026-09-26T04:01:00-06:00');
      }
      (h.raw.row_data as Record<string, unknown>).branchId = 'changed';
      if (receipt) receipt.ackReceivedAt = 'changed';
      expect(result.row).toEqual(terminal(state));
      expect(result.receipt).toEqual(absent ? null : ack(state));
    },
  );
  it.each(['', id.toUpperCase(), ` ${id}`, 'invalid', null, 42])(
    'rejects invalid requested identity %# before SQL',
    async (value) => {
      const h = harness();
      expect(await h.store.readOutcomeByDecision(value as string)).toEqual(
        hold,
      );
      expect(h.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    'decision_id',
    'source_request_id',
    'attempt_id',
    'sender_id',
    'branch_id',
  ])('holds divergent column %s, never missing', async (key) => {
    const h = harness();
    h.raw[key] = key === 'branch_id' ? 'branch' : id.toUpperCase();
    const before = structuredClone(h.raw);
    expect(await h.store.readOutcomeByDecision(id)).toEqual(hold);
    expect(h.raw).toEqual(before);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('binds the requested id even when stored columns and JSON agree on another id', async () => {
    const h = harness();
    h.raw.decision_id = source;
    h.raw.attempt_id = deriveExpirationAttemptId(source, source);
    h.raw.row_data = {
      ...terminal('STALE'),
      decisionId: source,
      attemptId: h.raw.attempt_id,
    };
    h.raw.ack_receipt = null;
    h.raw.ack_absent = true;
    expect(await h.store.readOutcomeByDecision(id)).toEqual(hold);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each([
    pending,
    started,
    { ...pending, state: 'DELIVERY_UNKNOWN' },
    { ...terminal('STALE'), staleObservedAt: pending.resolvedAt },
    { ...terminal('PROVIDER_ACCEPTED'), extra: true },
  ])('holds nonterminal or corrupt row %#', async (row) => {
    const h = harness(projection('STALE', null));
    h.raw.row_data = row;
    const before = structuredClone(h.raw);
    expect(await h.store.readOutcomeByDecision(id)).toEqual(hold);
    expect(h.raw).toEqual(before);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['id', id.toUpperCase()],
    ['attemptId', pending.attemptId.toUpperCase()],
    ['version', 1],
    ['outcome', 'STALE'],
    ['ackReceivedAt', 'invalid'],
    ['extra', true],
  ])('holds corrupt or divergent ACK %s', async (key, value) => {
    const h = harness(
      projection('PROVIDER_ACCEPTED', {
        ...ack('PROVIDER_ACCEPTED'),
        [key]: value,
      }),
    );
    const before = structuredClone(h.raw);
    expect(await h.store.readOutcomeByDecision(id)).toEqual(hold);
    expect(h.raw).toEqual(before);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ack_absent: false, ack_receipt: null }, // JSON null is not SQL NULL.
    { ack_absent: true, ack_receipt: ack('PROVIDER_ACCEPTED') },
    { ack_absent: true, ack_receipt: undefined },
    { ack_absent: undefined, ack_receipt: null },
    { ack_absent: 'true', ack_receipt: null },
    { ack_absent: false, ack_receipt: {} },
  ])('rejects missing or contradictory ACK projection %#', async (fields) => {
    const h = harness({ ...projection(), ...fields });
    const before = structuredClone(h.raw);
    expect(await h.store.readOutcomeByDecision(id)).toEqual(hold);
    expect(h.raw).toEqual(before);
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('returns missing only for a consistent zero-row result and propagates SQL failure without retry', async () => {
    const h = harness();
    h.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await h.store.readOutcomeByDecision(id)).toEqual({
      action: 'missing',
    });
    const error = new Error('database failure');
    h.query.mockRejectedValueOnce(error);
    await expect(h.store.readOutcomeByDecision(id)).rejects.toBe(error);
    expect(h.query).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    { rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 2, rows: [projection(), projection()] },
    { rowCount: 1, rows: [null] },
  ])('propagates malformed driver result %# without retry', async (result) => {
    const h = harness();
    h.query.mockResolvedValue(result);
    await expect(h.store.readOutcomeByDecision(id)).rejects.toThrow();
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy pending-only reads and their SQL unchanged', async () => {
    const h = harness();
    for (const state of states) {
      h.query.mockResolvedValueOnce({ rowCount: 1, rows: [projection(state)] });
      expect(await h.store.readByDecision(id)).toEqual(hold);
    }
    h.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...projection(), row_data: pending }],
    });
    expect(await h.store.readByDecision(id)).toEqual({
      action: 'foundPending',
      row: pending,
    });
    for (const [sql] of h.query.mock.calls as [string][]) {
      expect(sql).not.toContain('ack_receipt');
      expect(sql).not.toContain('FOR UPDATE');
    }
    expect(h.query).toHaveBeenCalledTimes(4);
  });
});
