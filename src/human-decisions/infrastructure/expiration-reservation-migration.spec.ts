/**
 * Offline `up`/`down` node-pg-migrate operation assertions for migration 270.
 * Runs no SQL and opens no connection; the gated Testcontainers spec owns the
 * real PostgreSQL behavior. Definitions are pinned exactly (contract, not just
 * substrings).
 */
export {};

type Op =
  | { op: 'dropConstraint'; table: string; name: string }
  | { op: 'addConstraint'; table: string; name: string; definition: string }
  | { op: 'sql'; sql: string };
type Pgm = {
  dropConstraint: (table: string, name: string) => void;
  addConstraint: (table: string, name: string, definition: string) => void;
  sql: (sql: string) => void;
};
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file lives outside the TypeScript project
  require('../../../migrations/2700000000000_expiration_reservations') as {
    up: (pgm: Pgm) => void;
    down: (pgm: Pgm) => void;
  };

const TABLE = 'human_decision_reservations';
const NAMES = [
  'human_decision_reservations_route_check',
  'human_decision_reservations_request_key_check',
  'human_decision_reservations_intake_check',
  'human_decision_reservations_post_state_route_check',
];
const KEYS = "ARRAY['sourceRequestId', 'type', 'productId', 'variantId']";
const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const L_KEY = "(route = 'LEGACY_OPS' AND request_key ~ '^[0-9a-f]{12}$')";
const R_KEY =
  "(route = 'RESTOCK' AND request_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')";
const L_INTAKE = "(route = 'LEGACY_OPS' AND intake IS NULL)";
const R_INTAKE =
  "(route = 'RESTOCK' AND intake IS NOT NULL AND jsonb_typeof(intake) = 'object' AND COALESCE((intake ->> 'sourceRequestId') = request_key, false))";
const L_POST = "(route = 'LEGACY_OPS' AND post_state IS NULL)";
const R_POST =
  "(route = 'RESTOCK' AND post_state IS NOT NULL AND post_state IN ('RESERVED', 'POST_IN_FLIGHT', 'RECEIPT_RECORDED', 'UNKNOWN'))";
const E_INTAKE = `(route = 'EXPIRATION' AND (intake IS NOT NULL AND jsonb_typeof(intake) = 'object' AND intake ?& ${KEYS} AND intake - ${KEYS} = '{}'::jsonb AND jsonb_typeof(intake -> 'sourceRequestId') = 'string' AND (intake ->> 'sourceRequestId') = request_key AND jsonb_typeof(intake -> 'type') = 'string' AND intake ->> 'type' = 'EXPIRATION' AND jsonb_typeof(intake -> 'productId') = 'string' AND (intake ->> 'productId') ~* '^${UUID}$' AND (intake -> 'variantId' = 'null'::jsonb OR (jsonb_typeof(intake -> 'variantId') = 'string' AND (intake ->> 'variantId') ~* '^${UUID}$'))) IS TRUE)`;
const WIDE = [
  "route IN ('LEGACY_OPS', 'RESTOCK', 'EXPIRATION')",
  `${L_KEY} OR ${R_KEY} OR (route = 'EXPIRATION' AND request_key ~* '^${UUID}$')`,
  `${L_INTAKE} OR ${R_INTAKE} OR ${E_INTAKE}`,
  `${L_POST} OR ${R_POST} OR (route = 'EXPIRATION' AND post_state IS NULL)`,
];
const ORIG = [
  "route IN ('LEGACY_OPS', 'RESTOCK')",
  `${L_KEY} OR ${R_KEY}`,
  `${L_INTAKE} OR ${R_INTAKE}`,
  `${L_POST} OR ${R_POST}`,
];
const SWAP = [
  'dropConstraint',
  'addConstraint',
  'dropConstraint',
  'addConstraint',
  'dropConstraint',
  'addConstraint',
  'dropConstraint',
  'addConstraint',
];
const run = (direction: 'up' | 'down') => {
  const ops: Op[] = [];
  const pgm: Pgm = {
    dropConstraint: (table, name) =>
      ops.push({ op: 'dropConstraint', table, name }),
    addConstraint: (table, name, definition) =>
      ops.push({ op: 'addConstraint', table, name, definition }),
    sql: (sql) => ops.push({ op: 'sql', sql }),
  };
  migration[direction](pgm);
  return ops;
};
const kinds = (ops: Op[]) => ops.map((op) => op.op);
const adds = (ops: Op[]) =>
  ops.filter(
    (op): op is Extract<Op, { op: 'addConstraint' }> =>
      op.op === 'addConstraint',
  );
const drops = (ops: Op[]) =>
  ops.filter(
    (op): op is Extract<Op, { op: 'dropConstraint' }> =>
      op.op === 'dropConstraint',
  );
const sqls = (ops: Op[]) =>
  ops.filter((op): op is Extract<Op, { op: 'sql' }> => op.op === 'sql');
const defs = (ops: Op[]) => adds(ops).map((op) => op.definition);

describe('270 EXPIRATION reservation migration (offline structure)', () => {
  it('up replaces exactly the four route/key/intake/post constraints in order', () => {
    const ops = run('up');
    expect(drops(ops).map((op) => op.name)).toEqual(NAMES);
    expect(adds(ops).map((op) => op.name)).toEqual(NAMES);
    expect(defs(ops)).toEqual(WIDE.map((def) => `CHECK (${def})`));
    expect(kinds(ops)).toEqual(SWAP);
    expect(ops.every((op) => op.op !== 'sql' && op.table === TABLE)).toBe(true);
  });

  it('down locks and refuses ANY EXPIRATION row, then restores the originals', () => {
    const ops = run('down');
    expect(kinds(ops)).toEqual(['sql', 'sql', ...SWAP]);
    expect(defs(ops)).toEqual(ORIG.map((def) => `CHECK (${def})`));
    const [lock, guard] = sqls(ops);
    expect(lock.sql).toMatch(
      /LOCK TABLE human_decision_reservations IN ACCESS EXCLUSIVE MODE/i,
    );
    expect(guard.sql).toContain("route = 'EXPIRATION'");
    expect(guard.sql).toContain('RAISE EXCEPTION');
    expect(guard.sql).not.toMatch(/\b(delete|truncate|update)\b/i);
  });
});
