import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { BackorderClient } from '../../backorders/domain/backorder';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CreateCheckoutInput } from '../../chatbot-api/domain/dtos/checkout.dto';
import { ChatbotApiError } from '../../chatbot-api/domain/errors';
import { FakeShippingQuoteClient } from '../../chatbot-api/infrastructure/fake-shipping-quote.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import {
  evaluateMinimalPickupOrder,
  renderMinimalOrderSummary,
  sameMinimalOrder,
} from '../domain/minimal-order-confirmation';
import { DurableOrderConfirmation } from './gates/order-confirmation.gate';
import { backorderLineDecision } from './minimal-backorder-checkout';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import {
  MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY,
  MINIMAL_ORDER_CHANGED_REPLY,
  MINIMAL_ORDER_REJECTED_REPLY,
  MINIMAL_ORDER_UNRESOLVED_REPLY,
  MinimalOrderService,
} from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';
import {
  BO_CROQUETAS,
  BO_DECISION,
  BO_FINAL_CENTS,
  BO_ID,
  BO_ID_2,
  BO_PRODUCT,
  BO_SENDER,
  backorderCartLine,
  reservedBackorder,
} from './minimal-backorder-checkout.fixtures';

/**
 * Restock backorder T5b (S2, S6, S11): the normal checkout with a reserved
 * backorder line: the body carries `backorderId` at the final price, the total
 * follows contract §7, and every refusal of the backend is answered honestly.
 */
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const SALE = '55555555-5555-4555-8555-555555555555';
const CATALOG: Record<string, { name: string; price: number }> = {
  [BO_PRODUCT]: { name: 'Ibuprofeno', price: 1500 },
  [BO_CROQUETAS]: { name: 'Croquetas Adulto 18 kg', price: 120000 },
};
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: BO_SENDER,
  messageId,
});
const savedAddress = {
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
};
const placedSale = () => ({
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
});
/** A stored cart line (the ordinary shape, optionally a backorder line). */
interface Line {
  productId: string;
  variantId?: string;
  quantity: number;
  unitPriceCents: number;
  backorder?: { id: string; folio: string };
}
const refusal = (status: number, error: string, extra: object = {}) =>
  new ChatbotApiError(
    error,
    status,
    { statusCode: status, error, ...extra },
    error,
  );

function setup() {
  const store = new InMemoryConversationStore();
  let promoPercent = 0;
  const api = {
    searchCatalog: jest.fn((name: string) => {
      const [productId, entry] = Object.entries(CATALOG).find(
        ([, v]) => v.name === name,
      )!;
      return Promise.resolve([
        {
          productId,
          name: entry.name,
          price: { priceCents: entry.price },
          variants: [],
        },
      ]);
    }),
    getStock: jest.fn((productId: string) =>
      Promise.resolve({
        productId,
        name: CATALOG[productId].name,
        stock: { status: 'available', quantity: 10 },
        variants: [],
      }),
    ),
    evaluateCart: jest.fn(
      (
        items: Array<{
          productId: string;
          quantity: number;
          unitPriceCents: number;
        }>,
      ) =>
        Promise.resolve({
          items: items.map((item) => {
            const original = item.unitPriceCents * item.quantity;
            const discount = Math.round((original * promoPercent) / 100);
            return {
              productId: item.productId,
              variantId: null,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              originalPriceCents: original,
              finalPriceCents: original - discount,
              discountAmountCents: discount,
              appliedPromotionTitle: discount > 0 ? 'Promo orden' : null,
            };
          }),
          promotionEvaluationStatus: 'fully_evaluated',
        }),
    ),
    getCustomerCheckoutContext: jest.fn(() =>
      Promise.resolve({
        status: 'unique',
        customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
        addresses: [savedAddress],
        nextAfterAddressId: null,
      }),
    ),
    createCheckout: jest.fn(() =>
      Promise.resolve({ status: 'created', sale: placedSale() }),
    ),
    getCheckoutStatus: jest.fn(() =>
      Promise.resolve({ status: 'not_observed', checkout: null }),
    ),
    createSale: jest.fn(),
    upsertCustomer: jest.fn(),
  };
  const backorders = {
    createBackorder: jest.fn(),
    getBackorder: jest.fn().mockResolvedValue(reservedBackorder()),
    listBackorders: jest.fn(),
    cancelBackorder: jest.fn(),
  } satisfies Record<keyof BackorderClient, jest.Mock>;
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId' ? CASHIER : undefined,
  } as unknown as ConfigService;
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const quotes = new FakeShippingQuoteClient();
  const shipping = new MinimalShippingService(store, cart, checkout, quotes, {
    register: async () => undefined,
  });
  const order = new MinimalOrderService(
    client,
    store,
    cart,
    checkout,
    config,
    shipping,
    undefined,
    undefined,
    undefined,
    backorders,
  );
  const pin = (items: Line[]) =>
    items.map((line) => ({
      productId: line.productId,
      ...(line.variantId === undefined ? {} : { variantId: line.variantId }),
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      finalPriceCents: line.unitPriceCents * line.quantity,
      ...(line.backorder === undefined
        ? {}
        : { backorderId: line.backorder.id }),
    }));
  /** A pickup cart: the pickup choice is pinned to exactly these lines. */
  const seedPickup = (items: Line[]) =>
    store.commitMinimalCart(
      BO_SENDER,
      undefined,
      {
        items,
        idempotencyKey: '',
        shipping: { mode: 'pickup', cartPin: pin(items) },
      },
      '2026-10-10T00:00:00.000Z',
    );
  const slot = async () =>
    (await store.get(BO_SENDER))?.data.minimalCart as {
      items: Line[];
      idempotencyKey: string;
      shipping?: unknown;
    };
  const offer = async (id = 'wamid.o1') => {
    const prepared = await order.prepareOrder(BO_SENDER, EVENT(id));
    prepared.onSent?.();
    return prepared;
  };
  const yes = (id = 'wamid.o2') =>
    order.consume({ senderId: BO_SENDER, text: 'SÍ', inboundEvent: EVENT(id) });
  return {
    store,
    api,
    backorders,
    cart,
    checkout,
    shipping,
    quotes,
    order,
    seedPickup,
    slot,
    offer,
    yes,
    setPromo: (percent: number) => {
      promoPercent = percent;
    },
  };
}
type Harness = ReturnType<typeof setup>;

