import { deriveRestockSourceRequestId } from './restock-source-identity';
import {
  bindRestockInboundEvidence,
  normalizeRestockInboundEvidence,
} from './restock-inbound-evidence';

const phone = '123456789';
const event = {
  receivingPhoneNumberId: phone,
  senderId: 'ABCdef-é',
  messageId: 'wamid.ABCdef',
};
const input = () => ({
  event: { ...event },
  providerTimestampSeconds: '1700000000',
  observedAt: '2023-11-14T22:13:20.000Z',
});
const row = () => ({
  ...event,
  sourceRequestId: deriveRestockSourceRequestId(event)!,
  providerTimestampSeconds: '1700000000',
  observedAt: '2023-11-14T22:13:20.000Z',
  version: 1,
});

describe('inert restock inbound evidence binding', () => {
  it('derives the golden identity and retains the original clocks on replay', () => {
    expect(bindRestockInboundEvidence(input(), phone)).toEqual(row());
    expect(bindRestockInboundEvidence(input(), phone)).toEqual(row());
    expect(normalizeRestockInboundEvidence(row())).toEqual(row());
  });

  it('freezes detached snapshots without mutating inputs', () => {
    const source = input();
    const stored = row();
    const bound = bindRestockInboundEvidence(source, phone)!;
    const normalized = normalizeRestockInboundEvidence(stored)!;
    source.event.senderId = 'changed';
    source.observedAt = '2024-01-01T00:00:00.000Z';
    stored.messageId = 'changed';
    stored.providerTimestampSeconds = '1';
    expect(bound).toEqual(row());
    expect(normalized).toEqual(row());
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it.each(['', 'other', '0123456789', '123456789 ', '1'.repeat(25)])(
    'holds a mismatched or malformed configured phone %s',
    (configured) => {
      expect(bindRestockInboundEvidence(input(), configured)).toBeNull();
    },
  );

  it('preserves case and Unicode bytes without trimming or NFC', () => {
    for (const senderId of ['ABCdef-é', 'abcdef-é', 'ABCdef-e\u0301']) {
      const source = input();
      source.event.senderId = senderId;
      const result = bindRestockInboundEvidence(source, phone)!;
      expect(result.senderId).toBe(senderId);
      expect(result.sourceRequestId).toBe(
        deriveRestockSourceRequestId(source.event),
      );
    }
    for (const key of ['senderId', 'messageId'] as const) {
      const source = input();
      source.event[key] += 'different';
      const changed = bindRestockInboundEvidence(source, phone);
      expect(changed).not.toBeNull();
      expect(changed!.sourceRequestId).not.toBe(row().sourceRequestId);
      source.event[key] = ` ${event[key]}`;
      expect(bindRestockInboundEvidence(source, phone)).toBeNull();
    }
    const source = input();
    source.event.receivingPhoneNumberId = '987';
    const changed = bindRestockInboundEvidence(source, '987');
    expect(changed).not.toBeNull();
    expect(changed!.sourceRequestId).not.toBe(row().sourceRequestId);
  });

  it.each(['\u0000', '\u001f', '\u007f', '\u0080', '\u009f'])(
    'rejects embedded control %j in either identity',
    (control) => {
      for (const key of ['senderId', 'messageId'] as const) {
        const source = input();
        source.event[key] = `a${control}b`;
        expect(bindRestockInboundEvidence(source, phone)).toBeNull();
        const stored = { ...row(), ...source.event };
        stored.sourceRequestId = deriveRestockSourceRequestId(source.event)!;
        expect(normalizeRestockInboundEvidence(stored)).toBeNull();
      }
    },
  );

  it.each([
    '',
    '0',
    '01',
    '-1',
    '+1',
    '1.0',
    ' 1',
    '1 ',
    '1e3',
    'NaN',
    'Infinity',
    '9007199254740992',
    '9007199254741',
    '8640000000001',
    1700000000,
    null,
  ])('holds invalid or out-of-range raw seconds %j', (seconds) => {
    expect(
      bindRestockInboundEvidence(
        { ...input(), providerTimestampSeconds: seconds },
        phone,
      ),
    ).toBeNull();
    expect(
      normalizeRestockInboundEvidence({
        ...row(),
        providerTimestampSeconds: seconds,
      }),
    ).toBeNull();
  });

  it.each([
    '',
    'invalid',
    '2023-11-14T22:13:20Z',
    '2023-11-14T22:13:20.000+00:00',
    '2023-02-30T00:00:00.000Z',
    '2023-11-14T22:13:19.999Z',
    '2023-11-14t22:13:20.000z',
    null,
    1700000000000,
  ])(
    'holds noncanonical observations and future provider time %j',
    (observedAt) => {
      expect(
        bindRestockInboundEvidence({ ...input(), observedAt }, phone),
      ).toBeNull();
      expect(
        normalizeRestockInboundEvidence({ ...row(), observedAt }),
      ).toBeNull();
    },
  );

  it('allows boundary equality, later observation and valid maximum UTC date', () => {
    expect(normalizeRestockInboundEvidence(row())).not.toBeNull();
    expect(
      normalizeRestockInboundEvidence({
        ...row(),
        observedAt: '2023-11-14T22:13:20.001Z',
      }),
    ).not.toBeNull();
    expect(
      normalizeRestockInboundEvidence({
        ...row(),
        providerTimestampSeconds: '1700000001',
      }),
    ).toBeNull();
    expect(
      normalizeRestockInboundEvidence({
        ...row(),
        providerTimestampSeconds: '8640000000000',
        observedAt: '+275760-09-13T00:00:00.000Z',
      }),
    ).not.toBeNull();
  });

  it('inherits identity bounds and never consults the current clock', () => {
    const now = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('no current clock');
    });
    try {
      expect(bindRestockInboundEvidence(input(), phone)).toEqual(row());
      for (const [key, value] of [
        ['senderId', 'x'.repeat(201)],
        ['messageId', 'x'.repeat(513)],
        ['receivingPhoneNumberId', '1'.repeat(25)],
        ['receivingPhoneNumberId', 'bad'],
      ]) {
        const source = { ...input(), event: { ...event, [key]: value } };
        expect(bindRestockInboundEvidence(source, phone)).toBeNull();
      }
    } finally {
      now.mockRestore();
    }
  });

  it('requires the exact derived lowercase source and version', () => {
    for (const sourceRequestId of [
      row().sourceRequestId.toUpperCase(),
      '00000000-0000-5000-8000-000000000000',
    ]) {
      expect(
        normalizeRestockInboundEvidence({ ...row(), sourceRequestId }),
      ).toBeNull();
    }
    for (const version of [0, 2, '1', undefined]) {
      expect(normalizeRestockInboundEvidence({ ...row(), version })).toBeNull();
    }
    const swapped = {
      ...row(),
      senderId: event.messageId,
      messageId: event.senderId,
    };
    expect(normalizeRestockInboundEvidence(swapped)).toBeNull();
    expect(
      normalizeRestockInboundEvidence(
        Object.fromEntries(Object.entries(row()).reverse()),
      ),
    ).toEqual(row());
  });

  it('holds malformed shapes without executing accessors or escaping throws', () => {
    const getter = jest.fn(() => 'not read');
    const hostile = (base: object) => [
      null,
      [],
      'row',
      { ...base, extra: true },
      Object.create(base) as unknown,
      { ...base, [Symbol('extra')]: true },
      Object.defineProperty({ ...base }, Object.keys(base)[0], { get: getter }),
      new Proxy(base, {
        ownKeys() {
          throw new Error('trap');
        },
      }),
      new Proxy(base, {
        get() {
          return 'divergent';
        },
      }),
      Object.fromEntries(Object.entries(base).slice(1)),
    ];
    for (const value of hostile(row())) {
      expect(normalizeRestockInboundEvidence(value)).toBeNull();
    }
    for (const value of hostile(input())) {
      expect(bindRestockInboundEvidence(value, phone)).toBeNull();
    }
    for (const value of hostile(event)) {
      expect(
        bindRestockInboundEvidence({ ...input(), event: value }, phone),
      ).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
