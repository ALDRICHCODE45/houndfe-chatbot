import {
  normalizeRestockDecision,
  normalizeRestockIntake,
  normalizeRestockApplicationOutcomeAck,
  type RestockResolution,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { bindRestockInboundEvidence } from '../domain/restock-inbound-evidence';
import { classifyRestockApplication } from '../domain/restock-application-policy';
import { normalizeRestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import { classifyRestockApplicationStart } from '../domain/restock-application-ledger-start';
import { classifyRestockApplicationAcceptance } from '../domain/restock-application-ledger-acceptance';
import { prepareRestockApplicationOutcome } from '../domain/restock-application-ledger-ack-preparation';
import { classifyRestockApplicationAckRecord } from '../domain/restock-application-ledger-ack-record';
import type { RestockApplicationLedgerRow } from '../domain/restock-application-ledger-row';
import type { RestockCandidateResult } from './restock-application-candidate.service';

const SENDER = 'whatsapp:+5215500000001';
const PHONE = '123456789';
const BRANCH = 'branch-fixture';
const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-06-22T12:00:00.000Z';
const ACCEPTED_AT = '2026-06-22T12:00:01.000Z';
const END = '2026-06-22T13:00:00.000Z';
const ACTIONS = [
  'PROVIDE_RESTOCK_ESTIMATE',
  'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
] as const satisfies readonly RestockResolution['action'][];

function present<T>(value: T | null): T {
  expect(value).not.toBeNull();
  if (value === null) throw new Error('invalid fixture');
  return value;
}

// Synthetic contract snapshots: not authentication, durable history, provider
// acceptance, claim ownership or permission to send/report. No I/O occurs here.
function fixture(action: RestockResolution['action'] = ACTIONS[0]) {
  const evidence = present(
    bindRestockInboundEvidence(
      {
        event: {
          senderId: SENDER,
          receivingPhoneNumberId: PHONE,
          messageId: 'wamid.synthetic-inbound',
        },
        providerTimestampSeconds: String(Date.parse(NOW) / 1000),
        observedAt: NOW,
      },
      PHONE,
    ),
  );
  const subject = {
    productId: '99999999-9999-4999-8999-999999999999',
    productName: 'Collar',
    variantId: null,
    sku: 'COL-01',
    requestedQuantity: 2,
    observedStockAtRequest: 0,
    stockObservedAt: NOW,
  };
  const intake = Object.freeze(
    present(
      normalizeRestockIntake({
        ...subject,
        sourceRequestId: evidence.sourceRequestId,
        type: 'RESTOCK',
        supersedesDecisionId: null,
      }),
    ),
  );
  const context = Object.freeze({
    reservation: Object.freeze({
      status: 'ACTIVE' as const,
      route: 'RESTOCK' as const,
      senderId: SENDER,
      requestKey: evidence.sourceRequestId,
      intake,
    }),
    backendDecisionId: ID,
    postAttemptedAt: NOW,
    receiptRecordedAt: NOW,
  });
  const decision = present(
    normalizeRestockDecision({
      id: ID,
      sourceRequestId: evidence.sourceRequestId,
      type: 'RESTOCK',
      createdAt: NOW,
      snapshot: { ...subject, branchId: BRANCH, branchName: null },
      supersedesDecisionId: null,
      status: 'RESOLVED',
      version: 2,
      resolution:
        action === 'PROVIDE_RESTOCK_ESTIMATE'
          ? { action, restockDays: 3, resolvedAt: NOW }
          : { action, resolvedAt: NOW },
      applyBefore: END,
    }),
  );
  expect(decision.status).toBe('RESOLVED');
  if (decision.status !== 'RESOLVED') throw new Error('not resolved');
  Object.freeze(decision.snapshot);
  Object.freeze(decision.resolution);
  Object.freeze(decision);
  const policyInput = Object.freeze({
    senderId: SENDER,
    branchId: BRANCH,
    reservation: context.reservation,
    backendDecisionId: ID,
    decision,
    now: NOW,
  });
  const classification = Object.freeze(classifyRestockApplication(policyInput));
  expect(classification.action).toBe('ready');
  if (classification.action !== 'ready') throw new Error('not ready');
  const candidate = Object.freeze({
    action: 'candidate',
    context,
    decision,
    classification,
    checkedAt: NOW,
  } as const satisfies RestockCandidateResult);
  const pending = present(
    normalizeRestockApplicationLedgerRow({
      state: 'PENDING_DELIVERY',
      senderId: SENDER,
      sourceRequestId: evidence.sourceRequestId,
      branchId: BRANCH,
      decisionId: ID,
      resolutionVersion: 2,
      attemptId: classification.attemptId,
      resolvedAt: NOW,
      applyBefore: END,
    }),
  );
  expect(pending.state).toBe('PENDING_DELIVERY');
  if (pending.state !== 'PENDING_DELIVERY') throw new Error('not pending');
  const start = classifyRestockApplicationStart({
    row: pending,
    event: { kind: 'begin_send', sendToken: TOKEN, attemptedAt: NOW },
  });
  expect(start.action).toBe('propose_cas');
  if (start.action !== 'propose_cas' || start.next.state !== 'SEND_STARTED')
    throw new Error('not started');
  const started = start.next;
  const expire = classifyRestockApplicationStart({
    row: pending,
    event: { kind: 'expire_unsent', observedAt: END },
  });
  expect(expire.action).toBe('propose_cas');
  if (expire.action !== 'propose_cas' || expire.next.state !== 'STALE')
    throw new Error('not stale');
  const providerReceipt = Object.freeze({
    providerMessageId: 'wamid.synthetic-outbound',
  });
  function acceptance(providerAcceptedObservedAt: string) {
    const event = Object.freeze({
      kind: 'provider_accepted' as const,
      attemptId: pending.attemptId,
      sendToken: TOKEN,
      providerMessageId: providerReceipt.providerMessageId,
      providerAcceptedObservedAt,
    });
    const result = classifyRestockApplicationAcceptance({
      row: started,
      event,
    });
    expect(result.action).toBe('propose_cas');
    if (result.action !== 'propose_cas') throw new Error('not accepted');
    return Object.freeze({ event, row: result.next });
  }
  return Object.freeze({
    candidate,
    policyInput,
    evidence,
    pending,
    started,
    stale: expire.next,
    providerReceipt,
    accepted: acceptance(ACCEPTED_AT),
    late: acceptance(END),
  });
}

function outcomeFixture(row: RestockApplicationLedgerRow) {
  const prepared = prepareRestockApplicationOutcome(row);
  expect(prepared.action).toBe('prepared');
  if (prepared.action !== 'prepared') throw new Error('not prepared');
  const receipt = Object.freeze(
    present(
      normalizeRestockApplicationOutcomeAck(
        {
          id: prepared.decisionId,
          version: 2,
          attemptId: row.attemptId,
          outcome: row.state,
          ackReceivedAt: '2026-06-22T13:00:02.000Z',
        },
        prepared.decisionId,
        prepared.request,
      ),
    ),
  );
  const recorded = classifyRestockApplicationAckRecord(row, receipt, null);
  expect(recorded.action).toBe('record');
  if (recorded.action !== 'record') throw new Error('not recorded');
  return Object.freeze({ prepared, receipt, record: recorded.next });
}

describe('coordinator fixture foundation (existing pure contracts only)', () => {
  it.each(ACTIONS)('binds and freezes a ready %s GET snapshot', (action) => {
    const f = fixture(action);
    expect(f.candidate.decision.resolution.action).toBe(action);
    expect(f.evidence.sourceRequestId).toBe(
      f.candidate.context.reservation.requestKey,
    );
    expect(f.pending.attemptId).toBe(f.candidate.classification.attemptId);
    expect(f.pending.sourceRequestId).toBe(
      f.candidate.decision.sourceRequestId,
    );
    expect(normalizeRestockDecision(f.candidate.decision)).toEqual(
      f.candidate.decision,
    );
    for (const value of [
      f,
      f.candidate,
      f.candidate.context,
      f.candidate.context.reservation,
      f.candidate.context.reservation.intake,
      f.candidate.decision,
      f.candidate.decision.snapshot,
      f.candidate.decision.resolution,
      f.candidate.classification,
      f.evidence,
      f.pending,
      f.started,
      f.stale,
      f.accepted.row,
      f.late.row,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(
      classifyRestockApplication({ ...f.policyInput, now: END }),
    ).toMatchObject({
      action: 'stale',
      attemptId: f.pending.attemptId,
    });
  });

  it('binds synthetic acceptance to the send token, provider ID and observation time', () => {
    const f = fixture();
    expect(f.accepted.row).toEqual({
      ...f.started,
      state: 'PROVIDER_ACCEPTED',
      providerMessageId: f.providerReceipt.providerMessageId,
      providerAcceptedObservedAt: ACCEPTED_AT,
    });
    expect(f.accepted.event.sendToken).toBe(f.started.sendToken);
    expect(f.accepted.event.attemptId).toBe(f.started.attemptId);
    expect(f.late.row).toEqual({
      ...f.accepted.row,
      state: 'PROVIDER_ACCEPTED_LATE',
      providerAcceptedObservedAt: END,
    });
    expect(f.stale).toEqual({
      ...f.pending,
      state: 'STALE',
      staleObservedAt: END,
    });
  });

  it('projects terminal-only wire bodies and canonical ACKs matching each row', () => {
    const f = fixture();
    for (const row of [f.stale, f.accepted.row, f.late.row]) {
      const { prepared, receipt, record } = outcomeFixture(row);
      expect(prepared.request).toEqual({
        attemptId: row.attemptId,
        expectedResolutionVersion: 2,
        outcome: row.state,
        ...(row.state === 'STALE'
          ? {}
          : {
              attemptedAt: row.attemptedAt,
              providerMessageId: row.providerMessageId,
              providerAcceptedObservedAt: row.providerAcceptedObservedAt,
            }),
      });
      expect(record).toEqual({ row, receipt });
      expect(receipt).toMatchObject({
        id: row.decisionId,
        attemptId: row.attemptId,
        outcome: row.state,
      });
      for (const value of [
        prepared,
        prepared.request,
        receipt,
        record,
        record.row,
        record.receipt,
      ])
        expect(Object.isFrozen(value)).toBe(true);
    }
  });
});
