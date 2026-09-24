import type { ConversationStateData } from '../../conversation/domain/conversation-store';
import {
  shippingAcceptancePair,
  type ShippingAcceptanceOverrides,
} from '../../../test/fixtures/shipping-customer-acceptance-fixture';
import { evaluateShippingSaleRevalidation } from './shipping-sale-revalidation';

// SQ-5E4a fail-closed revalidation of one already-validated plain JSONB snapshot.
const DRAFT_KEY = 'shippingQuoteDraft';
const CONTEXT_KEY = 'shippingQuoteDraftContext';
const APPROVAL_KEY = 'shippingApproval';
const PIN = '2026-06-23T12:00:00.000Z';
const EXPIRES = '2026-06-23T12:30:00.000Z';
const NOW = Date.parse('2026-06-23T12:10:00.000Z');
const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';
const PRODUCT_2 = '55555555-5555-5555-5555-555555555555';
const VARIANT = '44444444-4444-4444-4444-444444444444';
const REQUEST_ID = 'abcdef123456';
type Over = Record<string, unknown>;

const item = (
  productId: string,
  variantId: string | null | undefined,
  quantity: number,
  unitPriceCents: number,
) => ({ productId, variantId, quantity, unitPriceCents });

const destination = () => ({
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
});

const RATE = {
  rateId: 'rate-1',
  carrierName: 'Skydropx',
  serviceName: 'Express',
  priceCents: 18900,
  currency: 'MXN',
  estimatedDeliveryDays: 3,
  validUntil: null,
};

type DraftOver = { createdAt?: string; expiresAt?: string; draft?: Over };
const draft = (over: DraftOver = {}) => ({
  schemaVersion: 1,
  draft: {
    quoteId: 'quote-1',
    selectedRate: { ...RATE },
    providerExpiresAt: null,
    bestRateCents: 18900,
    totalCreditCents: 12000,
    appliedCreditCents: 12000,
    unusedCreditCents: 0,
    qualifyingUnitCount: 1,
    customerPaysCents: 6900,
    ...over.draft,
  },
  createdAt: over.createdAt ?? PIN,
  expiresAt: over.expiresAt ?? EXPIRES,
});

type ContextOver = {
  draftCreatedAt?: string;
  cart?: unknown;
  destination?: unknown;
};
const context = (over: ContextOver = {}) => ({
  schemaVersion: 1,
  draftCreatedAt: over.draftCreatedAt ?? PIN,
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  cart: over.cart ?? [item(PRODUCT, null, 1, 60000)],
  destination: over.destination ?? destination(),
});

const approval = (over: Over = {}) => ({
  requestId: REQUEST_ID,
  draftCreatedAt: PIN,
  decision: 'SHIPPING_APPROVED',
  decidedAt: '2026-06-23T12:05:00.000Z',
  ...over,
});

const baseCart = (over: Over = {}) => ({
  items: [item(PRODUCT, null, 1, 60000)],
  idempotencyKey: 'key-1',
  expectedTotalCents: 60000,
  ...over,
});

const data = (over: Over = {}): ConversationStateData => ({
  [DRAFT_KEY]: draft(),
  [CONTEXT_KEY]: context(),
  [APPROVAL_KEY]: approval(),
  cart: baseCart(),
  ...over,
});

const withDraft = (over: DraftOver = {}) => data({ [DRAFT_KEY]: draft(over) });
const withContext = (over: ContextOver = {}) =>
  data({ [CONTEXT_KEY]: context(over) });
const withApproval = (over: Over = {}) =>
  data({ [APPROVAL_KEY]: approval(over) });
const withCart = (over: Over = {}) => data({ cart: baseCart(over) });
const pinnedTo = (createdAt: string, expiresAt: string) =>
  data({
    [DRAFT_KEY]: draft({ createdAt, expiresAt }),
    [CONTEXT_KEY]: context({ draftCreatedAt: createdAt }),
    [APPROVAL_KEY]: approval({ draftCreatedAt: createdAt }),
  });
const revalidate = (snapshot: ConversationStateData | null, nowMs = NOW) =>
  evaluateShippingSaleRevalidation(snapshot, nowMs);

// SCA-2a: the committed disclosed offer/YES pair a future gate must match.
// Only the legitimate charged happy-path snapshots carry it; blocked cases do
// not, so a missing/stale acceptance stays fail-closed.
const accepted = (
  snapshot: ConversationStateData,
  over: ShippingAcceptanceOverrides = {},
): ConversationStateData => ({ ...snapshot, ...shippingAcceptancePair(over) });

const pendingHandoff = {
  requestId: REQUEST_ID,
  ref: `HF-${REQUEST_ID}`,
  createdAt: PIN,
  customerNotifiedAt: PIN,
};
// A valid record with a caller-chosen charge; best rate is paysCents + 12_000.
const chargeDraft = (paysCents: number): DraftOver => ({
  draft: {
    selectedRate: { ...RATE, priceCents: paysCents + 12000 },
    bestRateCents: paysCents + 12000,
    customerPaysCents: paysCents,
  },
});
const chargedVerdict = (merchandiseTotalCents: number) => ({
  kind: 'charged',
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  destination: destination(),
  approvalId: REQUEST_ID,
  quoteId: 'quote-1',
  chargeCents: 6900,
  merchandiseTotalCents,
  expectedTotalCents: merchandiseTotalCents + 6900,
});

