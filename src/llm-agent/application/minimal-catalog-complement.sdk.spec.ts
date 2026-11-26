import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import { InMemoryCustomerProfileStore } from '../../customer-profile/infrastructure/in-memory-customer-profile.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MINIMAL_CART_NEXT_STEP_QUESTION } from './minimal-cart.service';
import { MinimalCartService } from './minimal-cart.service';
import type { MinimalOrderService } from './minimal-order.service';
import type { MinimalPaymentService } from './minimal-payment.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * T3 (S4-S6): after a cart add the model may propose ONE complementary
 * product it read in this chat (suggestComplement); the application checks
 * it and appends a server-owned line before the next-step question. At most
 * one per sender per 24 h (persisted on the customer profile).
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
// Catalog fixture ids: 4 Dog Chow (agotado), 5 Whiskas, 9 arena de sílice.
const DOG_CHOW = 4;
const WHISKAS = 5;
const SILICE = 9;
const LINE_USTED =
  'Por si le sirve: *Arena para Gato de Sílice 3.8 L* ($179.00) suele ir bien con lo que eligió.';
const LINE_TU =
  '💡 Por si te sirve: *Arena para Gato de Sílice 3.8 L* ($179.00) suele ir bien con lo que elegiste.';
const QUESTION_TU = '¿Quieres agregar algo más o seguimos con tu compra?';

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
const say = (text = 'Texto del modelo con su propia oferta.') =>
  step([{ type: 'text', text }], 'stop');
const search = (q: string) => call('searchCatalog', { q });
const add = (p: number, text = 'una', quantity = 1) =>
  call('setCartItem', {
    selectionRef: ref(p),
    quantity,
    quantityText: text,
    continuation: false,
  });
const suggest = (p: number | string) =>
  call('suggestComplement', {
    productId: typeof p === 'number' ? product(p) : p,
  });
/** Set Whiskas to `quantity` units, then suggest `p` (all read by
 *  searchCatalog first). T3-fix E6: only a set that raises the units is an
 *  add, so a later turn passes a higher quantity. */
const addAndSuggest = (
  p: number | string = SILICE,
  quantity = 1,
  text = 'una',
) => [
  [
    search('whiskas'),
    search('arena sílice'),
    search('dog chow cachorro'),
    add(WHISKAS, text, quantity),
    suggest(p),
    say(),
  ],
];

type ToolOutput = { toolName: string; output: unknown };

function world(
  options: {
    profiles?: false;
    unpaidOrder?: true;
    pendingSummary?: true;
    /** E2: every profile write fails (reads still work). */
    failingWrites?: true;
    /** E7: patch the fake backend (prices, stock reads). */
    patchApi?: (api: EvalFakeApi) => void;
  } = {},
) {
  const profileStore = new InMemoryCustomerProfileStore();
  if (options.failingWrites === true)
    jest
      .spyOn(profileStore, 'upsert')
      .mockRejectedValue(new Error('profile db down'));
  const conversations = new InMemoryConversationStore();
  const clock = { now: new Date('2026-11-26T12:00:00.000Z') };
  const outputs: ToolOutput[] = [];
  const systems: string[] = [];
  const boot = () => {
    const api = new EvalFakeApi({ kind: 'new' });
    options.patchApi?.(api);
    const config = {
      get: (key: string) =>
        key === 'chatbotApi.cashierUserId'
          ? ''
          : { model: 'm', maxSteps: 8, historyTurns: 12 },
    } as unknown as ConfigService;
    let scripts: unknown[][] = [];
    const generate: GenerateTextFn = async (input) => {
      const script = scripts.shift() ?? [say()];
      systems.push(input.system as string);
      const result = await generateText({
        ...input,
        model: new MockLanguageModelV4({ doGenerate: script } as never),
      });
      for (const s of result.steps)
        for (const r of s.toolResults)
          outputs.push({ toolName: r.toolName, output: r.output });
      return result;
    };
    const profiles =
      options.profiles === false
        ? undefined
        : new CustomerProfileService(profileStore, () => clock.now);
    const payment =
      options.unpaidOrder === true
        ? ({
            placedSale: () => Promise.resolve({ paid: false }),
          } as unknown as MinimalPaymentService)
        : undefined;
    // A pending order summary (its SÍ gate armed): only its status is read.
    const order =
      options.pendingSummary === true
        ? ({
            enabled: false,
            offerStatus: () => ({ stage: 'pending' }),
            dismiss: () => undefined,
          } as unknown as MinimalOrderService)
        : undefined;
    const sessions = new InMemoryMinimalCatalogSessionStore();
    const agent = new MinimalCatalogAgentService(
      api,
      generate,
      new CostGuardService(100000),
      config,
      sessions,
      undefined,
      undefined,
      new MinimalCartService(api, conversations),
      undefined,
      order,
      undefined,
      profiles,
      undefined,
      undefined,
      payment,
    );
    const turn = async (text: string, runs: unknown[][]) => {
      scripts = runs;
      return agent.tryHandle({ senderId: SENDER, text });
    };
    return { turn, sessions, api };
  };
  const suggestOutputs = () =>
    outputs
      .filter((o) => o.toolName === 'suggestComplement')
      .map((o) => o.output);
  const toolOutputs = (name: string) =>
    outputs.filter((o) => o.toolName === name).map((o) => o.output);
  return { boot, clock, suggestOutputs, toolOutputs, systems, profileStore };
}

