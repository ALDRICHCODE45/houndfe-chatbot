import { makeCreateSaleTool } from './create-sale.tool';
import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../../conversation/domain/conversation-store';
import type { CartState } from '../../domain/cart-state';
import type { ToolDeps } from '../tool-deps';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type {
  BotSaleResponse,
  CreateSaleInput,
} from '../../../chatbot-api/domain/dtos/sales.dto';
import type { HumanHandoffService } from '../../../human-handoff/application/human-handoff.service';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import { SHIPPING_APPROVAL_KEY } from '../../../human-handoff/application/shipping-approval-persistence';
import { SHIPPING_QUOTE_DRAFT_KEY } from '../../../shipping/application/shipping-quote-draft-record';
import { SHIPPING_QUOTE_DRAFT_CONTEXT_KEY } from '../../../shipping/application/shipping-quote-draft-context';
import {
  DENIED,
  SALE,
} from '../../../../test/fixtures/shipping-sale-gate-fixture';
import {
  ID,
  NOW_ISO,
  NOW_MS,
  draftRecord,
} from '../../../../test/fixtures/shipping-approval-request-fixture';
import {
  shippingAcceptancePair,
  type ShippingAcceptanceOverrides,
} from '../../../../test/fixtures/shipping-customer-acceptance-fixture';
import {
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY,
} from '../../../shipping/application/shipping-customer-acceptance';

// E4-2b2: freight-safe promotion retry on a charged (approved-shipping) sale.
// The backend PROMO_RE_QUOTE recomputed total already includes freight, so the
// retry persists only the merchandise remainder and resends the freight once.
const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';
const SENDER = '525512345678';
const PHONE = '5512345678';
const NOW = NOW_MS + 600_000;
const MERCH = 60_000;
const CHARGE = 6_900;
const SENT_TOTAL = MERCH + CHARGE; // 66_900 freight-inclusive first send
const RECOMPUTED = 65_000; // 58_100 merchandise + 6_900 freight
const REMAINDER = RECOMPUTED - CHARGE; // 58_100
// A genuinely new disclosure/reply must carry a later timeline and fresh
// bounded message ids; reusing the original pair's 12:06/12:07 defaults (or its
// provider/inbound ids) would only re-assert the stale pair, not new consent.
const FRESH_OFFERED_AT = '2026-06-23T12:08:00.000Z';
const FRESH_ACCEPTED_AT = '2026-06-23T12:09:00.000Z';
const FRESH_PROVIDER_MESSAGE_ID = 'wamid.HBgLc2NhLW9mZmVyLTI=';
const FRESH_INBOUND_MESSAGE_ID = 'wamid.HBgLc2NhLXllcy0y';
const ORIGINAL_PROVIDER_MESSAGE_ID = (
  shippingAcceptancePair()[SHIPPING_CUSTOMER_OFFER_KEY] as {
    providerMessageId: string;
  }
).providerMessageId;
const ORIGINAL_INBOUND_MESSAGE_ID = (
  shippingAcceptancePair()[SHIPPING_CUSTOMER_ACCEPTANCE_KEY] as {
    inboundMessageId: string;
  }
).inboundMessageId;
const DEST = {
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};
const LINE = {
  productId: PRODUCT,
  variantId: null,
  quantity: 1,
  unitPriceCents: MERCH,
};

type Over = Record<string, unknown>;
type SaleInput = Parameters<
  ReturnType<typeof makeCreateSaleTool>['execute']
>[0];
type Patch = Partial<Omit<ConversationState, 'senderId'>>;
type BackendCall = Error | BotSaleResponse;