/** A backend-signed delivery quote (customer pays the shipping charge). */
const deliveryQuote = (quoteId: string) => ({
  quoteId,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  zoneStatus: 'CARRIER_ONLY' as const,
  option: { carrier: 'Skydropx', service: 'Ground', etaDays: 2 },
  costCents: 5000,
  creditCents: 0,
  customerChargeCents: 5000,
  currency: 'MXN' as const,
  eta: { days: 2, reason: null },
});

/**
 * A DELIVERY cart: saved address confirmed and a stored backend quote
 * (`quote-1`) pinned to exactly these lines at their current prices.
 */
async function seedDelivery(h: Harness, items: Line[]) {
  await h.store.commitMinimalCart(
    BO_SENDER,
    undefined,
    { items, idempotencyKey: '' },
    '2026-10-10T00:00:00.000Z',
  );
  const lookup = await h.checkout.lookup(BO_SENDER, null);
  if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
  await h.checkout.selectAddress(BO_SENDER, lookup.addresses[0].addressRef);
  const delivery = await h.checkout.prepareConfirmation(
    BO_SENDER,
    EVENT('wamid.d1'),
  );
  delivery.onSent?.();
  await h.checkout.consume({
    senderId: BO_SENDER,
    text: 'SÍ',
    inboundEvent: EVENT('wamid.d2'),
  });
  h.quotes.enqueue(deliveryQuote('quote-1'));
  expect((await h.shipping.quote(BO_SENDER)).kind).toBe('quoted');
}

const BACKORDER_LINE = backorderCartLine();
const ORDINARY = { productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1500 };
const sentBody = (h: Harness, call = 0): CreateCheckoutInput =>
  (
    h.api.createCheckout.mock.calls as unknown as Array<
      [CreateCheckoutInput, string]
    >
  )[call][0];

