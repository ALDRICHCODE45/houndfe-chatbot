import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  readPendingHumanRequest,
  type ConversationState,
} from '../../conversation/domain/conversation-store';
import { PostgresConversationStore } from '../../conversation/infrastructure/postgres-conversation.store';
import { PostgresSharedReservationStore } from '../../human-decisions/infrastructure/postgres-shared-reservation.store';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import { PostgresHumanHandoffStore } from '../infrastructure/postgres-human-handoff.store';
import {
  HumanHandoffService,
  type HumanHandoffCreateInput,
} from './human-handoff.service';

/**
 * HD-R3b3-b2 real-PostgreSQL integration for the legacy handoff lifecycle on top
 * of the shared reservation claim (b1 `861f97a`) and the fenced close (`74a28ab`).
 *
 * It wires the REAL PostgresHumanHandoffStore + PostgresConversationStore +
 * PostgresSharedReservationStore against one disposable `postgres:16-alpine`,
 * applying ALL migrations to that container URI only (child env override, never
 * an ambient `DATABASE_URL`), with a fake WhatsApp sender. It covers the full
 * create → resolve → close → fresh-create lifecycle, concurrent same-sender
 * creates (one winner), and a post-claim send failure (no false success / no
 * duplicate row). Gated by RUN_DOCKER_TESTS=1.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');

const OPS = '5219999888777';
const CUSTOMER = '5215550001111';

const input = (senderId: string): HumanHandoffCreateInput => ({
  senderId,
  kind: 'out_of_stock',
  digest: { kind: 'out_of_stock', productId: 'p1', name: 'Croquetas' },
});

ddescribe('legacy handoff reservation (real DB)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let conversationStore: PostgresConversationStore;
  let service: HumanHandoffService;
  let sender: jest.Mocked<WhatsappSenderPort>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync('pnpm', ['migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    sender = {
      sendText: jest
        .fn()
        .mockResolvedValue({ providerMessageId: 'wamid.outbound' }),
    };
    const config = {
      get: (key: string) =>
        key === 'humanHandoff.enabled'
          ? true
          : key === 'humanHandoff.opsChannelPhone'
            ? OPS
            : undefined,
    } as unknown as ConfigService;
    conversationStore = new PostgresConversationStore(pool);
    service = new HumanHandoffService(
      new PostgresHumanHandoffStore(pool),
      sender,
      conversationStore,
      config,
      new PostgresSharedReservationStore(pool),
    );
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });

  beforeEach(async () => {
    sender.sendText.mockReset();
    sender.sendText.mockResolvedValue({ providerMessageId: 'wamid.outbound' });
    await pool.query(
      `TRUNCATE TABLE human_decision_reservations, human_handoff_requests,
       conversation_state`,
    );
  });

  const reservationsFor = async (senderId: string) =>
    (
      await pool.query<{ route: string; request_key: string; status: string }>(
        `SELECT route, request_key, status FROM human_decision_reservations
         WHERE sender_id = $1 ORDER BY created_at`,
        [senderId],
      )
    ).rows;
  const handoffsFor = async (senderId: string) =>
    (
      await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM human_handoff_requests
         WHERE customer_id = $1 ORDER BY created_at`,
        [senderId],
      )
    ).rows;
  const markerFor = async (senderId: string) => {
    const { rows } = await pool.query<{ present: boolean; value: unknown }>(
      `SELECT (data ? 'pendingHumanRequest') AS present,
              data->'pendingHumanRequest' AS value
       FROM conversation_state WHERE sender_id = $1`,
      [senderId],
    );
    return rows[0];
  };

  it('reserves, notifies, resolves, closes, then allows a fresh handoff', async () => {
    const created = await service.create(input(CUSTOMER));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const key = created.requestId;
    expect(key).toMatch(/^[a-f0-9]{12}$/);

    expect(await reservationsFor(CUSTOMER)).toEqual([
      { route: 'LEGACY_OPS', request_key: key, status: 'ACTIVE' },
    ]);
    expect(await handoffsFor(CUSTOMER)).toEqual([
      { id: key, status: 'pending' },
    ]);
    expect(sender.sendText).toHaveBeenCalledTimes(2);

    const marker = await markerFor(CUSTOMER);
    expect(marker?.present).toBe(true);
    expect(marker?.value).toMatchObject({ requestId: key });

    const resolved = await service.resolveReply({
      text: `HF-${key} NO_RESTOCK`,
      from: OPS,
    });
    expect(resolved.kind).toBe('resolved');

    expect(await handoffsFor(CUSTOMER)).toEqual([
      { id: key, status: 'resolved' },
    ]);
    const cleared = await markerFor(CUSTOMER);
    expect(cleared?.present).toBe(true);
    expect(cleared?.value).toBeNull();
    expect(await reservationsFor(CUSTOMER)).toEqual([
      { route: 'LEGACY_OPS', request_key: key, status: 'CLOSED' },
    ]);

    const again = await service.create(input(CUSTOMER));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.requestId).not.toBe(key);
    expect(await reservationsFor(CUSTOMER)).toEqual([
      { route: 'LEGACY_OPS', request_key: key, status: 'CLOSED' },
      {
        route: 'LEGACY_OPS',
        request_key: again.requestId,
        status: 'ACTIVE',
      },
    ]);
  });

  it('lets exactly one concurrent handoff win', async () => {
    // Deterministic barrier: both real PostgresConversationStore.get reads must
    // complete (each observing the actual null state) before either create is
    // released to reserve. A 10s timeout REJECTS the gate (it never releases a
    // lone caller), and every intercept is restored in `finally`.
    const originalGet = conversationStore.get;
    const observed: (ConversationState | null)[] = [];
    let release!: () => void;
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    const timer = setTimeout(
      () => fail(new Error('reservation barrier timed out')),
      10_000,
    );
    conversationStore.get = async (senderId: string) => {
      const state = await originalGet.call(conversationStore, senderId);
      if (observed.length < 2) {
        observed.push(state);
        if (observed.length === 2) release();
        await gate;
      }
      return state;
    };

    try {
      const [a, b] = await Promise.all([
        service.create(input(CUSTOMER)),
        service.create(input(CUSTOMER)),
      ]);
      expect(observed).toEqual([null, null]);
      const winner = [a, b].find((r) => r.ok);
      const loser = [a, b].find((r) => !r.ok);
      if (!winner || !winner.ok || !loser || loser.ok) {
        throw new Error('expected exactly one winner');
      }
      expect(loser).toEqual({
        ok: false,
        error: { kind: 'unavailable', retryable: false },
      });
      expect(loser).not.toHaveProperty('requestId');
      expect(loser).not.toHaveProperty('ref');

      expect(await handoffsFor(CUSTOMER)).toHaveLength(1);
      expect(await reservationsFor(CUSTOMER)).toEqual([
        {
          route: 'LEGACY_OPS',
          request_key: winner.requestId,
          status: 'ACTIVE',
        },
      ]);
      expect(sender.sendText).toHaveBeenCalledTimes(2);
    } finally {
      clearTimeout(timer);
      conversationStore.get = originalGet;
    }
  });

  it('keeps ACTIVE after a failed send and denies the retry', async () => {
    sender.sendText.mockRejectedValueOnce(new Error('meta down'));
    await expect(service.create(input(CUSTOMER))).rejects.toThrow('meta down');

    const first = await reservationsFor(CUSTOMER);
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('ACTIVE');

    const pending = await pool.query<{ id: string }>(
      `SELECT id FROM human_handoff_requests
       WHERE customer_id = $1 AND status = 'pending'`,
      [CUSTOMER],
    );
    expect(pending.rows).toHaveLength(1);
    expect(
      readPendingHumanRequest(await conversationStore.get(CUSTOMER)),
    ).toBeNull();

    const sends = sender.sendText.mock.calls.length;

    const retry = await service.create(input(CUSTOMER));
    expect(retry).toEqual({
      ok: false,
      error: { kind: 'unavailable', retryable: false },
    });
    expect(await handoffsFor(CUSTOMER)).toHaveLength(1);
    expect(await reservationsFor(CUSTOMER)).toHaveLength(1);
    expect(sender.sendText.mock.calls.length).toBe(sends);
    expect(
      readPendingHumanRequest(await conversationStore.get(CUSTOMER)),
    ).toBeNull();
  });
});
