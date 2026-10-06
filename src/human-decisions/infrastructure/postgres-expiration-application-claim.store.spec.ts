import type { Pool, PoolClient } from 'pg';
import type { ExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import { PostgresExpirationApplicationClaimStore } from './postgres-expiration-application-claim.store';

const senderId = 'customer';
const branchId = ' branch ';
const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const productId = '44444444-4444-4444-8444-444444444444';
const sendToken = '55555555-5555-4555-8555-555555555555';
const at = '2026-06-23T08:00:00.000Z';
const deadline = '2026-06-24T08:00:00.000Z';
const hold = { action: 'hold' };
function harness() {
  const intake = {
    sourceRequestId,
    type: 'EXPIRATION' as const,
    productId,
    variantId: null,
  };
  const candidate = {
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
        intake,
      },
    },
    decision: {
      id: decisionId,
      sourceRequestId,
      type: 'EXPIRATION' as const,
      status: 'RESOLVED' as const,
      version: 2 as const,
      createdAt: at,
      supersedesDecisionId: null,
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
      resolution: {
        action: 'PROVIDE_EXPIRATION_TEXT' as const,
        expirationText: 'Vence 03/2027',
        resolvedAt: at,
      },
      applyBefore: deadline,
    },
  };
  const recorded: Record<string, unknown> = {
    sender_id: senderId,
    route: 'EXPIRATION',
    request_key: sourceRequestId,
    status: 'ACTIVE',
    intake: { ...intake },
    post_state: 'RECEIPT_RECORDED',
    backend_decision_id: decisionId,
    post_attempted_at: candidate.binding.postAttemptedAt,
    receipt_recorded_at: candidate.binding.receiptRecordedAt,
    unknown_observed_at: null,
  };
  let row: Record<string, unknown> = {
    state: 'PENDING_DELIVERY',
    senderId,
    branchId,
    sourceRequestId,
    decisionId,
    resolutionVersion: 2,
    attemptId: deriveExpirationAttemptId(sourceRequestId, decisionId),
    resolvedAt: at,
    applyBefore: deadline,
  };
  const projection = () => ({
    decision_id: decisionId,
    source_request_id: sourceRequestId,
    attempt_id: row.attemptId,
    sender_id: row.senderId,
    branch_id: row.branchId,
    row_data: { ...row },
  });
  const events: string[] = [];
  const query = jest.fn((sql: string, values?: unknown[]) => {
    let tag = sql;
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM human_decision_reservations')) {
      tag = sql.includes('FOR UPDATE') ? 'reservation-lock' : 'context';
      rows =
        tag === 'reservation-lock' ? [{ sender_id: senderId }] : [recorded];
    } else if (sql.includes('FROM expiration_application_ledger')) {
      tag = sql.includes('FOR UPDATE') ? 'ledger-lock' : 'pending';
      rows = [projection()];
    } else if (sql.startsWith('UPDATE')) {
      tag = 'cas';
      row = JSON.parse(values![6] as string) as Record<string, unknown>;
      rows = [projection()];
    }
    events.push(tag);
    return Promise.resolve({ rowCount: rows.length, rows });
  });
  const release = jest.fn();
  const connect = jest.fn(() =>
    Promise.resolve({ query, release } as unknown as PoolClient),
  );
  const poolQuery = jest.fn();
  const pool = { connect, query: poolQuery } as unknown as Pool;
  const clock = jest.fn(() => {
    events.push('clock');
    return new Date(at);
  });
  const token = jest.fn(() => sendToken);
  const store = new PostgresExpirationApplicationClaimStore(
    pool,
    branchId,
    clock,
    token,
  );
  return {
    candidate,
    recorded,
    row,
    events,
    query,
    release,
    connect,
    poolQuery,
    clock,
    token,
    pool,
    store,
  };
}

