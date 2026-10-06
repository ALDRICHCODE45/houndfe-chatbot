import {
  ExpirationApplicationOutcomeCoordinator,
  type ExpirationApplicationOutcomePorts,
} from './expiration-application-outcome-coordinator';
import { bindExpirationApplicationOutcomeAck } from '../domain/expiration-application-ledger-ack-binding';
import { deriveExpirationAttemptId } from '../domain/expiration-attempt-identity';

const ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SOURCE = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const AT = '2026-09-25T10:00:00.000Z';
const END = '2026-09-26T10:00:00.000Z';
const hold = { action: 'hold' as const };
function harness(state = 'PROVIDER_ACCEPTED', hasAck = false) {
  const intake = {
    sourceRequestId: SOURCE,
    type: 'EXPIRATION' as const,
    productId: ID,
    variantId: null,
  };
  const reservation = {
    senderId: 'customer',
    route: 'EXPIRATION' as const,
    status: 'ACTIVE' as const,
    requestKey: SOURCE,
    intake,
  };
  const context = {
    reservation,
    backendDecisionId: ID,
    postAttemptedAt: AT,
    receiptRecordedAt: AT,
  };
  const candidate = {
    action: 'candidate' as const,
    checkedAt: AT,
    binding: {
      ...context,
      branchId: ' branch ',
      reservation: { ...reservation, intake: { ...intake } },
    },
    decision: {
      id: ID,
      sourceRequestId: SOURCE,
      type: 'EXPIRATION' as const,
      status: 'RESOLVED' as const,
      version: 2 as const,
      createdAt: AT,
      supersedesDecisionId: null,
      applyBefore: END,
      snapshot: {
        branchId: ' branch ',
        branchName: null,
        productId: ID,
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
        resolvedAt: AT,
      },
    },
  };
  const row = {
    state,
    senderId: 'customer',
    branchId: ' branch ',
    sourceRequestId: SOURCE,
    decisionId: ID,
    resolutionVersion: 2,
    attemptId: deriveExpirationAttemptId(SOURCE, ID)!,
    resolvedAt: AT,
    applyBefore: END,
    ...(state === 'STALE'
      ? { staleObservedAt: END }
      : {
          sendToken: ID,
          attemptedAt: AT,
          providerMessageId: 'opaque',
          providerAcceptedObservedAt:
            state === 'PROVIDER_ACCEPTED_LATE' ? END : AT,
        }),
  };
  const receipt = {
    id: ID,
    version: 2,
    attemptId: row.attemptId,
    outcome: state,
    ackReceivedAt: END,
  };
  const bound = bindExpirationApplicationOutcomeAck(row, receipt);
  if (bound.action !== 'bound') throw new Error('Fixture must bind');
  const ports: jest.Mocked<ExpirationApplicationOutcomePorts> = {
    readRecordedForSender: jest
      .fn()
      .mockResolvedValue({ action: 'recorded', context }),
    readOutcomeByDecision: jest.fn().mockResolvedValue({
      action: 'foundOutcome',
      row: bound.expected,
      receipt: hasAck ? bound.receipt : null,
    }),
    recordRestockApplicationOutcome: jest.fn().mockResolvedValue(bound.receipt),
    recordOutcomeAck: jest.fn().mockResolvedValue({
      action: 'updated',
      row: bound.expected,
      receipt: bound.receipt,
    }),
    closeAcknowledged: jest.fn().mockResolvedValue({ action: 'closed' }),
  };
  const service = new ExpirationApplicationOutcomeCoordinator(
    ports,
    ' branch ',
  );
  const run = () => service.finishOnce(candidate, row);
  return { candidate, context, row, receipt, bound, ports, run };
}

