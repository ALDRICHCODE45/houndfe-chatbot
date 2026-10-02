/**
 * HD-R3b2b offline behavioral spec for the Postgres SharedReservationPort
 * adapter (typed Pool double; it runs no PostgreSQL and proves no real race).
 */
import type { Pool } from 'pg';
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  classifyReservation,
  type ReservationProposal,
} from '../domain/shared-reservation';
import { PostgresSharedReservationStore } from './postgres-shared-reservation.store';

const SENDER = 'whatsapp:+5215500000001';
const LEGACY_KEY = 'a1b2c3d4e5f6';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const intake = (o: Partial<RestockIntakeInput> = {}): RestockIntakeInput => ({
  sourceRequestId: A,
  type: 'RESTOCK',
  productId: B,
  productName: 'Alimento premium',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
  ...o,
});

const base = (route: 'LEGACY_OPS' | 'RESTOCK', o: Record<string, unknown>) =>
  ({
    route,
    senderId: SENDER,
    requestKey: route === 'RESTOCK' ? A : LEGACY_KEY,
    intake: route === 'RESTOCK' ? intake() : null,
    ...o,
  }) as ReservationProposal;
const restock = (o: Record<string, unknown> = {}) => base('RESTOCK', o);

const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  route: 'LEGACY_OPS',
  request_key: LEGACY_KEY,
  status: 'ACTIVE',
  sender_id: SENDER,
  intake: null,
  ...o,
});
const without = (key: keyof RestockIntakeInput): Record<string, unknown> =>
  Object.fromEntries(Object.entries(intake()).filter(([k]) => k !== key));
type Result = { rows: unknown[]; rowCount: number | null };
type Canned = {
  active?: Result | Error;
  key?: Result | Error;
  insert?: Result | Error;
  pending?: Result | Error;
  commit?: Error;
  close?: Result | Error;
  closeExisting?: Result | Error;
};
const EMPTY: Result = { rows: [], rowCount: 0 };
const ROWS = (...rows: unknown[]): Result => ({ rows, rowCount: rows.length });
const CLAIMED = ROWS({ status: 'ACTIVE' });
const pick = (reply?: Result | Error): Result => {
  if (reply instanceof Error) throw reply;
  return reply ?? EMPTY;
};

const ACTIVE_SQL =
  "SELECT route, request_key, status, sender_id, intake FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE' LIMIT 1";
const KEY_SQL =
  'SELECT route, request_key, status, sender_id, intake FROM human_decision_reservations WHERE route = $1 AND request_key = $2 LIMIT 1';
const PENDING_SQL =
  "SELECT 1 FROM human_handoff_requests WHERE customer_id = $1 AND status = 'pending' LIMIT 1";
const INSERT_SQL =
  "INSERT INTO human_decision_reservations (sender_id, route, request_key, status, intake, post_state) VALUES ($1, $2, $3, 'ACTIVE', $4::jsonb, $5) ON CONFLICT DO NOTHING RETURNING status";

/** Strict-fake contract faults. `beforeEach` clears them and `afterEach`
 * asserts none, so a mismatched predicate/param fails even a reject-case test
 * whose own assertion would otherwise mask it. */
const faults: string[] = [];
const fault = (message: string): never => {
  faults.push(message);
  throw new Error(`strict fake: ${message}`);
};
const sameParams = (actual: unknown[], expected: unknown[]): boolean =>
  actual.length === expected.length &&
  expected.every((value, index) => Object.is(actual[index], value));

