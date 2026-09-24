/**
 * SCA-4a: focused contract tests for the pure inbound customer-response
 * classifier and decline replay tombstone. No store, router, provider, model,
 * gate, backend or environment access.
 */
import {
  classifyShippingCustomerResponse as classify,
  matchShippingCustomerDeclineReceipt as matchReceipt,
  normalizeShippingCustomerDeclineReceipt as normalizeReceipt,
  SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY as DECLINE_KEY,
} from './shipping-customer-response';

const REQ = 'abcdef123456',
  DRAFT = '2026-06-23T12:00:00.000Z',
  OFFERED = '2026-06-23T12:00:05.000Z',
  EXPIRES = '2026-06-23T12:30:05.000Z',
  IN_AFTER = '2026-06-23T12:05:00.000Z',
  IN_ID = 'wamid.HBgLinbound=',
  NOW = Date.parse(IN_AFTER);

const offerOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  offeredAt: OFFERED,
  expiresAt: EXPIRES,
  merchandiseCents: 100_000,
  chargeCents: 12_900,
  expectedTotalCents: 112_900,
  providerMessageId: 'wamid.HBgLoutbound=',
  ...overrides,
});

const receiptOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  inboundMessageId: IN_ID,
  declinedAt: IN_AFTER,
  ...overrides,
});

/** Same exact key set, but one field becomes a throwing accessor. */
const withGetter = (base: Record<string, unknown>, key: string) => {
  const target: Record<string, unknown> = { ...base };
  delete target[key];
  Object.defineProperty(target, key, {
    enumerable: true,
    get: () => {
      throw new Error('hostile getter');
    },
  });
  return target;
};

const throwingTrap = () =>
  new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error('trap');
      },
    },
  );

describe('normalizeShippingCustomerDeclineReceipt', () => {
  it('exposes the exact replay key and returns a fresh frozen exact-key copy', () => {
    expect(DECLINE_KEY).toBe('shippingCustomerDeclineReceipt');
    const raw = receiptOf();
    const receipt = normalizeReceipt(raw)!;
    expect(receipt).not.toBe(raw);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt).sort().join()).toBe(
      'declinedAt,draftCreatedAt,inboundMessageId,requestId,schemaVersion',
    );
    expect([
      receipt.schemaVersion,
      receipt.requestId,
      receipt.inboundMessageId,
    ]).toEqual([1, REQ, IN_ID]);
  });

  it.each<[string, unknown]>([
    ['a non-object', null],
    ['a wrong schemaVersion', receiptOf({ schemaVersion: 2 })],
    [
      'a missing key',
      {
        schemaVersion: 1,
        requestId: REQ,
        draftCreatedAt: DRAFT,
        inboundMessageId: IN_ID,
      },
    ],
    ['an excess key', receiptOf({ decision: 'accept' })],
    ['an accessor field', withGetter(receiptOf(), 'declinedAt')],
    ['a throwing trap', throwingTrap()],
  ])('fails closed on %s', (_label, raw) => {
    expect(normalizeReceipt(raw)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an invalid requestId', { requestId: 'ABCDEF123456' }],
    [
      'a noncanonical draftCreatedAt',
      { draftCreatedAt: '2026-06-23T12:00:00Z' },
    ],
    ['a noncanonical declinedAt', { declinedAt: '2026-06-23T12:05:00Z' }],
    ['an oversized inboundMessageId', { inboundMessageId: 'x'.repeat(129) }],
    [
      'a declinedAt before the draft pin',
      { declinedAt: '2026-06-23T11:59:59.000Z' },
    ],
  ])('rejects a receipt with %s', (_label, patch) => {
    expect(normalizeReceipt(receiptOf(patch))).toBeNull();
  });

  it('matches only the exact replay inbound id and fails closed otherwise', () => {
    expect(matchReceipt(receiptOf(), IN_ID)).toBe(true);
    expect(matchReceipt(receiptOf(), 'wamid.HBgLother=')).toBe(false);
    expect(matchReceipt(receiptOf(), 123)).toBe(false);
    for (const raw of [
      null,
      receiptOf({ declinedAt: 'x' }),
      withGetter(receiptOf(), 'inboundMessageId'),
      throwingTrap(),
    ]) {
      expect(matchReceipt(raw, IN_ID)).toBe(false);
    }
  });
});

