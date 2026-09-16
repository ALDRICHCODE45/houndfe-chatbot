/** WU15-2 behavior spec: ReceiptMetricsController.
 *
 * Tests exercise runtime behavior of the composed endpoint. Historical
 * RED/GREEN evidence and limitations are recorded in the WU15 task tracker.
 * The composed NestJS HTTP endpoint uses the REAL guard and a real
 * TestingModule — no guard mocking, no external services, loopback listener
 * per test, closed in finally/afterEach.
 *
 * Coverage: metrics/admission flag matrix, authenticated 200/401/404,
 * query/cookie-only 401, case-sensitive token/mixedcase Bearer,
 * content-type/no-store, serialization rejection (503), no unauthorized
 * serialization, and singleton duplicate-imports.
 */
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry } from 'prom-client';
import { WHATSAPP_SENDER } from '../../whatsapp/domain/whatsapp-sender.port';
import { META_MEDIA } from '../domain/meta-media.port';
import { OBJECT_STORAGE_PORT } from '../domain/object-storage.port';
import { AppConfigModule } from '../../config/config.module';
import { PG_POOL } from '../../database/postgres-pool.provider';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { ReceiptMediaModule } from '../receipt-media.module';
import {
  PrometheusReceiptTelemetry,
  RECEIPT_TELEMETRY,
} from '../infrastructure/prometheus-receipt-telemetry';

/** Valid test fixture: exactly 64 hex chars. */
const FIXED_TOKEN =
  'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

/** Mixed-case variant: uppercase A-F digits — used for case-sensitivity tests. */
const FIXED_UPPER_TOKEN =
  'A1B2C3D4E5F6789012345678901234567890ABCDEF1234567890ABCDEF123456';

/** Snapshot of the pristine environment, restored after each test. */
const baseEnv: Record<string, string | undefined> = { ...process.env };

/** Empty notification claims through a fake pg client; never opens a socket. */
const stubPool = () => {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
    client,
  };
};

/** Makes an HTTP GET request to an ephemeral loopback address. */
function httpGet(
  host: string,
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Applies synthetic env only; AppConfigModule never reads an env file. */
function applyReceiptEnv(
  metricsEnabled: boolean,
  metricsToken: string | undefined,
  admissionEnabled: boolean,
): void {
  // Clear everything except npm_/NODE_ preservation list.
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('npm_') && !key.startsWith('NODE_')) {
      delete process.env[key];
    }
  }
  process.env.META_VERIFY_TOKEN = 't';
  process.env.META_APP_SECRET = 's';
  process.env.META_ACCESS_TOKEN = 'a';
  process.env.META_PHONE_NUMBER_ID = '1';
  process.env.CHATBOT_API_BASE_URL = 'https://api.example.com';
  process.env.SERVICE_KEY = 'svc_x';
  process.env.CHATBOT_API_BRANCH_ID = 'b';
  process.env.CHATBOT_API_CASHIER_USER_ID =
    '00000000-0000-4000-8000-000000000001';
  process.env.OPENAI_API_KEY = 'g';
  process.env.LLM_MODEL = 'm';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/d';
  process.env.OPS_CHANNEL_PHONE = '5215500000000';
  process.env.RECEIPT_MEDIA_ENABLED = String(admissionEnabled);
  if (admissionEnabled) {
    Object.assign(process.env, {
      RECEIPT_MEDIA_MAX_BYTES: '10485760',
      META_MEDIA_ALLOWED_HOSTS: 'graph.facebook.com,.meta.com',
      META_MEDIA_METADATA_TIMEOUT_MS: '5000',
      META_MEDIA_DOWNLOAD_TIMEOUT_MS: '30000',
      RECEIPT_STORAGE_ENDPOINT: 'https://s3.example.com',
      RECEIPT_STORAGE_REGION: 'us-east-1',
      RECEIPT_STORAGE_BUCKET: 'test-receipts',
      RECEIPT_STORAGE_ACCESS_KEY_ID: 'test-key',
      RECEIPT_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
      RECEIPT_MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
      RECEIPT_MEDIA_WORKER_CONCURRENCY: '2',
      RECEIPT_MEDIA_WORKER_LEASE_MS: '60000',
      RECEIPT_MEDIA_WORKER_POLL_MS: '59000',
      CHATBOT_API_ATTACH_TIMEOUT_MS: '30000',
      RECEIPT_CAPABILITY_KEYS: '1:QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
      RECEIPT_CAPABILITY_ACTIVE_VERSION: '1',
    });
  }
  if (metricsEnabled) {
    process.env.RECEIPT_MEDIA_METRICS_ENABLED = 'true';
    if (metricsToken !== undefined) {
      process.env.RECEIPT_MEDIA_METRICS_TOKEN = metricsToken;
    }
  }
}

