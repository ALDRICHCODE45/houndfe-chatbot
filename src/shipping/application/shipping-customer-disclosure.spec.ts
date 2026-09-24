/** SCA-3a: pure pre-send disclosure preparation contract tests (no I/O). */
import type { ConversationStateData } from '../../conversation/domain/conversation-store';
import { renderShippingCustomerAmounts } from './shipping-customer-decision';
import { prepareShippingCustomerDisclosure as prepare } from './shipping-customer-disclosure';

const DRAFT = 'shippingQuoteDraft';
const CONTEXT = 'shippingQuoteDraftContext';
const APPROVAL = 'shippingApproval';
const PIN = '2026-06-23T12:00:00.000Z';
const EXPIRES = '2026-06-23T12:30:00.000Z';
const NOW_ISO = '2026-06-23T12:10:00.000Z';
const NOW = Date.parse(NOW_ISO);
const REQUEST = 'abcdef123456';
const INT32 = 2_147_483_647;
const MERCH = 60_000;
const CHARGE = 6_900;
const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';
type Over = Record<string, unknown>;

const line = (productId: string, unitPriceCents: number, quantity = 1) => ({
  productId,
  variantId: null,
  quantity,
  unitPriceCents,
});
// bestRate = charge + 12_000, credit = 12_000, qualifyingUnitCount = 1.
const draft = (charge = CHARGE, createdAt = PIN, expiresAt = EXPIRES) => ({
  schemaVersion: 1,
  draft: {
    quoteId: 'quote-1',
    selectedRate: {
      rateId: 'rate-1',
      carrierName: 'Skydropx',
      serviceName: 'Express',
      priceCents: charge + 12_000,
      currency: 'MXN',
      estimatedDeliveryDays: 3,
      validUntil: null,
    },
    providerExpiresAt: null,
    bestRateCents: charge + 12_000,
    totalCreditCents: 12_000,
    appliedCreditCents: 12_000,
    unusedCreditCents: 0,
    qualifyingUnitCount: 1,
    customerPaysCents: charge,
  },
  createdAt,
  expiresAt,
});
const context = (createdAt = PIN, lines: unknown = [line(PRODUCT, MERCH)]) => ({
  schemaVersion: 1,
  draftCreatedAt: createdAt,
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  cart: lines,
  destination: {
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
});
const approval = (over: Over = {}) => ({
  requestId: REQUEST,
  draftCreatedAt: PIN,
  decision: 'SHIPPING_APPROVED',
  decidedAt: '2026-06-23T12:05:00.000Z',
  ...over,
});
const cart = (items: unknown = [line(PRODUCT, MERCH)], expected = MERCH) => ({
  items,
  idempotencyKey: 'key-1',
  expectedTotalCents: expected,
});
const base = (over: Over = {}): ConversationStateData => ({
  [DRAFT]: draft(),
  [CONTEXT]: context(),
  [APPROVAL]: approval(),
  cart: cart(),
  ...over,
});
const withDraft = (over: Over = {}) =>
  base({ [DRAFT]: { ...draft(), ...over } });
const withContext = (over: Over = {}) =>
  base({ [CONTEXT]: { ...context(), ...over } });
const withApproval = (over: Over = {}) => base({ [APPROVAL]: approval(over) });
const withCart = (over: Over = {}) => base({ cart: { ...cart(), ...over } });
const call = (data: ConversationStateData | null, nowMs = NOW) =>
  prepare(data, nowMs);

describe('prepareShippingCustomerDisclosure', () => {
  it('prepares the exact approved offer fields and text without a provider id', () => {
    const { offer, text } = call(base())!;
    expect(offer).toEqual({
      schemaVersion: 1,
      requestId: REQUEST,
      draftCreatedAt: PIN,
      offeredAt: NOW_ISO,
      expiresAt: EXPIRES,
      merchandiseCents: MERCH,
      chargeCents: CHARGE,
      expectedTotalCents: MERCH + CHARGE,
    });
    expect(Object.hasOwn(offer, 'providerMessageId')).toBe(false);
    expect(text).toBe(
      [
        'Detalle de tu envío (producto medido):',
        'Mercancía: $600.00 MXN',
        'Envío: $69.00 MXN',
        'Total: $669.00 MXN',
        '',
        'Verificaremos el precio antes de registrar tu pedido. Si cambia, te mostraremos el nuevo total para que lo confirmes otra vez.',
        '',
        'Responde exactamente "SÍ" para aceptar o "NO" para rechazar.',
      ].join('\n'),
    );
    expect(text.toLowerCase()).not.toContain('pending');
  });

  it('renders zero merchandise and the signed int32 upper bound', () => {
    const zero = call(
      base({
        [CONTEXT]: context(PIN, [line(PRODUCT, 0)]),
        cart: cart([line(PRODUCT, 0)], 0),
      }),
    )!;
    expect(zero.offer.merchandiseCents).toBe(0);
    expect(zero.offer.expectedTotalCents).toBe(CHARGE);
    expect(zero.text).toContain('Mercancía: $0.00 MXN');
    const top = call(
      base({
        [DRAFT]: draft(1),
        [CONTEXT]: context(PIN, [line(PRODUCT, INT32 - 1)]),
        cart: cart([line(PRODUCT, INT32 - 1)], INT32 - 1),
      }),
    )!;
    expect(top.offer.expectedTotalCents).toBe(INT32);
    expect(top.text).toContain('Total: $21,474,836.47 MXN');
  });

  it('allows an approval decided exactly now', () => {
    const prepared = call(
      base({ [APPROVAL]: approval({ decidedAt: NOW_ISO }) }),
    )!;
    expect(prepared.offer.offeredAt).toBe(NOW_ISO);
  });

  it('fails closed on malformed, stale or future state', () => {
    const bad: ConversationStateData[] = [
      withDraft({ expiresAt: '2026-06-23T11:30:00.000Z' }),
      withDraft({ createdAt: '2026-06-23T12:20:00.000Z' }),
      base({ [CONTEXT]: null }),
      base({ [APPROVAL]: null }),
      withApproval({ decision: 'SHIPPING_REJECTED' }),
      withApproval({ draftCreatedAt: EXPIRES }),
      withContext({ draftCreatedAt: EXPIRES }),
      withApproval({ decidedAt: '2026-06-23T12:20:00.000Z' }),
      base({ pendingHumanRequest: { requestId: REQUEST } }),
      withCart({ items: [line(PRODUCT, MERCH, 2)] }),
      withCart({ items: [line(PRODUCT, 59_000)] }),
      base({ [DRAFT]: draft(0) }),
      base({ [DRAFT]: draft(INT32 + 1) }),
      base({ cart: cart([line(PRODUCT, MERCH)], -1) }),
      base({ cart: cart([line(PRODUCT, MERCH)], 60_000.5) }),
      base({ cart: { items: [line(PRODUCT, MERCH)], idempotencyKey: 'k' } }),
      base({ cart: cart([line(PRODUCT, MERCH)], INT32) }),
      base({ [CONTEXT]: { schemaVersion: 1 } }),
      withApproval({ requestId: 'nope' }),
    ];
    for (const snapshot of bad) expect(call(snapshot)).toBeNull();
  });

  it('never throws and fails closed on hostile or clock-trapped input', () => {
    const throwing = new Proxy<ConversationStateData>(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    for (const raw of [null, [], {}, throwing]) {
      const snapshot = raw as ConversationStateData | null;
      expect(() => call(snapshot)).not.toThrow();
      expect(call(snapshot)).toBeNull();
    }
    for (const clock of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'x']) {
      expect(call(base(), clock as number)).toBeNull();
    }
  });

  it('fails closed in the factored amount renderer', () => {
    expect(renderShippingCustomerAmounts(-1, 100, 99)).toBeNull();
    expect(renderShippingCustomerAmounts(0, 100, 101)).toBeNull();
    expect(renderShippingCustomerAmounts(INT32, 1, INT32 + 1)).toBeNull();
  });
});
