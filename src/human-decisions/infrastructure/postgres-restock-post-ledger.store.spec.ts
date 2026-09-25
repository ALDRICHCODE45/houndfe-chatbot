import type { Pool } from 'pg';
import { PostgresRestockPostLedgerStore } from './postgres-restock-post-ledger.store';

/**
 * R3b3-c3a mock spec for the `beginPost` CAS adapter. It drives the real store
 * with a scripted Pool double so the issued SQL, bound params, rowCount
 * validation and fail-closed fallback are asserted without any database.
 */
const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const DECISION = '33333333-3333-4333-8333-333333333333';

type Result = { rows: unknown[]; rowCount: number | null };
type Reply = Result | Error;
const EMPTY: Result = { rows: [], rowCount: 0 };
const ROWS = (...rows: unknown[]): Result => ({ rows, rowCount: rows.length });
/** The ACTUAL persisted projection; the adapter must trust these fields. */
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

const start = (o: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  ...o,
});
const onUpdate = (update: Reply, fallback: Reply) =>
  harness((sql) => (sql.startsWith('UPDATE') ? update : fallback));

describe('PostgresRestockPostLedgerStore.beginPost', () => {
  it('authorizes on a one-row CAS and binds the exact fence', async () => {
    const h = harness(() => ROWS(postRow({ post_state: 'POST_IN_FLIGHT' })));
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'authorize_post',
    });
    expect(h.client.calls).toHaveLength(1);
    const [call] = h.client.calls;
    expect(call.sql).toContain('UPDATE human_decision_reservations');
    expect(call.sql).toContain("post_state = 'POST_IN_FLIGHT'");
    expect(call.sql).toContain("route = 'RESTOCK'");
    expect(call.sql).toContain("status = 'ACTIVE'");
    expect(call.sql).toContain("post_state = 'RESERVED'");
    expect(call.sql).toContain('backend_decision_id IS NULL');
    expect(call.sql).toContain('post_attempted_at = now()');
    expect(call.sql).toContain('RETURNING sender_id');
    expect(call.params).toEqual([SENDER, SOURCE]);
  });

  it('holds on a zero-row update that reads POST_IN_FLIGHT', async () => {
    const h = onUpdate(EMPTY, ROWS(postRow({ post_state: 'POST_IN_FLIGHT' })));
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'hold',
      reason: 'post_in_flight',
    });
    expect(h.client.calls).toHaveLength(2);
    expect(h.client.calls[1].params).toEqual([SENDER, SOURCE]);
    expect(h.client.calls[1].sql).toContain('status');
  });

  it('returns the historical receipt id on a zero-row update', async () => {
    const recorded = postRow({
      post_state: 'RECEIPT_RECORDED',
      backend_decision_id: DECISION,
    });
    const h = onUpdate(EMPTY, ROWS(recorded));
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'historical_receipt',
      backendDecisionId: DECISION,
    });
  });

  it('never authorizes on a zero-row update that still reads RESERVED', async () => {
    const h = onUpdate(EMPTY, ROWS(postRow({ post_state: 'RESERVED' })));
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'blocked',
      reason: 'unknown_state',
    });
  });

  it('holds on a zero-row update that reads UNKNOWN', async () => {
    const h = onUpdate(EMPTY, ROWS(postRow({ post_state: 'UNKNOWN' })));
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'hold',
      reason: 'unknown_state',
    });
  });

  it('fails closed when the exact RESTOCK row is absent', async () => {
    const h = onUpdate(EMPTY, EMPTY);
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'blocked',
      reason: 'missing_row',
    });
  });

  it('fails closed on a malformed stored post_state', async () => {
    const h = onUpdate(EMPTY, ROWS(postRow({ post_state: 'BOGUS' })));
    await expect(h.store.beginPost(start())).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_row',
    });
  });

  it('exposes no backend id on a hold result', async () => {
    const h = onUpdate(EMPTY, ROWS(postRow({ post_state: 'POST_IN_FLIGHT' })));
    const decision = await h.store.beginPost(start());
    expect(decision).toEqual({ action: 'hold', reason: 'post_in_flight' });
  });

  it.each([
    ['a blank sender', start({ senderId: ' ' })],
    ['a non-UUID key', start({ sourceRequestId: 'nope' })],
    ['a missing key', { senderId: SENDER }],
    ['a null input', null],
  ])('fails closed on %s before the pool', async (_n, input) => {
    const h = harness(() => ROWS(postRow({ post_state: 'POST_IN_FLIGHT' })));
    await expect(h.store.beginPost(input as never)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(h.client.calls).toHaveLength(0);
  });

  it('fails closed on a hostile input getter before the pool', async () => {
    const h = harness(() => ROWS(postRow({ post_state: 'POST_IN_FLIGHT' })));
    const hostile = Object.defineProperty({}, 'senderId', {
      get() {
        throw new Error('hostile');
      },
    });
    await expect(h.store.beginPost(hostile as never)).resolves.toEqual({
      action: 'blocked',
      reason: 'malformed_input',
    });
    expect(h.client.calls).toHaveLength(0);
  });

  it('throws on an inconsistent CAS result', async () => {
    const h = harness(() => ({ rows: [], rowCount: 1 }));
    await expect(h.store.beginPost(start())).rejects.toThrow();
  });

  it('throws when the CAS returns an unexpected state', async () => {
    const h = harness(() => ROWS(postRow({ post_state: 'RESERVED' })));
    await expect(h.store.beginPost(start())).rejects.toThrow();
  });

  it('propagates a CAS query error without retry', async () => {
    const h = harness(() => new Error('db down'));
    await expect(h.store.beginPost(start())).rejects.toThrow('db down');
    expect(h.client.calls).toHaveLength(1);
  });

  it('propagates a fallback read error without retry', async () => {
    const h = onUpdate(EMPTY, new Error('read failed'));
    await expect(h.store.beginPost(start())).rejects.toThrow('read failed');
    expect(h.client.calls).toHaveLength(2);
  });
});
