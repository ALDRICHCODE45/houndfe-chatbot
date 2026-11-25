import type { ConfigService } from '@nestjs/config';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type {
  CheckoutContextAddress,
  CustomerCheckoutContext,
} from '../../chatbot-api/domain/dtos/checkout-context.dto';
import type { ShippingQuoteResponse } from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import { UpstreamError } from '../../chatbot-api/domain/errors';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { MINIMAL_ORDER_SUMMARY_HEADING } from '../domain/minimal-order-confirmation';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';
import { MinimalZoneResumeService } from './minimal-zone-resume.service';

const SENDER = '5215550001111';
const PHONE_ID = '123456789012345';
const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const SALE = '55555555-5555-4555-8555-555555555555';
const EXPIRES = new Date(Date.now() + 30 * 60_000).toISOString();
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: PHONE_ID,
  senderId: SENDER,
  messageId,
});
const savedAddress = (): CheckoutContextAddress => ({
  id: ADDRESS,
  version: '2026-10-01T00:00:00.000Z',
  label: 'Casa',
  street: 'Av. Juárez',
  exteriorNumber: '10',
  interiorNumber: null,
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: 'Cuauhtémoc',
  city: null,
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
});
const unique = (): CustomerCheckoutContext => ({
  status: 'unique',
  customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
  addresses: [savedAddress()],
  nextAfterAddressId: null,
});
const backendQuote = (
  overrides: Record<string, unknown> = {},
): ShippingQuoteResponse => ({
  quoteId: 'quote-2',
  expiresAt: EXPIRES,
  zoneStatus: 'FREE',
  option: null,
  costCents: 0,
  creditCents: 0,
  customerChargeCents: 0,
  currency: 'MXN',
  eta: { days: 2, reason: null },
  ...overrides,
});
const pendingQuote = (): ShippingQuoteResponse =>
  backendQuote({
    zoneStatus: 'PENDING',
    quoteId: null,
    expiresAt: null,
    eta: { days: null, reason: null },
  });

