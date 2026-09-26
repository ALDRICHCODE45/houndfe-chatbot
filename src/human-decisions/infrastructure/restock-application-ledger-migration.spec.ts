/** Offline node-pg-migrate operation assertions; no SQL execution or DB connection. */
export {};

type Op =
  | { op: 'createTable'; table: string; columns: Record<string, unknown> }
  | { op: 'addConstraint'; table: string; name: string; definition: string }
  | { op: 'sql'; sql: string }
  | { op: 'dropTable'; table: string };
type Pgm = {
  createTable: (table: string, columns: Record<string, unknown>) => void;
  addConstraint: (table: string, name: string, definition: string) => void;
  sql: (sql: string) => void;
  dropTable: (table: string) => void;
};
type Migration = { up: (pgm: Pgm) => void; down: (pgm: Pgm) => void };
const migration =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS node-pg-migrate file outside TS project
  require('../../../migrations/2500000000000_restock_application_ledger') as Migration;
const TABLE = 'restock_application_ledger';
const run = (direction: 'up' | 'down'): Op[] => {
  const ops: Op[] = [];
  const pgm: Pgm = {
    createTable: (table, columns) =>
      ops.push({ op: 'createTable', table, columns }),
    addConstraint: (table, name, definition) =>
      ops.push({ op: 'addConstraint', table, name, definition }),
    sql: (sql) => ops.push({ op: 'sql', sql }),
    dropTable: (table) => ops.push({ op: 'dropTable', table }),
  };
  migration[direction](pgm);
  return ops;
};
const checks = () =>
  run('up').filter(
    (op): op is Extract<Op, { op: 'addConstraint' }> =>
      op.op === 'addConstraint',
  );
const check = (suffix: string) => {
  const found = checks().find((op) => op.name.endsWith(suffix));
  expect(found).toBeDefined();
  return found!.definition;
};

