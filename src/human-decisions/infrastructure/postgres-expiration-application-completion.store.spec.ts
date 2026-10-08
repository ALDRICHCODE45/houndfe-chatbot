import type { Pool, PoolClient } from 'pg';
import { PostgresExpirationApplicationContextStore } from './postgres-expiration-application-context.store';
import { PostgresExpirationApplicationLedgerStore } from './postgres-expiration-application-ledger.store';
import { PostgresExpirationApplicationCompletionStore as Store } from './postgres-expiration-application-completion.store';
import { prepareExpirationApplicationCompletion } from '../domain/expiration-application-completion-preparation';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';

const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const source = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const start = '2026-09-25T10:00:00.000Z';
const end = '2026-09-26T10:00:00.000Z';
const hold = { action: 'hold' };
function harness(state: 'STALE' | 'PROVIDER_ACCEPTED' = 'STALE') {
  const intake = {
    sourceRequestId: source,
    type: 'EXPIRATION' as const,
    productId: id,
    variantId: null,
  };
  const reservation = {
    senderId: 'customer',
    route: 'EXPIRATION' as const,
    status: 'ACTIVE' as const,
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
    binding: {
      ...context,
      branchId: ' branch ',
      reservation: { ...reservation, intake: { ...intake } },
    },
    decision: {
      id,
      sourceRequestId: source,
      type: 'EXPIRATION' as const,
      status: 'RESOLVED' as const,
      version: 2 as const,
      createdAt: start,
      supersedesDecisionId: null,
      applyBefore: end,
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
    },
  };
  const row = {
    senderId: 'customer',
    branchId: ' branch ',
    sourceRequestId: source,
    decisionId: id,
    attemptId: deriveExpirationAttemptId(source, id)!,
    resolutionVersion: 2,
    resolvedAt: start,
    applyBefore: end,
    ...(state === 'STALE'
      ? { state, staleObservedAt: end }
      : {
          state,
          sendToken: id,
          attemptedAt: start,
          providerMessageId: 'opaque',
          providerAcceptedObservedAt: start,
        }),
  };
  const receipt = {
    id,
    version: 2,
    attemptId: row.attemptId,
    outcome: state,
    ackReceivedAt: end,
  };
  const durable = prepareExpirationApplicationCompletion(row, receipt);
  if (durable.action !== 'prepared') throw new Error('Fixture must prepare');
  const events: string[] = [];
  const query = jest.fn((sql: string, values?: unknown[]) => {
    const tag = sql.startsWith('UPDATE')
      ? 'cas'
      : sql.includes('FOR UPDATE')
        ? sql.includes('reservations')
          ? 'reservation'
          : 'ledger'
        : sql;
    events.push(tag);
    const rows =
      tag === 'reservation'
        ? [{ sender_id: values?.[0] }]
        : tag === 'ledger'
          ? [{ decision_id: id }]
          : tag === 'cas'
            ? [
                {
                  sender_id: 'customer',
                  route: 'EXPIRATION',
                  request_key: source,
                  status: 'CLOSED',
                  backend_decision_id: id,
                },
              ]
            : [];
    return Promise.resolve({ rowCount: rows.length, rows });
  });
  const readContext = jest
    .spyOn(
      PostgresExpirationApplicationContextStore.prototype,
      'readRecordedForSender',
    )
    .mockImplementation(async () => {
      events.push('context');
      return { action: 'recorded', context };
    });
  const readOutcome = jest
    .spyOn(
      PostgresExpirationApplicationLedgerStore.prototype,
      'readOutcomeByDecision',
    )
    .mockImplementation(async () => {
      events.push('outcome');
      return {
        action: 'foundOutcome',
        row: durable.expected,
        receipt: durable.receipt,
      };
    });
  const release = jest.fn();
  const connect = jest.fn(() =>
    Promise.resolve({ query, release } as unknown as PoolClient),
  );
  const store = new Store({ connect } as unknown as Pool, ' branch ');
  const run = () => store.closeAcknowledged(candidate, row, receipt);
  return {
    candidate,
    row,
    receipt,
    context,
    durable,
    events,
    query,
    readContext,
    readOutcome,
    release,
    connect,
    run,
    recover: () =>
      store.closeAcknowledged(
        {
          outcome: 'resolved',
          binding: candidate.binding,
          decision: candidate.decision,
        },
        row,
        receipt,
      ),
  };
}
afterEach(() => jest.restoreAllMocks());

