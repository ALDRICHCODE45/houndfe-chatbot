/** WU14A PostgreSQL drain-adapter contract for the WU9 worker's local
 * `NotificationStoreSeam` (Testcontainers, RUN_DOCKER_TESTS=1). Proves
 * due/expired eligibility, claim ordering, SKIP LOCKED disjointness,
 * fenced markSent/reschedule, the attempts 1→2→3 ladder with replay,
 * parameter-bound adversarial identifiers, and a zero-outbound surface. */
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { QueryResultRow } from 'pg';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresReceiptOutboxStore } from './postgres-receipt-outbox.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;

type Row = Record<string, unknown>;
const OWNER = 'worker-a';
const OTHER = 'worker-b';
const UUID_B = '11111111-1111-4111-8111-111111111111';

let seq = 0;
/** Minimal durable outbox intent; overrides build status/lease fixtures. */
const intentRow = (over: Row = {}): Row => ({
  id: randomUUID(),
  dedupe_key: `dk.wu14.${++seq}`,
  source_webhook_message_id: 'wamid.wu14',
  recipient_id: '+525500000000',
  template_key: 'RECEIPT_AMOUNT_PROMPT',
  template_args: JSON.stringify({ amountCents: 123456 }),
  status: 'PENDING',
  attempts: 0,
  ...over,
});

