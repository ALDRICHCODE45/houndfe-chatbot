import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { AppConfigModule } from '../../config/config.module';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
import { PG_POOL } from '../../database/postgres-pool.provider';
import { CapabilityService } from '../application/capability.service';
import { ReceiptCleanupService } from '../application/receipt-cleanup.service';
import {
  RECEIPT_CAPABILITY_LOOKUP,
  ReceiptCapabilityAuthorizerService,
} from '../application/receipt-capability-authorizer.service';
import {
  OBJECT_STORAGE_PORT,
  ObjectStorageError,
  type GetObjectInput,
  type GetObjectResult,
  type HeadObjectInput,
  type HeadObjectResult,
} from '../domain/object-storage.port';
import type { ReceiptMimeType } from '../domain/receipt-media.types';
import { PostgresReceiptMediaStore } from '../infrastructure/postgres-receipt-media.store';
import { ReceiptMediaModule } from '../receipt-media.module';
import {
  CAPABILITY_RETRY_AFTER_SECONDS,
  ReceiptMediaAccessController,
} from './receipt-media-access.controller';

/**
 * ODD-5B tests-only DB-backed capability-access HTTP evidence.
 *
 * This slice adds NO production change: it composes the REAL HTTP transport,
 * `ReceiptMediaAccessController`, `ReceiptCapabilityAuthorizerService`,
 * `CapabilityService`, and `PostgresReceiptMediaStore` over one Testcontainers
 * PostgreSQL 16 instance with the production migrations applied. Only the
 * object-storage port seam is a deterministic fake (no MinIO/S3/network).
 *
 * Product contract under test: revocation is DB-only. Removing a historical
 * HMAC key does NOT invalidate an already-issued token because authorization
 * re-hashes the raw token and compares it to the durable stored hash; removing
 * the key only prevents reconstruction/re-emission. `revokeCapability` makes
 * the URL deny indistinguishably.
 *
 * Protocol: baseline-first tests-only evidence over already-committed behavior.
 * Pre-write baselines were recorded before any write, the first valid run is
 * expected GREEN, and a valid behavioral failure would be a real production
 * defect (the slice must then stop rather than edit production). No RED is
 * fabricated and no assertion is weakened to reach GREEN.
 *
 * Gated by RUN_DOCKER_TESTS=1 like the other Testcontainers suites. The
 * enabled-mode harness deliberately does NOT import `ReceiptMediaModule` (that
 * would start the notification/ingestion/cleanup lifecycles); it composes only
 * the access controller with the real authorizer/capability/store. The real
 * module is imported ONLY for disabled-mode composition, where every lifecycle
 * is inert.
 */

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
/** Exact pre-suite environment so teardown restores it (or removes it when it
 *  was initially absent) instead of blindly deleting it. */
const PRIOR_DATABASE_URL = process.env.DATABASE_URL;

const KEY_1 = Buffer.alloc(32, 0x11);
const KEY_2 = Buffer.alloc(32, 0x22);
const KEYRING_1 = new Map<string, Uint8Array>([['1', KEY_1]]);
const KEYRING_12 = new Map<string, Uint8Array>([
  ['1', KEY_1],
  ['2', KEY_2],
]);
const KEYRING_2 = new Map<string, Uint8Array>([['2', KEY_2]]);

const RECEIPT_A = '00000000-0000-4000-8000-0000000000a1';
const RECEIPT_B = '00000000-0000-4000-8000-0000000000b2';
const OBJECT_A = 'receipts/00000000-0000-4000-8000-0000000000c3';
const OBJECT_B = 'receipts/00000000-0000-4000-8000-0000000000c4';
const SALE = '00000000-0000-4000-8000-0000000000d4';
const ATTACH_ATTEMPT = '00000000-0000-4000-8000-0000000000e5';
const BACKEND_RECEIPT = '00000000-0000-4000-8000-0000000000f6';
const ATTACHED_AMOUNT = 15000;
const T0 = new Date('2025-01-01T00:00:00Z');
const ETAG = 'etag-access';
const VERSION_ID = 'version-access';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RETRY = String(CAPABILITY_RETRY_AFTER_SECONDS);
const CONTENT_SHA256 = createHash('sha256').update(JPEG).digest();

const SAFE_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  'cross-origin-resource-policy': 'cross-origin',
};

/** The complete fixed safe-header set every access response must carry. */
const SAFE_HEADER_SHAPE = {
  csp: SAFE_HEADERS['content-security-policy'],
  nosniff: SAFE_HEADERS['x-content-type-options'],
  referrer: SAFE_HEADERS['referrer-policy'],
  cacheControl: SAFE_HEADERS['cache-control'],
  corp: SAFE_HEADERS['cross-origin-resource-policy'],
};

