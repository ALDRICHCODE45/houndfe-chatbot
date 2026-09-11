import { execSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { Pool } from 'pg';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import type {
  AmountProposalInput,
  AmountRejectionInput,
  AttemptStartResult,
  LeaseFenceInput,
  OutboxIntentInput,
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
    pool = new Pool({ connectionString: container.getConnectionUri() });
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
      return '';
    } catch (err) {
      return String((err as { stderr?: Buffer }).stderr ?? err);
    }
  };

  it.each([
    ['receipt_media', lifeRow('RESERVED', null, {})],
    ['receipt_media_outbox', outboxRow()],
  ])('down refuses when only %s is populated', async (table, row) => {
    await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
    await pool.query(insertSql(table, row), Object.values(row));
    expect(tryMigrateDown()).toMatch(/refus/i);
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
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
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
        await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
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
    });
  });

  // --- WU6B capability access lookup (RMA2, RMA3) ---

  describe('WU6B capability access lookup', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
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
        await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
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
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
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
      await pool.query('TRUNCATE receipt_media_outbox, receipt_media');
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
