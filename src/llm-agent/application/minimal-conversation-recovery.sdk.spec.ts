import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { SCENARIOS } from '../../../scripts/eval/scenarios';
import { minimalLineLabel } from '../domain/minimal-order-confirmation';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService, minimalCartReply } from './minimal-cart.service';
import {
  EMPTY_REPLY_FALLBACK,
  MinimalCatalogAgentService,
} from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';

/**
 * Live eval run 4 (2026-11-07): G1 a step budget spent on tool calls must
 * never leave the customer without a reply; G2 a cart change after the order
 * summary continues to the UPDATED summary, and model-written imitations of
 * the confirmation summaries never reach the customer; G3 cart and summary
 * lines never repeat the product name inside the presentation.
 */
const SENDER = '5215550001111';
const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const variant = (p: number, v: number) =>
  `b0000000-0000-4000-8000-${String(p * 100 + v).padStart(12, '0')}`;
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
// Catalog fixture ids: 2 Pro Plan (3 kg, 7.5 kg, 15 kg), 9 sílice, 12 collar
// de nylon (Chica, Mediana, Grande).
const PRO_PLAN = 2;
const SILICE = 9;
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
) =>
  call('adjustCartItem', {
    selectionRef,
    delta,
    quantityText,
    continuation: false,
  });
const setItem = (
  selectionRef: string,
  quantity: number,
  quantityText: string | null = null,
) =>
  call('setCartItem', {
    selectionRef,
    quantity,
    quantityText,
    continuation: false,
  });
const scenarioTurns = (id: string): string[] => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`scenario ${id}`);
  return scenario.turns.flatMap((turn) =>
    typeof turn === 'string'
      ? [turn]
      : turn.onlyIfPreviousReply === undefined
        ? [turn.text]
        : [],
  );
};

const ORDER_ENDING = /Respond[ae] "SÍ" para crear el pedido/;
const FAKE_DELIVERY_SUMMARY =
  'Confirma tus datos de entrega nuevamente:\nNombre: Mariana\nCalle: Calle Francisco Sosa 150\n\nResponde "SÍ" para confirmar estos datos y crear el pedido, o dime qué quieres cambiar.';
const FAKE_ORDER_SUMMARY =
  'Resumen de tu pedido:\n• Collar: 2 × $149.00 MXN\nTotal a pagar: $367.00 MXN\n\nResponde "SÍ" para crear el pedido.';

function harness(
  customer: '03100' | '04000' = '04000',
  maxSteps = 6,
  failing?: { failAt: number },
) {
  const api = new EvalFakeApi({
    kind: 'existing',
    firstName: 'Mariana',
    zip: customer,
  });
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? '99999999-9999-4999-8999-999999999999'
        : { model: 'm', maxSteps, historyTurns: 12 },
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
  const seen: Array<Record<string, unknown>> = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    if (failing !== undefined && seen.length === failing.failAt)
      throw new Error('provider down');
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
      | { items: Array<{ variantId?: string; quantity: number }> }
      | undefined;
    return (raw?.items ?? []).map((item) => ({
      variantId: item.variantId ?? null,
      quantity: item.quantity,
    }));
  };
  const createCheckout = jest.spyOn(api, 'createCheckout');
  return { api, checkout, turn, lines, seen, createCheckout };
}

/** Correction scenario turns 1-6: the order summary for one collar is shown. */
async function summaryForOneCollar(h: ReturnType<typeof harness>) {
  const [t1, t2, t3, t4, t5, t6] = scenarioTurns('correction');
  await h.turn(t1, [
    call('searchCatalog', { q: 'collar de nylon perro talla mediana' }),
    say(
      'Encontré el Collar Ajustable de Nylon para Perro en talla Mediana en nuestro catálogo, $149.00. ¿Desea que se lo agregue al carrito?',
    ),
  ]);
  await h.turn(t2, [adjust(ref(COLLAR, 2), 1, 'uno'), say()]);
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
  expect(await h.turn(t6, [call('prepareOrder'), say()])).toMatch(ORDER_ENDING);
}

const orderedQuantities = (h: ReturnType<typeof harness>) =>
  h.createCheckout.mock.calls.map(([dto]) =>
    dto.sale.items.map((item) => item.quantity),
  );

