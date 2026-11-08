import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { OrderHistoryResponse } from '../../chatbot-api/domain/dtos/sales.dto';
import { NotFoundError, UpstreamError } from '../../chatbot-api/domain/errors';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import {
  EvalFakeApi,
  PREVIOUS_ORDER,
} from '../../../scripts/eval/fixtures/fake-api';
import type { CustomerReplyInteractive } from '../domain/customer-reply';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import {
  MinimalCatalogAgentService,
  STALE_BUTTON_LEAD,
} from './minimal-catalog-agent.service';
import { MinimalCheckoutService } from './minimal-checkout.service';
import { MinimalOrderService } from './minimal-order.service';
import { MinimalShippingService } from './minimal-shipping.service';
import {
  REORDER_EMPTY_REPLY,
  REORDER_UNAVAILABLE_REPLY,
  shortOrderDate,
} from './minimal-reorder';

/**
 * S2 (owner): ""Lo mismo de la vez pasada". El cliente recompra con un solo
 * mensaje. Es ideal para alimento, que se compra seguido." The last order is
 * re-read by productId/variantId/quantity, re-checked and re-priced today;
 * the cart is written only after the customer's yes.
 */
const SENDER = '5215550001111';
const CASHIER = '99999999-9999-4999-8999-999999999999';
const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const variant = (p: number, v: number) =>
  `b0000000-0000-4000-8000-${String(p * 100 + v).padStart(12, '0')}`;
const NUPEC = product(1);
const MINI = product(3);
const MINI_2KG = variant(3, 1);
const DOG_CHOW = product(4);

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
const REORDER = [call('getLastOrder'), say('Aquí está su pedido.')];

type Decision = {
  reply: string;
  onSent?: () => void;
  interactive?: CustomerReplyInteractive;
};
const buttons = (decision: Decision) =>
  decision.interactive?.type === 'buttons' ? decision.interactive.buttons : [];

const historyItem = (
  productId: string,
  quantity: number,
  unitPriceCents: number,
  variantId: string | null = null,
) => ({
  productId,
  variantId,
  productName: 'Nombre histórico',
  variantName: variantId === null ? null : '2 kg',
  quantity,
  unitPriceCents,
});
const orderWith = (
  items: OrderHistoryResponse['items'],
): OrderHistoryResponse => ({ ...PREVIOUS_ORDER, items });

function harness() {
  const api = new EvalFakeApi({
    kind: 'existing',
    firstName: 'Mariana',
    zip: '03100',
  });
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? CASHIER
        : { model: 'm', maxSteps: 5, historyTurns: 12 },
  } as unknown as ConfigService;
  let scripts: unknown[][] = [];
  const seen: unknown[] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    const script = scripts.shift() ?? [say()];
    let index = 0;
    return generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: async () =>
          script[index++] as Awaited<
            ReturnType<MockLanguageModelV4['doGenerate']>
          >,
      }),
    });
  };
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
  return {
    api,
    seen,
    checkout,
    turn: async (
      text: string,
      script: unknown[] = [say()],
      interactiveReplyId?: string,
    ): Promise<Decision> => {
      scripts = [script];
      const messageId = `wamid.${(n += 1)}`;
      const decision = (await agent.tryHandle({
        senderId: SENDER,
        text,
        inboundEvent: {
          receivingPhoneNumberId: '123456789012345',
          senderId: SENDER,
          messageId,
        },
        ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
      })) as Decision;
      decision.onSent?.();
      return decision;
    },
    lines: async () =>
      (
        (await store.get(SENDER))?.data.minimalCart as
          | {
              items: Array<{
                productId: string;
                variantId?: string;
                quantity: number;
              }>;
            }
          | undefined
      )?.items.map(({ productId, variantId, quantity }) => ({
        productId,
        ...(variantId === undefined ? {} : { variantId }),
        quantity,
      })) ?? [],
  };
}

const DATE = /20 oct(?: 2026)?/;

