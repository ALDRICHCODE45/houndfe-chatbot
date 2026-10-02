import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

// Real-PostgreSQL proof for migration 270, gated by RUN_DOCKER_TESTS=1. A
// disposable `postgres:16-alpine` only; the migration child gets the generated
// container URI as its ONLY `DATABASE_URL` (never ambient) and runs focused
// `up 260 -> seed -> up 270` targets, never a blanket migrate. No existing
// DB/container/volume/production resource is touched. The shared baseline
// (seed pre-270 LEGACY_OPS/RESTOCK rows, apply 270, snapshot pre/post rows and
// original/widened constraint defs) lives in `beforeAll`, so name-filtered `-t`
// runs still work; tests needing a clean table rely on the per-test TRUNCATE.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = `${ROOT}/node_modules/node-pg-migrate/bin/node-pg-migrate.js`;
const CONFIG = ['-f', 'package.json', '--config-value', 'pg-migrate'];
const TABLE = 'human_decision_reservations';
const LEGACY = 'a1b2c3d4e5f6';
const A = 'whatsapp:+5215500000001';
const B = 'whatsapp:+5215500000002';
const C = 'whatsapp:+5215500000003';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const UPPER = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const VARIANT = '33333333-3333-4333-8333-333333333333';
const NIL = '00000000-0000-0000-0000-000000000000';
const V0 = '11111111-1111-0111-8111-111111111111';
const VC = '11111111-1111-4111-c111-111111111111';
const AT = new Date('2026-01-01T00:00:00.000Z');
const CHECKS = [
  `${TABLE}_route_check`,
  `${TABLE}_request_key_check`,
  `${TABLE}_intake_check`,
  `${TABLE}_post_state_route_check`,
];
const POST = [
  'post_state',
  'backend_decision_id',
  'post_attempted_at',
  'receipt_recorded_at',
  'unknown_observed_at',
] as const;
type Post = Partial<Record<(typeof POST)[number], string | Date>>;
type SnapRow = { route: string; status: string } & Record<string, unknown>;
const INSERT = `INSERT INTO human_decision_reservations (sender_id, route, request_key, status, intake, post_state, backend_decision_id, post_attempted_at, receipt_recorded_at, unknown_observed_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`;

