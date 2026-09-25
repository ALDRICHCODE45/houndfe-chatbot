import { deriveRestockAttemptId } from './restock-attempt-identity';
import { classifyRestockApplicationStart as classify } from './restock-application-ledger-start';

const sourceRequestId = '11111111-1111-4111-8111-111111111111';
const decisionId = '22222222-2222-4222-8222-222222222222';
const sendToken = '33333333-3333-4333-8333-333333333333';
const resolvedAt = '2026-09-25T10:00:00.000Z';
const applyBefore = '2026-09-25T11:00:00.000Z';
const before = '2026-09-25T09:59:59.999Z';
const last = '2026-09-25T10:59:59.999Z';
const after = '2026-09-25T11:00:00.001Z';
const pending = {
  senderId: 'customer',
  branchId: 'branch',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId),
  resolvedAt,
  applyBefore,
  state: 'PENDING_DELIVERY',
};
const begin = { kind: 'begin_send', sendToken, attemptedAt: resolvedAt };
const expire = { kind: 'expire_unsent', observedAt: applyBefore };
const started = {
  ...pending,
  state: 'SEND_STARTED',
  sendToken,
  attemptedAt: resolvedAt,
};
const accepted = {
  ...started,
  state: 'PROVIDER_ACCEPTED',
  providerMessageId: 'provider',
  providerAcceptedObservedAt: resolvedAt,
};
function hold(input: unknown): void {
  const result = classify(input);
  expect(result.action).toBe('hold');
  expect(Object.keys(result).sort()).toEqual(['action', 'reason']);
  expect(Object.isFrozen(result)).toBe(true);
}

