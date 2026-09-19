import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { CapabilityService } from '../application/capability.service';
import { ReceiptIngestionProcessor } from '../application/receipt-ingestion.processor';
import { ReceiptProcessingDispatcher } from '../application/receipt-processing-dispatcher.service';
import type { ReceiptAttachmentService } from '../application/receipt-attachment.service';
import {
  MetaMediaError,
  type MetaMediaPort,
  type MetaMediaRequest,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import {
  type ObjectStoragePort,
  type PutObjectInput,
} from '../domain/object-storage.port';
import type { ReceiptMediaRow } from '../domain/receipt-media.types';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import { ReceiptMediaIngestionWorker } from './receipt-media-ingestion.worker';

/** ODD-6A1 tests-only composition: the real worker → dispatcher → processor →
 * PostgreSQL store chain over Testcontainers with the production migrations
 * and deterministic fake Meta/object-storage boundaries; ATTACHING is an
 * inert stub. No production change; gated by RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const SALE = 'cccccccc-0001-4000-8000-000000000001';
/** Distinct receipt/webhook/provider/sender/object identity per case. */
const media = (n: number, label: string) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.odd6a.${label}`,
  mediaId: `media.odd6a.${label}`,
  sender: `sender.odd6a.${label}`,
  objectKey: `receipts/aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
});
type Media = ReturnType<typeof media>;
const PROMPT = media(1, 'prompt');
const CONFIRM = media(2, 'confirm');
const RETRY = media(3, 'retry');
const EXHAUST = media(4, 'exhaust');
const RECLAIM = media(5, 'reclaim');
const COLS =
  'id webhook_message_id provider_media_id sender_id captured_sale_id object_key status version declared_mime_type declared_amount_cents lease_owner lease_expires_at'.split(
    ' ',
  );
const INSERT = `INSERT INTO receipt_media (${COLS.join(
  ', ',
)}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')})`;
/** Independently derived from the production two-pass claim sequence: claim,
 * meta attempt, download commit, reclaim, meta attempt, storage attempt, and
 * accepted-object bootstrap each bump `version` once. */
const ACCEPTED_VERSION = '7';
/** The bootstrap dedupe key binds the pre-bootstrap (storage-attempt)
 * expected version, exactly one below the accepted successor. */
const PRE_BOOTSTRAP_VERSION = '6';
type StorageHandler = (
  input: PutObjectInput,
  call: number,
) => Promise<{ etag: string; versionId: string | null }>;

