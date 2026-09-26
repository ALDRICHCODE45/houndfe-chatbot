import { RestockApplicationCoordinator } from './restock-application-coordinator';
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

function setup(
  action: RestockResolution['action'] = ACTIONS[0],
  stale = false,
) {
  const f = fixture(action);
  const outcome = outcomeFixture(stale ? f.stale : f.accepted.row);
  const ports = {
    pollForSender: jest.fn().mockResolvedValue(f.candidate),
    preparePending: jest
      .fn()
      .mockResolvedValue({ action: 'prepared', row: f.pending }),
    claimPending: jest.fn().mockResolvedValue({
      action: stale ? 'stale' : 'started',
      row: stale ? f.stale : f.started,
      evidence: f.evidence,
    }),
    sendText: jest.fn().mockResolvedValue(f.providerReceipt),
    recordAcceptance: jest
      .fn()
      .mockResolvedValue({ action: 'updated', row: f.accepted.row }),
    recordRestockApplicationOutcome: jest
      .fn()
      .mockResolvedValue(outcome.receipt),
    recordOutcomeAck: jest
      .fn()
      .mockResolvedValue({ action: 'recorded', record: outcome.record }),
  };
  const clock = jest
    .fn()
    .mockReturnValueOnce(new Date(NOW))
    .mockReturnValue(new Date(ACCEPTED_AT));
  const token = jest.fn(() => TOKEN);
  const coordinator = new RestockApplicationCoordinator(
    ports,
    BRANCH,
    PHONE,
    clock,
    token,
  );
  return {
    f,
    outcome,
    ports,
    clock,
    token,
    run: () => coordinator.applyOnce(SENDER, f.evidence.sourceRequestId),
  };
}