describe('summary and createCheckout with a backorder line (S2, S6, S11)', () => {
  it('backorder-only cart: line at finalPriceCents with backorderId, §7 total, marked summary', async () => {
    const h = setup();
    await h.seedPickup([BACKORDER_LINE]);

    const offer = await h.offer();
    expect(offer.reply).toContain(
      '• Croquetas Adulto 18 kg: 2 × $1099.00 MXN; importe $2198.00 MXN (pedido apartado BO-000012)',
    );
    expect(offer.reply).toContain('Total de productos: $2198.00 MXN');
    expect(offer.reply).toContain('Total a pagar: $2198.00 MXN');
    // Nothing to evaluate: no promotion call for a backorder-only cart.
    expect(h.api.evaluateCart).not.toHaveBeenCalled();

    const placed = await h.yes();
    expect(placed?.reply).toContain('¡Listo!');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(sentBody(h)).toEqual({
      phoneCountryCode: '52',
      phone: '5550001111',
      customer: { mode: 'existing', customerId: CUSTOMER },
      sale: {
        cashierUserId: CASHIER,
        items: [
          {
            productId: BO_CROQUETAS,
            variantId: null,
            productName: 'Croquetas Adulto 18 kg',
            variantName: null,
            quantity: 2,
            unitPriceCents: BO_FINAL_CENTS,
            backorderId: BO_ID,
          },
        ],
        expectedTotalCents: 2 * BO_FINAL_CENTS,
        shipping: { mode: 'pickup' },
      },
    });
  });

  it('mixed cart with an order-level promotion on the ordinary lines: expectedTotalCents = Σ backorder + evaluate-cart of ONLY the ordinary lines', async () => {
    const h = setup();
    h.setPromo(10);
    await h.seedPickup([ORDINARY, BACKORDER_LINE]);

    const offer = await h.offer();
    // The promotion applies to the ordinary line only.
    expect(offer.reply).toContain(
      '• Ibuprofeno: 2 × $15.00 MXN; importe $27.00 MXN (promoción: Promo orden, ahorro $3.00 MXN)',
    );
    expect(offer.reply).toContain(
      '• Croquetas Adulto 18 kg: 2 × $1099.00 MXN; importe $2198.00 MXN (pedido apartado BO-000012)',
    );
    expect(h.api.evaluateCart.mock.calls[0][0]).toEqual([
      { productId: BO_PRODUCT, quantity: 2, unitPriceCents: 1500 },
    ]);

    await h.yes();
    const body = sentBody(h);
    expect(body.sale.expectedTotalCents).toBe(2700 + 2 * BO_FINAL_CENTS);
    expect(body.sale.items[0]).not.toHaveProperty('backorderId');
    expect(body.sale.items[1]).toMatchObject({
      productId: BO_CROQUETAS,
      unitPriceCents: BO_FINAL_CENTS,
      backorderId: BO_ID,
    });
    expect(body.sale.items[0]).toEqual({
      productId: BO_PRODUCT,
      variantId: null,
      productName: 'Ibuprofeno',
      variantName: null,
      quantity: 2,
      unitPriceCents: 1500,
    });
  });

  it('an ordinary line and a backorder line of the SAME product stay two lines in the body', async () => {
    const h = setup();
    await h.seedPickup([
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
      backorderCartLine({
        productId: BO_PRODUCT,
        productName: 'Ibuprofeno',
        unitPriceCents: 1200,
      }),
    ]);
    await h.offer();
    await h.yes();
    const { items, expectedTotalCents } = sentBody(h).sale;
    expect(
      items.map((i) => [i.quantity, i.unitPriceCents, i.backorderId]),
    ).toEqual([
      [1, 1500, undefined],
      [2, 1200, BO_ID],
    ]);
    expect(expectedTotalCents).toBe(1500 + 2400);
  });

  it('delivery: the shipping quote asks about the units together (no repeated cart line) and the total adds the shipping charge', async () => {
    const h = setup();
    await seedDelivery(h, [
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
      backorderCartLine({
        productId: BO_PRODUCT,
        productName: 'Ibuprofeno',
        unitPriceCents: 1200,
      }),
    ]);
    expect(h.quotes.calls[0].items).toEqual([
      { productId: BO_PRODUCT, quantity: 3 },
    ]);
    const stored = await h.slot();
    const pins = (
      stored.shipping as { cartPin: Array<{ backorderId?: string }> }
    ).cartPin;
    expect(pins.map((pin) => pin.backorderId)).toEqual([undefined, BO_ID]);

    const offer = await h.offer();
    expect(offer.reply).toContain('(pedido apartado BO-000012)');
    expect(offer.reply).toContain('Total a pagar: $89.00 MXN');
    await h.yes();
    const { expectedTotalCents, shipping, items } = sentBody(h).sale;
    expect(shipping).toEqual({ quoteId: 'quote-1' });
    expect(expectedTotalCents).toBe(1500 + 2400 + 5000);
    expect(items[1].backorderId).toBe(BO_ID);
  });
});

describe('request shapes for a backorder + ordinary line of the SAME product (documented)', () => {
  it('the shipping quote asks for ONE merged line; the checkout sends TWO separate lines', async () => {
    const h = setup();
    await seedDelivery(h, [
      { productId: BO_PRODUCT, quantity: 1, unitPriceCents: 1500 },
      backorderCartLine({
        productId: BO_PRODUCT,
        productName: 'Ibuprofeno',
        unitPriceCents: 1200,
      }),
    ]);
    // POST /shipping/quotes: one line, quantities summed (the backend rejects
    // a repeated line with DUPLICATE_CART_LINE).
    expect(h.quotes.calls).toHaveLength(1);
    expect(h.quotes.calls[0].items).toEqual([
      { productId: BO_PRODUCT, quantity: 3 },
    ]);

    await h.offer();
    await h.yes();
    // POST /checkouts: the ordinary line and the backorder line stay apart
    // (the backorder line carries backorderId and its own price); the backend
    // verifies the quote by summing quantities per productId + variantId.
    expect(
      sentBody(h).sale.items.map((item) => [
        item.productId,
        item.quantity,
        item.unitPriceCents,
        item.backorderId ?? null,
      ]),
    ).toEqual([
      [BO_PRODUCT, 1, 1500, null],
      [BO_PRODUCT, 2, 1200, BO_ID],
    ]);
    expect(sentBody(h).sale.shipping).toEqual({ quoteId: 'quote-1' });
  });
});

