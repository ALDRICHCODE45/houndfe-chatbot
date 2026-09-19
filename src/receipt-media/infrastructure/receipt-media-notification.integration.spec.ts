import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ReceiptMediaOutboxRow } from '../domain/receipt-media.types';
import type {
  OutboundText,
  SendResult,
  WhatsappSenderPort,
} from '../../whatsapp/domain/whatsapp-sender.port';
import { PostgresReceiptOutboxStore } from './postgres-receipt-outbox.store';
import {
  RETRY_DELAY_MS,
  ReceiptMediaNotificationWorker,
  renderNotificationText,
  type NotificationAlertSeam,
} from './receipt-media-notification.worker';

/** ODD-6C tests-only cross-boundary evidence: the real
 * `ReceiptMediaNotificationWorker` → real `PostgresReceiptOutboxStore` over
 * Testcontainers PostgreSQL with the production migrations, a deterministic
 * `sendText` fake, and a deterministic exhaustion alert seam. No Nest app,
 * no live Meta, no production change; gated by RUN_DOCKER_TESTS=1. Delivery
 * stays explicitly at-least-once: the byte-identical replay case is not
 * exactly-once. */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
type Row = Record<string, unknown>;
const OWNER = 'odd6c.worker';
const AMOUNT_CONFIRM = 'Detectamos 1234.56 MXN. Responde CONFIRMAR o CANCELAR.';
const ATTACHED_PENDING = 'Comprobante recibido, queda PENDIENTE (PENDING).';

type SendHandler = (message: OutboundText) => Promise<SendResult>;
const fakeSender = (handler: SendHandler) => {
  const calls: OutboundText[] = [];
  const sender: Pick<WhatsappSenderPort, 'sendText'> = {
    sendText: (message) => {
      calls.push(message);
      return handler(message);
    },
  };
  return { sender, calls };
};

