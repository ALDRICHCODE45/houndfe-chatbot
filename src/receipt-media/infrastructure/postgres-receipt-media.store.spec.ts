import { execSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  RECEIPT_FAILURE_STAGES,
  RECEIPT_MEDIA_STATUSES,
  RECEIPT_OUTBOX_STATUSES,
  RECEIPT_RECONCILIATION_DISPOSITIONS,
  RECEIPT_TEMPLATE_KEYS,
} from '../domain/receipt-media.types';

/**
 * WU2A1 core schema contract for the durable receipt-media store (RM1, RM3).
 * Gated by RUN_DOCKER_TESTS=1 like the other Testcontainers suites. Proves
 * the two table/column sets, field-local enum/range/byte-length/nullability
 * checks, foreign keys, basic uniques, durable defaults, and empty-table
 * up/down. Cross-field lifecycle predicates, partial indexes, and non-empty
 * down refusal are deferred to WU2A2 and intentionally absent here.
 */

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

type Row = Record<string, unknown>;
const UUID_A = '00000000-0000-4000-8000-000000000000';
const UUID_B = '11111111-1111-4111-8111-111111111111';
const UUID_C = '22222222-2222-4222-8222-222222222222';

const receiptRow = (over: Row = {}): Row => ({
  id: UUID_A,
  webhook_message_id: 'wamid.core',
  provider_media_id: 'media.core',
  sender_id: 'sender.core',
  captured_sale_id: UUID_B,
  object_key: `receipts/${UUID_C}`,
  status: 'RESERVED',
  ...over,
});

const outboxRow = (over: Row = {}): Row => ({
  id: UUID_C,
  dedupe_key: 'dk.core',
  source_webhook_message_id: 'wamid.core',
  recipient_id: 'sender.core',
  template_key: 'RECEIPT_AMOUNT_PROMPT',
  ...over,
});

// [column, data_type, is_nullable] triplets; compared as an order-insensitive
// multiset against information_schema (timestamptz is normalized).
const RECEIPT_MEDIA_COLUMNS = `
id uuid NO webhook_message_id text NO provider_media_id text NO
sender_id text NO captured_sale_id uuid NO object_key text NO
status text NO version bigint NO
created_at timestamptz NO updated_at timestamptz NO reserved_at timestamptz NO
downloaded_at timestamptz YES stored_at timestamptz YES
amount_proposed_at timestamptz YES attach_started_at timestamptz YES
attach_request_started_at timestamptz YES attached_at timestamptz YES
terminal_at timestamptz YES declared_mime_type text YES
response_mime_type text YES detected_mime_type text YES
provider_declared_bytes integer YES byte_count integer YES
content_sha256 bytea YES object_etag text YES object_version_id text YES
capability_token_hash bytea YES capability_key_version integer YES
capability_issued_at timestamptz YES capability_revoked_at timestamptz YES
declared_amount_cents integer YES backend_receipt_id uuid YES
backend_receipt_status text YES attach_attempt_id uuid YES
attach_attempts smallint NO meta_attempts smallint NO
storage_attempts smallint NO next_attempt_at timestamptz NO
lease_owner text YES lease_expires_at timestamptz YES failure_stage text YES
last_error_category text YES last_error_code text YES
attach_http_status integer YES attach_transport_code text YES
attach_outcome_observed_at timestamptz YES cleanup_pending boolean NO
cleanup_attempts integer NO reconciliation_disposition text YES
reconciled_backend_receipt_id uuid YES reconciled_at timestamptz YES
reconciled_by text YES
`;

const RECEIPT_MEDIA_OUTBOX_COLUMNS = `
id uuid NO dedupe_key text NO receipt_media_id uuid YES
receipt_state_version bigint YES source_webhook_message_id text NO
recipient_id text NO template_key text NO template_args jsonb NO
status text NO attempts smallint NO next_attempt_at timestamptz NO
lease_owner text YES lease_expires_at timestamptz YES
provider_message_id text YES created_at timestamptz NO
updated_at timestamptz NO sent_at timestamptz YES
`;

