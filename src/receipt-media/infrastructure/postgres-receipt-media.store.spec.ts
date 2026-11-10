import { execSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { MAX_UPLOAD_ATTEMPTS } from '../domain/receipt-media-store.port';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import type {
  AttemptStartResult,
  LeaseFenceInput,
  ReservationOutcome,
  ReserveInput,
} from '../domain/receipt-media-store.port';
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
 * up/down. WU2A2A adds cross-field lifecycle predicates; WU2A2B adds the
 * design-required partial/lookup indexes and independent non-empty down
 * refusal.
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
  status: 'RESERVED',
  ...over,
});

const outboxRow = (over: Row = {}): Row => ({
  id: UUID_C,
  dedupe_key: 'dk.core',
  source_webhook_message_id: 'wamid.core',
  recipient_id: 'sender.core',
  template_key: 'RECEIPT_ATTACHED_PENDING',
  ...over,
});

// --- WU2A2A cross-field lifecycle/evidence/lease fixtures (RM1, RM3) ---
const T0 = new Date('2025-01-01T00:00:00Z');
const downloadEvidence: Row = {
  downloaded_at: T0,
  response_mime_type: 'image/jpeg',
  detected_mime_type: 'image/jpeg',
  byte_count: 1024,
  content_sha256: Buffer.alloc(32, 1),
};
/** R3 (3500): the attach-terminal states carry the upload start stamp. */
const attachEvidence: Row = { attach_started_at: T0 };
const downstreamStatuses = ['ATTACHED', 'ATTACH_OUTCOME_UNKNOWN'];

const lifeRow = (status: string, stage: string | null, over: Row = {}): Row => {
  const definite = stage === 'ATTACH_DEFINITE';
  const row: Row = { status, failure_stage: stage };
  if (
    status === 'DOWNLOADED' ||
    downstreamStatuses.includes(status) ||
    definite
  )
    Object.assign(row, downloadEvidence);
  if (['ATTACHED', 'ATTACH_OUTCOME_UNKNOWN'].includes(status) || definite)
    Object.assign(row, attachEvidence);
  if (status === 'ATTACHED')
    Object.assign(row, {
      backend_receipt_id: UUID_B,
      backend_receipt_status: 'PENDING',
      attached_at: T0,
    });
  if (status === 'ATTACH_OUTCOME_UNKNOWN')
    Object.assign(row, {
      attach_outcome_observed_at: T0,
      attach_http_status: 408,
    });
  if (definite) row.attach_http_status = 400;
  return receiptRow({ ...row, ...over });
};