ddescribe('EXPIRATION reservation migration (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let uri: string;
  let originalDefs: Record<string, string>;
  let widenedDefs: Record<string, string>;
  let preRows: SnapRow[];
  let postRows: SnapRow[];

  const migrate = (...args: string[]) =>
    execFileSync(process.execPath, [BIN, ...CONFIG, ...args], {
      cwd: ROOT,
      env: { DATABASE_URL: uri },
      stdio: 'pipe',
    });
  const up = (target: string) => migrate('up', target, '--timestamp');
  const failureOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
      return `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`;
    }
    throw new Error('expected the command to fail');
  };
  const insert = (
    route: string,
    key: string,
    intake: unknown,
    post: Post = {},
    sender = A,
    status = 'ACTIVE',
  ) =>
    pool.query(INSERT, [
      sender,
      route,
      key,
      status,
      intake == null ? null : JSON.stringify(intake),
      ...POST.map((column) => post[column] ?? null),
    ]);
  const legacy = (sender: string) =>
    insert('LEGACY_OPS', LEGACY, null, {}, sender);
  const restock = (post: Post, sender: string) =>
    insert('RESTOCK', SOURCE, { sourceRequestId: SOURCE }, post, sender);
  const expiration = (
    patch: Record<string, unknown> = {},
    key = SOURCE,
    post: Post = {},
    sender = A,
    status = 'ACTIVE',
  ) =>
    insert(
      'EXPIRATION',
      key,
      {
        sourceRequestId: key,
        type: 'EXPIRATION',
        productId: PRODUCT,
        variantId: null,
        ...patch,
      },
      post,
      sender,
      status,
    );
  const rejected = (value: Promise<unknown>, check: string): Promise<void> =>
    expect(value).rejects.toMatchObject({
      code: '23514',
      constraint: `${TABLE}_${check}`,
    });
  const count = async (sql: string): Promise<number> =>
    (await pool.query<{ n: number }>(sql)).rows[0].n;
  const rows = () =>
    count('SELECT count(*)::int AS n FROM human_decision_reservations');
  const scopedRows = async (): Promise<SnapRow[]> =>
    (
      await pool.query<SnapRow>(
        `SELECT sender_id, route, request_key, status, intake, post_state,
                backend_decision_id, post_attempted_at, receipt_recorded_at,
                unknown_observed_at
         FROM ${TABLE} ORDER BY sender_id, route, request_key`,
      )
    ).rows;
  const constraintDefs = async (): Promise<Record<string, string>> => {
    const definitions = Object.fromEntries(
      (
        await pool.query<{ name: string; def: string }>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conname = ANY($1)`,
          [CHECKS],
        )
      ).rows.map((row) => [row.name, row.def] as const),
    );
    expect(Object.keys(definitions).sort()).toEqual([...CHECKS].sort());
    return definitions;
  };
  const bookkeeping = async (): Promise<Record<string, unknown>[]> =>
    (
      await pool.query<Record<string, unknown>>(
        `SELECT id, name, run_on FROM pgmigrations
         WHERE name LIKE '270%' ORDER BY id`,
      )
    ).rows;
  const snapshot = async () => ({
    rows: await scopedRows(),
    defs: await constraintDefs(),
    book: await bookkeeping(),
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    uri = container.getConnectionUri();
    up('2600000000000');
    pool = new Pool({ connectionString: uri });
    originalDefs = await constraintDefs();
    await legacy(B);
    await restock({ post_state: 'RESERVED' }, C);
    preRows = await scopedRows();
    up('2700000000000');
    widenedDefs = await constraintDefs();
    postRows = await scopedRows();
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE human_decision_reservations');
  });

  it('keeps pre-270 LEGACY_OPS/RESTOCK rows and widens the route check', () => {
    expect(postRows).toEqual(preRows);
    expect(preRows).toHaveLength(2);
    expect(preRows.map((row) => row.route).sort()).toEqual([
      'LEGACY_OPS',
      'RESTOCK',
    ]);
    expect(widenedDefs[`${TABLE}_route_check`]).toContain('EXPIRATION');
    expect(widenedDefs).not.toEqual(originalDefs);
  });

  it('binds mixed-case keys byte-exactly and accepts an explicit variant', async () => {
    await expect(expiration({}, UPPER)).resolves.toBeDefined();
    await expect(
      expiration(
        { sourceRequestId: SOURCE, variantId: VARIANT },
        SOURCE,
        {},
        B,
      ),
    ).resolves.toBeDefined();
    await rejected(
      expiration({ sourceRequestId: UPPER.toLowerCase() }, UPPER),
      'intake_check',
    );
  });

  it.each([NIL, V0, VC, 'not-a-uuid'])(
    'rejects forbidden EXPIRATION key %s',
    (key) => rejected(expiration({}, key), 'request_key_check'),
  );

  it.each<[string, Record<string, unknown>]>([
    ['missing sourceRequestId', { sourceRequestId: undefined }],
    ['missing type', { type: undefined }],
    ['missing productId', { productId: undefined }],
    ['missing variantId', { variantId: undefined }],
    ['extra key', { tenantId: SOURCE }],
    ['wrong type', { type: 'RESTOCK' }],
    ['null type', { type: null }],
    ['non-string type', { type: 1 }],
    ['null sourceRequestId', { sourceRequestId: null }],
    ['malformed productId', { productId: 'x' }],
    ['nil productId', { productId: NIL }],
    ['malformed variantId', { variantId: 'x' }],
    ['nil variantId', { variantId: NIL }],
    ['wrong-variant variantId', { variantId: VC }],
  ])('rejects malformed EXPIRATION intake (%s)', (_label, patch) =>
    rejected(expiration(patch), 'intake_check'),
  );

  it.each<[string, () => Promise<unknown>]>([
    ['SQL NULL', () => insert('EXPIRATION', SOURCE, null)],
    [
      'top-level JSON null',
      () =>
        pool.query(
          `INSERT INTO human_decision_reservations
             (sender_id, route, request_key, status, intake)
           VALUES ($1, 'EXPIRATION', $2, 'ACTIVE', 'null'::jsonb)`,
          [A, SOURCE],
        ),
    ],
  ])('rejects EXPIRATION %s intake', (_label, run) =>
    rejected(run(), 'intake_check'),
  );

  it.each<[string, Post]>([
    ['post_state_route_check', { post_state: 'RESERVED' }],
    ['backend_decision_id_check', { backend_decision_id: PRODUCT }],
    ['post_attempted_at_check', { post_attempted_at: AT }],
    ['receipt_recorded_at_check', { receipt_recorded_at: AT }],
    ['unknown_observed_at_check', { unknown_observed_at: AT }],
  ])('rejects EXPIRATION non-null POST %s', (check, post) =>
    rejected(expiration({}, SOURCE, post), check),
  );

  it('keeps LEGACY_OPS/RESTOCK branch semantics', async () => {
    await expect(legacy(A)).resolves.toBeDefined();
    await expect(restock({ post_state: 'RESERVED' }, B)).resolves.toBeDefined();
    await rejected(
      insert('LEGACY_OPS', 'bad-key', null, {}, C),
      'request_key_check',
    );
    await rejected(
      insert(
        'LEGACY_OPS',
        'ffffffffffff',
        { sourceRequestId: 'ffffffffffff' },
        {},
        C,
      ),
      'intake_check',
    );
    await rejected(
      insert(
        'RESTOCK',
        PRODUCT,
        { sourceRequestId: SOURCE },
        { post_state: 'RESERVED' },
        C,
      ),
      'intake_check',
    );
  });

  it('keeps replay/sender uniqueness, indexdefs and cross-route arbitration', async () => {
    await expiration({}, SOURCE);
    await expect(expiration({}, SOURCE, {}, A, 'CLOSED')).rejects.toMatchObject(
      {
        code: '23505',
        constraint: `${TABLE}_route_request_key_idx`,
      },
    );
    await pool.query('TRUNCATE TABLE human_decision_reservations');
    const settled = await Promise.allSettled([
      expiration({}, SOURCE),
      restock({ post_state: 'RESERVED' }, A),
    ]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({
      code: '23505',
      constraint: `${TABLE}_active_sender_idx`,
    });
    expect(
      await count(
        `SELECT count(*)::int AS n FROM ${TABLE} WHERE status = 'ACTIVE'`,
      ),
    ).toBe(1);
    await pool.query('TRUNCATE TABLE human_decision_reservations');
    await expiration({}, SOURCE, {}, A, 'CLOSED');
    await expect(restock({ post_state: 'RESERVED' }, A)).resolves.toBeDefined();
    const { rows: defs } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [TABLE],
    );
    const text = defs.map((row) => row.indexdef).join('\n');
    expect(text).toMatch(/UNIQUE INDEX .* \(route, request_key\)/);
    expect(text).toMatch(
      /UNIQUE INDEX .* \(sender_id\) WHERE \(status = 'ACTIVE'::text\)/,
    );
  });

  it('refuses down for EXPIRATION ACTIVE then CLOSED without data/schema loss', async () => {
    await expiration({}, SOURCE);
    const refuse = () => failureOf(() => migrate('down'));
    const active = await snapshot();
    expect(refuse()).toMatch(/refusing to revert EXPIRATION constraints/);
    expect(await snapshot()).toEqual(active);
    await pool.query(
      "UPDATE human_decision_reservations SET status = 'CLOSED'",
    );
    const closed = await snapshot();
    expect(refuse()).toMatch(/refusing to revert EXPIRATION constraints/);
    expect(await snapshot()).toEqual(closed);
  });

  it('downgrades and reapplies with only LEGACY_OPS/RESTOCK rows preserved', async () => {
    await legacy(A);
    await restock({ post_state: 'RESERVED' }, B);
    migrate('down');
    expect(await constraintDefs()).toEqual(originalDefs);
    expect(await rows()).toBe(2);
    await expect(expiration({}, PRODUCT, {}, C)).rejects.toMatchObject({
      code: '23514',
    });
    up('2700000000000');
    expect(await constraintDefs()).toEqual(widenedDefs);
    expect(await rows()).toBe(2);
    await expect(expiration({}, PRODUCT, {}, C)).resolves.toBeDefined();
  });
});