/** Deterministic, non-PII exhaustion alert: records the claimed intent only. */
const fakeAlert = () => {
  const intents: ReceiptMediaOutboxRow[] = [];
  const alert: NotificationAlertSeam = {
    onExhausted: (intent) => {
      intents.push(intent);
      return Promise.resolve();
    },
  };
  return { alert, intents };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

ddescribe('receipt-media notification cross-boundary (ODD-6C)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let store: PostgresReceiptOutboxStore;
  let priorDatabaseUrl: string | undefined;
  let seq = 0;
  const workers = new Set<ReceiptMediaNotificationWorker>();

  /** Real worker → real fenced SQL store; workers are owned for teardown. */
  const boot = (
    sender: Pick<WhatsappSenderPort, 'sendText'>,
    alert: NotificationAlertSeam,
  ): ReceiptMediaNotificationWorker => {
    const worker = new ReceiptMediaNotificationWorker(store, sender, alert, {
      owner: OWNER,
      pollIntervalMs: 50,
      batchSize: 4,
      maxConcurrency: 4,
    });
    workers.add(worker);
    worker.onApplicationBootstrap();
    return worker;
  };

  /** Parameter-bound fixture SQL: `next_attempt_at` is left to the durable
   * DB default so due-ness never depends on client/container clock skew. */
  const insert = async (over: Row = {}): Promise<string> => {
    const row: Row = {
      id: randomUUID(),
      dedupe_key: `odd6c.${++seq}`,
      source_webhook_message_id: `wamid.odd6c.${seq}`,
      recipient_id: '+525500000000',
      template_key: 'RECEIPT_AMOUNT_CONFIRM',
      template_args: JSON.stringify({ amountCents: 123456 }),
      status: 'PENDING',
      attempts: 0,
      ...over,
    };
    const cols = Object.keys(row);
    const { rows } = await pool.query<Row>(
      `INSERT INTO receipt_media_outbox (${cols.join(', ')}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0].id as string;
  };

  const readRow = async (id: string): Promise<Row> =>
    (
      await pool.query<Row>(
        'SELECT * FROM receipt_media_outbox WHERE id = $1',
        [id],
      )
    ).rows[0];

  const makeDue = (id: string): Promise<unknown> =>
    pool.query(
      'UPDATE receipt_media_outbox SET next_attempt_at = now() WHERE id = $1',
      [id],
    );

  const waitFor = async <T>(
    probe: () => T | null | Promise<T | null>,
    ms = 40_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('ODD-6C: waitFor timed out');
      await delay(25);
    }
  };

  /** Renders a persisted row: proves the JSONB round trip drives the send. */
  const render = (row: Row): string =>
    renderNotificationText({
      templateKey: row.template_key as ReceiptMediaOutboxRow['templateKey'],
      templateArgs: row.template_args as ReceiptMediaOutboxRow['templateArgs'],
    });

  beforeAll(async () => {
    priorDatabaseUrl = process.env.DATABASE_URL;
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
    store = new PostgresReceiptOutboxStore(pool);
  });

  afterAll(async () => {
    let failure: unknown;
    try {
      for (const worker of workers) await worker.onModuleDestroy();
    } catch (error) {
      failure ??= error;
    } finally {
      workers.clear();
    }
    try {
      if (pool) await pool.end();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (container) await container.stop();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorDatabaseUrl;
    } catch (error) {
      failure ??= error;
    }
    if (failure)
      throw failure instanceof Error ? failure : new Error('ODD-6C teardown');
  });

  afterEach(async () => {
    let failure: unknown;
    try {
      for (const worker of workers) await worker.onModuleDestroy();
    } catch (error) {
      failure ??= error;
    } finally {
      workers.clear();
    }
    await pool.query(
      'TRUNCATE receipt_media_cancellation_commands, receipt_media_outbox',
    );
    if (failure)
      throw failure instanceof Error ? failure : new Error('ODD-6C teardown');
  });

  it('renders committed PENDING intents through the JSONB round trip and marks each durably SENT once', async () => {
    const confirm = await insert({
      recipient_id: '+525500000001',
      template_key: 'RECEIPT_AMOUNT_CONFIRM',
      template_args: JSON.stringify({ amountCents: 123456 }),
    });
    const attached = await insert({
      recipient_id: '+525500000002',
      template_key: 'RECEIPT_ATTACHED_PENDING',
      template_args: JSON.stringify({ backendStatus: 'PENDING' }),
    });
    const { sender, calls } = fakeSender(async (message) => ({
      providerMessageId: `wamid.det.${message.to}`,
    }));
    const { alert, intents } = fakeAlert();
    boot(sender, alert);

    const rows = await waitFor(async () => {
      const current = [await readRow(confirm), await readRow(attached)];
      return current.every((row) => row.status === 'SENT') ? current : null;
    });
    const [a, b] = rows;
    expect(a.template_args).toEqual({ amountCents: 123456 });
    expect(b.template_args).toEqual({ backendStatus: 'PENDING' });
    for (const [row, text] of [
      [a, AMOUNT_CONFIRM],
      [b, ATTACHED_PENDING],
    ] as [Row, string][]) {
      expect(row).toMatchObject({
        status: 'SENT',
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
        provider_message_id: `wamid.det.${row.recipient_id as string}`,
      });
      expect(row.sent_at).toBeInstanceOf(Date);
      expect((row.sent_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
      expect(render(row)).toBe(text);
    }
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        { to: '+525500000001', text: AMOUNT_CONFIRM },
        { to: '+525500000002', text: ATTACHED_PENDING },
      ]),
    );
    expect(intents).toHaveLength(0);
  });

  it('persists the 1→2→3 retry/exhaustion ladder, alerts once, and never sends a fourth time', async () => {
    const id = await insert({ recipient_id: '+525500000003' });
    const { sender, calls } = fakeSender(() =>
      Promise.reject(new Error('meta transport down')),
    );
    const { alert, intents } = fakeAlert();
    const worker = boot(sender, alert);

    const attempt = async (expected: number): Promise<Row> => {
      const row = await waitFor(async () => {
        const current = await readRow(id);
        return current.attempts === expected ? current : null;
      });
      expect(row).toMatchObject({
        status: 'PENDING',
        attempts: expected,
        lease_owner: null,
        lease_expires_at: null,
        provider_message_id: null,
        sent_at: null,
      });
      const nextAttemptAt = (row.next_attempt_at as Date).getTime();
      expect(nextAttemptAt).toBeGreaterThan(
        Date.now() + RETRY_DELAY_MS - 5_000,
      );
      expect(nextAttemptAt).toBeLessThan(Date.now() + RETRY_DELAY_MS + 5_000);
      return row;
    };

    await attempt(1);
    await makeDue(id);
    worker.wake();
    await attempt(2);
    await makeDue(id);
    worker.wake();
    const exhausted = await waitFor(async () => {
      const current = await readRow(id);
      return current.status === 'FAILED' && current.attempts === 3
        ? current
        : null;
    });

    expect(RETRY_DELAY_MS).toBe(60_000);
    expect(calls).toHaveLength(3);
    expect(exhausted.provider_message_id).toBeNull();
    expect(exhausted.sent_at).toBeNull();
    expect(intents).toHaveLength(1);
    // The alert carries the third claimed row identity (pre-increment).
    expect(intents[0]).toMatchObject({
      id,
      status: 'SENDING',
      attempts: 2,
      recipientId: '+525500000003',
      templateKey: 'RECEIPT_AMOUNT_CONFIRM',
      templateArgs: { amountCents: 123456 },
    });

    // No automatic fourth send and no re-arm: the terminal row stays put.
    await delay(300);
    expect(calls).toHaveLength(3);
    expect(intents).toHaveLength(1);
    expect(await store.claimBatch(10, 'odd6c.probe')).toEqual([]);
  });

  it('reclaims an expired SENDING lease and replays the byte-identical payload (at-least-once, never exactly-once)', async () => {
    const id = await insert({
      recipient_id: '+525500000004',
      template_key: 'RECEIPT_ATTACHED_PENDING',
      template_args: JSON.stringify({ backendStatus: 'PENDING' }),
      status: 'SENDING',
      attempts: 1,
      lease_owner: 'crashed-worker',
      lease_expires_at: new Date(Date.now() - 60_000),
    });
    const { sender, calls } = fakeSender(() =>
      Promise.resolve({ providerMessageId: 'wamid.replay.1' }),
    );
    const { alert, intents } = fakeAlert();
    boot(sender, alert);

    const row = await waitFor(async () => {
      const current = await readRow(id);
      return current.status === 'SENT' ? current : null;
    });
    expect(row).toMatchObject({
      status: 'SENT',
      attempts: 1,
      provider_message_id: 'wamid.replay.1',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(row.sent_at).toBeInstanceOf(Date);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      to: '+525500000004',
      text: ATTACHED_PENDING,
    });
    // The replay payload is derived only from durable row fields.
    expect(calls[0].text).toBe(render(row));
    expect(intents).toHaveLength(0);
  });

  it('drains an in-flight send through durable markSent before onModuleDestroy resolves', async () => {
    const id = await insert({ recipient_id: '+525500000005' });
    let release!: (result: SendResult) => void;
    const deferred = new Promise<SendResult>((resolve) => (release = resolve));
    const { sender, calls } = fakeSender(() => deferred);
    const { alert, intents } = fakeAlert();
    const worker = boot(sender, alert);
    await waitFor(() => (calls.length === 1 ? true : null));

    let drained = false;
    let destroy: Promise<void> | undefined;
    try {
      destroy = worker.onModuleDestroy();
      void destroy.then(() => {
        drained = true;
      });
      await delay(100);
      expect(drained).toBe(false);
      // Immediate DB read: only the claimed SENDING lease is durable yet.
      expect(await readRow(id)).toMatchObject({
        status: 'SENDING',
        lease_owner: OWNER,
        provider_message_id: null,
      });
    } finally {
      // Release the blocked worker even when an assertion above fails.
      release({ providerMessageId: 'wamid.drain.1' });
    }
    await destroy;

    // Immediate DB read after destroy: SENT must already be durable.
    const row = await readRow(id);
    expect(row).toMatchObject({
      status: 'SENT',
      provider_message_id: 'wamid.drain.1',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(row.sent_at).toBeInstanceOf(Date);
    expect(calls).toHaveLength(1);
    expect(intents).toHaveLength(0);

    // No later claim or re-arm of the terminal row.
    await delay(200);
    expect(calls).toHaveLength(1);
    expect((await readRow(id)).status).toBe('SENT');
  });

  it('never sends, alerts, or mutates for an empty queue or terminal rows', async () => {
    const sent = await insert({
      status: 'SENT',
      attempts: 2,
      provider_message_id: 'wamid.already',
      sent_at: new Date(Date.now() - 60_000),
    });
    const failed = await insert({ status: 'FAILED', attempts: 3 });
    const before = [await readRow(sent), await readRow(failed)];
    const { sender, calls } = fakeSender(() =>
      Promise.resolve({ providerMessageId: 'wamid.never' }),
    );
    const { alert, intents } = fakeAlert();
    boot(sender, alert);

    await delay(300);
    expect(calls).toHaveLength(0);
    expect(intents).toHaveLength(0);
    expect(await store.claimBatch(10, 'odd6c.probe')).toEqual([]);
    const after = [await readRow(sent), await readRow(failed)];
    expect(after).toEqual(before);
  });
});
