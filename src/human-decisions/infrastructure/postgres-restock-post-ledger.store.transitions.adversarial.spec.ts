import type { Pool } from 'pg';
import { PostgresRestockPostLedgerStore } from './postgres-restock-post-ledger.store';

/**
 * R3b3-c3b2 mock spec for the `markUnknown` CAS transition. It drives the real
 * store with a scripted Pool double and asserts the issued SQL, bound params,
 * actual-projection validation, the `pre_post`/`ambiguous_post` distinction from
 * persisted state, zero-row fail-closed paths and no-retry error propagation.
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
  post_state: 'RESERVED',
  backend_decision_id: null,
  post_attempted_at: null,
  receipt_recorded_at: null,
  unknown_observed_at: new Date('2026-06-23T12:00:00.000Z'),
  ...o,
});
const unknown = (o: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  ...o,
});
const receipt = (o: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  sourceRequestId: SOURCE,
  backendDecisionId: DECISION,
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

describe('PostgresRestockPostLedgerStore.markUnknown', () => {
  it.each<[string, unknown, unknown]>([
    [
      'pre_post when no attempt was made',
      null,
      { action: 'mark_unknown', reason: 'pre_post' },
    ],
    [
      'ambiguous_post when an attempt exists',
      new Date(),
      { action: 'mark_unknown', reason: 'ambiguous_post' },
    ],
  ])('marks %s', async (_n, attemptedAt, expected) => {
    const h = harness(() =>
      ROWS(row({ post_state: 'UNKNOWN', post_attempted_at: attemptedAt })),
    );
    await expect(h.store.markUnknown(unknown())).resolves.toEqual(expected);
    expect(h.client.calls[0].params).toEqual([SENDER, SOURCE]);
    expect(h.client.calls[0].sql).toContain(
      "post_state IN ('RESERVED', 'POST_IN_FLIGHT')",
    );
    expect(h.client.calls[0].sql).toContain('unknown_observed_at = now()');
  });

  it('throws when a persisted unknown success timestamp is invalid', async () => {
    const badAttempt = harness(() =>
      ROWS(row({ post_state: 'UNKNOWN', post_attempted_at: undefined })),
    );
    await expect(badAttempt.store.markUnknown(unknown())).rejects.toThrow();

    const badObserved = harness(() =>
      ROWS(row({ post_state: 'UNKNOWN', unknown_observed_at: 'not-a-date' })),
    );
    await expect(badObserved.store.markUnknown(unknown())).rejects.toThrow();
  });

  it('throws on an inconsistent or unexpected receipt CAS projection', async () => {
    const inconsistent = harness(() => ({ rows: [], rowCount: 1 }));
    await expect(inconsistent.store.recordReceipt(receipt())).rejects.toThrow();

    const unexpected = harness(() =>
      ROWS(
        row({
          post_state: 'RECEIPT_RECORDED',
          backend_decision_id: OTHER_DECISION,
        }),
      ),
    );
    await expect(unexpected.store.recordReceipt(receipt())).rejects.toThrow();
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    [
      'holds an already-UNKNOWN row',
      { post_state: 'UNKNOWN' },
      { action: 'hold', reason: 'already_unknown' },
    ],
    [
      'blocks a RECEIPT_RECORDED row',
      { post_state: 'RECEIPT_RECORDED', backend_decision_id: DECISION },
      { action: 'blocked', reason: 'receipt_recorded' },
    ],
    [
      'never marks a still-RESERVED row',
      {},
      { action: 'blocked', reason: 'unknown_state' },
    ],
    [
      'never marks a still-POST_IN_FLIGHT row',
      { post_state: 'POST_IN_FLIGHT' },
      { action: 'blocked', reason: 'unknown_state' },
    ],
    [
      'blocks a CLOSED row',
      { status: 'CLOSED' },
      { action: 'blocked', reason: 'unknown_row' },
    ],
  ])('on a zero-row update %s', async (_n, outcome, expected) => {
    const h = afterUpdate(outcome);
    await expect(h.store.markUnknown(unknown())).resolves.toEqual(expected);
  });

  it('fails closed on a malformed or extra input before the pool', async () => {
    const h = harness(() => ROWS(row()));
    await expect(
      h.store.markUnknown({ senderId: ' ' } as never),
    ).resolves.toEqual({ action: 'blocked', reason: 'malformed_input' });
    await expect(
      h.store.markUnknown(unknown({ extra: 1 }) as never),
    ).resolves.toEqual({ action: 'blocked', reason: 'malformed_input' });
    expect(h.client.calls).toHaveLength(0);
  });

  it('propagates a query error without retry', async () => {
    const h = harness(() => new Error('db down'));
    await expect(h.store.markUnknown(unknown())).rejects.toThrow('db down');
    expect(h.client.calls).toHaveLength(1);
  });
});
