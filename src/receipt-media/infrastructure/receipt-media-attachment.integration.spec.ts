import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type {
  AttachReceiptInput,
  AttachReceiptResponse,
} from '../../chatbot-api/domain/dtos/sales.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { CapabilityService } from '../application/capability.service';
import { ReceiptAttachmentService } from '../application/receipt-attachment.service';
import { ReceiptProcessingDispatcher } from '../application/receipt-processing-dispatcher.service';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import { ReceiptMediaIngestionWorker } from './receipt-media-ingestion.worker';

/** ODD-6B tests-only aggregate evidence: the real ingestion worker → real
 * dispatcher → real `ReceiptAttachmentService` → real PostgreSQL store over
 * Testcontainers with the production migrations, a real `CapabilityService`,
 * a deterministic backend fake, and an inert processor seam that ATTACHING
 * rows must never reach. No production change; gated by RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const SALE = 'cccccccc-0001-4000-8000-000000000001';
const BASE = 'https://media.odd6b.test';
const T0 = new Date('2025-01-01T00:00:00Z');
const BACKEND_RECEIPT = 'dddddddd-0001-4000-8000-000000000001';
/** Durable request identity already present on a request-evidenced row. */
const DURABLE_REQUEST = 'eeeeeeee-0001-4000-8000-000000000001';
/** Distinct receipt/webhook/provider/sender/object identity per case. */
const rec = (n: number, label: string) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.odd6b.${label}`,
  mediaId: `media.odd6b.${label}`,
  sender: `sender.odd6b.${label}`,
  objectKey: `receipts/aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
});
type Media = ReturnType<typeof rec>;
const SUCCESS = rec(1, 'success');
const DEFINITE = rec(2, 'definite');
const UNKNOWN = rec(3, 'unknown');
const RECLAIM = rec(4, 'reclaim');
const SHUTDOWN = rec(5, 'shutdown');
const COLS = (
  'id webhook_message_id provider_media_id sender_id captured_sale_id object_key' +
  ' status version declared_amount_cents downloaded_at response_mime_type' +
  ' detected_mime_type byte_count content_sha256 stored_at object_etag' +
  ' capability_token_hash capability_key_version capability_key_version_text' +
  ' capability_issued_at attach_started_at attach_attempts attach_attempt_id' +
  ' attach_request_started_at lease_owner lease_expires_at next_attempt_at'
).split(' ');
const INSERT = `INSERT INTO receipt_media (${COLS.join(
  ', ',
)}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')})`;
type AttachCall = {
  saleId: string;
  body: AttachReceiptInput;
  signal?: AbortSignal;
};
type AttachHandler = (
  call: AttachCall,
  attempt: number,
) => Promise<AttachReceiptResponse>;
/** One externally settled backend call: the spec owns when it rejects. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
/** Real deterministic capability over one fixed 32-byte key (version 1). */
const capability = new CapabilityService(
  new Map([['1', Buffer.alloc(32, 3)]]),
  '1',
);

