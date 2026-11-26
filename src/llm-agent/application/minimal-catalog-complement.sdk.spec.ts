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
const add = (p: number, text = 'una') =>
  call('setCartItem', {
    selectionRef: ref(p),
    quantity: 1,
    quantityText: text,
    continuation: false,
  });
const suggest = (p: number | string) =>
  call('suggestComplement', {
    productId: typeof p === 'number' ? product(p) : p,
  });
/** Add Whiskas, then suggest `p` (both read by searchCatalog first). */
const addAndSuggest = (p: number | string = SILICE) => [
  [
    search('whiskas'),
    search('arena sílice'),
    search('dog chow cachorro'),
    add(WHISKAS),
    suggest(p),
    say(),
  ],
];

type ToolOutput = { toolName: string; output: unknown };

function world(
  options: { profiles?: false; unpaidOrder?: true; pendingSummary?: true } = {},
) {
  const profileStore = new InMemoryCustomerProfileStore();
  const conversations = new InMemoryConversationStore();
  const clock = { now: new Date('2026-11-26T12:00:00.000Z') };
  const outputs: ToolOutput[] = [];
  const systems: string[] = [];
  const boot = () => {
    const api = new EvalFakeApi({ kind: 'new' });
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
    const agent = new MinimalCatalogAgentService(
      api,
      generate,
      new CostGuardService(100000),
      config,
      new InMemoryMinimalCatalogSessionStore(),
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
    return { turn };
  };
  const suggestOutputs = () =>
    outputs
      .filter((o) => o.toolName === 'suggestComplement')
      .map((o) => o.output);
  return { boot, clock, suggestOutputs, systems };
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
    const second = await h.turn('quiero una whiskas', addAndSuggest());
    expect(second.reply).not.toContain('Por si le sirve');
    const restarted = await w
      .boot()
      .turn('quiero una whiskas', addAndSuggest());
    expect(restarted.reply).not.toContain('Por si le sirve');
    w.clock.now = new Date('2026-11-27T12:00:01.000Z');
    const later = await w.boot().turn('quiero una whiskas', addAndSuggest());
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
});
