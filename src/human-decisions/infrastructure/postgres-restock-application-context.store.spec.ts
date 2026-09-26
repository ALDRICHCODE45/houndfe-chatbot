import type { Pool } from 'pg';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';

const source = 'abcdefab-1234-5678-9abc-abcdefabcdef';
const backend = 'fedcbafe-1234-5678-9abc-abcdefabcdef';
const instant = '2026-06-01T10:00:00.000Z';
const intake = () => ({
  sourceRequestId: source,
  type: 'RESTOCK',
  productId: backend,
  productName: 'Café',
  variantId: null,
  sku: null,
  requestedQuantity: null,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
});
const row = (): Record<string, unknown> => ({
  sender_id: 'sender',
  route: 'RESTOCK',
  request_key: source,
  status: 'ACTIVE',
  intake: intake(),
  post_state: 'RECEIPT_RECORDED',
  backend_decision_id: backend,
  post_attempted_at: new Date(instant),
  receipt_recorded_at: new Date(instant),
  unknown_observed_at: null,
});
function setup(rows: unknown[] = [row()], rowCount: unknown = rows.length) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount });
  const store = new PostgresRestockApplicationContextStore({
    query,
  } as Pick<Pool, 'query'>);
  return {
    query,
    read: (...args: [] | [string]) =>
      store.readRecordedForSender(args.length ? args[0] : 'sender'),
  };
}