describe('S2 reorder: presenting the last order', () => {
  it('re-reads the last order with today names and prices, writes nothing and offers ✅/✏️ buttons', async () => {
    const h = harness();
    const history = jest.spyOn(h.api, 'getOrderHistory');
    const offer = await h.turn(
      'Hola, quiero lo mismo de la vez pasada',
      REORDER,
    );

    expect(history).toHaveBeenCalledWith('5550001111', '52');
    expect(offer.reply).toMatch(
      new RegExp(`^Su último pedido \\(folio EV-0099, ${DATE.source}\\) fue:`),
    );
    expect(offer.reply).toContain(
      '• Croquetas Naturales Sin Grano de Salmón y Camote para Perros Adultos de Raza Grande 18 kg: 1',
    );
    expect(offer.reply).toContain(
      '• Croquetas Royal Canin Mini Adult para Perro — 2 kg: 2',
    );
    // What was paid is the sale total only; never historical unit × qty.
    expect(offer.reply).toContain('$2597.00 MXN');
    expect(offer.reply).not.toContain('$499.00');
    expect(offer.reply).not.toContain('$998.00');
    // 2 kg went from $499 to $529: today's total, said as today's prices.
    expect(offer.reply).toContain('$2657.00 MXN');
    expect(offer.reply).toMatch(/con precios de hoy/);
    expect(offer.reply).toMatch(/¿Lo agrego igual a su carrito\?$/);
    expect(offer.reply).not.toContain('Nombre histórico');
    expect(buttons(offer)).toEqual([
      {
        id: expect.stringMatching(/^reorder_confirm:.+/) as string,
        title: '✅ Sí, agréguelo',
      },
      { id: 'reorder_change', title: '✏️ Cambiar algo' },
    ]);
    expect(await h.lines()).toEqual([]);
  });

  it('says "Precio de hoy" without the change notice when no price changed', async () => {
    const h = harness();
    h.api.history = [
      orderWith([
        historyItem(NUPEC, 2, 159900),
        historyItem(MINI, 1, 52900, MINI_2KG),
      ]),
    ];
    const offer = await h.turn('lo de siempre', REORDER);
    expect(offer.reply).toContain('• Croquetas Naturales');
    expect(offer.reply).toContain(': 2\n');
    expect(offer.reply).toContain('Precio de hoy: $3727.00 MXN.');
    expect(offer.reply).not.toMatch(/con precios de hoy/);
  });

  it('lists an out-of-stock item as such, excludes it and adds only the available ones on ✅', async () => {
    const h = harness();
    h.api.history = [
      orderWith([
        historyItem(DOG_CHOW, 3, 38900),
        historyItem(NUPEC, 1, 159900),
      ]),
    ];
    const offer = await h.turn('repetir mi último pedido', REORDER);
    expect(offer.reply).toContain(
      '• Croquetas Dog Chow Cachorro Raza Pequeña 4 kg: 3 (agotado por ahora; no lo incluyo)',
    );
    expect(offer.reply).toContain('Precio de hoy: $1599.00 MXN.');
    expect(offer.reply).toMatch(/¿Agrego los disponibles a su carrito\?$/);

    await h.turn('SÍ', [say('no se usa')], buttons(offer)[0].id);
    expect(await h.lines()).toEqual([{ productId: NUPEC, quantity: 1 }]);
  });

  it('lists a product that no longer exists as unavailable', async () => {
    const h = harness();
    const gone = '0f000000-0000-4000-8000-000000000999';
    h.api.history = [
      orderWith([historyItem(gone, 1, 10000), historyItem(NUPEC, 1, 159900)]),
    ];
    jest
      .spyOn(h.api, 'getStock')
      .mockImplementationOnce(() =>
        Promise.reject(new NotFoundError('gone', 404, {}, null)),
      );
    const offer = await h.turn('otra vez lo mismo', REORDER);
    expect(offer.reply).toContain(
      '• Nombre histórico: 1 (ya no está disponible; no lo incluyo)',
    );
    expect(buttons(offer)).toHaveLength(2);
  });

  it('with nothing available today, asks what they want and offers no buttons', async () => {
    const h = harness();
    h.api.history = [orderWith([historyItem(DOG_CHOW, 1, 38900)])];
    const offer = await h.turn('mi pedido anterior', REORDER);
    expect(offer.reply).toContain('(agotado por ahora; no lo incluyo)');
    expect(offer.reply).toMatch(/¿Qué producto busca\?$/);
    expect(offer.interactive).toBeUndefined();
    await h.turn('sí');
    expect(await h.lines()).toEqual([]);
  });

  it('no history → asks for a product, never invents items', async () => {
    const h = harness();
    h.api.history = [];
    const offer = await h.turn('¿qué pedí la última vez?', REORDER);
    expect(offer.reply).toBe(REORDER_EMPTY_REPLY);
    expect(REORDER_EMPTY_REPLY).toBe(
      'Todavía no encuentro pedidos anteriores con este número. ¿Qué producto busca?',
    );
    expect(offer.interactive).toBeUndefined();
  });

  it('a backend error → short apology and a question, never items', async () => {
    const h = harness();
    jest
      .spyOn(h.api, 'getOrderHistory')
      .mockRejectedValue(new UpstreamError('down', 503, {}, null));
    const offer = await h.turn('lo mismo de la vez pasada', REORDER);
    expect(offer.reply).toBe(REORDER_UNAVAILABLE_REPLY);
    expect(offer.reply).toMatch(/¿Qué producto busca\?$/);
    expect(offer.interactive).toBeUndefined();
    expect(await h.lines()).toEqual([]);
  });

  it('mirrors tú in the copy and the button title', async () => {
    const h = harness();
    const offer = await h.turn('oye, dame lo mismo de la vez pasada', REORDER);
    expect(offer.reply).toMatch(/^Tu último pedido/);
    expect(offer.reply).toMatch(/¿Lo agrego igual a tu carrito\?$/);
    expect(buttons(offer)[0].title).toBe('✅ Sí, agrégalo');
  });
});

