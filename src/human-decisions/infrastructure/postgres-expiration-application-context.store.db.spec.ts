import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ExpirationIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import {
  PostgresExpirationApplicationContextStore,
  type ExpirationContextRead,
} from './postgres-expiration-application-context.store';

// Read-only real-PostgreSQL proof for the EXPIRATION application-context reader,
// gated by RUN_DOCKER_TESTS=1: the actual adapter, schema 280, a disposable
// postgres:16-alpine whose generated URI is the ONLY migration-child env (no
// ambient DATABASE_URL is read). Fixtures are inserted only to be read; the
// reader must never mutate, so every case snapshots SELECT * before and after.
// Constraint-impossible rows stay unit-only: a second ACTIVE row per sender,
// an uppercase EXPIRATION backend id, and a RECEIPT_RECORDED row that also
// carries unknown_observed_at.
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const OTHER_SENDER = 'whatsapp:+5215500000002';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const VARIANT = '55555555-5555-4555-8555-555555555555';
const DECISION = '99999999-9999-4999-8999-999999999999';
const UPPER = 'ABCDEF01-2345-4678-89AB-CDEF01234567';
const LEGACY = 'abcdef123456';
const AT = '2026-06-22T12:00:00.000Z';

const intake = (
  over: Partial<ExpirationIntakeInput> = {},
): ExpirationIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'EXPIRATION',
  productId: PRODUCT,
  variantId: null,
  ...over,
});
const recorded = (
  value: ExpirationIntakeInput = intake(),
  senderId = SENDER,
  requestKey = SOURCE,
) => ({
  action: 'recorded' as const,
  context: {
    reservation: {
      status: 'ACTIVE',
      route: 'EXPIRATION',
      senderId,
      requestKey,
      intake: value,
    },
    backendDecisionId: DECISION,
    postAttemptedAt: AT,
    receiptRecordedAt: AT,
  },
});

type Metadata = Partial<Record<string, string | null>>;
type Seed = Partial<{
  senderId: string;
  route: string;
  key: string;
  status: string;
  intake: string | null;
  meta: Metadata;
}>;
// Valid receipt metadata on an ACTIVE row. It is representable for both routes,
// so a RESTOCK fixture is held by the route guard, not by its POST state.
const RECEIPT: Metadata = {
  post_state: 'RECEIPT_RECORDED',
  backend_decision_id: DECISION,
  post_attempted_at: AT,
  receipt_recorded_at: AT,
};

