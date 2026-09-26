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
  ObjectStorageError,
  type ObjectStoragePort,
  type PutObjectInput,
} from '../domain/object-storage.port';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import { ReceiptMediaIngestionWorker } from './receipt-media-ingestion.worker';

/** ODD-6A2 tests-only composition: the remaining worker boundaries over the
 * same real worker → dispatcher → processor → PostgreSQL store chain with
 * production migrations and deterministic fake Meta/object-storage
 * boundaries; ATTACHING is an inert stub. No production change; gated by
 * RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const SALE = 'cccccccc-0001-4000-8000-000000000001';
/** Distinct receipt/webhook/provider/sender/object identity per case. */
const media = (n: number, label: string) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.odd6a2.${label}`,
  mediaId: `media.odd6a2.${label}`,
  sender: `sender.odd6a2.${label}`,
  objectKey: `receipts/aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
});
type Media = ReturnType<typeof media>;
const CLEANUP = media(1, 'cleanup');
const ABORT = media(2, 'abort');
const PEER = media(3, 'peer');
const HELD = media(4, 'held');
const COLS = (
  'id webhook_message_id provider_media_id sender_id captured_sale_id' +
  ' object_key status version declared_mime_type declared_amount_cents' +
  ' lease_owner lease_expires_at downloaded_at response_mime_type' +
  ' detected_mime_type byte_count content_sha256 stored_at object_etag' +
  ' capability_token_hash capability_key_version capability_issued_at'
).split(' ');
const INSERT = `INSERT INTO receipt_media (${COLS.join(
  ', ',
)}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')})`;
/** Independently derived from the production two-pass claim sequence: claim,
 * meta attempt, download commit, reclaim, meta attempt, storage attempt, and
 * the terminal storage disposition each bump `version` once. */