describe('checkout refusals of a backorder line (contract §7)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const refuse = async (
    h: Harness,
    error: ChatbotApiError,
    items: Line[] = [ORDINARY, BACKORDER_LINE],
  ) => {
    await h.seedPickup(items);
    await h.offer();
    h.api.createCheckout.mockRejectedValueOnce(error);
    return h.yes();
  };

  it.each([
    [
      'BACKORDER_RESERVATION_EXPIRED',
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
      'Se venció el apartado de su pedido BO-000012.',
    ],
    [
      'BACKORDER_NOT_RESERVED {EXPIRED}',
      refusal(409, 'BACKORDER_NOT_RESERVED', { status: 'EXPIRED' }),
      'Se venció el apartado de su pedido BO-000012.',
    ],
  ])(
    '%s: the line leaves the cart, nothing is charged, the apartado is said expired',
    async (_name, error, expected) => {
      const h = setup();
      const answer = await refuse(h, error);
      expect(answer?.reply).toContain(expected);
      expect(answer?.reply).toContain(
        'Quité esa pieza de su carrito y no se creó ningún pedido.',
      );
      // Only one attempt, never a retry; the ordinary line stays.
      expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
      const stored = await h.slot();
      expect(stored.items).toEqual([ORDINARY]);
      expect(stored.idempotencyKey).toBe('');
      expect(stored.shipping).toBeUndefined();
    },
  );

  it('expired with a known sourceDecisionId offers to schedule it again (two buttons bound to the backorder)', async () => {
    const h = setup();
    h.backorders.getBackorder.mockResolvedValue(
      reservedBackorder({
        status: 'EXPIRED',
        sourceDecisionId: BO_DECISION,
      }),
    );
    const answer = await refuse(
      h,
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
    );
    expect(answer?.reply).toContain(
      '¿Quiere que se lo agende de nuevo? Quedaría al final de la fila de espera.',
    );
    expect(answer?.interactive).toMatchObject({
      type: 'buttons',
      buttons: [
        { id: `backorder_reschedule:${BO_ID}` },
        { id: `backorder_reschedule_decline:${BO_ID}` },
      ],
    });
  });

  it('expired without a sourceDecisionId (or when the backorder cannot be read) offers nothing', async () => {
    const h = setup();
    const answer = await refuse(
      h,
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
    );
    expect(answer?.interactive).toBeUndefined();
    expect(answer?.reply).not.toContain('agende de nuevo');

    const other = setup();
    other.backorders.getBackorder.mockRejectedValue(new Error('down'));
    const failed = await refuse(
      other,
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
    );
    expect(failed?.interactive).toBeUndefined();
    expect(failed?.reply).toContain('Se venció el apartado');
  });

  it('NOT_RESERVED {CONFIRMED}: treated as already confirmed, the duplicate line leaves the cart', async () => {
    const h = setup();
    const answer = await refuse(
      h,
      refusal(409, 'BACKORDER_NOT_RESERVED', { status: 'CONFIRMED' }),
    );
    expect(answer?.reply).toContain('Ese pedido ya está confirmado');
    expect((await h.slot()).items).toEqual([ORDINARY]);
  });

  it.each([
    ['CANCELLED', 'Ese pedido apartado ya está cancelado.'],
    ['WAITING', 'Su pedido BO-000012 todavía no está apartado.'],
  ])(
    'NOT_RESERVED {%s}: honest answer and the line leaves',
    async (status, text) => {
      const h = setup();
      const answer = await refuse(
        h,
        refusal(409, 'BACKORDER_NOT_RESERVED', { status }),
      );
      expect(answer?.reply).toContain(text);
      expect((await h.slot()).items).toEqual([ORDINARY]);
    },
  );

  it('RESERVATION_LOST: apologises (lot expired, still first in line), drops the line and never retries', async () => {
    const h = setup();
    const answer = await refuse(h, refusal(409, 'BACKORDER_RESERVATION_LOST'));
    expect(answer?.reply).toContain('Lo siento');
    expect(answer?.reply).toContain('venció');
    expect(answer?.reply).toContain('Sigue primero en la fila');
    expect(answer?.interactive).toBeUndefined();
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect((await h.slot()).items).toEqual([ORDINARY]);
    // The next order summary has no backorder line and nothing resends it.
    const next = await h.offer('wamid.o3');
    expect(next.reply).not.toContain('apartado');
  });

  it('NOT_FOUND: honest answer and the line leaves', async () => {
    const h = setup();
    const answer = await refuse(h, refusal(404, 'BACKORDER_NOT_FOUND'));
    expect(answer?.reply).toContain('No encontré ese pedido apartado.');
    expect((await h.slot()).items).toEqual([ORDINARY]);
  });

  it('MISMATCH: logged with the field, honest message, the line leaves', async () => {
    const h = setup();
    const answer = await refuse(
      h,
      refusal(409, 'BACKORDER_MISMATCH', { field: 'quantity' }),
    );
    expect(answer?.reply).toContain('no coincide con la reserva');
    expect(answer?.reply).toContain('no se creó ningún pedido');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'checkout backorder refusal code=BACKORDER_MISMATCH decision=mismatch field=quantity',
      ),
    );
    expect((await h.slot()).items).toEqual([ORDINARY]);
  });

  it('INVALID_CHECKOUT_REQUEST: logged, the existing honest message, the cart is kept', async () => {
    const h = setup();
    const answer = await refuse(h, refusal(400, 'INVALID_CHECKOUT_REQUEST'));
    expect(answer?.reply).toBe(MINIMAL_ORDER_REJECTED_REPLY);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('code=INVALID_CHECKOUT_REQUEST'),
    );
    expect((await h.slot()).items).toEqual([ORDINARY, BACKORDER_LINE]);
  });

  it('RESERVATION_UNAVAILABLE: the team will call; the cart is kept', async () => {
    const h = setup();
    const answer = await refuse(
      h,
      refusal(409, 'BACKORDER_RESERVATION_UNAVAILABLE'),
    );
    expect(answer?.reply).toContain('el equipo le va a llamar');
    expect(answer?.reply).toContain('No se creó ningún pedido');
    expect((await h.slot()).items).toEqual([ORDINARY, BACKORDER_LINE]);
  });

  it('503 BACKORDER_CHECKOUT_UNAVAILABLE is an unknown outcome: the key is kept for a safe retry', async () => {
    const h = setup();
    const answer = await refuse(
      h,
      refusal(503, 'BACKORDER_CHECKOUT_UNAVAILABLE'),
    );
    expect(answer?.reply).toBe(MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY);
    expect((await h.slot()).idempotencyKey).not.toBe('');
  });

  it('PRICE_OUT_OF_DATE on the backorder line: refreshes the final price from GET :id and shows the summary again', async () => {
    const h = setup();
    h.backorders.getBackorder.mockResolvedValue(
      reservedBackorder({ finalPriceCents: 99900, currentPriceCents: 99900 }),
    );
    const answer = await refuse(
      h,
      refusal(409, 'PRICE_OUT_OF_DATE', { currentPriceCents: 99900 }),
    );
    expect(h.backorders.getBackorder).toHaveBeenCalledWith(BO_ID);
    expect(answer?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(answer?.reply).toContain('2 × $999.00 MXN; importe $1998.00 MXN');
    expect((await h.slot()).items[1].unitPriceCents).toBe(99900);

    // The next SÍ sends the refreshed price and the matching total.
    answer?.onSent?.();
    h.api.createCheckout.mockClear();
    await h.yes('wamid.o3');
    const body = sentBody(h);
    expect(body.sale.items[1]).toMatchObject({
      unitPriceCents: 99900,
      backorderId: BO_ID,
    });
    expect(body.sale.expectedTotalCents).toBe(3000 + 2 * 99900);
  });

  it('PRICE_OUT_OF_DATE on the backorder line of a DELIVERY order: re-quotes the shipping and shows the refreshed summary', async () => {
    const h = setup();
    h.backorders.getBackorder.mockResolvedValue(
      reservedBackorder({ finalPriceCents: 99900, currentPriceCents: 99900 }),
    );
    await seedDelivery(h, [ORDINARY, BACKORDER_LINE]);
    await h.offer();
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'PRICE_OUT_OF_DATE', { currentPriceCents: 99900 }),
    );
    h.quotes.enqueue(deliveryQuote('quote-2'));

    const answer = await h.yes();

    expect(answer?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(answer?.reply).not.toContain('necesito saber cómo recibirá');
    expect(answer?.reply).toContain('Resumen de su pedido:');
    expect(answer?.reply).toContain('2 × $999.00 MXN; importe $1998.00 MXN');
    expect(answer?.reply).toContain('Total a pagar: $2078.00 MXN');
    // The stored quote was pinned to the old price: one fresh quote was asked.
    expect(h.quotes.calls).toHaveLength(2);
    expect((await h.slot()).items[1].unitPriceCents).toBe(99900);

    answer?.onSent?.();
    h.api.createCheckout.mockClear();
    await h.yes('wamid.o3');
    const body = sentBody(h);
    expect(body.sale.shipping).toEqual({ quoteId: 'quote-2' });
    expect(body.sale.items[1]).toMatchObject({
      unitPriceCents: 99900,
      backorderId: BO_ID,
    });
    expect(body.sale.expectedTotalCents).toBe(3000 + 2 * 99900 + 5000);
  });

  it('PRICE_OUT_OF_DATE for a delivery order whose re-quote fails asks for the shipping again, never a stale summary', async () => {
    const h = setup();
    h.backorders.getBackorder.mockResolvedValue(
      reservedBackorder({ finalPriceCents: 99900 }),
    );
    await seedDelivery(h, [ORDINARY, BACKORDER_LINE]);
    await h.offer();
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'PRICE_OUT_OF_DATE', { currentPriceCents: 99900 }),
    );
    const answer = await h.yes(); // no second quote queued: the re-quote fails
    expect(answer?.reply).not.toContain('Resumen de su pedido:');
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('PRICE_OUT_OF_DATE with the detail but an unreadable backorder falls back to the detail', async () => {
    const h = setup();
    h.backorders.getBackorder.mockRejectedValue(new Error('down'));
    const answer = await refuse(
      h,
      refusal(409, 'PRICE_OUT_OF_DATE', { currentPriceCents: 99900 }),
    );
    expect(answer?.reply).toContain('2 × $999.00 MXN');
  });

  it("an ordinary line PRICE_OUT_OF_DATE (no detail) keeps today's handling and the backorder line", async () => {
    const h = setup();
    const answer = await refuse(h, refusal(409, 'PRICE_OUT_OF_DATE'));
    expect(answer?.reply).toBe(MINIMAL_ORDER_REJECTED_REPLY);
    expect(h.backorders.getBackorder).not.toHaveBeenCalled();
    expect((await h.slot()).items).toEqual([ORDINARY, BACKORDER_LINE]);
  });

  it('PROMO_RE_QUOTE: re-priced with the §7 formula (the backorder line stays outside the promotion)', async () => {
    const h = setup();
    await h.seedPickup([ORDINARY, BACKORDER_LINE]);
    await h.offer();
    h.setPromo(20);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'PROMO_RE_QUOTE', {
        recomputedTotalCents: 2400 + 2 * BO_FINAL_CENTS,
      }),
    );
    const answer = await h.yes();
    expect(answer?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(answer?.reply).toContain('importe $24.00 MXN');
    expect(answer?.reply).toContain(
      'importe $2198.00 MXN (pedido apartado BO-000012)',
    );
    answer?.onSent?.();
    h.api.createCheckout.mockClear();
    await h.yes('wamid.o3');
    expect(sentBody(h).sale.expectedTotalCents).toBe(2400 + 2 * BO_FINAL_CENTS);
  });

  it('with two backorder lines only the one the backend no longer honours leaves the cart', async () => {
    // The fixtures reserve until BO_UNTIL (2026-11-21); pin only Date so the
    // still-reserved line stays reserved whatever day the suite runs.
    jest.useFakeTimers({
      now: Date.parse('2026-11-20T15:00:00.000Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
        'hrtime',
        'performance',
      ],
    });
    const h = setup();
    const second = backorderCartLine({
      id: BO_ID_2,
      folio: 'BO-000013',
      productId: BO_PRODUCT,
      productName: 'Ibuprofeno',
      unitPriceCents: 1200,
    });
    h.backorders.getBackorder.mockImplementation((id: string) =>
      Promise.resolve(
        id === BO_ID
          ? reservedBackorder()
          : reservedBackorder({
              id: BO_ID_2,
              folio: 'BO-000013',
              status: 'EXPIRED',
            }),
      ),
    );
    const answer = await refuse(
      h,
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
      [BACKORDER_LINE, second],
    );
    expect(answer?.reply).toContain('BO-000013');
    expect((await h.slot()).items).toEqual([BACKORDER_LINE]);
  });
});

