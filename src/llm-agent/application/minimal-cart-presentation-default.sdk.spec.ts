import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  toCatalogItem,
  toStockCheck,
  type FixtureProduct,
} from '../../../scripts/eval/fixtures/catalog';
import type { CustomerReplyInteractive } from '../domain/customer-reply';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { CART_DEFAULT_UNIT_NOTE } from './minimal-cart-conversation';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * Retest 2026-11-18 S5 (N14): picking a presentation without a count
 * («quiero el de 2 kg» after the Nupec options, «la de 7 piezas») adds ONE
 * unit and says so, then shows the cart summary with its next-step buttons.
 * A number that is part of the presentation is never the quantity; explicit
 * counts keep working.
 */
const SENDER = '5215550001111';
const NUPEC = 'a0000000-0000-4000-8000-000000000101';
const DENTAL = 'a0000000-0000-4000-8000-000000000102';
const variantId = (product: string, n: number) =>
  `b0000000-0000-4000-8000-000000${product.slice(-3)}${String(n).padStart(3, '0')}`;
const NUPEC_2KG = variantId(NUPEC, 1);
const NUPEC_8KG = variantId(NUPEC, 2);
const DENTAL_7 = variantId(DENTAL, 1);

const variantsOf = (
  productId: string,
  option: string,
  list: Array<[string, number]>,
) =>
  list.map(([value, priceCents], index) => ({
    variantId: variantId(productId, index + 1),
    option,
    value,
    priceCents,
    status: 'available' as const,
    quantity: 10,
  }));
const PRODUCTS: FixtureProduct[] = [
  {
    productId: NUPEC,
    name: 'Croquetas Nupec Adulto Raza Pequeña',
    brand: 'Nupec',
    description: 'Alimento seco para perro adulto de raza pequeña.',
    priceCents: null,
    status: 'available',
    quantity: 30,
    variants: variantsOf(NUPEC, 'Peso', [
      ['2 kg', 34900],
      ['8 kg', 99900],
      ['20 kg', 189900],
    ]),
  },
  {
    productId: DENTAL,
    name: 'Premios Dentales para Perro',
    brand: null,
    description: 'Premios para la limpieza dental.',
    priceCents: null,
    status: 'available',
    quantity: 20,
    variants: variantsOf(DENTAL, 'Contenido', [
      ['7 piezas', 12900],
      ['14 piezas', 22900],
    ]),
  },
];
const unitPrice = (productId: string, variant?: string | null): number =>
  PRODUCTS.find((product) => product.productId === productId)?.variants.find(
    (candidate) => candidate.variantId === variant,
  )?.priceCents ?? 0;

const registry = new MinimalCartSelections(SENDER);
const ref = (productId: string, variant?: string): string => {
  const reference = registry.register({
    productId,
    productName: 'Fixture',
    ...(variant === undefined
      ? {}
      : { variantId: variant, variantName: 'Fixture variant' }),
  });
  if (reference === null) throw new Error('fixture ref');
  return reference;
};

const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (toolName: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${toolName}-${Math.random()}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Listo.') => step([{ type: 'text', text }], 'stop');
const adjust = (
  selectionRef: string,
  delta: number | null,
  quantityText: string | null = null,
) =>
  call('adjustCartItem', {
    selectionRef,
    delta,
    quantityText,
    continuation: false,
  });
const setItem = (selectionRef: string, quantity: number | null) =>
  call('setCartItem', {
    selectionRef,
    quantity,
    quantityText: null,
    continuation: false,
  });

function harness() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async (q: string) =>
      PRODUCTS.filter((product) =>
        q.toLowerCase().includes('nupec')
          ? product.productId === NUPEC
          : product.productId === DENTAL,
      ).map(toCatalogItem),
    ),
    getStock: jest.fn(async (productId: string) => {
      const product = PRODUCTS.find(
        (candidate) => candidate.productId === productId,
      );
      if (product === undefined) throw new Error('404');
      return toStockCheck(product);
    }),
    evaluateCart: jest.fn(
      async (
        items: Array<{
          productId: string;
          variantId?: string;
          quantity: number;
        }>,
      ) => ({
        items: items.map((item) => {
          const unit = unitPrice(item.productId, item.variantId);
          return {
            productId: item.productId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
            unitPriceCents: unit,
            originalPriceCents: unit * item.quantity,
            finalPriceCents: unit * item.quantity,
            discountAmountCents: 0,
            appliedPromotionTitle: null,
          };
        }),
        promotionEvaluationStatus: 'fully_evaluated',
      }),
    ),
  };
  const client = api as unknown as ChatbotApiClient;
  const config = {
    get: () => ({ model: 'm', maxSteps: 6, historyTurns: 12 }),
  } as unknown as ConfigService;
  let script: unknown[] = [];
  const generate: GenerateTextFn = async (input) =>
    generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
  const agent = new MinimalCatalogAgentService(
    client,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    new MinimalCartService(client, store),
  );
  let n = 0;
  const send = async (text: string, steps: unknown[] = [say()]) => {
    script = steps;
    const result = await agent.tryHandle({
      senderId: SENDER,
      text,
      inboundEvent: {
        senderId: SENDER,
        messageId: `wamid.${(n += 1)}`,
        receivingPhoneNumberId: '123456789012345',
      },
    });
    if (result.kind !== 'handled') throw new Error('reply');
    result.onSent?.();
    return result as {
      reply: string;
      interactive?: CustomerReplyInteractive;
    };
  };
  const lines = async () => {
    const raw = (await store.get(SENDER))?.data.minimalCart as
      | {
          items: Array<{
            productId: string;
            variantId?: string;
            quantity: number;
          }>;
        }
      | undefined;
    return (raw?.items ?? []).map((item) => ({
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
    }));
  };
  const showNupec = async () => {
    const options = await send('Hola, ¿tienen croquetas Nupec?', [
      call('searchCatalog', { q: 'croquetas nupec' }),
      say('Tenemos Nupec en 2 kg, 8 kg y 20 kg.'),
    ]);
    expect(options.reply).toContain('2 kg');
    expect(options.reply).toContain('20 kg');
  };
  const showDental = async () => {
    const options = await send('¿Tienen premios dentales para perro?', [
      call('searchCatalog', { q: 'premios dentales' }),
      say('Tenemos premios dentales de 7 y 14 piezas.'),
    ]);
    expect(options.reply).toContain('7 piezas');
  };
  return { send, lines, showNupec, showDental };
}