describe('inactive transactional EXPIRATION completion (mocked PostgreSQL)', () => {
  it('closes recovered STALE without an in-window candidate after durable row/ACK locks', async () => {
    const h = harness();
    expect(await h.recover()).toEqual({ action: 'closed' });
    expect(h.events).toEqual([
      'BEGIN',
      'reservation',
      'context',
      'ledger',
      'outcome',
      'cas',
      'COMMIT',
    ]);
  });
  it('holds recovered STALE on durable ACK drift without closing', async () => {
    const h = harness();
    h.readOutcome.mockResolvedValue({
      action: 'foundOutcome',
      row: h.durable.expected,
      receipt: { ...h.durable.receipt, ackReceivedAt: start },
    });
    expect(await h.recover()).toEqual(hold);
    expect(h.events).not.toContain('cas');
    expect(h.events.at(-1)).toBe('ROLLBACK');
  });
  it.each(['STALE', 'PROVIDER_ACCEPTED'] as const)(
    'closes %s only after locked exact evidence and COMMIT',
    async (state) => {
      const h = harness(state);
      const result = await h.run();
      expect(result).toEqual({ action: 'closed' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(h.events).toEqual([
        'BEGIN',
        'reservation',
        'context',
        'ledger',
        'outcome',
        'cas',
        'COMMIT',
      ]);
      expect(h.readContext).toHaveBeenCalledWith('customer');
      expect(h.readOutcome).toHaveBeenCalledWith(id);
      const [sql, values] = h.query.mock.calls.find(([text]) =>
        text.startsWith('UPDATE'),
      )!;
      expect(sql).toContain("status = 'ACTIVE'");
      expect(sql).toContain("route = 'EXPIRATION'");
      expect(sql).toContain('intake = $4::jsonb');
      expect(values).toEqual([
        'customer',
        source,
        id,
        JSON.stringify(h.context.reservation.intake),
      ]);
      expect(h.release).toHaveBeenCalledWith();
    },
  );
  it.each(['branch', 'subject', 'late', 'ack', 'window'])(
    'rejects %s before acquiring a client',
    async (point) => {
      const h = harness('PROVIDER_ACCEPTED');
      if (point === 'branch') h.candidate.binding.branchId = 'other';
      if (point === 'subject') h.candidate.decision.snapshot.productId = source;
      if (point === 'late') {
        Object.assign(h.row, {
          state: 'PROVIDER_ACCEPTED_LATE',
          providerAcceptedObservedAt: end,
        });
        Object.assign(h.receipt, { outcome: 'PROVIDER_ACCEPTED_LATE' });
      }
      if (point === 'ack') h.receipt.id = source;
      if (point === 'window')
        Object.assign(h.row, {
          resolvedAt: '2026-09-24T10:00:00.000Z',
          applyBefore: start,
          attemptedAt: '2026-09-24T10:00:00.000Z',
          providerAcceptedObservedAt: '2026-09-24T10:00:00.000Z',
        });
      expect(await h.run()).toEqual(hold);
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    },
  );
  it.each(['context', 'row', 'receipt', 'absent-ack'])(
    'holds %s drift under locks without updating',
    async (point) => {
      const h = harness();
      if (point === 'context') h.context.receiptRecordedAt = end;
      h.readOutcome.mockResolvedValue({
        action: 'foundOutcome',
        row:
          point === 'row'
            ? { ...h.durable.expected, senderId: 'other' }
            : h.durable.expected,
        receipt:
          point === 'absent-ack'
            ? null
            : {
                ...h.durable.receipt,
                ...(point === 'receipt' ? { ackReceivedAt: start } : {}),
              },
      });
      expect(await h.run()).toEqual(hold);
      expect(h.events).not.toContain('cas');
      expect(h.events.at(-1)).toBe('ROLLBACK');
      expect(h.release).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'reservation',
    'ledger',
    'cas',
    'bad-return',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
  ])('holds without retry at %s failure', async (point) => {
    const h = harness();
    const execute = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => {
      const result = await execute(sql, values);
      const tag = h.events.at(-1);
      if (
        point === 'ROLLBACK' ||
        (tag === point && ['BEGIN', 'COMMIT'].includes(point))
      )
        throw new Error('private failure');
      if (tag === point) return { rowCount: 0, rows: [] };
      if (point === 'bad-return' && tag === 'cas')
        return { rowCount: 1, rows: [{ sender_id: 'other' }] };
      return result;
    });
    expect(await h.run()).toEqual(hold);
    expect(h.events.at(-1)).toBe('ROLLBACK');
    expect(h.events.filter((tag) => tag === 'cas').length).toBeLessThanOrEqual(
      1,
    );
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    if (point === 'ROLLBACK')
      expect(h.release).toHaveBeenCalledWith(expect.any(Error));
  });
  it('detaches inputs before connect and awaits COMMIT confirmation', async () => {
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
    const result = h.run().then((value) => {
      settled = true;
      return value;
    });
    h.candidate.binding.reservation.intake.productId = source;
    h.candidate.decision.snapshot.branchId = 'changed';
    h.row.senderId = 'changed';
    h.receipt.ackReceivedAt = start;
    await Promise.race([committing, result]);
    const early = settled;
    finish();
    expect(await result).toEqual({ action: 'closed' });
    expect(early).toBe(false);
  });
  it('sanitizes release failure after COMMIT without compensation', async () => {
    const h = harness();
    h.release.mockImplementation(() => {
      throw new Error('private release');
    });
    await expect(h.run()).rejects.toThrow(
      'expiration completion client release failed',
    );
    expect(h.events.at(-1)).toBe('COMMIT');
    expect(h.events).not.toContain('ROLLBACK');
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
});
