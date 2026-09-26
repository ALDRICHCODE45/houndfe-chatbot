import {
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY as ACCEPT_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY as OFFER_KEY,
  matchShippingCustomerAcceptance as match,
  normalizeShippingCustomerAcceptance as normalizeAcceptance,
  normalizeShippingCustomerOffer as normalizeOffer,
} from './shipping-customer-acceptance';

const REQ = 'abcdef123456',
  OTHER_REQ = 'fedcba654321',
  DRAFT = '2026-06-23T12:00:00.000Z',
  OFFERED = '2026-06-23T12:00:05.000Z',
  EXPIRES = '2026-06-23T12:30:05.000Z',
  ACCEPTED = '2026-06-23T12:05:00.000Z',
  OUT_ID = 'wamid.HBgLoutbound=',
  IN_ID = 'wamid.HBgLinbound=',
  MERCH = 100_000,
  CHARGE = 12_900,
  TOTAL = 112_900;

const offerOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  offeredAt: OFFERED,
  expiresAt: EXPIRES,
  merchandiseCents: MERCH,
  chargeCents: CHARGE,
  expectedTotalCents: TOTAL,
  providerMessageId: OUT_ID,
  ...overrides,
});

const acceptOf = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: REQ,
  draftCreatedAt: DRAFT,
  merchandiseCents: MERCH,
  chargeCents: CHARGE,
  expectedTotalCents: TOTAL,
  acceptedAt: ACCEPTED,
  inboundMessageId: IN_ID,
  ...overrides,
});

const omit = (source: Record<string, unknown>, key: string) => {
  const rest: Record<string, unknown> = {};
  for (const entry of Object.keys(source)) {
    if (entry !== key) rest[entry] = source[entry];
  }
  return rest;
};

describe('shipping customer acceptance markers', () => {
  it('exposes the exact marker keys', () => {
    expect([OFFER_KEY, ACCEPT_KEY]).toEqual([
      'shippingCustomerOffer',
      'shippingCustomerAcceptance',
    ]);
  });
});

describe('normalizeShippingCustomerOffer', () => {
  it('returns a fresh detached frozen exact-key copy', () => {
    const raw = offerOf();
    const offer = normalizeOffer(raw)!;
    expect(offer).not.toBe(raw);
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.keys(offer).sort().join()).toBe(
      'chargeCents,draftCreatedAt,expectedTotalCents,expiresAt,merchandiseCents,offeredAt,providerMessageId,requestId,schemaVersion',
    );
    expect([offer.schemaVersion, offer.providerMessageId]).toEqual([1, OUT_ID]);
  });

  it.each<[string, unknown]>([
    ['a non-object', null],
    ['a wrong schemaVersion', offerOf({ schemaVersion: 2 })],
    ['a missing key', omit(offerOf(), 'chargeCents')],
    ['an excess key', offerOf({ token: 'svc_secret' })],
  ])('fails closed on %s', (_label, raw) => {
    expect(normalizeOffer(raw)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an invalid requestId', { requestId: 'ABCDEF123456' }],
    ['a non-canonical offeredAt', { offeredAt: '2026-06-23T12:00:05Z' }],
    ['expiresAt at offeredAt', { expiresAt: OFFERED }],
    ['a negative merchandiseCents', { merchandiseCents: -1 }],
    ['an empty providerMessageId', { providerMessageId: '' }],
  ])('rejects an offer with %s', (_label, patch) => {
    expect(normalizeOffer(offerOf(patch))).toBeNull();
  });
});

describe('normalizeShippingCustomerAcceptance', () => {
  it('returns a fresh detached frozen exact-key copy', () => {
    const raw = acceptOf();
    const acceptance = normalizeAcceptance(raw)!;
    expect(acceptance).not.toBe(raw);
    expect(Object.isFrozen(acceptance)).toBe(true);
    expect(Object.keys(acceptance).sort().join()).toBe(
      'acceptedAt,chargeCents,draftCreatedAt,expectedTotalCents,inboundMessageId,merchandiseCents,requestId,schemaVersion',
    );
    expect([acceptance.schemaVersion, acceptance.requestId]).toEqual([1, REQ]);
  });

  it.each<[string, unknown]>([
    ['a non-object', null],
    ['a wrong schemaVersion', acceptOf({ schemaVersion: 2 })],
    ['a missing key', omit(acceptOf(), 'acceptedAt')],
    ['an excess key', acceptOf({ decision: 'SHIPPING_APPROVED' })],
  ])('fails closed on %s', (_label, raw) => {
    expect(normalizeAcceptance(raw)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ['an invalid requestId', { requestId: 'zzzzzzzzzzzz' }],
    ['a non-canonical acceptedAt', { acceptedAt: '2026-06-23T12:05:00Z' }],
    [
      'acceptedAt before draftCreatedAt',
      { acceptedAt: '2026-06-23T11:59:00.000Z' },
    ],
    ['a total mismatch', { merchandiseCents: MERCH + 1 }],
    ['an empty inboundMessageId', { inboundMessageId: '' }],
  ])('rejects an acceptance with %s', (_label, patch) => {
    expect(normalizeAcceptance(acceptOf(patch))).toBeNull();
  });
});

describe('matchShippingCustomerAcceptance', () => {
  it('matches a valid acceptance to its offer', () => {
    expect(match(offerOf(), acceptOf())).toBe(true);
  });

  it('allows the inclusive offeredAt and exclusive expiresAt boundaries', () => {
    expect(match(offerOf(), acceptOf({ acceptedAt: OFFERED }))).toBe(true);
    expect(match(offerOf(), acceptOf({ acceptedAt: EXPIRES }))).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ['requestId', { requestId: OTHER_REQ }],
    ['merchandiseCents', { merchandiseCents: MERCH + 1 }],
    ['acceptedAt before offeredAt', { acceptedAt: DRAFT }],
  ])('rejects drift on %s', (_label, patch) => {
    expect(match(offerOf(), acceptOf(patch))).toBe(false);
  });

  it.each<[unknown, unknown]>([
    [null, acceptOf()],
    [offerOf(), { ...acceptOf(), extra: 1 }],
  ])('fails closed on invalid input', (offer, acceptance) => {
    expect(match(offer, acceptance)).toBe(false);
  });
});
