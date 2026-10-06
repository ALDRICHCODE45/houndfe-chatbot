import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';

// Only disposable PostgreSQL: never inherit an ambient DATABASE_URL.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const BIN = `${ROOT}/node_modules/node-pg-migrate/bin/node-pg-migrate.js`;
const TABLE = 'expiration_application_ledger';
const CHECK = `${TABLE}_ack_check`;
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const AT = '2026-09-25T10:00:00.000Z';
const DEADLINE = '2026-09-26T10:00:00.000Z';
const STATES = [
  'PENDING_DELIVERY',
  'SEND_STARTED',
  'PROVIDER_ACCEPTED',
  'PROVIDER_ACCEPTED_LATE',
  'STALE',
];
const fixtures = STATES.map((state, i) => {
  const decisionId = `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5${i}`;
  return {
    senderId: `customer:${i}`,
    branchId: ' branch ',
    sourceRequestId: SOURCE,
    decisionId,
    attemptId: deriveExpirationAttemptId(SOURCE, decisionId)!,
    resolutionVersion: 2,
    resolvedAt: AT,
    applyBefore: DEADLINE,
    state,
    ...(state === 'STALE' ? { staleObservedAt: DEADLINE } : {}),
    ...([
      'SEND_STARTED',
      'PROVIDER_ACCEPTED',
      'PROVIDER_ACCEPTED_LATE',
    ].includes(state)
      ? { sendToken: '99999999-8888-4777-8666-555555555555', attemptedAt: AT }
      : {}),
    ...(state.startsWith('PROVIDER_')
      ? {
          providerMessageId: ' opaque ',
          providerAcceptedObservedAt:
            state === 'PROVIDER_ACCEPTED' ? AT : DEADLINE,
        }
      : {}),
  };
});
const receipt = (i: number) => ({
  id: fixtures[i].decisionId,
  version: 2,
  attemptId: fixtures[i].attemptId,
  outcome: fixtures[i].state,
  ackReceivedAt: '2026-09-26T04:01:00-06:00',
});

