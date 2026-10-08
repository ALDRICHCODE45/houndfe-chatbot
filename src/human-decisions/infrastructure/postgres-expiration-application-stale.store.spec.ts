import type { Pool, PoolClient } from 'pg';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationStaleStore } from './postgres-expiration-application-stale.store';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';
import type { ExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import { createExpirationPreparationCandidate } from '../application/expiration-preparation-candidate';
import type { ExpirationExistingDecisionOutcome } from '../application/expiration-existing-decision.service';

const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const source = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const start = '2026-09-25T10:00:00.000Z';
const end = '2026-09-26T10:00:00.000Z';
const hold = { action: 'hold' };
function harness() {
  const intake = {
    sourceRequestId: source,
    type: 'EXPIRATION' as const,
    productId: id,
    variantId: null,
  };
  const reservation = {
    status: 'ACTIVE' as const,
    route: 'EXPIRATION' as const,
    senderId: 'customer',
    requestKey: source,
    intake,
  };
  const context = {
    reservation,
    backendDecisionId: id,
    postAttemptedAt: start,
    receiptRecordedAt: start,
  };
  const candidate = {
    action: 'candidate' as const,
    checkedAt: start,
    binding: { branchId: ' branch ', ...structuredClone(context) },
    decision: {
      id,
      sourceRequestId: source,
      type: 'EXPIRATION' as const,
      status: 'RESOLVED' as const,
      version: 2 as const,
      createdAt: start,
      supersedesDecisionId: null,
      snapshot: {
        branchId: ' branch ',
        branchName: null,
        productId: id,
        productName: 'Food',
        unit: 'PZA',
        variantId: null,
        variantName: null,
        variantOption: null,
        variantValue: null,
      },
      resolution: {
        action: 'PROVIDE_EXPIRATION_TEXT' as const,
        expirationText: 'March',
        resolvedAt: start,
      },
      applyBefore: end,
    },
  };
  // Local plain objects: strict domain normalizers reject cross-realm clones.
  candidate.binding.reservation = { ...reservation, intake: { ...intake } };
  let row: Record<string, unknown> = {
    state: 'PENDING_DELIVERY',
    senderId: 'customer',
    branchId: ' branch ',
    sourceRequestId: source,
    decisionId: id,
    resolutionVersion: 2,
    attemptId: deriveExpirationAttemptId(source, id),
    resolvedAt: start,
    applyBefore: end,
  };
  const expected = { ...row };
  const projection = () => ({
    decision_id: id,
    source_request_id: source,
    attempt_id: row.attemptId,
    sender_id: row.senderId,
    branch_id: row.branchId,
    row_data: { ...row },
  });
  const events: string[] = [];
  const query = jest.fn((sql: string, values?: unknown[]) => {
    const tag = sql.startsWith('UPDATE')
      ? 'cas'
      : sql.includes('FOR UPDATE')
        ? sql.includes('reservations')
          ? 'reservation-lock'
          : 'ledger-lock'
        : sql.startsWith('SELECT')
          ? 'pending'
          : sql;
    events.push(tag);
    if (tag === 'cas')
      row = JSON.parse(values![6] as string) as Record<string, unknown>;
    const rows =
      tag === 'reservation-lock'
        ? [{ sender_id: 'customer' }]
        : ['pending', 'ledger-lock', 'cas'].includes(tag)
          ? [projection()]
          : [];
    return Promise.resolve({ rowCount: rows.length, rows });
  });
  const read = jest
    .spyOn(
      PostgresExpirationApplicationContextStore.prototype,
      'readRecordedForSender',
    )
    .mockImplementation(() => {
      events.push('context');
      return Promise.resolve({ action: 'recorded', context });
    });
  const release = jest.fn();
  const connect = jest.fn(() =>
    Promise.resolve({ query, release } as unknown as PoolClient),
  );
  const pool = { connect } as unknown as Pool;
  const clock = jest.fn(() => {
    events.push('clock');
    return new Date(end);
  });
  const store = new PostgresExpirationApplicationStaleStore(
    pool,
    ' branch ',
    clock,
  );
  return {
    candidate,
    context,
    expected,
    row,
    events,
    query,
    read,
    release,
    connect,
    clock,
    store,
  };
}
afterEach(() => jest.restoreAllMocks());

describe('inactive transactional EXPIRATION STALE', () => {
  it('locks in claim order, samples time last, exact-CASes once and holds replay', async () => {
    const h = harness();
    const result = await h.store.expirePending(h.candidate);
    expect(result).toEqual({
      action: 'recordedStale',
      row: { ...h.expected, state: 'STALE', staleObservedAt: end },
    });
    expect(h.events).toEqual([
      'BEGIN',
      'reservation-lock',
      'context',
      'ledger-lock',
      'clock',
      'cas',
      'COMMIT',
    ]);
    const [sql, values] = h.query.mock.calls.find(([text]) =>
      text.startsWith('UPDATE'),
    )!;
    expect(sql).toMatch(
      /decision_id = \$1 AND source_request_id = \$2 AND attempt_id = \$3/,
    );
    expect(sql).toContain(
      'sender_id = $4 AND branch_id = $5 AND row_data = $6::jsonb',
    );
    expect(values).toEqual([
      id,
      source,
      h.expected.attemptId,
      'customer',
      ' branch ',
      JSON.stringify(h.expected),
      JSON.stringify({ ...h.expected, state: 'STALE', staleObservedAt: end }),
    ]);
    expect(h.read).toHaveBeenCalledWith('customer');
    expect(await h.store.expirePending(h.candidate)).toEqual(hold);
    expect(h.events.filter((tag) => tag === 'cas')).toHaveLength(1);
    expect(h.release).toHaveBeenCalledTimes(2);
  });
  it.each(['context', 'pending', 'branch', 'subject', 'started'])(
    'holds %s drift without CAS',
    async (point) => {
      const h = harness();
      if (point === 'context') h.context.receiptRecordedAt = end;
      if (point === 'pending') {
        h.row.resolvedAt = '2026-09-24T10:00:00.000Z';
        h.row.applyBefore = start;
      }
      if (point === 'branch') h.candidate.binding.branchId = 'branch';
      if (point === 'subject') h.candidate.decision.snapshot.productId = source;
      if (point === 'started')
        Object.assign(h.row, {
          state: 'SEND_STARTED',
          sendToken: id,
          attemptedAt: start,
        });
      expect(await h.store.expirePending(h.candidate)).toEqual(hold);
      expect(h.events).not.toContain('cas');
      expect(h.events).not.toContain('COMMIT');
      expect(h.release).toHaveBeenCalledTimes(point === 'branch' ? 0 : 1);
    },
  );
  it.each([
    start,
    '2026-09-26T09:59:59.999Z',
    end,
    '2026-09-26T10:00:00.001Z',
    'invalid',
  ])('reads fresh clock after both locks: %s', async (now) => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => {
      const result = await execute(sql, values);
      if (h.events.at(-1) === 'ledger-lock')
        h.clock.mockReturnValue(new Date(now));
      return result;
    });
    const expired = now === end || now.endsWith('00.001Z');
    expect((await h.store.expirePending(h.candidate)).action).toBe(
      expired ? 'recordedStale' : 'hold',
    );
    expect(h.events.includes('cas')).toBe(expired);
    expect(h.clock).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toBe(expired ? 'COMMIT' : 'ROLLBACK');
  });
  it('snapshots input before connect yields and waits for confirmed COMMIT', async () => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    let finish!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const committing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    h.query.mockImplementation(async (sql, values) => {
      const result = await execute(sql, values);
      if (sql === 'COMMIT') {
        reached();
        await gate;
      }
      return result;
    });
    let settled = false;
    const result = h.store.expirePending(h.candidate).then((value) => {
      settled = true;
      return value;
    });
    h.candidate.binding.reservation.intake.productId = source;
    h.candidate.decision.snapshot.branchId = 'changed';
    await Promise.race([committing, result]);
    const early = settled;
    finish();
    expect((await result).action).toBe('recordedStale');
    expect(early).toBe(false);
  });
  it('bounds release failure after commit without retry or compensation', async () => {
    const h = harness();
    h.release.mockImplementation(() => {
      throw new Error('private release detail');
    });
    await expect(h.store.expirePending(h.candidate)).rejects.toThrow(
      'expiration stale client release failed',
    );
    expect(h.events.at(-1)).toBe('COMMIT');
    expect(h.events).not.toContain('ROLLBACK');
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    'reservation-lock',
    'ledger-lock',
    'cas',
    'corrupt-return',
    'COMMIT',
    'ROLLBACK',
  ])('holds without retry at %s failure', async (point) => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => {
      const result = await execute(sql, values);
      const tag = h.events.at(-1);
      if (point === 'ROLLBACK') throw new Error('private');
      if (tag === point) {
        if (point === 'COMMIT') throw new Error('uncertain commit');
        return { rowCount: 0, rows: [] };
      }
      if (point === 'corrupt-return' && tag === 'cas')
        return {
          rowCount: 1,
          rows: [{ ...result.rows[0], sender_id: 'other' }],
        };
      return result;
    });
    expect(await h.store.expirePending(h.candidate)).toEqual(hold);
    expect(h.events.at(-1)).toBe('ROLLBACK');
    expect(h.events.filter((tag) => tag === 'cas').length).toBeLessThanOrEqual(
      1,
    );
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    if (point === 'ROLLBACK')
      expect(h.release).toHaveBeenCalledWith(expect.any(Error));
  });
  const evidence = (h: ReturnType<typeof harness>) =>
    ({
      outcome: 'resolved' as const,
      binding: h.candidate.binding,
      decision: h.candidate.decision,
    }) satisfies ExpirationExistingDecisionOutcome;

  it('records stale from trusted resolved evidence first consumed after expiry', async () => {
    const h = harness();
    // The in-window candidate factory cannot represent evidence consumed after
    // the window closed, so there is no candidate for this decision.
    expect(
      createExpirationPreparationCandidate('customer', evidence(h), end),
    ).toEqual(hold);
    expect(await h.store.expireResolvedOutcome(evidence(h))).toEqual({
      action: 'recordedStale',
      row: { ...h.expected, state: 'STALE', staleObservedAt: end },
    });
    expect(h.events).toEqual([
      'BEGIN',
      'reservation-lock',
      'context',
      'ledger-lock',
      'clock',
      'cas',
      'COMMIT',
    ]);
  });

  it.each([{ outcome: 'held' }, { outcome: 'query_failed' }] as const)(
    'new entry holds $outcome evidence without side effects',
    async (unresolved) => {
      const h = harness();
      expect(await h.store.expireResolvedOutcome(unresolved)).toEqual(hold);
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    },
  );

  it('new entry holds unresolved and mismatched resolved evidence', async () => {
    const h = harness();
    const pending = {
      ...evidence(h),
      decision: {
        ...h.candidate.decision,
        status: 'PENDING',
        version: 1,
        resolution: null,
        applyBefore: null,
      } as unknown as ReturnType<typeof evidence>['decision'],
    };
    expect(await h.store.expireResolvedOutcome(pending)).toEqual(hold);
    expect(h.connect).not.toHaveBeenCalled();
    const mismatched = {
      ...evidence(h),
      decision: { ...h.candidate.decision, id: source },
    };
    expect(await h.store.expireResolvedOutcome(mismatched)).toEqual(hold);
    expect(h.events).not.toContain('cas');
    expect(h.events.at(-1)).toBe('ROLLBACK');
  });

  it('new entry holds a within-window fresh clock without CAS', async () => {
    const h = harness();
    h.clock.mockReturnValue(new Date(start));
    expect(await h.store.expireResolvedOutcome(evidence(h))).toEqual(hold);
    expect(h.events).not.toContain('cas');
    expect(h.events.at(-1)).toBe('ROLLBACK');
  });

  it.each(['missing', 'started'] as const)(
    'new entry holds %s ledger without CAS',
    async (ledger) => {
      const h = harness();
      if (ledger === 'started')
        Object.assign(h.row, {
          state: 'SEND_STARTED',
          sendToken: id,
          attemptedAt: start,
        });
      const execute = h.query.getMockImplementation()!;
      h.query.mockImplementation(async (sql, values) => {
        if (
          ledger === 'missing' &&
          sql.includes('expiration_application_ledger') &&
          sql.includes('FOR UPDATE')
        )
          return { rowCount: 0, rows: [] };
        return execute(sql, values);
      });
      expect(await h.store.expireResolvedOutcome(evidence(h))).toEqual(hold);
      expect(h.events).not.toContain('cas');
      expect(h.events.at(-1)).toBe('ROLLBACK');
    },
  );

  it('both entries hold malformed arguments without side effects', async () => {
    const h = harness();
    expect(
      await h.store.expireResolvedOutcome(
        null as unknown as ExpirationExistingDecisionOutcome,
      ),
    ).toEqual(hold);
    expect(
      await h.store.expirePending(
        null as unknown as ExpirationPreparationCandidate,
      ),
    ).toEqual(hold);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});
