/** SCA-3b1: durable sent-offer marker seam tests. Fake store only; no I/O. */
import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  shippingCustomerAcceptance,
  shippingCustomerOffer,
} from '../../../test/fixtures/shipping-customer-acceptance-fixture';
import {
  normalizeShippingCustomerOffer,
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY as ACCEPT_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY as OFFER_KEY,
} from './shipping-customer-acceptance';
import { persistSentShippingCustomerOffer as persist } from './shipping-customer-offer-persistence';

const DRAFT = 'shippingQuoteDraft';
const CONTEXT = 'shippingQuoteDraftContext';
const APPROVAL = 'shippingApproval';
const PIN = '2026-06-23T12:00:00.000Z';
const EXPIRES = '2026-06-23T12:30:00.000Z';
const NOW_ISO = '2026-06-23T12:10:00.000Z';
const NOW = Date.parse(NOW_ISO);
const REQUEST = 'abcdef123456';
const MERCH = 60_000;
const CHARGE = 6_900;
const CUSTOMER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';
const OFFER = shippingCustomerOffer();
const ACCEPTANCE = shippingCustomerAcceptance();
const SIBLING = { messages: [{ role: 'user' as const, content: 'hola' }] };

const line = (unitPriceCents: number) => ({
  productId: PRODUCT,
  variantId: null,
  quantity: 1,
  unitPriceCents,
});
const draft = (charge = CHARGE) => ({
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
  createdAt: PIN,
  expiresAt: EXPIRES,
});
const context = () => ({
  schemaVersion: 1,
  draftCreatedAt: PIN,
  customerId: CUSTOMER,
  shippingAddressId: ADDRESS,
  cart: [line(MERCH)],
  destination: {
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
});
const approval = () => ({
  requestId: REQUEST,
  draftCreatedAt: PIN,
  decision: 'SHIPPING_APPROVED',
  decidedAt: '2026-06-23T12:05:00.000Z',
});
const cart = (expected = MERCH) => ({
  items: [line(MERCH)],
  idempotencyKey: 'key-1',
  expectedTotalCents: expected,
});
const base = (over: Record<string, unknown> = {}): ConversationStateData => ({
  [DRAFT]: draft(),
  [CONTEXT]: context(),
  [APPROVAL]: approval(),
  cart: cart(),
  ...SIBLING,
  ...over,
});
const stateOf = (
  data: ConversationStateData,
  lastMessageAt = NOW_ISO,
): ConversationState => ({ senderId: 's', lastMessageAt, data });

type Patch = { lastMessageAt?: string; data: Record<string, unknown> };
const okStore = (): [ConversationStore, jest.Mock] => {
  const update = jest.fn(
    (senderId: string, patch: Partial<Omit<ConversationState, 'senderId'>>) =>
      Promise.resolve({ senderId, ...patch } as ConversationState),
  );
  return [{ update } as unknown as ConversationStore, update];
};
const patchOf = (update: jest.Mock): [string, Patch] =>
  update.mock.calls[0] as [string, Patch];

describe('persistSentShippingCustomerOffer', () => {
  it('writes the exact offer, clears acceptance and preserves siblings/lastMessageAt', async () => {
    const [store, update] = okStore();
    const fresh = stateOf(base());
    const result = await persist(store, 's', fresh, OFFER, NOW);
    expect(update).toHaveBeenCalledTimes(1);
    const [senderId, patch] = patchOf(update);
    expect(senderId).toBe('s');
    expect(patch.lastMessageAt).toBe(NOW_ISO);
    const persisted = patch.data[OFFER_KEY] as { providerMessageId: string };
    expect(persisted).toEqual(normalizeShippingCustomerOffer(OFFER));
    expect(persisted).not.toBe(OFFER);
    expect(persisted.providerMessageId).toBe('wamid.HBgLc2NhLW9mZmVyPQ==');
    expect(patch.data[ACCEPT_KEY]).toBeNull();
    expect(patch.data.messages).toEqual(SIBLING.messages);
    expect(result).toMatchObject({ senderId: 's', lastMessageAt: NOW_ISO });
    expect(result!.data).toBe(patch.data);
  });

  it('does not rewrite an exact active replay with a matching or absent acceptance', async () => {
    const [store, update] = okStore();
    for (const accept of [ACCEPTANCE, null, undefined]) {
      const fresh = stateOf({
        ...base(),
        [OFFER_KEY]: OFFER,
        [ACCEPT_KEY]: accept,
      });
      expect(await persist(store, 's', fresh, OFFER, NOW)).toBe(fresh);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an exact replay whose acceptance is malformed, orphan or future', async () => {
    const [store, update] = okStore();
    const bad = [
      { bogus: true },
      shippingCustomerAcceptance({ requestId: 'ffffffffffff' }),
      shippingCustomerAcceptance({ acceptedAt: '2026-06-23T12:20:00.000Z' }),
    ];
    for (const accept of bad) {
      const fresh = stateOf({
        ...base(),
        [OFFER_KEY]: OFFER,
        [ACCEPT_KEY]: accept,
      });
      await expect(persist(store, 's', fresh, OFFER, NOW)).resolves.toBeNull();
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('clears any prior acceptance on a new offer, repriced or re-sent', async () => {
    const [store, update] = okStore();
    const newOffer = shippingCustomerOffer;
    const prior = shippingCustomerAcceptance;
    const cases: Array<[unknown, unknown]> = [
      [newOffer({ chargeCents: 6_800 }), prior({ chargeCents: 6_800 })],
      [newOffer({ providerMessageId: 'wamid.retry' }), prior()],
      [newOffer({ offeredAt: '2026-06-23T12:05:30.000Z' }), prior()],
      [undefined, prior({ requestId: 'ffffffffffff' })],
    ];
    for (const [stored, accepted] of cases) {
      const fresh = stateOf({
        ...base(),
        [OFFER_KEY]: stored,
        [ACCEPT_KEY]: accepted,
      });
      await persist(store, 's', fresh, OFFER, NOW);
      const [, patch] = patchOf(update);
      expect(patch.data[OFFER_KEY]).toEqual(
        normalizeShippingCustomerOffer(OFFER),
      );
      expect(patch.data[ACCEPT_KEY]).toBeNull();
      update.mockClear();
    }
  });

  it('returns null without writing for a mismatched sender, missing id, drift, bad clock or older replay', async () => {
    const [store, update] = okStore();
    const newer = shippingCustomerOffer({
      offeredAt: '2026-06-23T12:08:00.000Z',
    });
    const cases: Array<[ConversationState, unknown, number]> = [
      [stateOf(base()), { ...OFFER, providerMessageId: undefined }, NOW],
      [stateOf(base()), OFFER, NaN],
      [stateOf(base()), OFFER, Date.parse('2026-06-23T12:00:00.000Z')],
      [
        stateOf(base()),
        shippingCustomerOffer({ offeredAt: '2026-06-23T12:11:00.000Z' }),
        NOW,
      ],
      [stateOf(base()), OFFER, Date.parse(EXPIRES)],
      [stateOf(base()), undefined, NOW],
      [stateOf(base({ cart: cart(MERCH + 100) })), OFFER, NOW],
      [
        stateOf(base({ pendingHumanRequest: { requestId: REQUEST } })),
        OFFER,
        NOW,
      ],
      [stateOf({ ...base(), [OFFER_KEY]: newer }), OFFER, NOW],
      [{ ...stateOf(base()), senderId: 'other' }, OFFER, NOW],
    ];
    for (const [fresh, offer, clock] of cases) {
      await expect(
        persist(store, 's', fresh, offer, clock),
      ).resolves.toBeNull();
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('never throws and fails closed on hostile state or clock types', async () => {
    const [store, update] = okStore();
    const hostile = new Proxy<ConversationStateData>(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
        get() {
          throw new Error('trap');
        },
      },
    );
    for (const clock of [-1, 1.5, Number.POSITIVE_INFINITY, 'x', null]) {
      await expect(
        persist(store, 's', stateOf(base()), OFFER, clock as number),
      ).resolves.toBeNull();
    }
    await expect(
      persist(store, 's', { ...stateOf(base()), data: hostile }, OFFER, NOW),
    ).resolves.toBeNull();
    await expect(
      persist(store, 's', stateOf(base(), ''), OFFER, NOW),
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('returns null without throwing when the store rejects', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('db down'));
    const store = { update: failing } as unknown as ConversationStore;
    await expect(
      persist(store, 's', stateOf(base()), OFFER, NOW),
    ).resolves.toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