describe('inactive EXPIRATION terminal outcome coordination', () => {
  it.each([
    ['PROVIDER_ACCEPTED', false],
    ['STALE', false],
    ['PROVIDER_ACCEPTED', true],
    ['STALE', true],
  ])(
    '%s with existing ACK=%s closes only through the completion adapter',
    async (state, hasAck) => {
      const h = harness(state, hasAck);
      const result = await h.run();
      expect(result).toEqual({ action: 'closed' });
      expect(Object.isFrozen(result)).toBe(true);
      expect(h.ports.readRecordedForSender).toHaveBeenCalledWith('customer');
      expect(h.ports.readOutcomeByDecision).toHaveBeenCalledWith(ID);
      const report = h.ports.recordRestockApplicationOutcome;
      expect(report).toHaveBeenCalledTimes(hasAck ? 0 : 1);
      expect(h.ports.recordOutcomeAck).toHaveBeenCalledTimes(hasAck ? 0 : 1);
      if (!hasAck) {
        expect(report).toHaveBeenCalledWith(ID, {
          attemptId: h.row.attemptId,
          expectedResolutionVersion: 2,
          outcome: state,
          ...(state === 'STALE'
            ? {}
            : {
                attemptedAt: AT,
                providerMessageId: 'opaque',
                providerAcceptedObservedAt: AT,
              }),
        });
        expect(h.ports.recordOutcomeAck).toHaveBeenCalledWith(h.row, h.receipt);
      }
      expect(h.ports.closeAcknowledged).toHaveBeenCalledWith(
        h.candidate,
        h.row,
        h.receipt,
      );
      const order = Object.values(h.ports).flatMap(
        (method) => method.mock.invocationCallOrder,
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(Object.isFrozen(h.row)).toBe(false);
    },
  );
  it.each([false, true])(
    'keeps valid LATE held with existing ACK=%s',
    async (hasAck) => {
      const h = harness('PROVIDER_ACCEPTED_LATE', hasAck);
      expect(await h.run()).toEqual(hold);
      expect(h.ports.recordRestockApplicationOutcome).toHaveBeenCalledTimes(
        hasAck ? 0 : 1,
      );
      expect(h.ports.recordOutcomeAck).toHaveBeenCalledTimes(hasAck ? 0 : 1);
      expect(h.ports.closeAcknowledged).not.toHaveBeenCalled();
    },
  );
  it.each(['branch', 'subject', 'sender', 'nonterminal'])(
    'rejects %s input before I/O',
    async (point) => {
      const h = harness();
      if (point === 'branch') h.candidate.binding.branchId = 'other';
      if (point === 'subject') h.candidate.decision.snapshot.productId = SOURCE;
      if (point === 'sender') h.row.senderId = 'other';
      if (point === 'nonterminal') h.row.state = 'SEND_STARTED';
      expect(await h.run()).toEqual(hold);
      for (const port of Object.values(h.ports))
        expect(port).not.toHaveBeenCalled();
    },
  );
  it.each(['context', 'missing', 'row', 'stored-ack'])(
    'holds %s drift before reporting or closing',
    async (point) => {
      const h = harness();
      if (point === 'context') h.context.receiptRecordedAt = END;
      if (point === 'missing')
        h.ports.readOutcomeByDecision.mockResolvedValue({ action: 'missing' });
      if (point === 'row')
        h.ports.readOutcomeByDecision.mockResolvedValue({
          action: 'foundOutcome',
          row: { ...h.bound.expected, senderId: 'other' },
          receipt: null,
        });
      if (point === 'stored-ack')
        h.ports.readOutcomeByDecision.mockResolvedValue({
          action: 'foundOutcome',
          row: h.bound.expected,
          receipt: { ...h.bound.receipt, id: SOURCE },
        });
      expect(await h.run()).toEqual(hold);
      expect(h.ports.recordRestockApplicationOutcome).not.toHaveBeenCalled();
      expect(h.ports.recordOutcomeAck).not.toHaveBeenCalled();
      expect(h.ports.closeAcknowledged).not.toHaveBeenCalled();
    },
  );
  it.each(['response', 'cas-hold', 'cas-row', 'cas-receipt', 'close'])(
    'holds %s mismatch without retry or fabricated success',
    async (point) => {
      const h = harness();
      if (point === 'response')
        h.ports.recordRestockApplicationOutcome.mockResolvedValue({
          ...h.bound.receipt,
          id: SOURCE,
        });
      if (point === 'cas-hold')
        h.ports.recordOutcomeAck.mockResolvedValue(hold);
      if (point === 'cas-row')
        h.ports.recordOutcomeAck.mockResolvedValue({
          action: 'updated',
          row: { ...h.bound.expected, senderId: 'other' },
          receipt: h.bound.receipt,
        });
      if (point === 'cas-receipt')
        h.ports.recordOutcomeAck.mockResolvedValue({
          action: 'updated',
          row: h.bound.expected,
          receipt: { ...h.bound.receipt, ackReceivedAt: AT },
        });
      if (point === 'close') h.ports.closeAcknowledged.mockResolvedValue(hold);
      expect(await h.run()).toEqual(hold);
      expect(h.ports.recordRestockApplicationOutcome).toHaveBeenCalledTimes(1);
      expect(h.ports.closeAcknowledged).toHaveBeenCalledTimes(
        point === 'close' ? 1 : 0,
      );
      if (point === 'response')
        expect(h.ports.recordOutcomeAck).not.toHaveBeenCalled();
    },
  );
  it.each([
    'readRecordedForSender',
    'readOutcomeByDecision',
    'recordRestockApplicationOutcome',
    'recordOutcomeAck',
    'closeAcknowledged',
  ] as const)('holds %s rejection without retry', async (point) => {
    const h = harness();
    h.ports[point].mockRejectedValue(new Error('private failure'));
    expect(await h.run()).toEqual(hold);
    for (const port of Object.values(h.ports))
      expect(port.mock.calls.length).toBeLessThanOrEqual(1);
    expect(h.ports.closeAcknowledged).toHaveBeenCalledTimes(
      point === 'closeAcknowledged' ? 1 : 0,
    );
  });
  it('detaches caller inputs before the first read and waits for confirmed closure', async () => {
    const h = harness();
    let release!: (result: { action: 'closed' }) => void;
    h.ports.closeAcknowledged.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let reached!: () => void;
    const atClose = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const close = h.ports.closeAcknowledged.getMockImplementation()!;
    h.ports.closeAcknowledged.mockImplementation((...args) => {
      reached();
      return close(...args);
    });
    let settled = false;
    const result = h.run().then((value) => {
      settled = true;
      return value;
    });
    h.row.senderId = 'changed';
    h.candidate.binding.reservation.intake.productId = SOURCE;
    await Promise.race([atClose, result]);
    expect(settled).toBe(false);
    expect(h.ports.closeAcknowledged.mock.calls[0][1]).toEqual(
      h.bound.expected,
    );
    release({ action: 'closed' });
    expect(await result).toEqual({ action: 'closed' });
  });
});
