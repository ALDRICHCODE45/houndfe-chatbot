import type { Pool, PoolClient } from 'pg';
import type { ExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import { PostgresExpirationApplicationPreparationStore } from './postgres-expiration-application-preparation.store';

const senderId = 'customer';
const branchId = ' branch ';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const productId = '44444444-4444-4444-8444-444444444444';
const at = '2026-06-23T08:00:00.000Z';
const deadline = '2026-06-24T08:00:00.000Z';
const hold = { action: 'hold' };
const fixture = () => ({
  action: 'candidate' as const,
  checkedAt: at,
  binding: {
    branchId,
    backendDecisionId: decisionId,
    postAttemptedAt: '2026-06-23T07:58:00.000Z',
    receiptRecordedAt: '2026-06-23T07:59:00.000Z',
    reservation: {
      status: 'ACTIVE' as const,
      route: 'EXPIRATION' as const,
      senderId,
      requestKey: sourceRequestId,
      intake: {
        sourceRequestId,
        type: 'EXPIRATION' as const,
        productId,
        variantId: null,
      },
    },
  },
  decision: {
    id: decisionId,
    sourceRequestId,
    type: 'EXPIRATION' as const,
    status: 'RESOLVED' as const,
    version: 2 as const,
    createdAt: at,
    snapshot: {
      branchId,
      branchName: null,
      productId,
      productName: 'Food',
      unit: 'PZA',
      variantId: null,
      variantName: null,
      variantOption: null,
      variantValue: null,
    },
    supersedesDecisionId: null,
    resolution: {
      action: 'PROVIDE_EXPIRATION_TEXT' as const,
      expirationText: 'Vence 03/2027',
      resolvedAt: at,
    },
    applyBefore: deadline,
  },
});
function harness() {
  const candidate = fixture();
  const b = candidate.binding;
  const recorded: Record<string, unknown> = {
    sender_id: senderId,
    route: 'EXPIRATION',
    request_key: sourceRequestId,
    status: 'ACTIVE',
    intake: { ...b.reservation.intake },
    post_state: 'RECEIPT_RECORDED',
    backend_decision_id: decisionId,
    post_attempted_at: b.postAttemptedAt,
    receipt_recorded_at: b.receiptRecordedAt,
    unknown_observed_at: null,
  };
  let stored: Record<string, unknown> | undefined;
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FOR UPDATE'))
      return { rowCount: 1, rows: [{ sender_id: senderId }] };
    if (sql.includes('FROM human_decision_reservations'))
      return { rowCount: 1, rows: [recorded] };
    if (sql.startsWith('INSERT')) {
      if (stored) return { rowCount: 0, rows: [] };
      const [
        decision_id,
        source_request_id,
        attempt_id,
        sender_id,
        branch_id,
        json,
      ] = values!;
      stored = {
        decision_id,
        source_request_id,
        attempt_id,
        sender_id,
        branch_id,
        row_data: JSON.parse(json as string) as unknown,
      };
      return { rowCount: 1, rows: [stored] };
    }
    if (sql.includes('FROM expiration_application_ledger'))
      return { rowCount: stored ? 1 : 0, rows: stored ? [stored] : [] };
    return { rowCount: 0, rows: [] };
  });
  const release = jest.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = jest.fn(async () => client);
  const poolQuery = jest.fn();
  const pool = { connect, query: poolQuery } as unknown as Pool;
  const clock = jest.fn(() => new Date(at));
  const store = new PostgresExpirationApplicationPreparationStore(
    pool,
    branchId,
    clock,
  );
  return {
    candidate,
    recorded,
    query,
    release,
    connect,
    poolQuery,
    pool,
    clock,
    store,
    stored: () => structuredClone(stored),
  };
}

