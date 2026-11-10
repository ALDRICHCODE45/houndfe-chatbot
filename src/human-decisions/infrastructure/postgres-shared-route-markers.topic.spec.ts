/**
 * S5 offline spec for the topic-scoped PostgresSharedRouteMarkersStore read
 * (typed Pool double; the real-PostgreSQL proof is the per-topic db spec).
 */
import { PostgresSharedRouteMarkersStore } from './postgres-shared-route-markers.store';

const SENDER = 'whatsapp:+5215500000001';
const TOPIC = 'variant:55555555-5555-4555-8555-555555555555';
const UNKNOWN = {
  legacyRequestPending: 'unknown',
  restockIntentPresent: 'unknown',
};

function harness(rows: unknown[], rowCount: number | null = rows.length) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount });
  const store = new PostgresSharedRouteMarkersStore({
    query,
  });
  return { store, query };
}
const row = (o: Record<string, unknown> = {}) => ({
  legacy_count: 0,
  restock_count: 0,
  legacy_pending: false,
  ...o,
});

describe('PostgresSharedRouteMarkersStore.readForSender with a topic', () => {
  it('binds sender and topic to one RESTOCK-topic snapshot', async () => {
    const h = harness([row({ restock_count: 1 })]);
    await expect(h.store.readForSender(SENDER, TOPIC)).resolves.toEqual({
      legacyRequestPending: false,
      restockIntentPresent: true,
    });
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("route = 'RESTOCK' AND topic_key = $2");
    expect(sql).toContain("route = 'LEGACY_OPS'");
    expect(params).toEqual([SENDER, TOPIC]);
  });

  it.each([
    [row({ legacy_count: 1 }), true, false],
    [row({ legacy_pending: true }), true, false],
    [row(), false, false],
  ])('maps %o', async (snapshot, legacy, restock) => {
    const h = harness([snapshot]);
    await expect(h.store.readForSender(SENDER, TOPIC)).resolves.toEqual({
      legacyRequestPending: legacy,
      restockIntentPresent: restock,
    });
  });

  it.each([
    ['a duplicate topic row', [row({ restock_count: 2 })]],
    ['two legacy rows', [row({ legacy_count: 2 })]],
    ['a non-boolean pending', [row({ legacy_pending: 'f' })]],
    ['an extra column', [{ ...row(), active_route: null }]],
    ['no row', []],
  ])('fails closed on %s', async (_name, rows) => {
    await expect(
      harness(rows).store.readForSender(SENDER, TOPIC),
    ).resolves.toEqual(UNKNOWN);
  });

  it('rejects a malformed topic before any query', async () => {
    const h = harness([row()]);
    await expect(h.store.readForSender(SENDER, 'legacy')).resolves.toEqual(
      UNKNOWN,
    );
    expect(h.query).not.toHaveBeenCalled();
  });
});