function strictReply(
  canned: Canned,
  target: { route: string; key: string },
): (sql: string, params: unknown[]) => Result {
  return (sql, params) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') {
      if (sql === 'COMMIT' && canned.commit) throw canned.commit;
      return EMPTY;
    }
    if (sql === ACTIVE_SQL) {
      if (!sameParams(params, [SENDER])) fault('active SELECT params');
      return pick(canned.active);
    }
    if (sql === KEY_SQL) {
      if (!sameParams(params, [target.route, target.key])) {
        fault('replay-key SELECT params');
      }
      return pick(canned.key);
    }
    if (sql === PENDING_SQL) {
      if (!sameParams(params, [SENDER])) fault('legacy-pending SELECT params');
      return pick(canned.pending);
    }
    if (sql === INSERT_SQL) {
      const restock = target.route === 'RESTOCK';
      const expectedIntake = restock ? JSON.stringify(intake()) : null;
      if (
        !sameParams(params, [
          SENDER,
          target.route,
          target.key,
          expectedIntake,
          restock ? 'RESERVED' : null,
        ])
      ) {
        fault('INSERT params');
      }
      return pick(canned.insert);
    }
    if (sql.startsWith('UPDATE human_decision_reservations')) {
      return pick(canned.close);
    }
    if (sql.includes('SELECT 1 AS closed')) {
      return pick(canned.closeExisting);
    }
    return fault(`unrecognized query: ${sql}`);
  };
}

class FakeClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  releases = 0;
  constructor(
    private readonly reply: (sql: string, params: unknown[]) => Result,
  ) {}
  async query(sql: string, params: unknown[] = []): Promise<Result> {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: text, params });
    return this.reply(text, params);
  }
  release(): void {
    this.releases += 1;
  }
}

function harness(
  canned: Canned = {},
  target: { route: string; key: string } = { route: 'RESTOCK', key: A },
) {
  const client = new FakeClient(strictReply(canned, target));
  let connects = 0;
  const pool = {
    connect: async () => {
      connects += 1;
      return client;
    },
    end: async () => undefined,
  };
  const store = new PostgresSharedReservationStore(pool as unknown as Pool);
  const sqls = () => client.calls.map((c) => c.sql);
  return { store, client, connects: () => connects, sqls };
}

beforeEach(() => {
  faults.length = 0;
});
afterEach(() => {
  expect(faults).toEqual([]);
});
const MALFORMED = { action: 'blocked', reason: 'malformed_proposal' } as const;
const CLAIM = { action: 'claim', reason: 'single_sender_vacant' } as const;

describe('PostgresSharedReservationStore.reserve', () => {
  it('rejects raw-invalid or hostile RESTOCK before any connection', async () => {
    const cases: ReservationProposal[] = [
      ...[{ type: 'RESTOCK', sourceRequestId: A }, without('variantId')].map(
        (p) => restock({ intake: p }),
      ),
      {
        get senderId(): string {
          throw new Error('hostile');
        },
      } as ReservationProposal,
    ];
    for (const p of cases) {
      const h = harness();
      await expect(h.store.reserve(p)).resolves.toEqual(MALFORMED);
      expect(h.connects()).toBe(0);
      expect(h.client.calls).toHaveLength(0);
    }
  });

  it('binds a RESTOCK claim inside one transaction', async () => {
    const h = harness({ insert: CLAIMED });
    await expect(h.store.reserve(restock())).resolves.toEqual(CLAIM);
    expect(h.sqls()).toEqual([
      'BEGIN',
      expect.stringContaining('FROM human_decision_reservations'),
      expect.stringContaining('human_handoff_requests'),
      expect.stringContaining('INSERT INTO human_decision_reservations'),
      'COMMIT',
    ]);
    expect(h.client.calls[3].sql).toContain('ON CONFLICT DO NOTHING');
    expect(h.client.calls[3].params).toEqual([
      SENDER,
      'RESTOCK',
      A,
      JSON.stringify(intake()),
      'RESERVED',
    ]);
    expect(h.client.releases).toBe(1);
  });

  it('throws, rolls back and releases on inconsistent or non-ACTIVE reads', async () => {
    const anomalies: Canned[] = [
      { active: ROWS(null) },
      { active: ROWS(undefined) },
      { active: { rows: [], rowCount: 1 } },
      { active: { rows: [row({ status: 'CLOSED' })], rowCount: 1 } },
      { pending: { rows: undefined as never, rowCount: 0 } },
    ];
    for (const canned of anomalies) {
      const h = harness(canned);
      await expect(h.store.reserve(restock())).rejects.toThrow();
      expect(h.sqls()).toContain('ROLLBACK');
      expect(h.sqls()).not.toContain('COMMIT');
      expect(h.sqls().filter((s) => s === 'BEGIN')).toHaveLength(1);
      expect(h.client.releases).toBe(1);
    }
  });
});

