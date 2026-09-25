import { deriveRestockAttemptId } from './restock-attempt-identity';
import { classifyRestockApplicationAcceptance as classify } from './restock-application-ledger-acceptance';

const sourceRequestId = '11111111-1111-4111-8111-111111111111';
const decisionId = '22222222-2222-4222-8222-222222222222';
const sendToken = 'abcdefab-3333-4333-8333-333333333333';
const resolvedAt = '2026-09-25T10:00:00.000Z';
const attemptedAt = '2026-09-25T10:01:00.000Z';
const applyBefore = '2026-09-25T11:00:00.000Z';
const last = '2026-09-25T10:59:59.999Z';
const after = '2026-09-25T11:00:00.001Z';
const common = {
  senderId: 'customer',
  branchId: 'branch',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId),
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
function terminal(observed: string, state = 'PROVIDER_ACCEPTED') {
  return {
    ...started,
    state,
    providerMessageId: event.providerMessageId,
    providerAcceptedObservedAt: observed,
  };
}
function hold(input: unknown) {
  const result = classify(input);
  expect(result.action).toBe('hold');
  expect(Object.keys(result).sort()).toEqual(['action', 'reason']);
  expect(Object.isFrozen(result)).toBe(true);
}
const accessor = () =>
  Object.defineProperty({ ...event }, 'kind', {
    get: () => {
      throw new Error('getter must not run');
    },
  });
const hostile = () =>
  new Proxy(event, {
    ownKeys: () => {
      throw new Error('hostile');
    },
  });

