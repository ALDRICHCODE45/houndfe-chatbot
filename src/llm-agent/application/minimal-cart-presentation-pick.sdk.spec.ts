import { Logger } from '@nestjs/common';
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
import {
  CART_DEFAULT_UNIT_NOTE,
  CART_OPERATION_CLARIFICATION,
} from './minimal-cart-conversation';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * odd/tasks/presentation-pick-grounding.md (prod 2026-11-18, main 825b9a8):
 * after the code-rendered options for «Tienen alimento para gato?», picking
 * «la caja de 12 sobres» of «Whiskas Gatitos Pollo en Salsa Sobre 85 g»
 * (presentations «Sobre 85 g» $18 and «Caja 12 sobres» $199) answered the
 * fail-closed clarification (count_mismatch / citation_not_literal). A
 * countless pick adds ONE unit; the number inside the presentation name is
 * never the quantity; an explicit count still wins.
 */
const SENDER = '5215550002222';
const WHISKAS = 'a0000000-0000-4000-8000-000000000201';
const MININO = 'a0000000-0000-4000-8000-000000000202';
const WHISKAS_SOBRE = 'b0000000-0000-4000-8000-000000201001';
const WHISKAS_CAJA = 'b0000000-0000-4000-8000-000000201002';
const MININO_15 = 'b0000000-0000-4000-8000-000000202001';
const MININO_3 = 'b0000000-0000-4000-8000-000000202002';