ddescribe('receipt-media attachment cross-boundary (ODD-6B)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;
  let priorDatabaseUrl: string | undefined;
  const workers = new Set<ReceiptMediaIngestionWorker>();
  const ingested: jest.Mock[] = [];
  const fakeClient = (handler: AttachHandler) => {
    const calls: AttachCall[] = [];
    const client: Pick<ChatbotApiClient, 'attachReceipt'> = {
      attachReceipt: (saleId, body, options) => {
        const call = { saleId, body, signal: options?.signal };
        calls.push(call);
        return handler(call, calls.length);
      },
    };
    return { client, calls };
  };
  /** Real worker → real dispatcher → real attachment service → real store;
   * the processor seam is inert and must never run for ATTACHING rows. */
  const boot = (
    owner: string,
    client: Pick<ChatbotApiClient, 'attachReceipt'>,
  ): ReceiptMediaIngestionWorker => {
    const ingestion = { process: jest.fn() };
    ingested.push(ingestion.process);
    const dispatcher = new ReceiptProcessingDispatcher(
      ingestion,
      new ReceiptAttachmentService(
        store,
        client,
        { receiptMedia: { publicBaseUrl: BASE } },
        capability,
      ),
    );
    const worker = new ReceiptMediaIngestionWorker(store, dispatcher, {
      owner,
      pollIntervalMs: 50,
      batchSize: 4,
      maxConcurrency: 4,
    });
    workers.add(worker);
    worker.onApplicationBootstrap();
    return worker;
  };
  const seed = async (target: Media, over: Row = {}) => {
    const issued = capability.issue(target.id);
    const row: Row = {
      status: 'ATTACHING',
      version: '0',
      declared_amount_cents: 15000,
      downloaded_at: T0,
      response_mime_type: 'image/jpeg',
      detected_mime_type: 'image/jpeg',
      byte_count: 4096,
      content_sha256: Buffer.alloc(32, 7),
      stored_at: T0,
      object_etag: 'etag.odd6b',
      capability_token_hash: issued.tokenHash,
      capability_key_version: 1,
      capability_key_version_text: issued.keyVersion,
      capability_issued_at: T0,
      attach_started_at: T0,
      attach_attempts: 0,
      next_attempt_at: T0,
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
    return issued;
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
      if (Date.now() > deadline) throw new Error('ODD-6B: waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const waitRow = (target: Media, status: string): Promise<Row> =>
    waitFor(async () => {
      const row = await readRow(target.id);
      return row.status === status ? row : null;
    });
  const intentOf = (target: Media, version: string, namespace: string) => ({
    dedupe_key: `${namespace}:${target.id}:${version}:${target.wamid}`,
    receipt_media_id: target.id,
    receipt_state_version: version,
    source_webhook_message_id: target.wamid,
    recipient_id: target.sender,
  });

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
    let failure: unknown;
    try {
      if (pool) await pool.end();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (container) await container.stop();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
    } catch (error) {
      failure ??= error;
    }
    if (failure)
      throw failure instanceof Error ? failure : new Error('teardown');
  });
  afterEach(async () => {
    let failure: unknown;
    try {
      for (const worker of workers) await worker.onModuleDestroy();
    } catch (error) {
      failure ??= error;
    } finally {
      workers.clear();
    }
    for (const process of ingested) expect(process).not.toHaveBeenCalled();
    ingested.length = 0;
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox,' +
        ' receipt_media, conversation_state',
    );
    if (failure)
      throw failure instanceof Error ? failure : new Error('teardown');
  });

  it('attaches a claimed ATTACHING row with the exact capability URL and one success intent', async () => {
    const issued = await seed(SUCCESS);
    const { client, calls } = fakeClient(async () => ({
      receiptId: BACKEND_RECEIPT,
      status: 'PENDING' as const,
    }));
    boot('worker.success', client);
    const row = await waitRow(SUCCESS, 'ATTACHED');
    expect(row).toMatchObject({
      status: 'ATTACHED',
      version: '3',
      backend_receipt_id: BACKEND_RECEIPT,
      backend_receipt_status: 'PENDING',
    });
    expect(row.attached_at).toBeInstanceOf(Date);
    expect(calls).toHaveLength(1);
    expect(calls[0].saleId).toBe(SALE);
    expect(calls[0].body.declaredAmountCents).toBe(15000);
    expect(calls[0].body.mediaUrl).toBe(
      `${BASE}/media/receipts/${issued.token}`,
    );
    expect(calls[0].body.mediaUrl).not.toContain(SUCCESS.objectKey);
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      ...intentOf(SUCCESS, '3', 'receipt-attached-pending'),
      template_key: 'RECEIPT_ATTACHED_PENDING',
    });
    expect(intents[0].template_args).toEqual({ backendStatus: 'PENDING' });
  });

  it('records a representative definite failure with safe status evidence and one failure intent', async () => {
    await seed(DEFINITE);
    const { client, calls } = fakeClient(async () => {
      throw new ChatbotApiError('rejected', 422);
    });
    boot('worker.definite', client);
    const row = await waitRow(DEFINITE, 'FAILED');
    expect(row).toMatchObject({
      status: 'FAILED',
      failure_stage: 'ATTACH_DEFINITE',
      attach_http_status: 422,
      attach_transport_code: null,
      backend_receipt_id: null,
      version: '3',
    });
    expect(calls).toHaveLength(1);
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      ...intentOf(DEFINITE, '3', 'receipt-attach-definite-failure'),
      template_key: 'RECEIPT_ATTACH_DEFINITE_FAILURE',
    });
    expect(intents[0].template_args).toEqual({});
  });

  it('records an ambiguous outcome as exactly one unknown intent and never re-POSTs on a replacement worker', async () => {
    await seed(UNKNOWN);
    const { client, calls } = fakeClient(async () => {
      throw new ChatbotApiError('server error', 500);
    });
    boot('worker.unknown', client);
    const row = await waitRow(UNKNOWN, 'ATTACH_OUTCOME_UNKNOWN');
    expect(row).toMatchObject({
      status: 'ATTACH_OUTCOME_UNKNOWN',
      attach_http_status: 500,
      attach_transport_code: null,
      backend_receipt_id: null,
      version: '3',
    });
    expect(calls).toHaveLength(1);
    const firstIntents = await readOutbox();
    expect(firstIntents).toHaveLength(1);
    expect(firstIntents[0]).toMatchObject({
      ...intentOf(UNKNOWN, '3', 'receipt-attach-unknown'),
      template_key: 'RECEIPT_ATTACH_UNKNOWN',
    });
    expect(firstIntents[0].template_args).toEqual({});
    boot('worker.replacement', client);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toHaveLength(1);
    expect(await readOutbox()).toEqual(firstIntents);
    expect(await store.claimBatch(10, 'worker.unknown.probe')).toEqual([]);
  });

  it('fixes a request-evidenced expired-lease reclaim forward with zero POST and one unknown intent', async () => {
    await seed(RECLAIM, {
      attach_attempts: 1,
      attach_attempt_id: DURABLE_REQUEST,
      attach_request_started_at: T0,
      lease_owner: 'worker.stale',
      lease_expires_at: new Date(Date.now() - 60_000),
    });
    const { client, calls } = fakeClient(async () => ({
      receiptId: BACKEND_RECEIPT,
      status: 'PENDING' as const,
    }));
    boot('worker.reclaim', client);
    const row = await waitRow(RECLAIM, 'ATTACH_OUTCOME_UNKNOWN');
    expect(row).toMatchObject({
      status: 'ATTACH_OUTCOME_UNKNOWN',
      attach_transport_code: 'TRANSPORT_FAILURE',
      attach_http_status: null,
      attach_attempt_id: DURABLE_REQUEST,
      version: '2',
    });
    expect(calls).toHaveLength(0);
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      ...intentOf(RECLAIM, '2', 'receipt-attach-unknown'),
      template_key: 'RECEIPT_ATTACH_UNKNOWN',
    });
    expect(intents[0].template_args).toEqual({});
  });

  it('aborts the in-flight POST on destroy and drains only after the unknown commit is durable', async () => {
    await seed(SHUTDOWN);
    const backed = deferred<AttachReceiptResponse>();
    // Immediate observer so the controlled rejection below can never surface
    // as an unhandled rejection when an earlier assertion releases control.
    const released = backed.promise.catch(() => undefined);
    let signal: AbortSignal | undefined;
    const { client, calls } = fakeClient((call) => {
      signal = call.signal;
      return backed.promise;
    });
    const worker = boot('worker.shutdown', client);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    let destroy: Promise<void> | undefined;
    try {
      // The abortable backend is only reachable after the request-start commit.
      await waitFor(async () => {
        const row = await readRow(SHUTDOWN.id);
        return row.attach_request_started_at !== null && calls.length === 1
          ? row
          : null;
      });
      let drained = false;
      destroy = worker.onModuleDestroy();
      void destroy.then(() => {
        drained = true;
      });
      await waitFor(() => (signal?.aborted === true ? true : null));
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(await readRow(SHUTDOWN.id)).toMatchObject({ status: 'ATTACHING' });
    } finally {
      // Release the blocked worker even when an assertion above fails.
      backed.reject(abort);
      await released;
    }
    await destroy;
    // The durable transition must already exist when destroy resolves.
    const row = await readRow(SHUTDOWN.id);
    expect(row).toMatchObject({
      status: 'ATTACH_OUTCOME_UNKNOWN',
      attach_transport_code: 'TRANSPORT_FAILURE',
      attach_http_status: null,
      version: '3',
    });
    expect(calls).toHaveLength(1);
    const intents = await readOutbox();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      ...intentOf(SHUTDOWN, '3', 'receipt-attach-unknown'),
      template_key: 'RECEIPT_ATTACH_UNKNOWN',
    });
    expect(intents[0].template_args).toEqual({});
    expect(await store.claimBatch(10, 'worker.shutdown.probe')).toEqual([]);
  });
});
