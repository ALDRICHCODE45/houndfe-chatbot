import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';

/** ODD-2E tests-only aggregate evidence: real `PostgresReceiptMediaStore` + real
 * migrations over one Testcontainers PostgreSQL 16 instance. Aggregate pass: the
 * five durable terminal families coexist with exactly five deterministic outbox
 * intents and replay after one adapter recreation with no extra state or intent;
 * handoff pass: the real storage terminal -> releaseLease -> claimCleanupBatch ->
 * commitCleanupDisposition with no new intent and no terminal/STORED row claimed
 * by the generic claim. Store-level only; gated by RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const UUID_SALE = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2025-01-01T00:00:00Z');
const LEASE_END = (): Date => new Date(Date.now() + 60_000);
type ReceiptKey = 'attached' | 'definite' | 'unknown' | 'meta' | 'storage';
/** Distinct receipt/webhook/provider/object/sender identities per family. */
const receipt = (label: string, n: number) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.agg.${label}`,
  mediaId: `media.agg.${label}`,
  sender: `sender.agg.${label}`,
  objectKey: `receipts/agg-${label}`,
});
type Receipt = ReturnType<typeof receipt>;
const RECEIPTS: Record<ReceiptKey | 'stored', Receipt> = {
  attached: receipt('attached', 1),
  definite: receipt('definite', 2),
  unknown: receipt('unknown', 3),
  meta: receipt('meta', 4),
  storage: receipt('storage', 5),
  stored: receipt('stored', 6),
};
const OWNERS: Record<ReceiptKey | 'cleanup', string> = {
  attached: 'worker.agg-attached',
  definite: 'worker.agg-definite',
  unknown: 'worker.agg-unknown',
  meta: 'worker.agg-meta',
  storage: 'worker.agg-storage',
  cleanup: 'worker.agg-cleanup',
};
const ATTACH_REQUEST: Record<'attached' | 'definite' | 'unknown', string> = {
  attached: 'bbbbbbbb-0001-4000-8000-000000000001',
  definite: 'bbbbbbbb-0002-4000-8000-000000000002',
  unknown: 'bbbbbbbb-0003-4000-8000-000000000003',
};
const BACKEND_RECEIPT_ID = 'cccccccc-0001-4000-8000-000000000001';
const DOWNLOAD_EVIDENCE: Row = {
  downloaded_at: T0,
  response_mime_type: 'image/jpeg',
  detected_mime_type: 'image/jpeg',
  byte_count: 1024,
  content_sha256: Buffer.alloc(32, 1),
};
const acceptedEvidence = (seed: number): Row => ({
  stored_at: T0,
  object_etag: `etag.agg.${seed}`,
  capability_token_hash: Buffer.alloc(32, seed),
  capability_key_version: 1,
  capability_key_version_text: '1',
  capability_issued_at: T0,
});
/** Parameter-bound fixture insert: SQL text and column order are fixed literals. */
const FIXTURE_COLUMNS =
  'id webhook_message_id provider_media_id sender_id captured_sale_id object_key status version lease_owner lease_expires_at declared_amount_cents attach_started_at attach_attempts attach_attempt_id attach_request_started_at meta_attempts storage_attempts next_attempt_at downloaded_at response_mime_type detected_mime_type byte_count content_sha256 stored_at object_etag capability_token_hash capability_key_version capability_key_version_text capability_issued_at'.split(
    ' ',
  );
const SQL_INSERT_FIXTURE =
  'INSERT INTO receipt_media (id, webhook_message_id, provider_media_id, sender_id, captured_sale_id, object_key, status, version, lease_owner, lease_expires_at, declared_amount_cents, attach_started_at, attach_attempts, attach_attempt_id, attach_request_started_at, meta_attempts, storage_attempts, next_attempt_at, downloaded_at, response_mime_type, detected_mime_type, byte_count, content_sha256, stored_at, object_etag, capability_token_hash, capability_key_version, capability_key_version_text, capability_issued_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)';
const fence = (key: ReceiptKey, expectedVersion: string) => ({
  id: RECEIPTS[key].id,
  owner: OWNERS[key],
  expectedVersion,
});
const commands = () =>
  ({
    attached: {
      ...fence('attached', '4'),
      attachAttemptId: ATTACH_REQUEST.attached,
      backendReceiptId: BACKEND_RECEIPT_ID,
    },
    definite: {
      ...fence('definite', '4'),
      attachAttemptId: ATTACH_REQUEST.definite,
      httpStatus: 400,
    },
    unknown: {
      ...fence('unknown', '4'),
      attachAttemptId: ATTACH_REQUEST.unknown,
      httpStatus: 408,
    },
    meta: {
      ...fence('meta', '2'),
      category: 'META_TRANSPORT',
      code: 'META_EXHAUSTED',
    },
    storage: {
      ...fence('storage', '2'),
      category: 'OBJECT_STORAGE',
      code: 'STORAGE_EXHAUSTED',
    },
  }) as const;
/** Persisted end state: [status, failure_stage, version, cleanup_pending]. */
const STATE: Record<ReceiptKey, [string, string | null, string, boolean]> = {
  attached: ['ATTACHED', null, '5', false],
  definite: ['FAILED', 'ATTACH_DEFINITE', '5', false],
  unknown: ['ATTACH_OUTCOME_UNKNOWN', null, '5', false],
  meta: ['FAILED', 'META_EXHAUSTED_PRE_STORAGE', '3', false],
  storage: ['FAILED', 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE', '3', true],
};
/** Row-derived intent: [namespace, template_key, template_args]. */
const INTENTS: Record<ReceiptKey, [string, string, Row]> = {
  attached: [
    'receipt-attached-pending',
    'RECEIPT_ATTACHED_PENDING',
    { backendStatus: 'PENDING' },
  ],
  definite: [
    'receipt-attach-definite-failure',
    'RECEIPT_ATTACH_DEFINITE_FAILURE',
    {},
  ],
  unknown: ['receipt-attach-unknown', 'RECEIPT_ATTACH_UNKNOWN', {}],
  meta: ['receipt-unavailable-later', 'RECEIPT_UNAVAILABLE_LATER', {}],
  storage: ['receipt-unavailable-later', 'RECEIPT_UNAVAILABLE_LATER', {}],
};
const TERMINALS = (Object.keys(STATE) as ReceiptKey[]).map((key) => {
  const target = RECEIPTS[key];
  const [status, stage, version, cleanupPending] = STATE[key];
  const [namespace, templateKey, templateArgs] = INTENTS[key];
  return {
    key,
    target,
    owner: OWNERS[key],
    status,
    stage,
    version,
    cleanupPending,
    intent: {
      dedupeKey: `${namespace}:${target.id}:${version}:${target.wamid}`,
      receiptMediaId: target.id,
      receiptStateVersion: version,
      sourceWebhookMessageId: target.wamid,
      recipientId: target.sender,
      templateKey,
      templateArgs,
    },
  };
});
const terminalOf = (key: ReceiptKey) =>
  TERMINALS.find((terminal) => terminal.key === key)!;
ddescribe(
  'receipt-media aggregate outcome recovery (ODD-2E, Testcontainers)',
  () => {
    jest.setTimeout(120_000);
    let container: StartedPostgreSqlContainer;
    let pool: Pool;
    let store: PostgresReceiptMediaStore;
    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      process.env.DATABASE_URL = container.getConnectionUri();
      execSync('pnpm migrate', {
        env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
      });
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
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox,' +
          ' receipt_media',
      );
    });
    const insert = (row: Row): Promise<unknown> => {
      const fixture = { ...DEFAULTS, ...row };
      return pool.query(
        SQL_INSERT_FIXTURE,
        FIXTURE_COLUMNS.map((column) => fixture[column] ?? null),
      );
    };
    const DEFAULTS: Row = {
      status: 'RESERVED',
      version: '0',
      attach_attempts: 0,
      meta_attempts: 0,
      storage_attempts: 0,
      next_attempt_at: T0,
    };
    const base = (target: Receipt): Row => ({
      id: target.id,
      webhook_message_id: target.wamid,
      provider_media_id: target.mediaId,
      sender_id: target.sender,
      captured_sale_id: UUID_SALE,
      object_key: target.objectKey,
    });
    const attaching = (key: ReceiptKey, requestId: string, seed: number) =>
      insert({
        ...base(RECEIPTS[key]),
        ...DOWNLOAD_EVIDENCE,
        ...acceptedEvidence(seed),
        status: 'ATTACHING',
        version: '4',
        lease_owner: OWNERS[key],
        lease_expires_at: LEASE_END(),
        declared_amount_cents: 1250,
        attach_started_at: T0,
        attach_attempts: 1,
        attach_attempt_id: requestId,
        attach_request_started_at: T0,
      });
    const meta = (): Promise<unknown> =>
      insert({
        ...base(RECEIPTS.meta),
        status: 'RESERVED',
        version: '2',
        lease_owner: OWNERS.meta,
        lease_expires_at: LEASE_END(),
        meta_attempts: 3,
      });
    const downloaded = (): Promise<unknown> =>
      insert({
        ...base(RECEIPTS.storage),
        ...DOWNLOAD_EVIDENCE,
        status: 'DOWNLOADED',
        version: '2',
        lease_owner: OWNERS.storage,
        lease_expires_at: LEASE_END(),
        storage_attempts: 3,
      });
    const storedHold = (): Promise<unknown> =>
      insert({
        ...base(RECEIPTS.stored),
        ...DOWNLOAD_EVIDENCE,
        ...acceptedEvidence(9),
        status: 'STORED',
      });
    const seedPredecessors = async (): Promise<void> => {
      await attaching('attached', ATTACH_REQUEST.attached, 2);
      await attaching('definite', ATTACH_REQUEST.definite, 3);
      await attaching('unknown', ATTACH_REQUEST.unknown, 4);
      await meta();
      await downloaded();
    };
    const commitTerminals = async () => {
      const c = commands();
      return {
        attached: await store.commitAttachSuccess(c.attached),
        definite: await store.commitAttachDefiniteFailure(c.definite),
        unknown: await store.commitAttachUnknownOutcome(c.unknown),
        meta: await store.commitMetaFailureDisposition(c.meta),
        storage: await store.commitStorageFailureDisposition(c.storage),
      };
    };
    const receiptRow = async (id: string): Promise<Row> =>
      (await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [id]))
        .rows[0];
    const allReceiptRows = async (): Promise<Row[]> =>
      (await pool.query<Row>('SELECT * FROM receipt_media ORDER BY id')).rows;
    const outboxRows = async (): Promise<Row[]> =>
      (await pool.query<Row>('SELECT * FROM receipt_media_outbox ORDER BY id'))
        .rows;
    it('coexists all five terminal families with their exact intents and replays every one after an adapter recreation', async () => {
      await seedPredecessors();
      const committed = await commitTerminals();
      // Terminal rows and outbox rows coexist with exact state/intent identity.
      const rows = await allReceiptRows();
      const intents = await outboxRows();
      expect(rows).toHaveLength(5);
      expect(intents).toHaveLength(5);
      expect(new Set(intents.map((r) => r.dedupe_key)).size).toBe(5);
      for (const terminal of TERMINALS) {
        const { target, intent } = terminal;
        expect(rows.find((r) => r.id === target.id)).toMatchObject({
          webhook_message_id: target.wamid,
          provider_media_id: target.mediaId,
          sender_id: target.sender,
          object_key: target.objectKey,
          status: terminal.status,
          failure_stage: terminal.stage,
          version: terminal.version,
          lease_owner: terminal.owner,
          cleanup_pending: terminal.cleanupPending,
        });
        const entry = intents.find((r) => r.dedupe_key === intent.dedupeKey);
        expect(entry).toMatchObject({
          receipt_media_id: target.id,
          receipt_state_version: terminal.version,
          source_webhook_message_id: target.wamid,
          recipient_id: target.sender,
          template_key: intent.templateKey,
        });
        expect(entry?.template_args).toEqual(intent.templateArgs);
      }
      // The storage terminal retains download evidence and no accepted object.
      const storageRow = rows.find((r) => r.id === RECEIPTS.storage.id);
      expect(storageRow).toMatchObject({
        downloaded_at: T0,
        byte_count: 1024,
        stored_at: null,
        object_etag: null,
      });
      expect(Buffer.isBuffer(storageRow?.content_sha256)).toBe(true);
      // Four namespaces; unavailable-later rows stay distinct via receipt ids.
      const namespaces = new Set(
        intents.map((r) => String(r.dedupe_key).split(':')[0]),
      );
      expect([...namespaces].sort()).toEqual([
        'receipt-attach-definite-failure',
        'receipt-attach-unknown',
        'receipt-attached-pending',
        'receipt-unavailable-later',
      ]);
      const unavailable = intents.filter(
        (r) => r.template_key === 'RECEIPT_UNAVAILABLE_LATER',
      );
      expect(unavailable).toHaveLength(2);
      expect(
        unavailable.map((r) => String(r.dedupe_key).split(':')[1]).sort(),
      ).toEqual([RECEIPTS.meta.id, RECEIPTS.storage.id].sort());
      // One adapter recreation replays every terminal without any mutation.
      const before = {
        rows: await allReceiptRows(),
        intents: await outboxRows(),
      };
      const replayStore = new PostgresReceiptMediaStore(pool);
      const c = commands();
      const replays: Array<[unknown, (typeof TERMINALS)[number]]> = [
        [
          await replayStore.commitAttachSuccess(c.attached),
          terminalOf('attached'),
        ],
        [
          await replayStore.commitAttachDefiniteFailure(c.definite),
          terminalOf('definite'),
        ],
        [
          await replayStore.commitAttachUnknownOutcome(c.unknown),
          terminalOf('unknown'),
        ],
        [
          await replayStore.commitMetaFailureDisposition(c.meta),
          terminalOf('meta'),
        ],
        [
          await replayStore.commitStorageFailureDisposition(c.storage),
          terminalOf('storage'),
        ],
      ];
      const committedIntent = (o: unknown) => (o as { intent: Row }).intent;
      for (const [outcome, terminal] of replays) {
        expect(outcome).toMatchObject({
          kind: 'replayed',
          version: terminal.version,
        });
        expect(committedIntent(outcome)).toEqual(
          committedIntent(committed[terminal.key]),
        );
      }
      expect(await allReceiptRows()).toEqual(before.rows);
      expect(await outboxRows()).toEqual(before.intents);
    });
    it('hands the real storage terminal to cleanup with no new intent and holds every terminal row from the generic claim', async () => {
      await seedPredecessors();
      await storedHold();
      const outcomes = await commitTerminals();
      expect(outcomes.storage).toMatchObject({
        kind: 'terminal',
        failureStage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
        version: '3',
        intent: terminalOf('storage').intent,
      });
      // The real primitive left the durable backlog flag and retained lease.
      const terminal = await receiptRow(RECEIPTS.storage.id);
      expect(terminal).toMatchObject({
        status: 'FAILED',
        cleanup_pending: true,
        cleanup_attempts: 0,
        lease_owner: OWNERS.storage,
        version: '3',
        last_error_code: 'STORAGE_EXHAUSTED',
      });
      const intentsBefore = await outboxRows();
      expect(intentsBefore).toHaveLength(5);
      // Release the retained terminal lease, then claim with a new owner.
      expect(
        await store.releaseLease({
          id: RECEIPTS.storage.id,
          owner: OWNERS.storage,
          expectedVersion: '3',
        }),
      ).toBe(true);
      const claimed = await store.claimCleanupBatch(5, OWNERS.cleanup);
      expect(claimed.map((r) => r.id)).toEqual([RECEIPTS.storage.id]);
      const claimedRow = await receiptRow(RECEIPTS.storage.id);
      expect(claimedRow).toMatchObject({
        cleanup_pending: true,
        cleanup_attempts: 1,
        lease_owner: OWNERS.cleanup,
        version: '4',
      });
      expect(Number(claimedRow.lease_expires_at)).toBeGreaterThan(
        Date.now() + 55_000,
      );
      const cleanup = await store.commitCleanupDisposition({
        id: RECEIPTS.storage.id,
        owner: OWNERS.cleanup,
        expectedVersion: '4',
        outcome: 'deleted',
      });
      expect(cleanup).toMatchObject({
        kind: 'cleaned',
        attempt: 1,
        version: '5',
        receipt: {
          cleanupPending: false,
          cleanupAttempts: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      // cleanup_pending true -> false; retained evidence and cleared object
      // boundary.
      const cleaned = await receiptRow(RECEIPTS.storage.id);
      expect(cleaned).toMatchObject({
        status: 'FAILED',
        failure_stage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
        cleanup_pending: false,
        cleanup_attempts: 1,
        lease_owner: null,
        lease_expires_at: null,
        version: '5',
        last_error_code: 'STORAGE_EXHAUSTED',
        object_key: RECEIPTS.storage.objectKey,
        byte_count: 1024,
        stored_at: null,
        object_version_id: null,
        capability_key_version: null,
        capability_key_version_text: null,
        capability_issued_at: null,
        capability_revoked_at: null,
      });
      expect(cleaned.downloaded_at).toEqual(terminal.downloaded_at);
      expect(cleaned.terminal_at).toEqual(terminal.terminal_at);
      expect(cleaned.capability_token_hash).toBeNull();
      expect(Buffer.isBuffer(cleaned.content_sha256)).toBe(true);
      // Cleanup never creates new outbox intent.
      expect(await outboxRows()).toEqual(intentsBefore);
      // Mixed generic claim holds every terminal row and the STORED hold.
      expect(await store.claimBatch(10, 'worker.agg-generic')).toEqual([]);
    });
  },
);