/** Builds the receipt module graph, binds an ephemeral loopback listener. */
async function buildApp(
  metricsEnabled: boolean,
  metricsToken: string | undefined,
  admissionEnabled = false,
): Promise<{
  app: INestApplication;
  port: number;
  boundaryCalls: jest.Mock[];
}> {
  applyReceiptEnv(metricsEnabled, metricsToken, admissionEnabled);
  const pool = stubPool();
  const backend = { attachReceipt: jest.fn() };
  const sender = { sendText: jest.fn() };
  const media = { resolveAndDownload: jest.fn() };
  const storage = {
    put: jest.fn(),
    getStream: jest.fn(),
    head: jest.fn(),
    deleteTechnicalObject: jest.fn(),
  };

  const builder = Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot({ ignoreEnvFile: true }),
      ReceiptMediaModule,
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(CONVERSATION_STORE)
    .useValue({ get: jest.fn().mockResolvedValue(null) })
    .overrideProvider(CHATBOT_API_CLIENT)
    .useValue(backend)
    .overrideProvider(WHATSAPP_SENDER)
    .useValue(sender)
    .overrideProvider(META_MEDIA)
    .useValue(media)
    .overrideProvider(OBJECT_STORAGE_PORT)
    .useValue(storage);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  try {
    await app.listen(0, '127.0.0.1');
    const { port } = (
      app.getHttpServer() as http.Server
    ).address() as AddressInfo;
    return {
      app,
      port,
      boundaryCalls: [
        pool.query,
        pool.connect,
        pool.client.query,
        backend.attachReceipt,
        sender.sendText,
        media.resolveAndDownload,
        ...Object.values(storage),
      ],
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

describe('ReceiptMetricsController (behavior spec)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env))
      if (!(key in baseEnv)) delete process.env[key];
    Object.assign(process.env, baseEnv);
  });

  describe('metrics + admission flag matrix', () => {
    it.each([
      [false, false, 404],
      [false, true, 404],
      [true, false, 200],
      [true, true, 200],
    ] as const)(
      'metrics=%s admission=%s returns %i without scrape-caused I/O',
      async (metrics, admission, expectedStatus) => {
        const { app, port, boundaryCalls } = await buildApp(
          metrics,
          FIXED_TOKEN,
          admission,
        );
        try {
          const before = boundaryCalls.map((spy) => spy.mock.calls.length);
          const res = await httpGet(
            '127.0.0.1',
            port,
            '/internal/receipt-media/metrics',
            {
              Authorization: `Bearer ${FIXED_TOKEN}`,
            },
          );
          expect(res.statusCode).toBe(expectedStatus);
          expect(boundaryCalls.map((spy) => spy.mock.calls.length)).toEqual(
            before,
          );
          if (metrics) {
            expect(res.body).toContain('receipt_media_metrics_enabled 1');
            expect(res.body).not.toContain('receipt_media_admission_enabled');
            expect(res.body).not.toContain('receipt_outbox_tx2');
          }
        } finally {
          await app.close();
        }
      },
    );

    it('rejects boot when metrics are enabled without a configured token', async () => {
      await expect(buildApp(true, undefined)).rejects.toThrow(
        /RECEIPT_MEDIA_METRICS_TOKEN/,
      );
    });

    it('returns 404 when metrics are disabled', async () => {
      const { app, port } = await buildApp(false, undefined);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
        );
        expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when token is missing', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
        );
        expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when token is wrong', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `Bearer ${FIXED_TOKEN.slice(0, -1)}x` },
        );
        expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });

    it('returns 200 when token is correct', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `Bearer ${FIXED_TOKEN}` },
        );
        expect(res.statusCode).toBe(HttpStatus.OK);
        expect(res.body).toContain('receipt_media_metrics_enabled');
      } finally {
        await app.close();
      }
    });
  });

  describe('authentication — token only via Authorization header', () => {
    it('returns 401 when token is sent only as query parameter', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          `/internal/receipt-media/metrics?token=${FIXED_TOKEN}`,
        );
        expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });

    it('returns 401 when token is sent only as a cookie', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Cookie: `metrics_token=${FIXED_TOKEN}` },
        );
        expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });
  });

  describe('authentication — token format and casing', () => {
    it('returns 401 when lowercase token differs from mixed-case configured token', async () => {
      // FIXED_UPPER_TOKEN uses uppercase A-F digits. Configure with it, then
      // send the lowercased version. The guard must reject because the token
      // bytes differ after SHA-256 hashing.
      const { app, port } = await buildApp(true, FIXED_UPPER_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `bearer ${FIXED_UPPER_TOKEN.toLowerCase()}` },
        );
        // Lowercase hex bytes differ from uppercase bytes → SHA-256 digests differ → 401.
        expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
      } finally {
        await app.close();
      }
    });

    it('accepts uppercase hex when configured token is uppercase', async () => {
      const { app, port } = await buildApp(true, FIXED_UPPER_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `Bearer ${FIXED_UPPER_TOKEN}` },
        );
        expect(res.statusCode).toBe(HttpStatus.OK);
      } finally {
        await app.close();
      }
    });
  });

  describe('response headers', () => {
    it('sets Content-Type and Cache-Control: no-store on 200', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `Bearer ${FIXED_TOKEN}` },
        );
        expect(res.statusCode).toBe(HttpStatus.OK);
        // Express may reorder parameters without changing the media type.
        const contentType = app
          .get<PrometheusReceiptTelemetry>(RECEIPT_TELEMETRY)
          .contentType();
        const parameters = (value: string) =>
          value
            .split(';')
            .map((part) => part.trim())
            .sort();
        expect(parameters(res.headers['content-type'] ?? '')).toEqual(
          parameters(contentType),
        );
        expect(res.headers['cache-control']).toBe('no-store');
      } finally {
        await app.close();
      }
    });

    it('does NOT serialize metrics when guard denies with wrong token', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      const serialize = jest.spyOn(Registry.prototype, 'metrics');
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: 'Bearer wrong' },
        );
        expect(res.statusCode).toBe(HttpStatus.UNAUTHORIZED);
        expect(serialize).not.toHaveBeenCalled();
        expect(res.body).not.toContain('receipt_media_metrics_enabled');
        expect(res.body).not.toContain('receipt_outbox_tx2');
      } finally {
        await app.close();
      }
    });

    it('does NOT serialize metrics when metrics are disabled', async () => {
      const { app, port } = await buildApp(false, undefined);
      const serialize = jest.spyOn(Registry.prototype, 'metrics');
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
        );
        expect(res.statusCode).toBe(HttpStatus.NOT_FOUND);
        // The disabled guard rejects before reaching the controller.
        expect(serialize).not.toHaveBeenCalled();
        expect(res.body).not.toContain('receipt_media_metrics_enabled');
        expect(res.body).not.toContain('receipt_outbox_tx2');
      } finally {
        await app.close();
      }
    });
  });

  describe('serialization error → 503', () => {
    it('returns 503 with safe body when the real adapter Registry rejects', async () => {
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      expect(app.get(RECEIPT_TELEMETRY)).toBeInstanceOf(
        PrometheusReceiptTelemetry,
      );
      const serialize = jest
        .spyOn(Registry.prototype, 'metrics')
        .mockRejectedValue(new Error('synthetic-sensitive-registry-error'));
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `Bearer ${FIXED_TOKEN}` },
        );
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(503);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toBe('metrics unavailable');
        expect(res.body).not.toContain('synthetic-sensitive-registry-error');
        // No metric data serialized.
        expect(res.body).not.toContain('receipt_outbox_tx2');
        expect(res.body).not.toContain('receipt_media_metrics_enabled');
      } finally {
        await app.close();
      }
    });
  });

  describe('controller composition', () => {
    it('controller resolves and serves metrics with one module import', async () => {
      // Duplicate-import identity is exercised in receipt-media.module.spec.ts.
      const { app, port } = await buildApp(true, FIXED_TOKEN);
      try {
        const res = await httpGet(
          '127.0.0.1',
          port,
          '/internal/receipt-media/metrics',
          { Authorization: `Bearer ${FIXED_TOKEN}` },
        );
        expect(res.statusCode).toBe(HttpStatus.OK);
        expect(res.body).toContain('receipt_media_metrics_enabled');
      } finally {
        await app.close();
      }
    });
  });
});
