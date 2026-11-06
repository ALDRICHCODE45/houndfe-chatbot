/**
 * R5 receipt outcome store against a real migrated PostgreSQL
 * (Testcontainers; gated by RUN_DOCKER_TESTS=1 like the other suites).
 */
import { execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Pool } from 'pg';
import type { ReceiptOutcomeCommitInput } from '../domain/receipt-outcome';
import { PostgresReceiptMediaStore } from './postgres-receipt-media.store';

const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const OWNER = 'receipt-media:test';
const SALE = '22222222-2222-4222-8222-222222222222';
const POLICY = {
  intervalMs: 60_000,
  slowAfterMs: 3_600_000,
  slowIntervalMs: 900_000,
};

ddescribe('R5 receipt outcome store (Testcontainers)', () => {
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

  beforeEach(() =>
    pool.query('TRUNCATE receipt_media_outbox, receipt_media CASCADE'),
  );

  /** Admits, downloads and uploads one receipt; returns its ids. */
  const attached = async (folio: string | null = 'F-12') => {
    const id = randomUUID();
    const sender = `521${Math.floor(Math.random() * 1e9)}`;
    await store.admit({
      id,
      webhookMessageId: `wamid.${id}`,
      providerMediaId: `media-${id}`,
      senderId: sender,
      capturedSaleId: SALE,
      declaredMimeType: 'image/jpeg',
    });
    const [claimed] = await store.claimBatch(1, OWNER);
    const meta = await store.startMetaAttempt({
      id,
      owner: OWNER,
      expectedVersion: claimed.version,
    });
    await store.commitDownload({
      id,
      owner: OWNER,
      expectedVersion: meta!.version,
      responseMimeType: 'image/jpeg',
      detectedMimeType: 'image/jpeg',
      byteCount: 1234,
      contentSha256: createHash('sha256').update(id).digest(),
    });
    const start = await store.startStorageAttempt({
      id,
      owner: OWNER,
      expectedVersion: String(BigInt(meta!.version) + 1n),
    });
    const backendReceiptId = randomUUID();
    const out = await store.commitUploadSuccess({
      id,
      owner: OWNER,
      expectedVersion: start!.version,
      backendReceiptId,
      templateArgs: folio === null ? {} : { folio },
    });
    expect(out.kind).toBe('committed');
    return { id, sender, backendReceiptId };
  };

  const commit = (
    id: string,
    over: Partial<ReceiptOutcomeCommitInput> = {},
  ): ReceiptOutcomeCommitInput => ({
    id,
    status: 'CONFIRMED',
    customerReason: null,
    debtCents: 0,
    delivery: 'QUEUED',
    templateKey: 'RECEIPT_PAYMENT_CONFIRMED',
    templateArgs: { folio: 'F-12' },
    ...over,
  });

  const outcomeIntents = async (id: string) =>
    (
      await pool.query<{ template_key: string; template_args: unknown }>(
        "SELECT template_key, template_args FROM receipt_media_outbox WHERE receipt_media_id = $1 AND dedupe_key LIKE 'receipt-outcome:%'",
        [id],
      )
    ).rows;

  it('lists an attached receipt with its backend id and folio until polled', async () => {
    const { id, sender, backendReceiptId } = await attached();
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toEqual([
      expect.objectContaining({
        id,
        senderId: sender,
        backendReceiptId,
        saleFolio: 'F-12',
        outcomePolledAt: null,
      }),
    ]);
    await store.markOutcomePolled(id);
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toEqual([]);
  });

  it('lists a polled receipt again once its backoff gap elapsed', async () => {
    const { id } = await attached(null);
    await store.markOutcomePolled(id);
    await pool.query(
      "UPDATE receipt_media SET outcome_polled_at = now() - interval '61 seconds' WHERE id = $1",
      [id],
    );
    const [due] = await store.listOutcomeDue(10, POLICY);
    expect(due).toMatchObject({ id, saleFolio: null });
  });

  it('uses the slow gap for a long-pending receipt', async () => {
    const { id } = await attached();
    await pool.query(
      "UPDATE receipt_media SET attached_at = now() - interval '2 hours', outcome_polled_at = now() - interval '5 minutes' WHERE id = $1",
      [id],
    );
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toEqual([]);
    await pool.query(
      "UPDATE receipt_media SET outcome_polled_at = now() - interval '16 minutes' WHERE id = $1",
      [id],
    );
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toHaveLength(1);
  });

  it('bounds the batch and never lists unattached receipts', async () => {
    await attached();
    await attached();
    await store.admit({
      id: randomUUID(),
      webhookMessageId: `wamid.${randomUUID()}`,
      providerMediaId: `media-${randomUUID()}`,
      senderId: '5210000000000',
      capturedSaleId: SALE,
      declaredMimeType: 'image/jpeg',
    });
    await expect(store.listOutcomeDue(1, POLICY)).resolves.toHaveLength(1);
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toHaveLength(2);
  });

  it('records the outcome and queues the text exactly once', async () => {
    const { id, sender } = await attached();
    const first = await store.commitOutcome(commit(id));
    expect(first).toMatchObject({
      kind: 'committed',
      intent: {
        recipientId: sender,
        templateKey: 'RECEIPT_PAYMENT_CONFIRMED',
        templateArgs: { folio: 'F-12' },
        status: 'PENDING',
      },
    });
    await expect(store.commitOutcome(commit(id))).resolves.toEqual({
      kind: 'already-notified',
    });
    expect(await outcomeIntents(id)).toHaveLength(1);
    const { rows } = await pool.query<Record<string, unknown>>(
      'SELECT outcome_status, outcome_reason, outcome_debt_cents, outcome_delivery, outcome_notified_at FROM receipt_media WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({
      outcome_status: 'CONFIRMED',
      outcome_reason: null,
      outcome_debt_cents: '0',
      outcome_delivery: 'QUEUED',
    });
    expect(rows[0].outcome_notified_at).toBeInstanceOf(Date);
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toEqual([]);
  });

  it('arbitrates concurrent commits to one outcome and one message', async () => {
    const { id } = await attached();
    const results = await Promise.all([
      store.commitOutcome(commit(id)),
      store.commitOutcome(
        commit(id, {
          status: 'REJECTED',
          customerReason: 'Ilegible',
          templateKey: 'RECEIPT_PAYMENT_REJECTED',
          templateArgs: { reason: 'Ilegible' },
        }),
      ),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual([
      'already-notified',
      'committed',
    ]);
    expect(await outcomeIntents(id)).toHaveLength(1);
  });

  it('records a rejection with its reason and the partial debt', async () => {
    const { id } = await attached();
    await store.commitOutcome(
      commit(id, {
        status: 'REJECTED',
        customerReason: 'El monto no coincide',
        debtCents: 150000,
        templateKey: 'RECEIPT_PAYMENT_REJECTED',
        templateArgs: { folio: 'F-12', reason: 'El monto no coincide' },
      }),
    );
    expect(await outcomeIntents(id)).toEqual([
      {
        template_key: 'RECEIPT_PAYMENT_REJECTED',
        template_args: { folio: 'F-12', reason: 'El monto no coincide' },
      },
    ]);
  });

  it('records OUTSIDE_WINDOW without any message and never lists it again', async () => {
    const { id } = await attached();
    await expect(
      store.commitOutcome(commit(id, { delivery: 'OUTSIDE_WINDOW' })),
    ).resolves.toEqual({ kind: 'committed', intent: null });
    expect(await outcomeIntents(id)).toEqual([]);
    const { rows } = await pool.query<Record<string, unknown>>(
      'SELECT outcome_delivery FROM receipt_media WHERE id = $1',
      [id],
    );
    expect(rows[0].outcome_delivery).toBe('OUTSIDE_WINDOW');
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toEqual([]);
  });

  it('fences malformed commits without mutation', async () => {
    const { id } = await attached();
    for (const bad of [
      commit(id, { templateKey: 'RECEIPT_PAYMENT_REJECTED' }),
      commit(id, { customerReason: 'x' }),
      commit(id, { debtCents: -1 }),
      commit(id, { templateArgs: { folio: 'x'.repeat(41) } }),
      commit('not-a-uuid'),
    ])
      await expect(store.commitOutcome(bad)).resolves.toEqual({
        kind: 'already-notified',
      });
    await expect(store.listOutcomeDue(10, POLICY)).resolves.toHaveLength(1);
  });

  it('rejects outcome evidence on a non-attached row at the schema', async () => {
    const id = randomUUID();
    await store.admit({
      id,
      webhookMessageId: `wamid.${id}`,
      providerMediaId: `media-${id}`,
      senderId: '5210000000001',
      capturedSaleId: SALE,
      declaredMimeType: 'image/jpeg',
    });
    await expect(
      pool.query(
        "UPDATE receipt_media SET outcome_status = 'CONFIRMED', outcome_debt_cents = 0, outcome_observed_at = now(), outcome_notified_at = now(), outcome_delivery = 'QUEUED' WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: 'receipt_media_outcome_evidence' });
  });
});
