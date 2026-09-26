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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function stage(sql: string): string {
  if (sql.includes('FOR UPDATE')) return 'lock';
  if (sql.includes('FROM human_decision_reservations')) return 'context';
  if (sql.startsWith('INSERT')) return 'insert';
  if (sql.includes('FROM restock_application_ledger')) return 'conflict';
  return sql;
}
const PATH = ['BEGIN', 'lock', 'context', 'insert', 'COMMIT'];

describe('extended preparation boundaries', () => {
  it.each([
    ['source case', { request_key: SOURCE.toLowerCase() }],
    ['backend', { backend_decision_id: PRODUCT }],
    ['sender', { sender_id: 'other' }],
    ['post timestamp', { post_attempted_at: END }],
    ['receipt timestamp', { receipt_recorded_at: END }],
    ['route', { route: 'OTHER' }],
    ['closed', { status: 'CLOSED' }],
    ['legacy', { post_state: 'LEGACY' }],
    ['nonrecorded', { post_state: 'POST_ATTEMPTED' }],
    ['unknown observation', { unknown_observed_at: NOW }],
    ['corrupt timestamp', { receipt_recorded_at: 'bad' }],
  ])('rejects context drift: %s', async (_name, change) => {
    const f = setup();
    Object.assign(f.contextRow, change);
    expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
    expect(f.sql().map(stage)).toEqual([
      'BEGIN',
      'lock',
      'context',
      'ROLLBACK',
    ]);
    expect(f.clock).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['subject', { productName: 'Other' }],
    ['supersedes', { supersedesDecisionId: PRODUCT }],
    ['raw uncanonical', { productName: ' Collar ' }],
    ['source case', { sourceRequestId: SOURCE.toLowerCase() }],
  ])('rejects detached intake drift: %s', async (_name, change) => {
    const f = setup();
    f.contextRow.intake = Object.assign({ ...f.contextRow.intake }, change);
    expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
    expect(f.sql().map(stage)).toEqual([
      'BEGIN',
      'lock',
      'context',
      'ROLLBACK',
    ]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['lock', { rows: [], rowCount: 0 }],
    ['lock', { rows: [{ sender_id: SENDER }], rowCount: NaN }],
    [
      'lock',
      { rows: [{ sender_id: SENDER }, { sender_id: SENDER }], rowCount: 2 },
    ],
    ['lock', { rows: [null], rowCount: 1 }],
    ['lock', { rows: [{ sender_id: 'wrong' }], rowCount: 1 }],
    ['context', { rows: [], rowCount: 0 }],
    ['context', { rows: [null], rowCount: 1 }],
    ['context', { rows: [], rowCount: 1 }],
  ])('holds malformed %s response %#', async (target, response) => {
    const f = setup();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) =>
      stage(sql) === target ? response : original(sql, values),
    );
    expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
    expect(f.sql().map(stage)).toEqual([
      ...PATH.slice(0, target === 'lock' ? 2 : 3),
      'ROLLBACK',
    ]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each(['byte-exact source', 'raw intake', 'candidate context'])(
    'does not repair %s before binding',
    async (kind) => {
      const f = setup();
      if (kind === 'byte-exact source') {
        f.contextRow.request_key = SOURCE.toLowerCase();
        f.contextRow.intake = {
          ...f.contextRow.intake,
          sourceRequestId: SOURCE.toLowerCase(),
        };
      } else if (kind === 'raw intake') {
        // Both copies agree, but normalization must not silently repair either.
        Object.assign(f.contextRow.intake, { productName: ' Collar ' });
      } else {
        Object.assign(f.candidate.context, { backendDecisionId: PRODUCT });
      }
      expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
      expect(f.sql().map(stage)).toEqual([...PATH.slice(0, 3), 'ROLLBACK']);
      expect(f.clock).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['', 'bad\u0001branch'])(
    'holds malformed branch %j before connect',
    async (branch) => {
      const f = setup();
      const store = new PostgresRestockApplicationPreparationStore(
        { connect: f.connect } as unknown as Pool,
        branch,
        f.clock,
      );
      expect(await store.preparePending(f.candidate)).toEqual(HOLD);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.query).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
    },
  );
  it.each(['action', 'sender', 'decision'])(
    'holds malformed candidate %s before connect',
    async (kind) => {
      const f = setup();
      if (kind === 'action') Object.assign(f.candidate, { action: 'hold' });
      if (kind === 'sender')
        Object.assign(f.candidate.context.reservation, {
          senderId: ' padded ',
        });
      if (kind === 'decision')
        Object.assign(f.candidate.decision, { id: 'bad' });
      expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
    },
  );
  it('accepts reordered context keys without repairing raw intake', async () => {
    const f = setup();
    Object.assign(f.candidate, {
      context: Object.fromEntries(
        Object.entries(f.candidate.context).reverse(),
      ),
    });
    f.contextRow.intake = Object.fromEntries(
      Object.entries(f.contextRow.intake).reverse(),
    ) as typeof f.contextRow.intake;
    expect(await f.store.preparePending(f.candidate)).toMatchObject({
      action: 'prepared',
    });
    expect(f.sql().map(stage)).toEqual(PATH);
  });
  it.each([
    'subject',
    'branch',
    'identity',
    'invalid clock',
    'before resolution',
  ])('ignores cached ready classification for %s', async (kind) => {
    const f = setup();
    if (kind === 'subject')
      Object.assign(f.candidate.decision.snapshot, { productName: 'Other' });
    if (kind === 'branch')
      Object.assign(f.candidate.decision.snapshot, { branchId: BRANCH.trim() });
    if (kind === 'identity')
      Object.assign(f.candidate.decision, { id: PRODUCT });
    if (kind === 'invalid clock') f.clock.mockReturnValue(new Date(NaN));
    if (kind === 'before resolution')
      f.clock.mockReturnValue(new Date(Date.parse(NOW) - 1));
    expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
    expect(f.sql().map(stage)).toEqual([
      'BEGIN',
      'lock',
      'context',
      'ROLLBACK',
    ]);
    expect(f.clock).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each(['connect', 'lock'])(
    'detaches nested authority before suspended %s',
    async (target) => {
      const f = setup();
      // Fixture intake aliases the candidate: separate the persisted PG row first.
      f.contextRow.intake = { ...f.contextRow.intake };
      const entered = deferred<void>();
      const resume = deferred<void>();
      const original = f.query.getMockImplementation()!;
      if (target === 'connect')
        f.connect.mockImplementation(async () => {
          entered.resolve();
          await resume.promise;
          return { query: f.query, release: f.release };
        });
      else
        f.query.mockImplementation(async (sql, values) => {
          if (stage(sql) === 'lock') {
            entered.resolve();
            await resume.promise;
          }
          return original(sql, values);
        });
      const pending = f.store.preparePending(f.candidate);
      await entered.promise;
      Object.assign(f.candidate.context.reservation, {
        senderId: 'changed',
        requestKey: PRODUCT,
      });
      Object.assign(f.candidate.context.reservation.intake, {
        productName: 'Changed',
      });
      Object.assign(f.candidate.decision.snapshot, {
        productName: 'Changed',
        branchId: 'changed',
      });
      Object.assign(f.candidate.decision.resolution, {
        resolvedAt: END,
        restockDays: 9,
      });
      Object.assign(f.candidate.decision, { id: PRODUCT, applyBefore: NOW });
      resume.resolve();
      expect(await pending).toMatchObject({
        action: 'prepared',
        row: {
          senderId: SENDER,
          sourceRequestId: SOURCE,
          decisionId: ID,
          branchId: BRANCH,
          resolvedAt: NOW,
          applyBefore: END,
        },
      });
      expect(f.query.mock.calls[1][1]).toEqual([SENDER]);
      expect(f.sql().map(stage)).toEqual(PATH);
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it('samples freshness only after a suspended locked read crosses expiry', async () => {
    const f = setup();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const original = f.query.getMockImplementation()!;
    let current = NOW;
    const events: string[] = [];
    f.clock.mockImplementation(() => {
      events.push('clock');
      return new Date(current);
    });
    f.query.mockImplementation(async (sql, values) => {
      if (stage(sql) === 'context') {
        entered.resolve();
        await resume.promise;
        events.push('read returned');
      }
      return original(sql, values);
    });
    const pending = f.store.preparePending(f.candidate);
    await entered.promise;
    expect(f.clock).not.toHaveBeenCalled();
    current = END;
    Object.assign(f.candidate.classification, { action: 'hold' });
    resume.resolve();
    const result = await pending;
    expect(events).toEqual(['read returned', 'clock']);
    expect(result).toMatchObject({
      action: 'prepared',
      row: { state: 'PENDING_DELIVERY' },
    });
    if (result.action === 'prepared')
      expect(result.row.attemptId).not.toBe(PRODUCT);
    expect(f.sql().map(stage)).toEqual(PATH);
  });
  it.each([false, true])(
    'awaits delayed COMMIT, rejection=%s',
    async (fails) => {
      const f = setup();
      const entered = deferred<void>();
      const commit = deferred<{ rows: unknown[]; rowCount: number }>();
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, values) => {
        if (sql === 'COMMIT') {
          entered.resolve();
          return commit.promise;
        }
        return original(sql, values);
      });
      let settled = false;
      const pending = f.store.preparePending(f.candidate).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      expect(settled).toBe(false);
      expect(f.release).not.toHaveBeenCalled();
      if (fails) commit.reject(new Error('private database detail'));
      else commit.resolve({ rows: [], rowCount: 0 });
      expect(await pending).toMatchObject({
        action: fails ? 'hold' : 'prepared',
      });
      expect(f.sql().map(stage)).toEqual(fails ? [...PATH, 'ROLLBACK'] : PATH);
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'connect',
    'BEGIN',
    'lock',
    'context',
    'insert',
    'conflict',
    'COMMIT',
  ])('bounds failure at %s without retry', async (target) => {
    const f = setup();
    const original = f.query.getMockImplementation()!;
    if (target === 'conflict') f.replay();
    if (target === 'connect')
      f.connect.mockRejectedValue(new Error('private detail'));
    f.query.mockImplementation(async (sql, values) => {
      if (stage(sql) === target) throw new Error('private detail');
      return original(sql, values);
    });
    expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
    const route =
      target === 'conflict' ? [...PATH.slice(0, 4), 'conflict'] : PATH;
    expect(f.sql().map(stage)).toEqual(
      target === 'connect'
        ? []
        : [...route.slice(0, route.indexOf(target) + 1), 'ROLLBACK'],
    );
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(target === 'connect' ? 0 : 1);
  });
  it.each(['committed', 'held', 'rollback failed'])(
    'bounds release failure after %s',
    async (kind) => {
      const f = setup();
      f.release.mockImplementation(() => {
        throw new Error('SECRET payload');
      });
      if (kind !== 'committed') f.mismatch();
      if (kind === 'rollback failed') f.faults.add('ROLLBACK');
      await expect(f.store.preparePending(f.candidate)).rejects.toThrow(
        new Error('restock preparation client release failed'),
      );
      expect(f.sql().map(stage)).toEqual(
        kind === 'committed' ? PATH : ['BEGIN', 'lock', 'ROLLBACK'],
      );
      expect(f.release).toHaveBeenCalledTimes(1);
      if (kind === 'rollback failed')
        expect(f.release).toHaveBeenCalledWith(
          new Error('restock preparation rollback failed'),
        );
      else expect(f.release).toHaveBeenCalledWith();
    },
  );
  it.each(['binding', 'corrupt'])(
    'rejects %s conflict ledger without overwrite',
    async (kind) => {
      const f = setup();
      f.replay();
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, values) => {
        const response = await original(sql, values);
        if (stage(sql) === 'conflict') {
          const row = response.rows[0] as Record<string, unknown>;
          if (kind === 'binding') {
            row.branch_id = 'other branch';
            Object.assign(row.row_data as object, { branchId: 'other branch' });
          } else row.row_data = { state: 'invalid' };
        }
        return response;
      });
      expect(await f.store.preparePending(f.candidate)).toEqual(HOLD);
      expect(f.sql().map(stage)).toEqual([
        ...PATH.slice(0, 4),
        'conflict',
        'ROLLBACK',
      ]);
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );
});

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
