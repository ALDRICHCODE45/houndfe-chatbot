import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  type RestockIntakeInput,
  type RestockIntakeReceipt,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { PostgresRestockPostLedgerStore } from '../infrastructure/postgres-restock-post-ledger.store';
import { PostgresSharedReservationStore } from '../infrastructure/postgres-shared-reservation.store';
import type { RestockPostLedgerPort } from '../domain/restock-post-ledger';
import { RestockIntakeService } from './restock-intake.service';

/**
 * R3b3-c4b offline integration: REAL PostgresSharedReservationStore +
 * PostgresRestockPostLedgerStore + the inert RestockIntakeService with a FAKE
 * `submitRestockIntake` (no backend HTTP/Meta). Gated by RUN_DOCKER_TESTS=1; the
 * child `pnpm migrate` uses an explicit container `DATABASE_URL` only. The
 * caller supplies the same `sourceRequestId` manually, so this suite does NOT
 * prove a stable inbound-event id. Test-only against committed code: no
 * pre-implementation RED claim.
 */
const DOCKER = process.env.RUN_DOCKER_TESTS === '1';
const ddescribe = DOCKER ? describe : describe.skip;
const REPO_ROOT = join(__dirname, '..', '..', '..');

const SENDER = 'whatsapp:+5215500000001';
const OTHER = 'whatsapp:+5215500009999';
const LEGACY_KEY = 'a1b2c3d4e5f6';
const SOURCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const OTHER_PRODUCT = '66666666-6666-4666-8666-666666666666';
const DECISION = '33333333-3333-4333-8333-333333333333';
const BRANCH = '55555555-5555-4555-8555-555555555555';
const CREATED = '2026-06-23T12:00:00.000Z';

const intake = (o: Partial<RestockIntakeInput> = {}): RestockIntakeInput => ({
  sourceRequestId: SOURCE,
  type: 'RESTOCK',
  productId: PRODUCT,
  productName: 'Alimento premium',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
  ...o,
});
const receiptFor = (i: RestockIntakeInput): RestockIntakeReceipt => ({
  id: DECISION,
  sourceRequestId: i.sourceRequestId,
  type: 'RESTOCK',
  status: 'PENDING',
  version: 1,
  createdAt: CREATED,
  snapshot: {
    branchId: BRANCH,
    branchName: null,
    productId: i.productId,
    productName: i.productName,
    variantId: i.variantId,
    sku: i.sku,
    requestedQuantity: i.requestedQuantity,
    observedStockAtRequest: i.observedStockAtRequest,
    stockObservedAt: i.stockObservedAt,
  },
  supersedesDecisionId: i.supersedesDecisionId,
  resolution: null,
  applyBefore: null,
});

/** Wraps the real ledger so an ambiguous commit can be simulated precisely. */
class WrappingLedger implements RestockPostLedgerPort {
  constructor(
    private readonly inner: RestockPostLedgerPort,
    private readonly record: (
      inner: RestockPostLedgerPort,
      input: Parameters<RestockPostLedgerPort['recordReceipt']>[0],
    ) => Promise<Awaited<ReturnType<RestockPostLedgerPort['recordReceipt']>>>,
  ) {}
  beginPost(input: Parameters<RestockPostLedgerPort['beginPost']>[0]) {
    return this.inner.beginPost(input);
  }
  markUnknown(input: Parameters<RestockPostLedgerPort['markUnknown']>[0]) {
    return this.inner.markUnknown(input);
  }
  recordReceipt(input: Parameters<RestockPostLedgerPort['recordReceipt']>[0]) {
    return this.record(this.inner, input);
  }
}