const blockedCases: Array<[string, ConversationStateData]> = [
  ['orphan context', { [CONTEXT_KEY]: context(), cart: baseCart() }],
  ['orphan approval', { [APPROVAL_KEY]: approval(), cart: baseCart() }],
  ['contextless draft', { [DRAFT_KEY]: draft(), cart: baseCart() }],
  ['draft and context with no approval', data({ [APPROVAL_KEY]: null })],
  [
    'expired draft',
    pinnedTo('2026-06-23T11:00:00.000Z', '2026-06-23T11:30:00.000Z'),
  ],
  [
    'not-yet-created draft',
    pinnedTo('2026-06-23T12:20:00.000Z', '2026-06-23T12:50:00.000Z'),
  ],
  ['rejected approval', withApproval({ decision: 'SHIPPING_REJECTED' })],
  ['approval pin mismatch', withApproval({ draftCreatedAt: EXPIRES })],
  ['context pin mismatch', withContext({ draftCreatedAt: EXPIRES })],
  ['cart quantity drift', withCart({ items: [item(PRODUCT, null, 2, 60000)] })],
  ['cart price drift', withCart({ items: [item(PRODUCT, null, 1, 59000)] })],
  [
    'cart product drift',
    withCart({ items: [item(PRODUCT_2, null, 1, 60000)] }),
  ],
  ['empty cart', withCart({ items: [] })],
  ['zero charge', withDraft(chargeDraft(0))],
  ['oversize charge', withDraft(chargeDraft(2_147_483_648))],
  ['missing merchandise total', withCart({ expectedTotalCents: undefined })],
  ['negative merchandise total', withCart({ expectedTotalCents: -1 })],
  ['fractional merchandise total', withCart({ expectedTotalCents: 60000.5 })],
  ['invalid merchandise total', withCart({ expectedTotalCents: 'x' })],
  ['total overflow', withCart({ expectedTotalCents: Number.MAX_SAFE_INTEGER })],
  [
    'total one above int32 max',
    withCart({ expectedTotalCents: 2_147_483_648 - 6_900 }),
  ],
  [
    'safe total above int32 max',
    withCart({ expectedTotalCents: 3_000_000_000 - 6_900 }),
  ],
  ['pending handoff', data({ pendingHumanRequest: pendingHandoff })],
  ['malformed approval marker', withApproval({ requestId: 'nope' })],
  [
    'malformed context',
    withContext({ destination: { ...destination(), zipCode: '1' } }),
  ],
  ['bad draft', withDraft({ draft: { appliedCreditCents: 1 } })],
  ['non-canonical draft', withDraft({ createdAt: '2026-06-23T12:00:00Z' })],
];

describe('evaluateShippingSaleRevalidation', () => {
  it('returns ordinary free for a marker-free snapshot', () => {
    expect(revalidate(null).kind).toBe('ordinary_free');
    expect(revalidate({}).kind).toBe('ordinary_free');
    expect(
      revalidate(
        data({ [DRAFT_KEY]: null, [CONTEXT_KEY]: null, [APPROVAL_KEY]: null }),
      ).kind,
    ).toBe('ordinary_free');
  });

  it('returns the exact server-derived charge for a fresh pinned approval', () => {
    expect(revalidate(accepted(data()))).toEqual(chargedVerdict(60000));
  });

  it('charges when a full promo leaves a zero merchandise total', () => {
    expect(
      revalidate(
        accepted(withCart({ expectedTotalCents: 0 }), {
          merchandiseCents: 0,
        }),
      ),
    ).toEqual(chargedVerdict(0));
  });

  it('accepts the exact int32 backend total boundary', () => {
    const merchandiseTotalCents = 2_147_483_647 - 6_900;
    expect(
      revalidate(
        accepted(withCart({ expectedTotalCents: merchandiseTotalCents }), {
          merchandiseCents: merchandiseTotalCents,
        }),
      ),
    ).toEqual(chargedVerdict(merchandiseTotalCents));
  });

  it('matches canonical cart lines in any order with normalized variants', () => {
    const two = accepted(
      data({
        [CONTEXT_KEY]: context({ cart: [item(PRODUCT, null, 2, 60000)] }),
        cart: baseCart({
          items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 60000 }],
          expectedTotalCents: 120000,
        }),
      }),
      { merchandiseCents: 120000 },
    );
    expect(revalidate(two).kind).toBe('charged');
    const lines = [
      item(PRODUCT, null, 1, 60000),
      item(PRODUCT_2, VARIANT, 1, 8000),
    ];
    const reordered = accepted(
      data({
        [CONTEXT_KEY]: context({ cart: lines }),
        cart: baseCart({
          items: [...lines].reverse(),
          expectedTotalCents: 68000,
        }),
      }),
      { merchandiseCents: 68000 },
    );
    expect(revalidate(reordered).kind).toBe('charged');
  });

  it.each(blockedCases)('blocks %s', (_name, snapshot) => {
    expect(revalidate(snapshot).kind).toBe('blocked');
  });

  it('blocks an invalid clock while a quote is present', () => {
    expect(revalidate(data(), Number.NaN).kind).toBe('blocked');
    expect(revalidate(data(), -1).kind).toBe('blocked');
  });

  it('blocks a non-plain or hostile snapshot', () => {
    const hostile = {} as ConversationStateData;
    Object.defineProperty(hostile, DRAFT_KEY, {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(revalidate(hostile).kind).toBe('blocked');
    expect(revalidate([] as unknown as ConversationStateData).kind).toBe(
      'blocked',
    );
  });
});
