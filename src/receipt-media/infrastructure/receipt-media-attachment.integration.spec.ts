import { execSync } from 'node:child_process';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosRequestConfig } from 'axios';
import { Pool } from 'pg';
import { of, throwError } from 'rxjs';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RECEIPT_UPLOAD_TIMEOUT_MS } from '../../chatbot-api/domain/dtos/receipt-upload.dto';
import { ChatbotApiHttpClient } from '../../chatbot-api/infrastructure/chatbot-api-http.client';
import { ReceiptAttachmentService } from '../application/receipt-attachment.service';
import { ReceiptIngestionProcessor } from '../application/receipt-ingestion.processor';
import { ReceiptProcessingDispatcher } from '../application/receipt-processing-dispatcher.service';
import type { ValidatedMediaFile } from '../domain/meta-media.port';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import { ReceiptMediaIngestionWorker } from './receipt-media-ingestion.worker';

/** R2 cross-boundary: the real worker → processor → attachment service →
 * REAL ChatbotApiHttpClient (Axios seam mocked) → real PostgreSQL store with
 * production migrations. Proves the multipart wire request and the durable
 * outcome of each backend answer. Gated by RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const SALE = 'cccccccc-0001-4000-8000-000000000001';
const BACKEND_RECEIPT = 'dddddddd-0001-4000-8000-000000000001';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const rec = (n: number, label: string) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.r2http.${label}`,
  mediaId: `media.r2http.${label}`,
  sender: `sender.r2http.${label}`,
});
type Media = ReturnType<typeof rec>;

const response = (data: unknown, status = 201) => ({
  data,
  status,
  statusText: '',
  headers: {},
  config: { headers: new AxiosHeaders() },
});
const httpError = (status: number, error: string) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: { error } },
  });

ddescribe('receipt-media backend upload over the real HTTP client (R2)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;
  const workers = new Set<ReceiptMediaIngestionWorker>();

  const boot = (
    owner: string,
    answer: (config: AxiosRequestConfig, call: number) => unknown,
  ) => {
    const http = new HttpService();
    const calls: AxiosRequestConfig[] = [];
    jest.spyOn(http, 'request').mockImplementation((config) => {
      calls.push(config);
      return answer(config, calls.length) as ReturnType<HttpService['request']>;
    });
    const client = new ChatbotApiHttpClient(
      http,
      new ConfigService({
        chatbotApi: {
          baseUrl: 'https://backend.invalid',
          serviceKey: 'svc_test',
          branchId: 'branch',
        },
      }),
      () => Promise.resolve(),
    );
    const file: ValidatedMediaFile = {
      filePath: '/not-read',
      mimeType: 'image/jpeg',
      byteCount: JPEG.length,
      providerDeclaredBytes: JPEG.length,
      sha256: Buffer.alloc(32, 7),
      cleanup: async () => undefined,
    };
    const processor = new ReceiptIngestionProcessor(
      { resolveAndDownload: () => Promise.resolve(file) },
      store,
      {
        extract: () =>
          Promise.resolve({
            kind: 'receipt',
            amountCents: 150_000,
            date: null,
            reference: 'REF1',
            bank: null,
            confidence: 'high',
            amountMismatch: false,
          }),
      },
      new ReceiptAttachmentService(store, client),
      { get: () => Promise.resolve(null) },
      { readFile: () => Promise.resolve(JPEG) },
    );
    const worker = new ReceiptMediaIngestionWorker(
      store,
      new ReceiptProcessingDispatcher(processor),
      { owner, pollIntervalMs: 50, batchSize: 4, maxConcurrency: 4 },
    );
    workers.add(worker);
    worker.onApplicationBootstrap();
    return { calls };
  };

  const seed = (target: Media) =>
    pool.query(
      `INSERT INTO receipt_media (id, webhook_message_id, provider_media_id,
         sender_id, captured_sale_id, object_key, status, version,
         declared_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'RESERVED', 0, 'image/jpeg')`,
      [
        target.id,
        target.wamid,
        target.mediaId,
        target.sender,
        SALE,
        `receipts/${target.id}`,
      ],
    );
  const readRow = async (id: string): Promise<Row> =>
    (await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [id]))
      .rows[0];
  const templates = async (id: string): Promise<unknown[]> =>
    (
      await pool.query<{ template_key: string }>(
        'SELECT template_key FROM receipt_media_outbox WHERE receipt_media_id = $1 ORDER BY created_at',
        [id],
      )
    ).rows.map((r) => r.template_key);
  const waitFor = async (
    target: Media,
    ok: (row: Row) => boolean,
  ): Promise<Row> => {
    const deadline = Date.now() + 40_000;
    for (;;) {
      const row = await readRow(target.id);
      if (ok(row)) return row;
      if (Date.now() > deadline) throw new Error('R2: waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    store = new PostgresReceiptMediaStore(pool);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });
  afterEach(async () => {
    for (const worker of workers) await worker.onModuleDestroy();
    workers.clear();
    jest.restoreAllMocks();
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
    );
  });

  it('sends one multipart POST keyed by the media id and commits ATTACHED', async () => {
    const target = rec(1, 'success');
    await seed(target);
    const h = boot('r2http.success', () =>
      of(
        response({
          receiptId: BACKEND_RECEIPT,
          status: 'PENDING',
          mimeType: 'image/jpeg',
          sizeBytes: 4,
          sha256: 'ab'.repeat(32),
          previewStatus: 'READY',
        }),
      ),
    );
    const row = await waitFor(target, (r) => r.status === 'ATTACHED');
    expect(row.backend_receipt_id).toBe(BACKEND_RECEIPT);
    expect(h.calls).toHaveLength(1);
    const [config] = h.calls;
    expect(config).toMatchObject({
      method: 'POST',
      url: `/chatbot-api/sales/${SALE}/receipts`,
      timeout: RECEIPT_UPLOAD_TIMEOUT_MS,
      headers: {
        Authorization: 'Bearer svc_test',
        'X-Idempotency-Key': target.mediaId,
      },
    });
    const form = config.data as FormData;
    expect((form.get('file') as File).type).toBe('image/jpeg');
    expect(JSON.parse(form.get('extracted') as string)).toEqual({
      amountCents: 150_000,
      reference: 'REF1',
      confidence: 0.9,
    });
    expect(await templates(target.id)).toEqual(['RECEIPT_ATTACHED_PENDING']);
  });

  it('commits a 413 as a definite refusal asking for a smaller file', async () => {
    const target = rec(2, 'toolarge');
    await seed(target);
    boot('r2http.toolarge', () =>
      throwError(() => httpError(413, 'RECEIPT_FILE_TOO_LARGE')),
    );
    const row = await waitFor(target, (r) => r.status === 'FAILED');
    expect(row).toMatchObject({
      failure_stage: 'ATTACH_DEFINITE',
      attach_http_status: 413,
      last_error_code: 'RECEIPT_FILE_TOO_LARGE',
    });
    expect(await templates(target.id)).toEqual(['RECEIPT_UNSUPPORTED_FORMAT']);
  });

  it('schedules a same-key retry on a transport timeout', async () => {
    const target = rec(3, 'timeout');
    await seed(target);
    boot('r2http.timeout', () =>
      throwError(() =>
        Object.assign(new Error('timeout of 90000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    );
    const row = await waitFor(
      target,
      (r) => r.status === 'DOWNLOADED' && r.lease_owner === null,
    );
    expect(row).toMatchObject({
      storage_attempts: 1,
      last_error_code: 'TRANSPORT_FAILURE',
    });
    expect(await templates(target.id)).toEqual(['RECEIPT_ATTACH_UNKNOWN']);
  });
});
