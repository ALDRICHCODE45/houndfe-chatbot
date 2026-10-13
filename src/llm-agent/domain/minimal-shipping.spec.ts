import {
  buildMinimalShipping,
  classifyMinimalShipping,
  isShippingCurrent,
  minimalShippingSchema,
  transitionShippingApproval,
  requestMinimalShippingApproval,
} from './minimal-shipping';
import type { ShippingQuoteQuotedResult } from '../../shipping/domain/shipping-quote.result';

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '22222222-2222-4222-8222-222222222222';
const CREATED = '2026-06-22T12:00:00.000Z';
const NOW = Date.parse(CREATED);
const lines = [
  {
    productId: PRODUCT,
    quantity: 2,
    unitPriceCents: 50001,
    finalPriceCents: 100002,
  },
];
const quote: ShippingQuoteQuotedResult = {
  kind: 'quoted',
  quoteId: 'quote-1',
  expiresAt: null,
  rates: [
    {
      rateId: 'expensive',
      carrierName: 'Carrier A',
      serviceName: 'Express',
      priceCents: 40000,
      currency: 'MXN',
      estimatedDeliveryDays: 1,
      validUntil: null,
    },
    {
      rateId: 'best',
      carrierName: 'Carrier B',
      serviceName: 'Ground',
      priceCents: 20000,
      currency: 'MXN',
      estimatedDeliveryDays: 3,
      validUntil: null,
    },
  ],
};
const input = () => ({
  quote,
  cartLines: structuredClone(lines),
  addressId: ADDRESS,
  addressVersion: CREATED,
  createdAt: CREATED,
});
function record() {
  const result = buildMinimalShipping(input());
  if (!result) throw new Error('valid fixture rejected');
  return result;
}
const context = () => ({
  cartLines: structuredClone(lines),
  addressId: ADDRESS,
  addressVersion: CREATED,
  nowMs: NOW,
});

