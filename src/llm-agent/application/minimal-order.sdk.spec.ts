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

function setup(options: { order?: 'on' | 'off' | 'absent' } = {}) {
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
            interiorNumber: null,
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
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: (key: string) => {
      if (key === 'minimalCatalogAgent')
        return {
          enabled: true,
          allowedSenders: [SENDER],
          orderEnabled: mode === 'on',
        };
      if (key === 'chatbotApi.cashierUserId') return CASHIER;
      return { model: 'm', maxSteps: 5, historyTurns: 12 };
    },
  } as unknown as ConfigService;
  let steps: unknown[] = [];
  const seen: Array<{ tools?: Record<string, unknown> }> = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: steps } as never),
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
    seen,
    checkout,
    turn: (text: string, script: unknown[], event?: unknown) => {
      steps = script;
      return agent.tryHandle({
        senderId: SENDER,
        text,
        ...(event === undefined ? {} : { inboundEvent: event }),
      });
    },
    ready: async () => {
      await store.create(SENDER, {
        lastMessageAt: '2026-10-10T00:00:00.000Z',
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

describe('minimal order placement through the SDK route', () => {
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
});