const contexts = (createdAt: string): Over => ({
  schemaVersion: 1,
  draftCreatedAt: createdAt,
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  cart: [LINE],
  destination: DEST,
});
const approval = (createdAt: string): Over => ({
  requestId: ID,
  draftCreatedAt: createdAt,
  decision: 'SHIPPING_APPROVED',
  decidedAt: createdAt,
});
const chargedBag = (key = '', over: Over = {}): ConversationStateData => {
  const record = draftRecord();
  return {
    [SHIPPING_QUOTE_DRAFT_KEY]: record,
    [SHIPPING_QUOTE_DRAFT_CONTEXT_KEY]: contexts(record.createdAt),
    [SHIPPING_APPROVAL_KEY]: approval(record.createdAt),
    cart: { items: [LINE], idempotencyKey: key, expectedTotalCents: MERCH },
    ...over,
  };
};
const lookup = (zipCode = DEST.zipCode): Over => ({
  found: true,
  customer: {
    customerId: CUSTOMER,
    firstName: 'Ana',
    phone: PHONE,
    address: { id: ADDRESS, street: 'Calle Falsa 123', ...DEST, zipCode },
  },
});
const promoBody = (over: Over = {}): Over => ({
  error: 'PROMO_RE_QUOTE',
  recomputedTotalCents: RECOMPUTED,
  expectedTotalCents: SENT_TOTAL,
  discountCents: 1_900,
  shippingChargeCents: CHARGE,
  ...over,
});
const promoErr = (body: unknown = promoBody()): UpstreamError =>
  new UpstreamError('Price changed', 409, body, 'PROMO_RE_QUOTE');
const input = (over: Partial<SaleInput> = {}): SaleInput => ({
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  items: [{ ...LINE, productName: 'Croquetas' }],
  ...over,
});

function setup(
  initial: ConversationStateData,
  results: BackendCall[],
  lookups: Array<() => unknown> = [() => lookup()],
) {
  let current: ConversationState = {
    senderId: SENDER,
    lastMessageAt: NOW_ISO,
    data: initial,
  };
  const update = jest.fn(
    async (senderId: string, patch: Patch): Promise<ConversationState> => {
      current = {
        senderId,
        lastMessageAt: patch.lastMessageAt ?? NOW_ISO,
        data: patch.data ?? current.data,
      };
      return current;
    },
  );
  const get = jest.fn(async () => current);
  let lookupCalls = 0;
  const getCustomerByPhone = jest.fn(async () => {
    const next = lookups[lookupCalls] ?? lookups[lookups.length - 1];
    lookupCalls += 1;
    return next();
  });
  const createSale = jest.fn<
    Promise<BotSaleResponse>,
    [CreateSaleInput, string]
  >(async () => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? SALE;
  });
  const deps: ToolDeps = {
    cashierUserId: 'cashier',
    humanHandoffService: {} as unknown as HumanHandoffService,
    chatbotApi: {
      createSale,
      getCustomerByPhone,
    } as unknown as ChatbotApiClient,
    store: { get, update } as unknown as ConversationStore,
  };
  return {
    tool: makeCreateSaleTool(deps, () => NOW),
    createSale,
    getCustomerByPhone,
    update,
    data: () => current.data ?? {},
    cart: () => current.data?.cart as CartState,
  };
}
type Harness = ReturnType<typeof setup>;
const run = (h: Harness, modelInput: SaleInput = input()) =>
  h.tool.execute(modelInput, {
    toolCallId: 't',
    messages: [],
    context: { senderId: SENDER },
  });
