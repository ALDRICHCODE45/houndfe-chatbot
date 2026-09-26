import type { Pool } from 'pg';
import { deriveRestockAttemptId } from '../domain/restock-attempt-identity';
import { RestockApplicationCandidateService } from '../application/restock-application-candidate.service';
import { normalizeRestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import {
  bindRestockInboundEvidence,
  normalizeRestockInboundEvidence,
} from '../domain/restock-inbound-evidence';
import { PostgresRestockApplicationContextStore } from './postgres-restock-application-context.store';
import { PostgresRestockApplicationClaimStore } from './postgres-restock-application-claim.store';

const NOW = '2026-06-22T12:00:00.000Z';
const END = '2026-06-22T13:00:00.000Z';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TOKEN = '99999999-9999-4999-8999-999999999999';
const SENDER = 'whatsapp:+5215500000001';
const PHONE = '123456789';
const BRANCH = ' trusted branch ';
const EMPTY = { rows: [], rowCount: 0 };
function stage(sql: string): string {
  if (sql.includes('FROM conversation_state')) return 'conversation lock';
  if (sql.includes('active_count')) return 'markers';
  if (sql.includes('FOR UPDATE')) return 'reservation lock';
  if (sql.includes('FROM human_decision_reservations')) return 'context';
  if (sql.includes('FROM restock_inbound_evidence')) return 'evidence';
  if (sql.startsWith('UPDATE')) return 'CAS';
  return sql;
}
const PATH = (
  'BEGIN > reservation lock > context > evidence > conversation lock > ' +
  'markers > clock > CAS > COMMIT > release'
).split(' > ');
async function setup(now = NOW, failure = '') {
  const evidence = bindRestockInboundEvidence(
    {
      event: {
        receivingPhoneNumberId: PHONE,
        senderId: SENDER,
        messageId: 'wamid.core',
      },
      providerTimestampSeconds: String(Date.parse(NOW) / 1000),
      observedAt: NOW,
    },
    PHONE,
  )!;
  const subject = {
    productId: TOKEN,
    productName: 'Collar',
    variantId: null,
    sku: null,
    requestedQuantity: 2,
    observedStockAtRequest: 0,
    stockObservedAt: NOW,
  };
  const intake = {
    ...subject,
    sourceRequestId: evidence.sourceRequestId,
    type: 'RESTOCK',
    supersedesDecisionId: null,
  };
  const contextRow = {
    sender_id: SENDER,
    route: 'RESTOCK',
    request_key: evidence.sourceRequestId,
    status: 'ACTIVE',
    intake,
    post_state: 'RECEIPT_RECORDED',
    backend_decision_id: ID,
    post_attempted_at: NOW,
    receipt_recorded_at: NOW,
    unknown_observed_at: null,
  };
  const events: string[] = [];
  const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    const step = stage(sql);
    events.push(step);
    if (failure === step) throw new Error('private database detail');
    if (step === 'CAS' && failure === 'CAS zero') return EMPTY;
    if (step === 'reservation lock') return one({ sender_id: SENDER });
    if (step === 'context') return one(contextRow);
    if (step === 'evidence') return one(evidence);
    if (step === 'conversation lock')
      return one({ sender_id: SENDER, data: {} });
    if (step === 'markers')
      return one({
        active_count: 1,
        active_route: 'RESTOCK',
        legacy_pending: false,
      });
    if (step === 'CAS')
      return one({
        decision_id: values![0],
        source_request_id: values![1],
        attempt_id: values![2],
        sender_id: values![3],
        branch_id: values![4],
        row_data: JSON.parse(values![6] as string) as unknown,
        ack_receipt: null,
      });
    return EMPTY;
  });
  const release = jest.fn(() => {
    events.push('release');
  });
  const connect = jest.fn().mockResolvedValue({ query, release });
  const clock = jest.fn(() => {
    events.push('clock');
    return new Date(now);
  });
  const pool = { connect } as unknown as Pool;
  const candidate = await new RestockApplicationCandidateService(
    new PostgresRestockApplicationContextStore({ query } as unknown as Pool),
    {
      getRestockDecision: jest.fn().mockResolvedValue({
        id: ID,
        sourceRequestId: evidence.sourceRequestId,
        type: 'RESTOCK',
        createdAt: NOW,
        supersedesDecisionId: null,
        snapshot: { ...subject, branchId: BRANCH, branchName: null },
        status: 'RESOLVED',
        version: 2,
        applyBefore: END,
        resolution: {
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 3,
          resolvedAt: NOW,
        },
      }),
    },
    BRANCH,
    () => new Date(NOW),
  ).pollForSender(SENDER);
  if (candidate.action !== 'candidate')
    throw new Error('invalid candidate fixture');
  const pending = normalizeRestockApplicationLedgerRow({
    state: 'PENDING_DELIVERY',
    senderId: SENDER,
    sourceRequestId: evidence.sourceRequestId,
    branchId: BRANCH,
    decisionId: ID,
    resolutionVersion: 2,
    attemptId: candidate.classification.attemptId,
    resolvedAt: NOW,
    applyBefore: END,
  });
  if (pending?.state !== 'PENDING_DELIVERY')
    throw new Error('invalid pending fixture');
  expect(normalizeRestockInboundEvidence(evidence)).toEqual(evidence);
  events.length = 0;
  const store = new PostgresRestockApplicationClaimStore(
    pool,
    BRANCH,
    PHONE,
    clock,
  );
  // Caller inputs and mock DB projections must never share mutable authority.
  const input = {
    ...candidate,
    context: {
      ...candidate.context,
      reservation: {
        ...candidate.context.reservation,
        intake: { ...candidate.context.reservation.intake },
      },
    },
    decision: {
      ...candidate.decision,
      snapshot: { ...candidate.decision.snapshot },
      resolution: { ...candidate.decision.resolution },
    },
  };
  const expected = { ...pending };
  const claim = () => store.claimPending(input, expected, TOKEN);
  return {
    pending,
    evidence,
    events,
    connect,
    claim,
    input,
    expected,
    contextRow,
    query,
    release,
    clock,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function replaceRead(f: Fixture, step: string, row?: unknown) {
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    if (stage(sql) !== step) return original(sql, values);
    f.events.push(step);
    return row === undefined ? EMPTY : { rows: [row], rowCount: 1 };
  });
}
function heldThrough(f: Fixture, step: string) {
  expect(f.events).toEqual([
    ...PATH.slice(0, PATH.indexOf(step) + 1),
    'ROLLBACK',
    'release',
  ]);
  expect(f.connect).toHaveBeenCalledTimes(1);
}

