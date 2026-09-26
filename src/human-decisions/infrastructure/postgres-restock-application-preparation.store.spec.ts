import type { Pool } from 'pg';
import type { RestockCandidateResult } from '../application/restock-application-candidate.service';
import { PostgresRestockApplicationPreparationStore } from './postgres-restock-application-preparation.store';

const NOW = '2026-06-22T12:00:00.000Z';
const END = '2026-06-22T13:00:00.000Z';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SOURCE = '848D8B89-B323-5A4F-952E-41EBCC00D733';
const PRODUCT = '99999999-9999-4999-8999-999999999999';
const SENDER = 'whatsapp:+5215500000001';
const BRANCH = ' trusted branch ';
const HOLD = { action: 'hold' };
type Candidate = Extract<RestockCandidateResult, { action: 'candidate' }>;
function setup() {
  const subject = {
    productId: PRODUCT,
    productName: 'Collar',
    variantId: null,
    sku: null,
    requestedQuantity: 2,
    observedStockAtRequest: 0,
    stockObservedAt: NOW,
  };
  const intake = {
    ...subject,
    sourceRequestId: SOURCE,
    type: 'RESTOCK' as const,
    supersedesDecisionId: null,
  };
  const candidate: Candidate = {
    action: 'candidate',
    context: {
      reservation: {
        status: 'ACTIVE',
        route: 'RESTOCK',
        senderId: SENDER,
        requestKey: SOURCE,
        intake,
      },
      backendDecisionId: ID,
      postAttemptedAt: NOW,
      receiptRecordedAt: NOW,
    },
    decision: {
      id: ID,
      sourceRequestId: SOURCE,
      type: 'RESTOCK',
      createdAt: NOW,
      supersedesDecisionId: null,
      snapshot: { ...subject, branchId: BRANCH, branchName: null },
      status: 'RESOLVED',
      version: 2,
      resolution: {
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 3,
        resolvedAt: NOW,
      },
      applyBefore: END,
    },
    classification: {
      action: 'ready',
      attemptId: PRODUCT,
      decisionId: PRODUCT,
    },
    checkedAt: 'ignored',
  };
  const contextRow = {
    sender_id: SENDER,
    route: 'RESTOCK',
    request_key: SOURCE,
    status: 'ACTIVE',
    intake,
    post_state: 'RECEIPT_RECORDED',
    backend_decision_id: ID,
    post_attempted_at: NOW,
    receipt_recorded_at: NOW,
    unknown_observed_at: null,
  };
  const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
  const empty = { rows: [], rowCount: 0 };
  const faults = new Set<string>();
  let replay = false;
  let progressed = false;
  let lockedSender = SENDER;
  let projection: Record<string, unknown>;
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    if (faults.has(sql)) throw new Error('database failure');
    if (sql.includes('FOR UPDATE')) return one({ sender_id: lockedSender });
    if (sql.includes('FROM human_decision_reservations'))
      return one(contextRow);
    if (sql.startsWith('INSERT')) {
      const row = JSON.parse(values![5] as string) as Record<string, unknown>;
      if (progressed)
        Object.assign(row, { state: 'STALE', staleObservedAt: END });
      projection = {
        decision_id: values![0],
        source_request_id: values![1],
        attempt_id: values![2],
        sender_id: values![3],
        branch_id: values![4],
        row_data: row,
        ack_receipt: null,
      };
      return replay ? empty : one(projection);
    }
    if (sql.includes('FROM restock_application_ledger')) return one(projection);
    return empty;
  });
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query, release });
  // Type-only mock: real stores/policy execute, no real PostgreSQL connection.
  const mockPool = { connect } as unknown as Pool;
  const clock = jest.fn(() => new Date(NOW));
  const store = new PostgresRestockApplicationPreparationStore(
    mockPool,
    BRANCH,
    clock,
  );
  return {
    candidate,
    contextRow,
    query,
    release,
    connect,
    clock,
    store,
    faults,
    replay: () => {
      replay = true;
    },
    progress: () => {
      replay = true;
      progressed = true;
    },
    mismatch: () => {
      lockedSender = 'another sender';
    },
    sql: () => query.mock.calls.map(([sql]) => sql),
  };
}

describe('unwired transactional pending preparation', () => {
  it.each([NOW, END])(
    'prepares pending at fresh time %s, never starts or expires',
    async (now) => {
      const f = setup();
      f.clock.mockReturnValue(new Date(now));
      const result = await f.store.preparePending(f.candidate);
      expect(result).toMatchObject({
        action: 'prepared',
        row: {
          state: 'PENDING_DELIVERY',
          sourceRequestId: SOURCE,
          branchId: BRANCH,
          decisionId: ID,
          senderId: SENDER,
          resolutionVersion: 2,
        },
      });
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.sql()).toEqual([
        'BEGIN',
        expect.stringContaining('FOR UPDATE'),
        expect.stringContaining('FROM human_decision_reservations'),
        expect.stringContaining('INSERT INTO restock_application_ledger'),
        'COMMIT',
      ]);
      expect(f.query.mock.calls[1]).toEqual([
        "SELECT sender_id FROM human_decision_reservations WHERE sender_id=$1 AND status='ACTIVE' FOR UPDATE",
        [SENDER],
      ]);
      expect(f.query.mock.calls[2][1]).toEqual([SENDER]);
      expect(f.clock.mock.invocationCallOrder[0]).toBeGreaterThan(
        f.query.mock.invocationCallOrder[2],
      );
      expect(f.release).toHaveBeenCalledWith();
    },
  );
  it('commits exact pending replay after one conflict INSERT and READ', async () => {
    const f = setup();
    f.replay();
    expect(await f.store.preparePending(f.candidate)).toMatchObject({
      action: 'prepared',
    });
    expect(f.sql().filter((sql) => sql.startsWith('INSERT'))).toHaveLength(1);
    expect(f.sql().slice(-2)).toEqual([
      expect.stringContaining('FROM restock_application_ledger'),
      'COMMIT',
    ]);
  });
  it.each(['reservation', 'context', 'progressed'])(
    'rolls back %s mismatch',
    async (kind) => {
      const f = setup();
      if (kind === 'reservation') f.mismatch();
      if (kind === 'context') f.contextRow.receipt_recorded_at = END;
      if (kind === 'progressed') f.progress();
      expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
      expect(f.sql().at(-1)).toBe('ROLLBACK');
      expect(f.sql()).not.toContain('COMMIT');
      expect(f.sql().some((sql) => sql.startsWith('INSERT'))).toBe(
        kind === 'progressed',
      );
      expect(f.release).toHaveBeenCalledWith();
    },
  );
  it.each([false, true])(
    'holds COMMIT uncertainty; poisoned rollback=%s',
    async (rollbackFails) => {
      const f = setup();
      f.faults.add('COMMIT');
      if (rollbackFails) f.faults.add('ROLLBACK');
      expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
      expect(f.sql().slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledTimes(1);
      if (rollbackFails)
        expect(f.release).toHaveBeenCalledWith(expect.any(Error));
      else expect(f.release).toHaveBeenCalledWith();
    },
  );
});
