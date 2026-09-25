/**
 * HD-R3b2a structural spec for the shared human-decision reservation migration.
 *
 * OFFLINE STRUCTURE ONLY: it records the node-pg-migrate operations queued by
 * `up`/`down` and asserts their content and queued order. It runs no SQL,
 * opens no connection, and proves no CAS, unique-index arbitration or DB race;
 * the R3b2b Postgres adapter owns real database/race proof.
 */
type PgmOp =
  | {
      readonly op: 'createTable';
      readonly table: string;
      readonly columns: Record<string, unknown>;
    }
  | {
      readonly op: 'addConstraint';
      readonly table: string;
      readonly name: string;
      readonly definition: string;
    }
  | {
      readonly op: 'createIndex';
      readonly table: string;
      readonly columns: string | readonly string[];
      readonly options: Record<string, unknown>;
    }
  | { readonly op: 'sql'; readonly sql: string }
  | { readonly op: 'dropTable'; readonly table: string };
type PgmRecorder = {
  func: (expression: string) => { readonly func: string };
  createTable: (table: string, columns: Record<string, unknown>) => void;
  addConstraint: (table: string, name: string, definition: string) => void;
  createIndex: (
    table: string,
    columns: string | readonly string[],
    options?: Record<string, unknown>,
  ) => void;
  sql: (text: string) => void;
  dropTable: (table: string) => void;
};
type MigrationModule = {
  up: (pgm: PgmRecorder) => void;
  down: (pgm: PgmRecorder) => void;
};

const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/2300000000000_human_decision_reservations') as MigrationModule;

const TABLE = 'human_decision_reservations';
const REPLAY_INDEX = 'human_decision_reservations_route_request_key_idx';
const SENDER_INDEX = 'human_decision_reservations_active_sender_idx';
const SENDER_ACTIVE = "status = 'ACTIVE'";
const ROUTE_KEY_CHECK =
  "(route = 'LEGACY_OPS' AND request_key ~ '^[0-9a-f]{12}$') OR (route = 'RESTOCK' AND request_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')";
const INTAKE_CHECK =
  "(route = 'LEGACY_OPS' AND intake IS NULL) OR (route = 'RESTOCK' AND intake IS NOT NULL AND jsonb_typeof(intake) = 'object' AND COALESCE((intake ->> 'sourceRequestId') = request_key, false))";

function record(): { ops: PgmOp[]; pgm: PgmRecorder } {
  const ops: PgmOp[] = [];
  return {
    ops,
    pgm: {
      func: (func) => ({ func }),
      createTable: (table, columns) =>
        ops.push({ op: 'createTable', table, columns }),
      addConstraint: (table, name, definition) =>
        ops.push({ op: 'addConstraint', table, name, definition }),
      createIndex: (table, columns, options = {}) =>
        ops.push({ op: 'createIndex', table, columns, options }),
      sql: (sql) => ops.push({ op: 'sql', sql }),
      dropTable: (table) => ops.push({ op: 'dropTable', table }),
    },
  };
}

const of = <K extends PgmOp['op']>(ops: PgmOp[], op: K) =>
  ops.filter((entry): entry is Extract<PgmOp, { op: K }> => entry.op === op);
const definition = (ops: PgmOp[], name: string) =>
  of(ops, 'addConstraint').find((entry) => entry.name === name)?.definition;
const run = (direction: 'up' | 'down') => {
  const { ops, pgm } = record();
  migration[direction](pgm);
  return ops;
};

