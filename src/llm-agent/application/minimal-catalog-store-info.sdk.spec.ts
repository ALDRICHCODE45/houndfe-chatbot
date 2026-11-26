import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { BranchInfo } from '../../chatbot-api/domain/dtos/branch.dto';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { CatalogItemResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import type { CartItemInput } from '../../chatbot-api/domain/dtos/pricing.dto';
import { UpstreamError } from '../../chatbot-api/domain/errors';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import type { MinimalOrderService } from './minimal-order.service';
import type { MinimalShippingService } from './minimal-shipping.service';

/**
 * T2 H2/H5 (S1-S3): «¿dónde están?», «¿a qué hora abren?» → the model calls
 * getStoreInfo; the application answers with the backend branch (the shared
 * store block: bold name, address, «*Horario:*»; null parts left out) and
 * attaches the store pin when the branch has coordinates. Unavailable (both
 * parts null, backend error or drift) → the tool says so and the model's own
 * reply stands; the application never writes an address or hours it did
 * not read.
 */
const SENDER = '5215550001111';
const MODEL_TEXT = 'Por ahora no puedo confirmarlo.';
const ADDRESS =
  'Av. Insurgentes Sur 1000, Del Valle, Benito Juárez, Ciudad de México, 03100';
const HOURS = 'Lunes a sábado: 09:00–19:00. Domingo: 10:00–14:00.';
const NAME = 'Tienda de mascotas HoundFe — Sucursal Centro';
const STORE_USTED = `Nos encuentra en *${NAME}*\n${ADDRESS}\n*Horario:* ${HOURS}`;
const STORE_TU = `Nos encuentras en *${NAME}*\n${ADDRESS}\n*Horario:* ${HOURS}`;
const PIN = {
  latitude: 19.3907,
  longitude: -99.1716,
  name: NAME,
  address: ADDRESS,
};
/** T2-fix J8: the spec's own branch fixture (no eval import). */
const BRANCH: BranchInfo = {
  name: NAME,
  address: {
    addressLine1: 'Av. Insurgentes Sur 1000',
    addressLine2: null,
    neighborhood: 'Del Valle',
    municipality: 'Benito Juárez',
    state: 'Ciudad de México',
    postalCode: '03100',
    formatted: ADDRESS,
  },
  hours: { timeZone: 'America/Mexico_City', days: [], summary: HOURS },
  location: { latitude: PIN.latitude, longitude: PIN.longitude },
};
const BRANCH_WITHOUT_LOCATION: BranchInfo = { ...BRANCH, location: null };
/** T2-fix J5: the fixed server line when the branch cannot be read. */
const UNAVAILABLE =
  'Por ahora no puedo confirmar la dirección ni el horario de la sucursal.';
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
// Catalog fixture id 9: arena de sílice.
const SILICE = 9;

/**
 * T2-fix-2 K5: the spec's own catalog (no scripts/eval import): two cat
 * litters, found by any query that names «arena».
 */
const LITTERS: ReadonlyArray<{
  n: number;
  name: string;
  priceCents: number;
  status: 'available' | 'low_stock';
  quantity: number;
}> = [
  {
    n: 8,
    name: 'Arena para Gato Aglomerante Sin Aroma 10 kg',
    priceCents: 21900,
    status: 'available',
    quantity: 20,
  },
  {
    n: SILICE,
    name: 'Arena para Gato de Sílice 3.8 L',
    priceCents: 17900,
    status: 'low_stock',
    quantity: 2,
  },
];
const litterItem = (litter: (typeof LITTERS)[number]): CatalogItemResponse => ({
  productId: product(litter.n),
  name: litter.name,
  brand: "Pet's Choice",
  imageUrl: `https://cdn.example.test/products/${product(litter.n)}.jpg`,
  description: 'Arena para gato.',
  price: {
    priceCents: litter.priceCents,
    fromPriceCents: null,
    promoPriceCents: null,
    promotionEvaluationStatus: 'needs_human_review',
  },
  stock: { status: litter.status, quantity: litter.quantity },
  packageInfo: { weightGrams: null, dimensions: null },
  variants: [],
});
const litterById = (productId: string) =>
  LITTERS.find((litter) => product(litter.n) === productId);

/** The fake backend: catalog, stock, pricing and the branch read. */
function storeFakeApi(getBranch: () => Promise<BranchInfo>) {
  return {
    searchCatalog: (q: string) =>
      Promise.resolve(/arena/i.test(q) ? LITTERS.map(litterItem) : []),
    getStock: (productId: string) => {
      const litter = litterById(productId);
      if (litter === undefined) return Promise.reject(new Error('404'));
      return Promise.resolve({
        productId,
        name: litter.name,
        stock: { status: litter.status, quantity: litter.quantity },
        variants: [],
      });
    },
    evaluateCart: (items: CartItemInput[]) =>
      Promise.resolve({
        items: items.map((item) => {
          const unit = litterById(item.productId)?.priceCents ?? 0;
          return {
            productId: item.productId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
            unitPriceCents: unit,
            originalPriceCents: unit * item.quantity,
            finalPriceCents: unit * item.quantity,
            appliedPromotionTitle: null,
            discountAmountCents: 0,
          };
        }),
        promotionEvaluationStatus: 'fully_evaluated' as const,
        customerResolution: 'not_found' as const,
      }),
    getCustomerByPhone: () => Promise.resolve({ found: false, customer: null }),
    getBranch,
  } as Partial<ChatbotApiClient>;
}

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
const say = (text = MODEL_TEXT) => step([{ type: 'text', text }], 'stop');

function world(
  options: {
    branch?: BranchInfo | Error;
    /** A client without getBranch (hand-built fakes, older wiring). */
    noBranchRead?: true;
    /** T2-fix J3: the real cart service on the fake backend. */
    cart?: true;
    /** T2-fix J3/J5: the askTeam route. */
    team?: true;
  } = {},
) {
  const getBranch = jest.fn(() =>
    options.branch instanceof Error
      ? Promise.reject(options.branch)
      : Promise.resolve(structuredClone(options.branch ?? BRANCH)),
  );
  const fake = storeFakeApi(getBranch);
  if (options.noBranchRead === true) delete fake.getBranch;
  const api = fake as ChatbotApiClient;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 8, historyTurns: 12 },
  } as unknown as ConfigService;
  const outputs: Array<{ toolName: string; output: unknown }> = [];
  const systems: string[] = [];
  const toolNames: string[][] = [];
  let scripts: unknown[][] = [];
  const generate: GenerateTextFn = async (input) => {
    systems.push(input.system as string);
    toolNames.push(Object.keys(input.tools ?? {}));
    const result = await generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: scripts.shift() ?? [say()],
      } as never),
    });
    for (const s of result.steps)
      for (const r of s.toolResults)
        outputs.push({ toolName: r.toolName, output: r.output });
    return result;
  };
  const sessions = new InMemoryMinimalCatalogSessionStore();
  const askTeam = jest.fn(() =>
    Promise.resolve({ kind: 'registered' as const, requestId: null }),
  );
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    sessions,
    undefined,
    undefined,
    options.cart === true
      ? new MinimalCartService(api, new InMemoryConversationStore())
      : undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.team === true ? { askTeam } : undefined,
  );
  const turn = (text: string, runs: unknown[][]) => {
    scripts = runs;
    return agent.tryHandle({ senderId: SENDER, text });
  };
  const storeOutputs = () =>
    outputs.filter((o) => o.toolName === 'getStoreInfo').map((o) => o.output);
  /** The assistant message the session history recorded last. */
  const lastRecorded = () =>
    sessions.read(SENDER).at(-1)?.messages.at(-1)?.content;
  return { turn, getBranch, systems, toolNames, storeOutputs, lastRecorded };
}

