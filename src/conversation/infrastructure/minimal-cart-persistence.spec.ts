import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresConversationStore } from './postgres-conversation.store';
import { InMemoryConversationStore } from './in-memory-conversation.store';

const CART = { items: [], idempotencyKey: '', expectedTotalCents: 0 };
const TIME = '2026-01-01T00:00:00.000Z';

describe('Minimal cart atomic persistence', () => {
  it('uses one parameterized atomic PostgreSQL CAS, maps conflict to false', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0 });
    const store = new PostgresConversationStore({ query } as unknown as Pool);
    expect(await store.commitMinimalCart('a', undefined, CART, TIME)).toBe(
      false,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('minimalCart');
    expect(params).toContain(JSON.stringify(CART));
  });

  it('rejects competing stale writers and does not expose mutable references', async () => {
    const store = new InMemoryConversationStore();
    const next = { ...CART, expectedTotalCents: 10 };
    expect(await store.commitMinimalCart('a', undefined, next, TIME)).toBe(
      true,
    );
    next.expectedTotalCents = 20;
    expect((await store.get('a'))?.data.minimalCart).toEqual({
      ...CART,
      expectedTotalCents: 10,
    });
    const expected = structuredClone((await store.get('a'))?.data.minimalCart);
    const results = await Promise.all([
      store.commitMinimalCart('a', expected, CART, TIME),
      store.commitMinimalCart(
        'a',
        expected,
        { ...CART, expectedTotalCents: 30 },
        TIME,
      ),
    ]);
    expect(results).toEqual([true, false]);
  });
});

const dbDescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
dbDescribe('Minimal cart real disposable PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresConversationStore;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(
      'CREATE TABLE conversation_state (sender_id text PRIMARY KEY, last_message_at timestamptz NOT NULL, data jsonb NOT NULL)',
    );
    store = new PostgresConversationStore(pool);
  }, 120000);
  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });
  it('survives fresh adapters, preserves live siblings against stale updates, and permits one competing CAS', async () => {
    const original = {
      cart: { oldCheckout: true },
      shippingApproval: { id: 's' },
      pendingHumanRequest: null,
      messages: [],
    };
    await store.create('a', { lastMessageAt: TIME, data: original });
    expect(await store.commitMinimalCart('a', undefined, CART, TIME)).toBe(
      true,
    );
    const snapshot = (await store.get('a'))!;
    const changed = { ...CART, expectedTotalCents: 20 };
    expect(await store.commitMinimalCart('a', CART, changed, TIME)).toBe(true);
    await store.update('a', { lastMessageAt: TIME, data: snapshot.data });
    const fresh = new PostgresConversationStore(pool);
    expect((await fresh.get('a'))?.data).toEqual({
      ...original,
      minimalCart: changed,
    });
    const result = await Promise.all([
      fresh.commitMinimalCart('a', changed, CART, TIME),
      store.commitMinimalCart(
        'a',
        changed,
        { ...CART, expectedTotalCents: 30 },
        TIME,
      ),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect((await fresh.get('a'))?.data).toMatchObject(original);
    const before = await fresh.get('a');
    expect(await store.commitMinimalCart('a', changed, CART, TIME)).toBe(false);
    expect(await fresh.get('a')).toEqual(before);
  });
});
