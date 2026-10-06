import { prepareExpirationApplicationCompletion as prepare } from './expiration-application-completion-preparation';
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

// Pure eligibility only: these fixtures prove neither durable ACK nor the
// no-send history of STALE. No reservation or remote system is involved.
describe('inactive EXPIRATION completion preparation', () => {
  it.each([accepted, stale])(
    'prepares $state with its exact ACK as detached immutable evidence',
    (input) => {
      const row = { ...input };
      const receipt = { ...ack, outcome: row.state };
      const before = { ...row };
      const received = { ...receipt };
      const result = prepare(row, receipt);
      expect(result).toEqual({
        action: 'prepared',
        expected: before,
        receipt: received,
      });
      expect(row).toEqual(before);
      expect(receipt).toEqual(received);
      expect(Object.isFrozen(row)).toBe(false);
      expect(Object.isFrozen(receipt)).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'prepared') throw new Error('Preparation required');
      expect(Object.isFrozen(result.expected)).toBe(true);
      expect(Object.isFrozen(result.receipt)).toBe(true);
      expect(result.expected).not.toBe(row);
      expect(result.receipt).not.toBe(receipt);
      row.branchId = 'changed';
      receipt.ackReceivedAt = 'changed';
      expect(result.expected).toEqual(before);
      expect(result.receipt).toEqual(received);
    },
  );
  it('holds LATE even when the reporting ACK binds successfully', () => {
    const row = { ...late };
    const receipt = { ...ack, outcome: late.state };
    const before = { ...receipt };
    expect(bind(row, receipt).action).toBe('bound');
    const result = prepare(row, receipt);
    expect(result).toEqual(hold);
    expect(Object.isFrozen(result)).toBe(true);
    expect(row).toEqual(late);
    expect(receipt).toEqual(before);
  });
  it.each([
    { ...common, state: 'PENDING_DELIVERY' },
    started,
    { ...started, state: 'DELIVERY_UNKNOWN' },
    { ...accepted, providerAcceptedObservedAt: common.applyBefore },
    { ...stale, staleObservedAt: common.resolvedAt },
    { ...stale, sendToken: started.sendToken },
    { ...accepted, decisionId: decisionId.toUpperCase() },
    null,
    undefined,
    [],
  ])('holds nonterminal or invalid evidence %# unchanged', (row) => {
    const before = structuredClone(row);
    const receipt = { ...ack };
    const result = prepare(row, receipt);
    expect(result).toEqual(hold);
    expect(Object.isFrozen(result)).toBe(true);
    expect(row).toEqual(before);
    expect(receipt).toEqual(ack);
  });
  it.each([
    null,
    undefined,
    {},
    { ...ack, id: sourceRequestId },
    { ...ack, id: decisionId.toUpperCase() },
    { ...ack, attemptId: common.attemptId.toUpperCase() },
    { ...ack, version: 1 },
    { ...ack, outcome: 'STALE' },
    { ...ack, ackReceivedAt: 'invalid' },
    { ...ack, extra: true },
  ])('holds absent, malformed or mismatched ACK %# unchanged', (receipt) => {
    const row = { ...accepted };
    const before = structuredClone(receipt);
    const result = prepare(row, receipt);
    expect(result).toEqual(hold);
    expect(Object.isFrozen(result)).toBe(true);
    expect(row).toEqual(accepted);
    expect(receipt).toEqual(before);
  });
  it.each([
    '2020-01-01T00:00:00Z',
    '2030-01-01T00:00:00.123Z',
    '2026-09-25T04:02:00-06:00',
  ])('preserves server time %s without imposing a new clock rule', (time) => {
    const receipt = { ...ack, ackReceivedAt: time };
    expect(prepare(accepted, receipt)).toEqual({
      action: 'prepared',
      expected: accepted,
      receipt,
    });
  });
  it('does not inspect untrusted objects before the descriptor-only binding', () => {
    const getter = jest.fn(() => accepted.state);
    const trap = jest.fn(() => Object.prototype);
    const accessor = Object.defineProperty({ ...accepted }, 'state', {
      get: getter,
    });
    const receiptAccessor = Object.defineProperty({ ...ack }, 'outcome', {
      get: getter,
    });
    expect(prepare(accessor, ack)).toEqual(hold);
    expect(prepare(accepted, receiptAccessor)).toEqual(hold);
    expect(prepare(new Proxy(accepted, { getPrototypeOf: trap }), ack)).toEqual(
      hold,
    );
    expect(prepare(accepted, new Proxy(ack, { getPrototypeOf: trap }))).toEqual(
      hold,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });
  it('preserves null-prototype reordered records without deriving new evidence', () => {
    const row = Object.assign(
      Object.create(null) as object,
      Object.fromEntries(Object.entries(stale).reverse()),
    );
    const receipt = Object.assign(
      Object.create(null) as object,
      Object.fromEntries(
        Object.entries({ ...ack, outcome: 'STALE' }).reverse(),
      ),
    );
    const expected = {
      action: 'prepared',
      expected: stale,
      receipt: { ...ack, outcome: 'STALE' },
    };
    expect(prepare(row, receipt)).toEqual(expected);
    expect(prepare(row, receipt)).toEqual(expected);
  });
});