describe('up', () => {
  it('creates the shared table with exact columns and defaults', () => {
    const tables = of(run('up'), 'createTable');
    expect(tables[0].table).toBe(TABLE);
    expect(tables[0].columns).toEqual({
      sender_id: { type: 'text', notNull: true },
      route: { type: 'text', notNull: true },
      request_key: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'ACTIVE' },
      intake: { type: 'jsonb' },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: { func: 'now()' },
      },
      updated_at: {
        type: 'timestamptz',
        notNull: true,
        default: { func: 'now()' },
      },
    });
  });

  it('binds route, status, nonblank sender, and route-bound key/intake checks', () => {
    const ops = run('up');
    const checks = of(ops, 'addConstraint');
    expect(checks).toHaveLength(5);
    expect(checks.every((entry) => entry.table === TABLE)).toBe(true);
    expect(definition(ops, 'human_decision_reservations_route_check')).toBe(
      "CHECK (route IN ('LEGACY_OPS', 'RESTOCK'))",
    );
    expect(definition(ops, 'human_decision_reservations_status_check')).toBe(
      "CHECK (status IN ('ACTIVE', 'CLOSED'))",
    );
    expect(
      definition(ops, 'human_decision_reservations_sender_nonblank_check'),
    ).toBe("CHECK (btrim(sender_id) <> '')");
    expect(
      definition(ops, 'human_decision_reservations_request_key_check'),
    ).toBe(`CHECK (${ROUTE_KEY_CHECK})`);
    expect(definition(ops, 'human_decision_reservations_intake_check')).toBe(
      `CHECK (${INTAKE_CHECK})`,
    );
  });

  it('forces the RESTOCK source-id equality to a strict boolean (fail closed)', () => {
    const intake = definition(
      run('up'),
      'human_decision_reservations_intake_check',
    );
    expect(intake).toBeDefined();
    // A missing/null sourceRequestId makes `intake ->> 'sourceRequestId' =
    // request_key` evaluate to UNKNOWN, and PostgreSQL CHECK only rejects
    // FALSE, so the bare equality would silently accept a malformed RESTOCK
    // row. The predicate must collapse UNKNOWN to FALSE.
    expect(intake).toMatch(
      /COALESCE\(\s*\(?\s*intake ->> 'sourceRequestId'\s*\)?\s*=\s*request_key\s*,\s*false\s*\)/,
    );
    expect(intake).not.toMatch(
      /jsonb_typeof\(intake\) = 'object' AND intake ->> 'sourceRequestId' = request_key/,
    );
  });

  it('adds replay identity and one cross-route ACTIVE sender unique index', () => {
    const indexes = of(run('up'), 'createIndex');
    expect(indexes).toHaveLength(2);
    expect(indexes[0]).toMatchObject({
      table: TABLE,
      columns: ['route', 'request_key'],
      options: { name: REPLAY_INDEX, unique: true },
    });
    expect(indexes[1]).toMatchObject({
      table: TABLE,
      columns: 'sender_id',
      options: { name: SENDER_INDEX, unique: true, where: SENDER_ACTIVE },
    });
  });

  it('orders table, checks, ACTIVE sender index, then backfill; never drops', () => {
    const ops = run('up');
    const senderIndex = ops.findIndex(
      (entry) => entry.op === 'createIndex' && entry.columns === 'sender_id',
    );
    const backfill = ops.findIndex((entry) => entry.op === 'sql');
    const kinds = ops.map((entry) => entry.op);
    expect(kinds[0]).toBe('createTable');
    expect(kinds).not.toContain('dropTable');
    expect(kinds.indexOf('createIndex')).toBeGreaterThan(
      kinds.lastIndexOf('addConstraint'),
    );
    expect(senderIndex).toBeGreaterThan(-1);
    expect(senderIndex).toBeLessThan(backfill);
    expect(kinds.at(-1)).toBe('sql');
  });

  it('backfills only pending rows as ACTIVE LEGACY_OPS keyed by id/customer_id', () => {
    const backfill = of(run('up'), 'sql');
    expect(backfill).toHaveLength(1);
    const sql = backfill[0].sql;
    expect(sql).toContain(`INSERT INTO ${TABLE}`);
    expect(sql).toContain('(sender_id, route, request_key, status, intake)');
    expect(sql).toContain(
      "SELECT customer_id, 'LEGACY_OPS', id, 'ACTIVE', NULL",
    );
    expect(sql).toContain('FROM human_handoff_requests');
    expect(sql).toContain("WHERE status = 'pending'");
    expect(sql).not.toMatch(/on conflict|distinct|limit/i);
  });
});

describe('down', () => {
  it('queues the nonempty guard before dropping the table', () => {
    const ops = run('down');
    const guard = of(ops, 'sql');
    const drops = of(ops, 'dropTable');
    expect(guard).toHaveLength(1);
    expect(drops).toHaveLength(1);
    expect(guard[0].sql).toContain(`EXISTS (SELECT 1 FROM ${TABLE})`);
    expect(guard[0].sql).toContain('RAISE EXCEPTION');
    expect(guard[0].sql).not.toMatch(/\b(delete|truncate)\b/i);
    expect(ops.findIndex((entry) => entry.op === 'sql')).toBeLessThan(
      ops.findIndex((entry) => entry.op === 'dropTable'),
    );
    expect(drops[0].table).toBe(TABLE);
  });
});
