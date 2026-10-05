import { deriveExpirationAttemptId } from './expiration-attempt-identity';
import { classifyExpirationApplicationStart as classify } from './expiration-application-ledger-start';

const sourceRequestId = '848d8b89-b323-5a4f-952e-41ebcc00d733';
const decisionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const sendToken = 'aAbBcCdD-3333-4333-8333-333333333333';
const resolvedAt = '2026-09-25T10:00:00.000Z';
const applyBefore = '2026-09-26T10:00:00.000Z';
const pending = () => ({
  state: 'PENDING_DELIVERY',
  senderId: 'customer',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveExpirationAttemptId(sourceRequestId, decisionId)!,
  resolvedAt,
  applyBefore,
});
const event = (attemptedAt = resolvedAt) => ({
  kind: 'begin_send',
  sendToken,
  attemptedAt,
});
const hold = (reason: string) => ({ action: 'hold', reason });

describe('inactive EXPIRATION begin-send proposal', () => {
  it.each([resolvedAt, '2026-09-25T11:00:00.000Z', '2026-09-26T09:59:59.999Z'])(
    'preserves every identity byte and proposes only SEND_STARTED at %s',
    (at) => {
      const row = pending();
      const input = { row, event: event(at) };
      const result = classify(input);
      expect(result).toEqual({
        action: 'propose_cas',
        expected: row,
        next: { ...row, state: 'SEND_STARTED', sendToken, attemptedAt: at },
      });
      expect(input).toEqual({ row: pending(), event: event(at) });
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'propose_cas') throw new Error('proposal required');
      expect(Object.isFrozen(result.expected)).toBe(true);
      expect(Object.isFrozen(result.next)).toBe(true);
      expect(result.expected).not.toBe(row);
      row.branchId = 'mutated';
      input.event.sendToken = decisionId;
      expect(result.expected).toEqual(pending());
      expect(result.next).toEqual({
        ...pending(),
        state: 'SEND_STARTED',
        sendToken,
        attemptedAt: at,
      });
    },
  );
  it.each([
    '2026-09-25T09:59:59.999Z',
    applyBefore,
    '2026-09-26T10:00:00.001Z',
    'invalid',
    '2026-09-25T10:00:00Z',
  ])(
    'holds invalid/out-of-window time %s without changing the pending row',
    (at) => {
      const input = { row: pending(), event: event(at) };
      const before = { row: { ...input.row }, event: { ...input.event } };
      expect(classify(input)).toEqual(hold('invalid_transition'));
      expect(input).toEqual(before);
    },
  );
  it.each([
    'not-a-token',
    '',
    pending().attemptId,
    pending().attemptId.toUpperCase(),
  ])('rejects invalid or attempt-identity token %s', (token) => {
    const input = { row: pending(), event: { ...event(), sendToken: token } };
    expect(classify(input)).toEqual(hold('invalid_transition'));
    expect(input.row).toEqual(pending());
  });
  it.each([
    'SEND_STARTED',
    'PROVIDER_ACCEPTED',
    'PROVIDER_ACCEPTED_LATE',
    'STALE',
  ])('never retries or proposes another transition from %s', (state) => {
    const row =
      state === 'STALE'
        ? { ...pending(), state, staleObservedAt: applyBefore }
        : {
            ...pending(),
            state,
            sendToken,
            attemptedAt: resolvedAt,
            ...(state.startsWith('PROVIDER')
              ? {
                  providerMessageId: 'provider',
                  providerAcceptedObservedAt:
                    state === 'PROVIDER_ACCEPTED_LATE'
                      ? applyBefore
                      : resolvedAt,
                }
              : {}),
          };
    const before = { ...row };
    expect(classify({ row, event: event() })).toEqual(hold('not_pending'));
    expect(row).toEqual(before);
  });
  it.each([
    null,
    [],
    {},
    { row: pending() },
    { row: pending(), event: event(), extra: true },
    { row: { ...pending(), decisionId: 'invalid' }, event: event() },
    { row: pending(), event: { ...event(), extra: true } },
    { row: pending(), event: { kind: 'begin_send', sendToken } },
    {
      row: pending(),
      event: { kind: 'expire_unsent', observedAt: applyBefore },
    },
    { row: pending(), event: { kind: 'ack' } },
  ])('fails closed on unsupported/malformed snapshots %#', (input) => {
    const result = classify(input);
    expect(result).toEqual(hold('invalid_snapshot'));
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('rejects accessor and symbol envelopes/events without invoking getters', () => {
    const getter = jest.fn(() => pending());
    const envelope = Object.defineProperty({ event: event() }, 'row', {
      enumerable: true,
      get: getter,
    });
    const attempt = Object.defineProperty(
      { kind: 'begin_send', sendToken },
      'attemptedAt',
      { enumerable: true, get: getter },
    );
    for (const input of [
      envelope,
      { row: pending(), event: attempt },
      { row: pending(), event: { ...event(), [Symbol('extra')]: 1 } },
    ]) {
      expect(classify(input)).toEqual(hold('invalid_snapshot'));
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('accepts detached null-prototype input and event data', () => {
    const input: unknown = Object.assign(Object.create(null), {
      row: pending(),
      event: Object.assign(Object.create(null), event()) as unknown,
    });
    expect(classify(input)).toEqual(
      classify({ row: pending(), event: event() }),
    );
    expect(classify(input).action).toBe('propose_cas');
  });
});