describe('a backorder refusal after an earlier uncertain attempt (same idempotency key)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  /** 503 first (outcome unknown, key kept), then the summary again. */
  const afterUncertain = async (h: Harness, items: Line[]) => {
    await h.seedPickup(items);
    await h.offer();
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(503, 'BACKORDER_CHECKOUT_UNAVAILABLE'),
    );
    expect((await h.yes())?.reply).toBe(MINIMAL_ORDER_AMBIGUOUS_OUTCOME_REPLY);
    expect((await h.slot()).idempotencyKey).not.toBe('');
    await h.offer('wamid.o3');
  };

  it('no sale under the key: the key is cleared and the refusal is applied (expired line dropped), not the «unresolved» hold', async () => {
    const h = setup();
    await afterUncertain(h, [ORDINARY, BACKORDER_LINE]);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
    );

    const answer = await h.yes('wamid.o4');

    expect(answer?.reply).toContain(
      'Se venció el apartado de su pedido BO-000012.',
    );
    expect(answer?.reply).not.toBe(MINIMAL_ORDER_UNRESOLVED_REPLY);
    expect(h.api.getCheckoutStatus).toHaveBeenCalled();
    const stored = await h.slot();
    expect(stored.items).toEqual([ORDINARY]);
    expect(stored.idempotencyKey).toBe('');
    // The next summary has no backorder line and sends a fresh, keyless order.
    expect((await h.offer('wamid.o5')).reply).not.toContain('apartado');
  });

  it('no sale under the key: a price refusal refreshes the line and re-shows the summary', async () => {
    const h = setup();
    h.backorders.getBackorder.mockResolvedValue(
      reservedBackorder({ finalPriceCents: 99900 }),
    );
    await afterUncertain(h, [ORDINARY, BACKORDER_LINE]);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'PRICE_OUT_OF_DATE', { currentPriceCents: 99900 }),
    );
    const answer = await h.yes('wamid.o4');
    expect(answer?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(answer?.reply).toContain('2 × $999.00 MXN');
    expect((await h.slot()).idempotencyKey).toBe('');
  });

  it('a sale already exists under the key: treated as placed, the line is not dropped', async () => {
    const h = setup();
    await afterUncertain(h, [ORDINARY, BACKORDER_LINE]);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'BACKORDER_NOT_RESERVED', { status: 'CONFIRMED' }),
    );
    // consume's own recovery read sees nothing; the read after the refusal finds the sale.
    h.api.getCheckoutStatus
      .mockResolvedValueOnce({ status: 'not_observed', checkout: null })
      .mockResolvedValueOnce({
        status: 'succeeded',
        checkout: { sale: placedSale() },
      } as never);
    const answer = await h.yes('wamid.o4');
    expect(answer?.reply).toContain('¡Listo!');
    expect(answer?.reply).toContain('B-0042');
    expect((await h.slot()).items).toEqual([]);
  });

  it('the key status cannot be read: the hold stays and the line is kept', async () => {
    const h = setup();
    await afterUncertain(h, [ORDINARY, BACKORDER_LINE]);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'BACKORDER_RESERVATION_EXPIRED'),
    );
    h.api.getCheckoutStatus
      .mockResolvedValueOnce({ status: 'not_observed', checkout: null })
      .mockRejectedValueOnce(new Error('down'));
    const answer = await h.yes('wamid.o4');
    expect(answer?.reply).toBe(MINIMAL_ORDER_UNRESOLVED_REPLY);
    expect((await h.slot()).items).toEqual([ORDINARY, BACKORDER_LINE]);
  });

  it("an ORDINARY-cart rejection after an uncertain attempt keeps today's hold (no status read for it)", async () => {
    const h = setup();
    await afterUncertain(h, [ORDINARY]);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'PRICE_OUT_OF_DATE'),
    );
    const before = h.api.getCheckoutStatus.mock.calls.length;
    const answer = await h.yes('wamid.o4');
    expect(answer?.reply).toBe(MINIMAL_ORDER_UNRESOLVED_REPLY);
    // Only consume's own recovery read, none added by the send path.
    expect(h.api.getCheckoutStatus.mock.calls.length - before).toBe(1);
  });
});

