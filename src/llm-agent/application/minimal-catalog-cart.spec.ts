import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCartService } from './minimal-cart.service';
import { CostGuardService } from './cost-guard.service';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';

const ID = '11111111-1111-4111-8111-111111111111';
const SENDER = '5215550001111';
const step = (content: unknown[], finish: string) => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (name: string, input: unknown) =>
  step(
    [
      {
        type: 'tool-call',
        toolCallId: name,
        toolName: name,
        input: JSON.stringify(input),
      },
    ],
    'tool-calls',
  );
const say = () =>
  step([{ type: 'text', text: 'Invented sale created and paid' }], 'stop');
function setup() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn().mockResolvedValue([
      {
        productId: ID,
        name: 'Product',
        price: { priceCents: 1200 },
        variants: [],
      },
    ]),
    getStock: jest.fn().mockResolvedValue({
      productId: ID,
      name: 'Product',
      stock: { status: 'available', quantity: 10 },
      variants: [],
    }),
    evaluateCart: jest.fn().mockResolvedValue({
      items: [
        {
          productId: ID,
          variantId: null,
          quantity: 2,
          unitPriceCents: 1200,
          originalPriceCents: 2400,
          finalPriceCents: 2400,
          discountAmountCents: 0,
          appliedPromotionTitle: null,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    }),
    createSale: jest.fn(),
    getPaymentDetails: jest.fn(),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: (key: string) =>
      key === 'minimalCatalogAgent'
        ? { enabled: true, allowedSenders: [SENDER] }
        : { model: 'm', maxSteps: 4, historyTurns: 12 },
  } as unknown as ConfigService;
  const cart = new MinimalCartService(api, store);
  let steps: unknown[] = [];
  const optionsSeen: Array<{
    system?: unknown;
    tools?: Record<string, unknown>;
  }> = [];
  const generate: GenerateTextFn = async (options) => {
    optionsSeen.push(options);
    return generateText({
      ...options,
      model: new MockLanguageModelV4({ doGenerate: steps } as never),
    });
  };
  const createAgent = () =>
    new MinimalCatalogAgentService(
      api,
      generate,
      new CostGuardService(100000),
      config,
      new InMemoryMinimalCatalogSessionStore(),
      undefined,
      undefined,
      cart,
    );
  return {
    store,
    api,
    optionsSeen,
    createAgent,
    steps: (value: unknown[]) => {
      steps = value;
    },
  };
}

describe('Minimal cart through the public SDK route', () => {
  it('searches and adds via real SDK tools, restores cart with a fresh agent and never calls checkout', async () => {
    const f = setup();
    f.steps([
      call('searchCatalog', { q: 'Product' }),
      call('setCartItem', { productId: ID, quantity: 2 }),
      say(),
    ]);
    const first = await f.createAgent().tryHandle({
      senderId: SENDER,
      text: 'Agregue dos productos al carrito',
    });
    expect(first).toEqual({
      kind: 'handled',
      reply:
        'Su carrito:\n• Product: 2 × $12.00 MXN; importe $24.00 MXN\nTotal de productos: $24.00 MXN.\nNo incluye envío y no reserva existencias. Todavía no se ha creado un pedido.',
    });
    f.steps([call('getCart', {}), say()]);
    expect(
      await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: '¿Qué tengo en mi carrito?' }),
    ).toEqual(first);
    expect(f.api.createSale).not.toHaveBeenCalled();
    expect(f.api.getPaymentDetails).not.toHaveBeenCalled();
    expect(f.optionsSeen[0].system).toContain('cantidad TOTAL');
    expect(Object.keys(f.optionsSeen[0].tools ?? {})).not.toContain(
      'createSale',
    );
  });

  it('overrides a model success claim after failed persistence without reactivating legacy', async () => {
    const f = setup();
    jest.spyOn(f.store, 'commitMinimalCart').mockResolvedValue(false);
    f.steps([
      call('searchCatalog', { q: 'Product' }),
      call('setCartItem', { productId: ID, quantity: 2 }),
      say(),
    ]);
    expect(
      await f
        .createAgent()
        .tryHandle({ senderId: SENDER, text: 'Agregue dos' }),
    ).toEqual({
      kind: 'handled',
      reply:
        'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.',
    });
    expect(await f.store.get(SENDER)).toBeNull();
  });
});