describe('G2 a cart change after the order summary continues to the updated summary', () => {
  it('correction scenario: "sí pero cambia la cantidad a 2" → updated summary → "sí" → one order with 2', async () => {
    const h = harness('04000');
    await summaryForOneCollar(h);
    const [, , , , , , t7, t8, t9] = scenarioTurns('correction');

    const updated = await h.turn(t7, [
      setItem(ref(COLLAR, 2), 2, '2'),
      say(FAKE_ORDER_SUMMARY),
    ]);
    expect(await h.lines()).toEqual([
      { variantId: variant(COLLAR, 2), quantity: 2 },
    ]);
    expect(updated).toMatch(ORDER_ENDING);
    expect(updated).toContain('2 × $149.00 MXN');
    expect(updated).toContain('Envío');
    expect(updated).not.toContain('Todavía no se ha creado un pedido');
    expect(h.createCheckout).not.toHaveBeenCalled();

    // The model would write its own summary again; the armed gate answers.
    const created = await h.turn(t8, [say(FAKE_DELIVERY_SUMMARY)]);
    expect(created).toContain('folio EV-0001');
    expect(orderedQuantities(h)).toEqual([[2]]);

    await h.turn(t9, [say('¡Gracias por su compra!')]);
    expect(h.api.orders.size).toBe(1);
  });

  it('a change after store pickup keeps pickup and shows the updated summary', async () => {
    const h = harness('03100');
    await h.turn('Busco arena de sílice para gato', [
      call('searchCatalog', { q: 'arena de sílice para gato' }),
      say(
        'Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo, $179.00. ¿Se la agrego al carrito?',
      ),
    ]);
    await h.turn('Sí, agréguela por favor.', [
      adjust(ref(SILICE), null),
      say(),
    ]);
    expect(
      await h.turn('Prefiero recogerlo en tienda.', [
        call('chooseStorePickup'),
        say(),
      ]),
    ).toMatch(ORDER_ENDING);

    const updated = await h.turn('Mejor que sean 2', [
      setItem(ref(SILICE), 2, '2'),
      say(),
    ]);
    expect(updated).toMatch(ORDER_ENDING);
    expect(updated).toContain('Recoge en tienda');
    expect(updated).toContain('2 × $179.00 MXN');
    await h.turn('sí');
    expect(orderedQuantities(h)).toEqual([[2]]);
    expect(h.createCheckout.mock.calls[0][0].sale.shipping).toEqual({
      mode: 'pickup',
    });
  });

  it('a cart change before any checkout keeps the plain cart reply', async () => {
    const h = harness('04000');
    await h.turn('Hola, busco un collar de nylon para perro talla mediana', [
      call('searchCatalog', { q: 'collar de nylon perro talla mediana' }),
      say(
        'Encontré el Collar Ajustable de Nylon para Perro en talla Mediana en nuestro catálogo, $149.00. ¿Desea que se lo agregue al carrito?',
      ),
    ]);
    const reply = await h.turn('Agrégame dos', [
      adjust(ref(COLLAR, 2), 2, 'dos'),
      say(),
    ]);
    expect(reply).toContain('Tu carrito');
    expect(reply).not.toMatch(ORDER_ENDING);
  });

  it('a model-written imitation of the summaries is replaced by the real order summary', async () => {
    const h = harness('04000');
    await summaryForOneCollar(h);
    const reply = await h.turn('¿y cuándo llega?', [
      say(FAKE_DELIVERY_SUMMARY),
    ]);
    expect(reply).not.toContain('nuevamente');
    expect(reply).toMatch(ORDER_ENDING);
    expect(reply).toContain('1 × $149.00 MXN');
    await h.turn('sí');
    expect(orderedQuantities(h)).toEqual([[1]]);
  });

  it('a model-written delivery summary before checkout runs the real confirmation step', async () => {
    const h = harness('04000');
    await h.turn('Hola, busco un collar de nylon para perro talla mediana', [
      call('searchCatalog', { q: 'collar de nylon perro talla mediana' }),
      say('Encontré el Collar Ajustable de Nylon para Perro en talla Mediana.'),
    ]);
    await h.turn('Agrégame uno', [adjust(ref(COLLAR, 2), 1, 'uno'), say()]);
    const reply = await h.turn('quiero comprar', [say(FAKE_DELIVERY_SUMMARY)]);
    expect(reply).not.toContain('nuevamente');
    expect(reply).not.toMatch(ORDER_ENDING);
    expect(h.createCheckout).not.toHaveBeenCalled();
  });

  it('the prompt forbids writing the confirmation summaries by hand', async () => {
    const h = harness();
    await h.turn('Hola');
    const system = String(h.seen[0].system);
    expect(system).toMatch(/Nunca escriba por su cuenta el resumen/);
  });
});