async function setup(options: { failCommit?: boolean } = {}) {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(() =>
      Promise.resolve([
        {
          productId: PRODUCT,
          name: 'Ibuprofeno',
          price: { priceCents: 1500 },
          variants: [],
        },
      ]),
    ),
    getStock: jest.fn(() =>
      Promise.resolve({
        productId: PRODUCT,
        name: 'Ibuprofeno',
        stock: { status: 'available', quantity: 10 },
        variants: [],
      }),
    ),
    evaluateCart: jest.fn((items: Array<{ quantity: number }>) =>
      Promise.resolve({
        items: items.map((item) => ({
          productId: PRODUCT,
          variantId: null,
          quantity: item.quantity,
          unitPriceCents: 1500,
          originalPriceCents: 1500 * item.quantity,
          finalPriceCents: 1500 * item.quantity,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        })),
        promotionEvaluationStatus: 'fully_evaluated',
      }),
    ),
    getCustomerCheckoutContext: jest.fn(() => Promise.resolve(unique())),
    createCheckout: jest.fn(() =>
      Promise.resolve({
        status: 'created',
        sale: {
          saleId: SALE,
          folio: 'B-0042',
          paymentStatus: 'CREDIT',
          channel: 'ONLINE',
          deliveryStatus: 'PENDING',
          totalCents: 3000,
          paidCents: 0,
          debtCents: 3000,
          confirmedAt: '2026-10-13T00:00:00.000Z',
          discountCents: 0,
        },
      }),
    ),
    getCheckoutStatus: jest.fn(() =>
      Promise.resolve({ status: 'not_observed', checkout: null }),
    ),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId' ? CASHIER : undefined,
  } as unknown as ConfigService;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const quotes = new FakeShippingQuoteClient();
  const zones = { register: jest.fn(() => Promise.resolve()) };
  const shipping = new MinimalShippingService(
    store,
    cart,
    checkout,
    quotes,
    zones,
  );
  const order = new MinimalOrderService(
    client,
    store,
    cart,
    checkout,
    config,
    shipping,
  );
  const resume = new MinimalZoneResumeService(store, checkout, shipping, order);

  await store.create(SENDER, {
    lastMessageAt: new Date().toISOString(),
    data: {
      minimalCart: {
        items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
        idempotencyKey: '',
        expectedTotalCents: 3000,
      },
    },
  });
  const lookup = await checkout.lookup(SENDER, null);
  if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
  await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
  const offer = await checkout.prepareConfirmation(SENDER, EVENT('d1'));
  offer.onSent?.();
  await checkout.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('d2'),
  });
  // The customer asked for shipping while the zone was PENDING.
  quotes.enqueue(pendingQuote());
  expect(await shipping.quote(SENDER)).toMatchObject({ kind: 'zone_pending' });
  quotes.calls.length = 0;
  zones.register.mockClear();
  if (options.failCommit === true)
    jest.spyOn(store, 'commitMinimalCart').mockResolvedValue(false);

  const prepare = (
    zoneType: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED',
  ) =>
    resume.prepare({
      senderId: SENDER,
      zipCode: '06000',
      zoneType,
      sourceRequestId: SOURCE,
      receivingPhoneNumberId: PHONE_ID,
    });
  const minimalCart = async () =>
    (await store.get(SENDER))?.data.minimalCart as Record<string, unknown>;
  const patchCart = async (patch: Record<string, unknown>) => {
    const raw = (await store.get(SENDER))!.data.minimalCart;
    const ok = await store.commitMinimalCart(
      SENDER,
      raw,
      { ...(raw as object), ...patch },
      new Date().toISOString(),
    );
    if (!ok) throw new Error('fixture CAS failed');
  };
  return {
    store,
    api,
    quotes,
    zones,
    order,
    checkout,
    prepare,
    minimalCart,
    patchCart,
  };
}

async function correctZip(
  h: Awaited<ReturnType<typeof setup>>,
  zipCode: string,
  confirm: boolean,
) {
  const fields = Object.fromEntries(
    Object.keys(savedAddress())
      .filter((key) => key !== 'id' && key !== 'version')
      .map((key) => [key, null]),
  );
  await h.checkout.updateDetails(SENDER, {
    ...fields,
    firstName: null,
    lastName: null,
    zipCode,
    useNewAddress: false,
  } as Parameters<MinimalCheckoutService['updateDetails']>[1]);
  if (!confirm) return;
  const offer = await h.checkout.prepareConfirmation(SENDER, EVENT('c1'));
  offer.onSent?.();
  await h.checkout.consume({
    senderId: SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('c2'),
  });
}

