import { deriveRestockAttemptId } from './restock-attempt-identity';
import { prepareRestockApplicationOutcome } from './restock-application-ledger-ack-preparation';

const sourceRequestId = '11111111-1111-4111-8111-111111111111';
const decisionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const common = {
  senderId: 'customer-local-only',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId),
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-25T11:00:00.000Z',
};
const started = {
  ...common,
  state: 'SEND_STARTED',
  sendToken: '22222222-2222-4222-8222-222222222222',
  attemptedAt: '2026-09-25T10:30:00.000Z',
};
const accepted = {
  ...started,
  state: 'PROVIDER_ACCEPTED',
  providerMessageId: ' provider-e\u0301 ',
  providerAcceptedObservedAt: '2026-09-25T10:31:00.000Z',
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

function expectHold(input: unknown, reason = 'invalid_row') {
  const result = prepareRestockApplicationOutcome(input);
  expect(result).toEqual({ action: 'hold', reason });
  expect(Object.isFrozen(result)).toBe(true);
}

describe('inert terminal ACK preparation', () => {
  it.each([accepted, late, stale])('maps exact $state evidence', (row) => {
    const result = prepareRestockApplicationOutcome(row);
    expect(result.action).toBe('prepared');
    if (result.action !== 'prepared') throw new Error('not prepared');
    const base = {
      attemptId: row.attemptId,
      expectedResolutionVersion: 2,
      outcome: row.state,
    };
    expect(result).toEqual({
      action: 'prepared',
      decisionId,
      expected: row,
      request:
        'attemptedAt' in row
          ? {
              ...base,
              attemptedAt: row.attemptedAt,
              providerMessageId: row.providerMessageId,
              providerAcceptedObservedAt: row.providerAcceptedObservedAt,
            }
          : base,
    });
    expect(Object.keys(result.request).sort()).toEqual(
      ('attemptedAt' in row
        ? 'attemptId expectedResolutionVersion outcome attemptedAt providerMessageId providerAcceptedObservedAt'
        : 'attemptId expectedResolutionVersion outcome'
      )
        .split(' ')
        .sort(),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.expected)).toBe(true);
    expect(Object.isFrozen(result.request)).toBe(true);
    expect(result.expected).not.toBe(row);
    expect(JSON.stringify(result.request)).not.toContain(row.senderId);
    expect(JSON.stringify(result.request)).not.toContain(started.sendToken);
    expect(JSON.stringify(prepareRestockApplicationOutcome(row))).toBe(
      JSON.stringify(result),
    );
  });

  it('detaches without changing or freezing caller data', () => {
    const input = { ...accepted };
    const before = { ...input };
    const result = prepareRestockApplicationOutcome(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    input.providerMessageId = 'changed';
    input.state = 'SEND_STARTED';
    expect(result.action).toBe('prepared');
    if (result.action !== 'prepared') throw new Error('not prepared');
    expect(result.expected).toEqual(before);
    expect(result.request).toHaveProperty(
      'providerMessageId',
      before.providerMessageId,
    );
  });

  it.each([{ ...common, state: 'PENDING_DELIVERY' }, started])(
    'holds $state without recovery inference',
    (row) => expectHold(row, 'nonterminal_row'),
  );

  it.each([
    null,
    undefined,
    [],
    {},
    { ...accepted, state: 'DELIVERY_UNKNOWN' },
    { ...accepted, state: 'OTHER' },
    { ...accepted, extra: null },
    { ...accepted, evidenceCode: null },
    { ...accepted, attemptId: started.sendToken },
    { ...accepted, attemptId: common.attemptId?.toUpperCase() },
    { ...accepted, decisionId: sourceRequestId },
    { ...accepted, resolutionVersion: 1 },
    { ...accepted, sendToken: common.attemptId },
    { ...accepted, sendToken: 'bad-token' },
    { ...accepted, sendToken: null },
    { ...accepted, attemptedAt: common.applyBefore },
    { ...accepted, attemptedAt: '2026-09-25T09:59:59.999Z' },
    { ...accepted, attemptedAt: '2026-09-25T10:30:00Z' },
    { ...accepted, attemptedAt: '2026-09-25T11:30:00.000+01:00' },
    { ...accepted, resolvedAt: 'invalid' },
    { ...accepted, applyBefore: '2026-09-25T11:01:00.000Z' },
    { ...accepted, providerMessageId: null },
    { ...accepted, providerMessageId: '  ' },
    { ...accepted, providerMessageId: 'id\n' },
    { ...accepted, providerAcceptedObservedAt: null },
    { ...accepted, providerAcceptedObservedAt: common.resolvedAt },
    { ...accepted, providerAcceptedObservedAt: common.applyBefore },
    {
      ...late,
      providerAcceptedObservedAt: accepted.providerAcceptedObservedAt,
    },
    { ...stale, staleObservedAt: common.resolvedAt },
    { ...stale, attemptedAt: null },
    { ...stale, providerMessageId: null },
    { ...stale, providerAcceptedObservedAt: null },
    { ...stale, sendToken: null },
    { ...stale, evidenceCode: null },
  ])('rejects malformed input %# without repairing it', (row) => {
    expectHold(row);
  });

  it('rejects missing fields and hostile descriptors/proxies without throwing', () => {
    const missing: Partial<typeof accepted> = { ...accepted };
    delete missing.providerMessageId;
    expectHold(missing);
    const getter = jest.fn(() => accepted.providerMessageId);
    expectHold(
      Object.defineProperty({ ...accepted }, 'providerMessageId', {
        get: getter,
      }),
    );
    expect(getter).not.toHaveBeenCalled();
    expectHold({ ...accepted, [Symbol('extra')]: true });
    expectHold(Object.create(accepted));
    expectHold(
      new Proxy(accepted, {
        getPrototypeOf() {
          throw new Error('hostile');
        },
      }),
    );
    expectHold(
      new Proxy(accepted, {
        get(target, key): unknown {
          return key === 'providerMessageId'
            ? 'mismatch'
            : Reflect.get(target, key);
        },
      }),
    );
  });
});
