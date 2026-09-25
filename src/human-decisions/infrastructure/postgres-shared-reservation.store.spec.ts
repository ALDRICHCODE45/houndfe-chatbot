/**
 * HD-R3b2b offline behavioral spec for the Postgres SharedReservationPort
 * adapter (typed Pool double; it runs no PostgreSQL and proves no real race).
 */
import type { Pool } from 'pg';
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { type ReservationProposal } from '../domain/shared-reservation';
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
};
const EMPTY: Result = { rows: [], rowCount: 0 };
const ROWS = (...rows: unknown[]): Result => ({ rows, rowCount: rows.length });
const CLAIMED = ROWS({ status: 'ACTIVE' });
const pick = (reply?: Result | Error): Result => {
  if (reply instanceof Error) throw reply;
  return reply ?? EMPTY;
};

class FakeClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  releases = 0;
  constructor(private readonly reply: (sql: string) => Result) {}
  async query(sql: string, params: unknown[] = []): Promise<Result> {
    const text = sql.trim();
    this.calls.push({ sql: text, params });
    return this.reply(text);
  }
  release(): void {
    this.releases += 1;
  }
}
function harness(canned: Canned = {}) {
  const client = new FakeClient((sql) => {
    if (sql === 'COMMIT' && canned.commit) throw canned.commit;
    if (sql.includes('human_handoff_requests')) return pick(canned.pending);
    if (sql.startsWith('INSERT')) return pick(canned.insert);
    if (sql.includes('AND request_key =')) return pick(canned.key);
    if (sql.includes('sender_id =')) return pick(canned.active);
    return EMPTY;
  });
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