describe('inactive EXPIRATION transactional preparation', () => {
  it('locks, rereads and inserts using one client; exact replay preserves the pending row', async () => {
    const h = harness();
    const first = await h.store.preparePending(h.candidate);
    expect(first).toMatchObject({
      action: 'prepared',
      row: {
        state: 'PENDING_DELIVERY',
        senderId,
        branchId,
        sourceRequestId,
        decisionId,
        resolvedAt: at,
        applyBefore: deadline,
      },
    });
    const before = h.stored();
    expect(await h.store.preparePending(h.candidate)).toEqual(first);
    expect(h.stored()).toEqual(before);
    expect(
      h.query.mock.calls.slice(0, 5).map(([sql]) => sql.split(' ')[0]),
    ).toEqual(['BEGIN', 'SELECT', 'SELECT', 'INSERT', 'COMMIT']);
    expect(h.query.mock.calls[1][0]).toContain("status='ACTIVE' FOR UPDATE");
    expect(h.query.mock.calls[1][1]).toEqual([senderId]);
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(
      h.query.mock.calls.some(([sql]) => /UPDATE |DELETE |ROLLBACK/.test(sql)),
    ).toBe(false);
  });
  it.each([false, true])(
    'expiration at the exact deadline holds, existing pending=%s',
    async (existing) => {
      const h = harness();
      if (existing) await h.store.preparePending(h.candidate);
      const before = h.stored();
      h.query.mockClear();
      h.clock.mockReturnValue(new Date(deadline));
      expect(await h.store.preparePending(h.candidate)).toEqual(hold);
      expect(h.stored()).toEqual(before);
      expect(
        h.query.mock.calls.some(([sql]) =>
          /INSERT|expiration_application_ledger|COMMIT/.test(sql),
        ),
      ).toBe(false);
      expect(h.query).toHaveBeenLastCalledWith('ROLLBACK');
    },
  );
  it.each([
    'post_attempted_at',
    'receipt_recorded_at',
    'backend_decision_id',
    'request_key',
    'intake',
  ])('rejects original context drift: %s', async (key) => {
    const h = harness();
    h.recorded[key] =
      key === 'intake'
        ? { ...h.candidate.binding.reservation.intake, productId: decisionId }
        : key.includes('_at')
          ? at
          : productId;
    expect(await h.store.preparePending(h.candidate)).toEqual(hold);
    expect(h.stored()).toBeUndefined();
    expect(h.clock).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
  it('requires exact configured branch, not a trimmed equivalent', async () => {
    const h = harness();
    const store = new PostgresExpirationApplicationPreparationStore(
      h.pool,
      branchId.trim(),
      h.clock,
    );
    expect(await store.preparePending(h.candidate)).toEqual(hold);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it('detaches original binding and decision before the first await', async () => {
    const h = harness();
    const result = h.store.preparePending(h.candidate);
    h.candidate.binding.receiptRecordedAt = deadline;
    h.candidate.binding.reservation.intake.productId = decisionId;
    h.candidate.decision.snapshot.branchId = 'changed';
    h.candidate.decision.applyBefore = at;
    expect(await result).toMatchObject({
      action: 'prepared',
      row: { branchId, applyBefore: deadline },
    });
  });
  it.each(['2026-06-23T07:59:59.999Z', 'invalid', deadline])(
    'samples the clock after the locked reread: %s',
    async (now) => {
      const h = harness();
      let queriesAtClock: string[] = [];
      h.clock.mockImplementation(() => {
        queriesAtClock = h.query.mock.calls.map(([sql]) => sql);
        return new Date(now);
      });
      expect(await h.store.preparePending(h.candidate)).toEqual(hold);
      expect(h.clock).toHaveBeenCalledTimes(1);
      expect(queriesAtClock).toEqual([
        'BEGIN',
        expect.stringContaining('FOR UPDATE'),
        expect.stringContaining('FROM human_decision_reservations'),
      ]);
      expect(h.stored()).toBeUndefined();
    },
  );
  it.each(['missing', 'wrong sender', 'bad count'])(
    'holds when lock evidence is %s',
    async (kind) => {
      const h = harness();
      h.query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({
          rowCount: kind === 'bad count' ? 2 : kind === 'missing' ? 0 : 1,
          rows: kind === 'missing' ? [] : [{ sender_id: 'other' }],
        });
      expect(await h.store.preparePending(h.candidate)).toEqual(hold);
      expect(h.query).toHaveBeenCalledTimes(3);
      expect(h.stored()).toBeUndefined();
    },
  );
  it.each([
    'BEGIN',
    'FOR UPDATE',
    'FROM human_decision_reservations',
    'INSERT',
    'COMMIT',
  ])('holds without retry after %s failure', async (point) => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => {
      if (sql.includes(point)) throw new Error('database detail');
      return execute(sql, values);
    });
    expect(await h.store.preparePending(h.candidate)).toEqual(hold);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(
      h.query.mock.calls.filter(([sql]) => sql.includes(point)),
    ).toHaveLength(1);
    expect(h.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed candidates before connecting', async () => {
    const h = harness();
    expect(
      await h.store.preparePending(
        null as unknown as ExpirationPreparationCandidate,
      ),
    ).toEqual(hold);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it('destroys the client after failed rollback; release errors are bounded', async () => {
    const h = harness();
    h.query.mockRejectedValue(new Error('private database detail'));
    expect(await h.store.preparePending(h.candidate)).toEqual(hold);
    expect(h.release).toHaveBeenCalledWith(expect.any(Error));
    h.release.mockImplementation(() => {
      throw new Error('private release detail');
    });
    await expect(h.store.preparePending(h.candidate)).rejects.toThrow(
      'expiration preparation client release failed',
    );
  });
});
