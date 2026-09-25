/**
 * HD-R3b3-c4c2a offline behavioral spec for the read-only
 * PostgresSharedRouteMarkersStore (typed Pool double; it runs no PostgreSQL and
 * proves no real concurrency, locking, or old-writer exclusivity).
 */
import type { Pool } from 'pg';
import { selectOutOfStockRoute } from '../domain/restock-route-policy';
import type { SharedRouteMarkers } from '../domain/shared-route-markers';
import { PostgresSharedRouteMarkersStore } from './postgres-shared-route-markers.store';

const SENDER = 'whatsapp:+5215500000001';
const UNKNOWN: SharedRouteMarkers = {
  legacyRequestPending: 'unknown',
  restockIntentPresent: 'unknown',
};
const read = (
  legacyRequestPending: boolean,
  restockIntentPresent: boolean,
): SharedRouteMarkers => ({ legacyRequestPending, restockIntentPresent });

const SNAPSHOT_SQL =
  "SELECT (SELECT count(*)::int FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE') AS active_count, (SELECT route FROM human_decision_reservations WHERE sender_id = $1 AND status = 'ACTIVE' LIMIT 1) AS active_route, EXISTS (SELECT 1 FROM human_handoff_requests WHERE customer_id = $1 AND status = 'pending') AS legacy_pending";

type Row = Record<string, unknown>;
type Result = { rows: unknown[]; rowCount: number | null };
const plainRow = (o: Record<string, unknown>): Row => ({ ...o });
const snapshot = (o: Partial<Row> = {}): Result => ({
  rows: [
    plainRow({
      active_count: 0,
      active_route: null,
      legacy_pending: false,
      ...o,
    }),
  ],
  rowCount: 1,
});

const faults: string[] = [];
const fault = (message: string): never => {
  faults.push(message);
  throw new Error(`strict fake: ${message}`);
};

function harness(reply?: Result | Error) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: text, params });
      if (text !== SNAPSHOT_SQL) fault(`unrecognized SQL: ${text}`);
      if (params.length !== 1 || !Object.is(params[0], SENDER)) {
        fault('snapshot params');
      }
      if (reply === undefined) fault('unexpected query');
      if (reply instanceof Error) throw reply;
      return reply;
    },
    end: async () => undefined,
  };
  const store = new PostgresSharedRouteMarkersStore(pool as unknown as Pool);
  return { store, calls };
}

beforeEach(() => {
  faults.length = 0;
});
afterEach(() => {
  expect(faults).toEqual([]);
});

describe('PostgresSharedRouteMarkersStore.readForSender', () => {
  it('binds one parameterized statement and reads an active RESTOCK alone', async () => {
    const h = harness(snapshot({ active_count: 1, active_route: 'RESTOCK' }));
    await expect(h.store.readForSender(SENDER)).resolves.toEqual(
      read(false, true),
    );
    expect(h.calls).toEqual([{ sql: SNAPSHOT_SQL, params: [SENDER] }]);
  });

  it('reads an active LEGACY_OPS reservation as a legacy request alone', async () => {
    const h = harness(
      snapshot({ active_count: 1, active_route: 'LEGACY_OPS' }),
    );
    await expect(h.store.readForSender(SENDER)).resolves.toEqual(
      read(true, false),
    );
  });

  it('reads a pending legacy handoff with no reservation as a legacy request', async () => {
    const h = harness(snapshot({ legacy_pending: true }));
    await expect(h.store.readForSender(SENDER)).resolves.toEqual(
      read(true, false),
    );
  });

  it('reads both an active RESTOCK and a pending handoff truthfully, and the pure policy blocks the conflict', async () => {
    const h = harness(
      snapshot({
        active_count: 1,
        active_route: 'RESTOCK',
        legacy_pending: true,
      }),
    );
    const markers = await h.store.readForSender(SENDER);
    expect(markers).toEqual(read(true, true));
    expect(
      selectOutOfStockRoute({ restockFeatureEnabled: true, ...markers }),
    ).toEqual({ route: 'blocked_conflict', reason: 'conflicting_markers' });
  });

  it('reads no reservation and no pending handoff as both false, and the pure policy stays default-off', async () => {
    const h = harness(snapshot());
    const markers = await h.store.readForSender(SENDER);
    expect(markers).toEqual(read(false, false));
    expect(
      selectOutOfStockRoute({ restockFeatureEnabled: false, ...markers }),
    ).toEqual({ route: 'legacy_ops', reason: 'feature_disabled' });
  });

  it('fails closed to unknown,unknown on any inconsistent snapshot, never false', async () => {
    const cases: Array<Partial<Row>> = [
      { active_count: 2, active_route: 'RESTOCK' },
      { active_count: 1, active_route: null },
      { active_count: 1, active_route: 'OTHER' },
      { active_count: 0, active_route: 'RESTOCK' },
      { active_count: '1', active_route: 'RESTOCK' },
      { active_count: 1.5, active_route: 'RESTOCK' },
      { active_count: -1 },
      { legacy_pending: 'true' },
    ];
    for (const overrides of cases) {
      const h = harness(snapshot(overrides));
      await expect(h.store.readForSender(SENDER)).resolves.toEqual(UNKNOWN);
    }
    const h = harness(snapshot({ active_count: 2, active_route: 'RESTOCK' }));
    const markers = await h.store.readForSender(SENDER);
    expect(
      selectOutOfStockRoute({ restockFeatureEnabled: true, ...markers }),
    ).toEqual({
      route: 'blocked_indeterminate',
      reason: 'indeterminate_marker_state',
    });
  });

  it('rejects accessor and Proxy rows that spoof an empty route', async () => {
    const accessor = Object.defineProperty(
      plainRow({ active_count: 0, active_route: null, legacy_pending: false }),
      'active_count',
      {
        enumerable: true,
        get: () => 0,
      },
    );
    const actual = plainRow({
      active_count: 1,
      active_route: 'RESTOCK',
      legacy_pending: true,
    });
    const spoofed = new Proxy(actual, {
      get(target, key, receiver) {
        if (key === 'active_count') return 0;
        if (key === 'active_route') return null;
        if (key === 'legacy_pending') return false;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    for (const row of [accessor, spoofed]) {
      const h = harness({ rows: [row], rowCount: 1 });
      await expect(h.store.readForSender(SENDER)).resolves.toEqual(UNKNOWN);
    }
  });

  it('fails closed on driver-shape anomalies and SQL errors', async () => {
    const anomalies: Result[] = [
      { rows: [], rowCount: 0 },
      {
        rows: [plainRow({ active_count: 0 }), plainRow({ active_count: 0 })],
        rowCount: 2,
      },
      { rows: [plainRow({ active_count: 0 })], rowCount: null },
      { rows: ['not-a-row'], rowCount: 1 },
    ];
    for (const reply of anomalies) {
      const h = harness(reply);
      await expect(h.store.readForSender(SENDER)).resolves.toEqual(UNKNOWN);
    }
    const failing = harness(new Error('db down'));
    await expect(failing.store.readForSender(SENDER)).resolves.toEqual(UNKNOWN);
  });

  it('never queries for an invalid senderId', async () => {
    const invalid: unknown[] = [
      '',
      '   ',
      ' x',
      'x ',
      undefined,
      null,
      42,
      {},
      'a'.repeat(201),
    ];
    for (const senderId of invalid) {
      const h = harness();
      await expect(h.store.readForSender(senderId as never)).resolves.toEqual(
        UNKNOWN,
      );
      expect(h.calls).toHaveLength(0);
    }
  });
});