const TERMINAL_VERSION = '7';
type StorageHandler = (
  input: PutObjectInput,
  call: number,
) => Promise<{ etag: string; versionId: string | null }>;
/** One externally settled download: the spec owns when the fake rejects. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

ddescribe('receipt-media ingestion worker boundaries (ODD-6A2)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;
  let priorDatabaseUrl: string | undefined;
  const workers = new Set<ReceiptMediaIngestionWorker>();
  const attach = jest.fn();
  const attachment = { attach } as unknown as Pick<
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
    const claim = jest.spyOn(store, 'claimBatch');
    const worker = new ReceiptMediaIngestionWorker(store, dispatcher, {
      owner,
      pollIntervalMs: 50,
      batchSize: 4,
      maxConcurrency: 4,
    });
    workers.add(worker);
    worker.onApplicationBootstrap();
    return { worker, dispatcher, claims: () => claim.mock.calls.length };
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
    probe: () => T | null | Promise<T | null>,
    ms = 40_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('ODD-6A2: waitFor timed out');
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
  const reclaim = async (target: Media, status: string): Promise<Row> => {
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
    jest.restoreAllMocks();
    expect(attach).not.toHaveBeenCalled();
    attach.mockClear();
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox,' +
        ' receipt_media, conversation_state',
    );
  });

  it('terminalizes a CLEANUP_PENDING storage failure with retained download evidence and the cleanup backlog', async () => {
    const meta = fakeMeta(async () => fakeFile());
    const storage = fakeStorage(async () => {
      throw new ObjectStorageError('OBJECT_STORAGE', 'CLEANUP_PENDING');
    });
    await seed(CLEANUP);
    boot('worker.cleanup', meta.port, storage.port);
    const failed = await reclaim(CLEANUP, 'FAILED');
    expect(failed).toMatchObject({
      failure_stage: 'STORAGE_EXHAUSTED_PRE_ACCEPTANCE',
      last_error_category: 'OBJECT_STORAGE',
      last_error_code: 'CLEANUP_PENDING',
      cleanup_pending: true,
      storage_attempts: 1,
      meta_attempts: 2,
      response_mime_type: 'image/jpeg',
      detected_mime_type: 'image/jpeg',
      byte_count: 4096,
      stored_at: null,
      object_etag: null,
      object_version_id: null,
      capability_token_hash: null,
      capability_key_version: null,
      capability_issued_at: null,
    });
    expect(failed.version).toBe(TERMINAL_VERSION);
    expect(failed.downloaded_at).toBeInstanceOf(Date);
    expect(failed.content_sha256).toEqual(Buffer.alloc(32, 7));
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template_key: 'RECEIPT_UNAVAILABLE_LATER',
      receipt_media_id: CLEANUP.id,
      recipient_id: CLEANUP.sender,
      source_webhook_message_id: CLEANUP.wamid,
      receipt_state_version: TERMINAL_VERSION,
      dedupe_key: `receipt-unavailable-later:${CLEANUP.id}:${TERMINAL_VERSION}:${CLEANUP.wamid}`,
    });
    expect(intents[0].template_args).toEqual({});
    expect(meta.calls.map((call) => call.providerMediaId)).toEqual([
      CLEANUP.mediaId,
      CLEANUP.mediaId,
    ]);
    expect(storage.calls.map((call) => call.key)).toEqual([CLEANUP.objectKey]);
  });

  it('aborts an in-flight Meta download on destroy and drains only after the durable ABORTED disposition commits', async () => {
    const download = deferred<ValidatedMediaFile>();
    let signal: AbortSignal | undefined;
    const meta = fakeMeta((input) => {
      signal = input.signal;
      return download.promise;
    });
    const storage = fakeStorage();
    await seed(ABORT);
    const { worker, claims } = boot('worker.abort', meta.port, storage.port);
    // "Definitely entered": the download committed its Meta attempt first.
    const entered = await waitFor(async () => {
      const row = await readRow(ABORT.id);
      return meta.calls.length === 1 && row.meta_attempts === 1 ? row : null;
    });
    expect(entered.version).toBe('2');
    let drained = false;
    const before = claims();
    const destroy = worker.onModuleDestroy();
    void destroy.then(() => {
      drained = true;
    });
    expect(worker.onModuleDestroy()).toBe(destroy);
    await waitFor(() => (signal?.aborted ? true : null));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    expect(await readRow(ABORT.id)).toMatchObject({
      status: 'RESERVED',
      version: '2',
      lease_owner: 'worker.abort',
      last_error_code: null,
    });
    download.reject(new MetaMediaError('META_TRANSPORT', 'ABORTED'));
    await destroy;
    expect(await readRow(ABORT.id)).toMatchObject({
      status: 'RESERVED',
      version: '3',
      meta_attempts: 1,
      last_error_category: 'META_TRANSPORT',
      last_error_code: 'ABORTED',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(meta.calls).toHaveLength(1);
    expect(claims()).toBe(before);
  });

  it('holds a STORED row unclaimed and untouched while a RESERVED peer reaches accepted-object bootstrap', async () => {
    const meta = fakeMeta(async () => fakeFile());
    const storage = fakeStorage();
    await seed(HELD, {
      status: 'STORED',
      downloaded_at: new Date(),
      response_mime_type: 'image/png',
      detected_mime_type: 'image/png',
      byte_count: 2048,
      content_sha256: Buffer.alloc(32, 9),
      stored_at: new Date(),
      object_etag: 'etag.held',
      capability_token_hash: Buffer.alloc(32, 9),
      capability_key_version: 1,
      capability_issued_at: new Date(),
    });
    await seed(PEER);
    const before = await readRow(HELD.id);
    boot('worker.held', meta.port, storage.port);
    const accepted = await reclaim(PEER, 'AWAITING_AMOUNT');
    expect(accepted).toMatchObject({
      object_etag: 'etag.test',
      byte_count: 4096,
      stored_at: expect.any(Date) as Date,
    });
    expect(accepted.version).toBe(TERMINAL_VERSION);
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template_key: 'RECEIPT_AMOUNT_PROMPT',
      receipt_media_id: PEER.id,
    });
    const held = await readRow(HELD.id);
    expect(held).toMatchObject({
      status: 'STORED',
      version: '0',
      lease_owner: null,
      lease_expires_at: null,
      meta_attempts: 0,
      storage_attempts: 0,
      last_error_code: null,
    });
    expect((held.updated_at as Date).getTime()).toBe(
      (before.updated_at as Date).getTime(),
    );
    expect(meta.calls.map((call) => call.providerMediaId)).toEqual([
      PEER.mediaId,
      PEER.mediaId,
    ]);
    expect(storage.calls.map((call) => call.key)).toEqual([PEER.objectKey]);
    expect(await store.claimBatch(10, 'worker.held.probe')).toEqual([]);
  });
});
