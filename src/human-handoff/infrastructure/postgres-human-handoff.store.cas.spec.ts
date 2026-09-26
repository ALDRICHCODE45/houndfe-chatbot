/** SQ-5C2c2b4a offline compare-and-set contract for
 *  PostgresHumanHandoffStore.resolve.
 *
 *  `resolve` may transition ONLY an existing pending row. The emitted
 *  UPDATE must carry `WHERE id = $1 AND status = 'pending'`; an
 *  already-resolved row (or an unknown id) must yield `null` and MUST NOT
 *  overwrite the first recorded decision (concurrent operator replies).
 *
 *  No database: a structural Pool double records the issued SQL and
 *  simulates the row's pending→resolved transition, honoring the pending
 *  guard it observes. That lets the spec prove "first success, second
 *  null, decision preserved" offline. SQL runtime behavior is not
 *  certified here; the Testcontainers suite covers execution.
 *
 *  RED: the current store emits `WHERE id = $1` (no pending guard), so the
 *  guard assertion and the repeat-null/no-overwrite assertions fail before
 *  the fix; all pass after. */
import { Pool } from 'pg';
import { PostgresHumanHandoffStore } from './postgres-human-handoff.store';

interface Row {
  id: string;
  customer_id: string;
  agent_id: string;
  kind: string;
  digest: unknown;
  status: string;
  resolution: unknown;
  created_at: Date;
  resolved_at: Date | null;
}

const CREATED = new Date('2025-01-01T00:00:00.000Z');

const pendingRow = (over: Partial<Row> = {}): Row => ({
  id: 'abc123def456',
  customer_id: 'CUST',
  agent_id: 'OPS',
  kind: 'out_of_stock',
  digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
  status: 'pending',
  resolution: null,
  created_at: CREATED,
  resolved_at: null,
  ...over,
});

/** Recording Pool double that enforces the pending guard it observes in
 *  the SQL it is handed. Without the guard the UPDATE overwrites
 *  unconditionally — the bug this work unit removes. */
class CasPool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  row: Row | null;

  constructor(row: Row | null = pendingRow()) {
    this.row = row;
  }

  async query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const text = (sql ?? '').trim();
    this.calls.push({ sql: text, params: params ?? [] });
    if (!/^UPDATE\s+human_handoff_requests/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    if (this.row === null) {
      return { rows: [], rowCount: 0 };
    }
    const guarded = /WHERE\s+id\s*=\s*\$1\s+AND\s+status\s*=\s*'pending'/i.test(
      text,
    );
    if (guarded && this.row.status !== 'pending') {
      return { rows: [], rowCount: 0 };
    }
    const raw = typeof params?.[1] === 'string' ? params[1] : null;
    this.row = {
      ...this.row,
      status: 'resolved',
      resolution: raw ? JSON.parse(raw) : null,
      resolved_at: new Date('2025-01-01T00:05:00.000Z'),
    };
    return { rows: [this.row], rowCount: 1 };
  }
}

describe('PostgresHumanHandoffStore.resolve — CAS (SQ-5C2c2b4a)', () => {
  let pool: CasPool;
  let store: PostgresHumanHandoffStore;

  beforeEach(() => {
    pool = new CasPool();
    store = new PostgresHumanHandoffStore(pool as unknown as Pool);
  });

  const resolveSql = (): string => {
    const call = pool.calls.find((c) =>
      /^UPDATE\s+human_handoff_requests/i.test(c.sql),
    );
    expect(call).toBeDefined();
    return call!.sql;
  };

  it('guards the UPDATE with the pending status predicate', async () => {
    await store.resolve('abc123def456', { decision: 'NO_RESTOCK' });
    const sql = resolveSql();
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/i);
    expect(sql).toMatch(/status\s*=\s*'pending'/i);
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).not.toMatch(/DO UPDATE/i);
  });

  it('performs a single guarded UPDATE (no upsert)', async () => {
    await store.resolve('abc123def456', { decision: 'NO_RESTOCK' });
    const updates = pool.calls.filter((c) =>
      /^UPDATE\s+human_handoff_requests/i.test(c.sql),
    );
    expect(updates).toHaveLength(1);
  });

  it('returns the resolved row on the first successful transition', async () => {
    const row = await store.resolve('abc123def456', {
      decision: 'YES_RESTOCK_IN_X_DAYS',
      days: 3,
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('resolved');
    expect(row!.resolution).toEqual({
      decision: 'YES_RESTOCK_IN_X_DAYS',
      days: 3,
    });
    expect(row!.resolvedAt).not.toBeNull();
  });

  it('returns null on a repeated resolve and preserves the first decision', async () => {
    const first = await store.resolve('abc123def456', {
      decision: 'NO_RESTOCK',
    });
    expect(first).not.toBeNull();
    const second = await store.resolve('abc123def456', {
      decision: 'APPROVED_PROMO',
      totalCents: 100,
    });
    expect(second).toBeNull();
    expect(pool.row!.status).toBe('resolved');
    expect(pool.row!.resolution).toEqual({ decision: 'NO_RESTOCK' });
  });

  it('returns null for an unknown id without mutating or inserting', async () => {
    pool.row = null;
    const row = await store.resolve('zzz000000000', { decision: 'NO_RESTOCK' });
    expect(row).toBeNull();
    expect(pool.row).toBeNull();
  });
});
