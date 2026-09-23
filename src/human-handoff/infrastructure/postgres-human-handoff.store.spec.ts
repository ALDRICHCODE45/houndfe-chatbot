import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * Testcontainers-backed contract suite for PostgresHumanHandoffStore.
 *
 * Spec scenarios (human-handoff §"HumanHandoffStore port exposes the four CRUD primitives"):
 *   - create inserts and returns the row with generated createdAt.
 *   - findById round-trips.
 *   - findByRef('HF-<id>') parses the prefix and returns the matching row.
 *   - findLatestPendingForAgent returns the newest pending row (newest wins).
 *   - resolve sets status='resolved' + the supplied resolution + resolvedAt.
 *   - resolve on an unknown id returns null and does not insert.
 *   - resolve a second time returns null and preserves the first decision.
 *   - findByRef on an unknown id returns null.
 *
 * Gated by RUN_DOCKER_TESTS=1 (matches the existing
 * `PostgresConversationStore` testcontainers convention). Without the
 * gate, this file is skipped and `pnpm test` stays green.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

type StoreCtor =
  typeof import('./postgres-human-handoff.store').PostgresHumanHandoffStore;

ddescribe('PostgresHumanHandoffStore (Testcontainers)', () => {
  jest.setTimeout(60_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let Store: StoreCtor;
  let store: import('./postgres-human-handoff.store').PostgresHumanHandoffStore;

  beforeAll(async () => {
    const require = createRequire(__filename) as (
      moduleName: string,
    ) => typeof import('./postgres-human-handoff.store');
    Store = require('./postgres-human-handoff.store').PostgresHumanHandoffStore;

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const connStr = container.getConnectionUri();
    process.env.DATABASE_URL = connStr;
    delete process.env.DB_POOL_MAX;

    // Apply ALL migrations (1700, 1800, 1900) — matches production.
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: connStr },
      stdio: 'pipe',
    });

    pool = new Pool({ connectionString: connStr });
    store = new Store(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE human_handoff_requests');
  });

  it('create inserts and returns the row with generated createdAt', async () => {
    const created = await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: {
        kind: 'out_of_stock',
        productId: 'p1',
        name: 'X',
        quantity: 1,
      },
    });
    expect(created.id).toBe('abc123def456');
    expect(created.customerId).toBe('CUST');
    expect(created.agentId).toBe('OPS');
    expect(created.kind).toBe('out_of_stock');
    expect(created.status).toBe('pending');
    expect(created.resolution).toBeNull();
    expect(created.resolvedAt).toBeNull();
    expect(typeof created.createdAt).toBe('string');
  });

  it('findById round-trips the created row', async () => {
    await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
    });
    const row = await store.findById('abc123def456');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('abc123def456');
    expect(row!.customerId).toBe('CUST');
  });

  it('findByRef strips the HF- prefix and returns the matching row', async () => {
    await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
    });
    const row = await store.findByRef('HF-abc123def456');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('abc123def456');
  });

  it('findByRef tolerates the lowercased prefix', async () => {
    await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
    });
    const row = await store.findByRef('hf-abc123def456');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('abc123def456');
  });

  it('findByRef on an unknown id returns null', async () => {
    const row = await store.findByRef('HF-zzz000000000');
    expect(row).toBeNull();
  });

  it('findLatestPendingForAgent returns the newest pending row (newest wins)', async () => {
    await store.create({
      id: '111111111111',
      customerId: 'C1',
      agentId: 'OPS-2',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'A' },
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.create({
      id: '222222222222',
      customerId: 'C2',
      agentId: 'OPS-2',
      kind: 'expiration_date',
      digest: {
        kind: 'expiration_date',
        productId: 'p2',
        name: 'B',
        question: 'q',
      },
    });
    const row = await store.findLatestPendingForAgent('OPS-2');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('222222222222');
  });

  it('findLatestPendingForAgent ignores rows belonging to other agents', async () => {
    const row = await store.findLatestPendingForAgent('OPS-OTHER');
    expect(row).toBeNull();
  });

  it('resolve sets status=resolved, the supplied resolution, and a non-null resolvedAt', async () => {
    await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
    });
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

  it('resolve on an unknown id returns null', async () => {
    const row = await store.resolve('zzz000000000', {
      decision: 'NO_RESTOCK',
    });
    expect(row).toBeNull();
  });

  it('resolve a second time returns null and preserves the first decision', async () => {
    await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
    });
    const first = await store.resolve('abc123def456', {
      decision: 'NO_RESTOCK',
    });
    expect(first).not.toBeNull();
    const second = await store.resolve('abc123def456', {
      decision: 'APPROVED_PROMO',
      totalCents: 100,
    });
    expect(second).toBeNull();
    const persisted = await store.findById('abc123def456');
    expect(persisted!.status).toBe('resolved');
    expect(persisted!.resolution).toEqual({ decision: 'NO_RESTOCK' });
  });

  it('findLatestPendingForAgent excludes already-resolved rows', async () => {
    await store.create({
      id: 'abc123def456',
      customerId: 'CUST',
      agentId: 'OPS',
      kind: 'out_of_stock',
      digest: { kind: 'out_of_stock', productId: 'p1', name: 'X' },
    });
    await store.resolve('abc123def456', { decision: 'NO_RESTOCK' });
    const row = await store.findLatestPendingForAgent('OPS');
    expect(row).toBeNull();
  });
});