describe('MinimalZoneResumeService (S4: zone approved resumes checkout)', () => {
  it('FREE zone with ETA: re-quotes and returns the sentence plus the armed-on-send summary with confirm buttons', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    const resume = await h.prepare('FREE');
    expect(resume).not.toBeNull();
    expect(resume!.shippingSentence).toBe(
      'el envío no tiene costo y llega en aproximadamente 2 días hábiles',
    );
    expect(h.quotes.calls).toHaveLength(1);
    expect(resume!.summary.text).toContain(MINIMAL_ORDER_SUMMARY_HEADING);
    expect(resume!.summary.text).toContain('*Total a pagar: $30.00*');
    const status = h.order.offerStatus(SENDER)!;
    expect(status).toMatchObject({ armed: false });
    expect(resume!.summary.buttons).toEqual([
      { id: `order_confirm:${status.reference}`, title: '✅ Confirmar pedido' },
      { id: 'order_change', title: '✏️ Cambiar algo' },
    ]);
    expect(resume!.summary.prompt).toBe('¿Confirma su pedido?');
  });

  it('is armed only by the send: a SÍ before arm() creates nothing', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    await h.prepare('FREE');
    const early = await h.order.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.early'),
    });
    expect(early?.reply).toContain('Por ahora no puedo confirmar su pedido');
    expect(h.api.createCheckout).not.toHaveBeenCalled();
  });

  it('after arm() a later SÍ creates the order once, with the new quote', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    const resume = (await h.prepare('FREE'))!;
    resume.arm();
    const placed = await h.order.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.yes'),
    });
    expect(placed?.reply).toContain('B-0042');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.api.createCheckout.mock.calls[0])).toContain(
      'quote-2',
    );
    await h.order.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.yes2'),
    });
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('the confirm button reference matches the pending summary', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    const resume = (await h.prepare('FREE'))!;
    resume.arm();
    expect(h.order.offerStatus(SENDER)).toMatchObject({ armed: true });
    expect(resume.summary.buttons[0].id).toBe(
      `order_confirm:${h.order.offerStatus(SENDER)!.reference}`,
    );
  });

  it('SURCHARGE zone: the sentence states the charged amount from the quote', async () => {
    const h = await setup();
    h.quotes.enqueue(
      backendQuote({
        zoneStatus: 'SURCHARGE',
        option: { carrier: 'Skydropx', service: 'Ground', etaDays: 3 },
        costCents: 12500,
        creditCents: 0,
        customerChargeCents: 12500,
        eta: { days: 3, reason: null },
      }),
    );
    const resume = (await h.prepare('SURCHARGE'))!;
    expect(resume.shippingSentence).toBe(
      'el envío cuesta $125.00 y llega en aproximadamente 3 días hábiles',
    );
    expect(resume.summary.text).toContain('*Total a pagar: $155.00*');
  });

  it('a credit that covers the surcharge reads as free; one business day is singular', async () => {
    const h = await setup();
    h.quotes.enqueue(
      backendQuote({
        zoneStatus: 'SURCHARGE',
        costCents: 12000,
        creditCents: 12000,
        customerChargeCents: 0,
        eta: { days: 1, reason: null },
      }),
    );
    const resume = (await h.prepare('SURCHARGE'))!;
    expect(resume.shippingSentence).toBe(
      'el envío no tiene costo y llega en aproximadamente 1 día hábil',
    );
  });

  it.each([
    [
      'without an ETA the sentence has no arrival clause',
      { days: null, reason: null },
      'el envío no tiene costo',
    ],
    [
      'STOCK_PENDING says the date depends on restock',
      { days: null, reason: 'STOCK_PENDING' },
      'el envío no tiene costo y la fecha de entrega depende de la reposición de existencias',
    ],
  ])('%s', async (_label, eta, sentence) => {
    const h = await setup();
    h.quotes.enqueue(backendQuote({ eta }));
    expect((await h.prepare('FREE'))!.shippingSentence).toBe(sentence);
  });

  it('discard() drops the pending summary so a later SÍ cannot create the order', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    const resume = (await h.prepare('FREE'))!;
    resume.discard();
    expect(h.order.offerStatus(SENDER)).toBeNull();
  });

  it('discard() keeps a summary the customer armed meanwhile (it only drops its own)', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    const resume = (await h.prepare('FREE'))!;
    const ownReference = h.order.offerStatus(SENDER)!.reference;
    // The customer's own turn prepared and sent a newer summary.
    const theirs = await h.order.prepareOrder(SENDER, EVENT('customer-turn'));
    theirs.onSent?.();
    const theirReference = h.order.offerStatus(SENDER)!.reference;
    expect(theirReference).not.toBe(ownReference);
    resume.discard();
    expect(h.order.offerStatus(SENDER)).toMatchObject({
      reference: theirReference,
      armed: true,
    });
  });

  it('discard() still drops its own summary when it is the pending one', async () => {
    const h = await setup();
    h.quotes.enqueue(backendQuote());
    const resume = (await h.prepare('FREE'))!;
    resume.discard();
    resume.discard();
    expect(h.order.offerStatus(SENDER)).toBeNull();
  });

  describe('fallback: any failed precondition returns null and no summary stays pending', () => {
    const expectFallback = async (
      h: Awaited<ReturnType<typeof setup>>,
      zoneType: 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED' = 'FREE',
    ) => {
      expect(await h.prepare(zoneType)).toBeNull();
      expect(h.order.offerStatus(SENDER)).toBeNull();
      expect(h.api.createCheckout).not.toHaveBeenCalled();
    };

    it.each(['CARRIER_ONLY', 'DENIED'] as const)(
      '%s zones keep the current behaviour (no quote, no resume)',
      async (zoneType) => {
        const h = await setup();
        h.quotes.enqueue(backendQuote());
        await expectFallback(h, zoneType);
        expect(h.quotes.calls).toHaveLength(0);
      },
    );

    it('the cart is empty', async () => {
      const h = await setup();
      await h.patchCart({ items: [], expectedTotalCents: 0 });
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
      expect(h.quotes.calls).toHaveLength(0);
    });

    it('the cart changed after the PENDING quote', async () => {
      const h = await setup();
      await h.patchCart({
        items: [{ productId: PRODUCT, quantity: 3, unitPriceCents: 1500 }],
        expectedTotalCents: 4500,
      });
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
      expect(h.quotes.calls).toHaveLength(0);
    });

    it('the PENDING quote is gone (the customer chose store pickup)', async () => {
      const h = await setup();
      await h.patchCart({
        shipping: {
          mode: 'pickup',
          cartPin: [
            {
              productId: PRODUCT,
              quantity: 2,
              unitPriceCents: 1500,
              finalPriceCents: 3000,
            },
          ],
        },
      });
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
      expect(h.quotes.calls).toHaveLength(0);
    });

    it('there is no stored shipping record at all', async () => {
      const h = await setup();
      const raw = { ...(await h.minimalCart()) };
      delete raw.shipping;
      const state = (await h.store.get(SENDER))!;
      await h.store.commitMinimalCart(
        SENDER,
        state.data.minimalCart,
        raw,
        new Date().toISOString(),
      );
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
    });

    it('the customer corrected the ZIP and confirmed it again', async () => {
      const h = await setup();
      await correctZip(h, '55635', true);
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
      expect(h.quotes.calls).toHaveLength(0);
    });

    it('the delivery data are no longer confirmed', async () => {
      const h = await setup();
      await correctZip(h, '55635', false);
      expect(await h.checkout.confirmedDraft(SENDER)).toBeNull();
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
      expect(h.quotes.calls).toHaveLength(0);
    });

    it('the shipping quote fails', async () => {
      const h = await setup();
      h.quotes.enqueue(new UpstreamError('down', 503));
      await expectFallback(h);
    });

    it.each(['PENDING', 'DENIED'] as const)(
      'the quote comes back %s (not deliverable)',
      async (zoneStatus) => {
        const h = await setup();
        h.quotes.enqueue(
          backendQuote({
            zoneStatus,
            quoteId: null,
            expiresAt: null,
            eta: { days: null, reason: null },
          }),
        );
        await expectFallback(h);
      },
    );

    it('the quote comes back CARRIER_ONLY while the zone was approved as FREE', async () => {
      const h = await setup();
      h.quotes.enqueue(
        backendQuote({
          zoneStatus: 'CARRIER_ONLY',
          option: { carrier: 'Skydropx', service: 'Ground', etaDays: 3 },
          costCents: 20000,
          customerChargeCents: 20000,
        }),
      );
      await expectFallback(h);
    });

    it('the cart write loses its CAS', async () => {
      const h = await setup({ failCommit: true });
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
    });

    it('an earlier order request is still unresolved', async () => {
      const h = await setup();
      await h.patchCart({ idempotencyKey: 'k-1' });
      h.quotes.enqueue(backendQuote());
      await expectFallback(h);
      expect(h.quotes.calls).toHaveLength(0);
    });
  });
});