describe('inert provider acceptance recommendations', () => {
  it.each([
    ['attempt lower boundary', attemptedAt, 'PROVIDER_ACCEPTED'],
    ['deadline minus one', last, 'PROVIDER_ACCEPTED'],
    ['deadline equality', applyBefore, 'PROVIDER_ACCEPTED_LATE'],
    ['after deadline', after, 'PROVIDER_ACCEPTED_LATE'],
  ])('%s', (_, observed, state) => {
    expect(
      classify({
        row: started,
        event: { ...event, providerAcceptedObservedAt: observed },
      }),
    ).toEqual({
      action: 'propose_cas',
      expected: started,
      next: terminal(observed, state),
    });
  });
  it.each([
    ['before attempt', { providerAcceptedObservedAt: resolvedAt }],
    ['noncanonical date', { providerAcceptedObservedAt: '2026-09-25' }],
    [
      'impossible date',
      { providerAcceptedObservedAt: '2026-02-30T10:00:00.000Z' },
    ],
    ['blank provider ID', { providerMessageId: '  ' }],
    ['control provider ID', { providerMessageId: 'a\u0085b' }],
    ['newline provider ID', { providerMessageId: 'a\nb' }],
    ['wrong attempt', { attemptId: decisionId }],
    ['uppercase attempt', { attemptId: common.attemptId?.toUpperCase() }],
    ['wrong token', { sendToken: decisionId }],
    ['invalid token', { sendToken: 'bad' }],
    ['undefined evidence', { providerMessageId: undefined }],
    ['caller outcome', { state: 'PROVIDER_ACCEPTED' }],
    ['caller attempt time', { attemptedAt }],
    ['caller deadline', { applyBefore }],
    ['unknown outcome', { kind: 'DELIVERY_UNKNOWN' }],
    ['timeout', { kind: 'timeout' }],
    ['crash', { kind: 'crash' }],
  ])('holds %s', (_, patch) => {
    hold({ row: started, event: { ...event, ...patch } });
  });
  it('binds UUID token aliases without replacing stored bytes', () => {
    const row = { ...started, sendToken: sendToken.toUpperCase() };
    const result = classify({ row, event });
    expect(result).toEqual({
      action: 'propose_cas',
      expected: row,
      next: { ...terminal(attemptedAt), sendToken: row.sendToken },
    });
  });
  describe.each([
    ['PROVIDER_ACCEPTED', attemptedAt],
    ['PROVIDER_ACCEPTED_LATE', applyBefore],
  ])('%s immutable terminal', (state, observed) => {
    const row = terminal(observed, state);
    const matching = { ...event, providerAcceptedObservedAt: observed };
    it('replays only the existing detached frozen row', () => {
      const result = classify({ row, event: matching });
      expect(result).toEqual({ action: 'replay', row });
      expect(Object.isFrozen(result)).toBe(true);
      if (result.action !== 'replay') throw new Error('expected replay');
      expect(result.row).not.toBe(row);
      expect(Object.isFrozen(result.row)).toBe(true);
    });
    it('replays a token UUID case alias', () => {
      expect(
        classify({
          row,
          event: { ...matching, sendToken: sendToken.toUpperCase() },
        }),
      ).toEqual({ action: 'replay', row });
    });
    it.each([
      ['different message', { providerMessageId: 'other' }],
      ['trimmed message', { providerMessageId: 'provider opaque' }],
      ['different time', { providerAcceptedObservedAt: after }],
      ['different token', { sendToken: decisionId }],
      ['different attempt', { attemptId: decisionId }],
      ['deadline override', { applyBefore: after }],
    ])('holds %s without rewriting', (_, patch) => {
      hold({ row, event: { ...matching, ...patch } });
    });
    it('holds inconsistent terminal outcome timing', () => {
      hold({
        row: {
          ...row,
          state:
            state === 'PROVIDER_ACCEPTED'
              ? 'PROVIDER_ACCEPTED_LATE'
              : 'PROVIDER_ACCEPTED',
        },
        event: matching,
      });
    });
    it('holds a changed row deadline', () => {
      hold({ row: { ...row, applyBefore: after }, event: matching });
    });
  });
  it.each([
    ['pending', { ...common, state: 'PENDING_DELIVERY' }],
    ['stale', { ...common, state: 'STALE', staleObservedAt: applyBefore }],
    ['bad source', { ...started, sourceRequestId: 'bad' }],
    ['bad identity', { ...started, attemptId: decisionId }],
    ['extra row field', { ...started, extra: true }],
    ['unknown row', { ...started, state: 'DELIVERY_UNKNOWN' }],
    ['null row', null],
  ])('holds %s row', (_, row) => hold({ row, event }));
  it.each([
    ['null', null],
    ['array', []],
    ['class', new (class Event {})()],
    ['accessor', accessor()],
    ['throwing proxy', hostile()],
    ['symbol', { ...event, [Symbol('extra')]: true }],
    ['extra field', { ...event, extra: true }],
    ['missing fields', { kind: event.kind }],
    ['read mismatch', new Proxy(event, { get: () => 'different' })],
  ])('holds hostile event %s', (_, value) => {
    hold({ row: started, event: value });
  });
  it.each([
    ['null', null],
    ['array', []],
    ['undefined event', { row: started, event: undefined }],
    ['missing event', { row: started }],
    ['extra key', { row: started, event, extra: true }],
    ['symbol', { row: started, event, [Symbol('extra')]: true }],
    ['throwing proxy', hostile()],
    ['accessor', Object.defineProperty({}, 'row', { get: () => started })],
    [
      'class',
      new (class Input {
        row = started;
        event = event;
      })(),
    ],
    ['mismatch', new Proxy({ row: started, event }, { get: () => null })],
  ])('holds hostile input %s', (_, input) => hold(input));
  it.each(Object.keys(event))(
    'rejects missing or undefined event %s',
    (key) => {
      const missing = Object.fromEntries(
        Object.entries(event).filter(([name]) => name !== key),
      );
      hold({ row: started, event: missing });
      hold({ row: started, event: { ...event, [key]: undefined } });
    },
  );
  it.each([
    [
      'accessor',
      Object.defineProperty({ ...started }, 'state', { get: jest.fn() }),
    ],
    ['symbol', { ...started, [Symbol('extra')]: true }],
    ['read mismatch', new Proxy(started, { get: () => null })],
    ['throwing proxy', hostile()],
  ])('holds hostile row %s', (_, row) => hold({ row, event }));
  it('accepts plain null-prototype envelopes and events', () => {
    const input = Object.assign(Object.create(null) as object, {
      row: started,
      event: Object.assign(Object.create(null) as object, event),
    });
    expect(classify(input)).toEqual({
      action: 'propose_cas',
      expected: started,
      next: terminal(attemptedAt),
    });
  });
  it('detaches and freezes all recommendations without invoking a sender', () => {
    const row = { ...started };
    const evidence = { ...event };
    const result = classify({ row, event: evidence });
    if (result.action !== 'propose_cas') throw new Error('expected CAS');
    expect(result.expected).not.toBe(row);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.expected)).toBe(true);
    expect(Object.isFrozen(result.next)).toBe(true);
    row.sendToken = decisionId;
    evidence.providerMessageId = 'changed';
    expect(result.expected).toEqual(started);
    expect(result.next).toEqual(terminal(attemptedAt));
    const send = jest.fn();
    hold({ row: started, event, send });
    expect(send).not.toHaveBeenCalled();
  });
});