describe('PostgresSharedReservationStore.reserve — deferred adapter cases', () => {
  const OTHER = 'whatsapp:+5215500009999';
  const legacy = (o: Record<string, unknown> = {}) => base('LEGACY_OPS', o);
  const held = (o: Record<string, unknown> = {}) =>
    row({ route: 'RESTOCK', request_key: A, intake: intake(), ...o });
  const inserted = (h: ReturnType<typeof harness>) =>
    h.sqls().some((s) => s.startsWith('INSERT'));

  it('resolves classifier outcomes without inserting', async () => {
    const cases: Array<{
      canned: Canned;
      expected: unknown;
      proposal?: ReservationProposal;
    }> = [
      {
        canned: { active: ROWS(row()) },
        expected: { action: 'replay', reason: 'exact_active_replay' },
        proposal: legacy(),
      },
      {
        canned: { active: ROWS(held()) },
        expected: { action: 'replay', reason: 'exact_active_replay' },
      },
      {
        canned: {
          active: ROWS(held({ intake: intake({ requestedQuantity: 9 }) })),
        },
        expected: { action: 'conflict', reason: 'same_key_different_payload' },
      },
      {
        canned: { active: ROWS(row()) },
        expected: {
          action: 'occupied',
          reason: 'different_active_key',
          activeRoute: 'LEGACY_OPS',
        },
      },
      {
        canned: { pending: ROWS({ one: 1 }) },
        expected: {
          action: 'occupied_legacy',
          reason: 'legacy_marker_present',
        },
      },
      {
        canned: { active: ROWS(held()), pending: ROWS({ one: 1 }) },
        expected: { action: 'blocked', reason: 'ambiguous_active_hold' },
      },
    ];
    for (const { canned, expected, proposal } of cases) {
      const h = harness(canned);
      const decision = await h.store.reserve(proposal ?? restock());
      expect(decision).toEqual(expected);
      expect(h.sqls()[0]).toBe('BEGIN');
      expect(h.sqls().at(-1)).toBe('ROLLBACK');
      expect(inserted(h)).toBe(false);
      expect(h.client.releases).toBe(1);
    }
  });

  it('re-reads and arbitrates after a zero-row ON CONFLICT insert', async () => {
    const cases: Array<[Canned, unknown]> = [
      [{ insert: EMPTY }, { action: 'blocked', reason: 'unknown_existing' }],
      [
        { insert: EMPTY, key: ROWS(held({ status: 'CLOSED' })) },
        { action: 'blocked', reason: 'unknown_existing' },
      ],
      [
        { insert: EMPTY, key: ROWS(held()) },
        { action: 'replay', reason: 'exact_active_replay' },
      ],
    ];
    for (const [canned, expected] of cases) {
      const h = harness(canned);
      await expect(h.store.reserve(restock())).resolves.toEqual(expected);
      expect(h.sqls()[0]).toBe('BEGIN');
      expect(h.sqls().at(-1)).toBe('ROLLBACK');
      expect(inserted(h)).toBe(true);
      expect(h.client.releases).toBe(1);
    }
  });

  it('fails closed on a same-key other-sender row without leaking it', async () => {
    const h = harness({ insert: EMPTY, key: ROWS(held({ sender_id: OTHER })) });
    const decision = await h.store.reserve(restock());
    expect(decision).toEqual({ action: 'blocked', reason: 'sender_mismatch' });
    expect(JSON.stringify(decision)).not.toContain('Alimento premium');
    expect(h.sqls().at(-1)).toBe('ROLLBACK');
    expect(h.client.releases).toBe(1);
  });

  it('writes a SQL NULL, not JSON null, for a legacy claim', async () => {
    const h = harness(
      { insert: CLAIMED },
      { route: 'LEGACY_OPS', key: LEGACY_KEY },
    );
    await expect(h.store.reserve(legacy())).resolves.toEqual(CLAIM);
    const insert = h.client.calls.find((c) => c.sql === INSERT_SQL);
    expect(insert?.params).toEqual([
      SENDER,
      'LEGACY_OPS',
      LEGACY_KEY,
      null,
      null,
    ]);
    expect(h.client.releases).toBe(1);
  });

  it('replays a matching zero-row LEGACY_OPS key with bound key params', async () => {
    const h = harness(
      { insert: EMPTY, key: ROWS(row()) },
      { route: 'LEGACY_OPS', key: LEGACY_KEY },
    );
    await expect(h.store.reserve(legacy())).resolves.toEqual({
      action: 'replay',
      reason: 'exact_active_replay',
    });
    const keyCall = h.client.calls.find((c) => c.sql === KEY_SQL);
    expect(keyCall?.params).toEqual(['LEGACY_OPS', LEGACY_KEY]);
    expect(h.sqls()).toContain('ROLLBACK');
    expect(h.client.releases).toBe(1);
  });

  it('rethrows a commit error once and releases without retry', async () => {
    const h = harness({ insert: CLAIMED, commit: new Error('commit failed') });
    await expect(h.store.reserve(restock())).rejects.toThrow('commit failed');
    expect(h.sqls().filter((s) => s === INSERT_SQL)).toHaveLength(1);
    expect(h.sqls().filter((s) => s === 'COMMIT')).toHaveLength(1);
    expect(h.client.releases).toBe(1);
  });

  it('throws on inconsistent pending rowCount, LIMIT-1 overflow and query error', async () => {
    const failures: Canned[] = [
      { pending: { rows: [], rowCount: 1 } },
      { active: { rows: [held(), held()], rowCount: 2 } },
      { active: new Error('connection reset') },
    ];
    for (const canned of failures) {
      const h = harness(canned);
      await expect(h.store.reserve(restock())).rejects.toThrow();
      expect(h.sqls()).toContain('ROLLBACK');
      expect(h.sqls()).not.toContain('COMMIT');
      expect(h.client.releases).toBe(1);
    }
  });

  it('rejects malformed classifiers and raw undefined/extra payloads', async () => {
    const cases: ReservationProposal[] = [
      legacy({ requestKey: 'XYZ' }),
      restock({ requestKey: B }),
      legacy({ intake: intake() }),
      legacy({ route: 'BOGUS' }),
      restock({ intake: null }),
      restock({ intake: { ...intake(), variantId: undefined } }),
      restock({ intake: { ...intake(), ok: 1 } }),
    ];
    for (const p of cases) {
      const h = harness();
      await expect(h.store.reserve(p)).resolves.toEqual(MALFORMED);
      expect(h.connects()).toBe(0);
      expect(h.client.calls).toHaveLength(0);
    }
  });
});

