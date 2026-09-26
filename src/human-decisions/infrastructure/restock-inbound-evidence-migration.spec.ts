/** Offline mock-pgm assertions, NOT PostgreSQL semantics proof.
 * Actual CHECK/lock behavior requires a later Testcontainers unit.
 */
export {};

type Column = { type: string; notNull?: boolean; primaryKey?: boolean };
type Op =
  | { op: 'createTable'; table: string; columns: Record<string, Column> }
  | { op: 'addConstraint'; table: string; name: string; definition: string }
  | { op: 'sql'; sql: string }
  | { op: 'dropTable'; table: string };
type Pgm = {
  createTable: (table: string, columns: Record<string, Column>) => void;
  addConstraint: (table: string, name: string, definition: string) => void;
  sql: (sql: string) => void;
  dropTable: (table: string) => void;
};
type Migration = { up: (pgm: Pgm) => void; down: (pgm: Pgm) => void };
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS migration outside TS project
  require('../../../migrations/2600000000000_restock_inbound_evidence') as Migration;
const TABLE = 'restock_inbound_evidence';
const run = (direction: 'up' | 'down'): Op[] => {
  const ops: Op[] = [];
  migration[direction]({
    createTable: (table, columns) =>
      ops.push({ op: 'createTable', table, columns }),
    addConstraint: (table, name, definition) =>
      ops.push({ op: 'addConstraint', table, name, definition }),
    sql: (sql) => ops.push({ op: 'sql', sql }),
    dropTable: (table) => ops.push({ op: 'dropTable', table }),
  });
  return ops;
};
const constraints = () =>
  run('up').filter(
    (op): op is Extract<Op, { op: 'addConstraint' }> =>
      op.op === 'addConstraint',
  );
const check = (suffix: string) => {
  const found = constraints().find(
    (op) => op.name === `${TABLE}_${suffix}_check`,
  );
  expect(found).toBeDefined();
  return found!.definition;
};

describe('inbound evidence up (source only)', () => {
  it('requires exactly seven explicit fields without defaults or ancillary payload', () => {
    const first = run('up')[0];
    expect(first.op).toBe('createTable');
    if (first.op !== 'createTable') throw new Error('expected createTable');
    expect(first.table).toBe(TABLE);
    expect(Object.keys(first.columns).sort()).toEqual([
      'message_id',
      'observed_at',
      'provider_timestamp_seconds',
      'receiving_phone_number_id',
      'sender_id',
      'source_request_id',
      'version',
    ]);
    for (const [name, column] of Object.entries(first.columns)) {
      expect(column.type).toBe(
        name === 'source_request_id'
          ? 'uuid'
          : name === 'version'
            ? 'integer'
            : 'text',
      );
      expect(column.notNull).toBe(true);
      expect(Object.keys(column).sort()).toEqual(
        name === 'source_request_id'
          ? ['notNull', 'primaryKey', 'type']
          : ['notNull', 'type'],
      );
      expect(column.primaryKey).toBe(
        name === 'source_request_id' ? true : undefined,
      );
    }
  });

  it('isolates all operations and supplies only the exact tuple unique plus six checks', () => {
    const ops = run('up');
    expect(ops.map((op) => op.op)).toEqual([
      'createTable',
      ...Array<string>(7).fill('addConstraint'),
    ]);
    expect(ops.every((op) => 'table' in op && op.table === TABLE)).toBe(true);
    const unique = constraints().filter((op) =>
      op.definition.startsWith('UNIQUE'),
    );
    expect(unique).toHaveLength(1);
    expect(unique[0].definition).toBe(
      'UNIQUE (receiving_phone_number_id, sender_id, message_id)',
    );
    const checks = constraints().filter((op) =>
      op.definition.startsWith('CHECK'),
    );
    expect(checks).toHaveLength(6);
    expect(new Set(constraints().map((op) => op.name)).size).toBe(7);
    for (const entry of checks)
      expect(entry.definition).toMatch(/^CHECK \(\([\s\S]*\) IS TRUE\)$/);
    expect(JSON.stringify(ops)).not.toMatch(
      /processed_webhook_messages|conversation|reservation|application_ledger|\bNOW\b|CURRENT_TIMESTAMP|INSERT|UPDATE|DELETE|TRIGGER/i,
    );
  });

  it('requires version one and bounded ASCII receiving phone without transforming bytes', () => {
    expect(check('version')).toBe('CHECK ((version = 1) IS TRUE)');
    expect(check('phone')).toBe(
      "CHECK ((receiving_phone_number_id ~ '^[0-9]{1,24}$') IS TRUE)",
    );
  });

  it.each([
    ['sender_id', 200],
    ['message_id', 512],
  ] as const)(
    'bounds %s and rejects empty/outer ordinary spaces structurally',
    (column, max) => {
      const sql = check(column);
      expect(sql).toContain(`char_length(${column}) BETWEEN 1 AND ${max}`);
      expect(sql).toContain(`btrim(${column}) <> ''`);
      expect(sql).toContain(`${column} = btrim(${column})`);
    },
  );

  it('guards numeric conversion with canonical positive seconds shape and Date maximum', () => {
    const sql = check('provider_seconds');
    expect(sql).toMatch(
      /CASE WHEN provider_timestamp_seconds ~ '\^\[1-9\]\[0-9\]\{0,12\}\$'\s+THEN provider_timestamp_seconds::numeric <= 8640000000000\s+ELSE FALSE END/,
    );
    expect(sql).not.toMatch(/::(?:integer|bigint)|COALESCE|IS NULL/i);
  });

  it('keeps observation text with millisecond UTC shape including positive extended years', () => {
    const sql = check('observed_at');
    expect(sql).toContain("btrim(observed_at) <> ''");
    expect(sql).toContain(
      "observed_at ~ '^([0-9]{4}|[+][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'",
    );
    expect(sql).not.toMatch(
      /::|now|CURRENT_TIMESTAMP|provider_timestamp_seconds/i,
    );
  });
});

describe('inbound evidence down (source order only)', () => {
  it('locks before the unconditional any-row guard and drops only this table', () => {
    const ops = run('down');
    expect(ops.map((op) => op.op)).toEqual(['sql', 'sql', 'dropTable']);
    if (ops[0].op !== 'sql' || ops[1].op !== 'sql')
      throw new Error('expected SQL');
    expect(ops[0].sql).toBe(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE;`);
    expect(ops[1].sql).toContain(`IF EXISTS (SELECT 1 FROM ${TABLE}) THEN`);
    expect(ops[1].sql).toContain('RAISE EXCEPTION');
    expect(ops[1].sql).toContain('table is non-empty');
    expect(ops[1].sql).not.toMatch(
      /\b(WHERE|DELETE|TRUNCATE|UPDATE|INSERT|COMMIT)\b/i,
    );
    expect(ops[2]).toEqual({ op: 'dropTable', table: TABLE });
  });
});
