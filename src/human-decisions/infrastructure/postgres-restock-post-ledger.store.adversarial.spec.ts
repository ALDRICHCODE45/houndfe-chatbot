import type { Pool } from 'pg';
import { PostgresRestockPostLedgerStore } from './postgres-restock-post-ledger.store';

/**
 * R3b3-c3a adversarial mock spec: it proves the `beginPost` adapter trusts only
 * the ACTUAL persisted projection (never a synthesized target), fails closed on
 * a CLOSED/mismatched row, and validates the caller input as an exact two-key
 * own-data snapshot before any query.
 */
const SENDER = 'whatsapp:+5215500000001';
const OTHER = 'whatsapp:+5215500009999';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';
const DECISION = '33333333-3333-4333-8333-333333333333';

type Result = { rows: unknown[]; rowCount: number | null };
type Reply = Result | Error;
const EMPTY: Result = { rows: [], rowCount: 0 };
const ROWS = (...rows: unknown[]): Result => ({ rows, rowCount: rows.length });
const postRow = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  sender_id: SENDER,
  route: 'RESTOCK',
  request_key: SOURCE,
  status: 'ACTIVE',
  post_state: 'RESERVED',
  backend_decision_id: null,
  ...o,
});
const pick = (reply: Reply): Result => {
  if (reply instanceof Error) throw reply;
  return reply;
};

class FakeClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly reply: (sql: string) => Reply) {}
  async query(sql: string, params: unknown[] = []): Promise<Result> {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: text, params });
    return pick(this.reply(text));
  }
}

const harness = (reply: (sql: string) => Reply) => {
  const client = new FakeClient(reply);
  const pool = {
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
  } as unknown as Pool;
  return { store: new PostgresRestockPostLedgerStore(pool), client };
};
const onUpdate = (update: Reply, fallback: Reply) =>
  harness((sql) => (sql.startsWith('UPDATE') ? update : fallback));
const start = (o: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  ...o,
});

describe('PostgresRestockPostLedgerStore.beginPost adversarial', () => {
  it.each<[string, Record<string, unknown>]>([
    [
      'CLOSED + RECEIPT_RECORDED',
      postRow({
        status: 'CLOSED',
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: DECISION,
      }),
    ],
    [
      'CLOSED + POST_IN_FLIGHT',
      postRow({ status: 'CLOSED', post_state: 'POST_IN_FLIGHT' }),
    ],
    ['mismatched sender', postRow({ sender_id: OTHER })],
    ['mismatched key', postRow({ request_key: OTHER_SOURCE })],
    ['mismatched route', postRow({ route: 'LEGACY_OPS' })],
  ])(
    'fails closed on a %s persisted row without exposing an id',
    async (_n, row) => {
      const h = onUpdate(EMPTY, ROWS(row));
      const decision = await h.store.beginPost(start());
      expect(decision).toEqual({ action: 'blocked', reason: 'unknown_row' });
      expect(JSON.stringify(decision)).not.toContain(DECISION);
    },
  );

  it('validates the CAS RETURNING projection before authorizing', async () => {
    const h = harness(() =>
      ROWS(postRow({ post_state: 'POST_IN_FLIGHT', sender_id: OTHER })),
    );
    await expect(h.store.beginPost(start())).rejects.toThrow();
  });

  it('rejects a CAS projection leaking a backend id before authorizing', async () => {
    const h = harness(() =>
      ROWS(
        postRow({
          post_state: 'POST_IN_FLIGHT',
          backend_decision_id: DECISION,
        }),
      ),
    );
    await expect(h.store.beginPost(start())).rejects.toThrow();
    expect(h.client.calls).toHaveLength(1);
  });

  it('rejects an extra caller input key before the pool', async () => {
    const h = harness(() => ROWS(postRow()));
    await expect(
      h.store.beginPost(start({ extra: 1 }) as never),
    ).resolves.toEqual({ action: 'blocked', reason: 'malformed_input' });
    expect(h.client.calls).toHaveLength(0);
  });

  it('rejects an inherited caller key before the pool', async () => {
    const h = harness(() => ROWS(postRow()));
    const inherited = Object.create({
      senderId: SENDER,
      sourceRequestId: SOURCE,
    }) as object;
    await expect(h.store.beginPost(inherited as never)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(h.client.calls).toHaveLength(0);
  });

  it('rejects an accessor caller key before the pool', async () => {
    const h = harness(() => ROWS(postRow()));
    const accessor = { senderId: SENDER };
    Object.defineProperty(accessor, 'sourceRequestId', { get: () => SOURCE });
    await expect(h.store.beginPost(accessor as never)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(h.client.calls).toHaveLength(0);
  });

  it('rejects a Proxy that changes a caller field before the pool', async () => {
    const h = harness(() => ROWS(postRow()));
    const changing = new Proxy(
      { senderId: SENDER, sourceRequestId: SOURCE },
      {
        get: (target, prop) =>
          prop === 'sourceRequestId'
            ? OTHER_SOURCE
            : (Reflect.get(target, prop) as unknown),
      },
    );
    await expect(h.store.beginPost(changing as never)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(h.client.calls).toHaveLength(0);
  });
});
