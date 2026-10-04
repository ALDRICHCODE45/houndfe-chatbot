/** INACTIVE EXPIRATION reader->GET authorized integration proof, requested and
 * approved verbatim ("si. adelante."): a SINGLE new file with no production,
 * dependency, module, config or wiring change. It composes the REAL
 * ExpirationExistingDecisionService over the REAL
 * PostgresExpirationApplicationContextStore on disposable PostgreSQL and the
 * REAL ChatbotApiHttpClient, mocking ONLY HttpService.request and the backoff
 * sleep. It proves the persisted-id GET for PENDING/RESOLVED decisions,
 * foreign-identity rejection, the existing bounded 3x GET on a persistent 503
 * (sleeps 100/200), and ZERO HTTP for an absent or UNKNOWN reservation, with a
 * per-case before/after `SELECT *` snapshot proving no row mutation and an
 * independent assertion that every observed HTTP method is GET (never POST).
 * This does NOT prove communication with a real backend, runtime wiring,
 * process-restart durability, or any send/ACK behavior. */
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { of, throwError } from 'rxjs';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ExpirationIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import { ChatbotApiHttpClient } from '../../chatbot-api/infrastructure/chatbot-api-http.client';
import { PostgresExpirationApplicationContextStore } from '../infrastructure/postgres-expiration-application-context.store';
import { ExpirationExistingDecisionService } from './expiration-existing-decision.service';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const BRANCH = 'sucursal-centro';
const OTHER_BRANCH = 'sucursal-norte';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const DECISION = '99999999-9999-4999-8999-999999999999';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AT = '2026-06-22T12:00:00.000Z';
const AFTER = '2026-06-23T12:00:00.000Z';

function axiosResponse<T>(data: T, status = 200): AxiosResponse<T> {
  return {
    data,
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

const intake = (
  over: Partial<ExpirationIntakeInput> = {},
): ExpirationIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: VARIANT,
  ...over,
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  branchId: BRANCH,
  branchName: 'Sucursal Centro',
  productId: PRODUCT,
  productName: 'Croquetas Premium',
  unit: 'PZA',
  variantId: VARIANT,
  variantName: 'Senior',
  variantOption: 'Tamaño',
  variantValue: '15 kg',
  ...over,
});

const decision = (over: Record<string, unknown> = {}) => ({
  id: DECISION,
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  status: 'PENDING',
  version: 1,
  createdAt: AT,
  snapshot: snapshot(),
  supersedesDecisionId: null,
  resolution: null,
  applyBefore: null,
  ...over,
});

const PROVIDE = {
  action: 'PROVIDE_EXPIRATION_TEXT',
  expirationText: 'Vence 03/2027',
  resolvedAt: AT,
};
const UNAVAILABLE = {
  action: 'REPORT_EXPIRATION_UNAVAILABLE',
  resolvedAt: AT,
};
const resolvedDecision = (resolution: Record<string, unknown>) => ({
  ...decision(),
  status: 'RESOLVED',
  version: 2,
  resolution,
  applyBefore: AFTER,
});

const SEED = `INSERT INTO human_decision_reservations
 (sender_id, route, request_key, status, intake, post_state, backend_decision_id,
  post_attempted_at, receipt_recorded_at, unknown_observed_at)
 VALUES ($1, 'EXPIRATION', $2, 'ACTIVE', $3::jsonb, $4, $5, $6, $7, $8)`;