ddescribe('EXPIRATION application-context read (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let uri: string;
  let setup: Pool;

  const open = (max: number) =>
    new Pool({
      connectionString: uri,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
      statement_timeout: 12_000,
      lock_timeout: 10_000,
      max,
    });
  const read = (pool: Pool, senderId = SENDER) =>
    new PostgresExpirationApplicationContextStore(pool).readRecordedForSender(
      senderId,
    );
  const snapshot = async () =>
    (
      await setup.query(
        'SELECT * FROM human_decision_reservations ORDER BY sender_id, route, request_key',
      )
    ).rows as Record<string, unknown>[];
  const seed = async (o: Seed = {}) => {
    const meta = o.meta ?? {};
    await setup.query(
      `INSERT INTO human_decision_reservations
       (sender_id, route, request_key, status, intake, post_state,
        backend_decision_id, post_attempted_at, receipt_recorded_at,
        unknown_observed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [
        o.senderId ?? SENDER,
        o.route ?? 'EXPIRATION',
        o.key ?? SOURCE,
        o.status ?? 'ACTIVE',
        o.intake === undefined ? JSON.stringify(intake()) : o.intake,
        meta.post_state ?? null,
        meta.backend_decision_id ?? null,
        meta.post_attempted_at ?? null,
        meta.receipt_recorded_at ?? null,
        meta.unknown_observed_at ?? null,
      ],
    );
  };

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
      uri = container.getConnectionUri();
      setup = open(3);
    } catch {
      throw new Error(
        'disposable PostgreSQL context-read fixture setup failed',
      );
    }
  });
  afterAll(async () => {
    try {
      await setup?.end();
    } finally {
      if (container) await container.stop();
    }
  });
  beforeEach(async () => {
    await setup.query('TRUNCATE human_decision_reservations');
  });

  it('reads one RECEIPT_RECORDED reservation with an explicit variant as a frozen snapshot', async () => {
    await seed({
      meta: RECEIPT,
      intake: JSON.stringify(intake({ variantId: VARIANT })),
    });
    await seed({
      senderId: OTHER_SENDER,
      key: OTHER,
      meta: RECEIPT,
      intake: JSON.stringify(intake({ sourceRequestId: OTHER })),
    });
    const persisted = await snapshot();
    expect(persisted).toHaveLength(2);
    const result = await read(setup);
    expect(result).toEqual(recorded(intake({ variantId: VARIANT })));
    if (result.action !== 'recorded') throw new Error('expected recorded');
    for (const frozen of [
      result.context,
      result.context.reservation,
      result.context.reservation.intake,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(await snapshot()).toEqual(persisted);
  });

  it('reads an explicit null variant as the exact stored context', async () => {
    await seed({ meta: RECEIPT });
    const before = await snapshot();
    await expect(read(setup)).resolves.toEqual(recorded());
    expect(await snapshot()).toEqual(before);
  });

  it('preserves a mixed-case source key and a shuffled JSONB key order', async () => {
    const value = intake({ sourceRequestId: UPPER, variantId: VARIANT });
    await seed({
      key: UPPER,
      intake: JSON.stringify({
        variantId: VARIANT,
        type: 'EXPIRATION',
        productId: PRODUCT,
        sourceRequestId: UPPER,
      }),
      meta: RECEIPT,
    });
    const before = await snapshot();
    await expect(read(setup)).resolves.toEqual(recorded(value, SENDER, UPPER));
    expect(await snapshot()).toEqual(before);
  });

  it('canonicalizes a non-UTC timestamptz offset to UTC', async () => {
    await seed({
      meta: {
        post_state: 'RECEIPT_RECORDED',
        backend_decision_id: DECISION,
        post_attempted_at: '2026-06-22T14:00:00+02:00',
        receipt_recorded_at: '2026-06-22T12:00:00.000Z',
      },
    });
    const before = await snapshot();
    await expect(read(setup)).resolves.toEqual(recorded());
    expect(await snapshot()).toEqual(before);
  });

  it('rereads the same full context through a fresh pool and store', async () => {
    await seed({ meta: RECEIPT });
    const before = await snapshot();
    const first = open(1);
    const result: ExpirationContextRead = await read(first).finally(() =>
      first.end(),
    );
    const fresh = open(1);
    await expect(read(fresh).finally(() => fresh.end())).resolves.toEqual(
      result,
    );
    expect(result).toEqual(recorded());
    expect(await snapshot()).toEqual(before);
  });

  it.each<[string, Seed | null]>([
    ['no reservation at all', null],
    ['a CLOSED EXPIRATION reservation', { status: 'CLOSED', meta: RECEIPT }],
    [
      'an ACTIVE reservation for another sender',
      { senderId: OTHER_SENDER, meta: RECEIPT },
    ],
  ])('reports missing for %s without a hold', async (_name, value) => {
    if (value) await seed(value);
    const before = await snapshot();
    await expect(read(setup)).resolves.toEqual({ action: 'missing' });
    expect(await snapshot()).toEqual(before);
  });

  it.each<[string, Seed]>([
    [
      'an ACTIVE RESTOCK reservation that already recorded a receipt',
      { route: 'RESTOCK', meta: RECEIPT },
    ],
    [
      'an ACTIVE LEGACY_OPS reservation',
      { route: 'LEGACY_OPS', key: LEGACY, intake: null },
    ],
    ['an ACTIVE EXPIRATION reservation without any POST state', { meta: {} }],
    [
      'an ACTIVE EXPIRATION reservation still RESERVED',
      { meta: { post_state: 'RESERVED' } },
    ],
    [
      'an ACTIVE EXPIRATION reservation POST_IN_FLIGHT',
      { meta: { post_state: 'POST_IN_FLIGHT', post_attempted_at: AT } },
    ],
    [
      'an ACTIVE EXPIRATION reservation gone UNKNOWN',
      { meta: { post_state: 'UNKNOWN', unknown_observed_at: AT } },
    ],
  ])('holds %s without mutating the persisted row', async (_name, value) => {
    await seed(value);
    const before = await snapshot();
    await expect(read(setup)).resolves.toEqual({ action: 'hold' });
    expect(await snapshot()).toEqual(before);
  });
});
