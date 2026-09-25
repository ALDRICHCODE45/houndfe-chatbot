/**
 * HD-R3b3-c2 structural spec for the RESTOCK POST ledger migration (2400).
 *
 * OFFLINE STRUCTURE ONLY: it records the node-pg-migrate operations queued by
 * `up`/`down` and asserts their content and queued order. It runs no SQL and
 * opens no connection; the gated Testcontainers spec owns the real PostgreSQL
 * constraint behavior.
 */
export {};

type Op =
  | {
      readonly op: 'addColumns';
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
      readonly op: 'dropConstraint';
      readonly table: string;
      readonly name: string;
    }
  | {
      readonly op: 'dropColumns';
      readonly table: string;
      readonly columns: readonly string[];
    }
  | { readonly op: 'sql'; readonly sql: string };
type Pgm = {
  addColumns: (table: string, columns: Record<string, unknown>) => void;
  addConstraint: (table: string, name: string, definition: string) => void;
  dropConstraint: (table: string, name: string) => void;
  dropColumns: (table: string, columns: readonly string[]) => void;
  sql: (text: string) => void;
};
type MigrationModule = { up: (pgm: Pgm) => void; down: (pgm: Pgm) => void };

const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/2400000000000_restock_intake_post_ledger') as MigrationModule;

const TABLE = 'human_decision_reservations';
const COLUMNS = [
  'post_state',
  'backend_decision_id',
  'post_attempted_at',
  'receipt_recorded_at',
  'unknown_observed_at',
];
const CHECKS = [
  'human_decision_reservations_post_state_route_check',
  'human_decision_reservations_backend_decision_id_check',
  'human_decision_reservations_post_attempted_at_check',
  'human_decision_reservations_receipt_recorded_at_check',
  'human_decision_reservations_unknown_observed_at_check',
];

function record(): { ops: Op[]; pgm: Pgm } {
  const ops: Op[] = [];
  return {
    ops,
    pgm: {
      addColumns: (table, columns) =>
        ops.push({ op: 'addColumns', table, columns }),
      addConstraint: (table, name, definition) =>
        ops.push({ op: 'addConstraint', table, name, definition }),
      dropConstraint: (table, name) =>
        ops.push({ op: 'dropConstraint', table, name }),
      dropColumns: (table, columns) =>
        ops.push({ op: 'dropColumns', table, columns }),
      sql: (sql) => ops.push({ op: 'sql', sql }),
    },
  };
}
const of = <K extends Op['op']>(ops: Op[], op: K) =>
  ops.filter((entry): entry is Extract<Op, { op: K }> => entry.op === op);
const definition = (ops: Op[], name: string) =>
  of(ops, 'addConstraint').find((entry) => entry.name === name)?.definition;
const run = (direction: 'up' | 'down') => {
  const { ops, pgm } = record();
  migration[direction](pgm);
  return ops;
};

describe('up', () => {
  it('adds the five nullable post columns on the shared table', () => {
    const columns = of(run('up'), 'addColumns');
    expect(columns).toHaveLength(1);
    expect(columns[0].table).toBe(TABLE);
    expect(columns[0].columns).toEqual({
      post_state: { type: 'text' },
      backend_decision_id: { type: 'text' },
      post_attempted_at: { type: 'timestamptz' },
      receipt_recorded_at: { type: 'timestamptz' },
      unknown_observed_at: { type: 'timestamptz' },
    });
  });

  it('adds the five checks in order', () => {
    const checks = of(run('up'), 'addConstraint');
    expect(checks.map((entry) => entry.name)).toEqual(CHECKS);
    expect(checks.every((entry) => entry.table === TABLE)).toBe(true);
    expect(
      checks.every((entry) => entry.definition.startsWith('CHECK (')),
    ).toBe(true);
  });

  it('requires a RESTOCK post_state and rejects a missing/null one', () => {
    const state = definition(run('up'), CHECKS[0]);
    expect(state).toContain("route = 'LEGACY_OPS' AND post_state IS NULL");
    expect(state).toContain("route = 'RESTOCK' AND post_state IS NOT NULL");
    expect(state).toContain(
      "post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN')",
    );
  });

  it('keeps the id and timestamp checks strictly boolean (no fail-open)', () => {
    const ops = run('up');
    const backend = definition(ops, CHECKS[1]);
    expect(backend).toContain(
      "COALESCE(post_state = 'RECEIPT_RECORDED', false)",
    );
    expect(backend).toContain('~*');
    for (const name of CHECKS.slice(2)) {
      expect(definition(ops, name)).toMatch(/COALESCE\(|IS TRUE/);
    }
    expect(definition(ops, CHECKS[2])).toContain(
      "WHEN post_state = 'UNKNOWN' THEN TRUE",
    );
  });
});

describe('down', () => {
  it('queues the data-loss guard, then drops checks and columns in order', () => {
    const ops = run('down');
    const guard = of(ops, 'sql');
    expect(guard).toHaveLength(1);
    expect(guard[0].sql).toContain(`FROM ${TABLE}`);
    expect(guard[0].sql).toContain("route = 'RESTOCK'");
    expect(guard[0].sql).toContain('post_state IS NOT NULL');
    expect(guard[0].sql).toContain('RAISE EXCEPTION');
    expect(guard[0].sql).not.toMatch(/\b(delete|truncate)\b/i);
    expect(of(ops, 'dropConstraint').map((entry) => entry.name)).toEqual(
      CHECKS,
    );
    const columns = of(ops, 'dropColumns');
    expect(columns).toHaveLength(1);
    expect(columns[0].columns).toEqual(COLUMNS);
    const kinds = ops.map((entry) => entry.op);
    expect(kinds[0]).toBe('sql');
    expect(kinds.at(-1)).toBe('dropColumns');
  });
});
