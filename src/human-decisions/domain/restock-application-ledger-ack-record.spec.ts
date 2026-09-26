import { deriveRestockAttemptId } from './restock-attempt-identity';
import {
  classifyRestockApplicationAckRecord as classify,
  normalizeRestockApplicationAckRecord as normalize,
} from './restock-application-ledger-ack-record';

const sourceRequestId = '11111111-1111-4111-8111-111111111111';
const decisionId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const common = {
  senderId: 'local',
  branchId: ' branch ',
  sourceRequestId,
  decisionId,
  resolutionVersion: 2,
  attemptId: deriveRestockAttemptId(sourceRequestId, decisionId)!,
  resolvedAt: '2026-09-25T10:00:00.000Z',
  applyBefore: '2026-09-25T11:00:00.000Z',
};
const accepted = {
  ...common,
  state: 'PROVIDER_ACCEPTED',
  sendToken: '22222222-2222-4222-8222-222222222222',
  attemptedAt: '2026-09-25T10:30:00.000Z',
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
const ack = (row = accepted) => ({
  id: decisionId.toLowerCase(),
  version: 2,
  attemptId: row.attemptId.toUpperCase(),
  outcome: row.state,
  ackReceivedAt: '2020-01-01T00:00:00Z',
});
const receipt = ack();
const previous = { row: accepted, receipt };
function hold(row: unknown, received: unknown, prior: unknown) {
  const result = classify(row, received, prior);
  expect(result.action).toBe('hold');
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty('next');
}
const reordered = (value: object) =>
  Object.fromEntries(Object.entries(value).reverse());

describe('local terminal ACK record recommendations', () => {
  it.each([accepted, late, stale])('records and replays $state', (row) => {
    const received = { ...receipt, outcome: row.state };
    const result = classify(row, received, null);
    expect(result.action).toBe('record');
    if (result.action !== 'record') throw new Error('not record');
    expect(result).toEqual({
      action: 'record',
      expectedRow: row,
      expectedRecord: null,
      next: { row, receipt: received },
    });
    expect(classify(row, received, result.next).action).toBe('replay');
    expect(classify(row, received, null)).toEqual(result);
    expect(normalize(result.next)).toEqual(result.next);
    for (const snapshot of [
      result,
      result.expectedRow,
      result.next,
      result.next.row,
      result.next.receipt,
    ])
      expect(Object.isFrozen(snapshot)).toBe(true);
    expect(result.next.row).not.toBe(row);
    expect(result.next.receipt).not.toBe(received);
    expect(result.expectedRow).not.toBe(row);
    expect(Object.isFrozen(row)).toBe(false);
    expect(Object.isFrozen(received)).toBe(false);
    received.ackReceivedAt = 'changed';
    expect(result.next.receipt.ackReceivedAt).toBe(receipt.ackReceivedAt);
    if (row.state === 'STALE') {
      expect(result.next.row).not.toHaveProperty('attemptedAt');
      expect(result.next.row).not.toHaveProperty('providerMessageId');
    }
  });

  it('detaches rows and ignores key order for exact replay', () => {
    const row = { ...accepted };
    const result = classify(row, receipt, null);
    if (result.action !== 'record') throw new Error('not record');
    row.providerMessageId = 'mutated';
    expect(result.next.row).toEqual(accepted);
    expect(result.expectedRow).toEqual(accepted);
    const replay = classify(reordered(accepted), reordered(receipt), {
      receipt: reordered(receipt),
      row: reordered(accepted),
    });
    expect(replay.action).toBe('replay');
    expect(Object.isFrozen(replay)).toBe(true);
  });

  it.each([
    { id: sourceRequestId },
    { attemptId: sourceRequestId },
    { outcome: 'STALE' },
    { outcome: 'DELIVERY_UNKNOWN' },
    { version: 3 },
    { ackReceivedAt: 'not-time' },
    { ackReceivedAt: null },
    { extra: null },
    { id: ` ${decisionId}` },
    { attemptId: ` ${common.attemptId}` },
    { outcome: 'provider_accepted' },
  ])('holds invalid or unbound receipt %j', (patch) => {
    hold(accepted, { ...receipt, ...patch }, null);
  });

  it.each([
    undefined,
    null,
    {},
    [],
    { ...common, state: 'PENDING_DELIVERY' },
    {
      ...common,
      state: 'SEND_STARTED',
      sendToken: accepted.sendToken,
      attemptedAt: accepted.attemptedAt,
    },
    { ...accepted, state: 'DELIVERY_UNKNOWN' },
  ])('holds nonterminal or corrupt row %#', (row) => {
    hold(row, receipt, null);
  });

  it.each([
    undefined,
    {},
    [],
    { row: accepted },
    { receipt },
    { ...previous, extra: true },
    { row: { ...accepted, extra: true }, receipt },
    { row: accepted, receipt: { ...receipt, version: 1 } },
  ])('requires explicit absence or fully valid previous record %#', (prior) => {
    hold(accepted, receipt, prior);
    expect(normalize(prior)).toBeNull();
  });

  it.each([
    { providerMessageId: 'provider-é' },
    { providerAcceptedObservedAt: '2026-09-25T10:32:00.000Z' },
    { attemptedAt: '2026-09-25T10:29:00.000Z' },
    { senderId: 'another' },
    { branchId: 'branch' },
    { sendToken: sourceRequestId },
    { decisionId: decisionId.toLowerCase() },
    {
      resolvedAt: '2026-09-25T10:01:00.000Z',
      applyBefore: '2026-09-25T11:01:00.000Z',
    },
  ])('never replaces same-attempt evidence or local identity %j', (patch) => {
    const row = { ...accepted, ...patch };
    expect(classify(row, receipt, null).action).toBe('record');
    hold(row, receipt, previous);
    hold(accepted, receipt, { row, receipt });
  });

  it.each([
    { id: decisionId },
    { attemptId: common.attemptId.toLowerCase() },
    { ackReceivedAt: '2020-01-01T00:00:00.000Z' },
  ])('holds changed ACK bytes %j', (patch) => {
    const changed = { ...receipt, ...patch };
    const result = classify(accepted, changed, null);
    if (result.action !== 'record') throw new Error('not record');
    expect(result.next.receipt).toEqual(changed);
    hold(accepted, changed, previous);
  });

  it('never upgrades late or replaces stale outcomes', () => {
    hold(late, ack(late), previous);
    hold(accepted, receipt, { row: late, receipt: ack(late) });
    hold(stale, { ...receipt, outcome: 'STALE' }, previous);
    hold(late, receipt, null);
  });

  it('rejects missing fields and hostile data without invoking getters', () => {
    const getter = jest.fn(() => accepted);
    const hostile = [
      Object.defineProperty({}, 'row', { get: getter }),
      { ...previous, [Symbol('extra')]: true },
      Object.create(previous) as unknown,
      new Proxy(previous, {
        getPrototypeOf() {
          throw new Error('trap');
        },
      }),
      new Proxy(previous, {}),
    ];
    for (const value of hostile) {
      hold(value, receipt, null);
      hold(accepted, value, null);
      hold(accepted, receipt, value);
      expect(normalize(value)).toBeNull();
    }
    for (const [key, value] of Object.entries(previous)) {
      const accessor = Object.defineProperty({ ...previous }, key, {
        get: getter,
      });
      expect(normalize(accessor)).toBeNull();
      for (const field of Object.keys(value)) {
        const missing = { ...value } as Record<string, unknown>;
        delete missing[field];
        expect(normalize({ ...previous, [key]: missing })).toBeNull();
        const nested = Object.defineProperty({ ...value }, field, {
          get: getter,
        });
        expect(normalize({ ...previous, [key]: nested })).toBeNull();
      }
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