describe('inactive EXPIRATION transactional claim', () => {
  it('claims once on one client, after both locks and fresh clock; replay holds', async () => {
    const h = harness();
    const result = await h.store.claimPending(h.candidate);
    expect(result).toEqual({
      action: 'claimed',
      row: { ...h.row, state: 'SEND_STARTED', sendToken, attemptedAt: at },
    });
    expect(h.events).toEqual([
      'BEGIN',
      'reservation-lock',
      'context',
      'ledger-lock',
      'pending',
      'clock',
      'cas',
      'COMMIT',
    ]);
    expect(h.query.mock.calls[1][0]).toContain("status='ACTIVE' FOR UPDATE");
    expect(h.query.mock.calls[1][1]).toEqual([senderId]);
    expect(h.query.mock.calls[3][1]).toEqual([decisionId]);
    expect(await h.store.claimPending(h.candidate)).toEqual(hold);
    expect(h.events.filter((event) => event === 'cas')).toHaveLength(1);
    expect(h.token).toHaveBeenCalledTimes(1);
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(2);
  });
  it.each([
    'post_attempted_at',
    'receipt_recorded_at',
    'backend_decision_id',
    'request_key',
    'intake',
    'status',
  ])('holds on original context drift: %s', async (key) => {
    const h = harness();
    h.recorded[key] = key.endsWith('_at') ? at : 'changed';
    expect(await h.store.claimPending(h.candidate)).toEqual(hold);
    expect(h.events).toEqual([
      'BEGIN',
      'reservation-lock',
      'context',
      'ROLLBACK',
    ]);
    expect(h.clock).not.toHaveBeenCalled();
  });
  it.each(['senderId', 'branchId', 'resolvedAt', 'state'])(
    'holds on mismatched pending: %s',
    async (key) => {
      const h = harness();
      h.row[key] = key === 'resolvedAt' ? '2026-06-22T08:00:00.000Z' : 'other';
      // Keep a valid 24h row so equality, not shape validation, rejects drift.
      if (key === 'resolvedAt') h.row.applyBefore = at;
      expect(await h.store.claimPending(h.candidate)).toEqual(hold);
      expect(h.events).toContain('ledger-lock');
      expect(h.events).not.toContain('cas');
      expect(h.events.at(-1)).toBe('ROLLBACK');
    },
  );
  it.each([at, '2026-06-23T07:59:59.999Z', deadline, 'invalid'])(
    'samples time after ledger lock resolves: %s',
    async (now) => {
      const h = harness();
      const execute = h.query.getMockImplementation()!;
      h.query.mockImplementation(async (sql, values) => {
        const result = await execute(sql, values);
        if (
          sql.includes('expiration_application_ledger') &&
          sql.includes('FOR UPDATE')
        )
          h.clock.mockReturnValue(new Date(now));
        return result;
      });
      const result = await h.store.claimPending(h.candidate);
      expect(result.action).toBe(now === at ? 'claimed' : 'hold');
      expect(h.clock).toHaveBeenCalledTimes(1);
      expect(h.events.includes('cas')).toBe(now === at);
      expect(h.events.at(-1)).toBe(now === at ? 'COMMIT' : 'ROLLBACK');
    },
  );
  it('detaches candidate before connect yields and requires exact configured branch', async () => {
    const h = harness();
    const result = h.store.claimPending(h.candidate);
    h.candidate.binding.receiptRecordedAt = deadline;
    h.candidate.binding.reservation.intake.productId = decisionId;
    h.candidate.decision.snapshot.branchId = 'changed';
    expect((await result).action).toBe('claimed');
    const other = new PostgresExpirationApplicationClaimStore(
      h.pool,
      branchId.trim(),
      h.clock,
      h.token,
    );
    expect(await other.claimPending(h.candidate)).toEqual(hold);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
  it.each(['reservation-lock', 'ledger-lock', 'cas'])(
    'holds when %s returns zero rows',
    async (point) => {
      const h = harness();
      const execute = h.query.getMockImplementation()!;
      h.query.mockImplementation(async (sql, values) => {
        const result = await execute(sql, values);
        return h.events.at(-1) === point ? { rowCount: 0, rows: [] } : result;
      });
      expect(await h.store.claimPending(h.candidate)).toEqual(hold);
      expect(h.events.at(-1)).toBe('ROLLBACK');
      expect(h.events).not.toContain('COMMIT');
      expect(h.events.filter((event) => event === point)).toHaveLength(1);
    },
  );
  it.each([
    'BEGIN',
    'reservation-lock',
    'context',
    'ledger-lock',
    'pending',
    'cas',
    'COMMIT',
  ])('holds without retry after %s failure', async (point) => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => {
      const result = await execute(sql, values);
      if (h.events.at(-1) === point) throw new Error('private database detail');
      return result;
    });
    expect(await h.store.claimPending(h.candidate)).toEqual(hold);
    expect(h.events.filter((event) => event === point)).toHaveLength(1);
    expect(h.events.at(-1)).toBe('ROLLBACK');
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it('requires confirmed COMMIT before exposing a claim', async () => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let commitReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      commitReached = resolve;
    });
    h.query.mockImplementation(async (sql, values) => {
      const result = await execute(sql, values);
      if (sql === 'COMMIT') {
        commitReached();
        await gate;
      }
      return result;
    });
    let settled = false;
    const result = h.store.claimPending(h.candidate).then((value) => {
      settled = true;
      return value;
    });
    // A regression that returns early must fail promptly, not hang this test.
    await Promise.race([reached, result]);
    const settledBeforeCommit = settled;
    finish();
    expect((await result).action).toBe('claimed');
    expect(h.events).toContain('COMMIT');
    expect(settledBeforeCommit).toBe(false);
  });
  it('rejects malformed input and tokens without database writes', async () => {
    const h = harness();
    expect(
      await h.store.claimPending(
        null as unknown as ExpirationPreparationCandidate,
      ),
    ).toEqual(hold);
    expect(h.connect).not.toHaveBeenCalled();
    h.token.mockReturnValue('invalid');
    expect(await h.store.claimPending(h.candidate)).toEqual(hold);
    expect(h.events).not.toContain('cas');
    expect(h.events.at(-1)).toBe('ROLLBACK');
  });
  it('poisons failed rollback clients and bounds release errors', async () => {
    const h = harness();
    h.query.mockRejectedValue(new Error('private detail'));
    expect(await h.store.claimPending(h.candidate)).toEqual(hold);
    expect(h.release).toHaveBeenCalledWith(expect.any(Error));
    h.release.mockImplementation(() => {
      throw new Error('private release');
    });
    await expect(h.store.claimPending(h.candidate)).rejects.toThrow(
      'expiration claim client release failed',
    );
  });
});