ddescribe(
  'EXPIRATION existing-decision integration (real PostgreSQL + real GET client)',
  () => {
    jest.setTimeout(180_000);
    let container: StartedPostgreSqlContainer | undefined;
    let pool: Pool;
    let realHttp: HttpService;
    let httpRequest: jest.SpiedFunction<HttpService['request']>;
    let config: ConfigService;
    let sleep: jest.Mock<Promise<void>, [number]>;

    const buildService = () =>
      new ExpirationExistingDecisionService(
        new PostgresExpirationApplicationContextStore(pool),
        new ChatbotApiHttpClient(realHttp, config, sleep),
        BRANCH,
      );

    const calls = () =>
      httpRequest.mock.calls.map(
        ([cfg]) =>
          cfg as unknown as {
            method?: string;
            url?: string;
            data?: unknown;
            headers: Record<string, string | undefined>;
          },
      );
    const methods = () =>
      calls().map((cfg) => (cfg.method ?? 'GET').toUpperCase());
    const urls = () => calls().map((cfg) => cfg.url);
    const expectOnlyGets = () => {
      const observed = methods();
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((method) => method === 'GET')).toBe(true);
      expect(observed).not.toContain('POST');
    };
    const tableRows = async () =>
      (
        await pool.query(
          'SELECT * FROM human_decision_reservations ORDER BY sender_id, route, request_key',
        )
      ).rows as Record<string, unknown>[];
    const seedRecorded = () =>
      pool.query(SEED, [
        SENDER,
        SOURCE,
        JSON.stringify(intake()),
        'RECEIPT_RECORDED',
        DECISION,
        AT,
        AT,
        null,
      ]);
    const seedUnknown = () =>
      pool.query(SEED, [
        SENDER,
        SOURCE,
        JSON.stringify(intake()),
        'UNKNOWN',
        null,
        AT,
        null,
        AT,
      ]);

    beforeAll(async () => {
      try {
        container = await new PostgreSqlContainer('postgres:16-alpine').start();
        execFileSync(
          process.execPath,
          [
            join(ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js'),
            '-f',
            'package.json',
            '--config-value',
            'pg-migrate',
            'up',
            '2800000000000',
            '--timestamp',
          ],
          {
            cwd: ROOT,
            env: { DATABASE_URL: container.getConnectionUri() },
            stdio: 'pipe',
            timeout: 60_000,
          },
        );
        pool = new Pool({
          connectionString: container.getConnectionUri(),
          idleTimeoutMillis: 0,
          connectionTimeoutMillis: 10_000,
          query_timeout: 15_000,
          statement_timeout: 12_000,
          lock_timeout: 10_000,
          max: 3,
        });
      } catch {
        throw new Error(
          'disposable PostgreSQL existing-decision fixture setup failed',
        );
      }
    });
    afterAll(async () => {
      try {
        await pool?.end();
      } finally {
        if (container) await container.stop();
      }
    });
    beforeEach(async () => {
      await pool.query('TRUNCATE human_decision_reservations');
      realHttp = new HttpService();
      config = new ConfigService({
        chatbotApi: {
          baseUrl: 'https://backend.example.com',
          serviceKey: 'svc_test_key',
          branchId: BRANCH,
        },
        receiptMedia: { attachTimeoutMs: 15000 },
      });
      sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
      httpRequest = jest
        .spyOn(realHttp, 'request')
        .mockImplementation(() =>
          throwError(() => new Error('unexpected network request')),
        );
    });

    it('GETs the persisted decision id and returns the exact PENDING decision', async () => {
      await seedRecorded();
      const before = await tableRows();
      httpRequest.mockReturnValue(of(axiosResponse(decision())));

      await expect(
        buildService().readExistingDecision(SENDER),
      ).resolves.toEqual({ outcome: 'pending', decision: decision() });

      expect(httpRequest).toHaveBeenCalledTimes(1);
      expectOnlyGets();
      expect(urls()).toEqual([`/chatbot-api/human-decisions/${DECISION}`]);
      const cfg = calls()[0];
      expect(cfg.headers.Authorization).toBe('Bearer svc_test_key');
      expect(cfg.headers['X-Branch-Id']).toBe(BRANCH);
      expect(cfg.headers['X-Idempotency-Key']).toBeUndefined();
      expect(cfg.data).toBeUndefined();
      expect(await tableRows()).toEqual(before);
    });

    it.each([PROVIDE, UNAVAILABLE])(
      'GETs the persisted decision id and returns the exact RESOLVED decision (%#)',
      async (resolution) => {
        await seedRecorded();
        const before = await tableRows();
        const wire = resolvedDecision(resolution);
        httpRequest.mockReturnValue(of(axiosResponse(wire)));

        await expect(
          buildService().readExistingDecision(SENDER),
        ).resolves.toEqual({ outcome: 'resolved', decision: wire });

        expect(httpRequest).toHaveBeenCalledTimes(1);
        expectOnlyGets();
        expect(urls()).toEqual([`/chatbot-api/human-decisions/${DECISION}`]);
        expect(await tableRows()).toEqual(before);
      },
    );

    it.each<[string, Record<string, unknown>, string]>([
      [
        'foreign branch',
        decision({ snapshot: snapshot({ branchId: OTHER_BRANCH }) }),
        'held',
      ],
      [
        'foreign product',
        decision({ snapshot: snapshot({ productId: OTHER }) }),
        'held',
      ],
      [
        'foreign variant',
        decision({
          snapshot: snapshot({ variantId: OTHER, variantName: 'Otra' }),
        }),
        'held',
      ],
      ['foreign source', decision({ sourceRequestId: OTHER }), 'held'],
      ['foreign response id', decision({ id: OTHER }), 'query_failed'],
    ])(
      'rejects a %s without mutating the persisted row',
      async (_label, wire, outcome) => {
        await seedRecorded();
        const before = await tableRows();
        httpRequest.mockReturnValue(of(axiosResponse(wire)));

        await expect(
          buildService().readExistingDecision(SENDER),
        ).resolves.toEqual({ outcome });

        expect(httpRequest).toHaveBeenCalledTimes(1);
        expectOnlyGets();
        expect(urls()).toEqual([`/chatbot-api/human-decisions/${DECISION}`]);
        expect(await tableRows()).toEqual(before);
      },
    );

    it('maps a persistent 503 to query_failed after the existing 3 GETs and 100/200 backoff', async () => {
      await seedRecorded();
      const before = await tableRows();
      httpRequest.mockReturnValue(
        throwError(() => ({
          response: {
            status: 503,
            data: { statusCode: 503, code: 'UPSTREAM_DOWN', message: 'x' },
          },
        })),
      );

      await expect(
        buildService().readExistingDecision(SENDER),
      ).resolves.toEqual({ outcome: 'query_failed' });

      expect(httpRequest).toHaveBeenCalledTimes(3);
      expect(methods()).toEqual(['GET', 'GET', 'GET']);
      expect(methods()).not.toContain('POST');
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 200);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(await tableRows()).toEqual(before);
    });

    it.each<[string, boolean]>([
      ['an absent reservation', false],
      ['an UNKNOWN reservation', true],
    ])(
      'holds %s with zero HTTP calls and no mutation',
      async (_label, unknown) => {
        if (unknown) await seedUnknown();
        const before = await tableRows();
        await expect(
          buildService().readExistingDecision(SENDER),
        ).resolves.toEqual({ outcome: 'held' });
        expect(httpRequest).not.toHaveBeenCalled();
        expect(await tableRows()).toEqual(before);
      },
    );
  },
);