ddescribe('PostgresReceiptOutboxStore (WU14A, Testcontainers)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptOutboxStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execSync('pnpm migrate', {
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({
      connectionString: container.getConnectionUri(),
      options: '-c statement_timeout=8000',
    });
    store = new PostgresReceiptOutboxStore(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  /** Neutralizes leftovers so every test starts from a quiet outbox. */
  const quiesce = (): Promise<unknown> =>
    pool.query(
      `UPDATE receipt_media_outbox SET status = 'SENT',
         lease_owner = NULL, lease_expires_at = NULL
       WHERE status IN ('PENDING', 'SENDING')`,
    );

  const insert = async (over: Row = {}): Promise<string> => {
    const row = intentRow(over);
    const cols = Object.keys(row);
    const { rows } = await pool.query<QueryResultRow>(
      `INSERT INTO receipt_media_outbox (${cols.join(',')}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(',')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0].id as string;
  };

  const durable = async (id: string): Promise<Row> =>
    (
      await pool.query<QueryResultRow>(
        'SELECT * FROM receipt_media_outbox WHERE id = $1',
        [id],
      )
    ).rows[0];

  const expireLease = (id: string): Promise<unknown> =>
    pool.query(
      `UPDATE receipt_media_outbox
       SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

  const makeDue = (id: string): Promise<unknown> =>
    pool.query(
      'UPDATE receipt_media_outbox SET next_attempt_at = now() WHERE id = $1',
      [id],
    );

  /** Narrows a claimed row's lease token; a missing token fails the test. */
  const leaseToken = (row: { leaseExpiresAt: Date | null }): Date => {
    expect(row.leaseExpiresAt).toBeInstanceOf(Date);
    return row.leaseExpiresAt as Date;
  };

  const liveLease = (): Row => ({
    lease_owner: 'crashed',
    lease_expires_at: new Date(Date.now() + 60_000),
  });
  const expiredLease = (): Row => ({
    lease_owner: 'crashed',
    lease_expires_at: new Date(Date.now() - 1_000),
  });

  beforeEach(async () => {
    await quiesce();
  });

  it('claims only due PENDING and expired-lease SENDING (attempts < 3) rows in next_attempt_at, created_at order', async () => {
    const tie = new Date(Date.now() - 45_000);
    const [
      earliest,
      tie1,
      tie2,
      mid,
      future,
      liveSend,
      expireSend,
      exhaustSend,
    ] = await Promise.all([
      insert({ next_attempt_at: new Date(Date.now() - 60_000) }),
      insert({ next_attempt_at: tie, created_at: tie }),
      insert({
        next_attempt_at: tie,
        created_at: new Date(tie.getTime() + 10_000),
      }),
      insert({
        next_attempt_at: new Date(Date.now() - 30_000),
        created_at: new Date(Date.now() - 120_000),
      }),
      insert({ next_attempt_at: new Date(Date.now() + 3_600_000) }),
      insert({ status: 'SENDING', ...liveLease() }),
      insert({ status: 'SENDING', attempts: 2, ...expiredLease() }),
      insert({ status: 'SENDING', attempts: 3, ...expiredLease() }),
    ]);

    const batch = await store.claimBatch(20, OWNER);
    expect(batch.map((r) => r.id)).toEqual([
      earliest,
      tie1,
      tie2,
      mid,
      expireSend,
    ]);
    for (const row of batch) {
      expect(row.status).toBe('SENDING');
      expect(row.leaseOwner).toBe(OWNER);
      expect(row.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    }
    expect(batch[0]).toMatchObject({
      dedupeKey: expect.stringMatching(/^dk\.wu14\./) as string,
      receiptMediaId: null,
      sourceWebhookMessageId: 'wamid.wu14',
      recipientId: '+525500000000',
      templateKey: 'RECEIPT_AMOUNT_PROMPT',
      templateArgs: { amountCents: 123456 },
      providerMessageId: null,
      sentAt: null,
      createdAt: expect.any(Date) as Date,
      nextAttemptAt: expect.any(Date) as Date,
    });
    expect((await durable(future)).status).toBe('PENDING');
    expect((await durable(liveSend)).lease_owner).toBe('crashed');
    expect((await durable(exhaustSend)).status).toBe('SENDING');
  });

  it('concurrent claimBatch calls return disjoint batches (FOR UPDATE SKIP LOCKED)', async () => {
    const total = 12;
    for (let i = 0; i < total; i++) await insert();
    const [a, b] = await Promise.all([
      store.claimBatch(10, 'w1'),
      store.claimBatch(10, 'w2'),
    ]);
    const aIds = new Set(a.map((r) => r.id));
    expect(aIds.size).toBe(a.length);
    for (const id of b.map((r) => r.id)) expect(aIds.has(id)).toBe(false);
    expect(new Set(b.map((r) => r.id)).size).toBe(b.length);
    expect(a.length + b.length).toBe(total);
    for (const row of [...a, ...b]) {
      expect(row.status).toBe('SENDING');
      expect(['w1', 'w2']).toContain(row.leaseOwner);
    }
  });

  it('markSent is a fenced CAS: exact id, SENDING, owner, live lease; expired SENDING replays', async () => {
    const id = await insert();
    const [claimed] = await store.claimBatch(1, OWNER);
    expect(claimed?.id).toBe(id);
    const tokenA = leaseToken(claimed);

    expect(await store.markSent(id, OTHER, 'wamid.X', tokenA)).toBe(false);
    expect(await store.markSent(UUID_B, OWNER, 'wamid.X', tokenA)).toBe(false);
    await expireLease(id);
    expect(await store.markSent(id, OWNER, 'wamid.X', tokenA)).toBe(false);

    const [replay] = await store.claimBatch(1, OTHER);
    expect(replay?.id).toBe(id);
    const tokenB = leaseToken(replay);
    expect(await store.markSent(id, OTHER, 'wamid.OK', tokenB)).toBe(true);
    expect(await store.markSent(id, OTHER, 'wamid.OK', tokenB)).toBe(false);
    expect(await durable(id)).toMatchObject({
      status: 'SENT',
      provider_message_id: 'wamid.OK',
      lease_owner: null,
      lease_expires_at: null,
      sent_at: expect.any(Date) as Date,
      updated_at: expect.any(Date) as Date,
    });
    expect(await store.markSent(id, OWNER, 'wamid.Y', tokenB)).toBe(false);

    const pending = await insert();
    expect(await store.markSent(pending, OWNER, 'wamid.Z', tokenB)).toBe(false);
    expect((await durable(pending)).status).toBe('PENDING');
  });

  it('reschedule ladder: 1→2 rescheduled PENDING, 3 exhausted FAILED; stale losers lost', async () => {
    const id = await insert();
    const [c1] = await store.claimBatch(1, OWNER);
    expect(c1?.id).toBe(id);

    expect(await store.reschedule(id, OWNER, 60_000, leaseToken(c1))).toBe(
      'rescheduled',
    );
    let row = await durable(id);
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect((row.next_attempt_at as Date).getTime()).toBeGreaterThan(
      Date.now() + 55_000,
    );
    expect(await store.claimBatch(5, OTHER)).toEqual([]);

    await makeDue(id);
    const [c2] = await store.claimBatch(1, OTHER);
    expect(c2?.id).toBe(id);
    expect(await store.reschedule(id, OTHER, 60_000, leaseToken(c2))).toBe(
      'rescheduled',
    );
    expect(await durable(id)).toMatchObject({ status: 'PENDING', attempts: 2 });

    await makeDue(id);
    const [c3] = await store.claimBatch(1, OWNER);
    expect(c3?.id).toBe(id);
    expect(await store.reschedule(id, OWNER, 60_000, leaseToken(c3))).toBe(
      'exhausted',
    );
    row = await durable(id);
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lease_owner: null,
      lease_expires_at: null,
    });

    const lost = await insert();
    const [lostClaim] = await store.claimBatch(1, OWNER);
    expect(lostClaim?.id).toBe(lost);
    await expireLease(lost);
    expect(
      await store.reschedule(lost, OWNER, 1_000, leaseToken(lostClaim)),
    ).toBe('lost');
    expect((await durable(lost)).attempts).toBe(0);
    expect(await store.reschedule(id, OWNER, 1_000, leaseToken(c3))).toBe(
      'lost',
    );
    expect(await store.reschedule(id, OTHER, 1_000, leaseToken(c3))).toBe(
      'lost',
    );
    const pending = await insert();
    expect(await store.reschedule(pending, OWNER, 1_000, leaseToken(c3))).toBe(
      'lost',
    );
    expect((await durable(pending)).attempts).toBe(0);
  });

  it('parameter-bound adversarial identifiers never escape or mutate', async () => {
    expect(
      await store.markSent("' OR '1'='1", OWNER, 'wamid.X', new Date(0)),
    ).toBe(false);
    expect(
      await store.markSent(
        UUID_B,
        "'; DROP TABLE receipt_media_outbox; --",
        'wamid.X',
        new Date(0),
      ),
    ).toBe(false);
    expect(
      await store.reschedule(UUID_B, "x' OR 'x'='x", 1_000, new Date(0)),
    ).toBe('lost');
    expect(
      await store.claimBatch(5, "'); DELETE FROM receipt_media_outbox; --"),
    ).toEqual([]);
    const id = await insert();
    const guardId = await insert();
    const [claimId] = await store.claimBatch(1, OWNER);
    expect(claimId?.id).toBe(id);
    const [claimGuard] = await store.claimBatch(1, OWNER);
    expect(claimGuard?.id).toBe(guardId);
    expect(
      await store.reschedule(guardId, OWNER, -1, leaseToken(claimGuard)),
    ).toBe('lost');
    expect(await durable(guardId)).toMatchObject({
      status: 'SENDING',
      attempts: 0,
      lease_owner: OWNER,
    });
    expect(await store.claimBatch(0, OWNER)).toEqual([]);
    expect(await store.claimBatch(-1, OWNER)).toEqual([]);
    expect(await store.claimBatch(1.5, OWNER)).toEqual([]);
    expect(await store.claimBatch(1, '')).toEqual([]);
    const { rowCount } = await pool.query<QueryResultRow>(
      'SELECT 1 FROM receipt_media_outbox LIMIT 1',
    );
    expect(rowCount).toBeGreaterThan(0);
  });

  it('same-owner ABA: stale lease tokens lose after reclaim; current token wins', async () => {
    const idA = await insert();
    const idB = await insert();
    const [a1] = await store.claimBatch(1, OWNER);
    expect(a1?.id).toBe(idA);
    const staleA = leaseToken(a1);
    await expireLease(idA);
    const [a2] = await store.claimBatch(1, OWNER);
    expect(a2?.id).toBe(idA);
    const freshA = leaseToken(a2);
    expect(freshA.getTime()).toBeGreaterThan(staleA.getTime());

    expect(await store.markSent(idA, OWNER, 'wamid.STALE', staleA)).toBe(false);
    expect(await store.reschedule(idA, OWNER, 1_000, staleA)).toBe('lost');
    expect(await durable(idA)).toMatchObject({
      status: 'SENDING',
      attempts: 0,
      lease_owner: OWNER,
      provider_message_id: null,
    });

    expect(await store.markSent(idA, OWNER, 'wamid.OK', freshA)).toBe(true);
    expect(await durable(idA)).toMatchObject({
      status: 'SENT',
      provider_message_id: 'wamid.OK',
    });

    const [b1] = await store.claimBatch(1, OTHER);
    expect(b1?.id).toBe(idB);
    const staleB = leaseToken(b1);
    await expireLease(idB);
    const [b2] = await store.claimBatch(1, OTHER);
    expect(b2?.id).toBe(idB);
    expect(await store.reschedule(idB, OTHER, 60_000, staleB)).toBe('lost');
    expect((await durable(idB)).attempts).toBe(0);
    expect(await store.reschedule(idB, OTHER, 60_000, leaseToken(b2))).toBe(
      'rescheduled',
    );
    expect(await durable(idB)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
    });
  });

  it('fences invalid lease tokens without a durable effect', async () => {
    const id = await insert();
    const [claimed] = await store.claimBatch(1, OWNER);
    expect(claimed?.id).toBe(id);
    const lease = leaseToken(claimed);
    expect(
      await store.markSent(id, OWNER, 'wamid.X', null as unknown as Date),
    ).toBe(false);
    expect(
      await store.reschedule(id, OWNER, 1_000, undefined as unknown as Date),
    ).toBe('lost');
    expect(await durable(id)).toMatchObject({ status: 'SENDING', attempts: 0 });
    expect(await store.markSent(id, OWNER, 'wamid.OK', lease)).toBe(true);
  });

  it('exposes no outbound surface: one pool dependency, seam methods only', () => {
    expect(PostgresReceiptOutboxStore.length).toBe(1);
    expect(
      Object.getOwnPropertyNames(PostgresReceiptOutboxStore.prototype).sort(),
    ).toEqual([
      'claimBatch',
      'constructor',
      'markSent',
      'reschedule',
      'withTx',
    ]);
  });
});