const PRODUCTS: FixtureProduct[] = [
  {
    productId: WHISKAS,
    name: 'Whiskas Gatitos Pollo en Salsa Sobre 85 g',
    brand: 'Whiskas',
    description: 'Alimento húmedo para gato cachorro, pollo en salsa.',
    priceCents: null,
    status: 'available',
    quantity: 40,
    variants: [
      {
        variantId: WHISKAS_SOBRE,
        option: 'Presentación',
        value: 'Sobre 85 g',
        priceCents: 1800,
        status: 'available',
        quantity: 30,
      },
      {
        variantId: WHISKAS_CAJA,
        option: 'Presentación',
        value: 'Caja 12 sobres',
        priceCents: 19900,
        status: 'available',
        quantity: 10,
      },
    ],
  },
  {
    productId: MININO,
    name: 'Croquetas Minino Plus Gato Adulto',
    brand: 'Minino',
    description: 'Alimento seco para gato adulto.',
    priceCents: null,
    status: 'available',
    quantity: 20,
    variants: [
      {
        variantId: MININO_15,
        option: 'Peso',
        value: '1.5 kg',
        priceCents: 15900,
        status: 'available',
        quantity: 10,
      },
      {
        variantId: MININO_3,
        option: 'Peso',
        value: '3 kg',
        priceCents: 28900,
        status: 'available',
        quantity: 10,
      },
    ],
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
const prepare = (
  selectionRef: string,
  quantity: number | null,
  quantityText: string | null = null,
) =>
  call('prepareCartItem', {
    selectionRef,
    operation: 'add',
    quantity,
    quantityText,
    continuation: false,
  });

function harness() {
  const store = new InMemoryConversationStore();
  const api = {
    searchCatalog: jest.fn(async () => PRODUCTS.map(toCatalogItem)),
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
  const showCatFood = async () => {
    const options = await send('Tienen alimento para gato?', [
      call('searchCatalog', { q: 'alimento para gato' }),
      say('ok'),
    ]);
    // The code-rendered options (S13) list both Whiskas presentations.
    expect(options.reply).toContain('Sobre 85 g');
    expect(options.reply).toContain('Caja 12 sobres');
    return options;
  };
  return { send, lines, showCatFood, api };
}

const ONE_BOX = [{ productId: WHISKAS, variantId: WHISKAS_CAJA, quantity: 1 }];

describe('prod case: a presentation with a number in its name, picked without a count', () => {
  it.each([
    [
      'count_mismatch on the box (delta 1, «12 sobres»)',
      () => [
        adjust(ref(WHISKAS, WHISKAS_CAJA), 1, '12 sobres'),
        call('getCart'),
        prepare(ref(WHISKAS, WHISKAS_CAJA), 1, '12 sobres'),
        say(),
      ],
    ],
    [
      'count_mismatch on the product (delta 1, «la caja de 12 sobres»)',
      () => [adjust(ref(WHISKAS), 1, 'la caja de 12 sobres'), say()],
    ],
    [
      'the model proposes the presentation number (delta 12, «12»)',
      () => [adjust(ref(WHISKAS, WHISKAS_CAJA), 12, '12'), say()],
    ],
    [
      'no count at all',
      () => [adjust(ref(WHISKAS, WHISKAS_CAJA), null), say()],
    ],
  ])(
    '«quisiera whiskas, la caja de 12 sobres por favor.» adds one box (%s)',
    async (_label, steps) => {
      const h = harness();
      await h.showCatFood();
      const added = await h.send(
        'quisiera whiskas, la caja de 12 sobres por favor.',
        steps(),
      );
      expect(added.reply).not.toContain(CART_OPERATION_CLARIFICATION);
      expect(await h.lines()).toEqual(ONE_BOX);
      expect(added.reply.startsWith(`${CART_DEFAULT_UNIT_NOTE}\n\n`)).toBe(
        true,
      );
    },
  );

  it.each([
    [
      'citation_not_literal (the label «Caja 12 sobres»)',
      () => [adjust(ref(WHISKAS, WHISKAS_CAJA), 1, 'Caja 12 sobres'), say()],
    ],
    [
      'citation_not_literal (an invented «1»)',
      () => [adjust(ref(WHISKAS), 1, '1'), say()],
    ],
  ])(
    '«Quisiera la caja de 12 sobres de whiskas Gatitos Pollo en salsa por favor.» adds one box (%s)',
    async (_label, steps) => {
      const h = harness();
      await h.showCatFood();
      const added = await h.send(
        'Quisiera la caja de 12 sobres de whiskas Gatitos Pollo en salsa por favor.',
        [call('checkStock', { productId: WHISKAS }), ...steps()],
      );
      expect(added.reply).not.toContain(CART_OPERATION_CLARIFICATION);
      expect(await h.lines()).toEqual(ONE_BOX);
      expect(added.reply.startsWith(`${CART_DEFAULT_UNIT_NOTE}\n\n`)).toBe(
        true,
      );
    },
  );

  it('the full prod sequence: first try fails today, the second one too', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('quisiera whiskas, la caja de 12 sobres por favor.', [
      adjust(ref(WHISKAS, WHISKAS_CAJA), 1, '12 sobres'),
      say(),
    ]);
    await h.send(
      'Quisiera la caja de 12 sobres de whiskas Gatitos Pollo en salsa por favor.',
      [adjust(ref(WHISKAS, WHISKAS_CAJA), 1, 'Caja 12 sobres'), say()],
    );
    // Two picks of one box each: two boxes, never 12 or 24.
    expect(await h.lines()).toEqual([
      { productId: WHISKAS, variantId: WHISKAS_CAJA, quantity: 2 },
    ]);
  });
});

describe('S2 natural wordings of the presentation', () => {
  it('«la de 12» adds one box', async () => {
    const h = harness();
    await h.showCatFood();
    const added = await h.send('la de 12', [
      adjust(ref(WHISKAS, WHISKAS_CAJA), 12, '12'),
      say(),
    ]);
    expect(await h.lines()).toEqual(ONE_BOX);
    expect(added.reply.startsWith(`${CART_DEFAULT_UNIT_NOTE}\n\n`)).toBe(true);
  });

  it('«quiero el sobre de whiskas» picks the one «Sobre 85 g» presentation', async () => {
    const h = harness();
    await h.showCatFood();
    const added = await h.send('quiero el sobre de whiskas', [
      adjust(ref(WHISKAS), null),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: WHISKAS, variantId: WHISKAS_SOBRE, quantity: 1 },
    ]);
    expect(added.reply.startsWith(`${CART_DEFAULT_UNIT_NOTE}\n\n`)).toBe(true);
  });

  it('«el sobre de 85 gramos» adds one sachet (85 is not the count)', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('quiero el sobre de 85 gramos de whiskas', [
      adjust(ref(WHISKAS, WHISKAS_SOBRE), 85, '85'),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: WHISKAS, variantId: WHISKAS_SOBRE, quantity: 1 },
    ]);
  });

  it('«la de 3 kilos» of the Minino adds one 3 kg bag', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('quiero la de 3 kilos del minino', [
      adjust(ref(MININO), null),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: MININO, variantId: MININO_3, quantity: 1 },
    ]);
  });
});