describe('a cart without backorder lines is unchanged (previous behaviour)', () => {
  it("sends today's body (no backorderId key) and today's summary", async () => {
    const h = setup();
    await h.seedPickup([ORDINARY]);

    const offer = await h.offer();
    expect(offer.reply).toBe(
      [
        'Resumen de su pedido:',
        '• Ibuprofeno: 2 × $15.00 MXN; importe $30.00 MXN',
        'Total de productos: $30.00 MXN',
        'Datos del cliente: Ana',
        'Recoge en tienda (sin costo de envío)',
        'Total a pagar: $30.00 MXN',
        '',
        'Responda "SÍ" para crear el pedido, o dígame qué quiere cambiar.',
      ].join('\n'),
    );
    await h.yes();
    expect(JSON.stringify(sentBody(h))).toBe(
      JSON.stringify({
        phoneCountryCode: '52',
        phone: '5550001111',
        customer: { mode: 'existing', customerId: CUSTOMER },
        sale: {
          cashierUserId: CASHIER,
          items: [
            {
              productId: BO_PRODUCT,
              variantId: null,
              productName: 'Ibuprofeno',
              variantName: null,
              quantity: 2,
              unitPriceCents: 1500,
            },
          ],
          expectedTotalCents: 3000,
          shipping: { mode: 'pickup' },
        },
      }),
    );
    // No backorder was read for an ordinary order.
    expect(h.backorders.getBackorder).not.toHaveBeenCalled();
  });

  it('PROMO_RE_QUOTE of an ordinary cart still re-presents the new total', async () => {
    const h = setup();
    await h.seedPickup([ORDINARY]);
    await h.offer();
    h.setPromo(50);
    h.api.createCheckout.mockRejectedValueOnce(
      refusal(409, 'PROMO_RE_QUOTE', { recomputedTotalCents: 1500 }),
    );
    const answer = await h.yes();
    expect(answer?.reply).toContain(MINIMAL_ORDER_CHANGED_REPLY);
    expect(answer?.reply).toContain('Total a pagar: $15.00 MXN');
  });
});