describe('additional claim boundaries (mock SQL, not PostgreSQL proof)', () => {
  it('does not publish or release while COMMIT is unresolved', async () => {
    const f = await setup();
    const gate = deferred<typeof EMPTY>();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (sql !== 'COMMIT') return original(sql, values);
      f.events.push('COMMIT');
      return gate.promise;
    });
    let settled = false;
    const result = f.claim().then((value) => {
      settled = true;
      return value;
    });
    for (let turn = 0; turn < 40 && !f.events.includes('COMMIT'); turn++)
      await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.events).toEqual(PATH.slice(0, 9));
    expect(f.release).not.toHaveBeenCalled();
    gate.resolve(EMPTY);
    const started = await result;
    expect(started.action).toBe('started');
    expect(Object.isFrozen(started)).toBe(true);
    expect(f.events).toEqual(PATH);
  });
  it('detaches all caller authority before waiting for connect', async () => {
    const f = await setup();
    expect((await f.claim()).action).toBe('started');
    f.events.length = 0;
    const gate = deferred<{
      query: Fixture['query'];
      release: Fixture['release'];
    }>();
    f.connect.mockReturnValueOnce(gate.promise);
    const result = f.claim();
    Object.assign(f.input.context, { receiptRecordedAt: END });
    Object.assign(f.input.context.reservation, { requestKey: TOKEN });
    Object.assign(f.input.context.reservation.intake, {
      productName: 'Changed',
    });
    Object.assign(f.input.decision.snapshot, { branchId: 'other' });
    Object.assign(f.input.decision.resolution, { restockDays: 9 });
    Object.assign(f.expected, { branchId: 'other', resolvedAt: END });
    expect(f.events).toEqual([]);
    gate.resolve({ query: f.query, release: f.release });
    expect(await result).toMatchObject({
      action: 'started',
      row: { ...f.pending, state: 'SEND_STARTED' },
    });
    expect(f.events).toEqual(PATH);
  });
  it.each(['post', 'receipt', 'subject', 'source', 'backend'])(
    'rejects valid full-context %s drift before evidence',
    async (field) => {
      const f = await setup();
      expect((await f.claim()).action).toBe('started');
      if (field === 'post') f.contextRow.post_attempted_at = END;
      if (field === 'receipt') f.contextRow.receipt_recorded_at = END;
      if (field === 'subject') f.contextRow.intake.productName = 'Other collar';
      if (field === 'source') {
        f.contextRow.request_key = TOKEN;
        f.contextRow.intake.sourceRequestId = TOKEN;
      }
      if (field === 'backend') f.contextRow.backend_decision_id = TOKEN;
      expect(
        (
          await new PostgresRestockApplicationContextStore({
            query: f.query,
          } as unknown as Pool).readRecordedForSender(SENDER)
        ).action,
      ).toBe('recorded');
      f.events.length = 0;
      f.connect.mockClear();
      expect(await f.claim()).toEqual({ action: 'hold' });
      heldThrough(f, 'context');
    },
  );
  it.each(['senderId', 'messageId', 'receivingPhoneNumberId'])(
    'holds canonical alternate evidence %s before conversation reads',
    async (key) => {
      const f = await setup();
      const event = {
        senderId: SENDER,
        messageId: 'wamid.core',
        receivingPhoneNumberId: PHONE,
        [key]:
          key === 'receivingPhoneNumberId'
            ? '987654321'
            : key === 'senderId'
              ? 'whatsapp:+5215500000002'
              : 'wamid.other',
      };
      const alternate = bindRestockInboundEvidence(
        {
          event,
          providerTimestampSeconds: f.evidence.providerTimestampSeconds,
          observedAt: NOW,
        },
        event.receivingPhoneNumberId,
      );
      expect(alternate).not.toBeNull();
      expect(normalizeRestockInboundEvidence(alternate)).toEqual(alternate);
      expect(alternate!.sourceRequestId).not.toBe(f.evidence.sourceRequestId);
      if (key !== 'messageId') {
        // Keep source binding valid to reach the adapter's sender/channel gate.
        const source = alternate!.sourceRequestId;
        f.contextRow.request_key = source;
        f.contextRow.intake.sourceRequestId = source;
        Object.assign(f.input.context.reservation, { requestKey: source });
        Object.assign(f.input.context.reservation.intake, {
          sourceRequestId: source,
        });
        Object.assign(f.input.decision, { sourceRequestId: source });
      }
      replaceRead(f, 'evidence', alternate);
      expect(await f.claim()).toEqual({ action: 'hold' });
      heldThrough(f, 'evidence');
    },
  );
  it.each(['branch', 'id', 'resolved'])(
    'compares the whole valid expected pending row: %s',
    async (field) => {
      const f = await setup();
      const changed = {
        ...f.expected,
        ...(field === 'branch'
          ? { branchId: BRANCH.trim() }
          : field === 'id'
            ? {
                decisionId: TOKEN,
                attemptId: deriveRestockAttemptId(
                  f.expected.sourceRequestId,
                  TOKEN,
                )!,
              }
            : {
                resolvedAt: '2026-06-22T11:59:59.000Z',
                applyBefore: '2026-06-22T12:59:59.000Z',
              }),
      };
      expect(normalizeRestockApplicationLedgerRow(changed)).toEqual(changed);
      Object.assign(f.expected, changed);
      expect(await f.claim()).toEqual({ action: 'hold' });
      heldThrough(f, 'clock');
    },
  );
  it('preserves opaque configured branch bytes in policy', async () => {
    const f = await setup();
    Object.assign(f.input.decision.snapshot, { branchId: BRANCH.trim() });
    expect(await f.claim()).toEqual({ action: 'hold' });
    heldThrough(f, 'clock');
  });
  it('just inside provider 24h reaches stale CAS because applyBefore elapsed', async () => {
    const f = await setup('2026-06-23T11:59:59.999Z');
    expect(await f.claim()).toMatchObject({
      action: 'stale',
      row: { state: 'STALE' },
    });
    expect(f.events).toEqual(PATH);
  });
  it.each([
    'provider and observation future',
    'observation future',
    'clock before observation',
    'invalid clock',
    'throwing clock',
  ])('holds %s before CAS', async (kind) => {
    const f = await setup();
    if (kind.includes('future')) {
      const evidence = {
        ...f.evidence,
        observedAt: END,
        ...(kind.startsWith('provider')
          ? { providerTimestampSeconds: String(Date.parse(END) / 1000) }
          : {}),
      };
      expect(normalizeRestockInboundEvidence(evidence)).toEqual(evidence);
      replaceRead(f, 'evidence', evidence);
    }
    if (kind === 'clock before observation') {
      const earlier = {
        ...f.evidence,
        providerTimestampSeconds: String(Date.parse(NOW) / 1000 - 60),
      };
      expect(normalizeRestockInboundEvidence(earlier)).toEqual(earlier);
      replaceRead(f, 'evidence', earlier);
      f.clock.mockReturnValue(new Date(Date.parse(NOW) - 1));
    }
    if (kind === 'invalid clock') f.clock.mockReturnValue(new Date(NaN));
    if (kind === 'throwing clock')
      f.clock.mockImplementation(() => {
        throw new Error('private clock');
      });
    expect(await f.claim()).toEqual({ action: 'hold' });
    // Overridden clocks do not append the fixture's clock event.
    heldThrough(f, kind.includes('future') ? 'clock' : 'markers');
    expect(f.clock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['reservation lock', undefined],
    ['context', undefined],
    ['evidence', undefined],
    ['conversation lock', undefined],
    [
      'conversation lock',
      { sender_id: SENDER, data: { pendingHumanRequest: {} } },
    ],
    [
      'markers',
      { active_count: 2, active_route: 'RESTOCK', legacy_pending: false },
    ],
    [
      'markers',
      { active_count: 1, active_route: 'RESTOCK', legacy_pending: true },
    ],
    ['CAS', undefined],
  ])(
    'holds missing/colliding/advanced state at %s without later queries',
    async (step, row) => {
      const f = await setup();
      // A zero-row CAS models a predicate miss (including an advanced ledger),
      // not a fabricated RETURNING projection claiming persisted history.
      replaceRead(f, step, row);
      expect(await f.claim()).toEqual({ action: 'hold' });
      heldThrough(f, step);
    },
  );
  it.each(['connect', 'BEGIN', 'context', 'evidence', 'CAS'])(
    'bounds %s failure without retry',
    async (step) => {
      const f = await setup();
      const original = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, values) => {
        if (stage(sql) !== step) return original(sql, values);
        f.events.push(step);
        throw new Error('private database');
      });
      if (step === 'connect')
        f.connect.mockRejectedValue(new Error('private connection'));
      expect(await f.claim()).toEqual({ action: 'hold' });
      if (step === 'connect') {
        expect(f.events).toEqual([]);
        expect(f.release).not.toHaveBeenCalled();
        expect(f.connect).toHaveBeenCalledTimes(1);
      } else heldThrough(f, step);
    },
  );
  it('poisons release with a bounded error when rollback fails', async () => {
    const f = await setup(NOW, 'ROLLBACK');
    replaceRead(f, 'reservation lock');
    expect(await f.claim()).toEqual({ action: 'hold' });
    expect(f.release).toHaveBeenCalledWith(
      new Error('restock claim rollback failed'),
    );
    heldThrough(f, 'reservation lock');
  });
  it('rejects bounded release failure after COMMIT without rollback or success', async () => {
    const f = await setup();
    f.release.mockImplementation(() => {
      f.events.push('release');
      throw new Error('private release');
    });
    await expect(f.claim()).rejects.toThrow(
      'restock claim client release failed',
    );
    expect(f.events).toEqual(PATH);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith();
  });
});

describe('unwired guarded pending claim', () => {
  it('holds at the exact original-event 24h boundary before CAS', async () => {
    const f = await setup('2026-06-23T12:00:00.000Z');
    expect(await f.claim()).toEqual({ action: 'hold' });
    expect(f.events).toEqual([...PATH.slice(0, 7), 'ROLLBACK', 'release']);
  });
  it.each([
    [NOW, 'started', 'SEND_STARTED'],
    [END, 'stale', 'STALE'],
  ])(
    'claims at %s only after retained-client reads and commit',
    async (now, action, state) => {
      const f = await setup(now);
      const result = await f.claim();
      expect(result).toMatchObject({
        action,
        row: { ...f.pending, state },
        evidence: f.evidence,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(f.events).toEqual(PATH);
      expect(f.connect).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['CAS zero', 'COMMIT'])(
    'holds %s without retry or reread',
    async (failure) => {
      const f = await setup(NOW, failure);
      expect(await f.claim()).toEqual({ action: 'hold' });
      expect(f.events).toEqual([
        ...PATH.slice(0, failure === 'COMMIT' ? 9 : 8),
        'ROLLBACK',
        'release',
      ]);
      expect(f.connect).toHaveBeenCalledTimes(1);
    },
  );
});
