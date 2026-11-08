import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
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
 * S3 (product photo in replies) and S5 (cart change during checkout) on the
 * real customer route with the eval's in-memory pet-store backend.
 */
const SENDER = '5215550001111';
const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const registry = new MinimalCartSelections(SENDER);
const ref = (p: number): string => {
  const reference = registry.register({
    productId: product(p),
    productName: 'Fixture',
  });
  if (reference === null) throw new Error('fixture ref');
  return reference;
};
const SILICE = 9;
const KONG = 10;
const imageOf = (n: number) => `https://cdn.example.test/p/${n}.jpg`;

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

const KONG_TEXT =
  'Encontré el Juguete Kong Classic para Perro en nuestro catálogo, desde $249.00. ¿Qué tamaño busca?';
const BOTH_ARENAS =
  'Encontré dos opciones:\n1. Arena para Gato de Sílice 3.8 L, $179.00\n2. Arena para Gato Aglomerante Sin Aroma: 10 kg $219.00 o 20 kg $389.00\n¿Cuál desea?';

function harness(
  images: Record<number, string | null> = {},
  customer: 'new' | '03100' = '03100',
) {
  const api = new EvalFakeApi(
    customer === 'new'
      ? { kind: 'new' }
      : { kind: 'existing', firstName: 'Mariana', zip: customer },
  );
  // Every fixture product gets a public JPEG unless the test overrides it.
  const search = api.searchCatalog.bind(api);
  api.searchCatalog = async (q: string, limit?: number) =>
    (await search(q, limit)).map((item) => {
      const n = Number(item.productId.slice(-12));
      return {
        ...item,
        imageUrl: n in images ? images[n] : imageOf(n),
      };
    });
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
  let scripts: unknown[][] = [];
  const generate: GenerateTextFn = async (input) => {
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
    return result;
  };
  return { api, checkout, turn };
}

describe('S3 product photo in replies', () => {
  it('a single search hit presented by the model carries its photo, captioned with the product name only', async () => {
    const h = harness();
    const result = await h.turn('¿Tienen kong?', [
      call('searchCatalog', { q: 'kong' }),
      say(KONG_TEXT),
    ]);
    expect(result.reply).toBe(KONG_TEXT);
    expect(result.media).toEqual([
      {
        kind: 'image',
        url: imageOf(KONG),
        caption: 'Juguete Kong Classic para Perro',
      },
    ]);
  });

  it('never resends the same product photo later in the conversation', async () => {
    const h = harness();
    await h.turn('¿Tienen kong?', [
      call('searchCatalog', { q: 'kong' }),
      say(KONG_TEXT),
    ]);
    const again = await h.turn('¿y el kong cuánto cuesta?', [
      call('searchCatalog', { q: 'kong' }),
      say(KONG_TEXT),
    ]);
    expect(again.media).toBeUndefined();
  });

  it('a list of several products carries no photo', async () => {
    const h = harness();
    const result = await h.turn(
      'Buen día. Deseo comprar una arena para gato.',
      [call('searchCatalog', { q: 'arena para gato' }), say(BOTH_ARENAS)],
    );
    expect(result.media).toBeUndefined();
  });

  it('one product presented out of several search hits carries only its photo', async () => {
    const h = harness();
    const result = await h.turn('¿Tienen arena de sílice?', [
      call('searchCatalog', { q: 'arena de sílice para gato' }),
      say(
        'Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo, $179.00. ¿Se la agrego al carrito?',
      ),
    ]);
    expect(result.media).toEqual([
      {
        kind: 'image',
        url: imageOf(SILICE),
        caption: 'Arena para Gato de Sílice 3.8 L',
      },
    ]);
  });

  it.each<[string, string | null]>([
    ['null', null],
    ['plain http', 'http://cdn.example.test/p/10.jpg'],
    ['relative', '/p/10.jpg'],
    ['webp', 'https://cdn.example.test/p/10.webp'],
    ['gif', 'https://cdn.example.test/p/10.gif'],
    ['no extension', 'https://cdn.example.test/p/10'],
    ['extension only in the query', 'https://cdn.example.test/p/10?f=a.jpg'],
  ])('skips a %s imageUrl (text only)', async (_label, url) => {
    const h = harness({ [KONG]: url });
    const result = await h.turn('¿Tienen kong?', [
      call('searchCatalog', { q: 'kong' }),
      say(KONG_TEXT),
    ]);
    expect(result.reply).toBe(KONG_TEXT);
    expect(result.media).toBeUndefined();
  });

  it.each([
    'https://cdn.example.test/p/10.JPEG',
    'https://cdn.example.test/p/10.png?v=3',
    'https://cdn.example.test/p/10.jpeg#frag',
  ])('accepts a JPEG/PNG imageUrl (%s)', async (url) => {
    const h = harness({ [KONG]: url });
    const result = await h.turn('¿Tienen kong?', [
      call('searchCatalog', { q: 'kong' }),
      say(KONG_TEXT),
    ]);
    expect(result.media).toEqual([
      { kind: 'image', url, caption: 'Juguete Kong Classic para Perro' },
    ]);
  });

  it('a product just added to the cart carries its photo once (image remembered from an earlier list)', async () => {
    const h = harness();
    await h.turn('Buen día. Deseo comprar una arena para gato.', [
      call('searchCatalog', { q: 'arena para gato' }),
      say(BOTH_ARENAS),
    ]);
    const added = await h.turn('Agrégueme una de sílice', [
      adjust(ref(SILICE), 1, 'una'),
      say(),
    ]);
    expect(added.reply).toContain('Su carrito');
    expect(added.media).toEqual([
      {
        kind: 'image',
        url: imageOf(SILICE),
        caption: 'Arena para Gato de Sílice 3.8 L',
      },
    ]);
    const more = await h.turn('Agrégueme otra', [
      adjust(ref(SILICE), 1, 'otra'),
      say(),
    ]);
    expect(more.reply).toContain('Su carrito');
    expect(more.media).toBeUndefined();
  });

  it('a product photo found from a customer photo is attached like a single search hit', async () => {
    const h = harness();
    const result = await h.turn(
      '\n[Imagen enviada por el cliente: juguete de hule rojo marca Kong]',
      [call('searchCatalog', { q: 'kong' }), say(KONG_TEXT)],
    );
    expect(result.media).toEqual([
      {
        kind: 'image',
        url: imageOf(KONG),
        caption: 'Juguete Kong Classic para Perro',
      },
    ]);
  });
});