// [column, data_type, is_nullable] triplets; compared as an order-insensitive
// multiset against information_schema (timestamptz is normalized).
const RECEIPT_MEDIA_COLUMNS = `
id uuid NO webhook_message_id text NO provider_media_id text NO
sender_id text NO captured_sale_id uuid NO
status text NO version bigint NO
created_at timestamptz NO updated_at timestamptz NO reserved_at timestamptz NO
downloaded_at timestamptz YES attach_started_at timestamptz YES
attached_at timestamptz YES
terminal_at timestamptz YES declared_mime_type text YES
response_mime_type text YES detected_mime_type text YES
provider_declared_bytes integer YES byte_count integer YES
content_sha256 bytea YES
declared_amount_cents integer YES backend_receipt_id uuid YES
backend_receipt_status text YES meta_attempts smallint NO
storage_attempts smallint NO next_attempt_at timestamptz NO
lease_owner text YES lease_expires_at timestamptz YES failure_stage text YES
last_error_category text YES last_error_code text YES
attach_http_status integer YES attach_transport_code text YES
attach_outcome_observed_at timestamptz YES reconciliation_disposition text YES
reconciled_backend_receipt_id uuid YES reconciled_at timestamptz YES
reconciled_by text YES sale_folio text YES outcome_status text YES
outcome_reason text YES outcome_debt_cents bigint YES
outcome_observed_at timestamptz YES outcome_polled_at timestamptz YES
outcome_notified_at timestamptz YES outcome_delivery text YES
upload_fields jsonb YES
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
  let store: PostgresReceiptMediaStore;

  const migrate = (args: string) =>
    execSync(`pnpm ${args}`, {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
  // Rolls back every migration applied after the irreversible 3600 and then
  // asks for one more step, so the down always reaches 3600 no matter how
  // many migrations were added later.
  const migrateDownTo3600 = async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pgmigrations
        WHERE name > '3600000000000_receipt_media_upload_fields'`,
    );
    migrate(`migrate:down ${Number(rows[0].n) + 1}`);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    delete process.env.DB_POOL_MAX;
    migrate('migrate');
    pool = new Pool({
      connectionString: container.getConnectionUri(),
      options: '-c statement_timeout=8000',
    });
    store = new PostgresReceiptMediaStore(pool);
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
    ['status', 'ATTACH_OUTCOME_UNKNOWN', false],
    ['declared_mime_type', 'image/gif', false],
    ['declared_mime_type', 'image/jpeg', true],
    ['response_mime_type', 'image/gif', false],
    ['response_mime_type', 'image/png', false],
    ['detected_mime_type', 'image/gif', false],
    ['failure_stage', 'REBOOT', false],
    ['failure_stage', 'MEDIA_VALIDATION_PRE_STORAGE', false],
    ['backend_receipt_status', 'APPROVED', false],
    ['backend_receipt_status', 'PENDING', false],
    ['reconciliation_disposition', 'MAYBE', false],
    ['reconciliation_disposition', 'UNRESOLVED', true],
    ['byte_count', 0, false],
    ['byte_count', 1, false],
    ['byte_count', 10_485_760, false],
    ['byte_count', 10_485_761, false],
    ['provider_declared_bytes', 0, false],
    ['provider_declared_bytes', 10_485_761, false],
    ['declared_amount_cents', 0, false],
    ['declared_amount_cents', 1, true],
    ['meta_attempts', -1, false],
    ['meta_attempts', 4, false],
    ['meta_attempts', 3, true],
    // R2: up to MAX_UPLOAD_ATTEMPTS (6) same-key backend upload attempts.
    ['storage_attempts', 6, true],
    ['storage_attempts', 7, false],
    ['declared_mime_type', 'application/pdf', true],
    // R3 (3500): the removed states are rejected.
    ['status', 'STORED', false],
    ['status', 'AWAITING_AMOUNT', false],
    ['status', 'CANCELLED', false],
    // R5 (3400): outcome evidence only on ATTACHED, never on RESERVED.
    ['outcome_status', 'CONFIRMED', false],
    ['outcome_polled_at', T0, false],
    ['sale_folio', 'F-1', true],
    ['sale_folio', '', false],
  ])('receipt_media.%s accepts/rejects %j', async (col, value, ok) => {
    await expectInserts([['receipt_media', receiptRow({ [col]: value }), ok]]);
  });

  it.each([
    ['content_sha256', 32, false],
    ['content_sha256', 31, false],
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

  // --- WU2A2A cross-field lifecycle/evidence/lease predicates (RM1, RM3) ---

  type InsertCase = [string, string, Row, boolean];
  const receiptCase = (
    label: string,
    status: string,
    stage: string | null,
    over: Row,
    ok: boolean,
  ): InsertCase => [label, 'receipt_media', lifeRow(status, stage, over), ok];

  const validStates: Array<[string, string | null]> = [
    ...'RESERVED DOWNLOADED'.split(' ').map((s) => [s, null] as [string, null]),
    ...downstreamStatuses.map((s) => [s, null] as [string, null]),
    ...RECEIPT_FAILURE_STAGES.map(
      (stage) => ['FAILED', stage] as [string, string],
    ),
  ];
  const invalidReceipts: Array<[string, string, string | null, Row]> = [
    ['bytes required', 'DOWNLOADED', null, { byte_count: null }],
    ['no download early', 'RESERVED', null, { downloaded_at: T0 }],
    ['start required', 'ATTACHED', null, { attach_started_at: null }],
    ['no start early', 'DOWNLOADED', null, { attach_started_at: T0 }],
    ['backend id required', 'ATTACHED', null, { backend_receipt_id: null }],
    [
      'no success errors',
      'ATTACHED',
      null,
      { last_error_category: 'TRANSPORT' },
    ],
    [
      'definite no 500',
      'FAILED',
      'ATTACH_DEFINITE',
      { attach_http_status: 500 },
    ],
    [
      'definite no backend',
      'FAILED',
      'ATTACH_DEFINITE',
      { backend_receipt_status: 'PENDING' },
    ],
    [
      'unknown no 400',
      'ATTACH_OUTCOME_UNKNOWN',
      null,
      { attach_http_status: 400 },
    ],
    [
      'unknown observed',
      'ATTACH_OUTCOME_UNKNOWN',
      null,
      { attach_outcome_observed_at: null },
    ],
    ['failed staged', 'FAILED', null, {}],
    ['nonfailed unstaged', 'RESERVED', 'META_EXHAUSTED_PRE_STORAGE', {}],
  ];
  const validReceipts: Array<[string, string, string | null, Row]> = [
    ['caption amount ok', 'ATTACHED', null, { declared_amount_cents: 1250 }],
    [
      'outcome ok',
      'ATTACHED',
      null,
      {
        outcome_status: 'REJECTED',
        outcome_reason: 'Ilegible',
        outcome_debt_cents: 0,
        outcome_observed_at: T0,
        outcome_notified_at: T0,
        outcome_delivery: 'OUTSIDE_WINDOW',
      },
    ],
    [
      'definite 429 ok',
      'FAILED',
      'ATTACH_DEFINITE',
      { attach_http_status: 429 },
    ],
    [
      'unknown code ok',
      'ATTACH_OUTCOME_UNKNOWN',
      null,
      { attach_http_status: null, attach_transport_code: 'TIMEOUT' },
    ],
  ];

  it.each<InsertCase>([
    ...validStates.map(([s, st]) =>
      receiptCase(`valid ${s}/${st}`, s, st, {}, true),
    ),
    ...invalidReceipts.map(([label, s, st, over]) =>
      receiptCase(label, s, st, over, false),
    ),
    ...validReceipts.map(([label, s, st, over]) =>
      receiptCase(label, s, st, over, true),
    ),
    [
      'media lease ok',
      'receipt_media',
      receiptRow({ lease_owner: 'worker-1', lease_expires_at: T0 }),
      true,
    ],
    [
      'media lease bad',
      'receipt_media',
      receiptRow({ lease_owner: 'worker-1' }),
      false,
    ],
    [
      'outbox lease ok',
      'receipt_media_outbox',
      outboxRow({ lease_owner: 'worker-2', lease_expires_at: T0 }),
      true,
    ],
    [
      'outbox lease bad',
      'receipt_media_outbox',
      outboxRow({ lease_expires_at: T0 }),
      false,
    ],
  ])('%s', async (_label, table, row, ok) => {
    await expectInserts([[table, row, ok]]);
  });

  // --- WU2A2B partial/lookup indexes and non-empty down guards (RM1, RM3) ---

  const altRow = (over: Row = {}): Row =>
    receiptRow({
      id: UUID_B,
      webhook_message_id: 'wamid.alt',
      provider_media_id: 'media.alt',
      ...over,
    });

  /** Strips casts/parens/whitespace so deparser formatting cannot lie. */
  const norm = (def: string): string =>
    def.replace(/::[a-z]+/gi, '').replace(/[()\s]/g, '');

  type IndexRow = { relname: string; indisunique: boolean; indexdef: string };

  const loadIndexes = async (): Promise<Map<string, IndexRow>> => {
    const { rows } = await pool.query<IndexRow>(
      `SELECT c.relname, i.indisunique,
                  pg_get_indexdef(i.indexrelid) AS indexdef
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_class t ON t.oid = i.indrelid
            WHERE t.relname IN ('receipt_media', 'receipt_media_outbox')`,
    );
    return new Map(rows.map((r) => [r.relname, r]));
  };

  const defOf = async (name: string): Promise<IndexRow> => {
    const def = (await loadIndexes()).get(name);
    expect(def).toBeDefined();
    return def as IndexRow;
  };

  const REQUIRED_INDEXES = (
    'receipt_media_active_sender_idx receipt_media_claim_idx ' +
    'receipt_media_outcome_due_idx receipt_media_status_updated_idx ' +
    'receipt_media_unknown_outcome_idx receipt_media_webhook_message_id_key ' +
    'receipt_media_provider_media_id_key ' +
    'receipt_media_pkey receipt_media_outbox_claim_idx ' +
    'receipt_media_outbox_dedupe_key_key receipt_media_outbox_pkey'
  ).split(' ');

  it('creates exactly the design-required index inventory', async () => {
    const names = [...(await loadIndexes()).keys()].sort();
    expect(names.filter((n) => !REQUIRED_INDEXES.includes(n))).toEqual([]);
    expect(REQUIRED_INDEXES.filter((n) => !names.includes(n))).toEqual([]);
  });

  it('active-sender partial unique enforces one active flow per sender', async () => {
    await expectInserts([
      ['receipt_media', receiptRow(), true],
      [
        'receipt_media',
        altRow({ status: 'DOWNLOADED', ...downloadEvidence }),
        false,
      ],
    ]);
    await expectInserts([
      ['receipt_media', receiptRow(), true],
      ['receipt_media', altRow({ sender_id: 'sender.other' }), true],
    ]);
  });

  it.each([
    ['FAILED', 'META_EXHAUSTED_PRE_STORAGE'],
    ['ATTACHED', null],
    ['ATTACH_OUTCOME_UNKNOWN', null],
  ])('active-sender partial unique excludes terminal %s', async (s, st) => {
    await expectInserts([
      ['receipt_media', lifeRow(s, st, {}), true],
      ['receipt_media', altRow(), true],
    ]);
  });

  it.each([
    [
      'claim queue',
      'receipt_media_claim_idx',
      ['next_attempt_at,created_at', "'RESERVED'", "'DOWNLOADED'"],
      ["'STORED'", "'ATTACHING'"],
    ],
    [
      'status/updated backlog lookup',
      'receipt_media_status_updated_idx',
      ['status,updated_at'],
      ['WHERE'],
    ],
    [
      'unknown-outcome reconciliation',
      'receipt_media_unknown_outcome_idx',
      ["status='ATTACH_OUTCOME_UNKNOWN'"],
      ["'FAILED'"],
    ],
    [
      'outbox claim',
      'receipt_media_outbox_claim_idx',
      ['next_attempt_at,created_at', "'PENDING'", "'SENDING'"],
      ["'SENT'", "'FAILED'"],
    ],
  ])('%s index definition', async (_label, name, has, not) => {
    const { indisunique, indexdef } = await defOf(name);
    expect(indisunique).toBe(false);
    const def = norm(indexdef);
    for (const fragment of has) expect(def).toContain(fragment);
    for (const fragment of not) expect(def).not.toContain(fragment);
  });

  // The chain ends at the irreversible 3600 (receipt media upload fields,
  // `exports.down = false`, like 3300 through 3500), so the first
  // single-step down already refuses and the tables stay in place.
  const tryMigrateDown = async (): Promise<string> => {
    try {
      await migrateDownTo3600();
      return '';
    } catch (err) {
      return String((err as { stderr?: Buffer }).stderr ?? err);
    } finally {
      migrate('migrate');
    }
  };

  it.each([
    ['receipt_media', lifeRow('RESERVED', null, {})],
    ['receipt_media_outbox', outboxRow()],
  ])('down refuses when only %s is populated', async (table, row) => {
    await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
    await pool.query(insertSql(table, row), Object.values(row));
    expect(await tryMigrateDown()).toMatch(
      /disabled down migration on file: 3600000000000_receipt_media_upload_fields/,
    );
    const { rows } = await pool.query<{ a: boolean; b: boolean }>(
      "SELECT to_regclass('receipt_media') IS NOT NULL AS a, " +
        "to_regclass('receipt_media_outbox') IS NOT NULL AS b",
    );
    expect(rows[0]).toMatchObject({ a: true, b: true });
    await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
  });

  // --- WU2B1 reservation arbitration and intent dedupe (RM1, RM3) ---

  describe('WU2B1 reservation arbitration and intent dedupe', () => {
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE processed_webhook_messages, receipt_media_outbox, receipt_media',
      );
    });

    const reserveInput = (over: Row = {}): ReserveInput => ({
      id: UUID_A,
      webhookMessageId: 'wamid.r1',
      providerMediaId: 'media.r1',
      senderId: 'sender.r1',
      capturedSaleId: UUID_B,
      ...over,
    });

    const rivalInput = (over: Row = {}): ReserveInput =>
      reserveInput({ id: UUID_B, ...over });

    const admissionCounts = async (messageId: string) => {
      const [receipts, markers] = await Promise.all([
        pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM receipt_media WHERE webhook_message_id = $1',
          [messageId],
        ),
        pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM processed_webhook_messages WHERE message_id = $1',
          [messageId],
        ),
      ]);
      return { receipts: receipts.rows[0].n, markers: markers.rows[0].n };
    };

    it('atomically admits one receipt reservation with one inbound marker', async () => {
      const admission = reserveInput({ declaredMimeType: 'image/jpeg' });
      const first = await store.admit(admission);
      if (first.kind !== 'created') throw new Error('expected created');
      expect(first.receipt.declaredMimeType).toBe('image/jpeg');
      expect(await admissionCounts(admission.webhookMessageId)).toEqual({
        receipts: 1,
        markers: 1,
      });
      const replay = await store.admit(reserveInput());
      if (replay.kind !== 'webhook-replayed')
        throw new Error('expected replay');
      expect(replay.receipt.id).toBe(first.receipt.id);
      expect(await admissionCounts(admission.webhookMessageId)).toEqual({
        receipts: 1,
        markers: 1,
      });
    });

    // --- ODD-4A: declared caption amount persisted atomically at admit ---
    const durableCents = async (id = UUID_A): Promise<number | null> => {
      const { rows } = await pool.query<{
        declared_amount_cents: number | null;
      }>('SELECT declared_amount_cents FROM receipt_media WHERE id = $1', [id]);
      return rows[0]?.declared_amount_cents ?? null;
    };

    it('persists the declared caption amount with the reservation and marker', async () => {
      const admission = reserveInput({ declaredAmountCents: 1250 });
      const first = await store.admit(admission);
      if (first.kind !== 'created') throw new Error('expected created');
      expect(first.receipt.declaredAmountCents).toBe(1250);
      expect(await durableCents()).toBe(1250);
      expect(await admissionCounts(admission.webhookMessageId)).toEqual({
        receipts: 1,
        markers: 1,
      });
    });

    it('persists null when the reservation carries no declared amount', async () => {
      const first = await store.admit(reserveInput());
      if (first.kind !== 'created') throw new Error('expected created');
      expect(first.receipt.declaredAmountCents).toBeNull();
      expect(await durableCents()).toBeNull();
    });

    it('retains the first durable amount across webhook replay and provider reuse', async () => {
      const first = await store.admit(
        reserveInput({ declaredAmountCents: 1250 }),
      );
      if (first.kind !== 'created') throw new Error('expected created');
      await expect(
        store.admit(reserveInput({ declaredAmountCents: 999999 })),
      ).resolves.toMatchObject({ kind: 'webhook-replayed' });
      await expect(
        store.admit(
          reserveInput({
            id: UUID_B,
            webhookMessageId: 'wamid.reuse',
            declaredAmountCents: 7777,
          }),
        ),
      ).resolves.toMatchObject({ kind: 'provider-media-reused' });
      expect(await durableCents()).toBe(1250);
    });

    it('concurrent same-message arbitration keeps the winner amount without overwrite', async () => {
      const [left, right] = await Promise.all([
        store.admit(reserveInput({ declaredAmountCents: 1250 })),
        store.admit(reserveInput({ declaredAmountCents: 4200 })),
      ]);
      const winner = [left, right].find(
        (o): o is Extract<ReservationOutcome, { kind: 'created' }> =>
          o.kind === 'created',
      );
      if (!winner) throw new Error('expected one created');
      const persisted = await durableCents();
      expect([1250, 4200]).toContain(persisted);
      expect(persisted).toBe(winner.receipt.declaredAmountCents);
    });

    it('rolls back both artifacts when receipt persistence fails', async () => {
      await pool.query(`CREATE FUNCTION receipt_admission_receipt_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'receipt admission receipt failure'; END; $$`);
      await pool.query(`CREATE TRIGGER receipt_admission_receipt_failure
        BEFORE INSERT ON receipt_media FOR EACH ROW
        EXECUTE FUNCTION receipt_admission_receipt_failure()`);
      const admission = reserveInput({
        webhookMessageId: 'wamid.rollback.receipt',
        providerMediaId: 'media.rollback.receipt',
      });
      try {
        await expect(store.admit(admission)).rejects.toThrow(
          'receipt admission receipt failure',
        );
        expect(await admissionCounts(admission.webhookMessageId)).toEqual({
          receipts: 0,
          markers: 0,
        });
      } finally {
        await pool.query(
          'DROP TRIGGER IF EXISTS receipt_admission_receipt_failure ON receipt_media',
        );
        await pool.query(
          'DROP FUNCTION IF EXISTS receipt_admission_receipt_failure()',
        );
      }
    });

    it('rolls back both artifacts when marker persistence fails', async () => {
      await pool.query(`CREATE FUNCTION receipt_admission_marker_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'receipt admission marker failure'; END; $$`);
      await pool.query(`CREATE TRIGGER receipt_admission_marker_failure
        BEFORE INSERT ON processed_webhook_messages FOR EACH ROW
        EXECUTE FUNCTION receipt_admission_marker_failure()`);
      const admission = reserveInput({
        webhookMessageId: 'wamid.rollback.marker',
        providerMediaId: 'media.rollback.marker',
      });
      try {
        await expect(store.admit(admission)).rejects.toThrow(
          'receipt admission marker failure',
        );
        expect(await admissionCounts(admission.webhookMessageId)).toEqual({
          receipts: 0,
          markers: 0,
        });
      } finally {
        await pool.query(
          'DROP TRIGGER IF EXISTS receipt_admission_marker_failure ON processed_webhook_messages',
        );
        await pool.query(
          'DROP FUNCTION IF EXISTS receipt_admission_marker_failure()',
        );
      }
    });

    it('concurrently converges same-message admissions on one receipt and marker', async () => {
      const admission = reserveInput();
      const [left, right] = await Promise.all([
        store.admit(admission),
        store.admit(admission),
      ]);
      expect([left.kind, right.kind].sort()).toEqual([
        'created',
        'webhook-replayed',
      ]);
      expect(await admissionCounts(admission.webhookMessageId)).toEqual({
        receipts: 1,
        markers: 1,
      });
    });

    it('adds a durable marker while replaying a legacy receipt row', async () => {
      const admission = reserveInput();
      await pool.query(
        insertSql(
          'receipt_media',
          receiptRow({
            id: admission.id,
            webhook_message_id: admission.webhookMessageId,
            provider_media_id: admission.providerMediaId,
            sender_id: admission.senderId,
            captured_sale_id: admission.capturedSaleId,
          }),
        ),
        [
          admission.id,
          admission.webhookMessageId,
          admission.providerMediaId,
          admission.senderId,
          admission.capturedSaleId,
          'RESERVED',
        ],
      );
      await expect(store.admit(admission)).resolves.toMatchObject({
        kind: 'webhook-replayed',
        receipt: { id: admission.id },
      });
      expect(await admissionCounts(admission.webhookMessageId)).toEqual({
        receipts: 1,
        markers: 1,
      });
    });

    it('rethrows unrelated constraint violations', async () => {
      await store.admit(reserveInput());
      await expect(
        store.admit(
          rivalInput({
            webhookMessageId: 'wamid.x',
            providerMediaId: 'media.x',
            senderId: 'sender.x',
            // R3: no object key; a CHECK violation is the unrelated constraint.
            declaredMimeType: 'image/gif',
          }),
        ),
      ).rejects.toThrow();
    });

    it('parameter-binds adversarial values without altering SQL structure', async () => {
      const nasty = "wamid'); DROP TABLE receipt_media;--";
      const out = await store.admit(reserveInput({ webhookMessageId: nasty }));
      if (out.kind !== 'created') throw new Error('expected created');
      expect(out.receipt.webhookMessageId).toBe(nasty);
    });

    it.each<[Row, ReservationOutcome['kind']]>([
      [{}, 'webhook-replayed'],
      [{ webhookMessageId: 'wamid.r2' }, 'provider-media-reused'],
      [{ providerMediaId: 'media.r2' }, 'webhook-media-conflict'],
      [
        { webhookMessageId: 'wamid.r2', providerMediaId: 'media.r2' },
        'sender-active',
      ],
    ])('concurrently classifies %j', async (over, kind) => {
      const rival = rivalInput(over);
      const [x, y] = await Promise.all([
        store.admit(reserveInput()),
        store.admit(rival),
      ]);
      expect([x.kind, y.kind].sort()).toEqual(['created', kind]);
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM receipt_media',
      );
      expect(rows[0].n).toBe(1);
    });
  });

  // --- WU2B2A leased claims and fenced lease bookkeeping (RM1, RM3) ---

  describe('WU2B2A leased claims and fenced lease bookkeeping', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
    });

    const FUTURE = new Date(Date.now() + 60_000);
    const PAST = new Date(Date.now() - 60_000);
    let seq = 0;
    const claimRow = (status: string, over: Row = {}): Row =>
      lifeRow(status, null, {
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        webhook_message_id: `wamid.c${seq}`,
        provider_media_id: `media.c${seq}`,
        sender_id: `sender.c${seq}`,
        ...over,
      });

    const insert = (row: Row): Promise<unknown> =>
      pool.query(insertSql('receipt_media', row), Object.values(row));

    const claimedIds = async (limit: number, owner: string) =>
      (await store.claimBatch(limit, owner)).map((r) => r.id);

    const claim = async (owner = 'w1') => (await store.claimBatch(1, owner))[0];

    const fence = (
      r: { id: string; version: string },
      owner = 'w1',
    ): LeaseFenceInput => ({ id: r.id, owner, expectedVersion: r.version });

    const state = (id: string) =>
      pool
        .query<Row>(
          'SELECT status, version, meta_attempts, storage_attempts, ' +
            'lease_owner, lease_expires_at, ' +
            'extract(epoch FROM lease_expires_at - now()) AS lease_secs ' +
            'FROM receipt_media WHERE id = $1',
          [id],
        )
        .then((r) => r.rows[0]);

    it.each<[string, Row, boolean]>([
      ['RESERVED', {}, true],
      // ODD-2C: exhausted count-3 rows are reclaimable only so the processor
      // can terminalize them; startMetaAttempt still refuses a fourth call.
      ['RESERVED', { meta_attempts: 3 }, true],
      ['DOWNLOADED', {}, true],
      ['DOWNLOADED', { meta_attempts: 3 }, true],
      // ODD-2D1: storage-exhausted DOWNLOADED rows are reclaimable only so the
      // processor can terminalize them; startStorageAttempt still refuses a
      // fourth call.
      ['DOWNLOADED', { meta_attempts: 3, storage_attempts: 3 }, true],
      ['DOWNLOADED', { storage_attempts: 3 }, true],
      ['DOWNLOADED', { storage_attempts: 3, next_attempt_at: FUTURE }, false],
      // R3: attach-terminal rows are never claimed.
      ['ATTACHED', {}, false],
      ['ATTACH_OUTCOME_UNKNOWN', {}, false],
      ['RESERVED', { next_attempt_at: FUTURE }, false],
      ['RESERVED', { lease_owner: 'w0', lease_expires_at: FUTURE }, false],
      ['RESERVED', { lease_owner: 'w0', lease_expires_at: PAST }, true],
    ])('claim eligibility: %s %j', async (status, over, expectClaim) => {
      const row = claimRow(status, over);
      await insert(row);
      expect(await claimedIds(5, 'w1')).toEqual(expectClaim ? [row.id] : []);
    });

    it('orders claims by next_attempt_at, created_at', async () => {
      const at = new Date(Date.now() - 120_000);
      const r1 = claimRow('RESERVED', { next_attempt_at: at, created_at: at });
      const r2 = claimRow('RESERVED', {
        next_attempt_at: at,
        created_at: new Date(+at + 1_000),
      });
      const r3 = claimRow('RESERVED', {
        next_attempt_at: new Date(+at + 30_000),
      });
      for (const row of [r3, r2, r1]) await insert(row);
      expect(await claimedIds(3, 'w1')).toEqual([r1.id, r2.id, r3.id]);
    });

    it('splits eligible rows between concurrent workers', async () => {
      const [a, b] = [claimRow('RESERVED'), claimRow('RESERVED')];
      for (const row of [a, b]) await insert(row);
      const [x, y] = await Promise.all([
        store.claimBatch(1, 'w1'),
        store.claimBatch(1, 'w2'),
      ]);
      expect([x.length, y.length]).toEqual([1, 1]);
      expect([x[0].id, y[0].id].sort()).toEqual([a.id, b.id].sort());
    });

    it('skips a locked row and reclaims it after lock release', async () => {
      const [a, b] = [claimRow('RESERVED'), claimRow('RESERVED')];
      for (const row of [a, b]) await insert(row);
      await withTx(async (c) => {
        await c.query('SELECT id FROM receipt_media WHERE id = $1 FOR UPDATE', [
          a.id,
        ]);
        expect(await claimedIds(5, 'w1')).toEqual([b.id]);
      });
      expect(await claimedIds(5, 'w2')).toEqual([a.id]);
    });

    it('claims with an approximately 60-second lease from DB time', async () => {
      await insert(claimRow('RESERVED'));
      const claimed = await claim();
      const s = await state(claimed.id);
      expect(+(s.lease_secs as string)).toBeGreaterThan(55);
      expect(+(s.lease_secs as string)).toBeLessThanOrEqual(60);
      expect(s.version).toBe('1');
    });

    it('renews only the live owner at the expected version, preserving it', async () => {
      await insert(claimRow('RESERVED'));
      const claimed = await claim();
      const f = fence(claimed);
      expect(await store.renewLease({ ...f, owner: 'w0' })).toBe(false);
      expect(await store.renewLease({ ...f, expectedVersion: '9' })).toBe(
        false,
      );
      const s = await state(claimed.id);
      expect(s.version).toBe('1');
      expect(s.lease_owner).toBe('w1');
      expect(await store.renewLease(f)).toBe(true);
      const renewed = await state(claimed.id);
      expect(renewed.version).toBe('1');
      expect(+(renewed.lease_secs as string)).toBeGreaterThan(55);
      expect(+(renewed.lease_secs as string)).toBeLessThanOrEqual(60);
    });

    it('an expired owner cannot renew before or after reclaim', async () => {
      await insert(claimRow('RESERVED'));
      const stale = await claim();
      const f = fence(stale);
      await pool.query(
        "UPDATE receipt_media SET lease_expires_at = now() - interval '1s' " +
          'WHERE id = $1',
        [stale.id],
      );
      expect(await store.renewLease(f)).toBe(false);
      expect((await state(stale.id)).version).toBe('1');
      expect((await claim('w2')).id).toBe(stale.id);
      expect(await store.renewLease(f)).toBe(false);
      expect((await state(stale.id)).version).toBe('2');
    });

    // --- WU2B2B status CAS and bounded pre-call attempts (RM1, RM3) ---

    describe('WU2B2B status CAS and bounded pre-call attempts', () => {
      beforeEach(async () => {
        await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
      });

      type Counter = 'meta' | 'storage';
      const COL = { meta: 'meta_attempts', storage: 'storage_attempts' };
      const start = (
        counter: Counter,
        f: LeaseFenceInput,
      ): Promise<AttemptStartResult | null> =>
        counter === 'meta'
          ? store.startMetaAttempt(f)
          : store.startStorageAttempt(f);
      const expire = (id: string): Promise<unknown> =>
        pool.query(
          'UPDATE receipt_media SET lease_expires_at = ' +
            "now() - interval '1s' WHERE id = $1",
          [id],
        );

      it.each<Counter>(['meta', 'storage'])(
        'isolates fenced %s attempt-start losers before and after reclaim',
        async (counter) => {
          await insert(
            claimRow(counter === 'meta' ? 'RESERVED' : 'DOWNLOADED'),
          );
          const claimed = await claim();
          const f = fence(claimed);
          expect(await start(counter, { ...f, owner: 'w0' })).toBeNull();
          expect(
            await start(counter, { ...f, expectedVersion: '9' }),
          ).toBeNull();
          await expire(claimed.id);
          expect(await start(counter, f)).toBeNull();
          expect((await claim('w2')).id).toBe(claimed.id);
          expect(await start(counter, f)).toBeNull();
          expect(await state(claimed.id)).toMatchObject({
            [COL[counter]]: 0,
            version: '2',
          });
        },
      );

      it.each<[Counter, string]>([
        ['meta', 'RESERVED'],
        ['storage', 'DOWNLOADED'],
      ])(
        'starts every allowed %s attempt and refuses one more',
        async (counter, status) => {
          // Meta keeps 3; R2 storage = backend upload attempts (6).
          const cap = counter === 'meta' ? 3 : MAX_UPLOAD_ATTEMPTS;
          await insert(claimRow(status));
          const claimed = await claim();
          const f = fence(claimed);
          for (let i = 1, v = claimed.version; i <= cap; i++, v = String(i)) {
            expect(await start(counter, { ...f, expectedVersion: v })).toEqual({
              attempt: i,
              version: String(i + 1),
            });
          }
          expect(
            await start(counter, { ...f, expectedVersion: String(cap + 1) }),
          ).toBeNull();
          expect(await state(claimed.id)).toMatchObject({
            [COL[counter]]: cap,
            version: String(cap + 1),
          });
        },
      );

      type DownloadOutcome = { kind: 'committed' | 'replayed' | 'fenced' };
      const download = (input: Row): Promise<DownloadOutcome> =>
        (
          store as unknown as {
            commitDownload(input: Row): Promise<DownloadOutcome>;
          }
        ).commitDownload(input);
      const evidence = () => ({
        responseMimeType: 'image/jpeg',
        detectedMimeType: 'image/jpeg',
        byteCount: 1024,
        contentSha256: Buffer.alloc(32, 7),
      });
      const downloadState = (id: string) =>
        pool
          .query<Row>(
            `SELECT status, version, downloaded_at, response_mime_type,
                   detected_mime_type, byte_count, content_sha256
                 FROM receipt_media WHERE id = $1`,
            [id],
          )
          .then((result) => result.rows[0]);

      it('atomically commits complete download evidence and only exact retries replay', async () => {
        await insert(claimRow('RESERVED'));
        const claimed = await claim();
        const input = { ...fence(claimed), ...evidence() };
        await expect(download(input)).resolves.toEqual({ kind: 'committed' });
        const committed = await downloadState(claimed.id);
        expect(committed).toMatchObject({
          status: 'DOWNLOADED',
          version: '2',
          response_mime_type: input.responseMimeType,
          detected_mime_type: input.detectedMimeType,
          byte_count: input.byteCount,
          content_sha256: input.contentSha256,
        });
        expect(committed.downloaded_at).toBeInstanceOf(Date);
        await expect(download(input)).resolves.toEqual({ kind: 'replayed' });
        await expect(
          download({ ...input, byteCount: input.byteCount + 1 }),
        ).resolves.toEqual({ kind: 'fenced' });
      });

      it.each([
        { expectedVersion: '9' },
        { owner: 'w0' },
        { responseMimeType: 'image/gif' },
        { detectedMimeType: 'image/gif' },
        { byteCount: 0 },
        { contentSha256: Buffer.alloc(31, 7) },
      ])('fences invalid evidence or a rival fence: %j', async (over) => {
        await insert(claimRow('RESERVED'));
        const claimed = await claim();
        await expect(
          download({ ...fence(claimed), ...evidence(), ...over }),
        ).resolves.toEqual({ kind: 'fenced' });
        expect(await state(claimed.id)).toMatchObject({
          status: 'RESERVED',
          version: '1',
        });
      });

      it('rolls back the complete commit when a receipt trigger fails', async () => {
        await insert(claimRow('RESERVED'));
        const claimed = await claim();
        const before = await downloadState(claimed.id);
        await pool.query(`CREATE FUNCTION receipt_download_failure()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'receipt download failure'; END; $$`);
        await pool.query(`CREATE TRIGGER receipt_download_failure
          BEFORE UPDATE ON receipt_media FOR EACH ROW
          EXECUTE FUNCTION receipt_download_failure()`);
        try {
          await expect(
            download({ ...fence(claimed), ...evidence() }),
          ).rejects.toThrow('receipt download failure');
          expect(await downloadState(claimed.id)).toEqual(before);
        } finally {
          await pool.query(
            'DROP TRIGGER IF EXISTS receipt_download_failure ON receipt_media',
          );
          await pool.query(
            'DROP FUNCTION IF EXISTS receipt_download_failure()',
          );
        }
      });

      it('serializes duplicate commits and rejects an altered rival', async () => {
        await insert(claimRow('RESERVED'));
        const claimed = await claim();
        const input = { ...fence(claimed), ...evidence() };
        const outcomes = await Promise.all([download(input), download(input)]);
        expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
          'committed',
          'replayed',
        ]);
        await expect(
          download({ ...input, contentSha256: Buffer.alloc(32, 8) }),
        ).resolves.toEqual({ kind: 'fenced' });
      });

      it('fences expired and wrong-starting rows without partial evidence', async () => {
        await insert(claimRow('RESERVED'));
        const expired = await claim();
        await expire(expired.id);
        await expect(
          download({ ...fence(expired), ...evidence() }),
        ).resolves.toEqual({ kind: 'fenced' });
        const wrong = claimRow('ATTACHED');
        const wrongId = wrong.id as string;
        await insert(wrong);
        await pool.query(
          "UPDATE receipt_media SET lease_owner = 'w2', " +
            "lease_expires_at = now() + interval '60 seconds' WHERE id = $1",
          [wrongId],
        );
        const before = await downloadState(wrongId);
        await expect(
          download({
            id: wrongId,
            owner: 'w2',
            expectedVersion: '0',
            ...evidence(),
          }),
        ).resolves.toEqual({ kind: 'fenced' });

        expect(await downloadState(expired.id)).toMatchObject({
          downloaded_at: null,
          response_mime_type: null,
          detected_mime_type: null,
          byte_count: null,
          content_sha256: null,
        });
        expect(await downloadState(wrongId)).toEqual(before);
      });
    });
  });

  describe('ODD-2C durable Meta retry and finalization', () => {
    const OWNER = 'worker.meta-failure';
    const SENDER = 'sender.meta-failure';
    /** The new primitive is called through a structural seam so this spec
     * stays runnable before the port surface exists; the durable behavior is
     * proven against the real PostgreSQL store either way. */
    const metaStore = () =>
      store as unknown as {
        commitMetaFailureDisposition(input: Row): Promise<Row>;
      };
    const command = (over: Row = {}): Row => ({
      id: UUID_A,
      owner: OWNER,
      expectedVersion: '2',
      category: 'META_TRANSPORT',
      code: 'NETWORK_FAILURE',
      ...over,
    });
    const commit = (over: Row = {}) =>
      metaStore().commitMetaFailureDisposition(command(over));
    const seedRow = async (receipt: Row) => {
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
      await pool.query(
        insertSql('receipt_media', receipt),
        Object.values(receipt),
      );
      return receipt;
    };
    const seed = (status: string, over: Row = {}) =>
      seedRow(
        lifeRow(status, null, {
          id: UUID_A,
          sender_id: SENDER,
          captured_sale_id: UUID_B,
          version: '2',
          lease_owner: OWNER,
          lease_expires_at: new Date(Date.now() + 60_000),
          ...over,
        }),
      );
    /** A legacy terminal successor written before Meta intent ownership: the
     * exact durable terminal evidence with no `RECEIPT_UNAVAILABLE_LATER`
     * intent. */
    const legacyTerminal = (over: Row = {}): Row =>
      lifeRow('FAILED', 'META_EXHAUSTED_PRE_STORAGE', {
        id: UUID_A,
        sender_id: SENDER,
        captured_sale_id: UUID_B,
        version: '3',
        meta_attempts: 3,
        last_error_category: 'META_TRANSPORT',
        last_error_code: 'META_EXHAUSTED',
        terminal_at: T0,
        lease_owner: OWNER,
        lease_expires_at: new Date(Date.now() + 60_000),
        ...over,
      });
    const row = async () =>
      (
        await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [
          UUID_A,
        ])
      ).rows[0];
    const outboxRows = async () =>
      (await pool.query<Row>('SELECT * FROM receipt_media_outbox')).rows;
    const intentKey = (version: string) =>
      `receipt-unavailable-later:${UUID_A}:${version}:wamid.core`;
    const remainingMs = async () =>
      Number(
        (
          await pool.query<Row>(
            `SELECT (extract(epoch from next_attempt_at - clock_timestamp()) * 1000)::int AS ms
               FROM receipt_media WHERE id = $1`,
            [UUID_A],
          )
        ).rows[0].ms,
      );
    const expectFenced = async (input: Row) => {
      const before = await row();
      await expect(
        metaStore().commitMetaFailureDisposition(input),
      ).resolves.toEqual({ kind: 'fenced' });
      expect(await row()).toEqual(before);
    };

    it('schedules attempts 1/2 with retained status, cleared lease, bounded positive jitter, and no intent', async () => {
      const cases: Array<[string, number, number]> = [
        ['RESERVED', 1, 1000],
        ['RESERVED', 2, 4000],
        ['DOWNLOADED', 1, 1000],
        ['DOWNLOADED', 2, 4000],
      ];
      for (const [status, attempt, base] of cases) {
        await seed(status, { meta_attempts: attempt });
        const outcome = await commit();
        expect(outcome).toMatchObject({
          kind: 'retry-scheduled',
          attempt,
          version: '3',
          receipt: {
            status,
            metaAttempts: attempt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCategory: 'META_TRANSPORT',
            lastErrorCode: 'NETWORK_FAILURE',
          },
        });
        const stored = await row();
        expect(stored).toMatchObject({
          status,
          version: '3',
          meta_attempts: attempt,
          lease_owner: null,
          lease_expires_at: null,
          last_error_category: 'META_TRANSPORT',
          last_error_code: 'NETWORK_FAILURE',
        });
        expect(await remainingMs()).toBeGreaterThan(base - 500);
        expect(await remainingMs()).toBeLessThanOrEqual(base * 1.25 + 100);
        if (status === 'DOWNLOADED') {
          expect(stored.downloaded_at).toBeInstanceOf(Date);
          expect(stored.response_mime_type).toBe('image/jpeg');
          expect(stored.detected_mime_type).toBe('image/jpeg');
          expect(stored.byte_count).toBe(1024);
          expect(Buffer.isBuffer(stored.content_sha256)).toBe(true);
        } else expect(stored.downloaded_at).toBeNull();
        expect(await outboxRows()).toHaveLength(0);
      }
    });

    it('retries every retryable transport code below the limit and terminalizes attempt 3', async () => {
      for (const code of [
        'FILE_IO_FAILURE',
        'NETWORK_FAILURE',
        'HTTP_RETRYABLE',
        'TIMEOUT',
        'ABORTED',
      ]) {
        await seed('RESERVED', { meta_attempts: 1 });
        expect((await commit({ code })).kind).toBe('retry-scheduled');
        expect(await outboxRows()).toHaveLength(0);
        await seed('RESERVED', { meta_attempts: 3 });
        const outcome = await commit({ code });
        expect(outcome).toMatchObject({
          kind: 'terminal',
          failureStage: 'META_EXHAUSTED_PRE_STORAGE',
          version: '3',
          intent: {
            dedupeKey: intentKey('3'),
            receiptMediaId: UUID_A,
            receiptStateVersion: '3',
            sourceWebhookMessageId: 'wamid.core',
            recipientId: SENDER,
            templateKey: 'RECEIPT_UNAVAILABLE_LATER',
            templateArgs: {},
          },
        });
        expect(await row()).toMatchObject({
          status: 'FAILED',
          failure_stage: 'META_EXHAUSTED_PRE_STORAGE',
          last_error_category: 'META_TRANSPORT',
          last_error_code: code,
        });
        expect((await row()).terminal_at).toBeInstanceOf(Date);
        expect(await outboxRows()).toHaveLength(1);
      }
    });

    it('terminalizes MEDIA_VALIDATION and HTTP_PERMANENT as validation pre-storage with one exact intent', async () => {
      const cases: Array<[string, string]> = [
        ['MEDIA_VALIDATION', 'UNSUPPORTED_MIME'],
        ['MEDIA_VALIDATION', 'INVALID_MEDIA_SIZE'],
        ['MEDIA_VALIDATION', 'MIME_MISMATCH'],
        ['MEDIA_VALIDATION', 'PNG_STRUCTURE_INVALID'],
        ['MEDIA_VALIDATION', 'JPEG_STRUCTURE_INVALID'],
        ['META_TRANSPORT', 'HTTP_PERMANENT'],
      ];
      for (const [category, code] of cases) {
        await seed('RESERVED', { meta_attempts: 2 });
        const outcome = await commit({ category, code });
        expect(outcome).toMatchObject({
          kind: 'terminal',
          failureStage: 'MEDIA_VALIDATION_PRE_STORAGE',
          version: '3',
          intent: {
            dedupeKey: intentKey('3'),
            receiptMediaId: UUID_A,
            receiptStateVersion: '3',
            sourceWebhookMessageId: 'wamid.core',
            recipientId: SENDER,
            templateKey: 'RECEIPT_UNAVAILABLE_LATER',
            templateArgs: {},
          },
        });
        expect(await row()).toMatchObject({
          status: 'FAILED',
          failure_stage: 'MEDIA_VALIDATION_PRE_STORAGE',
          last_error_category: category,
          last_error_code: code,
          meta_attempts: 2,
        });
        expect((await row()).terminal_at).toBeInstanceOf(Date);
        expect(await outboxRows()).toHaveLength(1);
      }
    });

    it('terminalizes the internal exhaustion code for a reclaimed meta_attempts=3 row and clears DOWNLOADED evidence', async () => {
      for (const status of ['RESERVED', 'DOWNLOADED']) {
        await seed(status, { meta_attempts: 3 });
        const outcome = await commit({ code: 'META_EXHAUSTED' });
        expect(outcome).toMatchObject({
          kind: 'terminal',
          failureStage: 'META_EXHAUSTED_PRE_STORAGE',
          version: '3',
          intent: {
            dedupeKey: intentKey('3'),
            templateKey: 'RECEIPT_UNAVAILABLE_LATER',
            templateArgs: {},
          },
        });
        const stored = await row();
        expect(stored).toMatchObject({
          status: 'FAILED',
          failure_stage: 'META_EXHAUSTED_PRE_STORAGE',
          last_error_category: 'META_TRANSPORT',
          last_error_code: 'META_EXHAUSTED',
          meta_attempts: 3,
          downloaded_at: null,
          response_mime_type: null,
          detected_mime_type: null,
          byte_count: null,
          content_sha256: null,
        });
        expect(stored.terminal_at).toBeInstanceOf(Date);
        expect(await outboxRows()).toHaveLength(1);
      }
    });

    it('validates the exact persisted intent on replay, repairs a legacy successor missing only its intent, and fences foreign or rival evidence', async () => {
      await seed('RESERVED', { meta_attempts: 3 });
      expect((await commit({ code: 'META_EXHAUSTED' })).kind).toBe('terminal');
      const successor = await row();
      const [owned] = await outboxRows();
      expect(await commit({ code: 'META_EXHAUSTED' })).toMatchObject({
        kind: 'replayed',
        version: '3',
        intent: { id: owned.id },
      });
      expect(await outboxRows()).toHaveLength(1);
      expect(await row()).toEqual(successor);
      // A mismatch in the persisted intent is foreign evidence: fence, never
      // replace it.
      await pool.query(
        "UPDATE receipt_media_outbox SET recipient_id = 'sender.rival'",
      );
      await expectFenced(command({ code: 'META_EXHAUSTED' }));
      expect((await outboxRows())[0].recipient_id).toBe('sender.rival');
      // Rival terminal evidence fences before any intent repair.
      await seedRow(
        legacyTerminal({
          failure_stage: 'MEDIA_VALIDATION_PRE_STORAGE',
          last_error_category: 'MEDIA_VALIDATION',
          last_error_code: 'MIME_MISMATCH',
          meta_attempts: 1,
        }),
      );
      await expectFenced(command({ code: 'META_EXHAUSTED' }));
      expect(await outboxRows()).toHaveLength(0);
      // A deterministic key publicly owned by a foreign intent fences.
      await seedRow(legacyTerminal());
      await pool.query(
        `INSERT INTO receipt_media_outbox (id, dedupe_key,
           source_webhook_message_id, recipient_id, template_key, template_args)
         VALUES ($1, $2, 'wamid.core', 'sender.rival',
           'RECEIPT_ATTACH_UNKNOWN', '{}'::jsonb)`,
        [UUID_C, intentKey('3')],
      );
      await expectFenced(command({ code: 'META_EXHAUSTED' }));
      expect(await outboxRows()).toHaveLength(1);
      expect((await outboxRows())[0]).toMatchObject({
        recipient_id: 'sender.rival',
      });
      // A legacy FAILED successor missing only its deterministic intent is
      // repaired under the exact command and live-lease replay fence.
      await seedRow(legacyTerminal());
      const repaired = await commit({ code: 'META_EXHAUSTED' });
      expect(repaired).toMatchObject({
        kind: 'replayed',
        version: '3',
        failureStage: 'META_EXHAUSTED_PRE_STORAGE',
        intent: {
          dedupeKey: intentKey('3'),
          templateKey: 'RECEIPT_UNAVAILABLE_LATER',
          templateArgs: {},
        },
      });
      const repairedRows = await outboxRows();
      expect(repairedRows).toHaveLength(1);
      expect(repairedRows[0]).toMatchObject({
        dedupe_key: intentKey('3'),
        receipt_media_id: UUID_A,
        receipt_state_version: '3',
        source_webhook_message_id: 'wamid.core',
        recipient_id: SENDER,
        template_key: 'RECEIPT_UNAVAILABLE_LATER',
        template_args: {},
      });
      expect(await commit({ code: 'META_EXHAUSTED' })).toMatchObject({
        kind: 'replayed',
        version: '3',
        intent: { id: repairedRows[0].id },
      });
      expect(await outboxRows()).toHaveLength(1);
      // A dead lease never repairs a legacy terminal successor.
      await seedRow(legacyTerminal());
      await pool.query(
        "UPDATE receipt_media SET lease_expires_at = now() - interval '1s' WHERE id = $1",
        [UUID_A],
      );
      await expectFenced(command({ code: 'META_EXHAUSTED' }));
      expect(await outboxRows()).toHaveLength(0);
    });

    it('treats every mismatched persisted intent field as foreign evidence and never replaces it', async () => {
      const commitThenAlter = async (sql: string) => {
        await seed('RESERVED', { meta_attempts: 3 });
        expect((await commit({ code: 'META_EXHAUSTED' })).kind).toBe(
          'terminal',
        );
        await pool.query(sql);
        await expectFenced(command({ code: 'META_EXHAUSTED' }));
        expect(await outboxRows()).toHaveLength(1);
      };
      await commitThenAlter(
        "UPDATE receipt_media_outbox SET recipient_id = 'sender.rival'",
      );
      await commitThenAlter(
        "UPDATE receipt_media_outbox SET source_webhook_message_id = 'wamid.rival'",
      );
      await commitThenAlter(
        'UPDATE receipt_media_outbox SET receipt_state_version = 2',
      );
      await commitThenAlter(
        'UPDATE receipt_media_outbox SET receipt_media_id = NULL',
      );
      await commitThenAlter(
        "UPDATE receipt_media_outbox SET template_key = 'RECEIPT_ATTACH_UNKNOWN'",
      );
      await commitThenAlter(
        `UPDATE receipt_media_outbox SET template_args = '{"extra":1}'::jsonb`,
      );
    });

    it('fences a terminal transition and a transient retry whose lock wait outlives the lease', async () => {
      for (const input of [
        command({ code: 'META_EXHAUSTED' }),
        command({ code: 'NETWORK_FAILURE' }),
      ]) {
        await seed('RESERVED', {
          meta_attempts: input.code === 'META_EXHAUSTED' ? 3 : 1,
          lease_expires_at: new Date(Date.now() + 250),
        });
        const before = await row();
        const locker = await pool.connect();
        let observedPending: Promise<unknown> | undefined;
        try {
          await locker.query('BEGIN');
          await locker.query(
            'UPDATE receipt_media SET updated_at = updated_at WHERE id = $1',
            [UUID_A],
          );
          const pending = metaStore().commitMetaFailureDisposition(input);
          observedPending = pending.catch(() => undefined);
          while (Date.now() < +(before.lease_expires_at as number) + 20)
            await new Promise((r) => setTimeout(r, 20));
          await locker.query('COMMIT');
          await expect(pending).resolves.toEqual({ kind: 'fenced' });
          expect(await row()).toEqual(before);
          expect(await outboxRows()).toHaveLength(0);
        } finally {
          await locker.query('ROLLBACK').catch(() => undefined);
          locker.release();
          await observedPending;
        }
      }
    });

    it('serializes exact replay intent validation against a concurrent foreign alteration and never replaces it', async () => {
      await seed('RESERVED', { meta_attempts: 3 });
      expect((await commit({ code: 'META_EXHAUSTED' })).kind).toBe('terminal');
      const [owned] = await outboxRows();
      const locker = await pool.connect();
      let observedPending: Promise<unknown> | undefined;
      try {
        await locker.query('BEGIN');
        await locker.query(
          'SELECT * FROM receipt_media_outbox WHERE dedupe_key = $1 FOR UPDATE',
          [intentKey('3')],
        );
        let settled = false;
        const pending = (async () => {
          const outcome = await commit({ code: 'META_EXHAUSTED' });
          settled = true;
          return outcome;
        })();
        observedPending = pending.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 150));
        expect(settled).toBe(false);
        await locker.query(
          "UPDATE receipt_media_outbox SET recipient_id = 'sender.rival' WHERE dedupe_key = $1",
          [intentKey('3')],
        );
        await locker.query('COMMIT');
        await expect(pending).resolves.toEqual({ kind: 'fenced' });
        expect(await outboxRows()).toHaveLength(1);
        expect((await outboxRows())[0]).toMatchObject({
          id: owned.id,
          recipient_id: 'sender.rival',
        });
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined);
        locker.release();
        await observedPending;
      }
    });

    it('serializes duplicate transient retries to one scheduled successor and fences the loser', async () => {
      await seed('RESERVED', { meta_attempts: 1 });
      const [a, b] = await Promise.all([commit(), commit()]);
      expect([a.kind, b.kind].sort()).toEqual(['fenced', 'retry-scheduled']);
      const stored = await row();
      expect(stored).toMatchObject({
        status: 'RESERVED',
        version: '3',
        lease_owner: null,
        lease_expires_at: null,
      });
      expect(await outboxRows()).toHaveLength(0);
    });

    it('serializes duplicate terminal commits to one state and one intent and fences a rival', async () => {
      await seed('RESERVED', { meta_attempts: 3 });
      const [a, b] = await Promise.all([
        commit({ code: 'META_EXHAUSTED' }),
        commit({ code: 'META_EXHAUSTED' }),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['replayed', 'terminal']);
      expect(await row()).toMatchObject({
        status: 'FAILED',
        version: '3',
        failure_stage: 'META_EXHAUSTED_PRE_STORAGE',
      });
      const intents = await outboxRows();
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        dedupe_key: intentKey('3'),
        template_key: 'RECEIPT_UNAVAILABLE_LATER',
        template_args: {},
      });
      await seed('RESERVED', { meta_attempts: 3 });
      const [c, d] = await Promise.all([
        commit({ code: 'META_EXHAUSTED' }),
        commit({ category: 'MEDIA_VALIDATION', code: 'MIME_MISMATCH' }),
      ]);
      expect([c.kind, d.kind].sort()).toEqual(['fenced', 'terminal']);
      expect(await row()).toMatchObject({ status: 'FAILED', version: '3' });
      expect(await outboxRows()).toHaveLength(1);
    });

    it('rolls back both terminal state and its intent when the outbox insert fails', async () => {
      await seed('RESERVED', { meta_attempts: 3 });
      const before = await row();
      await pool.query(`CREATE FUNCTION receipt_meta_outbox_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'meta outbox failure'; END; $$;
      CREATE TRIGGER receipt_meta_outbox_failure
        BEFORE INSERT ON receipt_media_outbox FOR EACH ROW
        EXECUTE FUNCTION receipt_meta_outbox_failure()`);
      try {
        await expect(commit({ code: 'META_EXHAUSTED' })).rejects.toThrow(
          'meta outbox failure',
        );
        expect(await row()).toEqual(before);
        expect(await outboxRows()).toHaveLength(0);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS
          receipt_meta_outbox_failure ON receipt_media_outbox;
          DROP FUNCTION IF EXISTS receipt_meta_outbox_failure()`);
      }
      // A pre-existing foreign intent at the deterministic key also rolls the
      // fresh FAILED transition back instead of replacing that evidence.
      await seed('RESERVED', { meta_attempts: 3 });
      const seeded = await row();
      await pool.query(
        `INSERT INTO receipt_media_outbox (id, dedupe_key,
           source_webhook_message_id, recipient_id, template_key, template_args)
         VALUES ($1, $2, 'wamid.core', 'sender.rival',
           'RECEIPT_ATTACH_UNKNOWN', '{}'::jsonb)`,
        [UUID_C, intentKey('3')],
      );
      await expectFenced(command({ code: 'META_EXHAUSTED' }));
      expect(await row()).toEqual(seeded);
      const [foreign] = await outboxRows();
      expect(foreign).toMatchObject({
        dedupe_key: intentKey('3'),
        recipient_id: 'sender.rival',
        template_key: 'RECEIPT_ATTACH_UNKNOWN',
      });
    });

    it('fences wrong fences, malformed categories/codes, and non-eligible states without durable mutation', async () => {
      await seed('RESERVED', { meta_attempts: 1 });
      for (const over of [
        { owner: 'worker.rival' },
        { expectedVersion: '1' },
        { expectedVersion: '4' },
        { expectedVersion: '2.5' },
        { expectedVersion: '0' },
        { id: UUID_C },
        { id: 'not-a-uuid' },
        { owner: '' },
        { category: 'MEDIA_VALIDATION', code: 'NETWORK_FAILURE' },
        { category: 'META_TRANSPORT', code: 'MIME_MISMATCH' },
        { category: 'META_TRANSPORT', code: 'META_EXHAUSTED' },
        { category: 'MEDIA_VALIDATION', code: 'META_EXHAUSTED' },
        { category: 'META_TRANSPORT', code: 'UNKNOWN' },
        { category: 'META_TRANSPORT', code: '' },
        { category: 'OTHER', code: 'NETWORK_FAILURE' },
      ]) {
        await expectFenced(command(over));
      }
      expect(await outboxRows()).toHaveLength(0);
      // meta_attempts = 0 has no attempt evidence to dispose.
      await seed('RESERVED', { meta_attempts: 0 });
      await expectFenced(command());
      // Attach-terminal rows are never Meta-disposition eligible.
      await seed('ATTACHED', { meta_attempts: 1 });
      await expectFenced(command());
      await seed('ATTACH_OUTCOME_UNKNOWN', { meta_attempts: 1 });
      await expectFenced(command());
      // A released lease never authorizes a disposition.
      await seed('RESERVED', { meta_attempts: 1 });
      await pool.query(
        'UPDATE receipt_media SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1',
        [UUID_A],
      );
      await expectFenced(command());
      expect(await outboxRows()).toHaveLength(0);
    });

    it('reclaims exhausted count-3 rows for terminalization while refusing a fourth Meta attempt and holding attach-terminal rows', async () => {
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
      const reserved = lifeRow('RESERVED', null, {
        id: UUID_A,
        webhook_message_id: 'wamid.rec-r',
        provider_media_id: 'media.rec-r',
        sender_id: 'sender.rec-r',
        captured_sale_id: UUID_B,
        meta_attempts: 3,
        next_attempt_at: T0,
      });
      const downloaded = lifeRow('DOWNLOADED', null, {
        id: UUID_B,
        webhook_message_id: 'wamid.rec-d',
        provider_media_id: 'media.rec-d',
        sender_id: 'sender.rec-d',
        captured_sale_id: UUID_C,
        meta_attempts: 3,
        next_attempt_at: T0,
      });
      const exhaustedStorage = lifeRow('DOWNLOADED', null, {
        id: UUID_C,
        webhook_message_id: 'wamid.rec-s',
        provider_media_id: 'media.rec-s',
        sender_id: 'sender.rec-s',
        captured_sale_id: UUID_A,
        meta_attempts: 3,
        storage_attempts: 3,
        next_attempt_at: T0,
      });
      const stored = lifeRow('ATTACHED', null, {
        id: '33333333-3333-4333-8333-333333333333',
        webhook_message_id: 'wamid.rec-t',
        provider_media_id: 'media.rec-t',
        sender_id: 'sender.rec-t',
        captured_sale_id: UUID_B,
        meta_attempts: 3,
        next_attempt_at: T0,
      });
      for (const receipt of [reserved, downloaded, exhaustedStorage, stored])
        await pool.query(
          insertSql('receipt_media', receipt),
          Object.values(receipt),
        );
      const claimed = await store.claimBatch(5, OWNER);
      expect(claimed.map((r) => r.id).sort()).toEqual([UUID_A, UUID_B, UUID_C]);
      for (const receipt of claimed) {
        expect(receipt.metaAttempts).toBe(3);
        expect(
          await store.startMetaAttempt({
            id: receipt.id,
            owner: OWNER,
            expectedVersion: receipt.version,
          }),
        ).toBeNull();
      }
      // R2: storage_attempts counts backend upload attempts, capped at
      // MAX_UPLOAD_ATTEMPTS (6), so a row at 3 may still start an upload.
      expect(
        await store.startStorageAttempt({
          id: UUID_C,
          owner: OWNER,
          expectedVersion: '1',
        }),
      ).toMatchObject({ attempt: 4 });
    });
  });

  // --- ODD-4C identity-aware durable active-image lookup (RM1, RM3) ---
  describe('ODD-4C identity-aware durable active-image lookup', () => {
    const SENDER = 'sender.active';
    const ACTIVE = 'RESERVED DOWNLOADED'.split(' ');
    const TERMINAL = 'ATTACHED FAILED ATTACH_OUTCOME_UNKNOWN'.split(' ');
    const unrelated = (sender = SENDER) => ({
      senderId: sender,
      webhookMessageId: 'wamid.unrelated',
      providerMediaId: 'media.unrelated',
    });
    type Query = ReturnType<typeof unrelated>;
    /** Structural seam keeps this spec runnable before the port method
     * exists; the real PostgreSQL store is exercised either way. */
    const findActive = (input: Query): Promise<string | null> =>
      (
        store as unknown as {
          findActiveBySender(i: Query): Promise<string | null>;
        }
      ).findActiveBySender(input);
    const admit = (over: Row): Promise<ReservationOutcome> =>
      store.admit({
        senderId: SENDER,
        capturedSaleId: UUID_B,
        ...over,
      } as ReserveInput);
    const count = async (sql: string): Promise<number> =>
      (await pool.query<{ n: number }>(sql)).rows[0].n;
    const receiptCount = () =>
      count('SELECT count(*)::int AS n FROM receipt_media');
    const markerCount = () =>
      count('SELECT count(*)::int AS n FROM processed_webhook_messages');
    const seed = async (status: string, sender = SENDER): Promise<void> => {
      await pool.query(
        'TRUNCATE processed_webhook_messages, receipt_media_outbox, receipt_media',
      );
      const row = lifeRow(
        status,
        status === 'FAILED' ? 'ATTACH_DEFINITE' : null,
        {
          webhook_message_id: 'wamid.active',
          provider_media_id: 'media.active',
          sender_id: sender,
        },
      );
      await pool.query(insertSql('receipt_media', row), Object.values(row));
    };
    it.each([
      ...ACTIVE.map((s) => [s, s] as const),
      ...TERMINAL.map((s) => [s, null] as const),
    ])('projects %s to %s', async (status, expected) => {
      await seed(status);
      await expect(findActive(unrelated())).resolves.toBe(expected);
    });
    it('returns null for an absent sender', async () => {
      await expect(findActive(unrelated('sender.missing'))).resolves.toBeNull();
    });
    it('parameter-binds adversarial sender values without altering SQL structure', async () => {
      const nasty = "sender'); DROP TABLE receipt_media;--";
      await seed('RESERVED', nasty);
      await expect(findActive(unrelated(nasty))).resolves.toBe('RESERVED');
      await expect(
        findActive(unrelated("sender' OR '1'='1")),
      ).resolves.toBeNull();
      expect(await receiptCount()).toBe(1);
    });
    it('takes no row lock: an uncommitted writer does not block the lookup', async () => {
      await seed('RESERVED');
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          "UPDATE receipt_media SET sender_id = 'sender.locked' WHERE id = $1",
          [UUID_A],
        );
        // The uncommitted writer holds the row lock; a plain read does not block.
        const outcome = await Promise.race([
          findActive(unrelated()),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000)),
        ]);
        expect(outcome).toBe('RESERVED');
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
      }
    });
    it.each<[string, string, Record<string, unknown>]>([
      ['wamid.active', 'media.blank', { kind: 'webhook-media-conflict' }],
      [
        'wamid.blank',
        'media.active',
        { kind: 'provider-media-reused', receipt: expect.any(Object) },
      ],
    ])(
      'excludes the identity overlap %s/%s from the lookup while admit owns its outcome',
      async (webhookMessageId, providerMediaId, outcome) => {
        await seed('RESERVED');
        await expect(
          findActive({ senderId: SENDER, webhookMessageId, providerMediaId }),
        ).resolves.toBeNull();
        await expect(
          admit({
            id: UUID_B,
            webhookMessageId,
            providerMediaId,
          }),
        ).resolves.toEqual(outcome);
        expect(await receiptCount()).toBe(1);
        expect(await markerCount()).toBe(1);
      },
    );
    it('still projects an unrelated active row', async () => {
      await seed('RESERVED');
      await expect(findActive(unrelated())).resolves.toBe('RESERVED');
    });
    it('returns the committed winner status for a sender-active admit keeping one receipt', async () => {
      await seed('DOWNLOADED');
      await expect(
        admit({
          id: UUID_B,
          webhookMessageId: 'wamid.rival',
          providerMediaId: 'media.rival',
        }),
      ).resolves.toEqual({ kind: 'sender-active', status: 'DOWNLOADED' });
      expect(await receiptCount()).toBe(1);
    });
    it('rethrows the original conflict when no active row survives', async () => {
      await pool.query(
        'TRUNCATE processed_webhook_messages, receipt_media_outbox, receipt_media',
      );
      // Force the active-sender conflict with no durable winner, so the
      // post-conflict reload finds nothing and admit rethrows.
      await pool.query(`CREATE FUNCTION forced_active_sender_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced active sender conflict' USING ERRCODE = '23505', CONSTRAINT = 'receipt_media_active_sender_idx'; END; $$;
        CREATE TRIGGER forced_active_sender_conflict BEFORE INSERT ON receipt_media FOR EACH ROW EXECUTE FUNCTION forced_active_sender_conflict()`);
      try {
        await expect(
          admit({
            id: UUID_A,
            webhookMessageId: 'wamid.gone',
            providerMediaId: 'media.gone',
          }),
        ).rejects.toThrow('forced active sender conflict');
        expect(await receiptCount()).toBe(0);
      } finally {
        await pool.query(
          'DROP TRIGGER IF EXISTS forced_active_sender_conflict ON receipt_media; DROP FUNCTION IF EXISTS forced_active_sender_conflict()',
        );
      }
      expect(await markerCount()).toBe(0);
    });
  });

  // R3: 3300, 3400 and 3500 are irreversible, so even empty tables cannot
  // be rolled back; the tables stay and the dropped amount-dialog table is
  // gone.
  it('keeps both empty tables when the irreversible down refuses', async () => {
    await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
    await expect(migrateDownTo3600()).rejects.toThrow();
    migrate('migrate');
    for (const table of ['receipt_media', 'receipt_media_outbox']) {
      const { rows } = await pool.query<{ t: string | null }>(
        'SELECT to_regclass($1) AS t',
        [table],
      );
      expect(rows[0].t).toBe(table);
    }
    const { rows: cancellationTables } = await pool.query<{ t: string | null }>(
      "SELECT to_regclass('receipt_media_cancellation_commands') AS t",
    );
    expect(cancellationTables[0].t).toBeNull();
  });
});