describe('up (source shape only)', () => {
  it('creates only the isolated table with its PK, attempt unique, and JSON storage', () => {
    const ops = run('up');
    expect(ops[0]).toEqual({
      op: 'createTable',
      table: TABLE,
      columns: {
        decision_id: { type: 'uuid', primaryKey: true },
        source_request_id: { type: 'uuid', notNull: true },
        attempt_id: { type: 'uuid', notNull: true, unique: true },
        sender_id: { type: 'text', notNull: true },
        branch_id: { type: 'text', notNull: true },
        row_data: { type: 'jsonb', notNull: true },
        ack_receipt: { type: 'jsonb' },
      },
    });
    expect(ops.every((op) => 'table' in op && op.table === TABLE)).toBe(true);
    expect(ops.filter((op) => op.op === 'createTable')).toHaveLength(1);
    expect(ops.every((op) => op.op !== 'sql')).toBe(true);
    expect(
      checks().every(
        (op) =>
          op.definition.startsWith('CHECK (') &&
          op.definition.endsWith('IS TRUE)'),
      ),
    ).toBe(true);
  });

  it('requires object row, typed common primitives, five states and numeric version 2', () => {
    const shape = check('row_shape_check');
    expect(shape).toContain("jsonb_typeof(row_data) = 'object'");
    for (const field of [
      'senderId',
      'branchId',
      'sourceRequestId',
      'decisionId',
      'attemptId',
      'resolvedAt',
      'applyBefore',
      'state',
    ])
      expect(shape).toContain(
        `jsonb_typeof(row_data -> '${field}') = 'string'`,
      );
    expect(shape).toContain("row_data -> 'resolutionVersion' = '2'::jsonb");
    for (const state of [
      'PENDING_DELIVERY',
      'SEND_STARTED',
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
      'STALE',
    ])
      expect(shape).toContain(`'${state}'`);
    expect(shape).not.toContain('DELIVERY_UNKNOWN');
  });

  it('binds canonical UUID text case-insensitively and sender/branch bytes exactly', () => {
    const identity = check('identity_check');
    for (const [column, field] of [
      ['source_request_id', 'sourceRequestId'],
      ['decision_id', 'decisionId'],
      ['attempt_id', 'attemptId'],
    ]) {
      expect(identity).toContain(`row_data ->> '${field}'`);
      expect(identity).toContain(
        `lower(row_data ->> '${field}') = ${column}::text`,
      );
    }
    expect(identity).toContain('~*');
    for (const [column, field] of [
      ['sender_id', 'senderId'],
      ['branch_id', 'branchId'],
    ]) {
      expect(identity).toContain(`row_data ->> '${field}' = ${column}`);
      expect(identity).toContain(`btrim(${column}) <> ''`);
    }
    expect(identity).not.toContain('btrim(sender_id) =');
  });

  it('limits optional state evidence to its own state and type', () => {
    const evidence = check('evidence_check');
    for (const field of [
      'sendToken',
      'attemptedAt',
      'providerMessageId',
      'providerAcceptedObservedAt',
      'staleObservedAt',
    ])
      expect(evidence).toContain(field);
    expect(evidence).toMatch(
      /state' = 'PENDING_DELIVERY' AND NOT \(row_data \? 'sendToken'\)/,
    );
    expect(evidence).toMatch(
      /state' = 'SEND_STARTED' AND jsonb_typeof\(row_data -> 'sendToken'\) = 'string'/,
    );
    expect(evidence).toMatch(
      /state' = 'STALE' AND jsonb_typeof\(row_data -> 'staleObservedAt'\) = 'string'/,
    );
    expect(evidence).toContain("NOT (row_data ? 'providerMessageId')");
    expect(evidence).toContain("NOT (row_data ? 'staleObservedAt')");
  });

  it('allows SQL-null ACK only, otherwise requires exact five typed keys bound to terminal state', () => {
    const ack = check('ack_check');
    expect(ack).toContain('ack_receipt IS NULL OR');
    expect(ack).toContain("jsonb_typeof(ack_receipt) = 'object'");
    expect(ack).toContain(') IS TRUE');
    expect(ack).toContain(
      "ack_receipt ?& ARRAY['id', 'version', 'attemptId', 'outcome', 'ackReceivedAt']",
    );
    expect(ack).toContain(
      "ack_receipt - ARRAY['id', 'version', 'attemptId', 'outcome', 'ackReceivedAt'] = '{}'::jsonb",
    );
    expect(ack).toContain("ack_receipt -> 'version' = '2'::jsonb");
    for (const field of ['id', 'attemptId', 'outcome', 'ackReceivedAt'])
      expect(ack).toContain(
        `jsonb_typeof(ack_receipt -> '${field}') = 'string'`,
      );
    expect(ack).toContain("lower(ack_receipt ->> 'id') = decision_id::text");
    expect(ack).toContain(
      "lower(ack_receipt ->> 'attemptId') = attempt_id::text",
    );
    expect(ack).toContain("ack_receipt ->> 'outcome' = row_data ->> 'state'");
    for (const state of [
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
      'STALE',
    ])
      expect(ack).toContain(`'${state}'`);
    expect(ack).not.toContain('DELIVERY_UNKNOWN');
  });
});

describe('down (source order only)', () => {
  it('takes exclusive table lock before refusing any row and only then drops', () => {
    const ops = run('down');
    expect(ops.map((op) => op.op)).toEqual(['sql', 'sql', 'dropTable']);
    if (ops[0].op !== 'sql' || ops[1].op !== 'sql')
      throw new Error('expected SQL');
    expect(ops[0].sql).toMatch(
      /LOCK TABLE restock_application_ledger IN ACCESS EXCLUSIVE MODE/i,
    );
    expect(ops[1].sql).toContain(`IF EXISTS (SELECT 1 FROM ${TABLE})`);
    expect(ops[1].sql).toContain('RAISE EXCEPTION');
    expect(ops[1].sql).not.toMatch(/\b(delete|truncate)\b/i);
    expect(ops[2]).toEqual({ op: 'dropTable', table: TABLE });
  });
});