describe('T3: complementary suggestion after a cart add (S4-S6)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('D1/D5: the bounded rule replaces «sin upsell», with the decline rule', async () => {
    const w = world();
    await w.boot().turn('quiero una whiskas', [[search('whiskas'), say()]]);
    const system = w.systems[0];
    expect(system).not.toContain('sin upsell');
    expect(system).toContain(
      'sin ofrecer otros productos por tu cuenta (una sugerencia complementaria solo con suggestComplement, si está disponible)',
    );
    expect(system).toContain(
      'Nunca la llame si en esta conversación el cliente rechazó una sugerencia o pidió no recibir sugerencias.',
    );
    const off = world({ profiles: false });
    await off.boot().turn('quiero una whiskas', [[search('whiskas'), say()]]);
    expect(off.systems[0]).not.toContain('Herramienta suggestComplement');
  });

  it('D3: one server-owned line right before the next-step question, never the model text', async () => {
    const w = world();
    const decision = await w
      .boot()
      .turn('quiero una whiskas y arena', addAndSuggest());
    expect(decision.reply).toContain(
      `\n\n${LINE_USTED}\n\n${MINIMAL_CART_NEXT_STEP_QUESTION}`,
    );
    expect(decision.reply.endsWith(MINIMAL_CART_NEXT_STEP_QUESTION)).toBe(true);
    expect(decision.reply).not.toContain('💡');
    expect(decision.reply).not.toContain('Texto del modelo');
    expect(decision.interactive?.type).toBe('buttons');
    expect(w.suggestOutputs()).toEqual([expect.objectContaining({ ok: true })]);
  });

  it('D3: tú form, and the emoji only for a customer who uses emojis', async () => {
    const decision = await world()
      .boot()
      .turn('quiero una whiskas, ¿tienes arena? 😊', addAndSuggest());
    expect(decision.reply).toContain(`\n\n${LINE_TU}\n\n${QUESTION_TU}`);
  });

  it('D4: a second add within 24 h gets no line, also after a restart; after 24 h it may again', async () => {
    const w = world();
    const h = w.boot();
    await h.turn('quiero una whiskas y arena', addAndSuggest());
    const second = await h.turn(
      'mejor que sean dos whiskas',
      addAndSuggest(SILICE, 2, 'dos'),
    );
    expect(second.reply).not.toContain('Por si le sirve');
    const restarted = await w
      .boot()
      .turn('mejor que sean tres whiskas', addAndSuggest(SILICE, 3, 'tres'));
    expect(restarted.reply).not.toContain('Por si le sirve');
    w.clock.now = new Date('2026-11-27T12:00:01.000Z');
    const later = await w
      .boot()
      .turn(
        'mejor que sean cuatro whiskas',
        addAndSuggest(SILICE, 4, 'cuatro'),
      );
    expect(later.reply).toContain(LINE_USTED);
  });

  it.each([
    ['unknown_product', 'a0000000-0000-4000-8000-000000009999'],
    ['out_of_stock', DOG_CHOW],
    ['same_product', WHISKAS],
  ])('D2/D3: %s → no line and a refusal code', async (code, suggested) => {
    const w = world();
    const decision = await w
      .boot()
      .turn('quiero una whiskas y arena', addAndSuggest(suggested));
    expect(decision.reply).not.toContain('Por si le sirve');
    expect(w.suggestOutputs()).toEqual([{ ok: false, error: code }]);
  });

  it('D3: a product already in the cart → no line and in_cart', async () => {
    const w = world();
    const h = w.boot();
    await h.turn('quiero una arena de sílice', [
      [search('arena sílice'), add(SILICE), say()],
    ]);
    const decision = await h.turn('quiero una whiskas', addAndSuggest());
    expect(decision.reply).not.toContain('Por si le sirve');
    expect(w.suggestOutputs()).toEqual([{ ok: false, error: 'in_cart' }]);
  });

  it('D2: no cart add in this turn → no_cart_add and the model reply stands', async () => {
    const w = world();
    const decision = await w
      .boot()
      .turn('busco whiskas y arena', [
        [
          search('whiskas'),
          search('arena sílice'),
          suggest(SILICE),
          say('Ok.'),
        ],
      ]);
    expect(decision.reply).not.toContain('Por si le sirve');
    expect(w.suggestOutputs()).toEqual([{ ok: false, error: 'no_cart_add' }]);
  });

  it.each([
    ['a placed order awaits payment', { unpaidOrder: true as const }],
    ['an order summary is pending', { pendingSummary: true as const }],
  ])('D4: no suggestion tool while %s', async (_case, options) => {
    const w = world(options);
    const decision = await w
      .boot()
      .turn('quiero una whiskas y arena', addAndSuggest());
    expect(decision.reply).not.toContain('Por si le sirve');
    expect(w.suggestOutputs()).toEqual([]);
  });

  it('D6: a turn without a suggestion is byte-identical to a world without the feature', async () => {
    const run = [[search('whiskas'), add(WHISKAS), say()]];
    const withFeature = await world()
      .boot()
      .turn('quiero una whiskas', structuredClone(run));
    const without = await world({ profiles: false })
      .boot()
      .turn('quiero una whiskas', structuredClone(run));
    expect(withFeature.reply).toBe(without.reply);
    expect(withFeature.reply.endsWith(MINIMAL_CART_NEXT_STEP_QUESTION)).toBe(
      true,
    );
    expect(withFeature.interactive).toEqual(without.interactive);
  });
  describe('T3-fix (S5-S7)', () => {
    const DAY = 24 * 60 * 60_000;
    const T0 = Date.parse('2026-11-26T12:00:00.000Z');
    const decline = () => call('declineSuggestions', {});
    const LITTER = 8; // Arena aglomerante: two presentations.

    it('E1/S7: a decline after a shown suggestion pauses 30 days; the model reply stands', async () => {
      const w = world();
      const h = w.boot();
      await h.turn('quiero una whiskas y arena', addAndSuggest());
      const declined = await h.turn('no gracias, no me ofrezca nada más', [
        [decline(), say('Claro, con gusto.')],
      ]);
      expect(declined.reply).toBe('Claro, con gusto.');
      expect(w.toolOutputs('declineSuggestions')).toEqual([{ ok: true }]);
      // Offered after the shown suggestion, while suggestComplement is not.
      expect(w.systems[1]).toContain('Herramienta declineSuggestions');
      expect(w.systems[1]).not.toContain('Herramienta suggestComplement');
      await expect(w.profileStore.read(SENDER)).resolves.toMatchObject({
        suggestionsPausedUntil: new Date(
          w.clock.now.getTime() + 30 * DAY,
        ).toISOString(),
      });
      w.clock.now = new Date(w.clock.now.getTime() + 2 * DAY);
      const later = await w
        .boot()
        .turn('mejor que sean dos whiskas', addAndSuggest(SILICE, 2, 'dos'));
      expect(later.reply).not.toContain('Por si le sirve');
      expect(w.suggestOutputs()).toHaveLength(1);
      w.clock.now = new Date(Date.parse('2026-11-26T12:00:00.000Z') + 30 * DAY);
      const after = await w
        .boot()
        .turn('mejor que sean tres whiskas', addAndSuggest(SILICE, 3, 'tres'));
      expect(after.reply).toContain(LINE_USTED);
    });

    it('E1/G1: declineSuggestions needs a loaded profile, once per turn', async () => {
      const none = world({ profiles: false });
      await none.boot().turn('no me ofrezca nada', [[say('Claro.')]]);
      expect(none.systems[0]).not.toContain('Herramienta declineSuggestions');
      const w = world();
      await w
        .boot()
        .turn('no me ofrezca otros productos', [
          [decline(), decline(), say('Claro.')],
        ]);
      expect(w.systems[0]).toContain('Herramienta declineSuggestions');
      expect(w.toolOutputs('declineSuggestions')).toEqual([
        { ok: true },
        { ok: false, error: 'already_declined' },
      ]);
    });

    it('E1: a decline in the add turn → no line', async () => {
      const w = world();
      const decision = await w
        .boot()
        .turn('quiero una whiskas, y no me ofrezca nada más', [
          [
            search('whiskas'),
            search('arena sílice'),
            add(WHISKAS),
            decline(),
            suggest(SILICE),
            say(),
          ],
        ]);
      expect(decision.reply).not.toContain('Por si le sirve');
      expect(w.suggestOutputs()).toEqual([{ ok: false, error: 'declined' }]);
    });

    it('E2: a failing profile store never drops the reply nor repeats the suggestion in-process', async () => {
      const w = world({ failingWrites: true });
      const h = w.boot();
      const first = await h.turn('quiero una whiskas y arena', addAndSuggest());
      expect(first.reply).toContain(LINE_USTED);
      expect(first.interactive?.type).toBe('buttons');
      const second = await h.turn('quiero una whiskas', addAndSuggest());
      expect(second.reply).not.toContain('Por si le sirve');
      expect(w.suggestOutputs()).toHaveLength(1);
    });

    it.each([
      [
        'an earlier day',
        25 * 60 * 60_000,
        { ok: false, error: 'stale_product' },
      ],
      ['the same day', 23 * 60 * 60_000, expect.objectContaining({ ok: true })],
    ])(
      'E3/E7/G5: a product whose price was read %s (injected clock only)',
      async (_case, elapsed, expected) => {
        const w = world();
        const h = w.boot();
        await h.turn('quiero una whiskas y busco arena', [
          [search('whiskas'), search('arena sílice'), add(WHISKAS), say()],
        ]);
        w.clock.now = new Date(T0 + elapsed);
        await h.turn('mejor que sean dos whiskas', [
          [add(WHISKAS, 'dos', 2), suggest(SILICE), say()],
        ]);
        expect(w.suggestOutputs()).toEqual([expected]);
      },
    );

    it('E4: a product the same turn added after the suggestion → no line, no pause', async () => {
      const w = world();
      const decision = await w
        .boot()
        .turn('quiero una whiskas y una arena', [
          [
            search('whiskas'),
            search('arena sílice'),
            add(WHISKAS),
            suggest(SILICE),
            add(SILICE),
            say(),
          ],
        ]);
      expect(w.suggestOutputs()).toEqual([
        expect.objectContaining({ ok: true }),
      ]);
      expect(decision.reply).not.toContain('Por si le sirve');
      const stored = await w.profileStore.read(SENDER);
      expect(stored?.suggestionsPausedUntil).toBeUndefined();
    });

    it('E5: two parallel calls → one ok, the other already_suggested', async () => {
      const w = world();
      await w.boot().turn('quiero una whiskas y arena', [
        [
          search('whiskas'),
          search('arena sílice'),
          add(WHISKAS),
          step([
            {
              type: 'tool-call',
              toolCallId: 'p1',
              toolName: 'suggestComplement',
              input: JSON.stringify({ productId: product(SILICE) }),
            },
            {
              type: 'tool-call',
              toolCallId: 'p2',
              toolName: 'suggestComplement',
              input: JSON.stringify({ productId: product(SILICE) }),
            },
          ]),
          say(),
        ],
      ]);
      const outputs = w.suggestOutputs();
      expect(outputs).toHaveLength(2);
      expect(outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ok: true }),
          { ok: false, error: 'already_suggested' },
        ]),
      );
    });

    it('E6: a set that keeps the quantity is not an add', async () => {
      const w = world({ pendingSummary: undefined });
      const h = w.boot();
      await h.turn('quiero una whiskas', [
        [search('whiskas'), search('arena sílice'), add(WHISKAS), say()],
      ]);
      await h.turn('mejor déjela en una whiskas', [
        [add(WHISKAS), suggest(SILICE), say()],
      ]);
      expect(w.suggestOutputs()).toEqual([{ ok: false, error: 'no_cart_add' }]);
    });

    it.each([
      [
        'unknown_price',
        SILICE,
        undefined,
        (api: EvalFakeApi) => {
          const original = api.searchCatalog.bind(api);
          api.searchCatalog = async (q, limit) =>
            (await original(q, limit)).map((item) =>
              item.productId === product(SILICE)
                ? { ...item, price: { ...item.price, priceCents: null } }
                : item,
            );
        },
      ],
      [
        'unverified',
        SILICE,
        undefined,
        (api: EvalFakeApi) => {
          const original = api.getStock.bind(api);
          api.getStock = (id) =>
            id === product(SILICE)
              ? Promise.reject(new Error('backend down'))
              : original(id);
        },
      ],
      ['variant_required', LITTER, undefined, undefined],
      [
        'unknown_product',
        LITTER,
        'b0000000-0000-4000-8000-000000000899',
        undefined,
      ],
    ])(
      'E7: %s → no line and no pause',
      async (code, suggested, variantId, patchApi) => {
        const w = world(patchApi === undefined ? {} : { patchApi });
        const decision = await w.boot().turn('quiero una whiskas y arena', [
          [
            search('whiskas'),
            search('arena'),
            add(WHISKAS),
            call('suggestComplement', {
              productId: product(suggested),
              ...(variantId === undefined ? {} : { variantId }),
            }),
            say(),
          ],
        ]);
        expect(decision.reply).not.toContain('Por si le sirve');
        expect(w.suggestOutputs()).toEqual([{ ok: false, error: code }]);
        const stored = await w.profileStore.read(SENDER);
        expect(stored?.suggestionsPausedUntil).toBeUndefined();
      },
    );

    it('E7: a second call after an ok → already_suggested, one line', async () => {
      const w = world();
      const decision = await w
        .boot()
        .turn('quiero una whiskas y arena', [
          [
            search('whiskas'),
            search('arena sílice'),
            add(WHISKAS),
            suggest(SILICE),
            suggest(SILICE),
            say(),
          ],
        ]);
      expect(w.suggestOutputs()).toEqual([
        expect.objectContaining({ ok: true }),
        { ok: false, error: 'already_suggested' },
      ]);
      expect(decision.reply.split('Por si le sirve')).toHaveLength(2);
    });

    it('E7: an ok suggestion with a non-inviting cart reply → no line, no pause', async () => {
      const w = world();
      const decision = await w
        .boot()
        .turn('quiero una whiskas y un dog chow', [
          [
            search('whiskas'),
            search('arena sílice'),
            search('dog chow cachorro'),
            add(WHISKAS),
            suggest(SILICE),
            add(DOG_CHOW, 'un'),
            say(),
          ],
        ]);
      expect(w.suggestOutputs()).toEqual([
        expect.objectContaining({ ok: true }),
      ]);
      expect(decision.reply).not.toContain('Por si le sirve');
      expect(decision.reply.endsWith(MINIMAL_CART_NEXT_STEP_QUESTION)).toBe(
        false,
      );
      const stored = await w.profileStore.read(SENDER);
      expect(stored?.suggestionsPausedUntil).toBeUndefined();
    });

    it('E8: a long name is cut on a word boundary with «…»', async () => {
      const long =
        'Arena para Gato de Sílice Premium Control de Olores Extra Fuerte Larga Duración 3.8 L';
      const w = world({
        patchApi: (api) => {
          const original = api.getStock.bind(api);
          api.getStock = async (id) => {
            const stock = await original(id);
            return id === product(SILICE) ? { ...stock, name: long } : stock;
          };
        },
      });
      const decision = await w
        .boot()
        .turn('quiero una whiskas y arena', addAndSuggest());
      expect(decision.reply).toContain(
        'Por si le sirve: *Arena para Gato de Sílice Premium Control de Olores Extra Fuerte Larga Duración…* ($179.00)',
      );
    });
  });

  describe('T3-fix-2 (S6, S7)', () => {
    const DAY = 24 * 60 * 60_000;
    const T0 = Date.parse('2026-11-26T12:00:00.000Z');
    const decline = () => call('declineSuggestions', {});
    /** The addAndSuggest run without the suggestComplement call. */
    const addOnly = () => [
      [
        search('whiskas'),
        search('arena sílice'),
        search('dog chow cachorro'),
        add(WHISKAS),
        say(),
      ],
    ];

    it.each([
      [
        'an order awaits payment (no suggestion tool)',
        { unpaidOrder: true as const },
      ],
      ['no suggestion context at all', {}],
    ])(
      'G1/S7: «no me ofrezcas nada» while %s records the 30-day pause; the model reply stands',
      async (_case, options) => {
        const w = world(options);
        const decision = await w
          .boot()
          .turn('no me ofrezcas nada', [[decline(), say('Claro.')]]);
        expect(w.systems[0]).toContain('Herramienta declineSuggestions');
        expect(decision.reply).toBe('Claro.');
        expect(w.toolOutputs('declineSuggestions')).toEqual([{ ok: true }]);
        await expect(w.profileStore.read(SENDER)).resolves.toMatchObject({
          suggestionsPausedUntil: new Date(T0 + 30 * DAY).toISOString(),
        });
      },
    );

    it('G1 (verify A): three turns after a shown suggestion, inside its 24 h pause, a decline still records 30 days', async () => {
      const w = world();
      const h = w.boot();
      await h.turn('quiero una whiskas y arena', addAndSuggest());
      for (const text of ['gracias', 'ok', '¿a qué hora abren?'])
        await h.turn(text, [[say('Con gusto.')]]);
      await h.turn('ya no me ofrezca productos', [[decline(), say('Claro.')]]);
      expect(w.systems[4]).toContain('Herramienta declineSuggestions');
      expect(w.toolOutputs('declineSuggestions')).toEqual([{ ok: true }]);
      await expect(w.profileStore.read(SENDER)).resolves.toMatchObject({
        suggestionsPausedUntil: new Date(T0 + 30 * DAY).toISOString(),
      });
    });

    it.each([
      ['within 24 h', 23 * 60 * 60_000, expect.objectContaining({ ok: true })],
      ['after 24 h', 25 * 60 * 60_000, { ok: false, error: 'stale_product' }],
    ])(
      'G2: a product priced in an earlier non-cart turn, then a cart add %s',
      async (_case, elapsed, expected) => {
        const w = world();
        const h = w.boot();
        await h.turn('¿tienen arena?', [[search('arena sílice'), say('Sí.')]]);
        w.clock.now = new Date(T0 + elapsed);
        const decision = await h.turn('quiero una whiskas', [
          [search('whiskas'), add(WHISKAS), suggest(SILICE), say()],
        ]);
        expect(w.suggestOutputs()).toEqual([expected]);
        if (elapsed < DAY) expect(decision.reply).toContain(LINE_USTED);
      },
    );

    it('G2: a session stored without suggestion prices has nothing suggestable', async () => {
      const w = world();
      const h = w.boot();
      await h.turn('quiero una whiskas y busco arena', [
        [search('whiskas'), search('arena sílice'), add(WHISKAS), say()],
      ]);
      h.sessions.write(
        SENDER,
        h.sessions.read(SENDER).map((turn) => {
          const legacy: Record<string, unknown> = { ...turn };
          delete legacy.complementPrices;
          return legacy as unknown as typeof turn;
        }),
      );
      await h.turn('mejor que sean dos whiskas', [
        [add(WHISKAS, 'dos', 2), suggest(SILICE), say()],
      ]);
      expect(w.suggestOutputs()).toEqual([
        { ok: false, error: 'unknown_price' },
      ]);
    });

    it('G2: catalogPrices (list row titles) is unchanged by a non-cart read', async () => {
      const w = world();
      const h = w.boot();
      await h.turn('¿tienen arena?', [[search('arena sílice'), say('Sí.')]]);
      expect(h.sessions.read(SENDER).at(-1)?.catalogPrices).toBeUndefined();
    });

    it.each([
      [
        'usted',
        'quiero una whiskas y arena',
        LINE_USTED,
        MINIMAL_CART_NEXT_STEP_QUESTION,
      ],
      ['tú', 'quiero una whiskas, ¿tienes arena? 😊', LINE_TU, QUESTION_TU],
    ])(
      'G3: %s — the suggestion reply is the no-line reply with the line before the next-step question',
      async (_case, text, line, question) => {
        const without = await world().boot().turn(text, addOnly());
        const withLine = await world().boot().turn(text, addAndSuggest());
        expect(without.reply.endsWith(`\n\n${question}`)).toBe(true);
        expect(withLine.reply).toBe(
          `${without.reply.slice(0, -question.length)}${line}\n\n${question}`,
        );
        expect(withLine.interactive).toEqual(without.interactive);
      },
    );

    it('G4: a set that lowers the quantity is not an add', async () => {
      const w = world();
      const h = w.boot();
      await h.turn('quiero dos whiskas', [
        [
          search('whiskas'),
          search('arena sílice'),
          add(WHISKAS, 'dos', 2),
          say(),
        ],
      ]);
      await h.turn('mejor solo una whiskas', [
        [add(WHISKAS, 'una', 1), suggest(SILICE), say()],
      ]);
      expect(w.suggestOutputs()).toEqual([{ ok: false, error: 'no_cart_add' }]);
    });

    it('G4: when the previous lines cannot be read, a set is not an add (fail closed)', async () => {
      const w = world();
      const h = w.boot();
      await h.turn('quiero una whiskas', [
        [search('whiskas'), search('arena sílice'), add(WHISKAS), say()],
      ]);
      jest
        .spyOn(MinimalCartService.prototype, 'storedLines')
        .mockResolvedValue(null);
      await h.turn('mejor que sean dos whiskas', [
        [add(WHISKAS, 'dos', 2), suggest(SILICE), say()],
      ]);
      expect(w.suggestOutputs()).toEqual([{ ok: false, error: 'no_cart_add' }]);
    });

    it('G6: a missing price refuses before claiming the slot or reading stock', async () => {
      const stockReads: string[] = [];
      const w = world({
        patchApi: (api) => {
          const search = api.searchCatalog.bind(api);
          api.searchCatalog = async (q, limit) =>
            (await search(q, limit)).map((item) =>
              item.productId === product(SILICE)
                ? { ...item, price: { ...item.price, priceCents: null } }
                : item,
            );
          const stock = api.getStock.bind(api);
          api.getStock = (id) => {
            stockReads.push(id);
            return stock(id);
          };
        },
      });
      await w.boot().turn('quiero una whiskas y arena', addAndSuggest());
      expect(w.suggestOutputs()).toEqual([
        { ok: false, error: 'unknown_price' },
      ]);
      expect(stockReads).not.toContain(product(SILICE));
    });

    it('G8: a failed decline write is logged without the phone; the reply stands', async () => {
      const warn = jest.mocked(Logger.prototype.warn);
      const w = world({ failingWrites: true });
      const decision = await w
        .boot()
        .turn('no me ofrezcas nada', [[decline(), say('Claro.')]]);
      expect(decision.reply).toBe('Claro.');
      expect(w.toolOutputs('declineSuggestions')).toEqual([{ ok: true }]);
      const messages = warn.mock.calls.map((args) => String(args[0]));
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^minimal_catalog tool declineSuggestions durable_write=failed pause=process_only trace=\S+$/,
          ),
        ]),
      );
      expect(messages.join('\n')).not.toContain(SENDER);
    });
  });
});
