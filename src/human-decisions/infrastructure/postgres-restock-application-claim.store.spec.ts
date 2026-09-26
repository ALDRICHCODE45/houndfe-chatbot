import type { Pool } from 'pg';
import { RestockApplicationCandidateService } from '../application/restock-application-candidate.service';
import { normalizeRestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import { bindRestockInboundEvidence } from '../domain/restock-inbound-evidence';
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
  events.length = 0;
  const store = new PostgresRestockApplicationClaimStore(
    pool,
    BRANCH,
    PHONE,
    clock,
  );
  const claim = () => store.claimPending(candidate, pending, TOKEN);
  return { pending, evidence, events, connect, claim };
}

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
