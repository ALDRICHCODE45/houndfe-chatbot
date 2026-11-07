import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { SCENARIOS } from '../../../scripts/eval/scenarios';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * F6-F8 (live eval run 2, 2026-11-07): natural add-to-cart replies after a
 * product was shown must land in the cart when the target is unambiguous,
 * never with a quantity the customer did not say, and never by choosing
 * between several candidates for the customer.
 */
const SENDER = '5215550001111';
const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const variant = (p: number, v: number) =>
  `b0000000-0000-4000-8000-${String(p * 100 + v).padStart(12, '0')}`;
// Refs are deterministic digests of (sender, product, variant); every ref used
// below is also registered by a scripted catalog read in the same test.
const registry = new MinimalCartSelections(SENDER);
const ref = (p: number, v?: number): string => {
  const reference = registry.register({
    productId: product(p),
    productName: 'Fixture',
    ...(v === undefined
      ? {}
      : { variantId: variant(p, v), variantName: 'Fixture variant' }),
  });
  if (reference === null) throw new Error('fixture ref');
  return reference;
};
// Catalog fixture ids: 8 aglomerante (10 kg, 20 kg), 9 sílice, 10 Kong
// (Chico, Mediano, Grande), 12 collar de nylon (Chica, Mediana, Grande).
const AGLOMERANTE = 8;
const SILICE = 9;
const KONG = 10;
const COLLAR = 12;

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
const say = (text = 'Texto del modelo.') =>
  step([{ type: 'text', text }], 'stop');
const adjust = (
  selectionRef: string,
  delta: number | null,
  quantityText: string | null = null,
  continuation = false,
) =>
  call('adjustCartItem', { selectionRef, delta, quantityText, continuation });
const setItem = (
  selectionRef: string,
  quantity: number | null,
  quantityText: string | null = null,
) =>
  call('setCartItem', {
    selectionRef,
    quantity,
    quantityText,
    continuation: false,
  });
const prepare = (
  selectionRef: string,
  quantity: number | null,
  quantityText: string | null,
  continuation = false,
) =>
  call('prepareCartItem', {
    selectionRef,
    operation: 'add',
    quantity,
    quantityText,
    continuation,
  });
/** The scenario's turns; conditional ones only with `withConditional`. */
const scenarioTurns = (id: string, withConditional = false): string[] => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`scenario ${id}`);
  return scenario.turns.flatMap((turn) => {
    if (typeof turn === 'string') return [turn];
    return turn.onlyIfPreviousReply === undefined || withConditional
      ? [turn.text]
      : [];
  });
};

const ORDER_ENDING = /Respond[ae] "SÍ" para crear el pedido/;
const NO_CHANGE = /No modifiqué el carrito/;

function harness(customer: 'new' | '03100' | '04000' = '03100') {
  const api = new EvalFakeApi(
    customer === 'new'
      ? { kind: 'new' }
      : { kind: 'existing', firstName: 'Mariana', zip: customer },
  );
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? '99999999-9999-4999-8999-999999999999'
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const cart = new MinimalCartService(api, store);
  const checkout = new MinimalCheckoutService(api, store);
  const shipping = new MinimalShippingService(store, cart, checkout, api, {
    register: async () => undefined,
  });
  const order = new MinimalOrderService(
    api,
    store,
    cart,
    checkout,
    config,
    shipping,
  );
  // One scripted model run per generateText call, in order.
  let scripts: unknown[][] = [];
  const seen: Array<{ system?: unknown; prepareStep?: unknown }> = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = scripts.shift() ?? [say()];
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
  };
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cart,
    checkout,
    order,
    shipping,
  );
  let n = 0;
  const turn = async (text: string, ...runs: unknown[][]) => {
    scripts = runs.length === 0 ? [[say()]] : runs;
    const result = await agent.tryHandle({
      senderId: SENDER,
      text,
      inboundEvent: {
        senderId: SENDER,
        messageId: `wamid.${(n += 1)}`,
        receivingPhoneNumberId: '123456789012345',
      },
    });
    result.onSent?.();
    return result.reply;
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
  return { api, checkout, turn, lines, seen };
}