// SCA-2b: the deterministic disclosure/router that would persist a fresh
// server-owned pair after a merchandise change is NOT implemented yet (SCA-3/4
// own it). The harness simulates that later server write so a charged retry is
// exercised end to end.
const writeFreshAcceptancePair = async (
  h: Harness,
  over: ShippingAcceptanceOverrides = {},
) => {
  await h.update(SENDER, {
    data: {
      ...h.data(),
      ...shippingAcceptancePair({
        offeredAt: FRESH_OFFERED_AT,
        acceptedAt: FRESH_ACCEPTED_AT,
        providerMessageId: FRESH_PROVIDER_MESSAGE_ID,
        inboundMessageId: FRESH_INBOUND_MESSAGE_ID,
        ...over,
      }),
    },
  });
};
const expectFreshAcceptancePair = (h: Harness) => {
  const offer = h.data()[SHIPPING_CUSTOMER_OFFER_KEY] as {
    offeredAt: string;
    merchandiseCents: number;
    providerMessageId: string;
  };
  const acceptance = h.data()[SHIPPING_CUSTOMER_ACCEPTANCE_KEY] as {
    acceptedAt: string;
    merchandiseCents: number;
    inboundMessageId: string;
  };
  expect(offer.offeredAt).toBe(FRESH_OFFERED_AT);
  expect(acceptance.acceptedAt).toBe(FRESH_ACCEPTED_AT);
  expect(offer.providerMessageId).toBe(FRESH_PROVIDER_MESSAGE_ID);
  expect(acceptance.inboundMessageId).toBe(FRESH_INBOUND_MESSAGE_ID);
  expect(offer.providerMessageId).not.toBe(ORIGINAL_PROVIDER_MESSAGE_ID);
  expect(acceptance.inboundMessageId).not.toBe(ORIGINAL_INBOUND_MESSAGE_ID);
  expect(offer.merchandiseCents).toBe(REMAINDER);
  expect(acceptance.merchandiseCents).toBe(REMAINDER);
};
const renderedPromo = {
  ok: false,
  error: {
    kind: 'promoReQuote',
    retryable: false,
    recomputedTotalCents: RECOMPUTED,
    expectedTotalCents: SENT_TOTAL,
    discountCents: 1_900,
  },
};

