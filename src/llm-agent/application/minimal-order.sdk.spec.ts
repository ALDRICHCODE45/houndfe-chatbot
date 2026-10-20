import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';

const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const EVENT = (messageId: string) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
});

const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (name: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${name}-${Math.random()}`,
      toolName: name,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Listo.') => step([{ type: 'text', text }], 'stop');

function setup(
  options: {
    order?: 'on' | 'off' | 'absent';
    shipping?: boolean;
    atomic?: boolean;
  } = {},
) {
  const mode = options.order ?? 'on';
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
    getCustomerCheckoutContext: jest.fn(() =>
      Promise.resolve({
        status: 'unique',
        customer: { customerId: CUSTOMER, firstName: 'Ana', lastName: null },
        addresses: [
          {
            id: ADDRESS,
            version: '2026-10-01T00:00:00.000Z',
            label: 'Casa',
            street: 'Av. Juárez',
            exteriorNumber: '10',
            interiorNumber: null as string | null,
            zipCode: '06000',
            neighborhood: 'Centro',
            municipality: 'Cuauhtémoc',
            city: null,
            state: 'Ciudad de México',
            visualReferences: null,
            carrierPhone: null,
          },
        ],
        nextAfterAddressId: null,
      }),
    ),
    createSale: jest.fn(() =>
      Promise.resolve({
        saleId: '55555555-5555-4555-8555-555555555555',
        folio: 'B-0042',
        paymentStatus: 'CREDIT',
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        totalCents: 3000,
        paidCents: 0,
        debtCents: 3000,
        confirmedAt: null,
        discountCents: 0,
      }),
    ),
    createCheckout: jest.fn(),
    getPaymentDetails: jest.fn(() =>
      Promise.resolve({
        id: 'pd',
        bankName: 'BBVA',
        beneficiary: 'HoundFe SA de CV',
        clabe: '012180001234567891',
        accountNumber: '0123456789',
        isActive: true,
        updatedAt: '2026-10-01T00:00:00.000Z',
      }),
    ),
    upsertCustomer: jest.fn(),
  };
  api.createCheckout.mockImplementation(async () => ({
    status: 'created',
    sale: await api.createSale.getMockImplementation()!(),
  }));
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) => {
      if (key === 'minimalCatalogAgent')
        return {
          enabled: true,
          allowedSenders: [SENDER],
          orderEnabled: mode === 'on',
          shippingEnabled: options.shipping === true,
          atomicCheckoutEnabled: options.atomic === true,
        };
      if (key === 'chatbotApi.cashierUserId') return CASHIER;
      return { model: 'm', maxSteps: 5, historyTurns: 12 };
    },
  } as unknown as ConfigService;
  let steps: unknown[] = [];
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
  let gate: Promise<void> | null = null;
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = steps;
    if (gate !== null) await gate;
    let index = 0;
    return generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          const next = script[index++];
          return (
            typeof next === 'function' ? (next as () => unknown)() : next
          ) as Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
        },
      }),
    });
  };
  const cart = new MinimalCartService(client, store);
  const checkout = new MinimalCheckoutService(client, store);
  const order = new MinimalOrderService(client, store, cart, checkout, config);
  const agent = new MinimalCatalogAgentService(
    client,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cart,
    checkout,
    mode === 'absent' ? undefined : order,
  );
  return {
    api,
    store,
    seen,
    checkout,
    seedCart: () =>
      store.create(SENDER, {
        lastMessageAt: new Date().toISOString(),
        data: {
          minimalCart: {
            items: [{ productId: PRODUCT, quantity: 1, unitPriceCents: 1500 }],
            idempotencyKey: '',
            expectedTotalCents: 1500,
          },
        },
      }),
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    turn: (text: string, script: unknown[], event?: unknown) => {
      steps = script;
      return agent.tryHandle({
        senderId: SENDER,
        text,
        ...(event === undefined ? {} : { inboundEvent: event }),
      });
    },
    ready: async (newCustomer = false) => {
      await store.create(SENDER, {
        lastMessageAt: '2026-10-10T00:00:00.000Z',
        data: {
          minimalCart: {
            items: [{ productId: PRODUCT, quantity: 2, unitPriceCents: 1500 }],
            idempotencyKey: '',
            expectedTotalCents: 3000,
            ...(options.shipping
              ? {
                  shipping: {
                    quoteId: 'quote-1',
                    rateId: 'rate-1',
                    carrierName: 'Carrier',
                    serviceName: 'Ground',
                    estimatedDeliveryDays: 2,
                    bestRateCents: 5000,
                    totalCreditCents: 0,
                    customerPaysCents: 5000,
                    cartLines: [
                      {
                        productId: PRODUCT,
                        quantity: 2,
                        unitPriceCents: 1500,
                        finalPriceCents: 3000,
                      },
                    ],
                    addressId: ADDRESS,
                    addressVersion: '2026-10-01T00:00:00.000Z',
                    createdAt: new Date(Date.now() - 1000).toISOString(),
                    expiresAt: new Date(Date.now() + 60000).toISOString(),
                    approval: {
                      state: 'approved',
                      requestId: 'approval-1',
                      decidedAt: new Date().toISOString(),
                    },
                  },
                }
              : {}),
          },
        },
      });
      if (newCustomer) {
        await checkout.updateDetails(SENDER, {
          firstName: 'Ana',
          lastName: null,
          useNewAddress: true,
          label: null,
          street: 'Calle 5',
          exteriorNumber: 'S/N',
          interiorNumber: null,
          zipCode: '06700',
          neighborhood: 'Roma',
          municipality: null,
          city: 'CDMX',
          state: 'CDMX',
          visualReferences: null,
          carrierPhone: null,
        });
      } else {
        const lookup = await checkout.lookup(SENDER, null);
        if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
        await checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
      }
      const offer = await checkout.prepareConfirmation(
        SENDER,
        EVENT('wamid.d1'),
      );
      offer.onSent?.();
      await checkout.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('wamid.d2'),
      });
    },
  };
}

describe('checkout next-step guidance through the SDK route', () => {
  const deliveryEnding =
    'Responda "SÍ" para confirmar estos datos, o dígame qué quiere cambiar.';
  const orderEnding =
    'Responda "SÍ" para crear el pedido, o dígame qué quiere cambiar.';

  it('lookup → select → prepareOrder presents delivery in the same turn, then needs two separate sent-summary consents for one sale', async () => {
    const h = setup();
    await h.seedCart();
    const context = await h.api.getCustomerCheckoutContext();
    context.addresses[0].interiorNumber = '130';
    h.api.getCustomerCheckoutContext.mockResolvedValue(context);
    h.api.createSale.mockResolvedValue({
      ...(await h.api.createSale.getMockImplementation()!()),
      totalCents: 1500,
      debtCents: 1500,
    });
    let addressRef = '';
    const lookup = h.checkout.lookup.bind(h.checkout);
    jest.spyOn(h.checkout, 'lookup').mockImplementation(async (...args) => {
      const result = await lookup(...args);
      if (result.ok && result.status === 'unique')
        addressRef = result.addresses[0].addressRef;
      return result;
    });
    const delivery = await h.turn(
      'quiero realizar el pedido por favor.',
      [
        call('lookupCheckoutCustomer', { nextPageRef: null }),
        () => call('selectCheckoutAddress', { addressRef }),
        call('prepareOrder'),
        call('confirmCheckoutDetails'),
        say('Datos inventados'),
      ],
      EVENT('delivery-offer'),
    );
    const reply = (delivery as { reply: string }).reply;
    expect(reply).toMatch(/^Confirme sus datos de entrega:/);
    expect(reply).toContain('Calle: Av. Juárez 10, int. 130');
    expect(reply.endsWith(deliveryEnding)).toBe(true);
    expect(reply).toContain('no crea un pedido');
    expect(reply).not.toContain('Antes de crear el pedido necesito');
    expect(reply).not.toContain('Datos inventados');
    expect(h.api.createSale).not.toHaveBeenCalled();
    expect(h.checkout.confirmationStatus(SENDER)).toMatchObject({
      armed: false,
    });
    (delivery as { onSent: () => void }).onSent();
    const calls = h.seen.length;
    const confirmed = await h.turn('SÍ', [say()], EVENT('delivery-yes'));
    expect(h.seen).toHaveLength(calls);
    expect((confirmed as { reply: string }).reply).toContain(
      'Para continuar, dígame «hacer pedido» y le mostraré el resumen con el total.',
    );
    expect(h.api.createSale).not.toHaveBeenCalled();
    const order = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      EVENT('order-offer'),
    );
    expect((order as { reply: string }).reply.endsWith(orderEnding)).toBe(true);
    (order as { onSent: () => void }).onSent();
    await h.turn('SÍ', [say()], EVENT('order-yes'));
    await h.turn('SÍ', [say()], EVENT('repeat-yes'));
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'fallback delivery still requires sent-summary strict consent (sent: %s)',
    async (sent) => {
      const h = setup();
      await h.ready();
      const draft = await h.checkout.confirmedDraft(SENDER);
      if (draft === null) throw new Error('expected confirmed fixture');
      await h.store.commitMinimalCheckoutDraft(
        SENDER,
        draft,
        {
          ...draft,
          revision: draft.revision + 1,
          customer: { ...draft.customer, firstName: 'Ana María' },
        },
        new Date().toISOString(),
      );
      const offer = await h.turn(
        'hacer pedido',
        [call('prepareOrder'), say()],
        EVENT('fallback-offer'),
      );
      expect((offer as { reply: string }).reply).toMatch(
        /^Confirme sus datos de entrega:/,
      );
      if (sent) (offer as { onSent: () => void }).onSent();
      await h.turn(
        sent ? 'Sí, pero cambie la calle' : 'SÍ',
        [say('¿Qué calle desea usar?')],
        EVENT('fallback-answer'),
      );
      expect(await h.checkout.confirmedDraft(SENDER)).toBeNull();
      expect(h.api.createSale).not.toHaveBeenCalled();
    },
  );

  it('prepareOrder with an incomplete draft lists the missing fields', async () => {
    const h = setup();
    await h.seedCart();
    await h.checkout.updateDetails(SENDER, {
      firstName: 'Ana',
      lastName: null,
      useNewAddress: true,
      label: null,
      street: 'Calle 5',
      exteriorNumber: null,
      interiorNumber: null,
      zipCode: null,
      neighborhood: null,
      municipality: null,
      city: null,
      state: null,
      visualReferences: null,
      carrierPhone: null,
    });
    const result = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      EVENT('partial'),
    );
    expect(result).toEqual({
      kind: 'handled',
      reply:
        'Para mostrarle el resumen de entrega aún me falta: número exterior o S/N, colonia, código postal, estado, ciudad o municipio.',
    });
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('prepareOrder without an address gives a concrete starting instruction', async () => {
    const h = setup();
    await h.seedCart();
    const result = await h.turn(
      'hacer pedido',
      [call('prepareOrder'), say()],
      EVENT('absent'),
    );
    expect(result).toEqual({
      kind: 'handled',
      reply:
        'Para crear su pedido primero necesito su dirección de entrega. Dígame «quiero comprar» para ver sus direcciones guardadas o escríbame una dirección nueva.',
    });
    expect(result).not.toHaveProperty('onSent');
  });

  it.each([false, true])(
    'drops reviewCheckout when a delivery presentation is produced (review last: %s)',
    async (reviewLast) => {
      const h = setup();
      await h.ready();
      const confirm = call('confirmCheckoutDetails');
      const review = call('reviewCheckout');
      const result = await h.turn(
        'confirmar datos',
        reviewLast ? [confirm, review, say()] : [review, confirm, say()],
        EVENT('review-delivery'),
      );
      expect((result as { reply: string }).reply).toMatch(
        /^Confirme sus datos de entrega:/,
      );
      expect((result as { reply: string }).reply).not.toContain(
        'Revisión de compra',
      );
      expect(result).toHaveProperty('onSent');
    },
  );

  it('drops reviewCheckout when an order summary is produced', async () => {
    const h = setup();
    await h.ready();
    const result = await h.turn(
      'hacer pedido',
      [call('reviewCheckout'), call('prepareOrder'), say()],
      EVENT('review-order'),
    );
    expect((result as { reply: string }).reply).toMatch(
      /^Resumen de su pedido:/,
    );
    expect((result as { reply: string }).reply).not.toContain(
      'Revisión de compra',
    );
  });

  it('guides same-response delivery confirmation and prohibits review during checkout', async () => {
    const h = setup();
    await h.turn('Hola', [say()]);
    expect(h.seen[0].system).toContain('Después de selectCheckoutAddress ok');
    expect(h.seen[0].system).toContain('en la MISMA respuesta');
    expect(h.seen[0].system).toContain('Nunca llame reviewCheckout mientras');
  });
});

describe('minimal order placement through the SDK route', () => {
  it('S2/S3/S6 new customer order needs armed one-shot summary consent', async () => {
    const h = setup({ atomic: true });
    await h.ready(true);
    const offer = await h.turn(
      'Hacer pedido',
      [call('prepareOrder'), say('Inventado')],
      EVENT('new-order'),
    );
    expect((offer as { reply: string }).reply).toContain(
      'Guardaremos esta dirección con su pedido.',
    );
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    (offer as { onSent: () => void }).onSent();
    const calls = h.seen.length;
    const placed = await h.turn('SÍ', [say('Inventado')], EVENT('new-yes'));
    expect(h.seen).toHaveLength(calls);
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({
      customer: { mode: 'createIfAbsent', firstName: 'Ana' },
      deliveryAddress: {
        mode: 'newSaved',
        address: { street: 'Calle 5', state: 'Ciudad de México' },
      },
    });
    expect((placed as { reply: string }).reply).toContain('folio B-0042');
    expect((placed as { reply: string }).reply).toContain('CLABE');
    expect(h.api.upsertCustomer).not.toHaveBeenCalled();
    expect(h.api.createSale).not.toHaveBeenCalled();
    await h.turn('SÍ', [say()], EVENT('duplicate-yes'));
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
  it('atomic S2/S3/S4: armed summary consent creates checkout, not legacy sale', async () => {
    const h = setup({ atomic: true, shipping: true });
    await h.ready();
    const offer = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say('Pedido creado inventado')],
      EVENT('wamid.atomic1'),
    );
    expect((offer as { reply: string }).reply).toContain(
      'Total a pagar: $80.00 MXN',
    );
    expect(h.api.createCheckout).not.toHaveBeenCalled();
    (offer as { onSent: () => void }).onSent();
    const calls = h.seen.length;
    const placed = await h.turn(
      'SÍ',
      [say('inventado')],
      EVENT('wamid.atomic2'),
    );
    expect(h.seen).toHaveLength(calls);
    expect(h.api.createSale).not.toHaveBeenCalled();
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createCheckout.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({
      phoneCountryCode: '52',
      phone: '5550001111',
      customer: { mode: 'existing', customerId: CUSTOMER },
      deliveryAddress: {
        mode: 'existing',
        addressId: ADDRESS,
        expectedVersion: '2026-10-01T00:00:00.000Z',
      },
      sale: { expectedTotalCents: 8000, shipping: { chargeCents: 5000 } },
    });
    expect((placed as { reply: string }).reply).toContain('folio B-0042');
    expect((placed as { reply: string }).reply).toContain('CLABE');
    await h.turn('SÍ', [say()], EVENT('wamid.atomic3'));
    expect(h.api.createCheckout).toHaveBeenCalledTimes(1);
  });
  it('S1/S4: prepareOrder plus one SÍ creates the approved charged order', async () => {
    const h = setup({ shipping: true });
    await h.ready();
    const offer = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say('inventado')],
      EVENT('wamid.o1'),
    );
    expect((offer as { reply: string }).reply).toContain(
      'Total a pagar: $80.00 MXN',
    );
    expect(h.api.createSale).not.toHaveBeenCalled();
    (offer as { onSent: () => void }).onSent();
    const seen = h.seen.length;
    const result = await h.turn('SÍ', [say()], EVENT('wamid.o2'));
    expect(h.seen).toHaveLength(seen);
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    expect(
      (h.api.createSale.mock.calls[0] as unknown as [unknown])[0],
    ).toMatchObject({
      expectedTotalCents: 8000,
      shipping: {
        chargeCents: 5000,
        approvalId: 'approval-1',
        quoteId: 'quote-1',
      },
    });
    expect((result as { reply: string }).reply).not.toContain(
      'no está incluido',
    );
  });
  it.each([
    ['on', true],
    ['off', false],
    ['absent', false],
  ] as const)(
    'exposes prepareOrder only when the order gate is %s',
    async (order, exposed) => {
      const h = setup({ order });
      await h.turn('Hola', [say()]);
      expect(Object.keys(h.seen[0].tools ?? {}).includes('prepareOrder')).toBe(
        exposed,
      );
    },
  );

  it('replies with the server-owned summary and creates the sale only on a later SÍ', async () => {
    const h = setup();
    await h.ready();
    const offer = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say('Su pedido ya quedó creado.')],
      EVENT('wamid.o1'),
    );
    expect(offer).toMatchObject({ kind: 'handled' });
    const reply = (offer as { reply: string }).reply;
    expect(reply).toContain('Resumen de su pedido:');
    expect(reply).not.toContain('Su pedido ya quedó creado.');
    expect(h.api.createSale).not.toHaveBeenCalled();
    (offer as { onSent: () => void }).onSent();

    const calls = h.seen.length;
    const placed = await h.turn(
      'SÍ',
      [say('no debería usarse')],
      EVENT('wamid.o2'),
    );
    expect(h.seen.length).toBe(calls);
    expect(h.api.createSale).toHaveBeenCalledTimes(1);
    expect((placed as { reply: string }).reply).toContain('folio B-0042');
    expect(h.api.upsertCustomer).not.toHaveBeenCalled();
  });

  it('lets a mixed answer reach the model without creating a sale', async () => {
    const h = setup();
    await h.ready();
    const offer = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say()],
      EVENT('wamid.o1'),
    );
    (offer as { onSent: () => void }).onSent();
    expect(
      await h.turn(
        'Sí, pero quite uno',
        [say('¿Cuántas unidades desea?')],
        EVENT('wamid.o2'),
      ),
    ).toEqual({ kind: 'handled', reply: '¿Cuántas unidades desea?' });
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('never sells the earlier summary on a later SÍ meant for the model', async () => {
    const h = setup();
    await h.ready();
    const offer = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say()],
      EVENT('wamid.o1'),
    );
    (offer as { onSent: () => void }).onSent();
    await h.turn(
      'Sí, pero quite uno',
      [say('¿Desea que quite una unidad?')],
      EVENT('wamid.o2'),
    );
    const calls = h.seen.length;
    expect(
      await h.turn('Sí', [say('Listo, ¿algo más?')], EVENT('wamid.o3')),
    ).toEqual({ kind: 'handled', reply: 'Listo, ¿algo más?' });
    expect(h.seen.length).toBe(calls + 1);
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('drops a pending order when a delivery confirmation answers the turn', async () => {
    const h = setup();
    await h.ready();
    const offer = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder'), say()],
      EVENT('wamid.o1'),
    );
    (offer as { onSent: () => void }).onSent();
    const delivery = await h.checkout.prepareConfirmation(
      SENDER,
      EVENT('wamid.d3'),
    );
    delivery.onSent?.();
    await h.turn('SÍ', [say('no debería usarse')], EVENT('wamid.d4'));
    await h.turn('SÍ', [say('¿En qué más le ayudo?')], EVENT('wamid.o4'));
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('fails closed when the model sends arguments to prepareOrder', async () => {
    const h = setup();
    await h.ready();
    const result = await h.turn(
      'Quiero hacer mi pedido',
      [call('prepareOrder', { total: 1 }), say('Pedido creado.')],
      EVENT('wamid.o1'),
    );
    expect((result as { reply: string }).reply).not.toContain('Pedido creado');
    expect(result).not.toHaveProperty('onSent');
    expect(h.api.createSale).not.toHaveBeenCalled();
  });

  it('a busy-rejected turn cancels the summary of the run it interrupted', async () => {
    const h = setup();
    await h.ready();
    const release = h.hold();
    // Same script for both turns: the busy one returns before the model runs.
    const script = [call('prepareOrder'), say()];
    const running = h.turn('Quiero hacer mi pedido', script, EVENT('wamid.o1'));
    const busy = await h.turn('Mejor espere', script, EVENT('wamid.b1'));
    expect(busy).toMatchObject({ kind: 'handled' });
    release();
    const offer = await running;
    expect((offer as { reply: string }).reply).toContain(
      'Resumen de su pedido:',
    );
    (offer as { onSent?: () => void }).onSent?.();
    await h.turn('SÍ', [say('¿En qué le ayudo?')], EVENT('wamid.o2'));
    expect(h.api.createSale).not.toHaveBeenCalled();
  });
});