describe('S5 cart change during checkout', () => {
  /** Sílice in the cart, delivery confirmed and the order summary shown. */
  async function toOrderSummary(h: ReturnType<typeof harness>) {
    await h.turn('Buen día. Deseo comprar una arena para gato.', [
      call('searchCatalog', { q: 'arena para gato' }),
      say(BOTH_ARENAS),
    ]);
    await h.turn('Agrégueme una de sílice', [
      adjust(ref(SILICE), 1, 'una'),
      say(),
    ]);
    const lookup = await h.checkout.lookup(SENDER, null);
    if (!lookup.ok || lookup.status !== 'unique') throw new Error('lookup');
    await h.turn('Sí, a mi dirección de casa', [
      call('selectCheckoutAddress', {
        addressRef: lookup.addresses[0].addressRef,
      }),
      call('confirmCheckoutDetails'),
      say(),
    ]);
    const summary = await h.turn('sí');
    expect(summary.reply).toContain('Resumen de su pedido:');
    expect(summary.media).toBeUndefined();
    return summary;
  }

  it('a quantity change re-presented through the checkout tools leads with the update, never the cart listing', async () => {
    const h = harness();
    await toOrderSummary(h);
    const changed = await h.turn('sí pero cambia la cantidad a 2', [
      call('searchCatalog', { q: 'arena de sílice' }),
      call('setCartItem', {
        selectionRef: ref(SILICE),
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      call('confirmCheckoutDetails'),
      call('prepareOrder'),
      say(),
    ]);
    expect(changed.reply.startsWith('Listo, actualicé su carrito.')).toBe(true);
    expect(changed.reply).not.toContain('Su carrito:');
    expect(changed.reply).toContain('Resumen de su pedido:');
    expect(changed.reply).toContain(': 2 × $179.00 MXN');
    expect(changed.media).toBeUndefined();
  });

  it('a quantity change with only the cart tool also leads with the update', async () => {
    const h = harness();
    await toOrderSummary(h);
    const changed = await h.turn('cambia la cantidad a 2', [
      call('searchCatalog', { q: 'arena de sílice' }),
      call('setCartItem', {
        selectionRef: ref(SILICE),
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      say(),
    ]);
    expect(changed.reply.startsWith('Listo, actualicé su carrito.')).toBe(true);
    expect(changed.reply).not.toContain('Su carrito:');
    expect(changed.reply).toContain('Resumen de su pedido:');
    expect(changed.media).toBeUndefined();
  });

  it('a tú customer gets "Listo, actualicé tu carrito."', async () => {
    const h = harness();
    await toOrderSummary(h);
    const changed = await h.turn('oye, cambia la cantidad a 2 porfa', [
      call('searchCatalog', { q: 'arena de sílice' }),
      call('setCartItem', {
        selectionRef: ref(SILICE),
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
      call('confirmCheckoutDetails'),
      call('prepareOrder'),
      say(),
    ]);
    expect(changed.reply.startsWith('Listo, actualicé tu carrito.')).toBe(true);
  });
});