describe('classifyRestockApplicationStart recommendations only', () => {
  it.each([resolvedAt, last])('proposes begin at %s', (attemptedAt) => {
    expect(
      classify({ row: pending, event: { ...begin, attemptedAt } }),
    ).toEqual({
      action: 'propose_cas',
      expected: pending,
      next: { ...started, attemptedAt },
    });
  });
  it.each([before, applyBefore, after])('holds begin at %s', (attemptedAt) => {
    hold({ row: pending, event: { ...begin, attemptedAt } });
  });
  it.each([applyBefore, after])(
    'proposes unsent expiry at %s',
    (observedAt) => {
      expect(
        classify({ row: pending, event: { ...expire, observedAt } }),
      ).toEqual({
        action: 'propose_cas',
        expected: pending,
        next: { ...pending, state: 'STALE', staleObservedAt: observedAt },
      });
    },
  );
  it('holds expiry before the deadline', () => {
    hold({ row: pending, event: { ...expire, observedAt: last } });
  });
  it.each([
    'bad',
    null,
    undefined,
    pending.attemptId,
    pending.attemptId?.toUpperCase(),
  ])(
    'holds invalid or attempt-equal token %s without implicit expiry',
    (token) => hold({ row: pending, event: { ...begin, sendToken: token } }),
  );
  it.each([
    'bad',
    null,
    undefined,
    '2026-09-25T10:00:00Z',
    '2026-09-25T10:00:00.000+00:00',
    '2026-02-30T10:00:00.000Z',
  ])('holds noncanonical time %s for both events', (time) => {
    hold({ row: pending, event: { ...begin, attemptedAt: time } });
    hold({ row: pending, event: { ...expire, observedAt: time } });
  });
  it.each([
    ['same started token/time', started, begin],
    ['different started token', started, { ...begin, sendToken: decisionId }],
    ['started begin after expiry', started, { ...begin, attemptedAt: after }],
    [
      'started expiry before deadline',
      started,
      { ...expire, observedAt: last },
    ],
    ['started expiry at deadline', started, expire],
    [
      'started expiry after deadline',
      started,
      { ...expire, observedAt: after },
    ],
  ])('holds %s with no recovery authorization', (_name, row, event) => {
    hold({ row, event });
  });
  it.each([
    accepted,
    {
      ...accepted,
      state: 'PROVIDER_ACCEPTED_LATE',
      providerAcceptedObservedAt: applyBefore,
    },
    { ...pending, state: 'STALE', staleObservedAt: applyBefore },
  ])('never rewinds terminal $state', (row) => {
    hold({ row, event: begin });
    hold({ row, event: expire });
  });
  it.each([
    ['forged attempt', { attemptId: sendToken }],
    ['forged source', { sourceRequestId: sendToken }],
    ['forged decision', { decisionId: sendToken }],
    ['wrong version', { resolutionVersion: 1 }],
    ['pending evidence', { sendToken }],
    ['unknown terminal', { state: 'DELIVERY_UNKNOWN' }],
    ['invalid window', { applyBefore: after }],
  ])('holds malformed row: %s', (_name, patch) => {
    hold({ row: { ...pending, ...patch }, event: begin });
    hold({ row: { ...pending, ...patch }, event: expire });
  });
  it.each(Object.keys(pending))('holds omitted row key %s', (key) => {
    const row: Record<string, unknown> = { ...pending };
    delete row[key];
    hold({ row, event: begin });
  });
  it.each([begin, expire])('requires every event key for $kind', (event) => {
    for (const key of Object.keys(event)) {
      const copy: Record<string, unknown> = { ...event };
      delete copy[key];
      hold({ row: pending, event: copy });
    }
    hold({ row: pending, event: { ...event, extra: undefined } });
  });
  it.each([
    null,
    [],
    'input',
    {},
    { row: pending },
    { event: begin },
    { row: pending, event: begin, extra: undefined },
    { row: pending, event: { ...begin, kind: 'authorize_send' } },
    { row: pending, event: { ...expire, sendToken } },
  ])('holds malformed envelope/event %#', (input) => hold(input));
  const hostile = [
    [
      'class',
      (value: object) => Object.assign(new (class Snapshot {})(), value),
    ],
    ['inherited', (value: object): unknown => Object.create(value)],
    ['symbol', (value: object) => ({ ...value, [Symbol('extra')]: 1 })],
    [
      'hidden extra',
      (value: object) =>
        Object.defineProperty({ ...value }, 'extra', { value: 1 }),
    ],
    [
      'accessor',
      (value: object) =>
        Object.defineProperty({ ...value }, Object.keys(value)[0], {
          get: () => {
            throw new Error('must not read');
          },
        }),
    ],
    [
      'throwing proxy',
      (value: object) =>
        new Proxy(value, {
          ownKeys: () => {
            throw new Error('trap');
          },
        }),
    ],
    [
      'read mismatch',
      (value: object) => new Proxy(value, { get: () => 'substituted' }),
    ],
    [
      'revoked proxy',
      (value: object) => {
        const proxy = Proxy.revocable(value, {});
        proxy.revoke();
        return proxy.proxy;
      },
    ],
  ] as const;
  it.each(hostile)(
    'fails closed for hostile %s at every boundary',
    (_name, make) => {
      hold(make({ row: pending, event: begin }));
      hold({ row: pending, event: make(begin) });
      hold({ row: pending, event: make(expire) });
      hold({ row: make(pending), event: begin });
    },
  );
  it.each([begin, expire])(
    'returns detached frozen recommendations for $kind',
    (event) => {
      const row = { ...pending };
      const input = { row, event: { ...event } };
      const original = JSON.stringify(input);
      const result = classify(input);
      expect(JSON.stringify(input)).toBe(original);
      expect(result.action).toBe('propose_cas');
      if (result.action !== 'propose_cas')
        throw new Error('expected recommendation');
      expect(Object.keys(result).sort()).toEqual([
        'action',
        'expected',
        'next',
      ]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.expected)).toBe(true);
      expect(Object.isFrozen(result.next)).toBe(true);
      expect(result.expected).not.toBe(row);
      expect(result.next).not.toBe(row);
      expect(result.next).not.toBe(result.expected);
      row.branchId = 'changed';
      input.event.kind = 'changed';
      expect(result.expected.branchId).toBe('branch');
      expect(result.next.branchId).toBe('branch');
      expect(result.next).not.toHaveProperty('customerNotified');
      expect(result.next).not.toHaveProperty('sent');
      expect(JSON.stringify(result)).not.toContain('authorize_send');
    },
  );
  it('accepts null-prototype own snapshots', () => {
    const plain = (value: object): unknown =>
      Object.assign(Object.create(null), value);
    expect(
      classify(plain({ row: plain(pending), event: plain(begin) })).action,
    ).toBe('propose_cas');
  });
});