describe('makeCreateSaleTool charged PROMO_RE_QUOTE retry (E4-2b2)', () => {
  it('persists the merchandise remainder, rotates the key, and resends freight once', async () => {
    const h = setup(chargedBag('first-key', shippingAcceptancePair()), [
      promoErr(),
      { ...SALE, totalCents: RECOMPUTED },
    ]);
    const first = await run(h);
    expect(first).toEqual(renderedPromo);
    expect(h.createSale).toHaveBeenCalledTimes(1);
    expect(h.createSale.mock.calls[0][1]).toBe('first-key');
    expect(h.createSale.mock.calls[0][0].expectedTotalCents).toBe(SENT_TOTAL);
    expect(h.cart()).toEqual({
      items: [LINE],
      idempotencyKey: '',
      expectedTotalCents: REMAINDER,
    });

    // The changed merchandise invalidates the original 60_000 disclosure;
    // simulate the not-yet-implemented router writing a fresh 58_100 pair.
    await writeFreshAcceptancePair(h, { merchandiseCents: REMAINDER });
    expectFreshAcceptancePair(h);

    const second = await run(h);
    expect(second).toEqual({ ok: true, ...SALE, totalCents: RECOMPUTED });
    expect(h.createSale).toHaveBeenCalledTimes(2);
    const [dto, key] = h.createSale.mock.calls[1];
    expect(key).not.toBe('first-key');
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Freight added exactly once: remainder (58_100) + charge (6_900).
    expect(dto.expectedTotalCents).toBe(RECOMPUTED);
    expect(dto.shipping).toEqual({
      chargeCents: CHARGE,
      approvalId: ID,
      quoteId: 'q1',
    });
    expect(JSON.stringify(dto)).not.toContain(String(SENT_TOTAL + CHARGE));
    // The retry re-reads the backend customer/address before key/store/HTTP.
    expect(h.getCustomerByPhone).toHaveBeenCalledTimes(2);
    expect(h.getCustomerByPhone).toHaveBeenNthCalledWith(1, '52', PHONE);
    expect(h.getCustomerByPhone).toHaveBeenNthCalledWith(2, '52', PHONE);
  });

  it('blocks the retry on the stale pair before lookup/key/store/HTTP', async () => {
    const h = setup(chargedBag('first-key', shippingAcceptancePair()), [
      promoErr(),
      { ...SALE, totalCents: RECOMPUTED },
    ]);
    const first = await run(h);
    expect(first).toEqual(renderedPromo);
    expect(h.cart()).toEqual({
      items: [LINE],
      idempotencyKey: '',
      expectedTotalCents: REMAINDER,
    });

    // The original 60_000 disclosure no longer matches the 58_100 remainder,
    // so the second call is denied before any lookup, key mint, or HTTP.
    const second = await run(h);
    expect(second).toEqual(DENIED);
    expect(h.getCustomerByPhone).toHaveBeenCalledTimes(1);
    expect(h.createSale).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.cart()).toEqual({
      items: [LINE],
      idempotencyKey: '',
      expectedTotalCents: REMAINDER,
    });
  });

  it('allows a zero merchandise remainder when freight is the whole total', async () => {
    const h = setup(chargedBag('first-key', shippingAcceptancePair()), [
      promoErr(
        promoBody({
          recomputedTotalCents: CHARGE,
          discountCents: MERCH,
        }),
      ),
    ]);
    const result = await run(h);
    expect(result).toEqual({
      ...renderedPromo,
      error: {
        ...renderedPromo.error,
        recomputedTotalCents: CHARGE,
        discountCents: MERCH,
      },
    });
    expect(h.cart().expectedTotalCents).toBe(0);
    expect(h.cart().idempotencyKey).toBe('');
  });

  const blockedBodies: Array<[string, unknown]> = [
    [
      'a missing shippingChargeCents',
      promoBody({ shippingChargeCents: undefined }),
    ],
    [
      'a mismatched shippingChargeCents',
      promoBody({ shippingChargeCents: CHARGE + 1 }),
    ],
    [
      'a drifted pinned expected total',
      promoBody({ expectedTotalCents: SENT_TOTAL + 1 }),
    ],
    [
      'a recomputed total below freight',
      promoBody({ recomputedTotalCents: CHARGE - 1 }),
    ],
    [
      'an int32-overflow recomputed total',
      promoBody({ recomputedTotalCents: 2_147_483_648 }),
    ],
  ];

  it.each(blockedBodies)(
    'fails price-free and cannot persist the recomputed total on %s',
    async (_label, body) => {
      const h = setup(chargedBag('first-key', shippingAcceptancePair()), [
        promoErr(body),
      ]);
      const result = await run(h);
      expect(result).toEqual(DENIED);
      expect(JSON.stringify(result)).not.toContain(String(RECOMPUTED));
      expect(h.createSale).toHaveBeenCalledTimes(1);
      expect(h.update).toHaveBeenCalledTimes(1);
      expect(h.cart()).toEqual({
        items: [LINE],
        idempotencyKey: '',
        expectedTotalCents: MERCH,
      });
    },
  );

  it('blocks a retry on destination drift before the second key or HTTP call', async () => {
    const h = setup(
      chargedBag('first-key', shippingAcceptancePair()),
      [promoErr(), { ...SALE, totalCents: RECOMPUTED }],
      [() => lookup(), () => lookup('06701')],
    );
    const first = await run(h);
    expect(first).toEqual(renderedPromo);
    expect(h.cart().expectedTotalCents).toBe(REMAINDER);
    expect(h.cart().idempotencyKey).toBe('');

    // The gate re-reads the current cart, so the retry needs a fresh matching
    // pair (not-yet-implemented router simulation) to reach the address lookup;
    // otherwise the denial would come from the stale pair and prove nothing
    // about destination drift.
    await writeFreshAcceptancePair(h, { merchandiseCents: REMAINDER });
    expectFreshAcceptancePair(h);
    const writesBeforeRetry = h.update.mock.calls.length;

    const second = await run(h);
    expect(second).toEqual(DENIED);
    // The drifted destination is rejected before a fresh key mint or any HTTP.
    expect(h.getCustomerByPhone).toHaveBeenCalledTimes(2);
    expect(h.createSale).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(writesBeforeRetry);
    expect(h.cart().expectedTotalCents).toBe(REMAINDER);
    expect(h.cart().idempotencyKey).toBe('');
  });
});