/** A fresh script each time (a turn consumes its script). */
const asksStore = () => [
  [call('getStoreInfo'), say('Estamos en Av. Inventada 1.')],
];

describe('T2: store location and hours (getStoreInfo)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('H5: the tool and one instruction are offered when the branch read exists', async () => {
    const w = world();
    await w.turn('Hola', [[say('Hola')]]);
    expect(w.toolNames[0]).toContain('getStoreInfo');
    expect(w.systems[0]).toContain('Herramienta getStoreInfo');
    expect(w.systems[0]).toMatch(/nunca escriba una dirección ni un horario/i);
  });

  it('H5: no tool and no instruction without a branch read', async () => {
    const w = world({ noBranchRead: true });
    await w.turn('Hola', [[say('Hola')]]);
    expect(w.toolNames[0]).not.toContain('getStoreInfo');
    expect(w.systems[0]).not.toContain('getStoreInfo');
  });

  it('H2/H3: usted — the application answers with the store block and attaches the pin', async () => {
    const w = world();
    const decision = await w.turn(
      '¿Dónde están y a qué hora abren?',
      asksStore(),
    );
    expect(decision.reply).toBe(STORE_USTED);
    expect(decision.location).toEqual(PIN);
    expect(w.storeOutputs()).toEqual([
      { ok: true, presentedByApplication: true },
    ]);
    // The model's own text (an invented address) is never sent.
    expect(decision.reply).not.toContain('Inventada');
  });

  it('H2: tú form for a customer who tutea', async () => {
    const decision = await world().turn(
      'oye, ¿dónde quedan? ¿abres el domingo?',
      asksStore(),
    );
    expect(decision.reply).toBe(STORE_TU);
  });

  it('H2: hours null → address only (no «Horario» line)', async () => {
    const decision = await world({
      branch: { ...BRANCH, hours: null },
    }).turn('¿Dónde están?', asksStore());
    expect(decision.reply).toBe(`Nos encuentra en *${NAME}*\n${ADDRESS}`);
    expect(decision.reply).not.toContain('Horario');
  });

  it('H2: address null → name and hours (the pin without an address label)', async () => {
    const decision = await world({
      branch: { ...BRANCH, address: null },
    }).turn('¿A qué hora abren?', asksStore());
    expect(decision.reply).toBe(
      `Nos encuentra en *${NAME}*\n*Horario:* ${HOURS}`,
    );
    expect(decision.location).toEqual({
      latitude: PIN.latitude,
      longitude: PIN.longitude,
      name: NAME,
    });
  });

  it('H4/H3: no coordinates → the same text and no pin', async () => {
    const decision = await world({
      branch: BRANCH_WITHOUT_LOCATION,
    }).turn('¿Dónde están y a qué hora abren?', asksStore());
    expect(decision.reply).toBe(STORE_USTED);
    expect(decision).not.toHaveProperty('location');
  });

  it.each([
    ['address and hours both null', { ...BRANCH, address: null, hours: null }],
    ['a 5xx / drift (UpstreamError)', new UpstreamError('invalid', 502)],
    ['a network failure', new Error('ECONNRESET')],
  ])(
    'H2/J5: %s → unavailable; the fixed server line replaces the model text',
    async (_name, branch) => {
      const w = world({ branch });
      const decision = await w.turn('¿Dónde están?', [
        [call('getStoreInfo'), say(MODEL_TEXT)],
      ]);
      expect(w.storeOutputs()).toEqual([
        { ok: false, error: 'store_info_unavailable' },
      ]);
      expect(decision.reply).toBe(UNAVAILABLE);
      expect(decision).not.toHaveProperty('location');
      expect(decision.reply).not.toContain(NAME);
    },
  );

  it('H2: once per turn — a second call is refused and the backend is read once', async () => {
    const w = world();
    const decision = await w.turn('¿Dónde están?', [
      [call('getStoreInfo'), call('getStoreInfo'), say()],
    ]);
    expect(w.storeOutputs()).toEqual([
      { ok: true, presentedByApplication: true },
      { ok: false, error: 'store_info_settled' },
    ]);
    expect(w.getBranch).toHaveBeenCalledTimes(1);
    expect(decision.reply).toBe(STORE_USTED);
  });

  it('a turn that never asks keeps the model reply and carries no pin', async () => {
    const decision = await world().turn('Hola', [[say('¡Hola!')]]);
    expect(decision.reply).toBe('¡Hola!');
    expect(decision).not.toHaveProperty('location');
  });

  describe('T2-fix', () => {
    const search = (q: string) => call('searchCatalog', { q });
    const add = (p: number) =>
      call('adjustCartItem', {
        selectionRef: ref(p),
        delta: 1,
        quantityText: 'una',
        continuation: false,
      });

    it('J2: «¿tienen arena y dónde están?» → the catalog answer, then the store block and the pin; history keeps both', async () => {
      const text = '¿Tienen arena para gato y dónde están?';
      const base = await world().turn(text, [
        [search('arena para gato'), say('Sí tenemos.')],
      ]);
      const w = world();
      const decision = await w.turn(text, [
        [search('arena para gato'), call('getStoreInfo'), say('Sí tenemos.')],
      ]);
      expect(base.reply).toContain('Arena');
      expect(decision.reply).toBe(`${base.reply}\n\n${STORE_USTED}`);
      expect(decision.location).toEqual(PIN);
      expect(decision.media).toEqual(base.media);
      expect(w.lastRecorded()).toBe(decision.reply);
    });

    it('J2: the prompt says the application appends the store block (the model never writes it)', async () => {
      const w = world();
      await w.turn('Hola', [[say('Hola')]]);
      expect(w.systems[0]).toContain(
        'la aplicación agrega a su mensaje la dirección, el horario y la ubicación',
      );
      expect(w.systems[0]).toContain('store_info_deferred');
    });

    it('J3: «agrega la arena y ¿dónde están?» → the cart reply (buttons kept), then the store block and the pin', async () => {
      const text = 'agrega una arena de sílice y ¿dónde están?';
      const base = await world({ cart: true }).turn(text, [
        [search('arena sílice'), add(SILICE), say()],
      ]);
      const w = world({ cart: true });
      const decision = await w.turn(text, [
        [search('arena sílice'), add(SILICE), call('getStoreInfo'), say()],
      ]);
      expect(base.interactive).toBeDefined();
      expect(decision.reply).toBe(`${base.reply}\n\n${STORE_TU}`);
      expect(decision.interactive).toEqual(base.interactive);
      expect(decision.media).toEqual(base.media);
      expect(decision.location).toEqual(PIN);
      expect(w.storeOutputs()).toEqual([
        { ok: true, presentedByApplication: true },
      ]);
      expect(w.lastRecorded()).toBe(decision.reply);
    });

    it('J3: askTeam wins the turn → its reply, then the store block', async () => {
      const text = '¿Tienen estacionamiento? ¿Y dónde están?';
      const runs = (store: boolean) => [
        [
          ...(store ? [call('getStoreInfo')] : []),
          call('askTeam', {
            question: '¿Tienen estacionamiento?',
            summary: 'Pregunta por estacionamiento',
          }),
          say(),
        ],
      ];
      const base = await world({ team: true }).turn(text, runs(false));
      const decision = await world({ team: true }).turn(text, runs(true));
      expect(decision.reply).toBe(`${base.reply}\n\n${STORE_USTED}`);
      expect(decision.location).toEqual(PIN);
    });

    it('J5: unavailable + a model text inventing «Av. Reforma 222» → only the fixed line (tú) and the askTeam offer', async () => {
      const w = world({ branch: new Error('ECONNRESET'), team: true });
      const decision = await w.turn('oye, ¿dónde quedan?', [
        [
          call('getStoreInfo'),
          say('Estamos en Av. Reforma 222, abrimos de 9 a 7.'),
        ],
      ]);
      expect(decision.reply).toBe(
        `${UNAVAILABLE} Si quieres, lo consulto con el equipo.`,
      );
      expect(decision.reply).not.toContain('Reforma');
      expect(w.lastRecorded()).toBe(decision.reply);
    });

    it('J5: unavailable next to a catalog answer → the options, then the fixed line', async () => {
      const text = '¿Tienen arena para gato y dónde están?';
      const base = await world().turn(text, [
        [search('arena para gato'), say('x')],
      ]);
      const decision = await world({
        branch: new UpstreamError('invalid', 502),
      }).turn(text, [
        [
          search('arena para gato'),
          call('getStoreInfo'),
          say('Av. Reforma 222'),
        ],
      ]);
      expect(decision.reply).toBe(`${base.reply}\n\n${UNAVAILABLE}`);
    });

    it('K2: «¿la arena 9 tiene existencias? ¿y dónde están?» with the backend down → the stock answer kept, then the fixed line', async () => {
      const stockAnswer = 'Sí, la arena de sílice tiene existencias.';
      const w = world({ branch: new UpstreamError('invalid', 502) });
      const decision = await w.turn(
        '¿La arena de sílice tiene existencias? ¿Y dónde están?',
        [
          [
            search('arena sílice'),
            call('checkStock', { productId: product(SILICE) }),
            call('getStoreInfo'),
            say(stockAnswer),
          ],
        ],
      );
      expect(w.storeOutputs()).toEqual([
        { ok: false, error: 'store_info_unavailable' },
      ]);
      expect(decision.reply).toBe(`${stockAnswer}\n\n${UNAVAILABLE}`);
      expect(w.lastRecorded()).toBe(decision.reply);
    });

    it('K1: the fragment says «paso a recoger» while choosing delivery or pickup chooses pickup (chooseStorePickup)', async () => {
      const w = world();
      await w.turn('Hola', [[say('Hola')]]);
      expect(w.systems[0]).toContain(
        'Si el cliente está eligiendo entre envío a domicilio y recoger en tienda, «paso a recoger» o «lo recojo» eligen recoger en tienda: llame chooseStorePickup, no getStoreInfo',
      );
    });

    it('J6: a failed read logs the upstream status and error code; an unconfigured branch logs its own line', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await world({
        branch: new UpstreamError('invalid', 503, {}, 'BRANCH_DOWN'),
      }).turn('¿Dónde están?', asksStore());
      await world({
        branch: { ...BRANCH, address: null, hours: null },
      }).turn('¿Dónde están?', asksStore());
      const logged = warn.mock.calls.map(([line]) => String(line));
      expect(
        logged.some((line) =>
          /getStoreInfo read failed .*status=503 errorCode=BRANCH_DOWN/.test(
            line,
          ),
        ),
      ).toBe(true);
      expect(
        logged.some((line) =>
          line.includes('getStoreInfo branch_unconfigured'),
        ),
      ).toBe(true);
      expect(logged.join('\n')).not.toContain(SENDER);
    });

    it('J8: pin labels are capped on a word boundary (name ≤ 100, address ≤ 250)', async () => {
      const longName = `Sucursal ${'Centro Histórico '.repeat(10)}`.trim();
      const longAddress = `Av. ${'Insurgentes Sur '.repeat(20)}1000`;
      const decision = await world({
        branch: {
          ...BRANCH,
          name: longName,
          address: { ...BRANCH.address!, formatted: longAddress },
        },
      }).turn('¿Dónde están?', asksStore());
      const pin = decision.location!;
      expect(Array.from(pin.name!).length).toBeLessThanOrEqual(100);
      expect(Array.from(pin.address!).length).toBeLessThanOrEqual(250);
      expect(pin.name!.endsWith('…')).toBe(true);
      expect(pin.address!.endsWith('…')).toBe(true);
      expect(longName.startsWith(pin.name!.slice(0, -1))).toBe(true);
      expect(pin.name!.slice(0, -1)).toMatch(/\S$/);
      expect(longName.charAt(pin.name!.length - 1)).toBe(' ');
    });

    /** T2-fix J7 / T2-fix-2 K5: an agent on fakes whose order step returns a placed pickup order (its reply carries the store pin, T2 H4). */
    const pickupOrderAgent = (
      parts: {
        cart?: Partial<MinimalCartService>;
        sessions?: InMemoryMinimalCatalogSessionStore;
      } = {},
    ) => {
      const config = {
        get: (key: string) =>
          key === 'chatbotApi.cashierUserId'
            ? ''
            : { model: 'm', maxSteps: 8, historyTurns: 12 },
      } as unknown as ConfigService;
      const placedPickupOrder = {
        enabled: true,
        offerStatus: () => null,
        dismiss: () => undefined,
        consume: () => Promise.resolve(null),
        prepareOrder: () =>
          Promise.resolve({ reply: '*¡Pedido registrado!* ✅', location: PIN }),
      } as unknown as MinimalOrderService;
      const shipping = {
        chooseStorePickup: () => Promise.resolve({ kind: 'pickup' }),
      } as unknown as MinimalShippingService;
      const cart = {
        fingerprint: () => Promise.resolve('ref1'),
        ...parts.cart,
      } as unknown as MinimalCartService;
      return new MinimalCatalogAgentService(
        storeFakeApi(() => Promise.resolve(BRANCH)) as ChatbotApiClient,
        () => Promise.reject(new Error('no model')),
        new CostGuardService(100000),
        config,
        parts.sessions ?? new InMemoryMinimalCatalogSessionStore(),
        undefined,
        undefined,
        cart,
        undefined,
        placedPickupOrder,
        shipping,
      );
    };

    it('J7: [Recoger en tienda] continuing to an order reply with a pin forwards the pin', async () => {
      const decision = await pickupOrderAgent().tryHandle({
        senderId: SENDER,
        text: 'Recoger en tienda',
        interactiveReplyId: 'fulfil_pickup:ref1',
      });
      expect(decision.reply).toContain('*¡Pedido registrado!* ✅');
      expect(decision.location).toEqual(PIN);
    });

    it('K5: a «sí» to the reorder offer continuing to a pickup order reply forwards its pin (answerReorder)', async () => {
      const sessions = new InMemoryMinimalCatalogSessionStore();
      sessions.write(SENDER, [
        {
          messages: [
            { role: 'user', content: 'lo mismo de la vez pasada' },
            { role: 'assistant', content: '¿Se lo agrego?' },
          ],
          verifiedProductIds: [],
          reorderOffer: {
            reference: 'r1',
            items: [{ productId: product(SILICE), quantity: 1 }],
          },
        },
      ]);
      const addItems = jest.fn(() =>
        Promise.resolve({ ok: true, items: [], totalCents: 0 }),
      );
      const decision = await pickupOrderAgent({
        sessions,
        // The checkout already chose pickup: the yes continues to the order.
        cart: {
          addItems,
          shippingMode: () => Promise.resolve('pickup'),
        } as unknown as Partial<MinimalCartService>,
      }).tryHandle({ senderId: SENDER, text: 'sí' });
      expect(addItems).toHaveBeenCalledTimes(1);
      expect(decision.reply).toContain('*¡Pedido registrado!* ✅');
      expect(decision.location).toEqual(PIN);
    });
  });
});