describe('S3 explicit counts and protections are unchanged', () => {
  it('«2 cajas de 12 sobres» adds two boxes', async () => {
    const h = harness();
    await h.showCatFood();
    const added = await h.send('quiero 2 cajas de 12 sobres de whiskas', [
      adjust(ref(WHISKAS, WHISKAS_CAJA), 2, '2'),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: WHISKAS, variantId: WHISKAS_CAJA, quantity: 2 },
    ]);
    expect(added.reply).not.toContain(CART_DEFAULT_UNIT_NOTE);
  });

  it('«2 cajas de 12 sobres» on the product reference adds two boxes', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('quiero 2 cajas de 12 sobres de whiskas', [
      adjust(ref(WHISKAS), 2, '2 cajas'),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: WHISKAS, variantId: WHISKAS_CAJA, quantity: 2 },
    ]);
  });

  it('«las cajas de 12 sobres» (plural, no count) adds nothing', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('quiero las cajas de 12 sobres de whiskas', [
      adjust(ref(WHISKAS, WHISKAS_CAJA), 12, '12'),
      say(),
    ]);
    expect(await h.lines()).toEqual([]);
  });

  it('«la de 12» never becomes 12 boxes', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('la de 12', [
      adjust(ref(WHISKAS, WHISKAS_CAJA), 12, '12'),
      say(),
    ]);
    expect(await h.lines()).not.toContainEqual(
      expect.objectContaining({ quantity: 12 }),
    );
  });

  it('a question about the box is not a purchase', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('¿la caja de 12 sobres cuánto cuesta?', [
      adjust(ref(WHISKAS, WHISKAS_CAJA), null),
      say(),
    ]);
    expect(await h.lines()).toEqual([]);
  });

  it('«quiero el de whiskas» names no presentation: nothing is added', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('quiero el de whiskas', [adjust(ref(WHISKAS), null), say()]);
    expect(await h.lines()).toEqual([]);
  });
});

describe('checkStock after the code-rendered options', () => {
  it('the rendered product is a known product for the next turn', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('¿la caja de whiskas tiene existencias?', [
      call('checkStock', { productId: WHISKAS }),
      say('Sí hay.'),
    ]);
    expect(h.api.getStock).toHaveBeenCalledWith(WHISKAS);
  });

  it('a shown presentation id given as productId reads its product (no unknown_product)', async () => {
    const logs: string[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => {
        logs.push(String(message));
      });
    const h = harness();
    await h.showCatFood();
    await h.send(
      'Quisiera la caja de 12 sobres de whiskas Gatitos Pollo en salsa por favor.',
      [
        call('checkStock', { productId: WHISKAS_CAJA }),
        adjust(ref(WHISKAS, WHISKAS_CAJA), null),
        say(),
      ],
    );
    expect(h.api.getStock).toHaveBeenCalledWith(WHISKAS);
    expect(h.api.getStock).not.toHaveBeenCalledWith(WHISKAS_CAJA);
    expect(logs.join('\n')).not.toContain('code=unknown_product');
    expect(await h.lines()).toEqual(ONE_BOX);
    jest.restoreAllMocks();
  });

  it('an id never shown stays unknown_product', async () => {
    const h = harness();
    await h.showCatFood();
    await h.send('¿y el otro?', [
      call('checkStock', { productId: 'b0000000-0000-4000-8000-000000999001' }),
      say('No sé.'),
    ]);
    expect(h.api.getStock).not.toHaveBeenCalledWith(
      'b0000000-0000-4000-8000-000000999001',
    );
  });
});
