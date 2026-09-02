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
