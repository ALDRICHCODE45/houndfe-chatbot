/**
 * R2 backend upload commits against a real migrated PostgreSQL
 * (Testcontainers; gated by RUN_DOCKER_TESTS=1 like the other suites).
 */
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { MAX_UPLOAD_ATTEMPTS } from '../domain/receipt-media-store.port';
import type { ReceiptMimeType } from '../domain/receipt-media.types';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const OWNER = 'receipt-media:test';
const SALE = '22222222-2222-4222-8222-222222222222';
const BACKEND_RECEIPT = '33333333-3333-4333-8333-333333333333';

ddescribe('R2 backend upload commits (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptMediaStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    store = new PostgresReceiptMediaStore(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(() => pool.query('TRUNCATE receipt_media_outbox, receipt_media'));

  /** Admits, claims and downloads one receipt; returns its upload fence. */
  const downloaded = async (
    mime: ReceiptMimeType = 'image/jpeg',
    declaredAmountCents: number | null = null,
  ) => {
    const sender = `521${Math.floor(Math.random() * 1e9)}`;
    const id = randomUUID();
    await store.admit({
      id,
      webhookMessageId: `wamid.${id}`,
      providerMediaId: `media-${id}`,
      senderId: sender,
      capturedSaleId: SALE,
      declaredMimeType: mime,
      declaredAmountCents,
    });
    const [claimed] = await store.claimBatch(1, OWNER);
    const meta = await store.startMetaAttempt({
      id,
      owner: OWNER,
      expectedVersion: claimed.version,
    });
    const committed = await store.commitDownload({
      id,
      owner: OWNER,
      expectedVersion: meta!.version,
      responseMimeType: mime,
      detectedMimeType: mime,
      byteCount: 1234,
      contentSha256: createHash('sha256').update(id).digest(),
    });
    expect(committed.kind).toBe('committed');
    const start = await store.startStorageAttempt({
      id,
      owner: OWNER,
      expectedVersion: String(BigInt(meta!.version) + 1n),
    });
    return {
      id,
      sender,
      fence: { id, owner: OWNER, expectedVersion: start!.version },
    };
  };

  const intents = async (id: string) =>
    (
      await pool.query<{ template_key: string; template_args: unknown }>(
        'SELECT template_key, template_args FROM receipt_media_outbox WHERE receipt_media_id = $1 ORDER BY created_at',
        [id],
      )
    ).rows;

  it('commits a successful PDF upload with the received intent and its args', async () => {
    const { id, sender, fence } = await downloaded('application/pdf');
    const args = {
      folio: 'F-12',
      extractedAmountCents: 9900,
      totalCents: 10000,
    };
    const out = await store.commitUploadSuccess({
      ...fence,
      backendReceiptId: BACKEND_RECEIPT,
      templateArgs: args,
    });
    expect(out).toMatchObject({
      kind: 'committed',
      receipt: {
        status: 'ATTACHED',
        backendReceiptId: BACKEND_RECEIPT,
        backendReceiptStatus: 'PENDING',
        detectedMimeType: 'application/pdf',
        declaredAmountCents: null,
      },
      intent: {
        templateKey: 'RECEIPT_ATTACHED_PENDING',
        recipientId: sender,
        templateArgs: args,
      },
    });
    // A replayed (stale) fence never commits twice.
    await expect(
      store.commitUploadSuccess({
        ...fence,
        backendReceiptId: BACKEND_RECEIPT,
        templateArgs: args,
      }),
    ).resolves.toEqual({ kind: 'fenced' });
    expect(await intents(id)).toHaveLength(1);
  });

  it.each([
    [409, 'SALE_ALREADY_PAID', 'RECEIPT_SALE_ALREADY_PAID'],
    [413, 'RECEIPT_FILE_TOO_LARGE', 'RECEIPT_UNSUPPORTED_FORMAT'],
    [415, 'RECEIPT_FILE_TYPE_NOT_ALLOWED', 'RECEIPT_UNSUPPORTED_FORMAT'],
  ] as const)(
    'commits a definite %i %s refusal',
    async (httpStatus, errorCode, templateKey) => {
      const { id, fence } = await downloaded();
      const out = await store.commitUploadDefiniteFailure({
        ...fence,
        httpStatus,
        errorCode,
        templateKey,
        templateArgs: { folio: 'F-12' },
      });
      expect(out).toMatchObject({
        kind: 'committed',
        receipt: {
          status: 'FAILED',
          failureStage: 'ATTACH_DEFINITE',
          attachHttpStatus: httpStatus,
          lastErrorCode: errorCode,
        },
        intent: { templateKey },
      });
      expect(await intents(id)).toHaveLength(1);
    },
  );

  it('retries an unknown outcome with backoff, sends the registering message once, and terminalizes at the cap', async () => {
    const { id, fence: first } = await downloaded();
    let fence = first;
    for (let attempt = 1; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      const out = await store.commitUploadUnknown({
        ...fence,
        httpStatus: 502,
        transportCode: null,
      });
      expect(out).toMatchObject({
        kind: 'retry-scheduled',
        attempt,
        receipt: { status: 'DOWNLOADED', leaseOwner: null },
      });
      if (out.kind === 'fenced') throw new Error('fenced');
      expect(out.intent === null).toBe(attempt !== 1);
      expect(+out.receipt.nextAttemptAt).toBeGreaterThan(Date.now());
      // Make the row due again, then reclaim it for the next attempt.
      await pool.query(
        'UPDATE receipt_media SET next_attempt_at = now() WHERE id = $1',
        [id],
      );
      const [claimed] = await store.claimBatch(1, OWNER);
      const start = await store.startStorageAttempt({
        id,
        owner: OWNER,
        expectedVersion: claimed.version,
      });
      expect(start?.attempt).toBe(attempt + 1);
      fence = { id, owner: OWNER, expectedVersion: start!.version };
    }
    await expect(store.startStorageAttempt({ ...fence })).resolves.toBeNull();
    const terminal = await store.commitUploadUnknown({
      ...fence,
      httpStatus: null,
      transportCode: 'TRANSPORT_FAILURE',
    });
    expect(terminal).toMatchObject({
      kind: 'committed',
      attempt: MAX_UPLOAD_ATTEMPTS,
      receipt: {
        status: 'ATTACH_OUTCOME_UNKNOWN',
        attachTransportCode: 'TRANSPORT_FAILURE',
      },
      intent: null,
    });
    expect((await intents(id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_ATTACH_UNKNOWN',
    ]);
  });

  it.each([429, 401, 403])(
    'retries HTTP %i as an unknown outcome and terminalizes it at the cap',
    async (httpStatus) => {
      const { id, fence } = await downloaded();
      await expect(
        store.commitUploadDefiniteFailure({
          ...fence,
          httpStatus,
          errorCode: null,
          templateKey: 'RECEIPT_ATTACH_DEFINITE_FAILURE',
          templateArgs: {},
        }),
      ).resolves.toEqual({ kind: 'fenced' });
      await expect(
        store.commitUploadUnknown({
          ...fence,
          httpStatus,
          transportCode: null,
        }),
      ).resolves.toMatchObject({
        kind: 'retry-scheduled',
        receipt: { status: 'DOWNLOADED', lastErrorCode: `HTTP_${httpStatus}` },
        intent: { templateKey: 'RECEIPT_ATTACH_UNKNOWN' },
      });
      // The schema admits the status as unknown evidence at the cap.
      await pool.query(
        `UPDATE receipt_media SET next_attempt_at = now(),
           storage_attempts = $2 - 1 WHERE id = $1`,
        [id, MAX_UPLOAD_ATTEMPTS],
      );
      const [claimed] = await store.claimBatch(1, OWNER);
      const start = await store.startStorageAttempt({
        id,
        owner: OWNER,
        expectedVersion: claimed.version,
      });
      await expect(
        store.commitUploadUnknown({
          id,
          owner: OWNER,
          expectedVersion: start!.version,
          httpStatus,
          transportCode: null,
        }),
      ).resolves.toMatchObject({
        kind: 'committed',
        receipt: {
          status: 'ATTACH_OUTCOME_UNKNOWN',
          attachHttpStatus: httpStatus,
        },
        intent: null,
      });
    },
  );

  it('keeps the first attempt upload fields across later attempt starts', async () => {
    const { id, fence } = await downloaded();
    const first = {
      declared: { amountCents: 99900 },
      extracted: { amountCents: 140000, bank: 'BBVA', confidence: 0.6 },
    };
    // `downloaded()` started attempt 1 without fields; record them on a
    // fresh row through the real first-pass start instead.
    await pool.query(
      'UPDATE receipt_media SET storage_attempts = 0, version = version + 1 WHERE id = $1',
      [id],
    );
    const v = String(BigInt(fence.expectedVersion) + 1n);
    const start = await store.startStorageAttempt({
      id,
      owner: OWNER,
      expectedVersion: v,
      uploadFields: first,
    });
    expect(start?.attempt).toBe(1);
    await store.commitUploadUnknown({
      id,
      owner: OWNER,
      expectedVersion: start!.version,
      httpStatus: 503,
      transportCode: null,
    });
    await pool.query(
      'UPDATE receipt_media SET next_attempt_at = now() WHERE id = $1',
      [id],
    );
    const [claimed] = await store.claimBatch(1, OWNER);
    expect(claimed.uploadFields).toEqual(first);
    // A later start (even with other fields) never replaces them.
    const retry = await store.startStorageAttempt({
      id,
      owner: OWNER,
      expectedVersion: claimed.version,
      uploadFields: { extracted: { amountCents: 1, confidence: 0.3 } },
    });
    expect(retry?.attempt).toBe(2);
    const { rows } = await pool.query<{ upload_fields: unknown }>(
      'SELECT upload_fields FROM receipt_media WHERE id = $1',
      [id],
    );
    expect(rows[0].upload_fields).toEqual(first);
  });

  it('commits a success after unknown retries', async () => {
    const { id, fence } = await downloaded();
    await store.commitUploadUnknown({
      ...fence,
      httpStatus: null,
      transportCode: 'TRANSPORT_FAILURE',
    });
    await pool.query(
      'UPDATE receipt_media SET next_attempt_at = now() WHERE id = $1',
      [id],
    );
    const [claimed] = await store.claimBatch(1, OWNER);
    const start = await store.startStorageAttempt({
      id,
      owner: OWNER,
      expectedVersion: claimed.version,
    });
    const out = await store.commitUploadSuccess({
      id,
      owner: OWNER,
      expectedVersion: start!.version,
      backendReceiptId: BACKEND_RECEIPT,
      templateArgs: {},
    });
    expect(out).toMatchObject({
      kind: 'committed',
      receipt: { status: 'ATTACHED', lastErrorCode: null },
    });
    expect((await intents(id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_ATTACH_UNKNOWN',
      'RECEIPT_ATTACHED_PENDING',
    ]);
  });

  it.each([
    [
      'NOT_A_RECEIPT',
      'application/pdf',
      'RECEIPT_NOT_A_RECEIPT',
      { mediaKind: 'pdf' },
    ],
    ['NOT_A_RECEIPT', 'image/jpeg', 'RECEIPT_NOT_A_RECEIPT', {}],
    ['PDF_ENCRYPTED', 'application/pdf', 'RECEIPT_PDF_ENCRYPTED', {}],
  ] as const)(
    'refuses %s %s media without an upload',
    async (reason, mime, key, args) => {
      const { id, fence } = await downloaded(mime);
      const out = await store.commitRejectedMedia({ ...fence, reason });
      expect(out).toMatchObject({
        kind: 'committed',
        receipt: {
          status: 'FAILED',
          failureStage: reason,
          backendReceiptId: null,
        },
        intent: { templateKey: key, templateArgs: args },
      });
      expect(await intents(id)).toHaveLength(1);
    },
  );

  it('records an accepted upload with an invalid receipt id as an unknown outcome', async () => {
    const { id, fence } = await downloaded();
    const out = await store.commitUploadSuccess({
      ...fence,
      backendReceiptId: 'not-a-uuid',
      templateArgs: { folio: 'F-12' },
    });
    expect(out).toMatchObject({
      kind: 'committed',
      receipt: {
        status: 'ATTACH_OUTCOME_UNKNOWN',
        backendReceiptId: null,
        attachHttpStatus: null,
        attachTransportCode: 'RECEIPT_ID_INVALID',
        leaseOwner: OWNER,
      },
      intent: { templateKey: 'RECEIPT_ATTACH_UNKNOWN', templateArgs: {} },
    });
    // Terminal: never reclaimed, and the stale fence cannot commit again.
    await pool.query(
      'UPDATE receipt_media SET next_attempt_at = now() WHERE id = $1',
      [id],
    );
    await expect(store.claimBatch(1, OWNER)).resolves.toEqual([]);
    await expect(
      store.commitUploadSuccess({
        ...fence,
        backendReceiptId: 'not-a-uuid',
        templateArgs: {},
      }),
    ).resolves.toEqual({ kind: 'fenced' });
    expect((await intents(id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_ATTACH_UNKNOWN',
    ]);
  });

  it('sends the registering message once when an earlier unknown outcome sent it', async () => {
    const { id, fence } = await downloaded();
    const retry = await store.commitUploadUnknown({
      ...fence,
      httpStatus: 503,
      transportCode: null,
    });
    expect(retry.kind).toBe('retry-scheduled');
    await pool.query(
      'UPDATE receipt_media SET next_attempt_at = now() WHERE id = $1',
      [id],
    );
    const [claimed] = await store.claimBatch(1, OWNER);
    const start = await store.startStorageAttempt({
      id,
      owner: OWNER,
      expectedVersion: claimed.version,
    });
    await expect(
      store.commitUploadSuccess({
        id,
        owner: OWNER,
        expectedVersion: start!.version,
        backendReceiptId: 42 as unknown as string,
        templateArgs: {},
      }),
    ).resolves.toMatchObject({
      kind: 'committed',
      receipt: { status: 'ATTACH_OUTCOME_UNKNOWN' },
      intent: null,
    });
    expect((await intents(id)).map((r) => r.template_key)).toEqual([
      'RECEIPT_ATTACH_UNKNOWN',
    ]);
  });

  it('fences a malformed command without touching the row', async () => {
    const { fence } = await downloaded();
    await expect(
      store.commitUploadSuccess({
        ...fence,
        expectedVersion: 'x',
        backendReceiptId: BACKEND_RECEIPT,
        templateArgs: {},
      }),
    ).resolves.toEqual({ kind: 'fenced' });
    await expect(
      store.commitUploadUnknown({
        ...fence,
        httpStatus: 201,
        transportCode: null,
      }),
    ).resolves.toEqual({ kind: 'fenced' });
  });
});