/** The bot shows ONE product and offers to add it (fixed F8 behaviour). */
async function showSilice(h: ReturnType<typeof harness>) {
  await h.turn('Buen día. Deseo comprar una arena de sílice para gato.', [
    call('searchCatalog', { q: 'arena de sílice para gato' }),
    say(
      'Buen día. Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo, $179.00. ¿Se la agrego al carrito?',
    ),
  ]);
}

async function showCollar(h: ReturnType<typeof harness>) {
  await h.turn('Hola, busco un collar de nylon para perro talla mediana', [
    call('searchCatalog', { q: 'collar de nylon perro talla mediana' }),
    say(
      'Encontré el Collar Ajustable de Nylon para Perro en talla Mediana en nuestro catálogo, $149.00. ¿Te lo agrego al carrito?',
    ),
  ]);
}

describe('F7 prepareCartItem on a resolved selection is a real add', () => {
  it('"Agrégame uno" via prepareCartItem lands one unit and never claims a registered intention', async () => {
    const h = harness();
    await showCollar(h);
    const reply = await h.turn('Agrégame uno', [
      prepare(ref(COLLAR, 2), 1, 'uno'),
      say('He registrado la intención de agregar un collar al carrito.'),
    ]);
    expect(await h.lines()).toEqual([
      {
        productId: product(COLLAR),
        variantId: variant(COLLAR, 2),
        quantity: 1,
      },
    ]);
    expect(reply).not.toMatch(/intenci[oó]n/);
    expect(reply).toContain('Tu carrito');
  });

  it('a parent reference resolves to the presentation the customer named earlier', async () => {
    const h = harness();
    await showCollar(h);
    await h.turn('Agrégame uno', [prepare(ref(COLLAR), 1, 'uno'), say()]);
    expect(await h.lines()).toEqual([
      {
        productId: product(COLLAR),
        variantId: variant(COLLAR, 2),
        quantity: 1,
      },
    ]);
  });

  it('"quiero 2 kong mediano" adds two Mediano at once instead of re-asking the presentation', async () => {
    const h = harness('new');
    const reply = await h.turn('hola! 🐶 quiero 2 kong mediano', [
      call('searchCatalog', { q: 'kong mediano' }),
      prepare(ref(KONG), 2, '2'),
      say('¿Qué presentación desea agregar?'),
    ]);
    expect(await h.lines()).toEqual([
      { productId: product(KONG), variantId: variant(KONG, 2), quantity: 2 },
    ]);
    expect(reply).not.toContain('¿Qué presentación');
    // "sí ese, agrégamelos" afterwards never doubles the line on its own.
    await h.turn('sí ese, agrégamelos porfa', [
      adjust(ref(KONG, 2), 2, null, true),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: product(KONG), variantId: variant(KONG, 2), quantity: 2 },
    ]);
  });

  it('an unnamed presentation still asks which one, listing the real options', async () => {
    const h = harness('new');
    const reply = await h.turn('quiero 2 kong', [
      call('searchCatalog', { q: 'kong' }),
      prepare(ref(KONG), 2, '2'),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toMatch(/presentación/);
    expect(reply).toContain('Mediano');
    // The prepared two units carry to the presentation the customer picks.
    await h.turn('el mediano, agrégamelos porfa', [
      adjust(ref(KONG, 2), 2),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      { productId: product(KONG), variantId: variant(KONG, 2), quantity: 2 },
    ]);
  });
});

describe('F6 natural add replies after a product was shown', () => {
  it.each([
    ['Sí, agréguela por favor.', adjust(ref(SILICE), 1)],
    ['Sí, agréguela por favor.', adjust(ref(SILICE), null)],
    ['Agréguela', prepare(ref(SILICE), 1, 'una')],
    ['agrégalo', setItem(ref(SILICE), 1, 'agrégalo')],
    ['Sí.', adjust(ref(SILICE), null)],
    ['claro', adjust(ref(SILICE), 1)],
  ])('"%s" adds ONE unit and says so explicitly', async (text, toolCall) => {
    const h = harness();
    await showSilice(h);
    const reply = await h.turn(text, [toolCall, say('Listo.')]);
    expect(await h.lines()).toEqual([
      { productId: product(SILICE), variantId: null, quantity: 1 },
    ]);
    expect(reply).toMatch(/agregué 1 unidad/i);
    expect(reply).not.toMatch(NO_CHANGE);
  });

  it.each([
    ['quiero 2', adjust(ref(SILICE), 2)],
    ['dame dos', adjust(ref(SILICE), 2, 'dame')],
    ['Agrégueme un par', adjust(ref(SILICE), 2, 'un par')],
    ['quiero 2', setItem(ref(SILICE), null)],
  ])('"%s" adds the two units the customer said', async (text, toolCall) => {
    const h = harness();
    await showSilice(h);
    await h.turn(text, [toolCall, say()]);
    expect(await h.lines()).toEqual([
      { productId: product(SILICE), variantId: null, quantity: 2 },
    ]);
  });

  it('"un par" is two units, never one', async () => {
    const h = harness();
    await showSilice(h);
    await h.turn('Agrégueme un par', [adjust(ref(SILICE), 1, 'un par'), say()]);
    expect(await h.lines()).toEqual([]);
  });

  it('"cambia la cantidad a 2" sets the only cart line to two', async () => {
    const h = harness('04000');
    await showCollar(h);
    await h.turn('Agrégame uno', [adjust(ref(COLLAR, 2), 1, 'uno'), say()]);
    await h.turn('sí pero cambia la cantidad a 2', [
      setItem(ref(COLLAR, 2), 2),
      say(),
    ]);
    expect(await h.lines()).toEqual([
      {
        productId: product(COLLAR),
        variantId: variant(COLLAR, 2),
        quantity: 2,
      },
    ]);
    // The same request through a delta is still a total of two, never three.
    await h.turn('cambia la cantidad a 2', [adjust(ref(COLLAR, 2), 2), say()]);
    expect(await h.lines()).toEqual([
      {
        productId: product(COLLAR),
        variantId: variant(COLLAR, 2),
        quantity: 2,
      },
    ]);
  });
});

describe('F6 anti-hallucination still holds', () => {
  async function showBothArenas(h: ReturnType<typeof harness>) {
    await h.turn('Buen día. Deseo comprar una arena para gato.', [
      call('searchCatalog', { q: 'arena para gato' }),
      say(
        'Encontré dos opciones:\n1. Arena para Gato de Sílice 3.8 L, $179.00\n2. Arena para Gato Aglomerante Sin Aroma: 10 kg $219.00 o 20 kg $389.00\n¿Cuál desea?',
      ),
    ]);
  }

  it('"Sí, agréguela" after several products asks which one and writes nothing', async () => {
    const h = harness();
    await showBothArenas(h);
    const reply = await h.turn('Sí, agréguela por favor.', [
      adjust(ref(SILICE), 1),
      say('Listo, agregada.'),
    ]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toContain('Arena para Gato de Sílice 3.8 L');
    expect(reply).toContain('Arena para Gato Aglomerante Sin Aroma');
    expect(reply).toMatch(NO_CHANGE);
  });

  it('"Sí, agréguela" between two shown presentations asks the presentation', async () => {
    const h = harness();
    await h.turn('¿Tienen arena aglomerante?', [
      call('searchCatalog', { q: 'arena aglomerante' }),
      say(
        'Encontré Arena para Gato Aglomerante Sin Aroma en 10 kg ($219.00) y 20 kg ($389.00). ¿Se la agrego al carrito?',
      ),
    ]);
    const reply = await h.turn('Sí, agréguela por favor.', [
      adjust(ref(AGLOMERANTE, 1), null),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toMatch(/presentación/);
    expect(reply).toContain('10 kg');
    expect(reply).toContain('20 kg');
  });

  it.each([
    ['agrégalo', adjust(ref(SILICE), 3)],
    ['Sí.', setItem(ref(SILICE), 5)],
    ['Agréguela', prepare(ref(SILICE), 4, null)],
  ])(
    '"%s" never writes a quantity the customer did not say',
    async (text, toolCall) => {
      const h = harness();
      await showSilice(h);
      await h.turn(text, [toolCall, say('Listo, agregué varias.')]);
      expect(await h.lines()).toEqual([]);
    },
  );

  it('"sí" to a question that is not a cart offer does not add anything', async () => {
    const h = harness();
    await h.turn('¿Tienen arena de sílice?', [
      call('searchCatalog', { q: 'arena de sílice' }),
      say(
        'Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo. ¿Buscaba esa presentación?',
      ),
    ]);
    const reply = await h.turn('Sí.', [adjust(ref(SILICE), null), say()]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toMatch(/unidades/);
  });
});

/** Lists both arenas; `customerText` decides which one the customer meant. */
async function showBothArenasFor(
  h: ReturnType<typeof harness>,
  customerText: string,
) {
  await h.turn(customerText, [
    call('searchCatalog', { q: 'arena para gato' }),
    say(
      'Encontré dos opciones:\n1. Arena para Gato de Sílice 3.8 L, $179.00\n2. Arena para Gato Aglomerante Sin Aroma: 10 kg $219.00 o 20 kg $389.00\n¿Se la agrego al carrito?',
    ),
  ]);
}

const GENERIC_REJECTION = /No pude confirmar esa operación/;

describe("F9 the customer's own words pick one of several shown products", () => {
  it.each([
    adjust(ref(SILICE), null),
    adjust(ref(SILICE), 1),
    prepare(ref(SILICE), 1, 'una'),
  ])(
    '"sílice" in the request + "Sí, agréguela" adds one silica arena',
    async (toolCall) => {
      const h = harness();
      await showBothArenasFor(
        h,
        'Buen día. Deseo comprar una arena de sílice para gato.',
      );
      const reply = await h.turn('Sí, agréguela por favor.', [
        toolCall,
        say('Listo.'),
      ]);
      expect(await h.lines()).toEqual([
        { productId: product(SILICE), variantId: null, quantity: 1 },
      ]);
      expect(reply).toMatch(/agregué 1 unidad/i);
      expect(reply).not.toMatch(/A cuál producto/);
    },
  );

  it('a size only one product has ("20 kg") picks that product and presentation', async () => {
    const h = harness();
    await showBothArenasFor(h, 'Busco arena para gato de 20 kg.');
    await h.turn('Agréguela, por favor.', [
      adjust(ref(AGLOMERANTE), null),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([
      {
        productId: product(AGLOMERANTE),
        variantId: variant(AGLOMERANTE, 2),
        quantity: 1,
      },
    ]);
  });

  it('the product picked by name still asks its presentation when none was named', async () => {
    const h = harness();
    await showBothArenasFor(h, 'Busco arena aglomerante para gato.');
    const reply = await h.turn('Sí, agréguela por favor.', [
      adjust(ref(AGLOMERANTE), null),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toMatch(/presentación/);
    expect(reply).toContain('10 kg');
    expect(reply).toContain('20 kg');
  });

  it('a model pick that contradicts the customer words asks instead of writing', async () => {
    const h = harness();
    await showBothArenasFor(
      h,
      'Buen día. Deseo comprar una arena de sílice para gato.',
    );
    const reply = await h.turn('Sí, agréguela por favor.', [
      adjust(ref(AGLOMERANTE, 1), null),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toMatch(NO_CHANGE);
  });

  it('words both products share ("arena para gato") still ask which one', async () => {
    const h = harness();
    await showBothArenasFor(h, 'Buen día. Deseo comprar una arena para gato.');
    const reply = await h.turn('Sí, agréguela por favor.', [
      adjust(ref(SILICE), null),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([]);
    expect(reply).toContain('Arena para Gato de Sílice 3.8 L');
    expect(reply).toContain('Arena para Gato Aglomerante Sin Aroma');
  });
});

describe('F10 cart tools on a message with no cart request', () => {
  async function askWhichArena(h: ReturnType<typeof harness>) {
    await showBothArenasFor(h, 'Buen día. Deseo comprar una arena para gato.');
    const asked = await h.turn('Sí, agréguela por favor.', [
      adjust(ref(SILICE), null),
      say('Listo.'),
    ]);
    expect(asked).toMatch(/A cuál producto/);
  }

  it.each([adjust(ref(SILICE), 1, '1'), prepare(ref(SILICE), 1, 'una')])(
    '"Quiero comprar." with an empty cart re-asks the open product choice',
    async (toolCall) => {
      const h = harness();
      await askWhichArena(h);
      const reply = await h.turn('Quiero comprar.', [
        toolCall,
        say('Listo, agregada.'),
      ]);
      expect(await h.lines()).toEqual([]);
      expect(reply).not.toMatch(GENERIC_REJECTION);
      expect(reply).toMatch(/A cuál producto/);
      expect(reply).toContain('Arena para Gato de Sílice 3.8 L');
      expect(reply).toContain('Arena para Gato Aglomerante Sin Aroma');
    },
  );

  it('answering the product question by name ("La de sílice") adds one unit', async () => {
    const h = harness();
    await askWhichArena(h);
    const reply = await h.turn('La de sílice, por favor.', [
      adjust(ref(SILICE), null),
      say('Listo.'),
    ]);
    expect(await h.lines()).toEqual([
      { productId: product(SILICE), variantId: null, quantity: 1 },
    ]);
    expect(reply).toMatch(/agregué 1 unidad/i);
  });

  it('pickup with a filled cart proceeds instead of the generic rejection', async () => {
    const h = harness('03100');
    await showSilice(h);
    await h.turn('Sí, agréguela por favor.', [
      adjust(ref(SILICE), null),
      say(),
    ]);
    const reply = await h.turn('Prefiero recogerlo en tienda.', [
      adjust(ref(SILICE), 1, '1'),
      call('chooseStorePickup'),
      say(),
    ]);
    expect(reply).not.toMatch(GENERIC_REJECTION);
    expect(await h.lines()).toEqual([
      { productId: product(SILICE), variantId: null, quantity: 1 },
    ]);
  });
});

describe('F8 catalog claims need a catalog read', () => {
  it('"Encontré varias opciones" with no tool call reruns the turn with a forced search', async () => {
    const h = harness();
    const reply = await h.turn(
      'Buen día. Deseo comprar una arena de sílice para gato.',
      [
        say(
          'Buen día. Encontré varias opciones de arena de sílice para gato en el catálogo. ¿Buscaba alguna presentación específica?',
        ),
      ],
      [
        call('searchCatalog', { q: 'arena de sílice para gato' }),
        say(
          'Buen día. Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo, $179.00. ¿Se la agrego al carrito?',
        ),
      ],
    );
    expect(h.seen).toHaveLength(2);
    expect(reply).toContain('Arena para Gato de Sílice 3.8 L');
    const prepareStep = h.seen[1].prepareStep as (options: {
      stepNumber: number;
    }) => { toolChoice?: unknown } | undefined;
    expect(prepareStep({ stepNumber: 0 })?.toolChoice).toEqual({
      type: 'tool',
      toolName: 'searchCatalog',
    });
    expect(prepareStep({ stepNumber: 1 })?.toolChoice).toBeUndefined();
  });

  it('the prompt requires listing real options and using the real add tool', async () => {
    const h = harness();
    await h.turn('Hola');
    const raw = h.seen[0].system;
    const system = typeof raw === 'string' ? raw : '';
    expect(system).not.toContain('SOLO registra una intención');
    expect(system).toMatch(/enumere|enumera/i);
    expect(system).toMatch(/nunca diga que registró la intención/i);
  });
});

describe('fixed replies', () => {
  it('pickup with an empty cart says the cart is empty once', async () => {
    const h = harness();
    const reply = await h.turn('Prefiero recogerlo en tienda.', [
      call('chooseStorePickup'),
      call('getCart'),
      say(),
    ]);
    expect(reply.match(/Su carrito está vacío/g)).toHaveLength(1);
  });
});

describe('eval purchase scenarios with scripted tool calls → exactly one order', () => {
  it('pickup', async () => {
    const [t1, t2, t3, t4, t5, t6] = scenarioTurns('pickup');
    const h = harness('03100');
    await h.turn(t1, [
      call('searchCatalog', { q: 'arena de sílice para gato' }),
      say(
        'Buen día. Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo, $179.00. ¿Se la agrego al carrito?',
      ),
    ]);
    await h.turn(t2, [adjust(ref(SILICE), 1), say()]);
    expect(await h.lines()).toEqual([
      { productId: product(SILICE), variantId: null, quantity: 1 },
    ]);
    await h.turn(t3, [
      call('lookupCheckoutCustomer', { nextPageRef: null }),
      say('Tengo su dirección guardada Casa. ¿La usamos o prefiere recoger?'),
    ]);
    const summary = await h.turn(t4, [call('chooseStorePickup'), say()]);
    expect(summary).toMatch(ORDER_ENDING);
    const placed = await h.turn(t5);
    expect(placed).toContain('folio EV-0001');
    await h.turn(t6, [say('Gracias por su compra.')]);
    expect(h.api.orders.size).toBe(1);
  });

  it('pickup after the bot asked which product (conditional answer turn)', async () => {
    const [t1, t2, answer, t3, t4, t5] = scenarioTurns('pickup', true);
    const h = harness('03100');
    await showBothArenasFor(h, 'Buen día. Deseo comprar una arena para gato.');
    expect(t1).toMatch(/sílice/);
    const asked = await h.turn(t2, [adjust(ref(SILICE), null), say()]);
    expect(asked).toMatch(/A cuál producto/);
    const pickupTurn = SCENARIOS.find((s) => s.id === 'pickup')?.turns[2];
    if (typeof pickupTurn === 'string' || pickupTurn === undefined)
      throw new Error('conditional turn');
    expect(pickupTurn.onlyIfPreviousReply).toBeDefined();
    expect(asked).toMatch(pickupTurn.onlyIfPreviousReply ?? /never/);
    await h.turn(answer, [adjust(ref(SILICE), null), say()]);
    expect(await h.lines()).toEqual([
      { productId: product(SILICE), variantId: null, quantity: 1 },
    ]);
    await h.turn(t3, [
      call('lookupCheckoutCustomer', { nextPageRef: null }),
      say('Tengo su dirección guardada Casa. ¿La usamos o prefiere recoger?'),
    ]);
    expect(await h.turn(t4, [call('chooseStorePickup'), say()])).toMatch(
      ORDER_ENDING,
    );
    expect(await h.turn(t5)).toContain('folio EV-0001');
    expect(h.api.orders.size).toBe(1);
  });

  it('correction', async () => {
    const [t1, t2, t3, t4, t5, t6, t7, t8, t9] = scenarioTurns('correction');
    const h = harness('04000');
    await h.turn(t1, [
      call('searchCatalog', { q: 'collar de nylon perro talla mediana' }),
      say(
        'Encontré el Collar Ajustable de Nylon para Perro en talla Mediana en nuestro catálogo, $149.00. ¿Te lo agrego al carrito?',
      ),
    ]);
    await h.turn(t2, [prepare(ref(COLLAR, 2), 1, 'uno'), say()]);
    expect(await h.lines()).toHaveLength(1);
    await h.turn(t3, [
      call('lookupCheckoutCustomer', { nextPageRef: null }),
      say('Tengo tu dirección guardada Casa. ¿La usamos?'),
    ]);
    const lookup = await h.checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await h.turn(t4, [
      call('selectCheckoutAddress', {
        addressRef: lookup.addresses[0].addressRef,
      }),
      call('confirmCheckoutDetails'),
      say(),
    ]);
    expect(await h.turn(t5)).toMatch(ORDER_ENDING);
    await h.turn(t6, [call('prepareOrder'), say()]);
    // G2: the cart change continues to the updated summary in the same reply.
    expect(await h.turn(t7, [setItem(ref(COLLAR, 2), 2), say()])).toMatch(
      ORDER_ENDING,
    );
    expect(await h.lines()).toEqual([
      {
        productId: product(COLLAR),
        variantId: variant(COLLAR, 2),
        quantity: 2,
      },
    ]);
    expect(await h.turn(t8)).toContain('folio EV-0001');
    await h.turn(t9, [say('Gracias por su compra.')]);
    expect(h.api.orders.size).toBe(1);
  });
});
