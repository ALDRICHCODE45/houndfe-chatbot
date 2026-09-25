import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/**
 * R3b3-c2b real-PostgreSQL proof for migration 2400 RESTOCK POST ledger columns.
 *
 * Gated by RUN_DOCKER_TESTS=1. It starts a disposable `postgres:16-alpine`,
 * applies ALL migrations to that container URI only via a child process with an
 * explicit `DATABASE_URL` override (never an ambient value), and exercises the
 * actual CHECK constraints and the `down` data-loss guard. Test-only: it proves
 * the already-committed schema (2def7da); it makes no retroactive
 * pre-implementation RED claim.
 *
 * `beforeEach` TRUNCATEs the ephemeral tables. The downgrade test reapplies
 * migration 2400 in `finally`, so other cases do not depend on test order.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const LEGACY_KEY = 'a1b2c3d4e5f6';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const DECISION = '33333333-3333-4333-8333-333333333333';

type PostFields = {
  post_state?: string | null;
  backend_decision_id?: string | null;
  post_attempted_at?: Date | null;
  receipt_recorded_at?: Date | null;
  unknown_observed_at?: Date | null;
};

const failureOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    return `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`;
  }
  throw new Error('expected the command to fail');
};

ddescribe('restock post ledger migration (real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync('pnpm', ['migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE human_decision_reservations, human_handoff_requests',
    );
  });

  const migrate = (direction: 'migrate' | 'migrate:down') =>
    execFileSync('pnpm', [direction], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
  const migrateDown = () => migrate('migrate:down');

  const insert = (
    route: 'RESTOCK' | 'LEGACY_OPS',
    requestKey: string,
    intakeJson: string | null,
    fields: PostFields = {},
  ) =>
    pool.query(
      `INSERT INTO human_decision_reservations
         (sender_id, route, request_key, status, intake, post_state,
          backend_decision_id, post_attempted_at, receipt_recorded_at,
          unknown_observed_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4::jsonb, $5, $6, $7, $8, $9)`,
      [
        SENDER,
        route,
        requestKey,
        intakeJson,
        fields.post_state ?? null,
        fields.backend_decision_id ?? null,
        fields.post_attempted_at ?? null,
        fields.receipt_recorded_at ?? null,
        fields.unknown_observed_at ?? null,
      ],
    );
  const insertRestock = (fields: PostFields = {}) =>
    insert(
      'RESTOCK',
      SOURCE,
      JSON.stringify({ sourceRequestId: SOURCE }),
      fields,
    );
  const insertLegacy = (fields: PostFields = {}) =>
    insert('LEGACY_OPS', LEGACY_KEY, null, fields);

  it('accepts a valid RECEIPT_RECORDED row', async () => {
    const at = new Date();
    await expect(
      insertRestock({
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: DECISION,
        post_attempted_at: at,
        receipt_recorded_at: at,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects RECEIPT_RECORDED with a malformed backend UUID', async () => {
    const at = new Date();
    await expect(
      insertRestock({
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: 'not-a-uuid',
        post_attempted_at: at,
        receipt_recorded_at: at,
      }),
    ).rejects.toThrow(/backend_decision_id_check/);
  });

  it('rejects RECEIPT_RECORDED without post_attempted_at', async () => {
    await expect(
      insertRestock({
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: DECISION,
        receipt_recorded_at: new Date(),
      }),
    ).rejects.toThrow(/post_attempted_at_check/);
  });

  it('rejects RECEIPT_RECORDED without receipt_recorded_at', async () => {
    await expect(
      insertRestock({
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: DECISION,
        post_attempted_at: new Date(),
      }),
    ).rejects.toThrow(/receipt_recorded_at_check/);
  });

  it('rejects a missing or unknown RESTOCK post_state', async () => {
    await expect(insertRestock()).rejects.toThrow(/post_state_route_check/);
    await expect(insertRestock({ post_state: 'UNRECOGNIZED' })).rejects.toThrow(
      /post_state_route_check/,
    );
  });

  it('rejects RESERVED with a post_attempted_at timestamp', async () => {
    await expect(
      insertRestock({ post_state: 'RESERVED', post_attempted_at: new Date() }),
    ).rejects.toThrow(/post_attempted_at_check/);
  });

  it('accepts UNKNOWN before an attempt (null attempted, observed set)', async () => {
    await expect(
      insertRestock({
        post_state: 'UNKNOWN',
        unknown_observed_at: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects UNKNOWN without unknown_observed_at', async () => {
    await expect(insertRestock({ post_state: 'UNKNOWN' })).rejects.toThrow(
      /unknown_observed_at_check/,
    );
  });

  it('rejects LEGACY_OPS carrying a leaked backend id', async () => {
    await expect(
      insertLegacy({ post_state: null, backend_decision_id: DECISION }),
    ).rejects.toThrow(/backend_decision_id_check/);
  });

  it('rejects LEGACY_OPS carrying a non-null ledger timestamp', async () => {
    await expect(
      insertLegacy({ post_state: null, post_attempted_at: new Date() }),
    ).rejects.toThrow(/post_attempted_at_check/);
  });

  it('refuses down while a RESTOCK post row exists and preserves it', async () => {
    await insertRestock({ post_state: 'RESERVED' });
    const output = failureOf(migrateDown);
    expect(output).toMatch(/refusing to drop RESTOCK post ledger/);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM human_decision_reservations
       WHERE route = 'RESTOCK'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('downgrades after RESTOCK data is cleared, preserving LEGACY_OPS', async () => {
    await insertLegacy({ post_state: null });
    migrateDown();
    try {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM human_decision_reservations
         WHERE route = 'LEGACY_OPS'`,
      );
      expect(rows[0].n).toBe(1);
      const dropped = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'human_decision_reservations'
           AND column_name = 'post_state'`,
      );
      expect(dropped.rows).toHaveLength(0);
    } finally {
      migrate('migrate');
    }
    const restored = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM human_decision_reservations
       WHERE route = 'LEGACY_OPS'`,
    );
    expect(restored.rows[0].n).toBe(1);
  });
});
