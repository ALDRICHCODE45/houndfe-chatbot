import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  DEFAULT_DELIVERY_ZONE_POLL_POLICY,
  type DeliveryZoneRequesterRow,
} from '../domain/delivery-zone-requester';
import { PostgresDeliveryZoneRequesterStore } from './postgres-delivery-zone-requester.store';

const ddescribe =
  process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '..', '..', '..');
const SENDER = '5215512345678';
const CREATED = '2026-11-05T10:00:00.000Z';
const REQUESTER = 'c41b2c3d-1111-4222-8333-444455556666';
const ids = [
  '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b',
  '7f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b',
  '8f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b',
];

function row(
  sourceRequestId: string,
  patch: Partial<DeliveryZoneRequesterRow> = {},
): DeliveryZoneRequesterRow {
  return {
    sourceRequestId,
    senderId: SENDER,
    zipCode: '06700',
    intake: {
      sourceRequestId,
      type: 'DELIVERY_ZONE',
      zipCode: '06700',
      state: 'Ciudad de México',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Roma Norte',
      phoneCountryCode: '52',
      phone: '5512345678',
      conversationRef: `wa:${SENDER}`,
      lastCustomerMessageAt: CREATED,
    },
    requesterId: null,
    status: 'INTAKE_PENDING',
    lastPolledAt: null,
    resolution: null,
    applyBefore: null,
    channel: null,
    attemptId: null,
    attemptedAt: null,
    deliveryOutcome: null,
    providerMessageId: null,
    providerAcceptedObservedAt: null,
    notifiedAt: null,
    ackOutcome: null,
    ackedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...patch,
  };
}

ddescribe('delivery zone requester store (real PostgreSQL)', () => {
  jest.setTimeout(180_000);
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool;
  let store: PostgresDeliveryZoneRequesterStore;

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
      ],
      {
        cwd: ROOT,
        env: { DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
    store = new PostgresDeliveryZoneRequesterStore(pool);
  });
  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      await container?.stop();
    }
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM delivery_zone_requesters');
  });

  it('round-trips a row exactly, including the intake JSON', async () => {
    const created = await store.createOrGetOpen(row(ids[0]));
    expect(created).toEqual(row(ids[0]));
    expect(await store.findOpen(SENDER, '06700')).toEqual(row(ids[0]));
  });

  it('keeps one open requester per sender+ZIP and returns it on conflict', async () => {
    await store.createOrGetOpen(row(ids[0]));
    const second = await store.createOrGetOpen(row(ids[1]));
    expect(second.sourceRequestId).toBe(ids[0]);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM delivery_zone_requesters',
    );
    expect(rows[0].n).toBe(1);
  });

  it('a closed requester releases the slot for the same ZIP', async () => {
    await store.createOrGetOpen(row(ids[0], { status: 'FAILED' }));
    const next = await store.createOrGetOpen(row(ids[1]));
    expect(next.sourceRequestId).toBe(ids[1]);
  });

  it('transition is a status CAS and persists JSON resolution', async () => {
    await store.createOrGetOpen(row(ids[0]));
    const resolution = {
      source: 'VALIDATION' as const,
      zoneType: 'SURCHARGE' as const,
      surchargeCents: 4500,
      resolvedAt: '2026-11-05T18:00:00.000Z',
    };
    const resolved = await store.transition(ids[0], 'INTAKE_PENDING', {
      status: 'RESOLVED',
      requesterId: REQUESTER,
      resolution,
      applyBefore: '2026-11-06T18:00:00.000Z',
    });
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolution });
    expect(
      await store.transition(ids[0], 'INTAKE_PENDING', { status: 'FAILED' }),
    ).toBeNull();
  });

  it('rejects a send without resolution evidence (CHECK)', async () => {
    await store.createOrGetOpen(row(ids[0]));
    await expect(
      store.transition(ids[0], 'INTAKE_PENDING', { status: 'SEND_STARTED' }),
    ).rejects.toThrow();
  });

  it('listDue applies the backoff and ordering', async () => {
    const at = (ms: number) => new Date(Date.parse(CREATED) + ms).toISOString();
    await store.createOrGetOpen(row(ids[0], { lastPolledAt: at(0) }));
    await store.createOrGetOpen(
      row(ids[1], {
        zipCode: '06600',
        status: 'PENDING',
        lastPolledAt: at(2 * 3_600_000),
      }),
    );
    await store.createOrGetOpen(row(ids[2], { zipCode: '06500' }));
    const policy = DEFAULT_DELIVERY_ZONE_POLL_POLICY;
    // 2h + 1min: young row 0 is due, never-polled row 2 first, row 1 backs off.
    const due = await store.listDue(at(2 * 3_600_000 + 60_000), 10, policy);
    expect(due.map((r) => r.sourceRequestId)).toEqual([ids[2], ids[0]]);
    const later = await store.listDue(at(2 * 3_600_000 + 300_000), 1, policy);
    expect(later.map((r) => r.sourceRequestId)).toEqual([ids[2]]);
  });
});
