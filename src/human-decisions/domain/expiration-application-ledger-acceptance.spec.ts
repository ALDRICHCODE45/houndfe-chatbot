import { deriveExpirationAttemptId } from './expiration-attempt-identity';
import { classifyExpirationApplicationAcceptance as classify } from './expiration-application-ledger-acceptance';

const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const sendToken = 'aAbBcCdD-3333-4333-8333-333333333333';
const resolvedAt = '2026-09-25T10:00:00.000Z';
const attemptedAt = '2026-09-25T10:01:00.000Z';
const applyBefore = '2026-09-26T10:00:00.000Z';
const common = {
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveExpirationAttemptId(sourceRequestId, decisionId)!,
  resolvedAt,
  applyBefore,
};
const started = { ...common, state: 'SEND_STARTED', sendToken, attemptedAt };
const event = {
  kind: 'provider_accepted',
  attemptId: common.attemptId,
  sendToken,
  providerMessageId: ' provider opaque ',
  providerAcceptedObservedAt: attemptedAt,
};
const hold = (reason: string) => ({ action: 'hold', reason });

describe('inactive EXPIRATION provider acceptance proposal', () => {
  it.each([
    [attemptedAt, 'PROVIDER_ACCEPTED'],
    ['2026-09-26T09:59:59.999Z', 'PROVIDER_ACCEPTED'],
    [applyBefore, 'PROVIDER_ACCEPTED_LATE'],
    ['2026-09-26T10:00:00.001Z', 'PROVIDER_ACCEPTED_LATE'],
  ])('classifies acceptance observed at %s as %s', (observed, state) => {
    const row = { ...started };
    const evidence = { ...event, providerAcceptedObservedAt: observed };
    const result = classify({ row, event: evidence });
    const next = {
      ...started,
      state,
      providerMessageId: event.providerMessageId,
      providerAcceptedObservedAt: observed,
    };
    expect(result).toEqual({ action: 'propose_cas', expected: started, next });
    expect(row).toEqual(started);
    expect(evidence).toEqual({
      ...event,
      providerAcceptedObservedAt: observed,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.action !== 'propose_cas') throw new Error('Proposal required');
    expect(Object.isFrozen(result.expected)).toBe(true);
    expect(Object.isFrozen(result.next)).toBe(true);
    expect(result.expected).not.toBe(row);
    row.branchId = 'changed';
    evidence.providerMessageId = 'changed';
    expect(result.expected).toEqual(started);
    expect(result.next).toEqual(next);
  });
  it.each([
    { attemptId: decisionId },
    { attemptId: common.attemptId.toUpperCase() },
    { sendToken: decisionId },
    { sendToken: sendToken.toLowerCase() },
    { sendToken: null },
  ])('requires exact stored attempt/token bytes %#', (patch) => {
    const input = { row: { ...started }, event: { ...event, ...patch } };
    const before = structuredClone(input);
    expect(classify(input)).toEqual(hold('conflict'));
    expect(input).toEqual(before);
  });
  it.each([
    { providerAcceptedObservedAt: resolvedAt },
    { providerAcceptedObservedAt: '2026-09-25T10:00:59.999Z' },
    { providerAcceptedObservedAt: '2026-09-25T10:01:00Z' },
    { providerAcceptedObservedAt: 'invalid' },
    { providerAcceptedObservedAt: '2026-02-30T10:01:00.000Z' },
    { providerMessageId: '' },
    { providerMessageId: '   ' },
    { providerMessageId: 'a\nb' },
    { providerMessageId: 'a\u0085b' },
    { providerMessageId: undefined },
    { kind: 'timeout' },
    { kind: 'DELIVERY_UNKNOWN' },
    { kind: 'ack' },
    { applyBefore: 'override' },
    { attemptedAt },
    { state: 'PROVIDER_ACCEPTED' },
  ])('holds invalid/ambiguous evidence without mutation %#', (patch) => {
    const input = { row: { ...started }, event: { ...event, ...patch } };
    const before = structuredClone(input);
    const result = classify(input);
    expect(result).toEqual(hold('invalid_snapshot'));
    expect(Object.isFrozen(result)).toBe(true);
    expect(input).toEqual(before);
  });
  it.each([
    { ...common, state: 'PENDING_DELIVERY' },
    { ...common, state: 'STALE', staleObservedAt: applyBefore },
    {
      ...started,
      state: 'PROVIDER_ACCEPTED',
      providerMessageId: event.providerMessageId,
      providerAcceptedObservedAt: attemptedAt,
    },
    {
      ...started,
      state: 'PROVIDER_ACCEPTED_LATE',
      providerMessageId: event.providerMessageId,
      providerAcceptedObservedAt: applyBefore,
    },
  ])('never replays, retries or overwrites a non-started row %#', (row) => {
    const before = structuredClone(row);
    expect(classify({ row, event })).toEqual(hold('not_started'));
    expect(row).toEqual(before);
  });
  it.each([
    null,
    [],
    { row: started },
    { row: started, event, extra: true },
    { row: { ...started, attemptId: decisionId }, event },
    { row: { ...started, attemptedAt: applyBefore }, event },
    { row: started, event: { providerMessageId: 'id alone' } },
    { row: started, event: { ...event, [Symbol('extra')]: 1 } },
  ])('rejects malformed snapshots %#', (input) => {
    expect(classify(input)).toEqual(hold('invalid_snapshot'));
  });
  it.each(Object.keys(event))('rejects missing evidence field %s', (key) => {
    const missing = Object.fromEntries(
      Object.entries(event).filter(([name]) => name !== key),
    );
    expect(classify({ row: started, event: missing })).toEqual(
      hold('invalid_snapshot'),
    );
  });
  it('rejects accessors without invoking them and accepts null-prototype data', () => {
    const getter = jest.fn(() => event);
    const input = Object.defineProperty({ row: started }, 'event', {
      enumerable: true,
      get: getter,
    });
    const evidence = Object.defineProperty({ ...event }, 'kind', {
      get: getter,
    });
    expect(classify(input)).toEqual(hold('invalid_snapshot'));
    expect(classify({ row: started, event: evidence })).toEqual(
      hold('invalid_snapshot'),
    );
    expect(getter).not.toHaveBeenCalled();
    const plain = Object.assign(Object.create(null) as object, {
      row: started,
      event: Object.assign(Object.create(null) as object, event),
    });
    expect(classify(plain)).toEqual(classify({ row: started, event }));
    expect(classify(plain).action).toBe('propose_cas');
  });
});