const cartButtons = (interactive: CustomerReplyInteractive | undefined) =>
  interactive?.type === 'buttons'
    ? interactive.buttons.map((button) => button.id.split(':')[0])
    : [];

describe('S5 (N14) a presentation picked without a count adds one unit', () => {
  it.each([
    [
      'adjustCartItem on the presentation',
      () => adjust(ref(NUPEC, NUPEC_2KG), null),
    ],
    ['adjustCartItem on the product', () => adjust(ref(NUPEC), null)],
    [
      'setCartItem without a quantity',
      () => setItem(ref(NUPEC, NUPEC_2KG), null),
    ],
  ])(
    '«quiero el de 2 kg» after the Nupec options (%s)',
    async (_label, toolCall) => {
      const h = harness();
      await h.showNupec();
      const added = await h.send('quiero el de 2 kg', [toolCall(), say()]);
      expect(await h.lines()).toEqual([
        { productId: NUPEC, variantId: NUPEC_2KG, quantity: 1 },
      ]);
      expect(added.reply.startsWith(`${CART_DEFAULT_UNIT_NOTE}\n\n`)).toBe(
        true,
      );
      expect(added.reply).not.toMatch(/¿Cuántas unidades/);
      expect(cartButtons(added.interactive)).toEqual([
        'cart_continue',
        'cart_add',
      ]);
    },
  );

  it('«la de 7 piezas» adds one pack of 7 pieces (7 is not the count)', async () => {
    const h = harness();
    await h.showDental();
    const added = await h.send('la de 7 piezas', [
      adjust(ref(DENTAL, DENTAL_7), null),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: DENTAL, variantId: DENTAL_7, quantity: 1 },
    ]);
    expect(added.reply.startsWith(`${CART_DEFAULT_UNIT_NOTE}\n\n`)).toBe(true);
    expect(cartButtons(added.interactive)).toEqual([
      'cart_continue',
      'cart_add',
    ]);
  });

  it('«la de 7 piezas» never becomes seven units even if the model says 7', async () => {
    const h = harness();
    await h.showDental();
    await h.send('la de 7 piezas', [
      adjust(ref(DENTAL, DENTAL_7), 7, '7'),
      say(),
    ]);
    expect(await h.lines()).not.toContainEqual(
      expect.objectContaining({ quantity: 7 }),
    );
  });

  it('a tú customer gets the tú default-unit note', async () => {
    const h = harness();
    await h.send('hola, tienes croquetas nupec?', [
      call('searchCatalog', { q: 'croquetas nupec' }),
      say(),
    ]);
    const added = await h.send('quiero el de 8 kg porfa', [
      adjust(ref(NUPEC, NUPEC_8KG), null),
      say(),
    ]);
    expect(added.reply).toMatch(
      /^Te agregué 1 unidad; si quieres otra cantidad/,
    );
  });
});

describe('S5 explicit counts are unchanged', () => {
  it('«quiero 2 de 7 piezas» adds two packs of 7 pieces', async () => {
    const h = harness();
    await h.showDental();
    const added = await h.send('quiero 2 de 7 piezas', [
      adjust(ref(DENTAL, DENTAL_7), 2, '2'),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: DENTAL, variantId: DENTAL_7, quantity: 2 },
    ]);
    expect(added.reply).not.toContain(CART_DEFAULT_UNIT_NOTE);
  });

  it('«dos bolsas de 2 kg» adds two 2 kg bags', async () => {
    const h = harness();
    await h.showNupec();
    const added = await h.send('dos bolsas de 2 kg', [
      adjust(ref(NUPEC, NUPEC_2KG), 2, 'dos'),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: NUPEC, variantId: NUPEC_2KG, quantity: 2 },
    ]);
    expect(added.reply).not.toContain(CART_DEFAULT_UNIT_NOTE);
  });

  it('a presentation named with no want and no offer still asks the count', async () => {
    const h = harness();
    await h.send('¿Cuántas presentaciones tiene el nupec?', [
      call('searchCatalog', { q: 'croquetas nupec' }),
      say('Tiene 2 kg, 8 kg y 20 kg.'),
    ]);
    // A question about one presentation is not a purchase.
    await h.send('¿y el de 2 kg cuánto pesa en total?', [
      adjust(ref(NUPEC, NUPEC_2KG), null),
      say(),
    ]);
    expect(await h.lines()).toEqual([]);
  });
});