describe('classifyShippingCustomerResponse', () => {
  it('accepts a whole YES strictly after the offer at a frozen output', () => {
    const result = classify(offerOf(), 'SÍ', IN_AFTER, NOW);
    expect(result).toEqual({ decision: 'accept', decidedAt: IN_AFTER });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result!).sort().join()).toBe('decidedAt,decision');
  });

  it('declines a whole NO', () => {
    expect(classify(offerOf(), 'no.', IN_AFTER, NOW)).toEqual({
      decision: 'decline',
      decidedAt: IN_AFTER,
    });
  });

  it('rejects a delayed old YES sent at or before the offer', () => {
    expect(classify(offerOf(), 'SÍ', OFFERED, NOW)).toBeNull();
    expect(classify(offerOf(), 'SÍ', DRAFT, NOW)).toBeNull();
  });

  it('requires strictly more than one millisecond after offeredAt', () => {
    expect(classify(offerOf(), 'SI', OFFERED, NOW)).toBeNull();
    expect(classify(offerOf(), 'SI', '2026-06-23T12:00:05.001Z', NOW)).toEqual({
      decision: 'accept',
      decidedAt: '2026-06-23T12:00:05.001Z',
    });
  });

  it('rejects an inbound timestamp after the processing clock', () => {
    const future = new Date(NOW + 1).toISOString();
    expect(classify(offerOf(), 'SI', future, NOW)).toBeNull();
    expect(classify(offerOf(), 'NO', future, NOW)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['an offset ISO', '2026-06-23T12:05:00.000+00:00'],
    ['a seconds-only ISO', '2026-06-23T12:05:00Z'],
    ['garbage', 'not-a-time'],
  ])('rejects a noncanonical inbound timestamp: %s', (_label, inbound) => {
    expect(classify(offerOf(), 'SI', inbound, NOW)).toBeNull();
  });

  it('rejects YES at expiry and once the clock reached expiry', () => {
    expect(classify(offerOf(), 'SI', EXPIRES, NOW)).toBeNull();
    expect(classify(offerOf(), 'SI', IN_AFTER, Date.parse(EXPIRES))).toBeNull();
    expect(
      classify(offerOf(), 'SI', IN_AFTER, Date.parse(EXPIRES) + 1),
    ).toBeNull();
  });

  it('allows a late NO after expiry to cancel the offer', () => {
    const late = new Date(Date.parse(EXPIRES) + 60_000).toISOString();
    expect(classify(offerOf(), 'NO', late, Date.parse(late) + 1)).toEqual({
      decision: 'decline',
      decidedAt: late,
    });
  });

  it.each(['', 'S', 'SÍSÍ', 'SI por favor', 'yes', 'NO 100'])(
    'rejects nonsense or inferred text: %j',
    (text) => {
      expect(classify(offerOf(), text, IN_AFTER, NOW)).toBeNull();
    },
  );

  it.each<[string, unknown]>([
    ['a null offer', null],
    ['a total mismatch', offerOf({ expectedTotalCents: 112_901 })],
    [
      'a noncanonical offeredAt',
      offerOf({ offeredAt: '2026-06-23T12:00:05Z' }),
    ],
    ['an excess key', offerOf({ token: 'svc_secret' })],
    ['a hostile getter', withGetter(offerOf(), 'expiresAt')],
    ['a throwing trap', throwingTrap()],
  ])('fails closed on a %s', (_label, offer) => {
    expect(classify(offer, 'SI', IN_AFTER, NOW)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['negative', -1],
  ])('rejects a hostile clock: %s', (_label, clock) => {
    expect(classify(offerOf(), 'SI', IN_AFTER, clock)).toBeNull();
  });
});