describe('G1 a customer always gets a reply', () => {
  async function showProPlan(h: ReturnType<typeof harness>) {
    await h.turn('Busco croquetas Pro Plan', [
      call('searchCatalog', { q: 'croquetas Pro Plan' }),
      say(
        'Encontré Croquetas Pro Plan Adulto Raza Mediana en nuestro catálogo.',
      ),
    ]);
  }
  const stockLoop = () =>
    Array.from({ length: 4 }, () =>
      call('checkStock', { productId: product(PRO_PLAN) }),
    );

  it('steps exhausted on tool calls → one tool-free render with the gathered results', async () => {
    const h = harness('04000', 4);
    await showProPlan(h);
    const getStock = jest.spyOn(h.api, 'getStock');
    const before = h.seen.length;
    const reply = await h.turn('La de 7.5 kg, ¿tienen?', stockLoop(), [
      say('Sí, la presentación de 7.5 kg está disponible.'),
    ]);
    expect(reply).toBe('Sí, la presentación de 7.5 kg está disponible.');
    expect(h.seen.length - before).toBe(2);
    const render = h.seen.at(-1)!;
    expect(render.toolChoice).toBe('none');
    // Repeated identical reads in one turn hit the backend once.
    expect(getStock).toHaveBeenCalledTimes(1);
    const messages = render.messages as Array<{ role: string }>;
    expect(messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('an empty render falls back to a styled clarification', async () => {
    const h = harness('04000', 4);
    await showProPlan(h);
    const reply = await h.turn('oye, la de 7.5 kg ¿la tienes?', stockLoop(), [
      say(''),
    ]);
    expect(reply.trim()).not.toBe('');
    expect(reply).toBe(
      EMPTY_REPLY_FALLBACK.replace('¿Me confirma', '¿Me confirmas')
        .replace('busca?', 'buscas?')
        .replace('Disculpe', 'Disculpa')
        .replace('su consulta', 'tu consulta'),
    );
  });

  it('a failing render falls back to the clarification', async () => {
    const h = harness('04000', 4, { failAt: 3 });
    await showProPlan(h);
    const reply = await h.turn('La de 7.5 kg, ¿tienen?', stockLoop());
    expect(reply).toBe(EMPTY_REPLY_FALLBACK);
  });
});

describe('G3 lines never repeat the product name in the presentation', () => {
  it.each([
    [
      'Collar Ajustable de Nylon para Perro',
      'Collar Ajustable de Nylon para Perro Mediana',
      'Collar Ajustable de Nylon para Perro — Mediana',
    ],
    ['Ibuprofeno', '500 mg', 'Ibuprofeno — 500 mg'],
    ['Collar', 'Collares grandes', 'Collar — Collares grandes'],
    ['Croquetas', 'Croquetas', 'Croquetas'],
    ['Croquetas', undefined, 'Croquetas'],
  ])('%s + %s → %s', (name, variantName, label) => {
    expect(minimalLineLabel(name, variantName)).toBe(label);
  });

  it('cart reply and order summary show only the remainder', async () => {
    expect(
      minimalCartReply({
        ok: true,
        items: [
          {
            productId: product(COLLAR),
            variantId: variant(COLLAR, 2),
            quantity: 1,
            unitPriceCents: 14900,
            name: 'Collar Ajustable de Nylon para Perro',
            variantName: 'Collar Ajustable de Nylon para Perro Mediana',
            finalPriceCents: 14900,
            appliedPromotionTitle: null,
            discountAmountCents: 0,
          },
        ],
        totalCents: 14900,
        promotionEvaluationStatus: 'fully_evaluated',
      }),
    ).toContain(
      '• Collar Ajustable de Nylon para Perro — Mediana: 1 × $149.00 MXN',
    );
    const h = harness('04000');
    await summaryForOneCollar(h);
    const summary = await h.turn('¿me muestras el resumen?', [
      call('prepareOrder'),
      say(),
    ]);
    expect(summary).toContain(
      '• Collar Ajustable de Nylon para Perro — Mediana: 1 × $149.00 MXN',
    );
  });
});