/** Independently anchored generic-denial shape: a fixed literal, never a
 *  projection of another response. */
const ANCHORED_404_SHAPE = {
  ...SAFE_HEADER_SHAPE,
  status: 404,
  text: '',
  retryAfter: null,
  contentType: null,
  contentLength: '0',
};

/** Independently anchored safe-503 shape carrying the fixed Retry-After. */
const ANCHORED_503_SHAPE = {
  ...SAFE_HEADER_SHAPE,
  status: 503,
  text: '',
  retryAfter: RETRY,
  contentType: null,
  contentLength: '0',
};

/** Token issued under the version-1 key; the durable row keeps this evidence
 * even after the key is removed from a later keyring. */
const ISSUED_A1 = new CapabilityService(KEYRING_1, '1').issue(RECEIPT_A);
const ISSUED_B1 = new CapabilityService(KEYRING_1, '1').issue(RECEIPT_B);
const UNKNOWN_TOKEN = ISSUED_B1.token;

const INSERT_STORED_SQL = `INSERT INTO receipt_media (
  id, webhook_message_id, provider_media_id, sender_id, captured_sale_id,
  object_key, status, version, downloaded_at, response_mime_type,
  detected_mime_type, byte_count, content_sha256, stored_at, object_etag,
  capability_token_hash, capability_key_version, capability_key_version_text,
  capability_issued_at
) VALUES (
  $1, $2, $3, $4, $5, $6, 'STORED', '3', $7, $8, $8, $9, $10, $7, $11,
  $12, $13, $14, $7
)`;

/** One valid ATTACHED row satisfying every migration CHECK: accepted-object
 *  and download evidence, positive amount, one complete attach request. */
const INSERT_ATTACHED_SQL = `INSERT INTO receipt_media (
  id, webhook_message_id, provider_media_id, sender_id, captured_sale_id,
  object_key, status, version, downloaded_at, response_mime_type,
  detected_mime_type, byte_count, content_sha256, stored_at, object_etag, object_version_id,
  capability_token_hash, capability_key_version, capability_key_version_text,
  capability_issued_at, declared_amount_cents, attach_started_at,
  attach_attempts, attach_attempt_id, attach_request_started_at, attached_at,
  backend_receipt_id, backend_receipt_status
) VALUES (
  $1, $2, $3, $4, $5, $6, 'ATTACHED', '5', $7, $8, $8, $9, $10, $7, $11, $18,
  $12, $13, $14, $7, $15, $7, 1, $16, $7, $7, $17, 'PENDING'
)`;

interface FakeStorage {
  head: jest.Mock<Promise<HeadObjectResult>, [HeadObjectInput]>;
  getStream: jest.Mock<Promise<GetObjectResult>, [GetObjectInput]>;
  put: jest.Mock;
  deleteTechnicalObject: jest.Mock;
}

interface AccessHarness {
  app: INestApplication;
  capability: CapabilityService;
  store: PostgresReceiptMediaStore;
  storage: FakeStorage;
  close: () => Promise<void>;
}

const makeStorage = (
  bytes: Buffer,
  mimeType: ReceiptMimeType = 'image/jpeg',
): FakeStorage => {
  const head = jest.fn<Promise<HeadObjectResult>, [HeadObjectInput]>();
  head.mockResolvedValue({
    byteCount: bytes.length,
    mimeType,
    etag: ETAG,
    versionId: VERSION_ID,
  });
  const getStream = jest.fn<Promise<GetObjectResult>, [GetObjectInput]>();
  // A fresh stream per call: one app instance may serve more than one GET.
  getStream.mockImplementation(() =>
    Promise.resolve({
      stream: Readable.from([bytes]),
      byteCount: bytes.length,
      mimeType,
      etag: ETAG,
      versionId: VERSION_ID,
    }),
  );
  const put = jest.fn();
  put.mockRejectedValue(new Error('unexpected storage call'));
  const deleteTechnicalObject = jest.fn();
  deleteTechnicalObject.mockRejectedValue(new Error('unexpected storage call'));
  return { head, getStream, put, deleteTechnicalObject };
};

const failingStorage = (error: Error): FakeStorage => {
  const head = jest.fn<Promise<HeadObjectResult>, [HeadObjectInput]>();
  head.mockRejectedValue(error);
  const getStream = jest.fn<Promise<GetObjectResult>, [GetObjectInput]>();
  getStream.mockRejectedValue(error);
  const put = jest.fn();
  put.mockRejectedValue(error);
  const deleteTechnicalObject = jest.fn();
  deleteTechnicalObject.mockRejectedValue(error);
  return { head, getStream, put, deleteTechnicalObject };
};

