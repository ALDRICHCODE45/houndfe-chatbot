import { normalizeCustomerInboundObservation } from './customer-inbound-observation';

const valid = () => ({
  senderId: '5215512345678',
  receivingPhoneNumberId: '123456789',
  messageId: 'wamid.ABCdef-é',
  providerTimestampSeconds: '1700000000',
  observedAt: '2023-11-14T22:13:20.000Z',
});
const normalize = (over: Record<string, unknown> = {}) =>
  normalizeCustomerInboundObservation({ ...valid(), ...over });

describe('inert customer inbound observation normalization', () => {
  it('returns a detached frozen exact-five-string snapshot', () => {
    const input = valid();
    const result = normalizeCustomerInboundObservation(input)!;
    expect(result).toEqual(input);
    expect(Object.keys(result).sort()).toEqual(Object.keys(input).sort());
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toBe(input);
    input.senderId = 'changed';
    input.observedAt = '2024-01-01T00:00:00.000Z';
    expect(result).toEqual(valid());
  });

  it('holds malformed shapes without executing getters or proxy traps', () => {
    const getter = jest.fn(() => 'not read');
    const trap = jest.fn(() => {
      throw new Error('trap');
    });
    const base = valid();
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      'row',
      [],
      { ...base, extra: true },
      { ...base, [Symbol('extra')]: true },
      Object.create(base),
      Object.defineProperty({ ...base }, 'senderId', { get: getter }),
      Object.fromEntries(Object.entries(base).slice(0, 4)),
      new Proxy(base, { ownKeys: trap, get: trap, getPrototypeOf: trap }),
    ];
    for (const value of hostile)
      expect(normalizeCustomerInboundObservation(value)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it.each(['', 'not-digits', '+123', ' 12', '12 ', '1'.repeat(25), '١٢٣'])(
    'holds malformed receiving phone %j',
    (receivingPhoneNumberId) => {
      expect(normalize({ receivingPhoneNumberId })).toBeNull();
    },
  );

  it('accepts phone digit boundaries', () => {
    expect(normalize({ receivingPhoneNumberId: '0' })).not.toBeNull();
    expect(
      normalize({ receivingPhoneNumberId: '1'.repeat(24) }),
    ).not.toBeNull();
  });

  it.each([
    ['senderId', ''],
    ['senderId', ' '],
    ['senderId', ' padded'],
    ['senderId', 'trailing '],
    ['senderId', 'a\nb'],
    ['senderId', 'a\u0000b'],
    ['senderId', 'a\u001fb'],
    ['senderId', 'a\u007fb'],
    ['senderId', 'a\u0080b'],
    ['senderId', 'a\u009fb'],
    ['senderId', 'x'.repeat(201)],
    ['messageId', ''],
    ['messageId', ' padded'],
    ['messageId', 'a\u0000b'],
    ['messageId', 'x'.repeat(513)],
  ])('holds unusable opaque identity %s=%j', (field, value) => {
    expect(normalize({ [field]: value })).toBeNull();
  });

  it('accepts sender/message length boundaries and preserves original bytes', () => {
    const senderId = 'é'.repeat(200);
    const messageId = `wamid.${'x'.repeat(506)}`;
    const result = normalize({ senderId, messageId })!;
    expect(result.senderId).toBe(senderId);
    expect(result.messageId).toBe(messageId);
  });

  it.each([
    '0',
    '00',
    '01',
    '1.0',
    '-1',
    '+1',
    ' 1',
    '1 ',
    '1e3',
    'NaN',
    'Infinity',
    '9007199254740992',
    '8640000000001',
    1700000000,
    null,
    undefined,
  ])('holds invalid provider seconds %j', (providerTimestampSeconds) => {
    expect(normalize({ providerTimestampSeconds })).toBeNull();
  });

  it('accepts canonical positive seconds at both finite-date bounds', () => {
    expect(normalize({ providerTimestampSeconds: '1' })).not.toBeNull();
    expect(
      normalize({
        providerTimestampSeconds: '8640000000000',
        observedAt: '+275760-09-13T00:00:00.000Z',
      }),
    ).not.toBeNull();
  });

  it.each([
    '',
    'invalid',
    '2023-11-14T22:13:20Z',
    '2023-11-14T22:13:20.000+00:00',
    '2023-11-14t22:13:20.000z',
    '2023-02-30T00:00:00.000Z',
    '2023-11-14T22:13:20.00Z',
    1700000000000,
    null,
  ])('holds noncanonical or malformed observedAt %j', (observedAt) => {
    expect(normalize({ observedAt })).toBeNull();
  });

  it('holds provider time after observation and allows equality or later observation', () => {
    expect(normalize({ providerTimestampSeconds: '1700000001' })).toBeNull();
    expect(normalize()).not.toBeNull();
    expect(
      normalize({ observedAt: '2023-11-14T22:13:21.000Z' }),
    ).not.toBeNull();
  });

  it('rejects every extra request or product metadata key', () => {
    for (const extra of [
      { sourceRequestId: 'x' },
      { version: 1 },
      { productId: 'x' },
      { requestId: 'x' },
      { now: '2023-11-14T22:13:20.000Z' },
    ])
      expect(normalize(extra)).toBeNull();
    expect(normalizeCustomerInboundObservation(valid())).not.toHaveProperty(
      'sourceRequestId',
    );
  });

  it('never consults an ambient clock', () => {
    const now = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('no ambient clock');
    });
    try {
      expect(normalizeCustomerInboundObservation(valid())).not.toBeNull();
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});
