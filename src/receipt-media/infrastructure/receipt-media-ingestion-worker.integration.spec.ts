import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../chatbot-api/domain/errors';
import { ReceiptAttachmentService } from '../application/receipt-attachment.service';
import { ReceiptIngestionProcessor } from '../application/receipt-ingestion.processor';
import { ReceiptProcessingDispatcher } from '../application/receipt-processing-dispatcher.service';
import {
  MetaMediaError,
  type MetaMediaPort,
  type ValidatedMediaFile,
} from '../domain/meta-media.port';
import type {
  ReceiptExtraction,
  ReceiptExtractionPort,
} from '../domain/receipt-extraction.port';
import type { ReceiptMimeType } from '../domain/receipt-media.types';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';
import { ReceiptMediaIngestionWorker } from './receipt-media-ingestion.worker';

/** R2 end-to-end over Testcontainers with the production migrations: the
 * real worker → dispatcher → processor → attachment service → PostgreSQL
 * store chain, with deterministic fakes for Meta, the vision extraction and
 * the backend upload client. Gated by RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const SALE = 'cccccccc-0001-4000-8000-000000000001';
const BACKEND_RECEIPT = 'dddddddd-0001-4000-8000-000000000001';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const ENCRYPTED_PDF = Buffer.from(
  '%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 4 0 R >>\n%%EOF\n',
);
const media = (n: number, label: string) => ({
  id: `aaaaaaaa-000${n}-4000-8000-00000000000${n}`,
  wamid: `wamid.r2.${label}`,
  mediaId: `media.r2.${label}`,
  sender: `sender.r2.${label}`,
});
type Media = ReturnType<typeof media>;
const COLS =
  'id webhook_message_id provider_media_id sender_id captured_sale_id status version declared_mime_type declared_amount_cents'.split(
    ' ',
  );
const INSERT = `INSERT INTO receipt_media (${COLS.join(
  ', ',
)}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')})`;

const receipt = (
  overrides: Partial<Extract<ReceiptExtraction, { kind: 'receipt' }>> = {},
): ReceiptExtraction => ({
  kind: 'receipt',
  amountCents: 150_000,
  date: '2026-11-05',
  reference: 'REF123',
  bank: 'BBVA',
  confidence: 'medium',
  amountMismatch: false,
  ...overrides,
});

const uploaded = {
  receiptId: BACKEND_RECEIPT,
  status: 'PENDING' as const,
  mimeType: 'image/jpeg',
  sizeBytes: 4,
  sha256: 'ab'.repeat(32),
  previewStatus: 'READY' as const,
};

ddescribe('receipt-media R2 pipeline (worker → backend upload)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;
  const workers = new Set<ReceiptMediaIngestionWorker>();

  const fakeFile = (mimeType: ReceiptMimeType): ValidatedMediaFile => ({
    filePath: '/not-read',
    mimeType,
    byteCount: 4,
    providerDeclaredBytes: 4,
    sha256: Buffer.alloc(32, 7),
    cleanup: async () => undefined,
  });

  const boot = (options: {
    owner: string;
    meta?: MetaMediaPort['resolveAndDownload'];
    extraction?: ReceiptExtraction;
    upload?: ChatbotApiClient['uploadReceipt'];
    bytes?: Buffer;
    mime?: ReceiptMimeType;
  }) => {
    const meta = jest.fn(
      options.meta ??
        (() => Promise.resolve(fakeFile(options.mime ?? 'image/jpeg'))),
    );
    const extract = jest.fn<
      ReturnType<ReceiptExtractionPort['extract']>,
      Parameters<ReceiptExtractionPort['extract']>
    >(() => Promise.resolve(options.extraction ?? receipt()));
    const uploadReceipt = jest.fn<
      ReturnType<ChatbotApiClient['uploadReceipt']>,
      Parameters<ChatbotApiClient['uploadReceipt']>
    >(options.upload ?? (() => Promise.resolve(uploaded)));
    const processor = new ReceiptIngestionProcessor(
      { resolveAndDownload: meta },
      store,
      { extract },
      new ReceiptAttachmentService(store, { uploadReceipt }),
      {
        get: (senderId: string) =>
          pool
            .query<{
              data: Record<string, unknown>;
            }>('SELECT data FROM conversation_state WHERE sender_id = $1', [
              senderId,
            ])
            .then((r) =>
              r.rows[0]
                ? {
                    senderId,
                    lastMessageAt: new Date().toISOString(),
                    data: r.rows[0].data,
                  }
                : null,
            ),
      },
      { readFile: () => Promise.resolve(options.bytes ?? JPEG) },
    );
    const worker = new ReceiptMediaIngestionWorker(
      store,
      new ReceiptProcessingDispatcher(processor),
      {
        owner: options.owner,
        pollIntervalMs: 50,
        batchSize: 4,
        maxConcurrency: 4,
      },
    );
    workers.add(worker);
    worker.onApplicationBootstrap();
    return { worker, meta, extract, uploadReceipt };
  };

  const seed = async (
    target: Media,
    mime: ReceiptMimeType = 'image/jpeg',
    declaredAmountCents: number | null = null,
  ): Promise<void> => {
    const row: Row = {
      id: target.id,
      webhook_message_id: target.wamid,
      provider_media_id: target.mediaId,
      sender_id: target.sender,
      captured_sale_id: SALE,
      status: 'RESERVED',
      version: '0',
      declared_mime_type: mime,
      declared_amount_cents: declaredAmountCents,
    };
    await pool.query(
      INSERT,
      COLS.map((column) => row[column] ?? null),
    );
    await pool.query(
      `INSERT INTO conversation_state (sender_id, last_message_at, data)
       VALUES ($1, now(), $2::jsonb)`,
      [
        target.sender,
        JSON.stringify({
          minimalCart: {
            items: [],
            idempotencyKey: '',
            placedSale: { saleId: SALE, folio: 'F-0042', totalCents: 150_000 },
          },
        }),
      ],
    );
  };
  const readRow = async (id: string): Promise<Row> =>
    (await pool.query<Row>('SELECT * FROM receipt_media WHERE id = $1', [id]))
      .rows[0];
  const readOutbox = async (id: string): Promise<Row[]> =>
    (
      await pool.query<Row>(
        'SELECT * FROM receipt_media_outbox WHERE receipt_media_id = $1 ORDER BY created_at',
        [id],
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
      if (Date.now() > deadline) throw new Error('R2: waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const waitStatus = (
    target: Media,
    status: string,
    extra: (row: Row) => boolean = () => true,
  ) =>
    waitFor(async () => {
      const row = await readRow(target.id);
      return row.status === status && extra(row) ? row : null;
    });

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
    await pool.query(
      'TRUNCATE receipt_media_outbox,' + ' receipt_media, conversation_state',
    );
  });

  it('downloads, extracts and uploads in one pass, then says received with the folio and the mismatch', async () => {
    const target = media(1, 'success');
    await seed(target, 'image/jpeg', 149_000);
    const h = boot({
      owner: 'r2.success',
      extraction: receipt({ amountCents: 140_000, amountMismatch: true }),
    });
    const row = await waitStatus(target, 'ATTACHED');
    expect(row).toMatchObject({
      backend_receipt_id: BACKEND_RECEIPT,
      backend_receipt_status: 'PENDING',
      storage_attempts: 1,
      meta_attempts: 1,
    });
    expect(h.meta).toHaveBeenCalledTimes(1);
    expect(h.extract).toHaveBeenCalledWith({
      bytes: JPEG,
      mimeType: 'image/jpeg',
      expectedAmountCents: 150_000,
    });
    expect(h.uploadReceipt).toHaveBeenCalledWith(
      SALE,
      { bytes: JPEG, mimeType: 'image/jpeg', filename: 'receipt.jpg' },
      {
        declared: { amountCents: 149_000 },
        extracted: {
          amountCents: 140_000,
          date: '2026-11-05',
          reference: 'REF123',
          bank: 'BBVA',
          confidence: 0.6,
        },
      },
      target.mediaId,
      expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
    );
    const intents = await readOutbox(target.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template_key: 'RECEIPT_ATTACHED_PENDING',
      recipient_id: target.sender,
      template_args: {
        folio: 'F-0042',
        extractedAmountCents: 140_000,
        totalCents: 150_000,
      },
    });
  });

  it('retries an unknown outcome later with the SAME media id and tells the customer once', async () => {
    const target = media(2, 'retry');
    await seed(target);
    let call = 0;
    const h = boot({
      owner: 'r2.retry',
      upload: () =>
        ++call === 1
          ? Promise.reject(
              new UpstreamError('x', 502, {}, 'RECEIPT_STORAGE_FAILED'),
            )
          : Promise.resolve(uploaded),
    });
    const scheduled = await waitStatus(
      target,
      'DOWNLOADED',
      (row) => row.storage_attempts === 1 && row.lease_owner === null,
    );
    expect(scheduled).toMatchObject({
      last_error_category: 'BACKEND_UPLOAD',
      last_error_code: 'HTTP_502',
    });
    expect((scheduled.next_attempt_at as Date).getTime()).toBeGreaterThan(
      Date.now() + 20_000,
    );
    expect((await readOutbox(target.id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_ATTACH_UNKNOWN',
    ]);
    // Make the retry due instead of waiting the 30 s backoff.
    await pool.query(
      'UPDATE receipt_media SET next_attempt_at = now() WHERE id = $1',
      [target.id],
    );
    await waitStatus(target, 'ATTACHED');
    expect(h.uploadReceipt).toHaveBeenCalledTimes(2);
    expect(h.uploadReceipt.mock.calls.map((c) => c[3])).toEqual([
      target.mediaId,
      target.mediaId,
    ]);
    expect(h.meta).toHaveBeenCalledTimes(2);
    expect((await readOutbox(target.id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_ATTACH_UNKNOWN',
      'RECEIPT_ATTACHED_PENDING',
    ]);
  });

  it('commits SALE_ALREADY_PAID as a definite refusal with its message', async () => {
    const target = media(3, 'paid');
    await seed(target);
    boot({
      owner: 'r2.paid',
      upload: () =>
        Promise.reject(
          new ChatbotApiError('paid', 409, {}, 'SALE_ALREADY_PAID'),
        ),
    });
    const row = await waitStatus(target, 'FAILED');
    expect(row).toMatchObject({
      failure_stage: 'ATTACH_DEFINITE',
      attach_http_status: 409,
      last_error_code: 'SALE_ALREADY_PAID',
    });
    const intents = await readOutbox(target.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      template_key: 'RECEIPT_SALE_ALREADY_PAID',
      template_args: { folio: 'F-0042' },
    });
  });

  it('never uploads an image that is not a receipt', async () => {
    const target = media(4, 'notreceipt');
    await seed(target);
    const h = boot({
      owner: 'r2.notreceipt',
      extraction: { kind: 'not_receipt' },
    });
    const row = await waitStatus(target, 'FAILED');
    expect(row.failure_stage).toBe('NOT_A_RECEIPT');
    expect(h.uploadReceipt).not.toHaveBeenCalled();
    expect((await readOutbox(target.id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_NOT_A_RECEIPT',
    ]);
  });

  it('refuses an encrypted PDF and asks for a screenshot', async () => {
    const target = media(5, 'encrypted');
    await seed(target, 'application/pdf');
    const h = boot({
      owner: 'r2.encrypted',
      mime: 'application/pdf',
      bytes: ENCRYPTED_PDF,
    });
    const row = await waitStatus(target, 'FAILED');
    expect(row.failure_stage).toBe('PDF_ENCRYPTED');
    expect(h.extract).not.toHaveBeenCalled();
    expect(h.uploadReceipt).not.toHaveBeenCalled();
    expect((await readOutbox(target.id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_PDF_ENCRYPTED',
    ]);
  });

  it('uploads without extracted data when the extraction is unavailable', async () => {
    const target = media(6, 'unavailable');
    await seed(target);
    const h = boot({
      owner: 'r2.unavailable',
      extraction: { kind: 'unavailable', reason: 'timeout' },
    });
    await waitStatus(target, 'ATTACHED');
    expect(h.uploadReceipt.mock.calls[0][2]).toEqual({});
    expect((await readOutbox(target.id))[0]).toMatchObject({
      template_key: 'RECEIPT_ATTACHED_PENDING',
      template_args: { folio: 'F-0042' },
    });
  });

  it('keeps the transient Meta retry on the first download', async () => {
    const target = media(7, 'meta');
    await seed(target);
    let call = 0;
    const h = boot({
      owner: 'r2.meta',
      meta: () =>
        ++call === 1
          ? Promise.reject(new MetaMediaError('META_TRANSPORT', 'TIMEOUT'))
          : Promise.resolve(fakeFile('image/jpeg')),
    });
    await waitStatus(target, 'ATTACHED');
    expect(h.meta).toHaveBeenCalledTimes(2);
    expect((await readRow(target.id)).meta_attempts).toBe(2);
  });
});
