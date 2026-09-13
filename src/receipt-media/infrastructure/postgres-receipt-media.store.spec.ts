import { execSync } from 'node:child_process';
import type { PoolClient, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import type {
  AmountBootstrapInput,
  AmountProposalInput,
  AmountProposalOutcome,
  AmountRejectionInput,
  AmountRejectionOutcome,
  AttachStartInput,
  AttachStartOutcome,
  AttemptStartResult,
  LeaseFenceInput,
  OutboxIntentInput,
  ReceiptCancellationInput,
  ReceiptCancellationOutcome,
  ReceiptMediaStorePort,
  ReservationOutcome,
  ReserveInput,
  StatusCasInput,
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

// --- WU2A2A cross-field lifecycle/evidence/lease fixtures (RM1, RM3) ---
const T0 = new Date('2025-01-01T00:00:00Z');
const downloadEvidence: Row = {
  downloaded_at: T0,
  response_mime_type: 'image/jpeg',
  detected_mime_type: 'image/jpeg',
  byte_count: 1024,
  content_sha256: Buffer.alloc(32, 1),
};
const acceptedEvidence: Row = {
  stored_at: T0,
  object_etag: 'etag.core',
  capability_token_hash: Buffer.alloc(32, 2),
  capability_key_version: 1,
  capability_issued_at: T0,
};
const attachEvidence: Row = {
  attach_started_at: T0,
  attach_attempts: 1,
  attach_attempt_id: UUID_B,
  attach_request_started_at: T0,
};
const downstreamStatuses =
  'STORED AWAITING_AMOUNT AWAITING_CONFIRMATION ATTACHING ATTACHED CANCELLED ATTACH_OUTCOME_UNKNOWN'.split(
    ' ',
  );

const lifeRow = (status: string, stage: string | null, over: Row = {}): Row => {
  const definite = stage === 'ATTACH_DEFINITE';
  const row: Row = { status, failure_stage: stage };
  if (
    status === 'DOWNLOADED' ||
    downstreamStatuses.includes(status) ||
    definite
  )
    Object.assign(row, downloadEvidence);
  if (downstreamStatuses.includes(status) || definite)
    Object.assign(row, acceptedEvidence);
  if (
    [
      'AWAITING_CONFIRMATION',
      'ATTACHING',
      'ATTACHED',
      'ATTACH_OUTCOME_UNKNOWN',
    ].includes(status) ||
    definite
  )
    row.declared_amount_cents = 1250;
  if (status === 'ATTACHING') row.attach_started_at = T0;
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
  if (stage === 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE')
    Object.assign(row, downloadEvidence);
  if (definite) row.attach_http_status = 400;
  return receiptRow({ ...row, ...over });
};

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
  let store: PostgresReceiptMediaStore;

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
    ['capability_key_version', 0, false],
    ['capability_key_version', 1, false],
    ['declared_amount_cents', 0, false],
    ['declared_amount_cents', 1, true],
    ['attach_attempts', 2, false],
    ['attach_attempts', 1, false],
    ['meta_attempts', -1, false],
    ['meta_attempts', 4, false],
    ['meta_attempts', 3, true],
    ['storage_attempts', 4, false],
    ['cleanup_attempts', -1, false],
  ])('receipt_media.%s accepts/rejects %j', async (col, value, ok) => {
    await expectInserts([['receipt_media', receiptRow({ [col]: value }), ok]]);
  });

  it.each([
    ['content_sha256', 32, false],
    ['content_sha256', 31, false],
    ['capability_token_hash', 32, false],
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
    ['no object pre-store', 'RESERVED', null, acceptedEvidence],
    ['object required', 'STORED', null, { object_etag: null }],
    ['bytes required', 'DOWNLOADED', null, { byte_count: null }],
    ['no download early', 'RESERVED', null, { downloaded_at: T0 }],
    ['amount blocked', 'AWAITING_AMOUNT', null, { declared_amount_cents: 100 }],
    ['amount required', 'ATTACHING', null, { declared_amount_cents: null }],
    ['start required', 'ATTACHING', null, { attach_started_at: null }],
    ['request id paired', 'ATTACHED', null, { attach_attempt_id: null }],
    ['no request early', 'STORED', null, { attach_attempt_id: UUID_B }],
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
    ['cleanup after object', 'STORED', null, { cleanup_pending: true }],
    ['failed staged', 'FAILED', null, {}],
    ['nonfailed unstaged', 'RESERVED', 'META_EXHAUSTED_PRE_STORAGE', {}],
  ];
  const validReceipts: Array<[string, string, string | null, Row]> = [
    ['pre-request ok', 'ATTACHING', null, {}],
    ['request ok', 'ATTACHING', null, attachEvidence],
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
    [
      'cleanup pre-store ok',
      'FAILED',
      'MEDIA_VALIDATION_PRE_STORAGE',
      { cleanup_pending: true },
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
      object_key: `receipts/${UUID_B}`,
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
    'receipt_media_capability_lookup_idx receipt_media_status_updated_idx ' +
    'receipt_media_unknown_outcome_idx receipt_media_webhook_message_id_key ' +
    'receipt_media_provider_media_id_key receipt_media_object_key_key ' +
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
      ['receipt_media', altRow({ status: 'STORED' }), false],
    ]);
    await expectInserts([
      ['receipt_media', receiptRow(), true],
      ['receipt_media', altRow({ sender_id: 'sender.other' }), true],
    ]);
  });

  it.each([
    ['FAILED', 'META_EXHAUSTED_PRE_STORAGE'],
    ['CANCELLED', null],
    ['ATTACHED', null],
    ['ATTACH_OUTCOME_UNKNOWN', null],
  ])('active-sender partial unique excludes terminal %s', async (s, st) => {
    await expectInserts([
      ['receipt_media', lifeRow(s, st, {}), true],
      ['receipt_media', altRow(), true],
    ]);
  });

  it('capability lookup partial unique enforces hash uniqueness', async () => {
    await expectInserts([
      ['receipt_media', lifeRow('STORED', null, {}), true],
      [
        'receipt_media',
        lifeRow('STORED', null, {
          id: UUID_B,
          webhook_message_id: 'wamid.alt',
          provider_media_id: 'media.alt',
          object_key: `receipts/${UUID_B}`,
        }),
        false,
      ],
    ]);
  });

  it('capability lookup partial unique excludes null hashes', async () => {
    await expectInserts([
      ['receipt_media', receiptRow(), true],
      ['receipt_media', altRow({ sender_id: 'sender.nullhash' }), true],
    ]);
  });

  it.each([
    [
      'claim queue',
      'receipt_media_claim_idx',
      [
        'next_attempt_at,created_at',
        "status='RESERVED'ANDmeta_attempts<3",
        "status='DOWNLOADED'ANDstorage_attempts<3ANDmeta_attempts<3",
        "status='STORED'",
        "status='ATTACHING'ANDattach_attempts=0ANDattach_request_started_atISNULLANDattach_attempt_idISNULL",
      ],
      [],
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

  const tryMigrateDown = (): string => {
    try {
      migrate('migrate:down');
      migrate('migrate:down');
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
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
    );
    await pool.query(insertSql(table, row), Object.values(row));
    expect(tryMigrateDown()).toMatch(/refus/i);
    const { rows } = await pool.query<{ a: boolean; b: boolean }>(
      "SELECT to_regclass('receipt_media') IS NOT NULL AS a, " +
        "to_regclass('receipt_media_outbox') IS NOT NULL AS b",
    );
    expect(rows[0]).toMatchObject({ a: true, b: true });
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
    );
  });

  // --- WU2B1 reservation arbitration and intent dedupe (RM1, RM3) ---

  describe('WU2B1 reservation arbitration and intent dedupe', () => {
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
    });

    const reserveInput = (over: Row = {}): ReserveInput => ({
      id: UUID_A,
      webhookMessageId: 'wamid.r1',
      providerMediaId: 'media.r1',
      senderId: 'sender.r1',
      capturedSaleId: UUID_B,
      objectKey: `receipts/${UUID_A}`,
      ...over,
    });

    const rivalInput = (over: Row = {}): ReserveInput =>
      reserveInput({ id: UUID_B, objectKey: `receipts/${UUID_B}`, ...over });

    it('reserves with declared MIME and replays the exact webhook once', async () => {
      const first = await store.reserve(
        reserveInput({ declaredMimeType: 'image/jpeg' }),
      );
      if (first.kind !== 'created') throw new Error('expected created');
      expect(first.receipt.declaredMimeType).toBe('image/jpeg');
      const replay = await store.reserve(reserveInput());
      if (replay.kind !== 'webhook-replayed')
        throw new Error('expected replay');
      expect(replay.receipt.id).toBe(first.receipt.id);
    });

    it('rethrows unrelated constraint violations', async () => {
      await store.reserve(reserveInput());
      await expect(
        store.reserve(
          rivalInput({
            webhookMessageId: 'wamid.x',
            providerMediaId: 'media.x',
            senderId: 'sender.x',
            objectKey: `receipts/${UUID_A}`,
          }),
        ),
      ).rejects.toThrow();
    });

    it('parameter-binds adversarial values without altering SQL structure', async () => {
      const nasty = "wamid'); DROP TABLE receipt_media;--";
      const out = await store.reserve(
        reserveInput({ webhookMessageId: nasty }),
      );
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
        store.reserve(reserveInput()),
        store.reserve(rival),
      ]);
      expect([x.kind, y.kind].sort()).toEqual(['created', kind]);
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM receipt_media',
      );
      expect(rows[0].n).toBe(1);
    });

    const outboxInput = (over: Partial<OutboxIntentInput> = {}) => ({
      dedupeKey: 'dk.r1',
      receiptMediaId: null,
      receiptStateVersion: null,
      sourceWebhookMessageId: 'wamid.r1',
      recipientId: 'sender.r1',
      templateKey: 'RECEIPT_AMOUNT_PROMPT' as const,
      templateArgs: { cents: 1250 },
      ...over,
    });

    it('dedupes repeated keys, supporting nullable receipt linkage', async () => {
      const first = await store.insertOutboxIntent(outboxInput());
      expect(first.created).toBe(true);
      expect(first.intent).toMatchObject({
        status: 'PENDING',
        receiptMediaId: null,
      });
      const replay = await store.insertOutboxIntent(
        outboxInput({ templateArgs: { cents: 999 } }),
      );
      expect(replay.created).toBe(false);
      expect(replay.intent.id).toBe(first.intent.id);
      expect(replay.intent.templateArgs).toEqual({ cents: 1250 });
    });

    it('returns the same original id and payload for concurrent duplicate keys', async () => {
      const [x, y] = await Promise.all([
        store.insertOutboxIntent(outboxInput()),
        store.insertOutboxIntent(outboxInput()),
      ]);
      expect(x.intent.id).toBe(y.intent.id);
      expect(x.intent.templateArgs).toEqual(y.intent.templateArgs);
      expect([x.created, y.created].sort()).toEqual([false, true]);
    });
  });

  // --- WU2B2A leased claims and fenced lease bookkeeping (RM1, RM3) ---

  describe('WU2B2A leased claims and fenced lease bookkeeping', () => {
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
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
        object_key: `receipts/c${seq}`,
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
      ['RESERVED', { meta_attempts: 3 }, false],
      ['DOWNLOADED', {}, true],
      ['DOWNLOADED', { meta_attempts: 3 }, false],
      ['DOWNLOADED', { storage_attempts: 3 }, false],
      ['STORED', { meta_attempts: 3, storage_attempts: 3 }, true],
      ['ATTACHING', {}, true],
      ['ATTACHING', attachEvidence, false],
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

    it('releases only the live owner at the expected version, preserving it', async () => {
      await insert(claimRow('RESERVED'));
      const claimed = await claim();
      const f = fence(claimed);
      expect(await store.releaseLease({ ...f, owner: 'w0' })).toBe(false);
      expect(await store.releaseLease({ ...f, expectedVersion: '9' })).toBe(
        false,
      );
      const s = await state(claimed.id);
      expect(s.version).toBe('1');
      expect(s.lease_owner).toBe('w1');
      expect(await store.releaseLease(f)).toBe(true);
      const released = await state(claimed.id);
      expect(released.version).toBe('1');
      expect(released.lease_owner).toBeNull();
      expect(released.lease_expires_at).toBeNull();
      expect((await claim('w2')).id).toBe(claimed.id);
    });

    it('an expired owner cannot renew or release before or after reclaim', async () => {
      await insert(claimRow('RESERVED'));
      const stale = await claim();
      const f = fence(stale);
      await pool.query(
        "UPDATE receipt_media SET lease_expires_at = now() - interval '1s' " +
          'WHERE id = $1',
        [stale.id],
      );
      expect(await store.renewLease(f)).toBe(false);
      expect(await store.releaseLease(f)).toBe(false);
      expect((await state(stale.id)).version).toBe('1');
      expect((await claim('w2')).id).toBe(stale.id);
      expect(await store.renewLease(f)).toBe(false);
      expect(await store.releaseLease(f)).toBe(false);
      expect((await state(stale.id)).version).toBe('2');
    });

    // --- WU2B2B status CAS and bounded pre-call attempts (RM1, RM3) ---

    describe('WU2B2B status CAS and bounded pre-call attempts', () => {
      beforeEach(async () => {
        await pool.query(
          'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
        );
      });

      type Counter = 'meta' | 'storage';
      const COL = { meta: 'meta_attempts', storage: 'storage_attempts' };
      const cas = (
        over: { id: string } & Partial<StatusCasInput>,
      ): StatusCasInput => ({
        owner: 'w1',
        expectedStatus: 'STORED',
        expectedVersion: '1',
        nextStatus: 'AWAITING_AMOUNT',
        ...over,
      });
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

      it('transitions only through the fenced status CAS', async () => {
        await insert(claimRow('STORED'));
        const claimed = await claim();
        const f = { id: claimed.id };
        const losers = [
          { owner: 'w0' },
          { expectedStatus: 'RESERVED' },
          { expectedVersion: '9' },
        ] as const;
        for (const over of losers) {
          expect(await store.transitionStatus(cas({ ...f, ...over }))).toBe(
            false,
          );
          expect(await state(claimed.id)).toMatchObject({ status: 'STORED' });
          expect((await state(claimed.id)).version).toBe('1');
        }
        await expire(claimed.id);
        expect(await store.transitionStatus(cas(f))).toBe(false);
        expect((await claim('w2')).id).toBe(claimed.id);
        expect(await store.transitionStatus(cas(f))).toBe(false);
        expect(await state(claimed.id)).toMatchObject({
          status: 'STORED',
          version: '2',
        });
        expect(
          await store.transitionStatus(
            cas({ ...f, owner: 'w2', expectedVersion: '2' }),
          ),
        ).toBe(true);
        expect(await state(claimed.id)).toMatchObject({
          status: 'AWAITING_AMOUNT',
          version: '3',
        });
      });

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
          await insert(claimRow(counter === 'meta' ? 'STORED' : 'RESERVED'));
          const staged = await claim('w3');
          expect(await start(counter, fence(staged, 'w3'))).toBeNull();
          expect(await state(claimed.id)).toMatchObject({
            [COL[counter]]: 0,
            version: '2',
          });
          expect(await state(staged.id)).toMatchObject({
            [COL[counter]]: 0,
            version: '1',
          });
        },
      );

      it.each<[Counter, string]>([
        ['meta', 'RESERVED'],
        ['storage', 'DOWNLOADED'],
      ])(
        'starts three %s attempts and refuses a fourth',
        async (counter, status) => {
          await insert(claimRow(status));
          const claimed = await claim();
          const f = fence(claimed);
          for (let i = 1, v = claimed.version; i <= 3; i++, v = String(i)) {
            expect(await start(counter, { ...f, expectedVersion: v })).toEqual({
              attempt: i,
              version: String(i + 1),
            });
          }
          expect(
            await start(counter, { ...f, expectedVersion: '4' }),
          ).toBeNull();
          expect(await state(claimed.id)).toMatchObject({
            [COL[counter]]: 3,
            version: '4',
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

      it('proves generic status CAS cannot create a schema-valid DOWNLOADED row', async () => {
        await insert(claimRow('RESERVED'));
        const claimed = await claim();
        await expect(
          store.transitionStatus({
            id: claimed.id,
            owner: 'w1',
            expectedStatus: 'RESERVED',
            expectedVersion: claimed.version,
            nextStatus: 'DOWNLOADED',
          }),
        ).rejects.toThrow();
        expect(await state(claimed.id)).toMatchObject({
          status: 'RESERVED',
          version: '1',
        });
      });

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
        const wrong = claimRow('STORED');
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

  // --- WU6B capability access lookup (RMA2, RMA3) ---

  describe('WU6B capability access lookup', () => {
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
    });

    const KNOWN_HASH = Buffer.alloc(32, 2); // acceptedEvidence default
    const accessRow = (over: Row = {}): Row => lifeRow('STORED', null, over);
    const insertAccess = async (row: Row): Promise<void> => {
      await pool.query(insertSql('receipt_media', row), Object.values(row));
    };

    it('projects only id/object key/stored hash/revocation for a known hash', async () => {
      await insertAccess(accessRow());
      const hit = await store.lookupByCapabilityHash(KNOWN_HASH);
      expect(hit).not.toBeNull();
      expect(Object.keys(hit as object).sort()).toEqual([
        'capabilityRevokedAt',
        'capabilityTokenHash',
        'id',
        'objectKey',
      ]);
      expect(hit?.id).toBe(UUID_A);
      expect(hit?.objectKey).toBe(`receipts/${UUID_C}`);
      expect(
        Buffer.compare(hit?.capabilityTokenHash ?? Buffer.alloc(0), KNOWN_HASH),
      ).toBe(0);
      expect(hit?.capabilityRevokedAt).toBeNull();
    });

    it('returns null for unknown and altered hashes', async () => {
      await insertAccess(accessRow());
      expect(
        await store.lookupByCapabilityHash(Buffer.alloc(32, 9)),
      ).toBeNull();
      const altered = Buffer.from(KNOWN_HASH);
      altered[7] = 0xff;
      expect(await store.lookupByCapabilityHash(altered)).toBeNull();
    });

    it('returns revoked rows carrying their revocation timestamp', async () => {
      await insertAccess(accessRow({ capability_revoked_at: T0 }));
      const hit = await store.lookupByCapabilityHash(KNOWN_HASH);
      expect(hit).not.toBeNull();
      expect(hit?.capabilityRevokedAt).toEqual(T0);
      expect(hit?.id).toBe(UUID_A);
    });

    it.each([31, 33, 0])(
      'fails closed to null for a %d-byte hash without a query',
      async (len) => {
        await insertAccess(accessRow());
        const spy = jest.spyOn(pool, 'query');
        try {
          expect(
            await store.lookupByCapabilityHash(Buffer.alloc(len, 2)),
          ).toBeNull();
          expect(spy.mock.calls).toEqual([]);
        } finally {
          spy.mockRestore();
        }
      },
    );

    // WU6B R2 regression: any throw while recognizing the hash input
    // must fail closed to null before the query. A Proxy can pass
    // Buffer.isBuffer while its actual view throws on recognition reads
    // — even a fully transparent one, because TypedArray prototype
    // getters brand-check the receiver and reject proxy receivers.
    type ProxyDef = { target: object; traps?: ProxyHandler<object> };
    const lengthThrows: ProxyHandler<object> = {
      get: (t, prop, recv) => {
        if (prop === 'length') throw new Error('length trap');
        return Reflect.get(t, prop, recv) as unknown;
      },
    };
    const getThrows: ProxyHandler<object> = {
      get: () => {
        throw new Error('get trap');
      },
    };
    const protoThrows: ProxyHandler<object> = {
      getPrototypeOf: () => {
        throw new Error('proto trap');
      },
    };
    const lengthSpoofs: ProxyHandler<object> = {
      get: (t, prop, recv) =>
        prop === 'length' ? 32 : (Reflect.get(t, prop, recv) as unknown),
    };

    it.each<[string, ProxyDef]>([
      ['transparent real-buffer proxy', { target: Buffer.from(KNOWN_HASH) }],
      [
        'length-get-throws proxy',
        { target: Buffer.from(KNOWN_HASH), traps: lengthThrows },
      ],
      [
        'all-get-throws proxy',
        { target: Buffer.from(KNOWN_HASH), traps: getThrows },
      ],
      [
        'getPrototypeOf-throws proxy',
        { target: Buffer.from(KNOWN_HASH), traps: protoThrows },
      ],
      ['non-buffer plain-object proxy', { target: {} }],
      [
        'length-spoofing real-buffer proxy',
        { target: Buffer.from(KNOWN_HASH), traps: lengthSpoofs },
      ],
    ])('fails closed to null without a query for a %s', async (_label, def) => {
      await insertAccess(accessRow());
      const spy = jest.spyOn(pool, 'query') as jest.Mock;
      spy.mockResolvedValue({ rows: [], rowCount: 0 });
      try {
        const input = new Proxy(def.target, def.traps ?? {}) as Buffer;
        await expect(store.lookupByCapabilityHash(input)).resolves.toBeNull();
        expect(spy.mock.calls).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it('propagates database errors without swallowing them', async () => {
      await insertAccess(accessRow());
      const spy = jest.spyOn(pool, 'query') as jest.Mock;
      spy.mockRejectedValueOnce(new Error('db unavailable'));
      try {
        await expect(store.lookupByCapabilityHash(KNOWN_HASH)).rejects.toThrow(
          'db unavailable',
        );
      } finally {
        spy.mockRestore();
      }
    });

    // --- WU6C capability revocation (store-only mutation) ---

    describe('WU6C capability revocation', () => {
      beforeEach(async () => {
        await pool.query(
          'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
        );
      });

      const KNOWN_HASH = Buffer.alloc(32, 2); // acceptedEvidence default
      const insertRevocable = async (over: Row = {}): Promise<void> => {
        const row = lifeRow('STORED', null, over);
        await pool.query(insertSql('receipt_media', row), Object.values(row));
      };
      const rawRow = async (id: string): Promise<Row> =>
        (
          await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [
            id,
          ])
        ).rows[0];
      const count = async (): Promise<number> =>
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM receipt_media',
          )
        ).rows[0].n;

      it('revokes an accepted capability and stamps both timestamps', async () => {
        await insertRevocable({ updated_at: T0 });
        await expect(store.revokeCapability(UUID_A)).resolves.toBe(true);
        const row = await rawRow(UUID_A);
        expect(row.capability_revoked_at).toBeInstanceOf(Date);
        // Both columns are stamped by the same now() call inside the
        // single revocation statement, so they must be identical.
        expect(row.updated_at).toEqual(row.capability_revoked_at);
        expect((row.updated_at as Date).getTime()).toBeGreaterThan(
          T0.getTime(),
        );
      });

      it('exposes the revocation timestamp through the capability lookup', async () => {
        await insertRevocable();
        await store.revokeCapability(UUID_A);
        const hit = await store.lookupByCapabilityHash(KNOWN_HASH);
        expect(hit?.capabilityRevokedAt).toBeInstanceOf(Date);
      });

      it('a repeat revocation returns false and preserves the first timestamps', async () => {
        await insertRevocable();
        await store.revokeCapability(UUID_A);
        const first = await rawRow(UUID_A);
        await expect(store.revokeCapability(UUID_A)).resolves.toBe(false);
        const second = await rawRow(UUID_A);
        expect(second.capability_revoked_at).toEqual(
          first.capability_revoked_at,
        );
        expect(second.updated_at).toEqual(first.updated_at);
      });

      it('returns false for an unknown id and touches no row', async () => {
        await insertRevocable();
        await expect(store.revokeCapability(UUID_B)).resolves.toBe(false);
        expect(await rawRow(UUID_A)).toMatchObject({
          capability_revoked_at: null,
        });
        expect(await count()).toBe(1);
      });

      it('returns false and leaves the row untouched without capability evidence', async () => {
        const capabilityLess = receiptRow();
        await pool.query(
          insertSql('receipt_media', capabilityLess),
          Object.values(capabilityLess),
        );
        await expect(store.revokeCapability(UUID_A)).resolves.toBe(false);
        const row = await rawRow(UUID_A);
        expect(row.capability_revoked_at).toBeNull();
        expect(row.status).toBe('RESERVED');
      });

      it('concurrent revocations mutate exactly once with one timestamp', async () => {
        await insertRevocable();
        const [a, b] = await Promise.all([
          store.revokeCapability(UUID_A),
          store.revokeCapability(UUID_A),
        ]);
        expect([a, b].filter(Boolean)).toHaveLength(1);
        const row = await rawRow(UUID_A);
        expect(row.capability_revoked_at).toBeInstanceOf(Date);
      });

      it('preserves all other lifecycle and accepted-object evidence', async () => {
        await insertRevocable();
        const before = await rawRow(UUID_A);
        await store.revokeCapability(UUID_A);
        const after = await rawRow(UUID_A);
        for (const col of [
          'status',
          'version',
          'object_key',
          'stored_at',
          'object_etag',
          'capability_token_hash',
          'capability_key_version',
          'capability_issued_at',
          'webhook_message_id',
          'provider_media_id',
        ])
          expect(after[col]).toEqual(before[col]);
        expect(
          Buffer.compare(after.capability_token_hash as Buffer, KNOWN_HASH),
        ).toBe(0);
      });

      it('parameter-binds the id: a malformed uuid is a type error, never SQL alteration', async () => {
        await insertRevocable();
        await expect(
          store.revokeCapability(`"${UUID_A}' OR '1'='1"`),
        ).rejects.toThrow(/invalid input syntax for type uuid/);
        expect(await count()).toBe(1);
        expect(await rawRow(UUID_A)).toMatchObject({
          capability_revoked_at: null,
        });
        await expect(store.revokeCapability(UUID_A)).resolves.toBe(true);
      });

      it('propagates database errors without swallowing them', async () => {
        await insertRevocable();
        const spy = jest.spyOn(pool, 'query') as jest.Mock;
        spy.mockRejectedValueOnce(new Error('db unavailable'));
        try {
          await expect(store.revokeCapability(UUID_A)).rejects.toThrow(
            'db unavailable',
          );
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('parameter-binds adversarial hash bytes without altering SQL', async () => {
      await insertAccess(accessRow());
      const nasty = Buffer.from("'; DROP TABLE receipt_media;--aa", 'utf8');
      expect(nasty.length).toBe(32);
      expect(await store.lookupByCapabilityHash(nasty)).toBeNull();
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM receipt_media',
      );
      expect(rows[0].n).toBe(1);
      expect((await store.lookupByCapabilityHash(KNOWN_HASH))?.id).toBe(UUID_A);
    });
  });

  // --- WU8R2 atomic DOWNLOADED → AWAITING_AMOUNT bootstrap ---

  describe('WU8R2 atomic amount bootstrap', () => {
    type BootstrapInput = AmountBootstrapInput;
    type BootstrapOutcome =
      | { kind: 'bootstrapped' | 'replayed'; receipt: Row; intent: Row }
      | { kind: 'fenced' };
    type BootstrapStore = {
      bootstrapAmount(input: BootstrapInput): Promise<BootstrapOutcome>;
    };
    const SENDER = 'sender.amount-bootstrap';
    const OWNER = 'worker.amount-bootstrap';
    const CAPABILITY_HASH = Buffer.alloc(32, 8);
    const bootstrap = (target: BootstrapStore, input: BootstrapInput) =>
      target.bootstrapAmount(input);
    const command = (over: Partial<BootstrapInput> = {}): BootstrapInput => ({
      id: UUID_A,
      owner: OWNER,
      expectedVersion: '2',
      objectEtag: 'etag.amount-bootstrap',
      objectVersionId: 'version.amount-bootstrap',
      capabilityTokenHash: CAPABILITY_HASH,
      capabilityKeyVersion: 1,
      ...over,
    });
    const seed = async (
      data: unknown = { sibling: { keep: true } },
      over: Row = {},
    ) => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
      await pool.query('DELETE FROM conversation_state WHERE sender_id = $1', [
        SENDER,
      ]);
      const receipt = lifeRow('DOWNLOADED', null, {
        sender_id: SENDER,
        captured_sale_id: UUID_B,
        webhook_message_id: 'wamid.amount-bootstrap',
        version: '2',
        lease_owner: OWNER,
        lease_expires_at: new Date(Date.now() + 60_000),
        ...over,
      });
      await pool.query(
        insertSql('receipt_media', receipt),
        Object.values(receipt),
      );
      if (typeof data !== 'symbol')
        await pool.query(
          'INSERT INTO conversation_state (sender_id, last_message_at, data) VALUES ($1, now(), $2::jsonb)',
          [SENDER, JSON.stringify(data)],
        );
    };
    const snapshot = async () => {
      const [receipt, conversation, outbox] = await Promise.all([
        pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [UUID_A]),
        pool.query<Row>(
          'SELECT data FROM conversation_state WHERE sender_id = $1',
          [SENDER],
        ),
        pool.query<Row>('SELECT * FROM receipt_media_outbox'),
      ]);
      return {
        receipt: receipt.rows[0],
        conversation: conversation.rows[0]?.data,
        outbox: outbox.rows,
      };
    };
    const expectFenced = async (
      input = command(),
      target: BootstrapStore = store as unknown as BootstrapStore,
    ) => {
      const before = await snapshot();
      await expect(bootstrap(target, input)).resolves.toEqual({
        kind: 'fenced',
      });
      expect(await snapshot()).toEqual(before);
    };

    it('atomically derives the initial pointer and empty prompt from the locked receipt while preserving siblings', async () => {
      await seed();
      const outcome = await bootstrap(
        store as unknown as BootstrapStore,
        {
          ...command(),
          senderId: 'attacker',
          capturedSaleId: UUID_C,
          sourceWebhookMessageId: 'wamid.attacker',
        } as BootstrapInput,
      );
      expect(outcome).toMatchObject({
        kind: 'bootstrapped',
        receipt: {
          id: UUID_A,
          status: 'AWAITING_AMOUNT',
          version: '3',
          objectEtag: 'etag.amount-bootstrap',
          objectVersionId: 'version.amount-bootstrap',
          capabilityTokenHash: CAPABILITY_HASH,
          capabilityKeyVersion: 1,
        },
        intent: {
          receiptMediaId: UUID_A,
          receiptStateVersion: '3',
          sourceWebhookMessageId: 'wamid.amount-bootstrap',
          recipientId: SENDER,
          templateKey: 'RECEIPT_AMOUNT_PROMPT',
          templateArgs: {},
        },
      });
      const durable = await snapshot();
      expect(durable.receipt.stored_at).toBeInstanceOf(Date);
      expect(durable.receipt.capability_issued_at).toBeInstanceOf(Date);
      expect(durable.conversation).toEqual({
        sibling: { keep: true },
        receiptAmountPointer: {
          receiptMediaId: UUID_A,
          saleId: UUID_B,
          receiptVersion: '3',
        },
      });
      expect(durable.outbox).toHaveLength(1);
    });

    it.each<[string, Partial<BootstrapInput>]>([
      ['nullable object version', { objectVersionId: null }],
      [
        'max int32 capability key version',
        { capabilityKeyVersion: 2_147_483_647 },
      ],
    ])('accepts %s', async (_label, over) => {
      await seed();
      await expect(
        bootstrap(store as unknown as BootstrapStore, command(over)),
      ).resolves.toMatchObject({ kind: 'bootstrapped' });
    });

    it.each<[string, Partial<BootstrapInput>, Row]>([
      ['malformed object etag', { objectEtag: '' }, {}],
      ['non-string object etag', { objectEtag: 1 as never }, {}],
      ['malformed object version', { objectVersionId: '' }, {}],
      ['non-string object version', { objectVersionId: 1 as never }, {}],
      ['short capability hash', { capabilityTokenHash: Buffer.alloc(31) }, {}],
      ['long capability hash', { capabilityTokenHash: Buffer.alloc(33) }, {}],
      ['zero capability key version', { capabilityKeyVersion: 0 }, {}],
      ['fractional capability key version', { capabilityKeyVersion: 1.5 }, {}],
      [
        'unsafe capability key version',
        { capabilityKeyVersion: Number.MAX_SAFE_INTEGER + 1 },
        {},
      ],
      [
        'database-overflow key version',
        { capabilityKeyVersion: 2_147_483_648 },
        {},
      ],
      ['wrong owner', { owner: 'worker.rival' }, {}],
      ['wrong version', { expectedVersion: '1' }, {}],
      ['wrong state', {}, { status: 'STORED', ...acceptedEvidence }],
    ])('fences %s without mutation', async (_label, over, receiptOver) => {
      await seed({ sibling: { keep: true } }, receiptOver);
      await expectFenced(command(over));
    });

    it.each<[string, unknown]>([
      ['missing conversation', Symbol('missing conversation')],
      ['null conversation', null],
      ['array conversation', []],
      [
        'malformed pointer',
        { receiptAmountPointer: { receiptMediaId: UUID_A } },
      ],
      [
        'already-bearing pointer',
        {
          receiptAmountPointer: {
            receiptMediaId: UUID_A,
            saleId: UUID_B,
            receiptVersion: '2',
          },
        },
      ],
    ])('fences a %s without mutation', async (_label, data) => {
      await seed(data);
      await expectFenced();
    });

    it('fences expired or lost leases and successor overflow', async () => {
      await seed(undefined, { lease_expires_at: new Date(Date.now() - 1_000) });
      await expectFenced();
      const max = '9223372036854775807';
      await seed({ sibling: true }, { version: max });
      await expectFenced(command({ expectedVersion: max }));
    });

    it('replays only the exact durable successor across adapter recreation', async () => {
      await seed();
      const input = command();
      expect(
        (await bootstrap(store as unknown as BootstrapStore, input)).kind,
      ).toBe('bootstrapped');
      const recreated = new PostgresReceiptMediaStore(
        pool,
      ) as unknown as BootstrapStore;
      expect((await bootstrap(recreated, input)).kind).toBe('replayed');
      for (const changed of [
        command({ objectEtag: 'etag.changed' }),
        command({ objectVersionId: null }),
        command({ capabilityTokenHash: Buffer.alloc(32, 9) }),
        command({ capabilityKeyVersion: 2 }),
      ])
        await expectFenced(changed, recreated);
      await pool.query(
        "UPDATE conversation_state SET data = data - 'receiptAmountPointer'",
      );
      await expectFenced(input);
      await pool.query(
        "UPDATE conversation_state SET data = jsonb_set(data, '{receiptAmountPointer}', $1::jsonb)",
        [
          JSON.stringify({
            receiptMediaId: UUID_A,
            saleId: UUID_B,
            receiptVersion: '3',
          }),
        ],
      );
      await pool.query(
        'UPDATE receipt_media_outbox SET template_args = \'{"extra":1}\'::jsonb',
      );
      await expectFenced(input);
    });

    it.each<['receipt' | 'pointer' | 'intent']>([
      ['receipt'],
      ['pointer'],
      ['intent'],
    ])('rolls back all mutations when %s persistence fails', async (part) => {
      await seed();
      const before = await snapshot();
      const table =
        part === 'receipt'
          ? 'receipt_media'
          : part === 'pointer'
            ? 'conversation_state'
            : 'receipt_media_outbox';
      const trigger = `receipt_amount_bootstrap_${part}_failure`;
      const body =
        part === 'pointer'
          ? 'BEGIN RETURN NULL; END;'
          : `BEGIN RAISE EXCEPTION 'bootstrap ${part} failure'; END;`;
      await pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${trigger} BEFORE ${part === 'intent' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        if (part === 'pointer') await expectFenced();
        else
          await expect(
            bootstrap(store as unknown as BootstrapStore, command()),
          ).rejects.toThrow(`bootstrap ${part} failure`);
        expect(await snapshot()).toEqual(before);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      }
    });

    it('fences a replay with a missing intent or altered successor pointer', async () => {
      await seed();
      const input = command();
      await bootstrap(store as unknown as BootstrapStore, input);
      await pool.query('DELETE FROM receipt_media_outbox');
      await expectFenced(input);
      await seed();
      await bootstrap(store as unknown as BootstrapStore, input);
      await pool.query(
        `UPDATE conversation_state SET data = jsonb_set(data,
         '{receiptAmountPointer}', $1::jsonb)`,
        [
          JSON.stringify({
            receiptMediaId: UUID_A,
            saleId: UUID_C,
            receiptVersion: '3',
          }),
        ],
      );
      await expectFenced(input);
    });

    it('accepts MAX_BIGINT minus one once and fences a reclaimed lease', async () => {
      const prior = '9223372036854775806';
      await seed({ sibling: true }, { version: prior });
      await expect(
        bootstrap(
          store as unknown as BootstrapStore,
          command({ expectedVersion: prior }),
        ),
      ).resolves.toMatchObject({
        kind: 'bootstrapped',
        receipt: { version: '9223372036854775807' },
      });
      await seed();
      await store.releaseLease({
        id: UUID_A,
        owner: OWNER,
        expectedVersion: '2',
      });
      expect((await store.claimBatch(1, 'worker.reclaimed'))[0].id).toBe(
        UUID_A,
      );
      await expectFenced();
    });

    it.each<[string, () => Promise<unknown>]>([
      [
        'changed object evidence',
        () =>
          pool.query("UPDATE receipt_media SET object_etag = 'etag.changed'"),
      ],
      [
        'changed capability evidence',
        () => pool.query('UPDATE receipt_media SET capability_key_version = 2'),
      ],
      [
        'revoked capability',
        () =>
          pool.query('UPDATE receipt_media SET capability_revoked_at = now()'),
      ],
      [
        'wrong prompt source',
        () =>
          pool.query(
            "UPDATE receipt_media_outbox SET source_webhook_message_id = 'wamid.rival'",
          ),
      ],
      [
        'wrong prompt recipient',
        () =>
          pool.query(
            "UPDATE receipt_media_outbox SET recipient_id = 'sender.rival'",
          ),
      ],
      [
        'wrong prompt version',
        () =>
          pool.query(
            'UPDATE receipt_media_outbox SET receipt_state_version = 2',
          ),
      ],
      [
        'malformed prompt arguments',
        () =>
          pool.query(
            "UPDATE receipt_media_outbox SET template_args = '[]'::jsonb",
          ),
      ],
    ])('fences replay with %s', async (_label, mutate) => {
      await seed();
      const input = command();
      await bootstrap(store as unknown as BootstrapStore, input);
      await mutate();
      await expectFenced(input);
    });

    it.each<[string, boolean]>([
      ['initial bootstrap', false],
      ['durable replay', true],
    ])(
      'fences %s after its conversation lock wait outlives the lease',
      async (_label, replay) => {
        await seed();
        const input = command();
        if (replay)
          await expect(
            bootstrap(store as unknown as BootstrapStore, input),
          ).resolves.toMatchObject({ kind: 'bootstrapped' });
        await pool.query(
          "UPDATE receipt_media SET lease_expires_at = clock_timestamp() + interval '200 milliseconds'",
        );
        const before = await snapshot();
        const locker = await pool.connect();
        let inTransaction = false;
        try {
          await locker.query('BEGIN');
          inTransaction = true;
          await locker.query(
            'SELECT sender_id FROM conversation_state WHERE sender_id = $1 FOR UPDATE',
            [SENDER],
          );
          let settled = false;
          const operation = bootstrap(
            store as unknown as BootstrapStore,
            input,
          );
          void operation.finally(() => {
            settled = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(settled).toBe(false);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await locker.query('COMMIT');
          inTransaction = false;
          await expect(operation).resolves.toEqual({ kind: 'fenced' });
          expect(await snapshot()).toEqual(before);
        } finally {
          if (inTransaction)
            await locker.query('ROLLBACK').catch(() => undefined);
          locker.release();
        }
      },
    );

    it.each<[string, BootstrapInput]>([
      ['null input', null as unknown as BootstrapInput],
      [
        'symbol expected version',
        command({ expectedVersion: Symbol('version') as never }),
      ],
    ])('fails closed without opening SQL for %s', async (_label, input) => {
      const connect = jest.spyOn(pool, 'connect');
      try {
        await expect(
          bootstrap(store as unknown as BootstrapStore, input),
        ).resolves.toEqual({ kind: 'fenced' });
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });

    it('serializes duplicate and rival bootstraps with one durable winner', async () => {
      await seed();
      const duplicate = await Promise.all([
        bootstrap(store as unknown as BootstrapStore, command()),
        bootstrap(store as unknown as BootstrapStore, command()),
      ]);
      expect(duplicate.map((outcome) => outcome.kind).sort()).toEqual([
        'bootstrapped',
        'replayed',
      ]);
      await seed();
      const rival = await Promise.all([
        bootstrap(store as unknown as BootstrapStore, command()),
        bootstrap(
          store as unknown as BootstrapStore,
          command({ objectEtag: 'etag.rival' }),
        ),
      ]);
      expect(rival.map((outcome) => outcome.kind).sort()).toEqual([
        'bootstrapped',
        'fenced',
      ]);
    });

    it('propagates a capability-hash uniqueness collision and rolls back', async () => {
      await seed();
      const collision = lifeRow('STORED', null, {
        id: UUID_C,
        webhook_message_id: 'wamid.amount-bootstrap.collision',
        provider_media_id: 'media.amount-bootstrap.collision',
        sender_id: 'sender.amount-bootstrap.collision',
        captured_sale_id: UUID_C,
        object_key: 'receipts/amount-bootstrap-collision',
        capability_token_hash: CAPABILITY_HASH,
      });
      await pool.query(
        insertSql('receipt_media', collision),
        Object.values(collision),
      );
      await expect(
        bootstrap(store as unknown as BootstrapStore, command()),
      ).rejects.toThrow();
      expect((await snapshot()).receipt).toMatchObject({
        status: 'DOWNLOADED',
        version: '2',
      });
      const durable = await snapshot();
      expect(durable.conversation).toEqual({ sibling: { keep: true } });
      expect(durable.outbox).toEqual([]);
    });
  });

  // --- WU10C1 atomic receipt amount proposal (PostgreSQL only) ---

  describe('WU10C1 atomic amount proposal', () => {
    const proposalStore: Pick<ReceiptMediaStorePort, 'proposeAmount'> = {
      proposeAmount: (input) => store.proposeAmount(input),
    };
    const SENDER = 'sender.amount';
    const POINTER = {
      receiptMediaId: UUID_A,
      saleId: UUID_B,
      receiptVersion: '2',
    };
    const command = (over: Partial<AmountProposalInput> = {}) => ({
      sourceWebhookMessageId: 'wamid.amount.1',
      senderId: SENDER,
      receiptMediaId: UUID_A,
      capturedSaleId: UUID_B,
      expectedReceiptStatus: 'AWAITING_AMOUNT' as const,
      expectedReceiptVersion: '2',
      expectedPointer: POINTER,
      cents: 1250,
      ...over,
    });
    const seed = async (
      data: Row = { sibling: { keep: true }, receiptAmountPointer: POINTER },
      receiptOver: Row = {},
    ) => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
      await pool.query('DELETE FROM conversation_state WHERE sender_id = $1', [
        SENDER,
      ]);
      await pool.query(
        insertSql(
          'receipt_media',
          lifeRow('AWAITING_AMOUNT', null, {
            sender_id: SENDER,
            captured_sale_id: UUID_B,
            version: '2',
            ...receiptOver,
          }),
        ),
        Object.values(
          lifeRow('AWAITING_AMOUNT', null, {
            sender_id: SENDER,
            captured_sale_id: UUID_B,
            version: '2',
            ...receiptOver,
          }),
        ),
      );
      await pool.query(
        `INSERT INTO conversation_state (sender_id, last_message_at, data)
             VALUES ($1, now(), $2::jsonb)`,
        [SENDER, JSON.stringify(data)],
      );
    };
    const rawReceipt = async () =>
      (
        await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [
          UUID_A,
        ])
      ).rows[0];
    const rawConversation = async () =>
      (
        await pool.query<Row>(
          'SELECT data FROM conversation_state WHERE sender_id = $1',
          [SENDER],
        )
      ).rows[0].data as Row;

    it('commits receipt evidence, the exact successor pointer, siblings, and one confirmation intent together', async () => {
      await seed();
      const outcome = await proposalStore.proposeAmount(command());
      expect(outcome.kind).toBe('proposed');
      if (outcome.kind === 'fenced') throw new Error('expected proposal');
      expect(outcome.receipt).toMatchObject({
        id: UUID_A,
        status: 'AWAITING_CONFIRMATION',
        declaredAmountCents: 1250,
        version: '3',
      });
      expect(outcome.intent).toMatchObject({
        receiptMediaId: UUID_A,
        receiptStateVersion: '3',
        sourceWebhookMessageId: 'wamid.amount.1',
        recipientId: SENDER,
        templateKey: 'RECEIPT_AMOUNT_CONFIRM',
        templateArgs: { cents: 1250 },
      });
      expect((await rawReceipt()).amount_proposed_at).toBeInstanceOf(Date);
      expect(await rawConversation()).toEqual({
        sibling: { keep: true },
        receiptAmountPointer: { ...POINTER, receiptVersion: '3' },
      });
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM receipt_media_outbox WHERE receipt_media_id = $1',
        [UUID_A],
      );
      expect(rows[0].n).toBe(1);
    });

    it.each<[string, Row]>([
      ['absent', { sibling: true }],
      ['null', { receiptAmountPointer: null }],
      ['scalar', { receiptAmountPointer: 'bad' }],
      ['extra key', { receiptAmountPointer: { ...POINTER, extra: true } }],
      [
        'wrong receipt',
        { receiptAmountPointer: { ...POINTER, receiptMediaId: UUID_C } },
      ],
      ['wrong sale', { receiptAmountPointer: { ...POINTER, saleId: UUID_C } }],
      [
        'wrong version',
        { receiptAmountPointer: { ...POINTER, receiptVersion: '3' } },
      ],
    ])(
      'fences a %s conversation pointer without changing receipt or outbox',
      async (_label, data) => {
        await seed(data);
        await expect(proposalStore.proposeAmount(command())).resolves.toEqual({
          kind: 'fenced',
        });
        expect(await rawReceipt()).toMatchObject({
          status: 'AWAITING_AMOUNT',
          declared_amount_cents: null,
          version: '2',
        });
        expect(await rawConversation()).toEqual(data);
        expect(
          (await pool.query('SELECT * FROM receipt_media_outbox')).rowCount,
        ).toBe(0);
      },
    );

    it.each<[string, Partial<AmountProposalInput>, Row]>([
      ['wrong sender', { senderId: 'sender.other' }, {}],
      ['wrong captured sale', { capturedSaleId: UUID_C }, {}],
      [
        'malformed receipt id',
        {
          receiptMediaId: 'not-a-uuid',
          expectedPointer: { ...POINTER, receiptMediaId: 'not-a-uuid' },
        },
        {},
      ],
      ['wrong stored status', {}, { status: 'STORED' }],
      ['wrong receipt version', { expectedReceiptVersion: '1' }, {}],
      [
        'oversized receipt version',
        { expectedReceiptVersion: '9223372036854775808' },
        {},
      ],
    ])(
      'fences a %s receipt command without retargeting it',
      async (_label, over, receiptOver) => {
        await seed(undefined, receiptOver);
        await expect(
          proposalStore.proposeAmount(command(over)),
        ).resolves.toEqual({
          kind: 'fenced',
        });
        expect(await rawReceipt()).toMatchObject({
          status: receiptOver.status ?? 'AWAITING_AMOUNT',
          declared_amount_cents: null,
          version: '2',
        });
        expect(
          (await pool.query('SELECT * FROM receipt_media_outbox')).rowCount,
        ).toBe(0);
      },
    );

    it.each<[number, 'proposed' | 'fenced']>([
      [1, 'proposed'],
      [2_147_483_647, 'proposed'],
      [1.5, 'fenced'],
      [0, 'fenced'],
      [-1, 'fenced'],
      [2_147_483_648, 'fenced'],
    ])('accepts only positive int32 cents: %i', async (cents, kind) => {
      await seed();
      await expect(
        proposalStore.proposeAmount(command({ cents })),
      ).resolves.toMatchObject({
        kind,
      });
    });

    it.each([
      [`${UUID_A}\n`, UUID_B],
      [`{${UUID_A}}`, UUID_B],
      [UUID_A, UUID_B.replaceAll('-', '')],
      [UUID_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase()],
    ])(
      'fences noncanonical command identities before SQL',
      async (receiptMediaId, capturedSaleId) => {
        await seed();
        const connect = jest.spyOn(pool, 'connect');
        await expect(
          proposalStore.proposeAmount(
            command({
              receiptMediaId,
              capturedSaleId,
              expectedPointer: {
                ...POINTER,
                receiptMediaId,
                saleId: capturedSaleId,
              },
            }),
          ),
        ).resolves.toEqual({ kind: 'fenced' });
        expect(connect).not.toHaveBeenCalled();
        connect.mockRestore();
      },
    );

    it('fences an outer null conversation payload without querying a malformed state', async () => {
      await seed(null as unknown as Row);
      await expect(proposalStore.proposeAmount(command())).resolves.toEqual({
        kind: 'fenced',
      });
      expect(await rawReceipt()).toMatchObject({
        status: 'AWAITING_AMOUNT',
        version: '2',
      });
    });

    it('rolls back receipt and pointer when the confirmation outbox insert fails', async () => {
      await seed();
      await pool.query(`CREATE FUNCTION receipt_amount_outbox_failure()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'receipt amount outbox failure'; END;
        $$`);
      await pool.query(`CREATE TRIGGER receipt_amount_outbox_failure
        BEFORE INSERT ON receipt_media_outbox
        FOR EACH ROW EXECUTE FUNCTION receipt_amount_outbox_failure()`);
      try {
        await expect(proposalStore.proposeAmount(command())).rejects.toThrow(
          'receipt amount outbox failure',
        );
        expect(await rawReceipt()).toMatchObject({
          status: 'AWAITING_AMOUNT',
          declared_amount_cents: null,
          version: '2',
        });
        expect(await rawConversation()).toEqual({
          sibling: { keep: true },
          receiptAmountPointer: POINTER,
        });
      } finally {
        await pool.query(
          'DROP TRIGGER IF EXISTS receipt_amount_outbox_failure ON receipt_media_outbox',
        );
        await pool.query(
          'DROP FUNCTION IF EXISTS receipt_amount_outbox_failure()',
        );
      }
    });

    it('rolls back the receipt when the post-mutation pointer CAS returns zero', async () => {
      await seed();
      await pool.query(`CREATE FUNCTION receipt_amount_pointer_fence()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`);
      await pool.query(`CREATE TRIGGER receipt_amount_pointer_fence
        BEFORE UPDATE ON conversation_state FOR EACH ROW
        EXECUTE FUNCTION receipt_amount_pointer_fence()`);
      try {
        await expect(proposalStore.proposeAmount(command())).resolves.toEqual({
          kind: 'fenced',
        });
        expect(await rawReceipt()).toMatchObject({
          status: 'AWAITING_AMOUNT',
          declared_amount_cents: null,
          version: '2',
        });
      } finally {
        await pool.query(
          'DROP TRIGGER IF EXISTS receipt_amount_pointer_fence ON conversation_state',
        );
        await pool.query(
          'DROP FUNCTION IF EXISTS receipt_amount_pointer_fence()',
        );
      }
    });

    it('fences a retry after the pointer advances without further mutation', async () => {
      await seed();
      const first = command();
      await proposalStore.proposeAmount(first);
      await pool.query(
        `UPDATE conversation_state SET data = jsonb_set(data,
           '{receiptAmountPointer,receiptVersion}', '"4"'::jsonb)
         WHERE sender_id = $1`,
        [SENDER],
      );
      await expect(proposalStore.proposeAmount(first)).resolves.toEqual({
        kind: 'fenced',
      });
      expect(await rawReceipt()).toMatchObject({ version: '3' });
      expect(
        (await pool.query('SELECT * FROM receipt_media_outbox')).rowCount,
      ).toBe(1);
    });

    it('advances MAX_BIGINT minus one once and fences successor overflow', async () => {
      const prior = '9223372036854775806';
      const pointer = { ...POINTER, receiptVersion: prior };
      await seed(
        { sibling: { keep: true }, receiptAmountPointer: pointer },
        { version: prior },
      );
      await expect(
        proposalStore.proposeAmount(
          command({ expectedReceiptVersion: prior, expectedPointer: pointer }),
        ),
      ).resolves.toMatchObject({
        kind: 'proposed',
        receipt: { version: '9223372036854775807' },
      });
      const max = '9223372036854775807';
      await seed(
        {
          sibling: { keep: true },
          receiptAmountPointer: { ...POINTER, receiptVersion: max },
        },
        { version: max },
      );
      await expect(
        proposalStore.proposeAmount(
          command({
            expectedReceiptVersion: max,
            expectedPointer: { ...POINTER, receiptVersion: max },
          }),
        ),
      ).resolves.toEqual({ kind: 'fenced' });
    });

    it('replays only the same amount webhook across adapter recreation and rejects new-webhook or amount rivals', async () => {
      await seed();
      const first = command();
      expect((await proposalStore.proposeAmount(first)).kind).toBe('proposed');
      const recreated = new PostgresReceiptMediaStore(pool);
      expect((await recreated.proposeAmount(first)).kind).toBe('replayed');
      await expect(
        recreated.proposeAmount(
          command({ sourceWebhookMessageId: 'wamid.amount.2' }),
        ),
      ).resolves.toEqual({
        kind: 'fenced',
      });
      await expect(
        recreated.proposeAmount(command({ cents: 999 })),
      ).resolves.toEqual({
        kind: 'fenced',
      });
      expect(
        (await pool.query('SELECT * FROM receipt_media_outbox')).rowCount,
      ).toBe(1);
    });

    it('serializes concurrent duplicate proposals to one proposal and one replay', async () => {
      await seed();
      const [a, b] = await Promise.all([
        proposalStore.proposeAmount(command()),
        proposalStore.proposeAmount(command()),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['proposed', 'replayed']);
      expect(
        (await pool.query('SELECT * FROM receipt_media_outbox')).rowCount,
      ).toBe(1);
    });

    it('serializes concurrent rival proposals without replacement or partial durable state', async () => {
      await seed();
      const [a, b] = await Promise.all([
        proposalStore.proposeAmount(command()),
        proposalStore.proposeAmount(
          command({ sourceWebhookMessageId: 'wamid.amount.2' }),
        ),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['fenced', 'proposed']);
      expect(await rawReceipt()).toMatchObject({
        status: 'AWAITING_CONFIRMATION',
        version: '3',
      });
      expect(
        (await pool.query('SELECT * FROM receipt_media_outbox')).rowCount,
      ).toBe(1);
    });
  });

  describe('WU10C2A atomic amount rejection', () => {
    const reject = (
      target: Pick<ReceiptMediaStorePort, 'rejectProposedAmount'>,
      input: AmountRejectionInput,
    ) => target.rejectProposedAmount(input);
    const SENDER = 'sender.amount-reject';
    const POINTER = {
      receiptMediaId: UUID_A,
      saleId: UUID_B,
      receiptVersion: '3',
    };
    const command = (over: Partial<AmountRejectionInput> = {}) => ({
      sourceWebhookMessageId: 'wamid.amount-reject.1',
      senderId: SENDER,
      receiptMediaId: UUID_A,
      capturedSaleId: UUID_B,
      expectedReceiptStatus: 'AWAITING_CONFIRMATION' as const,
      expectedReceiptVersion: '3',
      expectedPointer: POINTER,
      ...over,
    });
    const seed = async (
      data: unknown = {
        sibling: { keep: true },
        receiptAmountPointer: POINTER,
      },
      receiptOver: Row = {},
    ) => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
      await pool.query('DELETE FROM conversation_state WHERE sender_id = $1', [
        SENDER,
      ]);
      const receipt = lifeRow('AWAITING_CONFIRMATION', null, {
        sender_id: SENDER,
        captured_sale_id: UUID_B,
        version: '3',
        amount_proposed_at: T0,
        ...receiptOver,
      });
      await pool.query(
        insertSql('receipt_media', receipt),
        Object.values(receipt),
      );
      await pool.query(
        `INSERT INTO conversation_state (sender_id, last_message_at, data)
             VALUES ($1, now(), $2::jsonb)`,
        [SENDER, JSON.stringify(data)],
      );
    };
    const snapshot = async () => {
      const [receipt, conversation, outbox] = await Promise.all([
        pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [UUID_A]),
        pool.query<Row>(
          'SELECT data FROM conversation_state WHERE sender_id = $1',
          [SENDER],
        ),
        pool.query<Row>('SELECT * FROM receipt_media_outbox'),
      ]);
      return {
        receipt: receipt.rows[0],
        conversation: conversation.rows[0].data as Row,
        outbox: outbox.rows,
      };
    };
    const expectFenced = async (
      input: AmountRejectionInput,
      target: Pick<ReceiptMediaStorePort, 'rejectProposedAmount'> = store,
    ) => {
      const before = await snapshot();
      await expect(reject(target, input)).resolves.toEqual({ kind: 'fenced' });
      expect(await snapshot()).toEqual(before);
    };
    const withRollback = async (
      trigger: string,
      table: string,
      body: string,
      assertion: () => Promise<unknown>,
    ) => {
      await seed();
      const before = await snapshot();
      await pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$`,
      );
      await pool.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE OR INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        await assertion();
        expect(await snapshot()).toEqual(before);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
        await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      }
    };
    it('atomically clears amount evidence, advances the exact pointer, preserves siblings, and inserts one reask intent', async () => {
      await seed();
      const outcome = await reject(store, command());
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'fenced') throw new Error('expected rejection');
      expect(outcome.receipt).toMatchObject({
        id: UUID_A,
        status: 'AWAITING_AMOUNT',
        declaredAmountCents: null,
        amountProposedAt: null,
        version: '4',
      });
      expect(outcome.intent).toMatchObject({
        receiptMediaId: UUID_A,
        receiptStateVersion: '4',
        sourceWebhookMessageId: 'wamid.amount-reject.1',
        recipientId: SENDER,
        templateKey: 'RECEIPT_AMOUNT_REASK',
        templateArgs: {},
      });
      expect((await snapshot()).conversation).toEqual({
        sibling: { keep: true },
        receiptAmountPointer: { ...POINTER, receiptVersion: '4' },
      });
      expect((await snapshot()).outbox).toHaveLength(1);
    });
    it.each<[string, Partial<AmountRejectionInput>, Row]>([
      ['wrong sender', { senderId: 'sender.other' }, {}],
      [
        'wrong receipt',
        {
          receiptMediaId: UUID_C,
          expectedPointer: { ...POINTER, receiptMediaId: UUID_C },
        },
        {},
      ],
      [
        'wrong sale',
        {
          capturedSaleId: UUID_C,
          expectedPointer: { ...POINTER, saleId: UUID_C },
        },
        {},
      ],
      [
        'wrong status',
        {},
        {
          status: 'STORED',
          declared_amount_cents: null,
          amount_proposed_at: null,
        },
      ],
      [
        'wrong version',
        {
          expectedReceiptVersion: '2',
          expectedPointer: { ...POINTER, receiptVersion: '2' },
        },
        {},
      ],
    ])(
      'fences a %s command without durable mutation',
      async (_label, over, receiptOver) => {
        await seed(undefined, receiptOver);
        await expectFenced(command(over));
      },
    );
    it.each<[string, unknown]>([
      ['absent', { sibling: true }],
      ['null', { receiptAmountPointer: null }],
      ['scalar', { receiptAmountPointer: 'bad' }],
      ['extra-key', { receiptAmountPointer: { ...POINTER, extra: true } }],
    ])('fences a %s pointer without mutation', async (_label, data) => {
      await seed(data);
      await expectFenced(command());
    });
    it('fences a noncanonical identity before opening a transaction', async () => {
      await seed();
      const capturedSaleId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
      const before = await snapshot();
      const connect = jest.spyOn(pool, 'connect');
      try {
        await expect(
          reject(
            store,
            command({
              capturedSaleId,
              expectedPointer: { ...POINTER, saleId: capturedSaleId },
            }),
          ),
        ).resolves.toEqual({ kind: 'fenced' });
        expect(connect).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
      } finally {
        connect.mockRestore();
      }
    });

    it('fences an outer null payload and a missing proposal timestamp permitted by the schema', async () => {
      await seed(null);
      await expectFenced(command());
      await seed();
      await pool.query(
        'UPDATE receipt_media SET amount_proposed_at = NULL WHERE id = $1',
        [UUID_A],
      );
      await expectFenced(command());
    });
    it('rolls back receipt state when pointer CAS loses after receipt mutation', async () => {
      await withRollback(
        'receipt_amount_reject_pointer_fence',
        'conversation_state',
        'BEGIN RETURN NULL; END;',
        () =>
          expect(reject(store, command())).resolves.toEqual({ kind: 'fenced' }),
      );
    });

    it('rolls back receipt state when the reask outbox insert fails', async () => {
      await withRollback(
        'receipt_amount_reject_outbox_failure',
        'receipt_media_outbox',
        "BEGIN RAISE EXCEPTION 'receipt amount reask outbox failure'; END;",
        () =>
          expect(reject(store, command())).rejects.toThrow(
            'receipt amount reask outbox failure',
          ),
      );
    });

    it('replays only the exact durable successor across adapter recreation and fences rivals or an advanced pointer', async () => {
      await seed();
      const first = command();
      expect((await reject(store, first)).kind).toBe('rejected');
      const recreated = new PostgresReceiptMediaStore(pool);
      expect((await reject(recreated, first)).kind).toBe('replayed');
      await expectFenced(
        command({ sourceWebhookMessageId: 'wamid.amount-reject.2' }),
        recreated,
      );
      await pool.query(
        `UPDATE conversation_state SET data = jsonb_set(data,
             '{receiptAmountPointer,receiptVersion}', '"5"'::jsonb)
             WHERE sender_id = $1`,
        [SENDER],
      );
      await expectFenced(first, recreated);
      expect((await snapshot()).outbox).toHaveLength(1);
    });

    it('fences a replay whose reask intent args are not exactly an object', async () => {
      await seed();
      const input = command();
      const outcome = await reject(store, input);
      if (outcome.kind === 'fenced') throw new Error('expected rejection');
      await pool.query(
        "UPDATE receipt_media_outbox SET template_args = '[]'::jsonb WHERE id = $1",
        [outcome.intent.id],
      );
      await expectFenced(input);
    });

    it('serializes concurrent duplicate rejection to one mutation and one replay', async () => {
      await seed();
      const [a, b] = await Promise.all([
        reject(store, command()),
        reject(store, command()),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['rejected', 'replayed']);
      expect((await snapshot()).outbox).toHaveLength(1);
    });

    it('serializes concurrent distinct-webhook rivals to one rejection and one fence', async () => {
      await seed();
      const [a, b] = await Promise.all([
        reject(store, command()),
        reject(
          store,
          command({ sourceWebhookMessageId: 'wamid.amount-reject.2' }),
        ),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['fenced', 'rejected']);
      const durable = await snapshot();
      expect(durable.receipt).toMatchObject({
        status: 'AWAITING_AMOUNT',
        declared_amount_cents: null,
        amount_proposed_at: null,
        version: '4',
      });
      expect(durable.conversation).toEqual({
        sibling: { keep: true },
        receiptAmountPointer: { ...POINTER, receiptVersion: '4' },
      });
      expect(durable.outbox).toHaveLength(1);
    });

    it('fences successor overflow', async () => {
      const max = '9223372036854775807';
      await seed(
        {
          sibling: { keep: true },
          receiptAmountPointer: { ...POINTER, receiptVersion: max },
        },
        { version: max },
      );
      await expect(
        reject(
          store,
          command({
            expectedReceiptVersion: max,
            expectedPointer: { ...POINTER, receiptVersion: max },
          }),
        ),
      ).resolves.toEqual({ kind: 'fenced' });
    });
  });
  describe('WU10C2B atomic cancellation with durable command provenance', () => {
    type CancellationInput = ReceiptCancellationInput;
    type CancellationOutcome = ReceiptCancellationOutcome;
    type CancellationStore = {
      cancelReceipt(input: CancellationInput): Promise<CancellationOutcome>;
    };
    const CANCELLATION_TABLE = 'receipt_media_cancellation_commands';
    const UUID_D = '33333333-3333-4333-8333-333333333333';
    const SENDER = 'sender.amount-cancel';
    const POINTER = {
      receiptMediaId: UUID_A,
      saleId: UUID_B,
      receiptVersion: '2',
    };
    const COMMAND_COLUMNS = `receipt_media_id uuid NO source_webhook_message_id text NO
      sender_id text NO captured_sale_id uuid NO expected_receipt_status text NO
      expected_receipt_version bigint NO expected_pointer_receipt_media_id uuid NO
      expected_pointer_sale_id uuid NO expected_pointer_receipt_version bigint NO
      successor_receipt_version bigint NO cancellation_outbox_id uuid NO created_at timestamptz NO`;
    const cancel = (target: CancellationStore, input: CancellationInput) =>
      Promise.resolve().then(() => target.cancelReceipt(input));
    const cancellationStore: CancellationStore = {
      cancelReceipt: (input) => store.cancelReceipt(input),
    };
    const command = (
      over: Partial<CancellationInput> = {},
    ): CancellationInput => ({
      sourceWebhookMessageId: 'wamid.amount-cancel.1',
      senderId: SENDER,
      receiptMediaId: UUID_A,
      capturedSaleId: UUID_B,
      expectedReceiptStatus: 'AWAITING_AMOUNT',
      expectedReceiptVersion: '2',
      expectedPointer: POINTER,
      ...over,
    });
    const commandRow = (over: Row = {}): Row => ({
      receipt_media_id: UUID_A,
      source_webhook_message_id: 'wamid.amount-cancel.1',
      sender_id: SENDER,
      captured_sale_id: UUID_B,
      expected_receipt_status: 'AWAITING_AMOUNT',
      expected_receipt_version: '2',
      expected_pointer_receipt_media_id: UUID_A,
      expected_pointer_sale_id: UUID_B,
      expected_pointer_receipt_version: '2',
      successor_receipt_version: '3',
      cancellation_outbox_id: UUID_C,
      ...over,
    });
    const hasCancellationTable = async (): Promise<boolean> =>
      (
        await pool.query<{ table: string | null }>(
          'SELECT to_regclass($1) AS table',
          [CANCELLATION_TABLE],
        )
      ).rows[0].table === CANCELLATION_TABLE;
    const reset = async (): Promise<void> => {
      if (await hasCancellationTable())
        await pool.query(
          'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
        );
      else await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
      await pool.query('DELETE FROM conversation_state WHERE sender_id = $1', [
        SENDER,
      ]);
    };
    const seed = async (
      status: CancellationInput['expectedReceiptStatus'] = 'AWAITING_AMOUNT',
      data: unknown = {
        sibling: { keep: true },
        receiptAmountPointer: POINTER,
      },
      receiptOver: Row = {},
    ): Promise<void> => {
      await reset();
      const receipt = lifeRow(status, null, {
        sender_id: SENDER,
        captured_sale_id: UUID_B,
        version: '2',
        ...(status === 'AWAITING_CONFIRMATION'
          ? { amount_proposed_at: T0 }
          : {}),
        ...receiptOver,
      });
      await pool.query(
        insertSql('receipt_media', receipt),
        Object.values(receipt),
      );
      await pool.query(
        `INSERT INTO conversation_state (sender_id, last_message_at, data)
             VALUES ($1, now(), $2::jsonb)`,
        [SENDER, JSON.stringify(data)],
      );
    };
    const snapshot = async (id = UUID_A) => {
      const commandRows = (await hasCancellationTable())
        ? await pool.query<Row>(
            'SELECT * FROM receipt_media_cancellation_commands WHERE receipt_media_id = $1',
            [id],
          )
        : { rows: [] as Row[] };
      const [receipt, conversation, outbox] = await Promise.all([
        pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [id]),
        pool.query<Row>(
          'SELECT data FROM conversation_state WHERE sender_id = $1',
          [SENDER],
        ),
        pool.query<Row>('SELECT * FROM receipt_media_outbox'),
      ]);
      return {
        receipt: receipt.rows[0],
        conversation: conversation.rows[0]?.data as Row | undefined,
        outbox: outbox.rows,
        command: commandRows.rows,
      };
    };
    const expectFenced = async (
      input: CancellationInput,
      target: CancellationStore = cancellationStore,
    ) => {
      const before = await snapshot(input.receiptMediaId);
      await expect(cancel(target, input)).resolves.toEqual({ kind: 'fenced' });
      expect(await snapshot(input.receiptMediaId)).toEqual(before);
    };
    it('enforces command identity checks, linked intent FK, and sender/webhook uniqueness', async () => {
      expect(await actualColumns(CANCELLATION_TABLE)).toEqual(
        expectedColumns(COMMAND_COLUMNS),
      );
      await reset();
      const terminal = async (id: string, sale: string, outboxId: string) => {
        const receipt = lifeRow('CANCELLED', null, {
          id,
          webhook_message_id: `wamid.cancel.${id}`,
          provider_media_id: `media.cancel.${id}`,
          captured_sale_id: sale,
          object_key: `receipts/${id}`,
          terminal_at: T0,
          capability_token_hash: Buffer.alloc(32, id === UUID_A ? 3 : 4),
          version: '3',
        });
        await pool.query(
          insertSql('receipt_media', receipt),
          Object.values(receipt),
        );
        const intent = outboxRow({
          id: outboxId,
          dedupe_key: `cancel.${id}`,
          receipt_media_id: id,
          receipt_state_version: '3',
          source_webhook_message_id: 'wamid.amount-cancel.1',
          recipient_id: SENDER,
          template_key: 'RECEIPT_CANCELLED',
          template_args: {},
        });
        await pool.query(
          insertSql('receipt_media_outbox', intent),
          Object.values(intent),
        );
      };
      await terminal(UUID_A, UUID_B, UUID_C);
      const badPointer = commandRow({ expected_pointer_sale_id: UUID_C });
      await expect(
        pool.query(
          insertSql(CANCELLATION_TABLE, badPointer),
          Object.values(badPointer),
        ),
      ).rejects.toThrow();
      await pool.query(
        insertSql(CANCELLATION_TABLE, commandRow()),
        Object.values(commandRow()),
      );
      await expect(
        pool.query('DELETE FROM receipt_media_outbox WHERE id = $1', [UUID_C]),
      ).rejects.toThrow();
      await terminal(UUID_D, UUID_C, UUID_B);
      const duplicate = commandRow({
        receipt_media_id: UUID_D,
        captured_sale_id: UUID_C,
        expected_pointer_receipt_media_id: UUID_D,
        expected_pointer_sale_id: UUID_C,
        cancellation_outbox_id: UUID_B,
      });
      await expect(
        pool.query(
          insertSql(CANCELLATION_TABLE, duplicate),
          Object.values(duplicate),
        ),
      ).rejects.toThrow();
      await expect(
        pool.query(
          insertSql(CANCELLATION_TABLE, {
            ...duplicate,
            sender_id: 'sender.other',
          }),
          Object.values({ ...duplicate, sender_id: 'sender.other' }),
        ),
      ).resolves.toBeDefined();
      expect(tryMigrateDown()).toMatch(/refus/i);
    });
    it.each(['AWAITING_AMOUNT', 'AWAITING_CONFIRMATION'] as const)(
      'cancels %s atomically while preserving evidence and siblings',
      async (status) => {
        await seed(status);
        const before = await snapshot();
        const outcome = await cancel(
          cancellationStore,
          command({
            expectedReceiptStatus: status,
          }),
        );
        expect(outcome).toMatchObject({
          kind: 'cancelled',
          receipt: { id: UUID_A, status: 'CANCELLED', version: '3' },
          intent: {
            receiptMediaId: UUID_A,
            receiptStateVersion: '3',
            sourceWebhookMessageId: 'wamid.amount-cancel.1',
            recipientId: SENDER,
            templateKey: 'RECEIPT_CANCELLED',
            templateArgs: {},
          },
        });
        if (outcome.kind === 'fenced') throw new Error('expected cancellation');
        expect(outcome.receipt.terminalAt).toBeInstanceOf(Date);
        const after = await snapshot();
        expect(after.receipt).toMatchObject({
          status: 'CANCELLED',
          version: '3',
          declared_amount_cents:
            status === 'AWAITING_AMOUNT'
              ? null
              : before.receipt.declared_amount_cents,
          amount_proposed_at:
            status === 'AWAITING_AMOUNT'
              ? null
              : before.receipt.amount_proposed_at,
        });
        expect(after.receipt.terminal_at).toBeInstanceOf(Date);
        const evidence = Object.fromEntries(
          Object.entries(before.receipt).filter(
            ([key]) =>
              !['status', 'version', 'updated_at', 'terminal_at'].includes(key),
          ),
        );
        expect(after.receipt).toMatchObject(evidence);
        expect(after.conversation).toEqual({ sibling: { keep: true } });
        expect(after.outbox).toHaveLength(1);
        expect(after.command).toEqual([
          expect.objectContaining({
            receipt_media_id: UUID_A,
            source_webhook_message_id: 'wamid.amount-cancel.1',
            sender_id: SENDER,
            captured_sale_id: UUID_B,
            expected_receipt_status: status,
            expected_receipt_version: '2',
            expected_pointer_receipt_media_id: UUID_A,
            expected_pointer_sale_id: UUID_B,
            expected_pointer_receipt_version: '2',
            successor_receipt_version: '3',
            cancellation_outbox_id: after.outbox[0].id,
          }),
        ]);
      },
    );
    it.each<[string, Partial<CancellationInput>]>([
      ['same webhook with wrong sender', { senderId: 'sender.other' }],
      ['same webhook with wrong receipt', { receiptMediaId: UUID_C }],
      ['same webhook with wrong sale', { capturedSaleId: UUID_C }],
      [
        'same webhook with wrong source status',
        { expectedReceiptStatus: 'AWAITING_CONFIRMATION' },
      ],
      [
        'same webhook with wrong source version',
        { expectedReceiptVersion: '1' },
      ],
      [
        'same webhook with wrong pointer',
        { expectedPointer: { ...POINTER, saleId: UUID_C } },
      ],
    ])(
      'fences a %s instead of replaying altered command identity',
      async (_label, over) => {
        await seed();
        const input = command();
        await cancel(cancellationStore, input);
        await expectFenced(command(over));
      },
    );
    it.each<[string, unknown]>([
      ['absent pointer before cancellation', { sibling: true }],
      ['null pointer before cancellation', { receiptAmountPointer: null }],
      [
        'array pointer before cancellation',
        { receiptAmountPointer: [POINTER] },
      ],
      [
        'malformed pointer before cancellation',
        { receiptAmountPointer: { ...POINTER, extra: true } },
      ],
    ])('fences a %s without durable mutation', async (_label, data) => {
      await seed('AWAITING_AMOUNT', data);
      await expectFenced(command());
    });
    it.each<[string, string]>([
      ['null', 'null'],
      ['array', '[]'],
      ['malformed object', JSON.stringify({ ...POINTER, extra: true })],
      ['new pointer', JSON.stringify({ ...POINTER, receiptVersion: '4' })],
    ])(
      'replay requires an absent pointer, fencing a %s pointer',
      async (_label, raw) => {
        await seed();
        const input = command();
        await cancel(cancellationStore, input);
        await pool.query(
          `UPDATE conversation_state SET data = jsonb_set(data,
               '{receiptAmountPointer}', $2::jsonb, true) WHERE sender_id = $1`,
          [SENDER, raw],
        );
        await expectFenced(input);
      },
    );
    it('replays only exact durable provenance after adapter recreation and fences legacy or malformed evidence', async () => {
      await seed('AWAITING_CONFIRMATION');
      const input = command({ expectedReceiptStatus: 'AWAITING_CONFIRMATION' });
      expect((await cancel(cancellationStore, input)).kind).toBe('cancelled');
      const recreated = new PostgresReceiptMediaStore(
        pool,
      ) as unknown as CancellationStore;
      expect((await cancel(recreated, input)).kind).toBe('replayed');
      await pool.query(
        "UPDATE receipt_media_outbox SET template_args = '[]'::jsonb",
      );
      await expectFenced(input, recreated);
      await seed(
        'AWAITING_AMOUNT',
        { sibling: true },
        {
          status: 'CANCELLED',
          version: '3',
          terminal_at: T0,
        },
      );
      await expectFenced(input, recreated);
    });
    it('fences noncanonical identities and successor overflow before mutation', async () => {
      await seed();
      await expectFenced(
        command({
          receiptMediaId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          expectedPointer: {
            ...POINTER,
            receiptMediaId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
          },
        }),
      );
      const max = '9223372036854775807';
      await seed(
        'AWAITING_AMOUNT',
        {
          sibling: { keep: true },
          receiptAmountPointer: { ...POINTER, receiptVersion: max },
        },
        { version: max },
      );
      await expectFenced(
        command({
          expectedReceiptVersion: max,
          expectedPointer: { ...POINTER, receiptVersion: max },
        }),
      );
    });
    it.each<[string, string, string, 'fenced' | 'throws']>([
      [
        'pointer update',
        'conversation_state',
        'BEGIN RETURN NULL; END;',
        'fenced',
      ],
      [
        'outbox insert',
        'receipt_media_outbox',
        "BEGIN RAISE EXCEPTION 'cancel outbox failure'; END;",
        'throws',
      ],
      [
        'command insert',
        CANCELLATION_TABLE,
        "BEGIN RAISE EXCEPTION 'cancel command failure'; END;",
        'throws',
      ],
      [
        'command suppression',
        CANCELLATION_TABLE,
        'BEGIN RETURN NULL; END;',
        'fenced',
      ],
    ])(
      'rolls back receipt, pointer, outbox, and command when %s fails',
      async (_label, table, body, expectation) => {
        await seed();
        const before = await snapshot();
        const trigger = `receipt_cancel_${table.replaceAll('_', '')}_failure`;
        await pool.query(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ ${body} $$`,
        );
        await pool.query(
          `CREATE TRIGGER ${trigger} BEFORE UPDATE OR INSERT ON ${table}
             FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        );
        try {
          if (expectation === 'fenced')
            await expect(cancel(cancellationStore, command())).resolves.toEqual(
              {
                kind: 'fenced',
              },
            );
          else
            await expect(
              cancel(cancellationStore, command()),
            ).rejects.toThrow();
          expect(await snapshot()).toEqual(before);
        } finally {
          await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
          await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
        }
      },
    );
    it('serializes duplicate and distinct cancellation webhooks', async () => {
      await seed();
      const [a, b] = await Promise.all([
        cancel(cancellationStore, command()),
        cancel(cancellationStore, command()),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(['cancelled', 'replayed']);
      await seed();
      const [first, rival] = await Promise.all([
        cancel(cancellationStore, command()),
        cancel(
          cancellationStore,
          command({ sourceWebhookMessageId: 'wamid.amount-cancel.2' }),
        ),
      ]);
      expect([first.kind, rival.kind].sort()).toEqual(['cancelled', 'fenced']);
    });
    // prettier-ignore
    it('allows concurrent same-webhook cancellation records for different senders', async () => {
          await seed();
          const sender = 'sender.amount-cancel.other';
          const other = lifeRow('AWAITING_AMOUNT', null, {
            id: UUID_D,
            webhook_message_id: 'wamid.cancel.other',
            provider_media_id: 'media.cancel.other',
            sender_id: sender,
            captured_sale_id: UUID_C,
            object_key: `receipts/${UUID_D}`,
            capability_token_hash: Buffer.alloc(32, 6),
            version: '2',
          });
          await pool.query(insertSql('receipt_media', other), Object.values(other));
          await pool.query(
            'INSERT INTO conversation_state (sender_id, last_message_at, data) VALUES ($1, now(), $2::jsonb)',
            [
              sender,
              JSON.stringify({
                receiptAmountPointer: {
                  receiptMediaId: UUID_D,
                  saleId: UUID_C,
                  receiptVersion: '2',
                },
              }),
            ],
          );
          const otherCommand = command({
            senderId: sender,
            receiptMediaId: UUID_D,
            capturedSaleId: UUID_C,
            expectedPointer: {
              receiptMediaId: UUID_D,
              saleId: UUID_C,
              receiptVersion: '2',
            },
          });
          const outcomes = await Promise.all([
            cancel(cancellationStore, command()),
            cancel(cancellationStore, otherCommand),
          ]);
          expect(outcomes.map((outcome) => outcome.kind)).toEqual([
            'cancelled',
            'cancelled',
          ]);
          const { rows } = await pool.query<Row>(
            `SELECT r.id receipt_id, r.sender_id receipt_sender_id, r.status receipt_status, r.version receipt_version, r.terminal_at receipt_terminal_at, c.sender_id command_sender_id, c.source_webhook_message_id, c.captured_sale_id, c.expected_receipt_status, c.expected_receipt_version, c.expected_pointer_receipt_media_id, c.expected_pointer_sale_id, c.expected_pointer_receipt_version, c.successor_receipt_version, c.cancellation_outbox_id, o.id outbox_id, o.receipt_media_id outbox_receipt_media_id, o.source_webhook_message_id outbox_source_webhook_message_id, o.recipient_id outbox_recipient_id, o.receipt_state_version outbox_receipt_state_version, o.template_key outbox_template_key, o.template_args outbox_template_args FROM receipt_media r JOIN receipt_media_cancellation_commands c ON c.receipt_media_id = r.id JOIN receipt_media_outbox o ON o.id = c.cancellation_outbox_id WHERE r.id IN ($1, $2)`,
            [UUID_A, UUID_D],
          );
          const expected = {
            [UUID_A]: { id: UUID_A, sender: SENDER, sale: UUID_B },
            [UUID_D]: { id: UUID_D, sender, sale: UUID_C },
          };
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            const outcome = expected[row.receipt_id as keyof typeof expected];
            if (!outcome) throw new Error('unexpected cancellation receipt');
            expect(row).toMatchObject({ receipt_id: outcome.id, receipt_sender_id: outcome.sender, receipt_status: 'CANCELLED', receipt_version: '3', command_sender_id: outcome.sender, source_webhook_message_id: 'wamid.amount-cancel.1', captured_sale_id: outcome.sale, expected_receipt_status: 'AWAITING_AMOUNT', expected_receipt_version: '2', expected_pointer_receipt_media_id: row.receipt_id, expected_pointer_sale_id: outcome.sale, expected_pointer_receipt_version: '2', successor_receipt_version: '3', outbox_receipt_media_id: row.receipt_id, outbox_source_webhook_message_id: 'wamid.amount-cancel.1', outbox_recipient_id: outcome.sender, outbox_receipt_state_version: '3', outbox_template_key: 'RECEIPT_CANCELLED' });
            expect(row.receipt_terminal_at).toBeInstanceOf(Date);
            expect(row.cancellation_outbox_id).toBe(row.outbox_id);
            expect(row.outbox_template_args).toEqual({});
          }
          const conversations = Object.fromEntries(
            (
              await pool.query<Row>(
                'SELECT sender_id, data FROM conversation_state WHERE sender_id IN ($1, $2)',
                [SENDER, sender],
              )
            ).rows.map((row) => [row.sender_id as string, row.data]),
          );
          expect(conversations).toEqual({
            [SENDER]: { sibling: { keep: true } },
            [sender]: {},
          });
        });
    it('fences a sequential cross-receipt same-sender webhook', async () => {
      await seed();
      expect((await cancel(cancellationStore, command())).kind).toBe(
        'cancelled',
      );
      const alternate = lifeRow('AWAITING_AMOUNT', null, {
        id: UUID_D,
        webhook_message_id: 'wamid.cancel.alternate',
        provider_media_id: 'media.cancel.alternate',
        sender_id: SENDER,
        captured_sale_id: UUID_C,
        object_key: `receipts/${UUID_D}`,
        capability_token_hash: Buffer.alloc(32, 5),
        version: '2',
      });
      await pool.query(
        insertSql('receipt_media', alternate),
        Object.values(alternate),
      );
      await pool.query(
        `UPDATE conversation_state SET data = jsonb_set(data, '{receiptAmountPointer}',
             $2::jsonb, true) WHERE sender_id = $1`,
        [
          SENDER,
          JSON.stringify({
            receiptMediaId: UUID_D,
            saleId: UUID_C,
            receiptVersion: '2',
          }),
        ],
      );
      await expectFenced(
        command({
          receiptMediaId: UUID_D,
          capturedSaleId: UUID_C,
          expectedPointer: {
            receiptMediaId: UUID_D,
            saleId: UUID_C,
            receiptVersion: '2',
          },
        }),
      );
    });
    type RaceKind = 'amount proposal' | 'amount rejection';
    type RaceWinner = 'cancellation' | 'competing';
    type RaceOutcome =
      | AmountProposalOutcome
      | AmountRejectionOutcome
      | ReceiptCancellationOutcome;
    type WinnerGate = readonly [string, number, string];
    const RACE_STATEMENT_TIMEOUT_MS = 1_000;
    const RACE_OPERATION_TIMEOUT_MS = 1_500;
    const RACE_SETTLEMENT_TIMEOUT_MS = 10_000;
    const withDeadline = async <T>(
      label: string,
      operation: Promise<T>,
      timeout = RACE_OPERATION_TIMEOUT_MS,
    ): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<T>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out ${label}`)),
              timeout,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const queryBounded = <T extends QueryResultRow>(
      client: PoolClient,
      label: string,
      text: string,
      values?: unknown[],
    ) => withDeadline(label, client.query<T>(text, values));
    const GATES = {
      proposal: ['proposal', 710_001, 'AWAITING_CONFIRMATION'],
      cancelAmount: ['cancel_amount', 710_002, 'CANCELLED'],
      rejection: ['rejection', 710_003, 'AWAITING_AMOUNT'],
      cancelConfirmation: ['cancel_confirmation', 710_004, 'CANCELLED'],
    } as const;
    const asError = (error: unknown): Error =>
      error instanceof Error ? error : new Error(String(error));
    const acquireRaceClient = async (label: string): Promise<PoolClient> => {
      const acquisition = pool.connect();
      let client: PoolClient | undefined;
      try {
        client = await withDeadline(`${label} client acquisition`, acquisition);
        await queryBounded(
          client,
          `${label} statement timeout setup`,
          `SET statement_timeout = '${RACE_STATEMENT_TIMEOUT_MS}ms'`,
        );
        return client;
      } catch (error) {
        const failure = asError(error);
        if (client) {
          client.release(failure);
        } else {
          void acquisition
            .then((late) => late.release(failure))
            .catch(() => {});
        }
        throw error;
      }
    };
    const releaseRaceClient = async (client?: PoolClient, failure?: Error) => {
      if (!client) return;
      if (failure) return client.release(failure);
      try {
        await queryBounded(client, 'reset', "SET statement_timeout='8s'");
        client.release();
      } catch (error) {
        client.release(asError(error));
        throw error;
      }
    };
    const withRaceClient = async <T>(
      label: string,
      operation: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      let client: PoolClient | undefined;
      let failure: Error | undefined;
      try {
        client = await acquireRaceClient(label);
        return await operation(client);
      } catch (error) {
        failure = asError(error);
        throw error;
      } finally {
        await releaseRaceClient(client, failure);
      }
    };
    const gateName = (name: string) => `receipt_media_wu10c2b_${name}_gate`;
    const installWinnerGate = async (gate: WinnerGate) => {
      const [name, key, status] = gate;
      const functionName = gateName(name);
      await withRaceClient('winner gate installation', async (client) => {
        await queryBounded(
          client,
          'winner gate function installation',
          `CREATE FUNCTION ${functionName}()
            RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              IF NEW.status = '${status}' THEN
                PERFORM pg_advisory_xact_lock(${key});
              END IF;
              RETURN NEW;
            END; $$`,
        );
        await queryBounded(
          client,
          'winner gate trigger installation',
          `CREATE TRIGGER ${functionName}
            BEFORE UPDATE ON receipt_media FOR EACH ROW
            EXECUTE FUNCTION ${functionName}()`,
        );
      });
    };
    const removeWinnerTrigger = ([name]: WinnerGate) =>
      withRaceClient('winner gate trigger removal', (client) =>
        queryBounded(
          client,
          'winner gate trigger removal query',
          `DROP TRIGGER IF EXISTS ${gateName(name)} ON receipt_media`,
        ),
      );
    const removeWinnerFunction = ([name]: WinnerGate) =>
      withRaceClient('winner gate function removal', (client) =>
        queryBounded(
          client,
          'winner gate function removal query',
          `DROP FUNCTION IF EXISTS ${gateName(name)}()`,
        ),
      );
    const waitForWinnerGate = async (
      observer: PoolClient,
      key: number,
    ): Promise<void> => {
      const deadline = Date.now() + RACE_SETTLEMENT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const { rows } = await queryBounded<{ waiting: boolean }>(
          observer,
          'winner gate observation',
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
                AND database = (SELECT oid FROM pg_database
                                  WHERE datname = current_database())
                AND classid = 0 AND objid = $1::oid AND objsubid = 1
           ) AS waiting`,
          [key],
        );
        if (rows[0].waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for advisory gate ${key}`);
    };
    // prettier-ignore
    it.each<[
              string,
          CancellationInput['expectedReceiptStatus'],
          RaceKind,
          RaceWinner,
          WinnerGate,
        ]>([
          [
            'proposal wins',
            'AWAITING_AMOUNT',
            'amount proposal',
            'competing',
            GATES.proposal,
          ],
          [
            'cancel wins versus proposal',
            'AWAITING_AMOUNT',
            'amount proposal',
            'cancellation',
            GATES.cancelAmount,
          ],
          [
            'rejection wins',
            'AWAITING_CONFIRMATION',
            'amount rejection',
            'competing',
            GATES.rejection,
          ],
          [
            'cancel wins versus rejection',
            'AWAITING_CONFIRMATION',
            'amount rejection',
            'cancellation',
            GATES.cancelConfirmation,
          ],
        ])(
          '%s through a trigger-gated receipt update',
          async (_label, status, kind, intendedWinner, gate) => {
            await seed(status);
            let control: PoolClient | undefined;
            let controlFailure: Error | undefined;
            let observer: PoolClient | undefined;
            let observerFailure: Error | undefined;
            let locked = false;
            let winner: Promise<RaceOutcome> | undefined;
            let loser: Promise<RaceOutcome> | undefined;
            const unlockControl = async (): Promise<void> => {
              if (!control || !locked) return;
              try {
                await queryBounded(
                  control,
                  'winner gate unlock',
                  'SELECT pg_advisory_unlock($1)',
                  [gate[1]],
                );
                locked = false;
              } catch (error) {
                controlFailure = asError(error);
                control.release(controlFailure);
                control = undefined;
                locked = false;
                throw error;
              }
            };
            const releaseControl = async (failure?: Error) => {
              const client = control;
              control = undefined;
              await releaseRaceClient(client, failure);
            };
            let primaryFailure: unknown;
            let hasPrimaryFailure = false;
            try {
              await installWinnerGate(gate);
              control = await acquireRaceClient('winner gate control');
              observer = await acquireRaceClient('winner gate observer');
              try {
                await queryBounded(
                  control,
                  'winner gate lock',
                  'SELECT pg_advisory_lock($1)',
                  [gate[1]],
                );
                locked = true;
              } catch (error) {
                controlFailure = asError(error);
                throw error;
              }
              const startCompeting = (): Promise<RaceOutcome> =>
                kind === 'amount proposal'
                  ? store.proposeAmount({
                      sourceWebhookMessageId: 'wamid.amount.propose.race',
                      senderId: SENDER,
                      receiptMediaId: UUID_A,
                      capturedSaleId: UUID_B,
                      expectedReceiptStatus: 'AWAITING_AMOUNT',
                      expectedReceiptVersion: '2',
                      expectedPointer: POINTER,
                      cents: 1250,
                    })
                  : store.rejectProposedAmount({
                      sourceWebhookMessageId: 'wamid.amount.reject.race',
                      senderId: SENDER,
                      receiptMediaId: UUID_A,
                      capturedSaleId: UUID_B,
                      expectedReceiptStatus: 'AWAITING_CONFIRMATION',
                      expectedReceiptVersion: '2',
                      expectedPointer: POINTER,
                    });
              const cancellation = (): Promise<RaceOutcome> =>
                cancel(
                  cancellationStore,
                  command({ expectedReceiptStatus: status }),
                );
              winner =
                intendedWinner === 'cancellation'
                  ? cancellation()
                  : startCompeting();
              try {
                await waitForWinnerGate(observer, gate[1]);
              } catch (error) {
                observerFailure = asError(error);
                throw error;
              }
              loser =
                intendedWinner === 'cancellation'
                  ? startCompeting()
                  : cancellation();
              await unlockControl();
              await releaseControl();
                  if (winner === undefined || loser === undefined) throw new Error('race did not start');
              const settled = await withDeadline(
                'winner/loser settlement',
                Promise.allSettled([winner, loser]),
                RACE_SETTLEMENT_TIMEOUT_MS,
              );
              const [winnerResult, loserResult] = settled;
              if (winnerResult.status === 'rejected') throw winnerResult.reason;
              if (loserResult.status === 'rejected') throw loserResult.reason;
              const winnerOutcome = winnerResult.value;
              const loserOutcome = loserResult.value;
              expect(winnerOutcome.kind).toBe(
                intendedWinner === 'cancellation'
                  ? 'cancelled'
                  : kind === 'amount proposal'
                    ? 'proposed'
                    : 'rejected',
              );
              expect(loserOutcome).toEqual({ kind: 'fenced' });
              const [cancelled, competing] =
                intendedWinner === 'cancellation'
                  ? [winnerOutcome, loserOutcome]
                  : [loserOutcome, winnerOutcome];
              const durable = await snapshot();
              expect(durable.outbox).toHaveLength(1);
              expect(durable.receipt).toMatchObject({
                id: UUID_A,
                sender_id: SENDER,
                captured_sale_id: UUID_B,
                ...downloadEvidence,
                ...acceptedEvidence,
                version: '3',
              });
              const [outbox] = durable.outbox;
              if (cancelled.kind === 'cancelled') {
                expect(competing).toEqual({ kind: 'fenced' });
                expect(durable.receipt).toMatchObject({
                  status: 'CANCELLED',
                  declared_amount_cents:
                    status === 'AWAITING_AMOUNT' ? null : 1250,
                });
                expect(durable.receipt.terminal_at).toBeInstanceOf(Date);
                if (status === 'AWAITING_AMOUNT') {
                  expect(durable.receipt.amount_proposed_at).toBeNull();
                } else {
                  expect(durable.receipt.amount_proposed_at).toEqual(T0);
                }
                expect(durable.conversation).toEqual({ sibling: { keep: true } });
                expect(outbox).toMatchObject({
                  receipt_media_id: UUID_A,
                  receipt_state_version: '3',
                  source_webhook_message_id: 'wamid.amount-cancel.1',
                  recipient_id: SENDER,
                  template_key: 'RECEIPT_CANCELLED',
                  dedupe_key: `receipt-cancel:${UUID_A}:2:wamid.amount-cancel.1`,
                });
                expect(outbox.id).toBe(cancelled.intent.id);
                expect(outbox.template_args).toEqual({});
                expect(durable.command).toHaveLength(1);
                const [provenance] = durable.command;
                expect(provenance).toMatchObject({
                  receipt_media_id: UUID_A,
                  sender_id: SENDER,
                  source_webhook_message_id: 'wamid.amount-cancel.1',
                  captured_sale_id: UUID_B,
                  expected_receipt_status: status,
                  expected_receipt_version: '2',
                  expected_pointer_receipt_media_id: UUID_A,
                  expected_pointer_sale_id: UUID_B,
                  expected_pointer_receipt_version: '2',
                  successor_receipt_version: '3',
                });
                expect(provenance.cancellation_outbox_id).toBe(outbox.id);
              } else {
                expect(cancelled).toEqual({ kind: 'fenced' });
                expect(competing.kind).toBe(
                  kind === 'amount proposal' ? 'proposed' : 'rejected',
                );
                expect(durable.receipt).toMatchObject(
                  kind === 'amount proposal'
                    ? {
                    status: 'AWAITING_CONFIRMATION',
                    declared_amount_cents: 1250,
                    terminal_at: null,
                      }
                    : {
                    status: 'AWAITING_AMOUNT',
                    declared_amount_cents: null,
                    amount_proposed_at: null,
                    terminal_at: null,
                      },
                );
                if (kind === 'amount proposal') expect(durable.receipt.amount_proposed_at).toBeInstanceOf(Date);
                expect(durable.conversation).toEqual({
                  sibling: { keep: true },
                  receiptAmountPointer: { ...POINTER, receiptVersion: '3' },
                });
                expect(outbox).toMatchObject({
                  receipt_media_id: UUID_A,
                  receipt_state_version: '3',
                  source_webhook_message_id:
                    kind === 'amount proposal'
                      ? 'wamid.amount.propose.race'
                      : 'wamid.amount.reject.race',
                  recipient_id: SENDER,
                  template_key:
                    kind === 'amount proposal'
                      ? 'RECEIPT_AMOUNT_CONFIRM'
                      : 'RECEIPT_AMOUNT_REASK',
                  dedupe_key:
                    kind === 'amount proposal'
                      ? `receipt-amount-confirm:${UUID_A}:2:wamid.amount.propose.race`
                      : `receipt-amount-reask:${UUID_A}:2:wamid.amount.reject.race`,
                });
                    if (
                      competing.kind !== 'proposed' &&
                      competing.kind !== 'rejected'
                    ) {
                      throw new Error('competing race operation did not win');
                    }
                    expect(outbox.id).toBe(competing.intent.id);
                    expect(outbox.template_args).toEqual(
                  kind === 'amount proposal' ? { cents: 1250 } : {},
                );
                expect(durable.command).toEqual([]);
              }
            } catch (error) {
              hasPrimaryFailure = true;
              primaryFailure = error;
            }
            const cleanupErrors: Error[] = [];
                const clean = async (
                  label: string,
                  operation: () => unknown,
                ) => {
              try {
                await operation();
              } catch (error) {
                cleanupErrors.push(new Error(`${label}: ${asError(error).message}`));
              }
            };
            await clean('unlock/control release', async () => {
              await unlockControl();
              await releaseControl(controlFailure);
            });
            await clean('winner/loser settlement', async () => {
              const operations = [winner, loser].filter(
                (promise): promise is Promise<RaceOutcome> => promise !== undefined,
              );
              await withDeadline(
                'cleanup winner/loser settlement',
                Promise.allSettled(operations),
                RACE_SETTLEMENT_TIMEOUT_MS,
              );
            });
            await clean('winner gate trigger removal', () =>
              removeWinnerTrigger(gate),
            );
            await clean('winner gate function removal', () =>
              removeWinnerFunction(gate),
            );
            await clean('observer release', async () => {
              const client = observer;
              observer = undefined;
              await releaseRaceClient(client, observerFailure);
            });
            if (hasPrimaryFailure) throw primaryFailure;
            if (cleanupErrors.length > 0) {
              throw new AggregateError(cleanupErrors, 'race cleanup failed');
            }
          },
          );
    afterAll(reset);
  });

  // --- WU10C3A atomic attachment start (confirmation → attaching) ---

  describe('WU10C3A atomic attachment start', () => {
    const start = (input: AttachStartInput): Promise<AttachStartOutcome> =>
      store.startAttachment(input);
    const SENDER = 'sender.attach-start';
    const POINTER = {
      receiptMediaId: UUID_A,
      saleId: UUID_B,
      receiptVersion: '3',
    };
    const command = (
      over: Partial<AttachStartInput> = {},
    ): AttachStartInput => ({
      sourceWebhookMessageId: 'wamid.attach-start.1',
      senderId: SENDER,
      receiptMediaId: UUID_A,
      capturedSaleId: UUID_B,
      expectedReceiptStatus: 'AWAITING_CONFIRMATION' as const,
      expectedReceiptVersion: '3',
      expectedPointer: POINTER,
      ...over,
    });
    const seed = async (
      data: unknown = {
        sibling: { keep: true },
        receiptAmountPointer: POINTER,
      },
      receiptOver: Row = {},
    ) => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
      await pool.query('DELETE FROM conversation_state WHERE sender_id = $1', [
        SENDER,
      ]);
      const receipt = lifeRow('AWAITING_CONFIRMATION', null, {
        sender_id: SENDER,
        captured_sale_id: UUID_B,
        version: '3',
        amount_proposed_at: T0,
        ...receiptOver,
      });
      await pool.query(
        insertSql('receipt_media', receipt),
        Object.values(receipt),
      );
      await pool.query(
        `INSERT INTO conversation_state (sender_id, last_message_at, data)
                 VALUES ($1, now(), $2::jsonb)`,
        [SENDER, JSON.stringify(data)],
      );
    };
    const snapshot = async () => {
      const [receipt, conversation, outbox] = await Promise.all([
        pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [UUID_A]),
        pool.query<Row>(
          'SELECT data FROM conversation_state WHERE sender_id = $1',
          [SENDER],
        ),
        pool.query<Row>('SELECT * FROM receipt_media_outbox'),
      ]);
      return {
        receipt: receipt.rows[0],
        conversation: conversation.rows[0]?.data as Row | undefined,
        outbox: outbox.rows,
      };
    };
    const expectFenced = async (input: AttachStartInput = command()) => {
      const before = await snapshot();
      await expect(start(input)).resolves.toEqual({ kind: 'fenced' });
      expect(await snapshot()).toEqual(before);
    };

    it('starts the attachment and clears the exact pointer', async () => {
      const LEASE_END = new Date(Date.now() + 60_000);
      await seed(undefined, {
        lease_owner: 'worker.attach-start',
        lease_expires_at: LEASE_END,
      });
      const outcome = await start(command());
      expect(outcome.kind).toBe('started');
      if (outcome.kind === 'fenced') throw new Error('expected start');
      // prettier-ignore
      expect(outcome.receipt).toMatchObject({ id: UUID_A, status: 'ATTACHING', declaredAmountCents: 1250, attachAttempts: 0, attachRequestStartedAt: null, attachAttemptId: null, version: '4' });
      // prettier-ignore
      expect(outcome.intent).toMatchObject({ receiptMediaId: UUID_A, receiptStateVersion: '4', sourceWebhookMessageId: 'wamid.attach-start.1', recipientId: SENDER, templateKey: 'RECEIPT_IN_PROGRESS', templateArgs: {} });
      const after = await snapshot();
      expect(after.conversation).toEqual({ sibling: { keep: true } });
      expect(after.outbox).toHaveLength(1);
      // prettier-ignore
      expect(after.receipt).toMatchObject({ declared_amount_cents: 1250, amount_proposed_at: T0, lease_owner: 'worker.attach-start', lease_expires_at: LEASE_END });
      expect(after.receipt.attach_started_at).toBeInstanceOf(Date);
    });

    // prettier-ignore
    it.each([
          ['wrong sender', undefined, { senderId: 'sender.other' }, {}],
          ['wrong receipt', undefined, { receiptMediaId: UUID_C, expectedPointer: { ...POINTER, receiptMediaId: UUID_C } }, {}],
          ['wrong sale', undefined, { capturedSaleId: UUID_C, expectedPointer: { ...POINTER, saleId: UUID_C } }, {}],
          ['wrong version', undefined, { expectedReceiptVersion: '2', expectedPointer: { ...POINTER, receiptVersion: '2' } }, {}],
          ['wrong stored status', undefined, {}, { status: 'STORED', declared_amount_cents: null, amount_proposed_at: null }],
          ['missing proposal timestamp', undefined, {}, { amount_proposed_at: null }],
          ['absent pointer', { sibling: true }, {}, {}],
          ['extra-key pointer', { receiptAmountPointer: { ...POINTER, extra: true } }, {}, {}],
          ['wrong-version pointer', { receiptAmountPointer: { ...POINTER, receiptVersion: '4' } }, {}, {}],
        ])('%s fences without durable mutation', async (_label, data, over, receiptOver) => {
          await seed(data, receiptOver);
          await expectFenced(command(over));
        });

    it('rolls back receipt and pointer when the intent insert fails', async () => {
      await seed();
      const before = await snapshot();
      await pool.query(`CREATE FUNCTION receipt_attach_start_outbox_failure()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'attach start outbox failure'; END; $$`);
      await pool.query(`CREATE TRIGGER receipt_attach_start_outbox_failure
            BEFORE INSERT ON receipt_media_outbox
            FOR EACH ROW EXECUTE FUNCTION receipt_attach_start_outbox_failure()`);
      try {
        await expect(start(command())).rejects.toThrow(
          'attach start outbox failure',
        );
        expect(await snapshot()).toEqual(before);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS
          receipt_attach_start_outbox_failure ON receipt_media_outbox;
          DROP FUNCTION IF EXISTS receipt_attach_start_outbox_failure()`);
      }
    });

    it('rolls back the receipt when the pointer update is suppressed', async () => {
      await seed();
      const before = await snapshot();
      await pool.query(`CREATE FUNCTION receipt_attach_start_pointer_fence()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RETURN NULL; END; $$`);
      await pool.query(`CREATE TRIGGER receipt_attach_start_pointer_fence
            BEFORE UPDATE ON conversation_state FOR EACH ROW
            EXECUTE FUNCTION receipt_attach_start_pointer_fence()`);
      try {
        await expect(start(command())).resolves.toEqual({ kind: 'fenced' });
        expect(await snapshot()).toEqual(before);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS
          receipt_attach_start_pointer_fence ON conversation_state;
          DROP FUNCTION IF EXISTS receipt_attach_start_pointer_fence()`);
      }
    });

    it('replays only the exact durable successor and fences every rival', async () => {
      await seed();
      const first = command();
      expect((await start(first)).kind).toBe('started');
      const replay = await new PostgresReceiptMediaStore(pool).startAttachment(
        first,
      );
      // prettier-ignore
      expect(replay).toMatchObject({ kind: 'replayed', receipt: { id: UUID_A, status: 'ATTACHING', version: '4', declaredAmountCents: 1250 }, intent: { templateKey: 'RECEIPT_IN_PROGRESS', templateArgs: {} } });
      await expectFenced(
        command({ sourceWebhookMessageId: 'wamid.attach-start.2' }),
      );
      await pool.query(
        "UPDATE conversation_state SET data = jsonb_set(data, '{receiptAmountPointer}', $1::jsonb, true) WHERE sender_id = $2",
        [JSON.stringify({ ...POINTER, receiptVersion: '4' }), SENDER],
      );
      await expectFenced(first);
      await pool.query(
        "UPDATE conversation_state SET data = data - 'receiptAmountPointer' WHERE sender_id = $1",
        [SENDER],
      );
      await pool.query(
        "UPDATE receipt_media_outbox SET template_args = '[]'::jsonb",
      );
      await expectFenced(first);
      await pool.query(
        "UPDATE receipt_media_outbox SET template_args = '{}'::jsonb",
      );
      await pool.query(
        "UPDATE receipt_media SET attach_attempts = 1, attach_request_started_at = now(), attach_attempt_id = '11111111-1111-4111-8111-111111111111'",
      );
      await expectFenced(first);
      expect((await snapshot()).outbox).toHaveLength(1);
    });

    it('serializes concurrent duplicate and rival starts', async () => {
      await seed();
      const [a, b] = await Promise.all([start(command()), start(command())]);
      expect([a.kind, b.kind].sort()).toEqual(['replayed', 'started']);
      expect((await snapshot()).outbox).toHaveLength(1);
      await seed();
      const [first, rival] = await Promise.all([
        start(command()),
        start(command({ sourceWebhookMessageId: 'wamid.attach-start.2' })),
      ]);
      expect([first.kind, rival.kind].sort()).toEqual(['fenced', 'started']);
      const durable = await snapshot();
      expect(durable.receipt).toMatchObject({
        status: 'ATTACHING',
        declared_amount_cents: 1250,
        version: '4',
      });
      expect(durable.conversation).toEqual({ sibling: { keep: true } });
      expect(durable.outbox).toHaveLength(1);
    });
  });
  it('rolls back and re-applies both empty tables (empty-table up/down)', async () => {
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
    );
    migrate('migrate:down');
    const { rows: cancellationTables } = await pool.query<{ t: string | null }>(
      "SELECT to_regclass('receipt_media_cancellation_commands') AS t",
    );
    expect(cancellationTables[0].t).toBeNull();
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