ddescribe('RESTOCK intake coordinator (real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let reservations: PostgresSharedReservationStore;
  let ledger: PostgresRestockPostLedgerStore;
  let client: jest.Mocked<Pick<ChatbotApiClient, 'submitRestockIntake'>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    execFileSync('pnpm', ['migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    reservations = new PostgresSharedReservationStore(pool);
    ledger = new PostgresRestockPostLedgerStore(pool);
  });

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (container) await container.stop();
    }
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE human_decision_reservations, human_handoff_requests',
    );
    client = { submitRestockIntake: jest.fn() };
  });

  const serviceWith = (
    activeLedger: RestockPostLedgerPort = ledger,
  ): RestockIntakeService =>
    new RestockIntakeService(reservations, activeLedger, client);
  const ledgerRow = async (senderId = SENDER, requestKey = SOURCE) => {
    const { rows } = await pool.query<{
      post_state: string | null;
      backend_decision_id: string | null;
      post_attempted_at: Date | null;
      receipt_recorded_at: Date | null;
    }>(
      `SELECT post_state, backend_decision_id, post_attempted_at,
              receipt_recorded_at
       FROM human_decision_reservations
       WHERE sender_id = $1 AND route = 'RESTOCK' AND request_key = $2`,
      [senderId, requestKey],
    );
    return rows[0];
  };

  it('records durably before returning and replays the historical id', async () => {
    const i = intake();
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    const service = serviceWith();

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'recorded', historicalPollId: DECISION });
    const row = await ledgerRow();
    expect(row?.post_state).toBe('RECEIPT_RECORDED');
    expect(row?.backend_decision_id).toBe(DECISION);
    expect(row?.receipt_recorded_at).toBeInstanceOf(Date);
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
    expect(client.submitRestockIntake).toHaveBeenCalledWith(i);

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'existing', historicalPollId: DECISION });
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
    expect((await ledgerRow())?.backend_decision_id).toBe(DECISION);
  });

  it('posts at most once for concurrent identical calls', async () => {
    const i = intake();
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    const service = serviceWith();

    const [a, b] = await Promise.all([
      service.coordinate({ senderId: SENDER, intake: i }),
      service.coordinate({ senderId: SENDER, intake: i }),
    ]);
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
    expect([a, b].filter((o) => o.decision === 'recorded')).toHaveLength(1);
    const loser = [a, b].find((o) => o.decision !== 'recorded');
    expect(['hold', 'existing']).toContain(loser?.decision);
    expect((await ledgerRow())?.backend_decision_id).toBe(DECISION);
  });

  it('holds a durable UNKNOWN after a POST timeout or malformed receipt', async () => {
    const service = serviceWith();
    const timedOut = intake();
    client.submitRestockIntake.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      service.coordinate({ senderId: SENDER, intake: timedOut }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect((await ledgerRow())?.post_state).toBe('UNKNOWN');
    await expect(
      service.coordinate({ senderId: SENDER, intake: timedOut }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);

    const malformed = intake({
      sourceRequestId: OTHER_SOURCE,
      productId: OTHER_PRODUCT,
    });
    client.submitRestockIntake.mockResolvedValueOnce({
      ...receiptFor(malformed),
      status: 'RESOLVED',
    } as unknown as RestockIntakeReceipt);
    await expect(
      service.coordinate({ senderId: OTHER, intake: malformed }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect((await ledgerRow(OTHER, OTHER_SOURCE))?.post_state).toBe('UNKNOWN');
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(2);
  });

  it('returns existing only when an ambiguous commit is durably recorded', async () => {
    const i = intake();
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    const ambiguous = new WrappingLedger(ledger, async (inner, input) => {
      await inner.recordReceipt(input);
      throw new Error('ambiguous commit after the DB write');
    });
    const service = serviceWith(ambiguous);

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'existing', historicalPollId: DECISION });
    expect((await ledgerRow())?.backend_decision_id).toBe(DECISION);
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
  });

  it('holds record_unconfirmed when the record never committed', async () => {
    const i = intake();
    client.submitRestockIntake.mockResolvedValue(receiptFor(i));
    const failing = new WrappingLedger(ledger, async () => {
      throw new Error('ambiguous before commit');
    });
    const service = serviceWith(failing);

    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'hold', reason: 'record_unconfirmed' });
    const row = await ledgerRow();
    expect(row?.post_state).toBe('UNKNOWN');
    expect(row?.backend_decision_id).toBeNull();
    await expect(
      service.coordinate({ senderId: SENDER, intake: i }),
    ).resolves.toEqual({ decision: 'hold', reason: 'unknown_hold' });
    expect(client.submitRestockIntake).toHaveBeenCalledTimes(1);
  });

  it('suppresses RESTOCK while an ACTIVE LEGACY_OPS reservation exists', async () => {
    await expect(
      reservations.reserve({
        senderId: SENDER,
        route: 'LEGACY_OPS',
        requestKey: LEGACY_KEY,
        intake: null,
      }),
    ).resolves.toEqual({ action: 'claim', reason: 'single_sender_vacant' });
    const service = serviceWith();

    await expect(
      service.coordinate({ senderId: SENDER, intake: intake() }),
    ).resolves.toEqual({ decision: 'blocked', reason: 'occupied' });
    expect(client.submitRestockIntake).not.toHaveBeenCalled();
  });
});
