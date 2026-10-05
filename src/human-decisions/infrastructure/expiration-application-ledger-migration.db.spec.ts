import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
// Disposable-PostgreSQL proof for migration 290, gated by RUN_DOCKER_TESTS=1.
// The migration child gets the container URI as its ONLY DATABASE_URL (never
// ambient); focused 280 -> 290 chain. SQL proves canonical-column binding and
// shape presence, not derived attempt identity, RFC UUID bits, instants, the
// 24h deadline or exact-key rejection (normalizer/trusted adapter own those).
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = `${ROOT}/node_modules/node-pg-migrate/bin/node-pg-migrate.js`;
const CONFIG = ['-f', 'package.json', '--config-value', 'pg-migrate'];
const TABLE = 'expiration_application_ledger';
const RESTOCK = 'restock_application_ledger';
const RESERVATIONS = 'human_decision_reservations';
const COUNT_LEDGER =
  'SELECT count(*)::int AS n FROM expiration_application_ledger';
const SELECT_LEDGER = 'SELECT * FROM expiration_application_ledger';
const SELECT_LEDGER_ROW = 'SELECT row_data FROM expiration_application_ledger';
const SELECT_RESTOCK =
  'SELECT * FROM restock_application_ledger ORDER BY decision_id';
const SELECT_RESERVATIONS =
  'SELECT * FROM human_decision_reservations ORDER BY sender_id';
const INSERT_LEDGER = `INSERT INTO expiration_application_ledger
  (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data)
  VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)`;
const INSERT_RESTOCK = `INSERT INTO restock_application_ledger
  (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data)
  VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)`;
const INSERT_RESERVATIONS = `INSERT INTO human_decision_reservations
  (sender_id, route, request_key, status, intake, post_state)
  VALUES ($1, 'RESTOCK', $2, 'ACTIVE', $3::jsonb, 'RESERVED')`;
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ATTEMPT = '6e57b252-319e-5a2c-a23e-d2bd5f5ebc43';
const OTHER = '11111111-2222-4333-8444-555555555555';
const TOKEN = '99999999-8888-4777-8666-555555555555';
const AT = '2026-09-25T10:00:00.000Z';
const ACCEPTED_AT = '2026-09-25T10:30:00.000Z';
const LATE = '2026-09-26T10:00:00.000Z';
const SENDER = 'whatsapp:+5215500000001';
const BRANCH = '  branch:\tEast  ';
type Row = Record<string, unknown>;
type Def = { name: string; def: string };
type Fields = {
  decision?: string;
  source?: string;
  attempt?: string;
  sender?: string;
  branch?: string;
  row?: Row;
};
const row = (state: string, patch: Row = {}): Row => ({
  senderId: SENDER,
  branchId: BRANCH,
  sourceRequestId: SOURCE,
  decisionId: DECISION,
  resolutionVersion: 2,
  attemptId: ATTEMPT,
  resolvedAt: AT,
  applyBefore: LATE,
  state,
  ...patch,
});
const pending = (patch: Row = {}): Row => row('PENDING_DELIVERY', patch);
const start = (state: string, patch: Row = {}): Row =>
  row(state, { sendToken: TOKEN, attemptedAt: AT, ...patch });
const accept = (state: string, patch: Row = {}): Row =>
  start(state, {
    providerMessageId: 'provider:1',
    providerAcceptedObservedAt: ACCEPTED_AT,
    ...patch,
  });
const stale = (patch: Row = {}): Row =>
  row('STALE', { staleObservedAt: LATE, ...patch });
