import type { Pool } from 'pg';
import { PostgresRestockPostLedgerStore } from './postgres-restock-post-ledger.store';

/**
 * R3b3-c3b1 mock spec for the `recordReceipt` CAS transition. It drives the real
 * store with a scripted Pool double and asserts the issued SQL, bound params,
 * actual-projection validation, zero-row fail-closed paths and no-retry error
 * propagation without any database. `markUnknown` lives in the adversarial spec.
 */
const SENDER = 'whatsapp:+5215500000001';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const DECISION = '33333333-3333-4333-8333-333333333333';
const OTHER_DECISION = '44444444-4444-4444-8444-444444444444';

type Result = { rows: unknown[]; rowCount: number | null };
type Reply = Result | Error;
const EMPTY: Result = { rows: [], rowCount: 0 };
const ROWS = (...rows: unknown[]): Result => ({ rows, rowCount: rows.length });
/** The ACTUAL persisted projection; every field must be trusted, not invented. */
const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  sender_id: SENDER,
  route: 'RESTOCK',
  request_key: SOURCE,
  status: 'ACTIVE',
  post_state: 'POST_IN_FLIGHT',
  backend_decision_id: null,
  post_attempted_at: new Date('2026-06-23T12:00:00.000Z'),
  receipt_recorded_at: new Date('2026-06-23T12:00:00.000Z'),
  unknown_observed_at: new Date('2026-06-23T12:00:00.000Z'),
  ...o,
});
const receipt = (o: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  backendDecisionId: DECISION,
  ...o,
});
const successRow = (o: Record<string, unknown> = {}) =>
  row({
    post_state: 'RECEIPT_RECORDED',
    backend_decision_id: DECISION,
    ...o,
  });

class FakeClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  constructor(private readonly reply: (sql: string) => Reply) {}
  async query(sql: string, params: unknown[] = []): Promise<Result> {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: text, params });
    const response = this.reply(text);
    if (response instanceof Error) throw response;
    return response;
  }
}
const harness = (reply: (sql: string) => Reply) => {
  const client = new FakeClient(reply);
  const pool = {
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
  } as unknown as Pool;
  return { store: new PostgresRestockPostLedgerStore(pool), client };
};
const afterUpdate = (fallback: Record<string, unknown>) =>
  harness((sql) => (sql.startsWith('UPDATE') ? EMPTY : ROWS(row(fallback))));

describe('PostgresRestockPostLedgerStore.recordReceipt', () => {
  it('records on a one-row CAS with the exact fence and id', async () => {
    const h = harness(() => ROWS(successRow()));
    await expect(h.store.recordReceipt(receipt())).resolves.toEqual({
      action: 'record_receipt',
      backendDecisionId: DECISION,
    });
    const [call] = h.client.calls;
    expect(call.sql).toContain("post_state = 'RECEIPT_RECORDED'");
    expect(call.sql).toContain("post_state = 'POST_IN_FLIGHT'");
    expect(call.sql).toContain('post_attempted_at IS NOT NULL');
    expect(call.sql).toContain('RETURNING sender_id');
    expect(call.params).toEqual([SENDER, SOURCE, DECISION]);
  });

  it.each([
    ['a null receipt timestamp', { receipt_recorded_at: null }],
    ['a string attempt timestamp', { post_attempted_at: 'not-a-date' }],
    ['an invalid attempt Date', { post_attempted_at: new Date('nope') }],
  ])('throws on %s', async (_n, o) => {
    const h = harness(() => ROWS(successRow(o)));
    await expect(h.store.recordReceipt(receipt())).rejects.toThrow();
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    [
      'replays the same id',
      { post_state: 'RECEIPT_RECORDED', backend_decision_id: DECISION },
      { action: 'replay_receipt', backendDecisionId: DECISION },
    ],
    [
      'conflicts on a different id',
      { post_state: 'RECEIPT_RECORDED', backend_decision_id: OTHER_DECISION },
      { action: 'conflict', storedBackendDecisionId: OTHER_DECISION },
    ],
    [
      'blocks an UNKNOWN row',
      { post_state: 'UNKNOWN' },
      { action: 'blocked', reason: 'unknown_state' },
    ],
    [
      'blocks a RESERVED row',
      { post_state: 'RESERVED' },
      { action: 'blocked', reason: 'not_in_flight' },
    ],
    [
      'never records a still-POST_IN_FLIGHT row',
      {},
      { action: 'blocked', reason: 'unknown_state' },
    ],
    [
      'blocks a CLOSED row',
      { status: 'CLOSED', post_state: 'RECEIPT_RECORDED' },
      { action: 'blocked', reason: 'unknown_row' },
    ],
  ])('on a zero-row update %s', async (_n, outcome, expected) => {
    const h = afterUpdate(outcome);
    await expect(h.store.recordReceipt(receipt())).resolves.toEqual(expected);
  });

  it('fails closed on malformed or extra input before the pool', async () => {
    const h = harness(() => ROWS(row()));
    await expect(
      h.store.recordReceipt(receipt({ backendDecisionId: 'nope' }) as never),
    ).resolves.toEqual({ action: 'blocked', reason: 'malformed_input' });
    await expect(
      h.store.recordReceipt(receipt({ extra: 1 }) as never),
    ).resolves.toEqual({ action: 'blocked', reason: 'malformed_input' });
    expect(h.client.calls).toHaveLength(0);
  });

  it('propagates a query error without retry', async () => {
    const h = harness(() => new Error('db down'));
    await expect(h.store.recordReceipt(receipt())).rejects.toThrow('db down');
    expect(h.client.calls).toHaveLength(1);
  });
});