describe('PostgresSharedReservationStore.closeLegacyResolved', () => {
  it('closes the exact legacy reservation and commits', async () => {
    const h = harness({ close: ROWS({ status: 'CLOSED' }) });
    await expect(h.store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      true,
    );
    const sqls = h.sqls();
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.at(-1)).toBe('COMMIT');
    const update = h.client.calls.find((c) =>
      c.sql.startsWith('UPDATE human_decision_reservations'),
    );
    expect(update?.params).toEqual([SENDER, LEGACY_KEY]);
    expect(update?.sql).toContain("r.route = 'LEGACY_OPS'");
    expect(update?.sql).toContain("SET status = 'CLOSED'");
    expect(update?.sql).toContain('updated_at = now()');
    expect(update?.sql).toContain("h.status = 'resolved'");
    expect(h.client.releases).toBe(1);
  });

  it('returns true idempotently for an already-CLOSED exact reservation', async () => {
    const h = harness({ close: EMPTY, closeExisting: ROWS({ closed: 1 }) });
    await expect(h.store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      true,
    );
    const sqls = h.sqls();
    expect(
      sqls.filter((s) => s.startsWith('UPDATE human_decision_reservations')),
    ).toHaveLength(1);
    expect(sqls.some((s) => s.includes('SELECT 1 AS closed'))).toBe(true);
    expect(sqls.at(-1)).toBe('COMMIT');
    expect(h.client.releases).toBe(1);
  });

  it('returns false when no exact resolved legacy reservation exists', async () => {
    const h = harness({ close: EMPTY, closeExisting: EMPTY });
    await expect(h.store.closeLegacyResolved(SENDER, LEGACY_KEY)).resolves.toBe(
      false,
    );
    expect(h.sqls()).toContain('COMMIT');
    expect(h.client.releases).toBe(1);
  });

  it('fails closed on a malformed sender or non-legacy key before the pool', async () => {
    const h = harness();
    await expect(h.store.closeLegacyResolved('', LEGACY_KEY)).resolves.toBe(
      false,
    );
    await expect(h.store.closeLegacyResolved(SENDER, 'XYZ')).resolves.toBe(
      false,
    );
    await expect(h.store.closeLegacyResolved(SENDER, A)).resolves.toBe(false);
    expect(h.connects()).toBe(0);
    expect(h.client.calls).toHaveLength(0);
  });

  it('throws and rolls back on an inconsistent driver result', async () => {
    const h = harness({ close: { rows: [], rowCount: 1 } });
    await expect(
      h.store.closeLegacyResolved(SENDER, LEGACY_KEY),
    ).rejects.toThrow();
    expect(h.sqls()).toContain('ROLLBACK');
    expect(h.client.releases).toBe(1);
  });

  it('throws and rolls back on a DB or commit error', async () => {
    const dbError = harness({ close: new Error('boom') });
    await expect(
      dbError.store.closeLegacyResolved(SENDER, LEGACY_KEY),
    ).rejects.toThrow('boom');
    expect(dbError.sqls()).toContain('ROLLBACK');
    expect(dbError.client.releases).toBe(1);

    const commitError = harness({
      close: ROWS({ status: 'CLOSED' }),
      commit: new Error('commit failed'),
    });
    await expect(
      commitError.store.closeLegacyResolved(SENDER, LEGACY_KEY),
    ).rejects.toThrow('commit failed');
    expect(commitError.client.releases).toBe(1);
  });
});

describe('PostgresSharedReservationStore.reserve — EXPIRATION sentinel', () => {
  // A VALID pure-EXPIRATION proposal (the classifier claims it) stays outside
  // the port's supported LEGACY_OPS/RESTOCK adapter subset: an untyped runtime
  // caller must be rejected before any connect/query, never materialized. The
  // `as never` cast simulates that untyped runtime caller only.
  const expiration = {
    senderId: SENDER,
    route: 'EXPIRATION',
    requestKey: A,
    intake: {
      sourceRequestId: A,
      type: 'EXPIRATION',
      productId: B,
      variantId: null,
    },
  };

  it('is pure-valid yet rejected before any connection', async () => {
    expect(
      classifyReservation({
        proposal: expiration as unknown as ReservationProposal,
        existing: 'absent',
        legacyMarkerPresent: false,
      }),
    ).toEqual(CLAIM);

    const h = harness();
    await expect(h.store.reserve(expiration as never)).resolves.toEqual(
      MALFORMED,
    );
    expect(h.connects()).toBe(0);
    expect(h.client.calls).toHaveLength(0);
  });
});