ddescribe('receipt-media ingestion worker integration (ODD-6A1)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;
  let priorDatabaseUrl: string | undefined;
  const workers = new Set<ReceiptMediaIngestionWorker>();
  const attachment = { attach: jest.fn() } as unknown as Pick<
    ReceiptAttachmentService,
    'attach'
  >;
  /** The readable path is the spec's own bytes; the fake cleanup never deletes. */
  const fakeFile = (): ValidatedMediaFile => ({
    filePath: __filename,
    mimeType: 'image/jpeg',
    byteCount: 4096,
    providerDeclaredBytes: 4096,
    sha256: Buffer.alloc(32, 7),
    cleanup: async () => undefined,
  });
  const fakeMeta = (
    handler: (
      input: MetaMediaRequest,
      call: number,
    ) => Promise<ValidatedMediaFile>,
  ) => {
    const calls: MetaMediaRequest[] = [];
    const port: MetaMediaPort = {
      resolveAndDownload: (input) => {
        calls.push(input);
        return handler(input, calls.length);
      },
    };
    return { port, calls };
  };
  const fakeStorage = (
    handler: StorageHandler = async () => ({
      etag: 'etag.test',
      versionId: null,
    }),
  ) => {
    const calls: PutObjectInput[] = [];
    const port: Pick<ObjectStoragePort, 'put'> = {
      put: (input) => {
        calls.push(input);
        input.content.resume();
        return handler(input, calls.length);
      },
    };
    return { port, calls };
  };
  const boot = (
    owner: string,
    meta: MetaMediaPort,
    storage: Pick<ObjectStoragePort, 'put'>,
  ) => {
    const capability = new CapabilityService(
      new Map([['1', Buffer.alloc(32, 3)]]),
      '1',
    );
    const dispatcher = new ReceiptProcessingDispatcher(
      new ReceiptIngestionProcessor(meta, storage, store, capability),
      attachment,
    );
    const worker = new ReceiptMediaIngestionWorker(store, dispatcher, {
      owner,
      pollIntervalMs: 50,
      batchSize: 4,
      maxConcurrency: 4,
    });
    workers.add(worker);
    worker.onApplicationBootstrap();
    return { worker, dispatcher };
  };
  const seed = async (target: Media, over: Row = {}): Promise<void> => {
    const row: Row = {
      status: 'RESERVED',
      version: '0',
      declared_mime_type: 'image/jpeg',
      ...over,
      id: target.id,
      webhook_message_id: target.wamid,
      provider_media_id: target.mediaId,
      sender_id: target.sender,
      captured_sale_id: SALE,
      object_key: target.objectKey,
    };
    await pool.query(
      INSERT,
      COLS.map((column) => row[column] ?? null),
    );
    await pool.query(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, now(), '{}'::jsonb) ON CONFLICT (sender_id) DO NOTHING`,
      [target.sender],
    );
  };
  const readRow = async (id: string): Promise<Row> =>
    (await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [id]))
      .rows[0];
  const readOutbox = async (): Promise<Row[]> =>
    (
      await pool.query<Row>(
        'SELECT * FROM receipt_media_outbox ORDER BY created_at, template_key',
      )
    ).rows;
  const waitFor = async <T>(
    probe: () => Promise<T | null>,
    ms = 40_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('ODD-6A1: waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const waitRow = (target: Media, status: string): Promise<Row> =>
    waitFor(async () => {
      const row = await readRow(target.id);
      return row.status === status ? row : null;
    });
  /** Deterministic reclaim seam: wait for the real worker's first pass to
   * commit DOWNLOADED, then expire that row's live lease so the next poll can
   * reclaim the storage/bootstrap stage without the 60-second production
   * lease. Test-controlled database evidence only; no production change. */
  const expireLeaseAfterDownload = async (target: Media): Promise<void> => {
    await waitRow(target, 'DOWNLOADED');
    await pool.query(
      `UPDATE receipt_media SET lease_expires_at = now() - interval '1 second'
        WHERE id = $1 AND status = 'DOWNLOADED'`,
      [target.id],
    );
  };
  const acceptAfterReclaim = async (
    target: Media,
    status: string,
  ): Promise<Row> => {
    await expireLeaseAfterDownload(target);
    return waitRow(target, status);
  };

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    store = new PostgresReceiptMediaStore(pool);
  });
  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (container) await container.stop();
      } finally {
        if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = priorDatabaseUrl;
      }
    }
  });
  afterEach(async () => {
    for (const worker of workers) await worker.onModuleDestroy();
    workers.clear();
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox,' +
        ' receipt_media, conversation_state',
    );
  });

  it('drives RESERVED rows to their accepted-object amount state with the exact prompt/confirm intent', async () => {
    const meta = fakeMeta(async () => fakeFile());
    const storage = fakeStorage();
    await seed(PROMPT);
    await seed(CONFIRM, { declared_amount_cents: 1250 });
    boot('worker.flow', meta.port, storage.port);
    const [prompt, confirm] = await Promise.all([
      acceptAfterReclaim(PROMPT, 'AWAITING_AMOUNT'),
      acceptAfterReclaim(CONFIRM, 'AWAITING_CONFIRMATION'),
    ]);
    expect(prompt).toMatchObject({
      object_etag: 'etag.test',
      declared_amount_cents: null,
      byte_count: 4096,
    });
    expect(prompt.version).toBe(ACCEPTED_VERSION);
    expect(prompt.stored_at).toBeInstanceOf(Date);
    expect(confirm).toMatchObject({
      object_etag: 'etag.test',
      declared_amount_cents: 1250,
    });
    expect(confirm.version).toBe(ACCEPTED_VERSION);
    expect(confirm.stored_at).toBeInstanceOf(Date);
    expect(confirm.amount_proposed_at).toBeInstanceOf(Date);
    const intents = await readOutbox();
    expect(intents).toHaveLength(2);
    const promptIntent = intents.find((i) => i.receipt_media_id === PROMPT.id);
    const confirmIntent = intents.find(
      (i) => i.receipt_media_id === CONFIRM.id,
    );
    expect(promptIntent).toMatchObject({
      template_key: 'RECEIPT_AMOUNT_PROMPT',
      recipient_id: PROMPT.sender,
      source_webhook_message_id: PROMPT.wamid,
      receipt_state_version: ACCEPTED_VERSION,
    });
    expect(promptIntent?.template_args).toEqual({});
    expect(promptIntent?.dedupe_key).toBe(
      `receipt-amount-prompt:${PROMPT.id}:${PRE_BOOTSTRAP_VERSION}:${PROMPT.wamid}`,
    );
    expect(confirmIntent).toMatchObject({
      template_key: 'RECEIPT_AMOUNT_CONFIRM',
      recipient_id: CONFIRM.sender,
      source_webhook_message_id: CONFIRM.wamid,
      receipt_state_version: ACCEPTED_VERSION,
    });
    expect(confirmIntent?.template_args).toEqual({ amountCents: 1250 });
    expect(confirmIntent?.dedupe_key).toBe(
      `receipt-amount-confirm:${CONFIRM.id}:${PRE_BOOTSTRAP_VERSION}:${CONFIRM.wamid}`,
    );
    expect(meta.calls).toHaveLength(4);
    expect(storage.calls).toHaveLength(2);
  });

  it('schedules a durable retry on a transient Meta failure and reaches the accepted state after the re-claim', async () => {
    const meta = fakeMeta(async (_input, call) => {
      if (call === 1)
        throw new MetaMediaError('META_TRANSPORT', 'HTTP_RETRYABLE');
      return fakeFile();
    });
    const storage = fakeStorage();
    await seed(RETRY);
    boot('worker.retry', meta.port, storage.port);
    const reclaim = acceptAfterReclaim(RETRY, 'AWAITING_AMOUNT');
    const retried = await waitFor(async () => {
      const row = await readRow(RETRY.id);
      return row.meta_attempts === 1 && row.status === 'RESERVED' ? row : null;
    });
    expect(retried).toMatchObject({
      last_error_category: 'META_TRANSPORT',
      last_error_code: 'HTTP_RETRYABLE',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect((retried.next_attempt_at as Date).getTime()).toBeGreaterThan(
      (retried.updated_at as Date).getTime(),
    );
    expect(await readOutbox()).toEqual([]);
    const done = await reclaim;
    expect(done).toMatchObject({
      meta_attempts: 3,
      last_error_code: 'HTTP_RETRYABLE',
    });
    expect(meta.calls).toHaveLength(3);
  });

  it('exhausts Meta at exactly three attempts and never issues a fourth call', async () => {
    const meta = fakeMeta(async () => {
      throw new MetaMediaError('META_TRANSPORT', 'HTTP_RETRYABLE');
    });
    const storage = fakeStorage();
    await seed(EXHAUST);
    const { dispatcher } = boot('worker.exhaust', meta.port, storage.port);
    const failed = await waitRow(EXHAUST, 'FAILED');
    expect(failed).toMatchObject({
      failure_stage: 'META_EXHAUSTED_PRE_STORAGE',
      meta_attempts: 3,
      last_error_category: 'META_TRANSPORT',
      last_error_code: 'HTTP_RETRYABLE',
    });
    expect(meta.calls).toHaveLength(3);
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template_key: 'RECEIPT_UNAVAILABLE_LATER',
      receipt_media_id: EXHAUST.id,
    });
    // No fourth call: the terminal row is neither claimable nor dispatched.
    expect(await store.claimBatch(10, 'worker.exhaust.probe')).toEqual([]);
    expect(
      await dispatcher.dispatch(
        failed as unknown as ReceiptMediaRow,
        'worker.exhaust.probe',
      ),
    ).toEqual({ kind: 'non-dispatched', status: 'FAILED' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(meta.calls).toHaveLength(3);
  });

  it('reclaims an expired lease with a replacement worker', async () => {
    const meta = fakeMeta(async () => fakeFile());
    const storage = fakeStorage();
    await seed(RECLAIM, {
      version: '1',
      lease_owner: 'worker.stale',
      lease_expires_at: new Date(Date.now() - 60_000),
    });
    boot('worker.replacement', meta.port, storage.port);
    const done = await acceptAfterReclaim(RECLAIM, 'AWAITING_AMOUNT');
    expect(done).toMatchObject({
      lease_owner: 'worker.replacement',
      meta_attempts: 2,
    });
    expect(meta.calls).toHaveLength(2);
  });
});
