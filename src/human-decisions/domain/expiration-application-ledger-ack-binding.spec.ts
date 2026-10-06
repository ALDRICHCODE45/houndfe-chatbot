import { bindExpirationApplicationOutcomeAck as bind } from './expiration-application-ledger-ack-binding';
import { deriveExpirationAttemptId } from './expiration-attempt-identity';

const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const common = {
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveExpirationAttemptId(sourceRequestId, decisionId)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-26T10:00:00.000Z',
};
const started = {
  ...common,
  state: 'SEND_STARTED',
  sendToken: 'aAbBcCdD-3333-4333-8333-333333333333',
  attemptedAt: '2026-09-25T10:01:00.000Z',
};
const accepted = {
  ...started,
  state: 'PROVIDER_ACCEPTED',
  providerMessageId: ' provider opaque ',
  providerAcceptedObservedAt: started.attemptedAt,
};
const late = {
  ...accepted,
  state: 'PROVIDER_ACCEPTED_LATE',
  providerAcceptedObservedAt: common.applyBefore,
};
const stale = {
  ...common,
  state: 'STALE',
  staleObservedAt: common.applyBefore,
};
const ack = {
  id: decisionId,
  version: 2,
  attemptId: common.attemptId,
  outcome: accepted.state,
  ackReceivedAt: '2026-09-25T10:02:00.000Z',
};
const hold = { action: 'hold' };

describe('inactive EXPIRATION ACK binding', () => {
  it.each([accepted, late, stale])(
    'binds an exact $state receipt without changing evidence',
    (input) => {
      const row = { ...input };
      const receipt = { ...ack, outcome: row.state };
      const expected = { ...row };
      const received = { ...receipt };
      const result = bind(row, receipt);
      expect(result).toEqual({ action: 'bound', expected, receipt: received });
      expect(row).toEqual(expected);
      expect(receipt).toEqual(received);
      expect(Object.isFrozen(row)).toBe(false);
      expect(Object.isFrozen(receipt)).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'bound') throw new Error('Binding required');
      expect(Object.isFrozen(result.expected)).toBe(true);
      expect(Object.isFrozen(result.receipt)).toBe(true);
      expect(result.expected).not.toBe(row);
      expect(result.receipt).not.toBe(receipt);
      row.branchId = 'changed';
      receipt.ackReceivedAt = 'changed';
      expect(result.expected).toEqual(expected);
      expect(result.receipt).toEqual(received);
    },
  );
  it.each([
    '2020-01-01T00:00:00Z',
    '2030-01-01T00:00:00.123Z',
    '2026-09-25T04:02:00-06:00',
  ])(
    'validates server time %s without local ordering or rewriting',
    (ackReceivedAt) => {
      const receipt = { ...ack, ackReceivedAt };
      expect(bind(accepted, receipt)).toEqual({
        action: 'bound',
        expected: accepted,
        receipt,
      });
    },
  );
  it.each([
    { id: sourceRequestId },
    { id: decisionId.toUpperCase() },
    { attemptId: decisionId },
    { attemptId: common.attemptId.toUpperCase() },
    { version: 1 },
    { version: '2' },
    { outcome: 'PROVIDER_ACCEPTED_LATE' },
    { outcome: 'STALE' },
    { outcome: 'DELIVERY_UNKNOWN' },
    { ackReceivedAt: null },
    { ackReceivedAt: 'invalid' },
    { ackReceivedAt: '2026-02-30T10:00:00Z' },
    { ackReceivedAt: '2026-09-25' },
    { ackReceivedAt: '2026-09-25T10:02:00' },
    { evidenceCode: null },
    { providerMessageId: accepted.providerMessageId },
    { sendToken: started.sendToken },
    { extra: true },
  ])('holds mismatched or malformed ACK %# without mutation', (patch) => {
    const row = { ...accepted };
    const receipt = { ...ack, ...patch };
    const before = structuredClone(receipt);
    const result = bind(row, receipt);
    expect(result).toEqual(hold);
    expect(Object.isFrozen(result)).toBe(true);
    expect(row).toEqual(accepted);
    expect(receipt).toEqual(before);
  });
  it.each(Object.keys(ack))('requires ACK field %s', (key) => {
    const receipt = Object.fromEntries(
      Object.entries(ack).filter(([name]) => name !== key),
    );
    expect(bind(accepted, receipt)).toEqual(hold);
  });
  it.each([
    { ...common, state: 'PENDING_DELIVERY' },
    started,
    { ...accepted, attemptId: common.attemptId.toUpperCase() },
    { ...accepted, providerAcceptedObservedAt: common.applyBefore },
    { ...late, providerAcceptedObservedAt: started.attemptedAt },
    { ...stale, staleObservedAt: common.resolvedAt },
    { ...stale, sendToken: started.sendToken },
    { ...accepted, state: 'DELIVERY_UNKNOWN' },
    { ...accepted, ackReceivedAt: ack.ackReceivedAt },
    null,
    [],
  ])('does not let ACK repair a nonterminal or invalid row %#', (row) => {
    const before = structuredClone(row);
    expect(bind(row, ack)).toEqual(hold);
    expect(row).toEqual(before);
  });
  it.each([null, [], {}, 'ACK'])('holds malformed receipt %#', (receipt) => {
    expect(bind(accepted, receipt)).toEqual(hold);
  });
  it('rejects accessors, proxies and symbols without invoking caller code', () => {
    const getter = jest.fn(() => decisionId);
    const trap = jest.fn(() => Object.prototype);
    expect(
      bind(
        Object.defineProperty({ ...accepted }, 'decisionId', { get: getter }),
        ack,
      ),
    ).toEqual(hold);
    expect(
      bind(accepted, Object.defineProperty({ ...ack }, 'id', { get: getter })),
    ).toEqual(hold);
    expect(bind(new Proxy(accepted, { getPrototypeOf: trap }), ack)).toEqual(
      hold,
    );
    expect(bind(accepted, new Proxy(ack, { getPrototypeOf: trap }))).toEqual(
      hold,
    );
    expect(bind({ ...accepted, [Symbol('extra')]: 1 }, ack)).toEqual(hold);
    expect(bind(accepted, { ...ack, [Symbol('extra')]: 1 })).toEqual(hold);
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });
  it('accepts reordered null-prototype snapshots without minting new evidence', () => {
    const row = Object.assign(
      Object.create(null) as object,
      Object.fromEntries(Object.entries(accepted).reverse()),
    );
    const receipt = Object.assign(
      Object.create(null) as object,
      Object.fromEntries(Object.entries(ack).reverse()),
    );
    expect(bind(row, receipt)).toEqual({
      action: 'bound',
      expected: accepted,
      receipt: ack,
    });
    expect(bind(row, receipt)).toEqual(bind(row, receipt));
  });
});