ddescribe('EXPIRATION ACK migration 300 (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const migrate = (direction: 'up' | 'down', ...args: string[]) =>
    execFileSync(
      process.execPath,
      [
        BIN,
        '-f',
        'package.json',
        '--config-value',
        'pg-migrate',
        direction,
        ...args,
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
  const up = () => migrate('up', '3000000000000', '--timestamp');
  const rows = async () =>
    (
      await pool.query(
        'SELECT * FROM expiration_application_ledger ORDER BY decision_id',
      )
    ).rows as Record<string, unknown>[];
  const book = async () =>
    (await pool.query('SELECT name FROM pgmigrations ORDER BY id'))
      .rows as Record<string, unknown>[];
  const constraints = async () =>
    (
      await pool.query(
        'SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname',
        [TABLE],
      )
    ).rows as Record<string, unknown>[];
  const columns = async () =>
    (
      await pool.query(
        'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position',
        [TABLE],
      )
    ).rows as Record<string, unknown>[];
  const update = (value: unknown, i = 2) =>
    pool.query(
      'UPDATE expiration_application_ledger SET ack_receipt=$1::jsonb WHERE decision_id=$2',
      [JSON.stringify(value), fixtures[i].decisionId],
    );
  let baseline: Awaited<ReturnType<typeof rows>>;
  let oldBook: Awaited<ReturnType<typeof book>>;
  let oldConstraints: Awaited<ReturnType<typeof constraints>>;
  let oldColumns: Awaited<ReturnType<typeof columns>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    migrate('up', '2900000000000', '--timestamp');
    pool = new Pool({ connectionString: container.getConnectionUri() });
    for (const row of fixtures) {
      await pool.query(
        `INSERT INTO expiration_application_ledger
        (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          row.decisionId,
          row.sourceRequestId,
          row.attemptId,
          row.senderId,
          row.branchId,
          JSON.stringify(row),
        ],
      );
    }
    baseline = await rows();
    oldBook = await book();
    oldConstraints = await constraints();
    oldColumns = await columns();
    up();
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });
  afterEach(async () => {
    await pool.query(
      'UPDATE expiration_application_ledger SET ack_receipt=NULL',
    );
  });

  it('adds nullable JSONB without changing existing rows, columns or constraints', async () => {
    expect(await columns()).toEqual([
      ...oldColumns,
      {
        column_name: 'ack_receipt',
        data_type: 'jsonb',
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
    expect(await rows()).toEqual(
      baseline.map((row) => ({ ...row, ack_receipt: null })),
    );
    expect((await constraints()).filter((c) => c.conname !== CHECK)).toEqual(
      oldConstraints,
    );
    const migrated = await book();
    expect(migrated.slice(0, -1)).toEqual(oldBook);
    expect(migrated.at(-1)?.name).toBe(
      '3000000000000_expiration_application_ack',
    );
  });
  it.each([2, 3, 4])(
    'stores an exact terminal ACK without changing row_data (%i)',
    async (i) => {
      const ack = receipt(i);
      expect((await update(ack, i)).rowCount).toBe(1);
      expect(await rows()).toEqual(
        baseline.map((row, index) => ({
          ...row,
          ack_receipt: index === i ? ack : null,
        })),
      );
    },
  );
  it.each([
    null,
    [],
    'ACK',
    {},
    { ...receipt(2), id: fixtures[3].decisionId },
    { ...receipt(2), id: fixtures[2].decisionId.toUpperCase() },
    { ...receipt(2), attemptId: fixtures[3].attemptId },
    { ...receipt(2), attemptId: fixtures[2].attemptId.toUpperCase() },
    { ...receipt(2), version: '2' },
    { ...receipt(2), version: 1 },
    { ...receipt(2), outcome: 'STALE' },
    { ...receipt(2), ackReceivedAt: null },
    { ...receipt(2), ackReceivedAt: 123 },
    { ...receipt(2), evidenceCode: null },
    ...Object.keys(receipt(2)).map((missing) =>
      Object.fromEntries(
        Object.entries(receipt(2)).filter(([key]) => key !== missing),
      ),
    ),
  ])(
    'rejects malformed/mismatched ACK %# without changing stored data',
    async (ack) => {
      const before = await rows();
      await expect(update(ack)).rejects.toMatchObject({
        code: '23514',
        constraint: CHECK,
      });
      expect(await rows()).toEqual(before);
    },
  );
  it.each([0, 1])(
    'forbids an ACK on nonterminal row %i even when identity and outcome match',
    async (i) => {
      const before = await rows();
      await expect(update(receipt(i), i)).rejects.toMatchObject({
        code: '23514',
        constraint: CHECK,
      });
      expect(await rows()).toEqual(before);
    },
  );
  it('retains existing row identity checks', async () => {
    const before = await rows();
    await expect(
      pool.query(`UPDATE expiration_application_ledger
      SET row_data=jsonb_set(row_data, '{decisionId}', '"different"'::jsonb)`),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: `${TABLE}_identity_check`,
    });
    expect(await rows()).toEqual(before);
  });
  it('leaves timestamp semantics to the domain, not SQL shape checks', async () => {
    const ack = { ...receipt(2), ackReceivedAt: 'not an instant' };
    await update(ack);
    expect((await rows())[2]).toEqual({ ...baseline[2], ack_receipt: ack });
  });
  it('refuses rollback with any ACK and preserves evidence, schema and migration metadata', async () => {
    await update(receipt(2));
    const before = {
      rows: await rows(),
      columns: await columns(),
      constraints: await constraints(),
      book: await book(),
    };
    expect(() => migrate('down')).toThrow(
      /refusing to roll back expiration ACK storage/,
    );
    expect({
      rows: await rows(),
      columns: await columns(),
      constraints: await constraints(),
      book: await book(),
    }).toEqual(before);
  });
  it('rolls back a populated all-NULL ACK column without dropping ledger rows, then reapplies', async () => {
    migrate('down');
    expect(await rows()).toEqual(baseline);
    expect(await columns()).toEqual(oldColumns);
    expect(await constraints()).toEqual(oldConstraints);
    expect(await book()).toEqual(oldBook);
    up();
    expect(await rows()).toEqual(
      baseline.map((row) => ({ ...row, ack_receipt: null })),
    );
  });
});