describe('the pending summary of a backorder order survives a restart', () => {
  const EVENT_ID = EVENT('wamid.offer');
  it('the durable gate keeps the backorder line (and its marker) through a new process', async () => {
    const T0 = Date.parse('2026-11-20T15:00:00.000Z');
    const store = new InMemoryConversationGateStore(() => new Date(T0));
    const boot = () => {
      const gates = new ConversationGates(store, () => T0);
      return { gates, order: new DurableOrderConfirmation(gates) };
    };
    const verdict = evaluateMinimalPickupOrder({
      quote: {
        items: [
          {
            productId: BO_CROQUETAS,
            name: 'Croquetas Adulto 18 kg',
            quantity: 2,
            unitPriceCents: BO_FINAL_CENTS,
            finalPriceCents: 2 * BO_FINAL_CENTS,
            appliedPromotionTitle: null,
            discountAmountCents: 0,
            backorder: backorderCartLine().backorder,
          },
        ],
        totalCents: 2 * BO_FINAL_CENTS,
        promotionEvaluationStatus: 'fully_evaluated',
      },
      customerId: '',
      customer: { firstName: 'Ana', lastName: null },
    });
    if (!verdict.ok) throw new Error('eligible');
    const first = boot();
    const offered = first.order.prepare({
      senderId: BO_SENDER,
      inboundEvent: EVENT_ID,
      snapshot: verdict.snapshot,
    });
    if (offered.kind !== 'offer') throw new Error('offer');
    offered.onSent();
    await first.gates.settle(BO_SENDER);

    const restarted = boot();
    await restarted.gates.begin(BO_SENDER);
    const consumed = await restarted.order.consume({
      senderId: BO_SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.yes'),
    });
    expect(consumed).toMatchObject({ kind: 'candidate' });
    const { snapshot } = consumed as { snapshot: typeof verdict.snapshot };
    expect(snapshot.items[0].backorder?.id).toBe(BO_ID);
    expect(sameMinimalOrder(snapshot, verdict.snapshot)).toBe(true);
    // A summary of the same line WITHOUT the backorder is a different order.
    const { backorder: _drop, ...ordinary } = snapshot.items[0];
    void _drop;
    expect(sameMinimalOrder(snapshot, { ...snapshot, items: [ordinary] })).toBe(
      false,
    );
    expect(renderMinimalOrderSummary(snapshot)).toContain(
      '(pedido apartado BO-000012)',
    );
  });
});