/** Closed response projection used to prove indistinguishable failures. */
const responseShape = (res: request.Response) => ({
  status: res.status,
  text: res.text ?? '',
  retryAfter: res.headers['retry-after'] ?? null,
  contentType: res.headers['content-type'] ?? null,
  contentLength: res.headers['content-length'] ?? null,
  csp: res.headers['content-security-policy'] ?? null,
  nosniff: res.headers['x-content-type-options'] ?? null,
  referrer: res.headers['referrer-policy'] ?? null,
  cacheControl: res.headers['cache-control'] ?? null,
  corp: res.headers['cross-origin-resource-policy'] ?? null,
});

/** Exact request/provider secrets relevant to one response surface. */
interface LeakageCheck {
  /** Exact raw request token(s) used to obtain this response. */
  tokens?: readonly string[];
  /** Exact caller-supplied/provider details for this response. */
  sensitive?: readonly string[];
}

/** No request token, private object key, stored ETag/version, or
 *  caller-supplied sensitive value may appear on any response surface. Every
 *  response header plus the body/text is inspected; the private object key,
 *  stored ETag, and stored version id are always rejected regardless of the
 *  caller-supplied token(s)/details. */
const expectNoSecretLeakage = (
  res: request.Response,
  { tokens = [], sensitive = [] }: LeakageCheck = {},
): void => {
  const haystack = [
    JSON.stringify(res.headers),
    res.text ?? '',
    Buffer.isBuffer(res.body) ? res.body.toString('latin1') : '',
  ]
    .join('\n')
    .toLowerCase();
  expect(res.headers.etag).toBeUndefined();
  for (const value of [OBJECT_A, ETAG, VERSION_ID, ...tokens, ...sensitive]) {
    expect(value.length).toBeGreaterThan(0);
    expect(haystack).not.toContain(value.toLowerCase());
  }
};

/** Minimal valid environment for the disabled-mode module import; mirrors the
 * established composition-spec environment. */
const BASE_ENV: Record<string, string> = {
  META_VERIFY_TOKEN: 't',
  META_APP_SECRET: 's',
  META_ACCESS_TOKEN: 'a',
  META_PHONE_NUMBER_ID: '1',
  CHATBOT_API_BASE_URL: 'https://api.example.com',
  SERVICE_KEY: 'svc_x',
  CHATBOT_API_BRANCH_ID: 'b',
  CHATBOT_API_CASHIER_USER_ID: '00000000-0000-4000-8000-000000000001',
  OPENAI_API_KEY: 'g',
  LLM_MODEL: 'm',
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  OPS_CHANNEL_PHONE: '5215500000000',
};

/** Receipt-specific keys that must be absent for a valid disabled boot. */
const RECEIPT_SPECIFIC_KEYS = [
  'RECEIPT_MEDIA_ENABLED',
  'RECEIPT_MEDIA_MAX_BYTES',
  'META_MEDIA_ALLOWED_HOSTS',
  'META_MEDIA_METADATA_TIMEOUT_MS',
  'META_MEDIA_DOWNLOAD_TIMEOUT_MS',
  'RECEIPT_STORAGE_ENDPOINT',
  'RECEIPT_STORAGE_REGION',
  'RECEIPT_STORAGE_BUCKET',
  'RECEIPT_STORAGE_ACCESS_KEY_ID',
  'RECEIPT_STORAGE_SECRET_ACCESS_KEY',
  'RECEIPT_MEDIA_PUBLIC_BASE_URL',
  'RECEIPT_MEDIA_WORKER_CONCURRENCY',
  'RECEIPT_MEDIA_WORKER_LEASE_MS',
  'RECEIPT_MEDIA_WORKER_POLL_MS',
  'RECEIPT_MEDIA_INGESTION_ENABLED',
  'CHATBOT_API_ATTACH_TIMEOUT_MS',
  'RECEIPT_CAPABILITY_KEYS',
  'RECEIPT_CAPABILITY_ACTIVE_VERSION',
];

