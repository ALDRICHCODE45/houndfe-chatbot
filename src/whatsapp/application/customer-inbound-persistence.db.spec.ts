import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresCustomerInboundObservationStore as Store } from '../../human-decisions/infrastructure/postgres-customer-inbound-observation.store';
import { SignatureGuard } from '../presentation/signature.guard';
import { captureCustomerInboundObservations } from './customer-inbound-persistence';

// Committed behavior proof, not retroactive RED or remote Meta provenance.
// Public capture/readLatest exercise the seam; SQL only resets and snapshots.
const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const PHONE = '123456789';
const OTHER_PHONE = '987654321';
const SENDER = '5215555555555';
const EARLY = '2026-06-22T13:00:00.000Z';
const LATE = '2026-06-22T14:00:00.000Z';
const SECRET = 'synthetic-local-test-secret';
const message = (id = 'first', timestamp = '100', from = SENDER) => ({
  id,
  timestamp,
  from,
  type: 'text',
  text: { body: 'private customer body' },
});
const observation = (
  id = 'first',
  timestamp = '100',
  sender = SENDER,
  phone = PHONE,
  observedAt = EARLY,
) => ({
  senderId: sender,
  receivingPhoneNumberId: phone,
  messageId: id,
  providerTimestampSeconds: timestamp,
  observedAt,
});
const captured = (...observations: ReturnType<typeof observation>[]) => ({
  action: 'captured',
  observations,
});
const found = (value: ReturnType<typeof observation>) => ({
  kind: 'found',
  observation: value,
});
function signed(
  messages: unknown[],
  phone = PHONE,
  time = EARLY,
  enabled = true,
) {
  const rawBody = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: phone },
                messages,
              },
            },
          ],
        },
      ],
    }),
  );
  const req = {
    rawBody,
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    },
  };
  const guard = new SignatureGuard(
    new ConfigService({
      meta: { appSecret: SECRET },
      humanDecisions: { restockEnabled: enabled },
    }),
  );
  const verify = () => {
    jest.useFakeTimers({ now: new Date(time) });
    try {
      return guard.canActivate({
        switchToHttp: () => ({ getRequest: () => req }),
      } as ExecutionContext);
    } finally {
      jest.useRealTimers();
    }
  };
  verify();
  return { req, verify };
}

