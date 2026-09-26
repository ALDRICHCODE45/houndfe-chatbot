import type { PoolClient } from 'pg';
import { PostgresRestockClaimCollisionsStore } from './postgres-restock-claim-collisions.store';

const SENDER = 'whatsapp:+5215500000001';
const LOCK =
  'SELECT sender_id, data FROM conversation_state WHERE sender_id=$1 FOR UPDATE';
const MARKERS =
  "SELECT (SELECT count(*)::int FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE') AS active_count, (SELECT route FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE' LIMIT 1) AS active_route, EXISTS (SELECT 1 FROM human_handoff_requests WHERE customer_id = $1 AND status = 'pending') AS legacy_pending";
type Reply = { rows: unknown[]; rowCount: number | null };
const conversation = (data: unknown = {}): Reply => ({
  rows: [{ sender_id: SENDER, data }],
  rowCount: 1,
});
const markers = (overrides: Record<string, unknown> = {}): Reply => ({
  rows: [
    {
      active_count: 1,
      active_route: 'RESTOCK',
      legacy_pending: false,
      ...overrides,
    },
  ],
  rowCount: 1,
});

// Real marker reader on the same client; no DB or concurrency claim.
function harness(first: Reply | Error, second: Reply | Error = markers()) {
  const query = jest.fn().mockImplementation(() => {
    const reply = query.mock.calls.length === 1 ? first : second;
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  });
  const client = { query } as unknown as Pick<PoolClient, 'query'>;
  return { query, store: new PostgresRestockClaimCollisionsStore(client) };
}

function expectQueries(query: jest.Mock, count: number) {
  expect(query.mock.calls.map((call: unknown[]) => call[1])).toEqual(
    Array.from({ length: count }, () => [SENDER]),
  );
  expect(
    query.mock.calls.map(([sql]: [string]) => sql.replace(/\s+/g, ' ').trim()),
  ).toEqual([LOCK, MARKERS].slice(0, count));
  // Exact whitelist excludes BEGIN/COMMIT, writes, retries and extra reads.
}

describe('retained-transaction RESTOCK collision snapshot (not send ownership)', () => {
  it.each([
    {},
    { messages: [] },
    { messages: [{ role: 'user', content: 'catalog query' }] },
    { pendingHumanRequest: null },
    { messages: [], pendingHumanRequest: null },
  ])(
    'clears admitted conversation data with own RESTOCK and no legacy: %j',
    async (data) => {
      const h = harness(conversation(data));
      const result = await h.store.readForSender(SENDER);
      expect(result).toEqual({ action: 'clear' });
      expect(Object.isFrozen(result)).toBe(true);
      expectQueries(h.query, 2);
    },
  );

  it.each([
    ['missing', { rows: [], rowCount: 0 }],
    ['wrong sender', { rows: [{ sender_id: 'other', data: {} }], rowCount: 1 }],
    ['inconsistent count', { ...conversation(), rowCount: 0 }],
    ['null count', { ...conversation(), rowCount: null }],
    [
      'multiple rows',
      { rows: [...conversation().rows, ...conversation().rows], rowCount: 2 },
    ],
    [
      'hidden extra row',
      { rows: [...conversation().rows, ...conversation().rows], rowCount: 1 },
    ],
    ['null row', { rows: [null], rowCount: 1 }],
  ])('holds %s without a marker query', async (_name, reply) => {
    const h = harness(reply);
    const result = await h.store.readForSender(SENDER);
    expect(result).toEqual({ action: 'hold' });
    expect(Object.isFrozen(result)).toBe(true);
    expectQueries(h.query, 1);
  });

  it.each([
    null,
    [],
    'data',
    { unknown: null },
    { messages: null },
    { messages: {} },
    { messages: undefined },
    { pendingHumanRequest: undefined },
    { pendingHumanRequest: {} },
    {
      pendingHumanRequest: {
        requestId: 'request',
        ref: 'ref',
        createdAt: 'date',
        customerNotifiedAt: 'date',
      },
    },
    { receiptAmountPointer: null },
    {
      receiptAmountPointer: {
        receiptMediaId: 'media',
        saleId: 'sale',
        receiptVersion: '1',
      },
    },
    Object.create({ inherited: true }) as unknown,
  ])('holds non-admitted data without reading markers: %j', async (data) => {
    const h = harness(conversation(data));
    await expect(h.store.readForSender(SENDER)).resolves.toEqual({
      action: 'hold',
    });
    expectQueries(h.query, 1);
  });

  it.each([
    markers({ legacy_pending: true }),
    markers({ active_count: 0, active_route: null }),
    markers({ active_route: 'LEGACY_OPS' }),
    markers({ active_route: 'OTHER' }),
    markers({ active_route: null }),
    markers({ active_count: 0 }),
    markers({ active_count: 2 }),
    markers({ legacy_pending: 'false' }),
    { rows: [], rowCount: 0 },
    { ...markers(), rowCount: null },
    { rows: [...markers().rows, ...markers().rows], rowCount: 2 },
  ])(
    'holds legacy, absent RESTOCK or unknown durable context: %j',
    async (reply) => {
      const h = harness(conversation(), reply);
      await expect(h.store.readForSender(SENDER)).resolves.toEqual({
        action: 'hold',
      });
      expectQueries(h.query, 2);
    },
  );

  it.each([1, 2])(
    'holds query failure at read %s without retry',
    async (position) => {
      const error = new Error('read failed');
      const h = harness(position === 1 ? error : conversation(), error);
      await expect(h.store.readForSender(SENDER)).resolves.toEqual({
        action: 'hold',
      });
      expectQueries(h.query, position);
    },
  );

  it.each(['', '   ', ' x', 'x ', null, undefined, 42])(
    'rejects invalid sender %j without queries',
    async (sender) => {
      const h = harness(conversation());
      await expect(h.store.readForSender(sender as string)).resolves.toEqual({
        action: 'hold',
      });
      expect(h.query).not.toHaveBeenCalled();
    },
  );
});