const noField = (key: string): Row => {
  const copy = pending();
  delete copy[key];
  return copy;
};
const startNull = start('SEND_STARTED', { attemptedAt: null });
const COMPLETE = [
  pending(),
  start('SEND_STARTED'),
  accept('PROVIDER_ACCEPTED'),
  accept('PROVIDER_ACCEPTED_LATE', { providerAcceptedObservedAt: LATE }),
  stale(),
];
// Structural/evidence violations. PostgreSQL reports the alphabetically first
// failing CHECK, so evidence_* beats row_shape_* when both fail. Unknown keys
// and UUID-bit/instant gaps are deliberate SQL boundaries, not domain checks.
const BAD: [string, Row, string][] = [
  ['missing state', noField('state'), 'evidence_check'],
  ['null state', pending({ state: null }), 'evidence_check'],
  ['unknown state', row('UNKNOWN'), 'evidence_check'],
  ['string version', pending({ resolutionVersion: '2' }), 'row_shape_check'],
  ['null deadline', pending({ applyBefore: null }), 'row_shape_check'],
  ['missing field', noField('sourceRequestId'), 'identity_check'],
  ['pending token', pending({ sendToken: TOKEN }), 'evidence_check'],
  ['missing start', row('SEND_STARTED'), 'evidence_check'],
  ['null start time', startNull, 'evidence_check'],
  ['missing acceptance', start('PROVIDER_ACCEPTED'), 'evidence_check'],
  ['token on stale', stale({ sendToken: TOKEN }), 'evidence_check'],
  ['stale without time', row('STALE'), 'evidence_check'],
];
ddescribe(
  'EXPIRATION application ledger migration 290 (real PostgreSQL)',
  () => {
    jest.setTimeout(180_000);
    let container: StartedPostgreSqlContainer;
    let pool: Pool;
    const migrate = (direction: 'up' | 'down', ...args: string[]) =>
      execFileSync(process.execPath, [BIN, ...CONFIG, direction, ...args], {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 30_000,
      });
    const up = (target = '2900000000000') =>
      migrate('up', target, '--timestamp');
    const insert = (fields: Fields = {}) =>
      pool.query(INSERT_LEDGER, [
        fields.decision ?? DECISION,
        fields.source ?? SOURCE,
        fields.attempt ?? ATTEMPT,
        fields.sender ?? SENDER,
        fields.branch ?? BRANCH,
        JSON.stringify(fields.row ?? pending()),
      ]);
    const count = async (): Promise<number> =>
      (await pool.query<{ n: number }>(COUNT_LEDGER)).rows[0].n;
    const rejected = async (fields: Fields, constraint: string) => {
      const before = await count();
      await expect(insert(fields)).rejects.toMatchObject({
        code: '23514',
        constraint: `${TABLE}_${constraint}`,
      });
      expect(await count()).toBe(before);
    };
    const defs = async (table: string): Promise<Def[]> =>
      (
        await pool.query<Def>(
          `SELECT conname AS name, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
          [table],
        )
      ).rows;
    const read = async (sql: string, table: string) => ({
      rows: (await pool.query<Row>(sql)).rows,
      defs: await defs(table),
    });
    const book = async (): Promise<Row[]> =>
      (await pool.query<Row>('SELECT name FROM pgmigrations ORDER BY id')).rows;
    const snapshot = async () => ({
      restock: await read(SELECT_RESTOCK, RESTOCK),
      reservations: await read(SELECT_RESERVATIONS, RESERVATIONS),
      book: await book(),
    });
    const guard = () =>
      expect(() => migrate('down')).toThrow(/refusing to roll back/);
    let pre: Awaited<ReturnType<typeof snapshot>>;
    let post: typeof pre;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      up('2800000000000');
      pool = new Pool({ connectionString: container.getConnectionUri() });
      // Pre-290 data; RESTOCK keeps upper-case JSON ids with lower-case columns,
      // exercising the case-folding alias policy that 290 deliberately rejects.
      const aliased = row('PENDING_DELIVERY', {
        senderId: 'sender',
        branchId: 'branch',
        sourceRequestId: SOURCE.toUpperCase(),
        decisionId: DECISION.toUpperCase(),
        attemptId: ATTEMPT.toUpperCase(),
      });
      await pool.query(INSERT_RESTOCK, [
        DECISION,
        SOURCE,
        ATTEMPT,
        'sender',
        'branch',
        JSON.stringify(aliased),
      ]);
      await pool.query(INSERT_RESERVATIONS, [
        'sender:restock',
        SOURCE,
        JSON.stringify({ sourceRequestId: SOURCE }),
      ]);
      pre = await snapshot();
      up();
      post = await snapshot();
    });
    afterAll(async () => {
      try {
        if (pool) await pool.end();
      } finally {
        if (container) await container.stop();
      }
    });
    beforeEach(async () => {
      await pool.query('TRUNCATE TABLE expiration_application_ledger');
    });

    it('preserves RESTOCK/reservation data, constraints and metadata across 280 -> 290', () => {
      expect(post).toMatchObject({
        restock: pre.restock,
        reservations: pre.reservations,
      });
      expect(pre.restock.rows).toHaveLength(1);
      expect(pre.reservations.rows).toHaveLength(1);
      expect(JSON.stringify(pre.restock.rows[0].row_data)).toContain(
        DECISION.toUpperCase(),
      );
      expect(post.book.slice(0, -1)).toEqual(pre.book);
      expect(String(post.book.at(-1)?.name)).toContain(
        'expiration_application_ledger',
      );
    });
    it('creates six inert columns, a decision PK/unique attempt and no ACK', async () => {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 ORDER BY ordinal_position`,
        [TABLE],
      );
      expect(rows.map((entry) => entry.column_name).join()).toBe(
        'decision_id,source_request_id,attempt_id,sender_id,branch_id,row_data',
      );
      const byName = Object.fromEntries(
        (await defs(TABLE)).map((entry) => [entry.name, entry.def]),
      );
      expect(byName[`${TABLE}_pkey`]).toContain('PRIMARY KEY (decision_id)');
      expect(byName[`${TABLE}_attempt_id_key`]).toContain(
        'UNIQUE (attempt_id)',
      );
    });
    it('accepts all five snapshots and enforces PK/attempt uniqueness', async () => {
      for (const data of COMPLETE) {
        await insert({ row: data });
        // Insert success also proves stored bytes equal the padded JSON identity.
        expect((await pool.query<Row>(SELECT_LEDGER_ROW)).rows).toEqual([
          { row_data: data },
        ]);
        await pool.query('TRUNCATE TABLE expiration_application_ledger');
      }
      await insert();
      await expect(
        insert({
          decision: DECISION,
          attempt: TOKEN,
          row: { ...pending(), attemptId: TOKEN },
        }),
      ).rejects.toMatchObject({ code: '23505', constraint: `${TABLE}_pkey` });
      await expect(
        insert({
          decision: OTHER,
          attempt: ATTEMPT,
          row: { ...pending(), decisionId: OTHER },
        }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: `${TABLE}_attempt_id_key`,
      });
      expect(await count()).toBe(1);
    });
    it.each(BAD)(
      'rejects %s with an unchanged count',
      (_label, data, constraint) => rejected({ row: data }, constraint),
    );
    it('rejects binding mismatches and case aliases (stricter than RESTOCK)', async () => {
      for (const key of ['sourceRequestId', 'decisionId', 'attemptId'] as const)
        await rejected(
          {
            row: { ...pending(), [key]: String(pending()[key]).toUpperCase() },
          },
          'identity_check',
        );
      for (const fields of [
        { sender: ` ${SENDER} ` },
        { branch: BRANCH.trim() },
        { sender: '   ' },
        { branch: '   ' },
        { row: { ...pending(), decisionId: OTHER } },
        { row: { ...pending(), attemptId: TOKEN } },
        { row: { ...pending(), sourceRequestId: OTHER } },
      ] as Fields[])
        await rejected(fields, 'identity_check');
    });
    it('guards DOWN: nonempty refuses intact; empty drops leaving RESTOCK intact', async () => {
      await insert();
      const before = {
        ...(await read(SELECT_LEDGER, TABLE)),
        book: await book(),
      };
      guard();
      expect({
        ...(await read(SELECT_LEDGER, TABLE)),
        book: await book(),
      }).toEqual(before);
      await pool.query('TRUNCATE TABLE expiration_application_ledger');
      migrate('down');
      expect(
        (
          await pool.query<Row>('SELECT to_regclass($1) AS name', [
            'public.expiration_application_ledger',
          ])
        ).rows,
      ).toEqual([{ name: null }]);
      expect((await read(SELECT_RESTOCK, RESTOCK)).rows).toHaveLength(1);
      expect((await read(SELECT_RESERVATIONS, RESERVATIONS)).rows).toHaveLength(
        1,
      );
      expect(await defs(RESTOCK)).toEqual(pre.restock.defs);
      expect(await defs(RESERVATIONS)).toEqual(pre.reservations.defs);
      up();
    });
  },
);