describe('durable RESTOCK application context read', () => {
  it('returns a detached frozen snapshot through one exact SELECT only', async () => {
    const persisted = row();
    const { query, read } = setup([persisted]);
    const result = await read();
    expect(result).toEqual({
      action: 'recorded',
      context: {
        reservation: {
          status: 'ACTIVE',
          route: 'RESTOCK',
          senderId: 'sender',
          requestKey: source,
          intake: intake(),
        },
        backendDecisionId: backend,
        postAttemptedAt: instant,
        receiptRecordedAt: instant,
      },
    });
    expect(query.mock.calls).toEqual([
      [
        "SELECT sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE'",
        ['sender'],
      ],
    ]);
    if (result.action !== 'recorded') throw new Error('expected context');
    const { context } = result;
    for (const value of [
      context,
      context.reservation,
      context.reservation.intake,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    (persisted.intake as Record<string, unknown>).productName = 'changed';
    (persisted.post_attempted_at as Date).setTime(0);
    persisted.backend_decision_id = source;
    expect(Reflect.set(context.reservation.intake, 'sku', 'changed')).toBe(
      false,
    );
    expect(context.reservation.intake).toEqual(intake());
    expect(context.postAttemptedAt).toBe(instant);
    expect(context.backendDecisionId).toBe(backend);
  });

  it('returns missing only for consistent zero rows', async () => {
    await expect(setup([]).read()).resolves.toEqual({ action: 'missing' });
  });
  it('preserves identical uppercase TEXT keys and backend UUID bytes', async () => {
    const value = row();
    value.request_key = source.toUpperCase();
    value.intake = { ...intake(), sourceRequestId: source.toUpperCase() };
    value.backend_decision_id = backend.toUpperCase();
    await expect(setup([value]).read()).resolves.toMatchObject({
      action: 'recorded',
      context: {
        backendDecisionId: backend.toUpperCase(),
        reservation: { requestKey: source.toUpperCase(), intake: value.intake },
      },
    });
  });
  it.each([
    ['route', 'LEGACY_OPS'],
    ['status', 'CLOSED'],
    ...['RESERVED', 'POST_IN_FLIGHT', 'UNKNOWN', null, undefined, 1].map(
      (v) => ['post_state', v],
    ),
    ['sender_id', 'other'],
    ['request_key', backend],
    ['request_key', source.toUpperCase()],
    ['request_key', 1],
    ['backend_decision_id', 'invalid'],
    ['backend_decision_id', null],
    ['unknown_observed_at', instant],
    ['unknown_observed_at', undefined],
    ['intake', null],
  ])('holds corrupt column %s = %s', async (key, value) => {
    await expect(
      setup([{ ...row(), [key as string]: value }]).read(),
    ).resolves.toEqual({ action: 'hold' });
  });
  it.each(Object.keys(row()))(
    'holds missing required column %s',
    async (key) => {
      const value = row();
      delete value[key];
      await expect(setup([value]).read()).resolves.toEqual({ action: 'hold' });
    },
  );
  it.each([
    { productId: 'invalid' },
    { supersedesDecisionId: 'invalid' },
    { sourceRequestId: backend },
    { productName: ' Café ' },
    { productName: 'Cafe\u0301' },
    { productName: 'bad\u0000' },
    { sku: ' SKU ' },
    { sku: '' },
    { requestedQuantity: undefined },
    { requestedQuantity: 0 },
    { observedStockAtRequest: -0, stockObservedAt: instant },
    { observedStockAtRequest: 1, stockObservedAt: '2026-06-01T10:00:00Z' },
    { extra: null },
    { branchId: backend },
  ])('rejects noncanonical intake %j', async (patch) => {
    // -0 is already canonical and must retain Object.is semantics.
    const value = { ...row(), intake: { ...intake(), ...patch } };
    const expected = Object.is(patch.observedStockAtRequest, -0)
      ? 'recorded'
      : 'hold';
    await expect(setup([value]).read()).resolves.toMatchObject({
      action: expected,
    });
  });
  it.each(Object.keys(intake()))(
    'does not repair missing intake key %s',
    async (key) => {
      const payload: Record<string, unknown> = intake();
      delete payload[key];
      await expect(
        setup([{ ...row(), intake: payload }]).read(),
      ).resolves.toEqual({ action: 'hold' });
    },
  );
  it('rejects accessors without invoking them, symbols and nonplain intakes', async () => {
    const getter = jest.fn(() => 'Café');
    const accessor = Object.defineProperty(intake(), 'productName', {
      get: getter,
    });
    for (const payload of [
      accessor,
      { ...intake(), [Symbol('extra')]: 1 },
      Object.assign(Object.create({}) as object, intake()),
    ]) {
      await expect(
        setup([{ ...row(), intake: payload }]).read(),
      ).resolves.toEqual({ action: 'hold' });
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['post_attempted_at', 'receipt_recorded_at'])(
    'validates timestamp %s',
    async (key) => {
      for (const invalid of [
        null,
        undefined,
        new Date(NaN),
        Infinity,
        0,
        '',
        'yesterday',
        '2026-02-30T10:00:00Z',
      ]) {
        await expect(
          setup([{ ...row(), [key]: invalid }]).read(),
        ).resolves.toEqual({ action: 'hold' });
      }
      await expect(
        setup([{ ...row(), [key]: '2026-06-01T12:00:00+02:00' }]).read(),
      ).resolves.toMatchObject({
        action: 'recorded',
        context: { postAttemptedAt: instant, receiptRecordedAt: instant },
      });
    },
  );
  it.each([
    null,
    undefined,
    '',
    ' ',
    ' sender',
    'sender ',
    'sen\u0000der',
    'sen\u0085der',
    3,
  ])('rejects sender %j before querying', async (sender) => {
    const { read, query } = setup();
    await expect(read(sender as string)).resolves.toEqual({ action: 'hold' });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    [[], 1],
    [[row()], 0],
    [[row(), row()], 2],
    [[], null],
    [[], -1],
    [[], 0.5],
    [[], '0'],
    [[null], 1],
    [null, 0],
  ])('throws on inconsistent driver result %#', async (rows, count) => {
    await expect(setup(rows as unknown[], count).read()).rejects.toThrow(
      'inconsistent',
    );
  });
  it('propagates a DB failure without retry or other effects', async () => {
    const { query, read } = setup();
    const failure = new Error('database unavailable');
    query.mockRejectedValue(failure);
    await expect(read()).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