ddescribe('receipt_media core schema (WU2A1, Testcontainers)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  const migrate = (args: string) =>
    execSync(`pnpm ${args}`, {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    delete process.env.DB_POOL_MAX;
    migrate('migrate');
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
    delete process.env.DATABASE_URL;
  });

  const insertSql = (table: string, row: Row, returning = ''): string =>
    `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(
      row,
    )
      .map((_, i) => `$${i + 1}`)
      .join(',')})${returning}`;

  /** Runs every try inside one transaction that always rolls back. */
  async function expectInserts(
    tries: Array<[string, Row, boolean]>,
  ): Promise<void> {
    await withTx(async (c) => {
      for (const [table, row, ok] of tries) {
        const p = c.query(insertSql(table, row), Object.values(row));
        if (ok) await expect(p).resolves.toBeDefined();
        else await expect(p).rejects.toThrow();
      }
    });
  }

  async function withTx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  async function actualColumns(table: string): Promise<string[]> {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns WHERE table_name = $1`,
      [table],
    );
    return rows
      .flatMap((r) => [
        r.column_name,
        r.data_type.replace('timestamp with time zone', 'timestamptz'),
        r.is_nullable,
      ])
      .sort();
  }

  const expectedColumns = (spec: string): string[] =>
    spec.trim().split(/\s+/).sort();

  it('creates the exact receipt_media column set', async () => {
    expect(await actualColumns('receipt_media')).toEqual(
      expectedColumns(RECEIPT_MEDIA_COLUMNS),
    );
  });

  it('creates the exact receipt_media_outbox column set', async () => {
    expect(await actualColumns('receipt_media_outbox')).toEqual(
      expectedColumns(RECEIPT_MEDIA_OUTBOX_COLUMNS),
    );
  });

  it('applies durable core defaults', async () => {
    await withTx(async (c) => {
      const { rows } = await c.query(
        insertSql('receipt_media', receiptRow(), ' RETURNING *'),
        Object.values(receiptRow()),
      );
      expect(rows[0]).toMatchObject({
        version: '0',
        meta_attempts: 0,
        storage_attempts: 0,
        attach_attempts: 0,
        cleanup_pending: false,
        cleanup_attempts: 0,
      });
      expect(
        (rows[0] as { next_attempt_at: Date }).next_attempt_at,
      ).toBeInstanceOf(Date);
    });
  });

  it('durable type unions match the database enum checks', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT conrelid::regclass::text AS table_name,
              pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE contype = 'c'
         AND conrelid::regclass::text LIKE 'receipt_media%'`,
    );
    const defs: string[] = rows.map((r) => r.def);
    const has = (values: readonly string[]) =>
      defs.some((d) => values.every((v) => d.includes(`'${v}'`)));
    expect(has(RECEIPT_MEDIA_STATUSES)).toBe(true);
    expect(has(RECEIPT_FAILURE_STAGES)).toBe(true);
    expect(has(RECEIPT_RECONCILIATION_DISPOSITIONS)).toBe(true);
    expect(has(RECEIPT_OUTBOX_STATUSES)).toBe(true);
    expect(has(RECEIPT_TEMPLATE_KEYS)).toBe(true);
  });

  it('enforces basic uniques and not-null core columns', async () => {
    await expectInserts([
      ['receipt_media', receiptRow(), true],
      ['receipt_media', receiptRow(), false],
      ['receipt_media', receiptRow({ sender_id: null }), false],
    ]);
  });

  it('enforces the outbox dedupe_key unique', async () => {
    await expectInserts([
      ['receipt_media_outbox', outboxRow(), true],
      ['receipt_media_outbox', outboxRow(), false],
    ]);
  });

  it('enforces the outbox receipt foreign key', async () => {
    await expectInserts([
      ['receipt_media_outbox', outboxRow({ receipt_media_id: UUID_B }), false],
    ]);
  });

  it('accepts a committed-receipt outbox row with durable defaults', async () => {
    await withTx(async (c) => {
      await c.query(
        insertSql('receipt_media', receiptRow()),
        Object.values(receiptRow()),
      );
      const row = outboxRow({ receipt_media_id: UUID_A });
      const { rows } = await c.query(
        insertSql('receipt_media_outbox', row, ' RETURNING *'),
        Object.values(row),
      );
      expect(rows[0]).toMatchObject({
        status: 'PENDING',
        template_args: {},
        attempts: 0,
      });
    });
  });

  it.each([
    ['status', 'PARKED', false],
    ['status', 'ATTACH_OUTCOME_UNKNOWN', true],
    ['declared_mime_type', 'image/gif', false],
    ['declared_mime_type', 'image/jpeg', true],
    ['response_mime_type', 'image/gif', false],
    ['response_mime_type', 'image/png', true],
    ['detected_mime_type', 'image/gif', false],
    ['failure_stage', 'REBOOT', false],
    ['failure_stage', 'MEDIA_VALIDATION_PRE_STORAGE', true],
    ['backend_receipt_status', 'APPROVED', false],
    ['backend_receipt_status', 'PENDING', true],
    ['reconciliation_disposition', 'MAYBE', false],
    ['reconciliation_disposition', 'UNRESOLVED', true],
    ['byte_count', 0, false],
    ['byte_count', 1, true],
    ['byte_count', 10_485_760, true],
    ['byte_count', 10_485_761, false],
    ['provider_declared_bytes', 0, false],
    ['provider_declared_bytes', 10_485_761, false],
    ['capability_key_version', 0, false],
    ['capability_key_version', 1, true],
    ['declared_amount_cents', 0, false],
    ['declared_amount_cents', 1, true],
    ['attach_attempts', 2, false],
    ['attach_attempts', 1, true],
    ['meta_attempts', -1, false],
    ['meta_attempts', 4, false],
    ['meta_attempts', 3, true],
    ['storage_attempts', 4, false],
    ['cleanup_attempts', -1, false],
  ])('receipt_media.%s accepts/rejects %j', async (col, value, ok) => {
    await expectInserts([['receipt_media', receiptRow({ [col]: value }), ok]]);
  });

  it.each([
    ['content_sha256', 32, true],
    ['content_sha256', 31, false],
    ['capability_token_hash', 32, true],
    ['capability_token_hash', 31, false],
  ])('%s enforces its 32-byte length (%d)', async (col, len, ok) => {
    await expectInserts([
      ['receipt_media', receiptRow({ [col]: Buffer.alloc(len, 7) }), ok],
    ]);
  });

  it.each([
    ['template_key', 'FREE_TEXT', false],
    ['template_key', 'RECEIPT_ATTACH_UNKNOWN', true],
    ['status', 'QUEUED', false],
    ['status', 'SENT', true],
    ['attempts', 4, false],
    ['attempts', 3, true],
  ])('receipt_media_outbox.%s accepts/rejects %j', async (col, value, ok) => {
    await expectInserts([
      ['receipt_media_outbox', outboxRow({ [col]: value }), ok],
    ]);
  });

  it('rolls back and re-applies both empty tables (empty-table up/down)', async () => {
    await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
    migrate('migrate:down');
    for (const table of ['receipt_media', 'receipt_media_outbox']) {
      const { rows } = await pool.query<{ t: string | null }>(
        'SELECT to_regclass($1) AS t',
        [table],
      );
      expect(rows[0].t).toBeNull();
    }
    migrate('migrate');
    for (const table of ['receipt_media', 'receipt_media_outbox']) {
      const { rows } = await pool.query<{ t: string | null }>(
        'SELECT to_regclass($1) AS t',
        [table],
      );
      expect(rows[0].t).toBe(table);
    }
  });
});
