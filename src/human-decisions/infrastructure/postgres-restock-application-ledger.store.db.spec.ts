import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import { normalizeRestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import { PostgresRestockApplicationLedgerStore } from './postgres-restock-application-ledger.store';

// Integration proof for committed INSERT/read only; no retroactive RED.
// CAS, send, reservation, 24h eligibility, ownership, history and provider
// provenance are untested. Distinct sessions do not force every lock schedule.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const SOURCE = 'AAAAAAAA-1111-4111-8111-111111111111';
const DECISION = 'BBBBBBBB-3333-4333-8333-333333333333';
const OTHER = 'CCCCCCCC-4444-4444-8444-444444444444';
const pending = () => ({
  state: 'PENDING_DELIVERY' as const,
  senderId: 'fixture:Sender',
  branchId: '  branch:East  ',
  sourceRequestId: SOURCE,
  decisionId: DECISION,
  resolutionVersion: 2 as const,
  attemptId: deriveRestockAttemptId(SOURCE, DECISION)!,
  resolvedAt: '2026-06-22T01:00:00.000Z',
  applyBefore: '2026-06-22T02:00:00.000Z',
});
const started = () => ({
  ...pending(),
  state: 'SEND_STARTED' as const,
  sendToken: OTHER,
  attemptedAt: '2026-06-22T01:30:00.000Z',
});
const terminal = () => ({
  ...started(),
  state: 'PROVIDER_ACCEPTED' as const,
  providerMessageId: '  fixture:Provider  ',
  providerAcceptedObservedAt: '2026-06-22T01:31:00.000Z',
});
const receipt = () => ({
  id: DECISION.toLowerCase(),
  version: 2,
  attemptId: pending().attemptId.toUpperCase(),
  outcome: 'PROVIDER_ACCEPTED',
  ackReceivedAt: '2020-01-01T00:00:00Z',
});

ddescribe('restock INSERT/read adapter (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let first: Pool;
  let second: Pool;
  let writer: PostgresRestockApplicationLedgerStore;
  let reader: PostgresRestockApplicationLedgerStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    // Only this disposable URI reaches the migration child. Never log it.
    try {
      execFileSync(
        'node',
        [
          join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
          '--config-file',
          'package.json',
          '--config-value',
          'pg-migrate',
          'up',
          '2500000000000',
          '--timestamp',
        ],
        {
          cwd: ROOT,
          env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
          stdio: 'pipe',
        },
      );
    } catch {
      throw new Error('Disposable fixture migration to 250 failed');
    }
    first = new Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
    });
    second = new Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
    });
    writer = new PostgresRestockApplicationLedgerStore(first);
    reader = new PostgresRestockApplicationLedgerStore(second);
  });
  afterAll(async () => {
    try {
      await Promise.all([first?.end(), second?.end()]);
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await first.query('TRUNCATE TABLE restock_application_ledger');
  });

  const persisted = async () =>
    (
      await second.query<{
        row_data: unknown;
        ack_receipt: unknown;
        revision: string;
      }>(
        'SELECT row_data, ack_receipt, xmin::text AS revision FROM restock_application_ledger',
      )
    ).rows;
  // Direct SQL is test fixture setup, NOT a newly implemented durable state
  // transition or ACK recording API. The schema is weaker than domain parsing.
  const seed = (
    row: ReturnType<typeof pending> | Record<string, unknown>,
    ack: unknown = null,
  ) =>
    first.query(
      `INSERT INTO restock_application_ledger
       (decision_id, source_request_id, attempt_id, sender_id, branch_id, row_data, ack_receipt)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        row.decisionId,
        row.sourceRequestId,
        row.attemptId,
        row.senderId,
        row.branchId,
        JSON.stringify(row),
        ack === null ? null : JSON.stringify(ack),
      ],
    );

  it('uses two live independent PostgreSQL sessions', async () => {
    const a = await first.connect();
    try {
      const b = await second.connect();
      try {
        const [left, right] = await Promise.all([
          a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
          b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
        ]);
        expect(left.rows[0].pid).not.toBe(right.rows[0].pid);
      } finally {
        b.release();
      }
    } finally {
      a.release();
    }
  });

  it('inserts and reads an exact detached frozen snapshot across pools', async () => {
    const input = pending();
    const expected = { ...input };
    expect(normalizeRestockApplicationLedgerRow(input)).toEqual(input);
    const inserted = await writer.insertPending(input);
    expect(inserted).toEqual({ action: 'inserted', row: expected });
    if (inserted.action !== 'inserted') throw new Error('expected inserted');
    const found = await reader.readByDecision(DECISION.toLowerCase());
    expect(found).toEqual({ action: 'found', row: expected, ack: null });
    if (found.action !== 'found') throw new Error('expected found');
    for (const value of [inserted, inserted.row, found, found.row])
      expect(Object.isFrozen(value)).toBe(true);
    expect(inserted.row).not.toBe(input);
    expect(found.row).not.toBe(inserted.row);
    input.branchId = 'mutated';
    expect(found.row).toEqual(expected);
    expect(await reader.readByDecision(DECISION)).toEqual(found);
    expect(await persisted()).toEqual([
      {
        row_data: expected,
        ack_receipt: null,
        revision: expect.any(String) as unknown,
      },
    ]);
  });

  it('replays identical input without rewriting the persisted tuple', async () => {
    await writer.insertPending(pending());
    const before = await persisted();
    expect(await reader.insertPending(pending())).toEqual({
      action: 'replay',
      row: pending(),
    });
    expect(await persisted()).toEqual(before);
  });

  it('concurrent independent stores produce one insert, one replay and one row', async () => {
    const results = await Promise.all([
      writer.insertPending(pending()),
      reader.insertPending(pending()),
    ]);
    expect(results.map((result) => result.action).sort()).toEqual([
      'inserted',
      'replay',
    ]);
    expect(await persisted()).toHaveLength(1);
    expect(await reader.readByDecision(DECISION)).toEqual({
      action: 'found',
      row: pending(),
      ack: null,
    });
    expect(await writer.readByDecision(DECISION)).toEqual(
      await reader.readByDecision(DECISION),
    );
  });

  it.each([
    ['branch', { branchId: 'branch:West' }],
    ['sender', { senderId: 'fixture:Other' }],
    [
      'time',
      {
        resolvedAt: '2026-06-22T02:00:00.000Z',
        applyBefore: '2026-06-22T03:00:00.000Z',
      },
    ],
    [
      'source',
      {
        sourceRequestId: OTHER,
        attemptId: deriveRestockAttemptId(OTHER, DECISION)!,
      },
    ],
    ['UUID payload casing', { decisionId: DECISION.toLowerCase() }],
  ])(
    'holds conflicting valid %s without overwriting',
    async (_name, change) => {
      await writer.insertPending(pending());
      const before = await persisted();
      const conflict = { ...pending(), ...change };
      expect(normalizeRestockApplicationLedgerRow(conflict)).toEqual(conflict);
      expect(deriveRestockAttemptId(SOURCE, DECISION.toLowerCase())).toBe(
        pending().attemptId,
      );
      expect(await reader.insertPending(conflict)).toEqual({ action: 'hold' });
      expect(await persisted()).toEqual(before);
      expect(before).toHaveLength(1);
    },
  );

  it('rejects padded sender without persisting a row', async () => {
    expect(
      await writer.insertPending({
        ...pending(),
        senderId: ' fixture:Sender ',
      }),
    ).toEqual({ action: 'hold' });
    expect(await persisted()).toEqual([]);
  });

  it('distinguishes invalid UUID hold from real missing', async () => {
    expect(await reader.readByDecision('not-a-uuid')).toEqual({
      action: 'hold',
    });
    expect(await reader.readByDecision(OTHER)).toEqual({ action: 'missing' });
  });

  it.each([started(), terminal()])(
    'reads seeded $state but never resets it on pending retry',
    async (row) => {
      expect(normalizeRestockApplicationLedgerRow(row)).toEqual(row);
      await seed(row);
      const before = await persisted();
      expect(await reader.readByDecision(DECISION)).toEqual({
        action: 'found',
        row,
        ack: null,
      });
      expect(await writer.insertPending(pending())).toEqual({ action: 'hold' });
      expect(await persisted()).toEqual(before);
    },
  );

  it('reads a test-seeded bound terminal ACK retaining original timestamp bytes', async () => {
    const row = terminal();
    const ack = receipt();
    await seed(row, ack);
    const before = await persisted();
    const found = await reader.readByDecision(DECISION);
    expect(found).toEqual({ action: 'found', row, ack });
    if (found.action !== 'found') throw new Error('expected found');
    expect(Object.isFrozen(found.ack)).toBe(true);
    expect(found.ack).not.toBe(ack);
    expect(found.ack?.ackReceivedAt).toBe('2020-01-01T00:00:00Z');
    expect(await writer.insertPending(pending())).toEqual({ action: 'hold' });
    expect(await persisted()).toEqual(before);
  });

  it.each([
    { ...pending(), resolvedAt: 'not-an-instant' },
    { ...pending(), attemptId: OTHER },
  ])('holds SQL-structural but domain-invalid row %#', async (row) => {
    expect(normalizeRestockApplicationLedgerRow(row)).toBeNull();
    await seed(row);
    const before = await persisted();
    expect(await reader.readByDecision(DECISION)).toEqual({ action: 'hold' });
    expect(await writer.insertPending(pending())).toEqual({ action: 'hold' });
    expect(await persisted()).toEqual(before);
  });

  it('holds SQL-structural ACK with invalid timestamp', async () => {
    await seed(terminal(), { ...receipt(), ackReceivedAt: 'bad-time' });
    expect(await reader.readByDecision(DECISION)).toEqual({ action: 'hold' });
  });

  it('holds unique-attempt conflict with missing decision (corruption fixture only)', async () => {
    // This identity/attempt mismatch is not reachable through the valid port.
    const corrupt = { ...pending(), decisionId: OTHER };
    expect(normalizeRestockApplicationLedgerRow(corrupt)).toBeNull();
    await seed(corrupt);
    const before = await persisted();
    expect(await reader.readByDecision(DECISION)).toEqual({
      action: 'missing',
    });
    expect(await writer.insertPending(pending())).toEqual({ action: 'hold' });
    expect(await persisted()).toEqual(before);
  });
});
