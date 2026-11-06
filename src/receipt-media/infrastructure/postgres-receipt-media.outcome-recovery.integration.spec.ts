import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { MAX_UPLOAD_ATTEMPTS } from '../domain/receipt-media-store.port';
import type { LeaseFenceInput } from '../domain/receipt-media-store.port';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';

/** Aggregate terminal-family evidence over the kept pipeline (R3): real
 * `PostgresReceiptMediaStore` + real migrations over one Testcontainers
 * PostgreSQL 16 instance. The five durable terminal families of the backend
 * upload pipeline — attached, definite refusal, unknown outcome, Meta
 * exhaustion and refused media — coexist with exactly five customer intents
 * and none of them is claimable or committable again after one adapter
 * recreation. Store-level only; gated by RUN_DOCKER_TESTS=1. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const SALE = '11111111-1111-4111-8111-111111111111';
const OWNER = 'worker.agg';

ddescribe(
  'receipt-media terminal families after adapter recreation (R3)',
  () => {
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

    /** Admits and claims one receipt; returns its live lease fence. */
    const claimed = async (label: string): Promise<LeaseFenceInput> => {
      const id = randomUUID();
      await store.admit({
        id,
        webhookMessageId: `wamid.agg.${label}`,
        providerMediaId: `media.agg.${label}`,
        senderId: `sender.agg.${label}`,
        capturedSaleId: SALE,
        declaredMimeType: 'image/jpeg',
      });
      const [row] = await store.claimBatch(1, OWNER);
      expect(row.id).toBe(id);
      return { id, owner: OWNER, expectedVersion: row.version };
    };

    /** Claims, downloads and starts one upload attempt. */
    const uploading = async (label: string): Promise<LeaseFenceInput> => {
      const fence = await claimed(label);
      const meta = await store.startMetaAttempt(fence);
      await store.commitDownload({
        ...fence,
        expectedVersion: meta!.version,
        responseMimeType: 'image/jpeg',
        detectedMimeType: 'image/jpeg',
        byteCount: 1024,
        contentSha256: createHash('sha256').update(label).digest(),
      });
      const start = await store.startStorageAttempt({
        ...fence,
        expectedVersion: String(BigInt(meta!.version) + 1n),
      });
      return { ...fence, expectedVersion: start!.version };
    };

    it('keeps five terminal families with exactly five intents across adapter recreation', async () => {
      const attached = await uploading('attached');
      await store.commitUploadSuccess({
        ...attached,
        backendReceiptId: randomUUID(),
        templateArgs: { folio: 'F-1' },
      });
      const definite = await uploading('definite');
      await store.commitUploadDefiniteFailure({
        ...definite,
        httpStatus: 409,
        errorCode: 'SALE_ALREADY_PAID',
        templateKey: 'RECEIPT_SALE_ALREADY_PAID',
        templateArgs: {},
      });
      const unknown = await uploading('unknown');
      await pool.query(
        'UPDATE receipt_media SET storage_attempts = $2 WHERE id = $1',
        [unknown.id, MAX_UPLOAD_ATTEMPTS],
      );
      await store.commitUploadUnknown({
        ...unknown,
        httpStatus: null,
        transportCode: 'TRANSPORT_FAILURE',
      });
      const meta = await claimed('meta');
      await pool.query(
        'UPDATE receipt_media SET meta_attempts = 3 WHERE id = $1',
        [meta.id],
      );
      await store.commitMetaFailureDisposition({
        ...meta,
        category: 'META_TRANSPORT',
        code: 'META_EXHAUSTED',
      });
      const rejected = await uploading('rejected');
      await store.commitRejectedMedia({ ...rejected, reason: 'NOT_A_RECEIPT' });

      const states = async () =>
        (
          await pool.query<{ status: string; failure_stage: string | null }>(
            'SELECT status, failure_stage FROM receipt_media ORDER BY status, failure_stage',
          )
        ).rows;
      const intents = async () =>
        (
          await pool.query<{ template_key: string }>(
            'SELECT template_key FROM receipt_media_outbox ORDER BY template_key',
          )
        ).rows.map((r) => r.template_key);
      const expectedStates = [
        { status: 'ATTACHED', failure_stage: null },
        { status: 'ATTACH_OUTCOME_UNKNOWN', failure_stage: null },
        { status: 'FAILED', failure_stage: 'ATTACH_DEFINITE' },
        { status: 'FAILED', failure_stage: 'META_EXHAUSTED_PRE_STORAGE' },
        { status: 'FAILED', failure_stage: 'NOT_A_RECEIPT' },
      ];
      const expectedIntents = [
        'RECEIPT_ATTACHED_PENDING',
        'RECEIPT_ATTACH_UNKNOWN',
        'RECEIPT_NOT_A_RECEIPT',
        'RECEIPT_SALE_ALREADY_PAID',
        'RECEIPT_UNAVAILABLE_LATER',
      ];
      expect(await states()).toEqual(expectedStates);
      expect(await intents()).toEqual(expectedIntents);

      // A fresh adapter over the same database finds nothing to claim and
      // every stale command is fenced without a new state or intent.
      const recreated = new PostgresReceiptMediaStore(pool);
      await pool.query(
        "UPDATE receipt_media SET lease_expires_at = now() - interval '1s' WHERE lease_owner IS NOT NULL",
      );
      expect(await recreated.claimBatch(10, 'worker.recreated')).toEqual([]);
      await expect(
        recreated.commitUploadSuccess({
          ...attached,
          backendReceiptId: randomUUID(),
          templateArgs: {},
        }),
      ).resolves.toEqual({ kind: 'fenced' });
      await expect(
        recreated.commitRejectedMedia({ ...rejected, reason: 'NOT_A_RECEIPT' }),
      ).resolves.toEqual({ kind: 'fenced' });
      expect(await states()).toEqual(expectedStates);
      expect(await intents()).toEqual(expectedIntents);
    });
  },
);