describe('backorderLineDecision (the single §7 mapping)', () => {
  const failure = (code: string, extra: object = {}) =>
    ({ code, status: 409, ...extra }) as never;
  it.each([
    [
      failure('BACKORDER_RESERVATION_EXPIRED'),
      { kind: 'drop', why: 'expired' },
    ],
    [
      failure('BACKORDER_NOT_RESERVED', { backorderStatus: 'EXPIRED' }),
      { kind: 'drop', why: 'expired' },
    ],
    [
      failure('BACKORDER_NOT_RESERVED', { backorderStatus: 'CONFIRMED' }),
      { kind: 'drop', why: 'confirmed' },
    ],
    [
      failure('BACKORDER_NOT_RESERVED', { backorderStatus: 'CANCELLED' }),
      { kind: 'drop', why: 'cancelled' },
    ],
    [
      failure('BACKORDER_NOT_RESERVED', { backorderStatus: 'WAITING' }),
      { kind: 'drop', why: 'waiting' },
    ],
    [
      failure('BACKORDER_NOT_RESERVED', { backorderStatus: null }),
      { kind: 'drop', why: 'unknown' },
    ],
    [failure('BACKORDER_RESERVATION_LOST'), { kind: 'drop', why: 'lost' }],
    [failure('BACKORDER_NOT_FOUND'), { kind: 'drop', why: 'not_found' }],
    [
      failure('BACKORDER_MISMATCH', { field: 'quantity' }),
      { kind: 'mismatch', field: 'quantity' },
    ],
    [failure('BACKORDER_RESERVATION_UNAVAILABLE'), { kind: 'unavailable' }],
    [
      failure('PRICE_OUT_OF_DATE', { currentPriceCents: 99900 }),
      { kind: 'reprice', currentPriceCents: 99900 },
    ],
    // Not decisions of this mapping: the existing handling answers.
    [failure('PRICE_OUT_OF_DATE', { currentPriceCents: null }), null],
    [failure('INVALID_CHECKOUT_REQUEST'), null],
    [failure('BACKORDER_CHECKOUT_UNAVAILABLE'), null],
  ])('%j → %j', (input, expected) => {
    expect(backorderLineDecision(input)).toEqual(expected);
  });
});