ddescribe('authenticated capture to latest inbound (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let writer: Pool;
  let store: Store;
  const makePool = () => {
    if (!container) throw Error('Owned database unavailable');
    return new Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000,
      statement_timeout: 12_000,
    });
  };
  beforeAll(async () => {
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
        '3100000000000',
        '--timestamp',
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
    writer = makePool();
    store = new Store(writer);
  });
  afterAll(async () => {
    try {
      await writer?.end();
    } finally {
      await container?.stop();
    }
  });
  beforeEach(async () => {
    await writer.query('TRUNCATE customer_inbound_observations');
  });
  const snapshot = async () =>
    (
      await writer.query(
        'SELECT *, xmin::text AS xmin FROM customer_inbound_observations ORDER BY receiving_phone_number_id, message_id',
      )
    ).rows as unknown[];
  const capture = (req: unknown, phone = PHONE, enabled: unknown = true) =>
    captureCustomerInboundObservations(
      req,
      {
        enabled,
        phone,
        isOpsSender: (sender) => sender === 'ops',
        isKnownOutbound: (id) => id === 'outbound',
      },
      store,
    );
  async function latest(sender = SENDER, phone = PHONE) {
    const pool = makePool();
    try {
      return await new Store(pool).readLatest(sender, phone);
    } finally {
      await pool.end();
    }
  }

  it('persists verified snapshot metadata only and exposes it through a fresh pool', async () => {
    expect(await latest()).toEqual({ kind: 'missing' });
    const { req } = signed([message()]);
    req.rawBody.fill(0);
    Object.defineProperty(req, 'body', {
      get: () => {
        throw Error('untrusted body');
      },
    });
    const result = await capture(req);
    expect(result).toEqual(captured(observation()));
    expect(await latest()).toEqual(found(observation()));
    expect(Object.isFrozen(result)).toBe(true);
    if (result.action !== 'captured') throw Error('not captured');
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.observations[0])).toBe(true);
    expect(JSON.stringify(await snapshot())).not.toContain(
      'private customer body',
    );
  });
  it('keeps original observation on later verification replay without changing storage', async () => {
    expect(await capture(signed([message()]).req)).toEqual(
      captured(observation()),
    );
    const before = await snapshot();
    expect(await capture(signed([message()], PHONE, LATE).req)).toEqual(
      captured(observation()),
    );
    expect(await latest()).toEqual(found(observation()));
    expect(await snapshot()).toEqual(before);
  });
  it('orders by numeric provider time, not arrival or replay, with stable same-time ties', async () => {
    expect(await capture(signed([message('new', '1000')]).req)).toEqual(
      captured(observation('new', '1000')),
    );
    expect(
      await capture(signed([message('old', '99')], PHONE, LATE).req),
    ).toEqual(captured(observation('old', '99', SENDER, PHONE, LATE)));
    expect(await latest()).toEqual(found(observation('new', '1000')));
    expect(await capture(signed([message('z', '1000')]).req)).toEqual(
      captured(observation('z', '1000')),
    );
    expect(
      await capture(signed([message('new', '1000')], PHONE, LATE).req),
    ).toEqual(captured(observation('new', '1000')));
    expect(await latest()).toEqual(found(observation('z', '1000')));
    expect(await snapshot()).toHaveLength(3);
  });
  it('holds historical identity conflicts after newer events without changing rows', async () => {
    expect(
      await capture(signed([message(), message('new', '200')]).req),
    ).toEqual(captured(observation(), observation('new', '200')));
    const before = await snapshot();
    for (const conflict of [
      message('first', '101'),
      message('first', '100', 'other'),
    ]) {
      expect(
        await capture(
          signed([conflict, message('never', '300')], PHONE, LATE).req,
        ),
      ).toEqual({ action: 'hold' });
      expect(await snapshot()).toEqual(before);
      expect(await latest()).toEqual(found(observation('new', '200')));
      expect(await latest('other')).toEqual({ kind: 'missing' });
    }
  });
  it('retains a committed prefix and stops after a database identity conflict', async () => {
    expect(await capture(signed([message()]).req)).toEqual(
      captured(observation()),
    );
    const before = await snapshot();
    expect(
      await capture(
        signed(
          [
            message('prefix', '200'),
            message('first', '101'),
            message('never', '300'),
          ],
          PHONE,
          LATE,
        ).req,
      ),
    ).toEqual({ action: 'hold' });
    expect(await latest()).toEqual(
      found(observation('prefix', '200', SENDER, PHONE, LATE)),
    );
    const after = await snapshot();
    expect(after).toHaveLength(2);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(await capture(signed([message()], PHONE, LATE).req)).toEqual(
      captured(observation()),
    );
    expect(await snapshot()).toEqual(after);
  });
  it('preflights malformed eligible batches before any prefix write', async () => {
    expect(await capture(signed([message()]).req)).toEqual(
      captured(observation()),
    );
    const before = await snapshot();
    expect(
      await capture(
        signed([message('prefix', '200'), message('bad', '01')]).req,
      ),
    ).toEqual({ action: 'hold' });
    expect(await snapshot()).toEqual(before);
    expect(await latest()).toEqual(found(observation()));
  });
  it('rejects forgeries, revoked signatures and disabled snapshots with no writes', async () => {
    expect(await capture(signed([message()]).req)).toEqual(
      captured(observation()),
    );
    const before = await snapshot();
    const { req, verify } = signed([message('untrusted', '200')]);
    const cloned = { ...req };
    req.headers['x-hub-signature-256'] = `sha256=${'00'.repeat(32)}`;
    expect(verify).toThrow('Invalid X-Hub-Signature-256 header');
    for (const untrusted of [
      req,
      cloned,
      { action: 'prepared', observations: [observation('untrusted', '200')] },
      signed([message('untrusted', '200')], PHONE, EARLY, false).req,
    ]) {
      expect(await capture(untrusted)).toEqual({ action: 'hold' });
      expect(await snapshot()).toEqual(before);
      expect(await latest()).toEqual(found(observation()));
    }
    expect(
      await capture(signed([message('disabled', '300')]).req, PHONE, false),
    ).toEqual({ action: 'disabled' });
    expect(await snapshot()).toEqual(before);
  });
  it('filters excluded messages while preserving reaction outer identity and valid media', async () => {
    const messages = [
      message('ops', 'bad', 'ops'),
      message('outbound', 'bad'),
      { ...message('system', 'bad'), type: 'system' },
      { ...message('unsupported', 'bad'), type: 'unsupported' },
      {
        ...message('reaction', '200'),
        type: 'reaction',
        reaction: { message_id: 'outbound', emoji: '' },
      },
      { ...message('media', '100'), type: 'image' },
    ];
    expect(await capture(signed(messages).req)).toEqual(
      captured(observation('reaction', '200'), observation('media', '100')),
    );
    expect(await latest()).toEqual(found(observation('reaction', '200')));
    expect(await snapshot()).toHaveLength(2);
    const before = await snapshot();
    expect(await capture(signed(messages.slice(0, 4)).req)).toEqual(captured());
    expect(await snapshot()).toEqual(before);
  });
  it('separates senders and receiving phones while allowing cross-phone event IDs', async () => {
    expect(await capture(signed([message()]).req)).toEqual(
      captured(observation()),
    );
    expect(
      await capture(signed([message('other-sender', '200', 'other')]).req),
    ).toEqual(captured(observation('other-sender', '200', 'other')));
    const other = signed([message('first', '300')], OTHER_PHONE);
    const before = await snapshot();
    expect(await capture(other.req)).toEqual(captured());
    expect(await snapshot()).toEqual(before);
    expect(await latest(SENDER, OTHER_PHONE)).toEqual({ kind: 'missing' });
    expect(await capture(other.req, OTHER_PHONE)).toEqual(
      captured(observation('first', '300', SENDER, OTHER_PHONE)),
    );
    expect(await latest()).toEqual(found(observation()));
    expect(await latest('other')).toEqual(
      found(observation('other-sender', '200', 'other')),
    );
    expect(await latest(SENDER, OTHER_PHONE)).toEqual(
      found(observation('first', '300', SENDER, OTHER_PHONE)),
    );
    expect(await latest('other', OTHER_PHONE)).toEqual({ kind: 'missing' });
    expect(await snapshot()).toHaveLength(3);
  });
});