describe('Minimal shipping (T2)', () => {
  // prettier-ignore
  it('[S1,S6] requests pending explicitly; cannot skip pending or restart approval', () => {
    const fresh = record();
    expect(transitionShippingApproval(fresh, { state: 'approved', requestId: 'r', nowMs: NOW })).toBeNull();
    expect(transitionShippingApproval(fresh, { state: 'expired', requestId: 'r', nowMs: NOW })).toBeNull();
    const pending = requestMinimalShippingApproval(fresh, { requestId: 'r', nowMs: NOW })!;
    expect(pending.approval).toEqual({ state: 'pending', requestId: 'r' });
    expect(requestMinimalShippingApproval(pending, { requestId: 'other', nowMs: NOW })).toBeNull();
    for (const state of ['approved', 'rejected', 'expired'] as const) {
      const terminal = transitionShippingApproval(pending, { state, requestId: 'r', nowMs: NOW })!;
      expect(requestMinimalShippingApproval(terminal, { requestId: 'r', nowMs: NOW })).toBeNull();
    }
    expect(requestMinimalShippingApproval(fresh, { requestId: '', nowMs: NOW })).toBeNull();
    expect(requestMinimalShippingApproval(fresh, { requestId: 'r', nowMs: NaN })).toBeNull();
    expect(requestMinimalShippingApproval(fresh, { requestId: 'r', nowMs: NOW - 1 })).toBeNull();
    expect(requestMinimalShippingApproval(fresh, { requestId: 'r', nowMs: NOW + 1800000 })?.approval).toEqual({ state: 'expired' });
    expect(transitionShippingApproval(fresh, { state: 'expired', requestId: '', nowMs: NOW + 1800000 })?.approval).toEqual({ state: 'expired' });
  });
  it('[S1,S2] selects the cheapest provider rate, calculates summed credit, and starts not_requested even when free', () => {
    expect(record()).toMatchObject({
      quoteId: 'quote-1',
      rateId: 'best',
      carrierName: 'Carrier B',
      serviceName: 'Ground',
      estimatedDeliveryDays: 3,
      bestRateCents: 20000,
      totalCreditCents: 24000,
      customerPaysCents: 0,
      approval: { state: 'not_requested' },
    });
    expect(classifyMinimalShipping(record())).toBe('free');
    const charged = buildMinimalShipping({
      ...input(),
      cartLines: [{ ...lines[0], unitPriceCents: 50000 }],
    });
    expect(charged).toMatchObject({
      totalCreditCents: 0,
      customerPaysCents: 20000,
    });
    if (!charged) throw new Error('charged fixture rejected');
    expect(classifyMinimalShipping(charged)).toBe('charged');
  });
  it('[S4] detaches cart lines from inputs', () => {
    const original = input();
    const built = buildMinimalShipping(original)!;
    original.cartLines[0].quantity = 9;
    expect(built.cartLines).toEqual(lines);
  });
  it.each([null, '2026-06-22T12:10:00.000Z', '2026-06-22T13:00:00.000Z'])(
    '[S6] caps expiry at 30 minutes or provider expiry (%s)',
    (expiresAt) => {
      const built = buildMinimalShipping({
        ...input(),
        quote: { ...quote, expiresAt },
      })!;
      expect(built.expiresAt).toBe(
        expiresAt === '2026-06-22T12:10:00.000Z'
          ? expiresAt
          : '2026-06-22T12:30:00.000Z',
      );
      expect(
        isShippingCurrent(built, {
          ...context(),
          nowMs: Date.parse(built.expiresAt) - 1,
        }),
      ).toBe('current');
      expect(
        isShippingCurrent(built, {
          ...context(),
          nowMs: Date.parse(built.expiresAt),
        }),
      ).toBe('expired');
    },
  );
  it('[S6] also respects selected rate validity and rejects already expired quotes', () => {
    const rates: ShippingQuoteQuotedResult['rates'] = [
      quote.rates[0],
      { ...quote.rates[1], validUntil: '2026-06-22T12:05:00.000Z' },
    ];
    expect(
      buildMinimalShipping({ ...input(), quote: { ...quote, rates } })
        ?.expiresAt,
    ).toBe('2026-06-22T12:05:00.000Z');
    expect(
      buildMinimalShipping({
        ...input(),
        quote: { ...quote, expiresAt: CREATED },
      }),
    ).toBeNull();
  });
  it.each([
    'quantity',
    'unitPriceCents',
    'finalPriceCents',
    'productId',
    'variantId',
    'addressId',
    'addressVersion',
  ] as const)('[S4] detects stale %s', (field) => {
    const fresh = context();
    const changed =
      field === 'addressId' || field === 'addressVersion'
        ? { ...fresh, [field]: 'changed' }
        : {
            ...fresh,
            cartLines: [
              { ...lines[0], [field]: field.endsWith('Id') ? ADDRESS : 42 },
            ],
          };
    expect(isShippingCurrent(record(), changed)).toBe('stale');
  });
  it('[S4] treats line order as irrelevant but rejects extra or duplicate lines', () => {
    const second = { ...lines[0], productId: ADDRESS };
    const built = buildMinimalShipping({
      ...input(),
      cartLines: [...lines, second],
    })!;
    expect(
      isShippingCurrent(built, { ...context(), cartLines: [second, ...lines] }),
    ).toBe('current');
    expect(
      isShippingCurrent(record(), {
        ...context(),
        cartLines: [...lines, ...lines],
      }),
    ).toBe('stale');
  });
  it.each(['approved', 'rejected', 'expired'] as const)(
    '[S1,S6] permits only pending → %s with exact request binding; terminal states never revive',
    (state) => {
      const pending = minimalShippingSchema.parse({
        ...record(),
        approval: { state: 'pending', requestId: 'request-1' },
      });
      const decision = { state, requestId: 'request-1', nowMs: NOW + 1000 };
      const next = transitionShippingApproval(pending, decision)!;
      expect(next.approval).toEqual(
        state === 'expired'
          ? { state: 'expired' }
          : {
              state,
              requestId: 'request-1',
              decidedAt: '2026-06-22T12:00:01.000Z',
            },
      );
      expect(pending.approval.state).toBe('pending');
      expect(
        transitionShippingApproval(next, { ...decision, state: 'approved' }),
      ).toBeNull();
      expect(
        transitionShippingApproval(pending, {
          ...decision,
          requestId: 'other',
        }),
      ).toBeNull();
    },
  );
  it('[S1,S6] late decisions expire rather than approve or reject', () => {
    expect(
      transitionShippingApproval(
        minimalShippingSchema.parse({
          ...record(),
          approval: { state: 'pending', requestId: 'request-1' },
        }),
        {
          state: 'approved',
          requestId: 'request-1',
          nowMs: NOW + 1800000,
        },
      )?.approval,
    ).toEqual({ state: 'expired' });
    expect(
      transitionShippingApproval(record(), {
        state: 'approved',
        requestId: 'request-1',
        nowMs: NOW - 1,
      }),
    ).toBeNull();
  });
  it.each([
    { extra: true },
    { customerPaysCents: -1 },
    { totalCreditCents: 1 },
    { createdAt: 'yesterday' },
    { expiresAt: '2026-06-22T13:00:00.000Z' },
    { addressVersion: 'bad' },
    { quoteId: ' quote-1 ' },
    { cartLines: [{ ...lines[0], extra: true }] },
    { createdAt: '2026-02-30T12:00:00.000Z' },
    {
      approval: {
        state: 'approved',
        requestId: 'r',
        decidedAt: '2026-06-22T12:30:00.000Z',
      },
    },
    { approval: { state: 'approved', requestId: 'r' } },
    { approval: { state: 'expired', requestId: 'r' } },
    { cartLines: [] },
    { cartLines: [...lines, ...lines] },
  ])(
    '[S1,S4,S6] rejects malformed or inconsistent persisted records (%j)',
    (patch) => {
      expect(
        minimalShippingSchema.safeParse({ ...record(), ...patch }).success,
      ).toBe(false);
    },
  );
  it('[S4,S6] fails closed on invalid clocks and explicit expiry', () => {
    expect(isShippingCurrent(record(), { ...context(), nowMs: NaN })).toBe(
      'stale',
    );
    expect(isShippingCurrent(record(), { ...context(), nowMs: NOW - 1 })).toBe(
      'stale',
    );
    const expired = transitionShippingApproval(record(), {
      state: 'expired',
      requestId: 'request-1',
      nowMs: NOW + 1800000,
    })!;
    expect(isShippingCurrent(expired, context())).toBe('expired');
    expect(
      transitionShippingApproval(record(), {
        state: 'approved',
        requestId: 'request-1',
        nowMs: NaN,
      }),
    ).toBeNull();
  });
  it('[S2,S4] rejects unsafe money, invalid provider result, invalid lines and timestamps', () => {
    expect(
      buildMinimalShipping({
        ...input(),
        cartLines: [{ ...lines[0], quantity: Number.MAX_SAFE_INTEGER }],
      }),
    ).toBeNull();
    expect(
      buildMinimalShipping({ ...input(), quote: { ...quote, quoteId: '' } }),
    ).toBeNull();
    expect(
      buildMinimalShipping({ ...input(), createdAt: 'invalid' }),
    ).toBeNull();
    expect(
      buildMinimalShipping({
        ...input(),
        cartLines: [{ ...lines[0], quantity: 0 }],
      }),
    ).toBeNull();
  });
});
