import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/** SQL structural proof for committed migration 250; no retroactive RED claim. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATE_BIN = join(
  REPO_ROOT,
  'node_modules',
  'node-pg-migrate',
  'bin',
  'node-pg-migrate.js',
);
const CONFIG = [
  '--config-file',
  'package.json',
  '--config-value',
  'pg-migrate',
];
const TARGET = '2500000000000';
const TABLE = 'restock_application_ledger';
const SOURCE = 'aaaaaaaa-1111-4111-8111-111111111111';
const DECISION = 'bbbbbbbb-3333-4333-8333-333333333333';
const OTHER_DECISION = '44444444-4444-4444-8444-444444444444';
const ATTEMPT = 'cccccccc-5555-4555-8555-555555555555';
const OTHER_ATTEMPT = '66666666-6666-4666-8666-666666666666';
const SENDER = '  whatsapp:+5215500000001  ';
const BRANCH = '  branch:East  ';
const at = '2026-06-22T01:02:03.004Z';
const late = '2026-06-22T02:02:03.004Z';
const common = () => ({
  senderId: SENDER,
  branchId: BRANCH,
  sourceRequestId: SOURCE.toUpperCase(),
  decisionId: DECISION.toUpperCase(),
  attemptId: ATTEMPT.toUpperCase(),
  resolutionVersion: 2,
  resolvedAt: at,
  applyBefore: late,
});
const started = () => ({ sendToken: OTHER_ATTEMPT, attemptedAt: at });
const accepted = () => ({
  ...started(),
  providerMessageId: '  provider:Opaque  ',
  providerAcceptedObservedAt: late,
});
const ack = (outcome: string) => ({
  id: DECISION.toUpperCase(),
  version: 2,
  attemptId: ATTEMPT.toUpperCase(),
  outcome,
  ackReceivedAt: '  reported:Opaque  ',
});
const states = [
  ['PENDING_DELIVERY', () => ({})],
  ['SEND_STARTED', started],
  ['PROVIDER_ACCEPTED', accepted],
  ['PROVIDER_ACCEPTED_LATE', accepted],
  ['STALE', () => ({ staleObservedAt: late })],
] as const;

type Fields = {
  decision?: string;
  source?: string;
  attempt?: string;
  sender?: string;
  branch?: string;
  row?: unknown;
  receipt?: unknown;
};

ddescribe('restock application ledger migration (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  // Child migration process and Pool are bound exclusively to this container URI.
  const run = (direction: 'up' | 'down', ...args: string[]) =>
    execFileSync('node', [MIGRATE_BIN, ...CONFIG, direction, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
  const runUp = () => run('up', TARGET, '--timestamp');
  const runDown = () => run('down');
  const row = (state: string, evidence: Record<string, unknown> = {}) => ({
    ...common(),
    state,
    ...evidence,
  });
  const insert = (fields: Fields = {}) =>
    pool.query(
      `INSERT INTO restock_application_ledger
         (decision_id, source_request_id, attempt_id, sender_id, branch_id,
          row_data, ack_receipt)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        fields.decision ?? DECISION,
        fields.source ?? SOURCE,
        fields.attempt ?? ATTEMPT,
        fields.sender ?? SENDER,
        fields.branch ?? BRANCH,
        JSON.stringify(fields.row ?? row('PENDING_DELIVERY')),
        fields.receipt === undefined ? null : JSON.stringify(fields.receipt),
      ],
    );
  const rejected = async (
    fields: Fields,
    constraint: string,
    code = '23514',
  ) => {
    try {
      await insert(fields);
    } catch (error) {
      expect(error).toMatchObject(constraint ? { code, constraint } : { code });
      return;
    }
    throw new Error(`expected PostgreSQL ${constraint} rejection`);
  };
  const guardFailure = () => {
    try {
      runDown();
    } catch (error) {
      const output = error as { stdout?: Buffer; stderr?: Buffer };
      expect(
        `${String(output.stdout ?? '')}${String(output.stderr ?? '')}`,
      ).toContain(
        'refusing to roll back restock_application_ledger: table is non-empty',
      );
      return;
    }
    throw new Error('expected the nonempty down guard to refuse');
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    runUp();
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
    await pool.query('TRUNCATE TABLE restock_application_ledger');
  });

  it.each([SOURCE, DECISION, ATTEMPT])(
    'uses case-distinct UUID fixture %s',
    (id) => {
      expect(id.toUpperCase()).not.toBe(id);
    },
  );

  it('roundtrips all five snapshots, opaque bytes, UUID case and SQL NULL ACK', async () => {
    for (const [state, evidence] of states) {
      const snapshot = row(state, evidence());
      await insert({ row: snapshot });
      const { rows } = await pool.query(
        `SELECT decision_id::text AS decision, source_request_id::text AS source,
                attempt_id::text AS attempt, sender_id, branch_id,
                row_data, ack_receipt FROM restock_application_ledger`,
      );
      expect(rows).toEqual([
        {
          decision: DECISION,
          source: SOURCE,
          attempt: ATTEMPT,
          sender_id: SENDER,
          branch_id: BRANCH,
          row_data: snapshot,
          ack_receipt: null,
        },
      ]);
      await pool.query('TRUNCATE TABLE restock_application_ledger');
    }
  });

  it('preserves padded opaque timestamp and provider strings without parsing dates', async () => {
    const snapshot = {
      ...row('PROVIDER_ACCEPTED', accepted()),
      resolvedAt: `  ${at}  `,
      applyBefore: `  ${late}  `,
      attemptedAt: `  ${at}  `,
      providerAcceptedObservedAt: `  ${late}  `,
    };
    await insert({ row: snapshot });
    const { rows } = await pool.query(
      'SELECT row_data FROM restock_application_ledger',
    );
    expect(rows).toEqual([{ row_data: snapshot }]);
  });

  it('accepts exactly bound terminal ACKs for accepted, late and stale', async () => {
    for (const [state, evidence] of states.slice(2)) {
      const receipt = ack(state);
      await insert({ row: row(state, evidence()), receipt });
      const { rows } = await pool.query(
        `SELECT decision_id::text AS decision, attempt_id::text AS attempt,
                ack_receipt FROM restock_application_ledger`,
      );
      expect(rows).toEqual([
        { decision: DECISION, attempt: ATTEMPT, ack_receipt: receipt },
      ]);
      await pool.query('TRUNCATE TABLE restock_application_ledger');
    }
  });

  it('rejects missing/null/unknown states and malformed common shape/version', async () => {
    const missing: Record<string, unknown> = row('PENDING_DELIVERY');
    delete missing.state;
    for (const candidate of [
      missing,
      row('PENDING_DELIVERY', { state: null }),
      row('UNKNOWN'),
    ])
      await rejected({ row: candidate }, `${TABLE}_evidence_check`);
    for (const candidate of [
      { ...row('PENDING_DELIVERY'), resolutionVersion: '2' },
      { ...row('PENDING_DELIVERY'), applyBefore: null },
    ])
      await rejected({ row: candidate }, `${TABLE}_row_shape_check`);
    await rejected(
      { row: { ...row('PENDING_DELIVERY'), senderId: 3 } },
      `${TABLE}_identity_check`,
    );
  });

  it('rejects malformed UUIDs and mismatched exact sender/branch/identity bindings', async () => {
    for (const fields of [
      { decision: 'bad-uuid' },
      { source: 'bad-uuid' },
      { attempt: 'bad-uuid' },
    ])
      await rejected(fields, '', '22P02');
    for (const fields of [
      { row: { ...row('PENDING_DELIVERY'), sourceRequestId: 'bad-uuid' } },
      { row: { ...row('PENDING_DELIVERY'), decisionId: OTHER_DECISION } },
      { row: { ...row('PENDING_DELIVERY'), attemptId: OTHER_ATTEMPT } },
      { sender: SENDER.trim() },
      { branch: BRANCH.trim() },
      { sender: '  ' },
    ])
      await rejected(fields, `${TABLE}_identity_check`);
  });

  it('requires state evidence and forbids foreign evidence even when JSON null', async () => {
    for (const candidate of [
      row('PENDING_DELIVERY', { sendToken: null }),
      row('SEND_STARTED'),
      row('SEND_STARTED', { ...started(), attemptedAt: null }),
      row('SEND_STARTED', { ...started(), providerMessageId: null }),
      row('PROVIDER_ACCEPTED', started()),
      row('PROVIDER_ACCEPTED_LATE', { ...accepted(), staleObservedAt: null }),
      row('STALE'),
      row('STALE', { staleObservedAt: late, sendToken: null }),
    ])
      await rejected({ row: candidate }, `${TABLE}_evidence_check`);
  });

  it('distinguishes SQL NULL ACK from JSON null and rejects ACK on nonterminal states', async () => {
    await rejected({ receipt: null }, `${TABLE}_ack_check`);
    for (const state of ['PENDING_DELIVERY', 'SEND_STARTED'])
      await rejected(
        {
          row: row(state, state === 'SEND_STARTED' ? started() : {}),
          receipt: ack(state),
        },
        `${TABLE}_ack_check`,
      );
  });

  it('rejects unbound, malformed, incomplete and nonterminal ACKs', async () => {
    const terminal = row('STALE', { staleObservedAt: late });
    for (const receipt of [
      { ...ack('STALE'), id: OTHER_DECISION },
      { ...ack('STALE'), attemptId: OTHER_ATTEMPT },
      { ...ack('STALE'), version: '2' },
      { ...ack('STALE'), outcome: 'PROVIDER_ACCEPTED' },
      { ...ack('STALE'), outcome: 'SEND_STARTED' },
      { ...ack('STALE'), extra: null },
      { ...ack('STALE'), ackReceivedAt: null },
      { id: DECISION, version: 2, attemptId: ATTEMPT, outcome: 'STALE' },
    ])
      await rejected({ row: terminal, receipt }, `${TABLE}_ack_check`);
  });

  it('enforces case-insensitive decision PK and distinct-decision attempt uniqueness', async () => {
    await insert();
    await rejected(
      { decision: DECISION.toUpperCase() },
      `${TABLE}_pkey`,
      '23505',
    );
    await rejected(
      {
        decision: OTHER_DECISION,
        attempt: ATTEMPT.toUpperCase(),
        row: { ...row('PENDING_DELIVERY'), decisionId: OTHER_DECISION },
      },
      `${TABLE}_attempt_id_key`,
      '23505',
    );
  });

  it('refuses down for even a pending row, then drops empty table and restores 250', async () => {
    await insert();
    guardFailure();
    const before = await pool.query(
      'SELECT row_data FROM restock_application_ledger',
    );
    expect(before.rows).toEqual([{ row_data: row('PENDING_DELIVERY') }]);
    await pool.query('TRUNCATE TABLE restock_application_ledger');
    try {
      runDown();
      const absent = await pool.query(
        "SELECT to_regclass('public.restock_application_ledger') AS table_name",
      );
      expect(absent.rows).toEqual([{ table_name: null }]);
    } finally {
      runUp();
    }
    const restored = await pool.query(
      "SELECT to_regclass('public.restock_application_ledger') IS NOT NULL AS present",
    );
    expect(restored.rows).toEqual([{ present: true }]);
  });
});