describe('S2 reorder: accepting or declining', () => {
  const expected = [
    { productId: NUPEC, quantity: 1 },
    { productId: MINI, variantId: MINI_2KG, quantity: 2 },
  ];

  it('✅ adds the exact quantities once, deterministically; a second tap adds nothing', async () => {
    const h = harness();
    const offer = await h.turn('quiero lo mismo de la vez pasada', REORDER);
    const confirm = buttons(offer)[0].id;
    const calls = h.seen.length;

    const added = await h.turn('SÍ', [say('no se usa')], confirm);
    expect(h.seen).toHaveLength(calls);
    expect(await h.lines()).toEqual(expected);
    expect(added.reply).toContain('Su carrito:');
    expect(added.reply).toContain('Total de productos: $2657.00 MXN.');
    expect(added.reply).toMatch(
      /¿Desea agregar algo más o seguimos con su compra\?$/,
    );
    expect(added.interactive).toBeUndefined();

    const again = await h.turn('SÍ', [say('¿Algo más?')], confirm);
    expect(again.reply).toContain(STALE_BUTTON_LEAD);
    expect(await h.lines()).toEqual(expected);
  });

  it('a typed "sí" adds the exact quantities once without a model call', async () => {
    const h = harness();
    await h.turn('quiero lo mismo de la vez pasada', REORDER);
    const calls = h.seen.length;
    const added = await h.turn('sí');
    expect(h.seen).toHaveLength(calls);
    expect(await h.lines()).toEqual(expected);
    expect(added.reply).toContain('Su carrito:');
    // The offer is spent: another yes goes to the normal flow.
    await h.turn('sí', [say('¿Qué más necesita?')]);
    expect(await h.lines()).toEqual(expected);
  });

  it('adds on top of what is already in the cart', async () => {
    const h = harness();
    h.api.history = [orderWith([historyItem(NUPEC, 2, 159900)])];
    await h.turn('quiero lo mismo de la vez pasada', REORDER);
    await h.turn('sí');
    h.api.history = [orderWith([historyItem(NUPEC, 1, 159900)])];
    await h.turn('otra vez lo mismo', REORDER);
    await h.turn('sí');
    expect(await h.lines()).toEqual([{ productId: NUPEC, quantity: 3 }]);
  });

  it('a stale ✅ (other reference, or after another message) adds nothing', async () => {
    const h = harness();
    const offer = await h.turn('quiero lo mismo de la vez pasada', REORDER);
    const confirm = buttons(offer)[0].id;
    const forged = await h.turn('SÍ', [say()], 'reorder_confirm:other-ref');
    expect(forged.reply).toContain(STALE_BUTTON_LEAD);
    expect(await h.lines()).toEqual([]);

    const fresh = await h.turn('quiero lo mismo de la vez pasada', REORDER);
    await h.turn('¿tienen arena para gato?', [say('Busco arena.')]);
    const late = await h.turn('SÍ', [say()], buttons(fresh)[0].id);
    expect(late.reply).toContain(STALE_BUTTON_LEAD);
    await h.turn('SÍ', [say()], confirm);
    expect(await h.lines()).toEqual([]);
  });

  it('"no" keeps the cart unchanged and asks what they want', async () => {
    const h = harness();
    await h.turn('quiero lo mismo de la vez pasada', REORDER);
    const calls = h.seen.length;
    const declined = await h.turn('no');
    expect(h.seen).toHaveLength(calls);
    expect(declined.reply).toBe(
      'Entendido, no agregué nada a su carrito. ¿Qué producto busca?',
    );
    expect(await h.lines()).toEqual([]);
    await h.turn('sí', [say('¿Qué producto busca?')]);
    expect(await h.lines()).toEqual([]);
  });

  it('✏️ Cambiar algo keeps the cart unchanged, asks what to change and spends the offer', async () => {
    const h = harness();
    const offer = await h.turn('quiero lo mismo de la vez pasada', REORDER);
    const change = await h.turn(
      'Quiero cambiar algo',
      [say()],
      'reorder_change',
    );
    expect(change.reply).toBe(
      'Claro, ¿qué desea cambiar? Dígame qué productos y cuántos de cada uno.',
    );
    await h.turn('SÍ', [say()], buttons(offer)[0].id);
    expect(await h.lines()).toEqual([]);
  });

  it('reorder → sí → buy → delivery confirm → order confirm creates exactly one order with those quantities', async () => {
    const h = harness();
    await h.turn('Hola, quiero lo mismo de la vez pasada', REORDER);
    await h.turn('sí');
    const lookup = await h.checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await h.checkout.selectAddress(SENDER, lookup.addresses[0].addressRef);
    const delivery = await h.turn('quiero comprar', [
      call('confirmCheckoutDetails'),
      say(),
    ]);
    expect(delivery.reply).toContain('Confirme sus datos de entrega:');
    const summary = await h.turn('sí');
    expect(summary.reply).toContain('Resumen de su pedido:');
    expect(summary.reply).toContain('$2657.00 MXN');
    const create = jest.spyOn(h.api, 'createCheckout');
    const placed = await h.turn('sí');
    expect(placed.reply).toMatch(/folio EV-0001/);
    expect(h.api.orders.size).toBe(1);
    expect(create.mock.calls[0][0].sale.items).toEqual([
      expect.objectContaining({ productId: NUPEC, quantity: 1 }),
      expect.objectContaining({
        productId: MINI,
        variantId: MINI_2KG,
        quantity: 2,
      }),
    ]);
  });
});

describe('shortOrderDate', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');
  it('renders day and month in Mexico City time', () => {
    expect(shortOrderDate('2026-10-20T18:00:00.000Z', now)).toBe('20 oct');
    // 03:00 UTC on Oct 1 is still Sept 30 in Mexico City.
    expect(shortOrderDate('2026-10-01T03:00:00.000Z', now)).toBe('30 sep');
  });
  it('adds the year when it is not the current one', () => {
    expect(shortOrderDate('2025-12-24T18:00:00.000Z', now)).toBe('24 dic 2025');
  });
  it('is null for a missing or invalid date', () => {
    expect(shortOrderDate(null, now)).toBeNull();
    expect(shortOrderDate('not-a-date', now)).toBeNull();
  });
});
