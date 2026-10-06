import { deriveExpirationAttemptId } from './expiration-attempt-identity';
import { prepareExpirationApplicationOutcome as prepare } from './expiration-application-ledger-ack-preparation';

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
const stale = {
  ...common,
  state: 'STALE',
  staleObservedAt: common.applyBefore,
};
const hold = (reason: string) => ({ action: 'hold', reason });

describe('inactive EXPIRATION outcome request preparation', () => {
  it.each([
    ['PROVIDER_ACCEPTED', started.attemptedAt],
    ['PROVIDER_ACCEPTED', '2026-09-26T09:59:59.999Z'],
    ['PROVIDER_ACCEPTED_LATE', common.applyBefore],
    ['PROVIDER_ACCEPTED_LATE', '2026-09-26T10:00:00.001Z'],
    ['STALE', common.applyBefore],
    ['STALE', '2026-09-26T10:00:00.001Z'],
  ])(
    'projects %s at %s without granting send or closure authority',
    (state, observedAt) => {
      const row =
        state === 'STALE'
          ? { ...stale, staleObservedAt: observedAt }
          : { ...accepted, state, providerAcceptedObservedAt: observedAt };
      const before = structuredClone(row);
      const base = {
        attemptId: common.attemptId,
        expectedResolutionVersion: 2,
        outcome: state,
      };
      const request =
        state === 'STALE'
          ? base
          : {
              ...base,
              attemptedAt: started.attemptedAt,
              providerMessageId: accepted.providerMessageId,
              providerAcceptedObservedAt: observedAt,
            };
      const result = prepare(row);
      expect(result).toEqual({
        action: 'prepared',
        decisionId,
        expected: before,
        request,
      });
      expect(row).toEqual(before);
      expect(Object.isFrozen(row)).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'prepared') throw new Error('Preparation required');
      expect(Object.isFrozen(result.expected)).toBe(true);
      expect(Object.isFrozen(result.request)).toBe(true);
      expect(result.expected).not.toBe(row);
      row.branchId = 'changed';
      expect(result.expected).toEqual(before);
      expect(result.request).toEqual(request);
      expect(prepare({ ...before })).toEqual(result);
    },
  );
  it.each([{ ...common, state: 'PENDING_DELIVERY' }, started])(
    'holds nonterminal rows %#',
    (row) => {
      const before = structuredClone(row);
      const result = prepare(row);
      expect(result).toEqual(hold('nonterminal_row'));
      expect(Object.isFrozen(result)).toBe(true);
      expect(row).toEqual(before);
    },
  );
  it.each([
    { attemptId: common.attemptId.toUpperCase() },
    { decisionId: decisionId.toUpperCase() },
    { sourceRequestId: decisionId },
    { resolutionVersion: 1 },
    { branchId: '' },
    { providerMessageId: '' },
    { providerMessageId: 'a\nb' },
    { providerAcceptedObservedAt: common.resolvedAt },
    { providerAcceptedObservedAt: common.applyBefore },
    { providerAcceptedObservedAt: '2026-09-25T10:01:00Z' },
    { state: 'PROVIDER_ACCEPTED_LATE' },
    { attemptedAt: common.applyBefore },
    { applyBefore: '2026-09-25T11:00:00.000Z' },
    { state: 'DELIVERY_UNKNOWN' },
    { ackReceivedAt: common.applyBefore },
    { evidence: {} },
  ])('holds invalid terminal snapshots without repairing them %#', (patch) => {
    const row = { ...accepted, ...patch };
    const before = structuredClone(row);
    const result = prepare(row);
    expect(result).toEqual(hold('invalid_row'));
    expect(Object.isFrozen(result)).toBe(true);
    expect(row).toEqual(before);
  });
  it.each([
    { ...stale, staleObservedAt: '2026-09-26T09:59:59.999Z' },
    { ...stale, attemptedAt: started.attemptedAt },
    { ...stale, providerMessageId: 'not no-send evidence' },
    { ...stale, sendToken: started.sendToken },
    null,
    [],
    { providerMessageId: 'id alone' },
  ])('rejects invalid STALE evidence or malformed input %#', (row) => {
    expect(prepare(row)).toEqual(hold('invalid_row'));
  });
  it.each(Object.keys(accepted))('requires terminal field %s', (key) => {
    const row = Object.fromEntries(
      Object.entries(accepted).filter(([name]) => name !== key),
    );
    const before = structuredClone(row);
    expect(prepare(row)).toEqual(hold('invalid_row'));
    expect(row).toEqual(before);
  });
  it('rejects accessors and symbols, and accepts null-prototype reordered data', () => {
    const getter = jest.fn(() => accepted.providerMessageId);
    const row = Object.defineProperty({ ...accepted }, 'providerMessageId', {
      get: getter,
    });
    expect(prepare(row)).toEqual(hold('invalid_row'));
    expect(getter).not.toHaveBeenCalled();
    expect(prepare({ ...accepted, [Symbol('extra')]: 1 })).toEqual(
      hold('invalid_row'),
    );
    const plain = Object.assign(
      Object.create(null) as object,
      Object.fromEntries(Object.entries(accepted).reverse()),
    );
    expect(prepare(plain)).toEqual(prepare(accepted));
    expect(prepare(plain).action).toBe('prepared');
  });
});