describe('unwired application orchestration', () => {
  it.each(ACTIONS)(
    'sends authoritative %s text then records the actual acceptance and ACK',
    async (action) => {
      const { f, outcome, ports: p, token, run } = setup(action);
      const result = await run();
      expect(result).toEqual({ action: 'ack_recorded' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(p.pollForSender).toHaveBeenCalledWith(
        SENDER,
        f.evidence.sourceRequestId,
      );
      expect(p.preparePending).toHaveBeenCalledWith(f.candidate);
      expect(token).toHaveBeenCalledTimes(1);
      expect(p.claimPending).toHaveBeenCalledWith(
        f.candidate,
        f.pending,
        TOKEN,
      );
      expect(p.sendText).toHaveBeenCalledWith({
        to: SENDER,
        text:
          action === 'PROVIDE_RESTOCK_ESTIMATE'
            ? 'Collar (SKU: COL-01): el equipo confirmó un estimado de reposición de 3 días desde su confirmación. Es un estimado, no una fecha garantizada.'
            : 'Collar (SKU: COL-01): el equipo no pudo confirmar un estimado de reposición.',
      });
      expect(p.recordAcceptance).toHaveBeenCalledWith({
        row: f.started,
        event: f.accepted.event,
      });
      expect(p.recordRestockApplicationOutcome).toHaveBeenCalledWith(
        ID,
        outcome.prepared.request,
      );
      expect(p.recordOutcomeAck).toHaveBeenCalledWith(
        f.accepted.row,
        outcome.receipt,
      );
      const calls = Object.values(p).map((mock) => {
        expect(mock).toHaveBeenCalledTimes(1);
        return mock.mock.invocationCallOrder[0];
      });
      expect(calls).toEqual([...calls].sort((a, b) => a - b));
    },
  );

  it('returns frozen pending without downstream work', async () => {
    const { ports, run, clock, token } = setup();
    ports.pollForSender.mockResolvedValue({ action: 'pending' });
    const result = await run();
    expect(result).toEqual({ action: 'pending' });
    expect(Object.isFrozen(result)).toBe(true);
    for (const mock of [...Object.values(ports).slice(1), clock, token])
      expect(mock).not.toHaveBeenCalled();
  });

  it('ACKs confirmed stale without sending or recording acceptance', async () => {
    const { f, outcome, ports: p, run } = setup(ACTIONS[0], true);
    expect(await run()).toEqual({ action: 'ack_recorded' });
    expect(p.sendText).not.toHaveBeenCalled();
    expect(p.recordAcceptance).not.toHaveBeenCalled();
    expect(p.recordRestockApplicationOutcome).toHaveBeenCalledTimes(1);
    expect(p.recordRestockApplicationOutcome).toHaveBeenCalledWith(
      ID,
      outcome.prepared.request,
    );
    expect(p.recordOutcomeAck).toHaveBeenCalledTimes(1);
    expect(p.recordOutcomeAck).toHaveBeenCalledWith(f.stale, outcome.receipt);
  });

  it.each(['send rejection', 'post-COMMIT expiry'])(
    'holds on %s without acceptance or ACK',
    async (failure) => {
      const { ports: p, clock, run } = setup();
      if (failure === 'send rejection')
        p.sendText.mockRejectedValue(new Error('uncertain'));
      else clock.mockReset().mockReturnValue(new Date(END));
      expect(await run()).toEqual({ action: 'hold' });
      expect(p.claimPending).toHaveBeenCalledTimes(1);
      expect(p.sendText).toHaveBeenCalledTimes(
        failure === 'send rejection' ? 1 : 0,
      );
      expect(p.recordAcceptance).not.toHaveBeenCalled();
      expect(p.recordRestockApplicationOutcome).not.toHaveBeenCalled();
      expect(p.recordOutcomeAck).not.toHaveBeenCalled();
    },
  );
});

function expectThrough(ports: ReturnType<typeof setup>['ports'], last: number) {
  Object.values(ports).forEach((mock, index) =>
    expect(mock).toHaveBeenCalledTimes(index <= last ? 1 : 0),
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function evidenceAt(
  providerOffset: number,
  observedOffset = 0,
  senderId = SENDER,
) {
  return present(
    bindRestockInboundEvidence(
      {
        event: {
          senderId,
          receivingPhoneNumberId: PHONE,
          messageId: 'wamid.synthetic-inbound',
        },
        providerTimestampSeconds: String(
          (Date.parse(NOW) + providerOffset) / 1000,
        ),
        observedAt: new Date(Date.parse(NOW) + observedOffset).toISOString(),
      },
      PHONE,
    ),
  );
}

describe('application authority and failure boundaries (mocked ports only)', () => {
  it.each([NOW, END])(
    'waits for claim completion before sampling %s',
    async (afterClaim) => {
      const { f, ports: p, clock, run } = setup();
      const entered = deferred<void>();
      const claim = deferred<{
        action: 'started';
        row: typeof f.started;
        evidence: typeof f.evidence;
      }>();
      p.claimPending.mockImplementation(() => {
        entered.resolve();
        return claim.promise;
      });
      const result = run();
      await entered.promise;
      expectThrough(p, 2);
      expect(clock).not.toHaveBeenCalled();
      clock
        .mockReset()
        .mockReturnValueOnce(new Date(afterClaim))
        .mockReturnValue(new Date(ACCEPTED_AT));
      claim.resolve({
        action: 'started',
        row: f.started,
        evidence: f.evidence,
      });
      expect(await result).toEqual({
        action: afterClaim === NOW ? 'ack_recorded' : 'hold',
      });
      expectThrough(p, afterClaim === NOW ? 6 : 2);
      expect(clock).toHaveBeenCalledTimes(afterClaim === NOW ? 2 : 1);
    },
  );

  it.each(['updated', 'replay'])(
    'preserves actual late acceptance with %s persistence',
    async (action) => {
      const { f, ports: p, clock, run } = setup();
      const outcome = outcomeFixture(f.late.row);
      clock
        .mockReset()
        .mockReturnValueOnce(new Date(NOW))
        .mockReturnValue(new Date(END));
      p.recordAcceptance.mockResolvedValue({ action, row: f.late.row });
      p.recordRestockApplicationOutcome.mockResolvedValue(outcome.receipt);
      p.recordOutcomeAck.mockResolvedValue({
        action: action === 'replay' ? 'replay' : 'recorded',
        record: outcome.record,
      });
      expect(await run()).toEqual({ action: 'ack_recorded' });
      expectThrough(p, 6);
      expect(p.recordAcceptance).toHaveBeenCalledWith({
        row: f.started,
        event: f.late.event,
      });
      expect(p.recordRestockApplicationOutcome).toHaveBeenCalledWith(
        ID,
        outcome.prepared.request,
      );
      expect(outcome.prepared.request.outcome).toBe('PROVIDER_ACCEPTED_LATE');
      expect(p.recordOutcomeAck).toHaveBeenCalledWith(
        f.late.row,
        outcome.receipt,
      );
    },
  );

  it.each([999, 1000, 1001])(
    'checks the original 24h boundary at offset %i ms while policy is ready',
    async (offset) => {
      const { f, ports: p, clock, run } = setup();
      const evidence = evidenceAt(-86_400_000 + 1000);
      expect(evidence.sourceRequestId).toBe(f.evidence.sourceRequestId);
      const now = new Date(Date.parse(NOW) + offset).toISOString();
      expect(classifyRestockApplication({ ...f.policyInput, now }).action).toBe(
        'ready',
      );
      p.claimPending.mockResolvedValue({
        action: 'started',
        row: f.started,
        evidence,
      });
      clock
        .mockReset()
        .mockReturnValueOnce(new Date(now))
        .mockReturnValue(new Date(ACCEPTED_AT));
      expect(await run()).toEqual({
        action: offset < 1000 ? 'ack_recorded' : 'hold',
      });
      expectThrough(p, offset < 1000 ? 6 : 2);
      if (offset < 1000)
        expect(p.recordAcceptance).toHaveBeenCalledWith({
          row: f.started,
          event: f.accepted.event,
        });
    },
  );

  it('holds clock rollback before attemptedAt even while policy remains ready', async () => {
    const { f, ports: p, clock, run } = setup();
    const row = present(
      normalizeRestockApplicationLedgerRow({
        ...f.started,
        attemptedAt: ACCEPTED_AT,
      }),
    );
    expect(row.state).toBe('SEND_STARTED');
    expect(classifyRestockApplication(f.policyInput).action).toBe('ready');
    p.claimPending.mockResolvedValue({
      action: 'started',
      row,
      evidence: f.evidence,
    });
    clock.mockReset().mockReturnValue(new Date(NOW));
    expect(await run()).toEqual({ action: 'hold' });
    expectThrough(p, 2);
  });

  it.each(['provider', 'observation'])(
    'rejects future %s evidence while policy remains ready',
    async (future) => {
      const { f, ports: p, run } = setup();
      const evidence = evidenceAt(future === 'provider' ? 1000 : 0, 1000);
      expect(evidence.sourceRequestId).toBe(f.evidence.sourceRequestId);
      expect(classifyRestockApplication(f.policyInput).action).toBe('ready');
      p.claimPending.mockResolvedValue({
        action: 'started',
        row: f.started,
        evidence,
      });
      expect(await run()).toEqual({ action: 'hold' });
      expectThrough(p, 2);
    },
  );

  it.each(['throw', 'invalid'])(
    'holds a %s post-claim clock',
    async (failure) => {
      const { ports: p, clock, run } = setup();
      clock.mockReset().mockImplementation(() => {
        if (failure === 'throw') throw new Error('clock unavailable');
        return new Date(NaN);
      });
      expect(await run()).toEqual({ action: 'hold' });
      expectThrough(p, 2);
    },
  );

  it.each(['sender', 'source', 'branch'])(
    'rejects %s binding before preparation',
    async (mismatch) => {
      const { f, ports: p, clock, token } = setup();
      const coordinator = new RestockApplicationCoordinator(
        p,
        mismatch === 'branch' ? 'other-branch' : BRANCH,
        PHONE,
        clock,
        token,
      );
      expect(
        await coordinator.applyOnce(
          mismatch === 'sender' ? 'other-sender' : SENDER,
          mismatch === 'source' ? ID : f.evidence.sourceRequestId,
        ),
      ).toEqual({ action: 'hold' });
      expectThrough(p, 0);
      expect(clock).not.toHaveBeenCalled();
    },
  );

  it.each(['token', 'sender'])(
    'rejects a valid but mismatched claimed-row %s',
    async (mismatch) => {
      const { f, ports: p, run } = setup();
      const row = present(
        normalizeRestockApplicationLedgerRow({
          ...f.started,
          ...(mismatch === 'token'
            ? { sendToken: ID }
            : { senderId: 'other-sender' }),
        }),
      );
      expect(row.state).toBe('SEND_STARTED');
      p.claimPending.mockResolvedValue({
        action: 'started',
        row,
        evidence: f.evidence,
      });
      expect(await run()).toEqual({ action: 'hold' });
      expectThrough(p, 2);
    },
  );

  it('rejects canonical evidence bound to another source event', async () => {
    const { f, ports: p, run } = setup();
    const evidence = evidenceAt(0, 0, 'other-sender');
    expect(evidence.sourceRequestId).not.toBe(f.evidence.sourceRequestId);
    p.claimPending.mockResolvedValue({
      action: 'started',
      row: f.started,
      evidence,
    });
    expect(await run()).toEqual({ action: 'hold' });
    expectThrough(p, 2);
  });

  it('isolates configured phone mismatch with otherwise matching canonical evidence', async () => {
    const { f, ports: p, clock, token } = setup();
    expect(f.evidence.senderId).toBe(SENDER);
    expect(f.evidence.sourceRequestId).toBe(f.started.sourceRequestId);
    expect(f.evidence.receivingPhoneNumberId).toBe(PHONE);
    const coordinator = new RestockApplicationCoordinator(
      p,
      BRANCH,
      '987654321',
      clock,
      token,
    );
    expect(
      await coordinator.applyOnce(SENDER, f.evidence.sourceRequestId),
    ).toEqual({ action: 'hold' });
    expectThrough(p, 2);
  });

  it.each([
    null,
    undefined,
    {},
    { providerMessageId: '' },
    { providerMessageId: 42 },
  ])(
    'holds malformed actual receipt %p without inventing acceptance',
    async (receipt) => {
      const { ports: p, run } = setup();
      p.sendText.mockResolvedValue(receipt);
      expect(await run()).toEqual({ action: 'hold' });
      expectThrough(p, 3);
    },
  );

  it('preserves opaque provider ID bytes through acceptance and ACK', async () => {
    const { f, ports: p, run } = setup();
    const providerMessageId = ' provider-e\u0301 ';
    const event = Object.freeze({ ...f.accepted.event, providerMessageId });
    const accepted = classifyRestockApplicationAcceptance({
      row: f.started,
      event,
    });
    expect(accepted.action).toBe('propose_cas');
    if (accepted.action !== 'propose_cas')
      throw new Error('invalid acceptance fixture');
    const outcome = outcomeFixture(accepted.next);
    p.sendText.mockResolvedValue(Object.freeze({ providerMessageId }));
    p.recordAcceptance.mockResolvedValue({
      action: 'updated',
      row: accepted.next,
    });
    p.recordRestockApplicationOutcome.mockResolvedValue(outcome.receipt);
    p.recordOutcomeAck.mockResolvedValue({
      action: 'recorded',
      record: outcome.record,
    });
    expect(await run()).toEqual({ action: 'ack_recorded' });
    expectThrough(p, 6);
    expect(p.recordAcceptance).toHaveBeenCalledWith({ row: f.started, event });
    expect(outcome.prepared.request).toHaveProperty(
      'providerMessageId',
      providerMessageId,
    );
    expect(p.recordRestockApplicationOutcome).toHaveBeenCalledWith(
      ID,
      outcome.prepared.request,
    );
    expect(p.recordOutcomeAck).toHaveBeenCalledWith(
      accepted.next,
      outcome.receipt,
    );
  });

  it('does not ACK a valid persisted acceptance that disagrees with the actual observation', async () => {
    const { f, ports: p, run } = setup();
    p.recordAcceptance.mockResolvedValue({
      action: 'updated',
      row: f.late.row,
    });
    expect(await run()).toEqual({ action: 'hold' });
    expect(p.recordAcceptance).toHaveBeenCalledWith({
      row: f.started,
      event: f.accepted.event,
    });
    expectThrough(p, 4);
  });

  it.each([
    'pollForSender',
    'preparePending',
    'claimPending',
    'sendText',
    'recordAcceptance',
    'recordRestockApplicationOutcome',
    'recordOutcomeAck',
  ] as const)(
    'stops after %s throws, without retry or later calls',
    async (port) => {
      const { ports: p, run } = setup();
      p[port].mockRejectedValue(new Error('uncertain effect'));
      const result = await run();
      expect(result).toEqual({ action: 'hold' });
      expect(Object.isFrozen(result)).toBe(true);
      expectThrough(p, Object.keys(p).indexOf(port));
    },
  );

  it.each([
    'pollForSender',
    'preparePending',
    'claimPending',
    'recordAcceptance',
    'recordOutcomeAck',
  ] as const)('stops after a discriminated %s hold', async (port) => {
    const { ports: p, run } = setup();
    p[port].mockResolvedValue({ action: 'hold' });
    expect(await run()).toEqual({ action: 'hold' });
    expectThrough(p, Object.keys(p).indexOf(port));
  });
});

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