ddescribe(
  'ReceiptMediaAccessController DB-backed capability access (ODD-5B, Testcontainers)',
  () => {
    jest.setTimeout(120_000);

    let container: StartedPostgreSqlContainer;
    let pool: Pool;

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
    });

    afterAll(async () => {
      // Attempt BOTH shutdowns even when one fails, then restore the exact
      // prior environment, then surface any cleanup failure.
      const failures: unknown[] = [];
      try {
        if (pool) await pool.end();
      } catch (error) {
        failures.push(error);
      }
      try {
        if (container) await container.stop();
      } catch (error) {
        failures.push(error);
      }
      if (PRIOR_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = PRIOR_DATABASE_URL;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'receipt-media-access integration cleanup failed',
        );
      }
    });

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox, receipt_media',
      );
    });

    /** Seeds one valid STORED receipt carrying the exact capability evidence. */
    const seedStored = async (
      id: string,
      objectKey: string,
      tokenHash: Buffer,
      keyVersion: string,
    ): Promise<void> => {
      await pool.query(INSERT_STORED_SQL, [
        id,
        `wamid.${id}`,
        `media.${id}`,
        `sender.${id}`,
        SALE,
        objectKey,
        T0,
        'image/jpeg',
        JPEG.length,
        CONTENT_SHA256,
        ETAG,
        tokenHash,
        Number(keyVersion),
        keyVersion,
      ]);
    };

    /** Seeds one valid ATTACHED receipt carrying the exact capability evidence. */
    const seedAttached = async (
      id: string,
      objectKey: string,
      tokenHash: Buffer,
      keyVersion: string,
    ): Promise<void> => {
      await pool.query(INSERT_ATTACHED_SQL, [
        id,
        `wamid.${id}`,
        `media.${id}`,
        `sender.${id}`,
        SALE,
        objectKey,
        T0,
        'image/jpeg',
        JPEG.length,
        CONTENT_SHA256,
        ETAG,
        tokenHash,
        Number(keyVersion),
        keyVersion,
        ATTACHED_AMOUNT,
        ATTACH_ATTEMPT,
        BACKEND_RECEIPT,
        VERSION_ID,
      ]);
    };

    /** Exact durable receipt row, used to prove ATTACHED evidence is stable. */
    const rowOf = async (id: string): Promise<Record<string, unknown>> =>
      (
        await pool.query<Record<string, unknown>>(
          'SELECT * FROM receipt_media WHERE id = $1',
          [id],
        )
      ).rows[0];

    /** Real HTTP Nest app over the real access controller, real authorizer,
     * real capability service, real Postgres store, fake storage seam. */
    const buildAccessApp = async (
      targetPool: Pool,
      keys: Map<string, Uint8Array>,
      activeVersion: string,
      storage: FakeStorage,
    ): Promise<AccessHarness> => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ReceiptMediaAccessController],
        providers: [
          {
            provide: PostgresReceiptMediaStore,
            useFactory: () => new PostgresReceiptMediaStore(targetPool),
          },
          {
            provide: RECEIPT_CAPABILITY_LOOKUP,
            useExisting: PostgresReceiptMediaStore,
          },
          {
            provide: CapabilityService,
            useFactory: () => new CapabilityService(keys, activeVersion),
          },
          {
            provide: ReceiptCapabilityAuthorizerService,
            useFactory: (capability: CapabilityService, lookup: unknown) =>
              new ReceiptCapabilityAuthorizerService(
                capability,
                lookup as never,
              ),
            inject: [CapabilityService, RECEIPT_CAPABILITY_LOOKUP],
          },
          { provide: OBJECT_STORAGE_PORT, useValue: storage },
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      return {
        app,
        capability: moduleRef.get(CapabilityService),
        store: moduleRef.get(PostgresReceiptMediaStore),
        storage,
        close: () => app.close(),
      };
    };

    const getUrl = (
      app: INestApplication,
      token: string,
      headers: Record<string, string> = {},
    ) =>
      request(app.getHttpServer() as App)
        .get(`/media/receipts/${token}`)
        .set(headers);

    const headUrl = (
      app: INestApplication,
      token: string,
      headers: Record<string, string> = {},
    ) =>
      request(app.getHttpServer() as App)
        .head(`/media/receipts/${token}`)
        .set(headers);

    it.each<[string, string, Buffer]>([
      ['image/jpeg', 'receipt.jpg', JPEG],
      ['image/png', 'receipt.png', PNG],
    ])(
      'serves authorized GET bytes and HEAD metadata for %s from the real DB lookup without exposing secrets',
      async (mime, filename, bytes) => {
        const storage = makeStorage(bytes, mime as ReceiptMimeType);
        const harness = await buildAccessApp(pool, KEYRING_1, '1', storage);
        try {
          await seedStored(
            RECEIPT_A,
            OBJECT_A,
            ISSUED_A1.tokenHash,
            ISSUED_A1.keyVersion,
          );

          const get = await getUrl(harness.app, ISSUED_A1.token);
          expect(get.status).toBe(200);
          expect(get.body).toEqual(bytes);
          expect(get.headers).toMatchObject({
            ...SAFE_HEADERS,
            'content-type': mime,
            'content-length': String(bytes.length),
            'content-disposition': `inline; filename="${filename}"`,
          });
          expect(get.headers.etag).toBeUndefined();
          expect(storage.getStream).toHaveBeenCalledTimes(1);
          const getCall = storage.getStream.mock.calls[0]?.[0];
          expect(getCall?.key).toBe(OBJECT_A);
          expect(getCall?.abortSignal).toBeInstanceOf(AbortSignal);

          const head = await headUrl(harness.app, ISSUED_A1.token);
          expect(head.status).toBe(200);
          expect(head.headers).toMatchObject({
            ...SAFE_HEADERS,
            'content-type': mime,
            'content-length': String(bytes.length),
            'content-disposition': `inline; filename="${filename}"`,
          });
          expect(head.text ?? '').toBe('');
          expect(storage.head).toHaveBeenCalledTimes(1);
          expect(storage.head.mock.calls[0]?.[0]?.key).toBe(OBJECT_A);

          // Neither the capability token, the private object key, the stored
          // ETag/version, nor any provider metadata leaks on either surface.
          expectNoSecretLeakage(get, { tokens: [ISSUED_A1.token] });
          expectNoSecretLeakage(head, { tokens: [ISSUED_A1.token] });
        } finally {
          await harness.close();
        }
      },
    );

    it('authorizes before Range: denied Range is 404 and authorized unsupported Range is 416 without storage', async () => {
      const storage = makeStorage(JPEG);
      const harness = await buildAccessApp(pool, KEYRING_1, '1', storage);
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );

        const deniedGet = await getUrl(harness.app, UNKNOWN_TOKEN, {
          range: 'bytes=0-',
        });
        expect(deniedGet.status).toBe(404);
        expect(deniedGet.text ?? '').toBe('');
        expect(deniedGet.headers['retry-after']).toBeUndefined();
        const deniedHead = await headUrl(harness.app, UNKNOWN_TOKEN, {
          range: 'bytes=0-',
        });
        expect(deniedHead.status).toBe(404);
        expectNoSecretLeakage(deniedGet, { tokens: [UNKNOWN_TOKEN] });
        expectNoSecretLeakage(deniedHead, { tokens: [UNKNOWN_TOKEN] });

        for (const range of ['bytes=0-', 'bogus']) {
          const get = await getUrl(harness.app, ISSUED_A1.token, { range });
          expect(get.status).toBe(416);
          expect(get.text ?? '').toBe('');
          expect(get.headers['retry-after']).toBeUndefined();
          const head = await headUrl(harness.app, ISSUED_A1.token, { range });
          expect(head.status).toBe(416);
          expectNoSecretLeakage(get, { tokens: [ISSUED_A1.token] });
          expectNoSecretLeakage(head, { tokens: [ISSUED_A1.token] });
        }
        expect(storage.getStream).not.toHaveBeenCalled();
        expect(storage.head).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    });

    it('anchors one indistinguishable empty 404 for malformed, unknown, and DB-revoked tokens', async () => {
      const storage = makeStorage(JPEG);
      const harness = await buildAccessApp(pool, KEYRING_1, '1', storage);
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );

        const malformed = await getUrl(harness.app, 'not-a-capability-token');
        const unknown = await getUrl(harness.app, UNKNOWN_TOKEN);
        expect(await harness.store.revokeCapability(RECEIPT_A)).toBe(true);
        const revoked = await getUrl(harness.app, ISSUED_A1.token);

        // Independently anchored generic-denial shape plus explicit field
        // anchors, never a projection of another response.
        expect(responseShape(malformed)).toEqual(ANCHORED_404_SHAPE);
        expect(malformed.status).toBe(404);
        expect(malformed.text ?? '').toBe('');
        expect(malformed.headers['retry-after']).toBeUndefined();
        expect(malformed.headers['content-type']).toBeUndefined();
        expect(malformed.headers['content-length']).toBe('0');
        expect(malformed.headers).toMatchObject(SAFE_HEADERS);
        expect(responseShape(unknown)).toEqual(ANCHORED_404_SHAPE);
        expect(responseShape(revoked)).toEqual(ANCHORED_404_SHAPE);
        expect(responseShape(unknown)).toEqual(responseShape(revoked));
        expect(storage.getStream).not.toHaveBeenCalled();
        expect(storage.head).not.toHaveBeenCalled();
        expectNoSecretLeakage(malformed, {
          tokens: ['not-a-capability-token'],
        });
        expectNoSecretLeakage(unknown, { tokens: [UNKNOWN_TOKEN] });
        expectNoSecretLeakage(revoked, { tokens: [ISSUED_A1.token] });
      } finally {
        await harness.close();
      }
    });

    it('returns the anchored empty 404 only after real DB authorization when private storage reports OBJECT_NOT_FOUND', async () => {
      const notFound = new ObjectStorageError(
        'OBJECT_STORAGE',
        'OBJECT_NOT_FOUND',
      );
      const storage = failingStorage(notFound);
      const harness = await buildAccessApp(pool, KEYRING_1, '1', storage);
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );

        const get = await getUrl(harness.app, ISSUED_A1.token);
        const head = await headUrl(harness.app, ISSUED_A1.token);
        expect(responseShape(get)).toEqual(ANCHORED_404_SHAPE);
        expect(responseShape(head)).toEqual(ANCHORED_404_SHAPE);
        expect(responseShape(get)).toEqual(responseShape(head));
        // Authorization consumed the real DB row and handed the private key
        // to storage exactly once per method before the not-found mapping.
        expect(storage.getStream).toHaveBeenCalledTimes(1);
        expect(storage.head).toHaveBeenCalledTimes(1);
        expect(storage.getStream.mock.calls[0]?.[0]?.key).toBe(OBJECT_A);
        expect(storage.head.mock.calls[0]?.[0]?.key).toBe(OBJECT_A);
        expectNoSecretLeakage(get, {
          tokens: [ISSUED_A1.token],
          sensitive: ['OBJECT_NOT_FOUND', 'OBJECT_STORAGE'],
        });
        expectNoSecretLeakage(head, {
          tokens: [ISSUED_A1.token],
          sensitive: ['OBJECT_NOT_FOUND', 'OBJECT_STORAGE'],
        });
      } finally {
        await harness.close();
      }
    });

    it('returns the anchored empty 503 with the fixed Retry-After when the capability lookup is unavailable', async () => {
      const storage = makeStorage(JPEG);
      const brokenPool = new Pool({
        connectionString: container.getConnectionUri(),
      });
      await brokenPool.end();
      const harness = await buildAccessApp(brokenPool, KEYRING_1, '1', storage);
      try {
        const res = await getUrl(harness.app, ISSUED_A1.token);
        expect(responseShape(res)).toEqual(ANCHORED_503_SHAPE);
        expect(res.status).toBe(503);
        expect(res.text ?? '').toBe('');
        expect(res.headers['retry-after']).toBe(RETRY);
        expect(res.headers['content-type']).toBeUndefined();
        expect(res.headers['content-length']).toBe('0');
        expect(res.headers).toMatchObject(SAFE_HEADERS);
        expectNoSecretLeakage(res, { tokens: [ISSUED_A1.token] });
        expect(storage.getStream).not.toHaveBeenCalled();
        expect(storage.head).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    });

    it('returns the anchored empty 503 with the fixed Retry-After when deterministic storage is unavailable', async () => {
      const failure = new ObjectStorageError(
        'OBJECT_STORAGE',
        'NETWORK_FAILURE',
      );
      const storage = failingStorage(failure);
      const harness = await buildAccessApp(pool, KEYRING_1, '1', storage);
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );

        const get = await getUrl(harness.app, ISSUED_A1.token);
        expect(responseShape(get)).toEqual(ANCHORED_503_SHAPE);
        expect(get.status).toBe(503);
        expect(get.text ?? '').toBe('');
        expect(get.headers['retry-after']).toBe(RETRY);
        expect(get.headers['content-type']).toBeUndefined();
        expect(get.headers['content-length']).toBe('0');
        expect(get.headers).toMatchObject(SAFE_HEADERS);
        const head = await headUrl(harness.app, ISSUED_A1.token);
        expect(responseShape(head)).toEqual(ANCHORED_503_SHAPE);
        // No provider code/name, ETag, private object key, or token leaks.
        expectNoSecretLeakage(get, {
          tokens: [ISSUED_A1.token],
          sensitive: ['NETWORK_FAILURE', 'OBJECT_STORAGE'],
        });
        expectNoSecretLeakage(head, {
          tokens: [ISSUED_A1.token],
          sensitive: ['NETWORK_FAILURE', 'OBJECT_STORAGE'],
        });
        // The real DB lookup authorized; the deterministic seam then failed.
        expect(storage.getStream).toHaveBeenCalledTimes(1);
        expect(storage.head).toHaveBeenCalledTimes(1);
      } finally {
        await harness.close();
      }
    });

    it('produces byte-identical empty 503 shapes for lookup-unavailable and deterministic storage-unavailable', async () => {
      const shapes: ReturnType<typeof responseShape>[] = [];

      const brokenPool = new Pool({
        connectionString: container.getConnectionUri(),
      });
      await brokenPool.end();
      const lookupHarness = await buildAccessApp(
        brokenPool,
        KEYRING_1,
        '1',
        makeStorage(JPEG),
      );
      try {
        const lookupGet = await getUrl(lookupHarness.app, ISSUED_A1.token);
        shapes.push(responseShape(lookupGet));
        expectNoSecretLeakage(lookupGet, { tokens: [ISSUED_A1.token] });
        const lookupHead = await headUrl(lookupHarness.app, ISSUED_A1.token);
        shapes.push(responseShape(lookupHead));
        expectNoSecretLeakage(lookupHead, { tokens: [ISSUED_A1.token] });
      } finally {
        await lookupHarness.close();
      }

      const storage = failingStorage(
        new ObjectStorageError('OBJECT_STORAGE', 'NETWORK_FAILURE'),
      );
      const storageHarness = await buildAccessApp(
        pool,
        KEYRING_1,
        '1',
        storage,
      );
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );
        const storageGet = await getUrl(storageHarness.app, ISSUED_A1.token);
        shapes.push(responseShape(storageGet));
        expectNoSecretLeakage(storageGet, {
          tokens: [ISSUED_A1.token],
          sensitive: ['NETWORK_FAILURE', 'OBJECT_STORAGE'],
        });
        const storageHead = await headUrl(storageHarness.app, ISSUED_A1.token);
        shapes.push(responseShape(storageHead));
        expectNoSecretLeakage(storageHead, {
          tokens: [ISSUED_A1.token],
          sensitive: ['NETWORK_FAILURE', 'OBJECT_STORAGE'],
        });
      } finally {
        await storageHarness.close();
      }

      for (const shape of shapes) expect(shape).toEqual(ANCHORED_503_SHAPE);
      // GET pair (index 0 vs 2) and HEAD pair (index 1 vs 3).
      expect(shapes[0]).toEqual(shapes[2]);
      expect(shapes[1]).toEqual(shapes[3]);
    });

    it('preserves access and reconstruction across a restart and an additive key rotation while retaining exact ATTACHED evidence and never reclaiming it', async () => {
      await seedAttached(
        RECEIPT_B,
        OBJECT_B,
        ISSUED_B1.tokenHash,
        ISSUED_B1.keyVersion,
      );
      // Exact durable ATTACHED evidence is snapshotted before its first GET.
      const attachedBefore = await rowOf(RECEIPT_B);
      const first = await buildAccessApp(
        pool,
        KEYRING_1,
        '1',
        makeStorage(JPEG),
      );
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );
        const served = await getUrl(first.app, ISSUED_A1.token);
        expect(served.status).toBe(200);
        expectNoSecretLeakage(served, { tokens: [ISSUED_A1.token] });
        const attached = await getUrl(first.app, ISSUED_B1.token);
        expect(attached.status).toBe(200);
        expect(attached.body).toEqual(JPEG);
        expectNoSecretLeakage(attached, { tokens: [ISSUED_B1.token] });
      } finally {
        await first.close();
      }

      // Real cleanup and both claim primitives must leave ATTACHED untouched.
      const store = new PostgresReceiptMediaStore(pool);
      const storage = makeStorage(JPEG);
      const cleanup = new ReceiptCleanupService(store, storage);
      expect(await cleanup.runBatch(10, 'cleanup-probe')).toEqual({
        claimed: 0,
        cleaned: 0,
        retryScheduled: 0,
        manualHold: 0,
        fenced: 0,
      });
      expect(storage.deleteTechnicalObject).not.toHaveBeenCalled();
      expect(await store.claimCleanupBatch(10, 'cleanup-probe')).toEqual([]);
      expect(await store.claimBatch(10, 'generic-probe')).toEqual([]);
      expect(await rowOf(RECEIPT_B)).toEqual(attachedBefore);

      const restarted = await buildAccessApp(
        pool,
        KEYRING_1,
        '1',
        makeStorage(JPEG),
      );
      try {
        const served = await getUrl(restarted.app, ISSUED_A1.token);
        expect(served.status).toBe(200);
        expectNoSecretLeakage(served, { tokens: [ISSUED_A1.token] });
        expect(
          restarted.capability.reconstruct(
            RECEIPT_A,
            ISSUED_A1.keyVersion,
            ISSUED_A1.tokenHash,
          ),
        ).not.toBeNull();
        const attached = await getUrl(restarted.app, ISSUED_B1.token);
        expect(attached.status).toBe(200);
        expect(attached.body).toEqual(JPEG);
        expectNoSecretLeakage(attached, { tokens: [ISSUED_B1.token] });
        expect(
          restarted.capability.reconstruct(
            RECEIPT_B,
            ISSUED_B1.keyVersion,
            ISSUED_B1.tokenHash,
          ),
        ).not.toBeNull();
      } finally {
        await restarted.close();
      }

      const rotated = await buildAccessApp(
        pool,
        KEYRING_12,
        '2',
        makeStorage(JPEG),
      );
      try {
        expect(
          rotated.capability.reconstruct(
            RECEIPT_A,
            ISSUED_A1.keyVersion,
            ISSUED_A1.tokenHash,
          ),
        ).not.toBeNull();
        const served = await getUrl(rotated.app, ISSUED_A1.token);
        expect(served.status).toBe(200);
        expectNoSecretLeakage(served, { tokens: [ISSUED_A1.token] });
        expect(
          rotated.capability.reconstruct(
            RECEIPT_B,
            ISSUED_B1.keyVersion,
            ISSUED_B1.tokenHash,
          ),
        ).not.toBeNull();
        const attached = await getUrl(rotated.app, ISSUED_B1.token);
        expect(attached.status).toBe(200);
        expect(attached.body).toEqual(JPEG);
        expectNoSecretLeakage(attached, { tokens: [ISSUED_B1.token] });
      } finally {
        await rotated.close();
      }

      // Restart plus every probe leaves the exact durable ATTACHED row intact.
      const attachedAfter = await rowOf(RECEIPT_B);
      expect(attachedAfter).toEqual(attachedBefore);
      expect(attachedAfter).toMatchObject({
        status: 'ATTACHED',
        object_key: OBJECT_B,
        capability_key_version_text: '1',
        backend_receipt_status: 'PENDING',
        declared_amount_cents: ATTACHED_AMOUNT,
      });
    });

    it('blocks reconstruction after the historical key is removed while the issued token still authorizes until explicit DB revocation', async () => {
      const storage = makeStorage(JPEG);
      const harness = await buildAccessApp(pool, KEYRING_2, '2', storage);
      try {
        await seedStored(
          RECEIPT_A,
          OBJECT_A,
          ISSUED_A1.tokenHash,
          ISSUED_A1.keyVersion,
        );
        // The rotated-only keyring cannot reconstruct the historical token...
        expect(
          harness.capability.reconstruct(
            RECEIPT_A,
            ISSUED_A1.keyVersion,
            ISSUED_A1.tokenHash,
          ),
        ).toBeNull();
        // ...but the already-issued raw token still authorizes via the hash.
        const before = await getUrl(harness.app, ISSUED_A1.token);
        expect(before.status).toBe(200);
        expect(before.body).toEqual(JPEG);
        expectNoSecretLeakage(before, { tokens: [ISSUED_A1.token] });

        // Explicit DB-only revocation then denies the same token.
        expect(await harness.store.revokeCapability(RECEIPT_A)).toBe(true);
        const after = await getUrl(harness.app, ISSUED_A1.token);
        expect(after.status).toBe(404);
        expect(after.text ?? '').toBe('');
        expect(after.headers['retry-after']).toBeUndefined();
        expectNoSecretLeakage(after, { tokens: [ISSUED_A1.token] });
      } finally {
        await harness.close();
      }
    });

    it('serves the mounted disabled route as an empty 503 with zero DB and storage I/O', async () => {
      const previous = { ...process.env };
      for (const key of RECEIPT_SPECIFIC_KEYS) delete process.env[key];
      Object.assign(process.env, BASE_ENV, { RECEIPT_MEDIA_ENABLED: 'false' });
      const stubPool = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
          query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      const storage = makeStorage(JPEG);
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [
            AppConfigModule.forRoot({ ignoreEnvFile: true }),
            ReceiptMediaModule,
          ],
        })
          .overrideProvider(PG_POOL)
          .useValue(stubPool)
          .overrideProvider(CONVERSATION_STORE)
          .useValue({ get: jest.fn().mockResolvedValue(null) })
          .overrideProvider(CHATBOT_API_CLIENT)
          .useValue({ attachReceipt: jest.fn().mockResolvedValue(undefined) })
          .overrideProvider(OBJECT_STORAGE_PORT)
          .useValue(storage)
          .compile();
        const app = moduleRef.createNestApplication();
        await app.init();
        try {
          const res = await getUrl(app, ISSUED_A1.token);
          expect(responseShape(res)).toEqual(ANCHORED_503_SHAPE);
          expect(res.status).toBe(503);
          expect(res.text ?? '').toBe('');
          expect(res.headers['retry-after']).toBe(RETRY);
          expect(res.headers).toMatchObject(SAFE_HEADERS);
          expectNoSecretLeakage(res, { tokens: [ISSUED_A1.token] });
          expect(stubPool.query).not.toHaveBeenCalled();
          expect(stubPool.connect).not.toHaveBeenCalled();
          expect(storage.getStream).not.toHaveBeenCalled();
          expect(storage.head).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    });
  },
);
