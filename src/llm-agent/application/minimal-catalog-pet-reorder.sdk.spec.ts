import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import {
  CustomerPetsService,
  type KnownPet,
} from '../../customer-profile/application/customer-pets.service';
import type { CustomerPetsClient } from '../../chatbot-api/domain/customer-pets.port';
import type { CustomerPet as BackendPet } from '../../chatbot-api/domain/dtos/customer-pets.dto';
import type { CustomerLookupResponse } from '../../chatbot-api/domain/dtos/customers.dto';
import type {
  OrderHistoryQuery,
  OrderHistoryResponse,
} from '../../chatbot-api/domain/dtos/sales.dto';
import { NotFoundError } from '../../chatbot-api/domain/errors';
import { InMemoryLocalPetStore } from '../../customer-profile/infrastructure/in-memory-local-pet.store';
import { InMemoryCustomerProfileStore } from '../../customer-profile/infrastructure/in-memory-customer-profile.store';
import {
  EvalFakeApi,
  PREVIOUS_ORDER,
} from '../../../scripts/eval/fixtures/fake-api';
import type { CustomerReplyInteractive } from '../domain/customer-reply';
import { applyCustomerStyle } from '../domain/customer-style';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import {
  MinimalCatalogAgentService,
  REORDER_PET_INSTRUCTIONS_FRAGMENT,
} from './minimal-catalog-agent.service';
import {
  REORDER_PET_EMPTY_REPLY,
  reorderPetEmptyReply,
} from './minimal-reorder';

/**
 * Multi-pet T5b (S4, S14, S15): «¿Lo mismo de siempre para Max?». With an
 * explicit pet name getLastOrder reads the order history of that backend pet
 * (?petId), takes the newest order with a line for it and offers only its
 * lines; a yes tags them for that pet. Without a pet name the reorder is the
 * existing «lo de la vez pasada», byte for byte (risk item 3).
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const BRUNO_ID = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const MAX_ID = 'a0000000-0000-4000-8000-000000000050';
const MAX_2_ID = 'a0000000-0000-4000-8000-000000000051';
const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const variant = (p: number, v: number) =>
  `b0000000-0000-4000-8000-${String(p * 100 + v).padStart(12, '0')}`;
const NUPEC = product(1);
const MINI = product(3);
const MINI_2KG = variant(3, 1);
const SILICE = product(9);
const NUPEC_NAME =
  'Croquetas Naturales Sin Grano de Salmón y Camote para Perros Adultos de Raza Grande 18 kg';

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
const forPet = (name: string) => [
  [call('getLastOrder', { petName: name }), say('Aquí está.')],
];
const generic = () => [[call('getLastOrder'), say('Aquí está.')]];

type Decision = {
  reply: string;
  interactive?: CustomerReplyInteractive;
  onSent?: () => void;
};
const buttons = (decision: Decision) =>
  decision.interactive?.type === 'buttons' ? decision.interactive.buttons : [];

const pet = (patch: Partial<BackendPet>): BackendPet => ({
  id: BRUNO_ID,
  customerId: CUSTOMER_ID,
  name: 'Bruno',
  species: 'DOG',
  speciesOther: null,
  breed: 'Chihuahua',
  size: 'SMALL',
  birthDate: '2026-01-01',
  birthDatePrecision: 'MONTH',
  ageMonths: 10,
  ageLabel: '~10 meses',
  allergies: null,
  notes: null,
  status: 'ACTIVE',
  archivedAt: null,
  archivedReason: null,
  createdVia: 'POS',
  version: 3,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...patch,
});
const max = (patch: Partial<BackendPet> = {}) =>
  pet({
    id: MAX_ID,
    name: 'Max',
    breed: 'Labrador',
    size: 'LARGE',
    birthDate: '2023-01-01',
    ageMonths: 40,
    ageLabel: '~3 años',
    createdAt: '2026-10-01T10:00:00.000Z',
    ...patch,
  });
const customer = (pets: BackendPet[]): CustomerLookupResponse => ({
  found: true,
  customer: {
    customerId: CUSTOMER_ID,
    firstName: 'Ana',
    lastName: null,
    phoneCountryCode: '52',
    phone: '5550001111',
    preferredPaymentMethod: null,
    address: null,
    pets,
  },
});
const petsClient = () => ({
  listPets: jest.fn().mockResolvedValue({ kind: 'ok', pets: [] }),
  createPet: jest.fn(),
  patchPet: jest.fn(),
  archivePet: jest.fn(),
  restorePet: jest.fn(),
  deletePet: jest.fn(),
});

type LinePet = { id: string; name: string; species: 'DOG'; status: 'ACTIVE' };
const linePet = (id: string, name: string): LinePet => ({
  id,
  name,
  species: 'DOG',
  status: 'ACTIVE',
});
const item = (
  productId: string,
  quantity: number,
  unitPriceCents: number,
  owner: LinePet | null,
  variantId: string | null = null,
) => ({
  productId,
  variantId,
  productName: 'Nombre histórico',
  variantName: variantId === null ? null : '2 kg',
  quantity,
  unitPriceCents,
  pet: owner,
});
const order = (
  n: number,
  confirmedAt: string,
  items: OrderHistoryResponse['items'],
): OrderHistoryResponse => ({
  ...structuredClone(PREVIOUS_ORDER),
  saleId: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  folio: `EV-0${n}`,
  confirmedAt,
  totalCents: 999900,
  paidCents: 999900,
  items,
});
const MAX = linePet(MAX_ID, 'Max');
const BRUNO = linePet(BRUNO_ID, 'Bruno');
/** Newest first. The newest order has nothing for Max; the next one mixes
 *  Bruno, a pet-less line and two Max lines of the same product (lines in
 *  no particular order, contract §6). */
const MIXED_HISTORY: OrderHistoryResponse[] = [
  order(101, '2026-11-10T18:00:00.000Z', [
    item(MINI, 2, 52900, BRUNO, MINI_2KG),
    item(NUPEC, 1, 159900, null),
  ]),
  order(100, '2026-11-01T18:00:00.000Z', [
    item(MINI, 1, 52900, BRUNO, MINI_2KG),
    item(NUPEC, 1, 159900, MAX),
    item(SILICE, 3, 25000, null),
    item(NUPEC, 1, 159900, MAX),
  ]),
  order(99, '2026-10-20T18:00:00.000Z', [item(NUPEC, 5, 159900, MAX)]),
];

/** The backend's ?petId filter: orders with a line for it, all their lines. */
function backendHistory(history: OrderHistoryResponse[]) {
  return (
    _phone: string,
    _cc: string,
    options?: OrderHistoryQuery,
  ): Promise<OrderHistoryResponse[]> =>
    Promise.resolve(
      structuredClone(
        options?.petId === undefined
          ? history
          : history.filter((o) =>
              o.items.some((line) => line.pet?.id === options.petId),
            ),
      ),
    );
}

type ToolResult = { toolName: string; output: unknown };

function world(opts: {
  lookup?: CustomerLookupResponse;
  pets?: CustomerPetsService | 'none';
  history?: OrderHistoryResponse[];
}) {
  const gateStore = new InMemoryConversationGateStore(() => NOW);
  const profileStore = new InMemoryCustomerProfileStore();
  const conversations = new InMemoryConversationStore();
  const api = new EvalFakeApi({ kind: 'new' });
  const history = jest
    .spyOn(api, 'getOrderHistory')
    .mockImplementation(backendHistory(opts.history ?? MIXED_HISTORY));
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  let scripts: unknown[][] = [];
  const systems: string[] = [];
  const toolResults: ToolResult[] = [];
  const generate: GenerateTextFn = async (input) => {
    systems.push(
      typeof input.system === 'string'
        ? input.system
        : JSON.stringify(input.system),
    );
    const script = scripts.shift() ?? [say()];
    const result = await generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
    for (const s of result.steps)
      for (const r of s.toolResults)
        toolResults.push({ toolName: r.toolName, output: r.output });
    return result;
  };
  const profiles = new CustomerProfileService(profileStore, () => NOW);
  const pets =
    opts.pets === 'none'
      ? undefined
      : (opts.pets ??
        new CustomerPetsService(
          new InMemoryLocalPetStore(profileStore),
          {
            getCustomerByPhone: () =>
              Promise.resolve(
                structuredClone(opts.lookup ?? customer([pet({}), max()])),
              ),
          },
          petsClient() satisfies Record<keyof CustomerPetsClient, jest.Mock>,
          profiles,
          () => NOW,
        ));
  const cartService = new MinimalCartService(api, conversations);
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    cartService,
    undefined,
    undefined,
    undefined,
    profiles,
    new ConversationGates(gateStore, () => NOW.getTime()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pets,
  );
  const turn = async (
    text: string,
    runs: unknown[][] = [],
    interactiveReplyId?: string,
  ): Promise<Decision> => {
    scripts = runs.length === 0 ? [[say()]] : [...runs];
    const decision = (await agent.tryHandle({
      senderId: SENDER,
      text,
      ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
    })) as Decision;
    decision.onSent?.();
    return decision;
  };
  const cart = async () =>
    (await conversations.get(SENDER))?.data.minimalCart as
      | {
          items: Array<{
            productId: string;
            variantId?: string;
            quantity: number;
            pet?: { id: string; name: string };
          }>;
          currentPet?: { id: string; name: string };
        }
      | undefined;
  const lastOrderResults = () =>
    toolResults
      .filter((r) => r.toolName === 'getLastOrder')
      .map((r) => r.output);
  return { turn, cart, history, systems, lastOrderResults, cartService };
}

const confirmId = (decision: Decision) =>
  buttons(decision).find((b) => b.id.startsWith('reorder_confirm:'))?.id;

describe('T5b: «lo mismo de siempre para Max» (S4, S14, S15)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('S14/S15: reads ?petId of Max and offers only the Max lines of the newest order that has one, merged, with the reorder buttons', async () => {
    const w = world({});
    const offer = await w.turn('lo mismo de siempre para Max', forPet('Max'));

    expect(w.history).toHaveBeenCalledWith('5550001111', '52', {
      petId: MAX_ID,
    });
    expect(offer.reply).toMatch(
      new RegExp(
        [
          '^\\*Lo último que pidió para Max\\* \\(folio EV-0100, 1 nov(?: 2026)?\\)',
          `• ${NUPEC_NAME}`,
          '   2 × \\$1,599\\.00 = \\*\\$3,198\\.00\\*',
          '',
          '\\*Precio de hoy: \\$3,198\\.00\\*',
          '',
          '¿Lo agrego igual a su carrito\\?$',
        ].join('\\n'),
      ),
    );
    // Neither Bruno's lines nor the pet-less line, nor the order total.
    expect(offer.reply).not.toContain('Royal Canin');
    expect(offer.reply).not.toContain('sílice');
    expect(offer.reply).not.toContain('El total de esa vez');
    // Message formatting F3a: the tú render of the per-pet offer.
    const tu = applyCustomerStyle(offer.reply, {
      register: 'tu',
      emojis: false,
      tone: 'neutral',
    });
    expect(tu).toMatch(/^\*Lo último que pediste para Max\* \(folio EV-0100/);
    expect(tu).toContain('\n   2 × $1,599.00 = *$3,198.00*\n');
    expect(tu).toMatch(/\n\n¿Lo agrego igual a tu carrito\?$/);
    expect(buttons(offer)).toEqual([
      {
        id: expect.stringMatching(/^reorder_confirm:.+/) as string,
        title: '✅ Sí, agréguelo',
      },
      { id: 'reorder_change', title: '✏️ Cambiar algo' },
    ]);
    expect(w.lastOrderResults()).toEqual([
      { ok: true, presentedByApplication: true },
    ]);
    expect((await w.cart())?.items ?? []).toEqual([]);
  });

  it('S15: ✅ adds only those lines, tagged for Max, and the cart says «(para Max)»', async () => {
    const w = world({});
    const offer = await w.turn('lo de siempre de Max', forPet('Max'));
    const added = await w.turn('SÍ', [[say('no se usa')]], confirmId(offer));
    expect((await w.cart())?.items).toEqual([
      expect.objectContaining({
        productId: NUPEC,
        quantity: 2,
        pet: { id: MAX_ID, name: 'Max' },
      }),
    ]);
    expect(added.reply).toContain('(para Max)');
    expect(added.reply).toMatch(
      /¿Desea agregar algo más o seguimos con su compra\?$/,
    );
  });

  it('a typed «sí» accepts the per-pet offer the same way', async () => {
    const w = world({});
    await w.turn('lo mismo de siempre para max', forPet('max'));
    await w.turn('sí');
    expect((await w.cart())?.items).toEqual([
      expect.objectContaining({
        productId: NUPEC,
        quantity: 2,
        pet: { id: MAX_ID, name: 'Max' },
      }),
    ]);
  });

  it('pins the per-pet empty reply', () => {
    expect(REORDER_PET_EMPTY_REPLY).toBe(
      'Todavía no encuentro pedidos anteriores para {pet}. ¿Qué producto busca?',
    );
    expect(reorderPetEmptyReply('Max')).toBe(
      'Todavía no encuentro pedidos anteriores para Max. ¿Qué producto busca?',
    );
  });

  it('a pet with no orders (200 []) → the per-pet empty reply, no buttons', async () => {
    const w = world({ history: [] });
    const offer = await w.turn('lo de siempre para Bruno', forPet('Bruno'));
    expect(w.history).toHaveBeenCalledWith('5550001111', '52', {
      petId: BRUNO_ID,
    });
    expect(offer.reply).toBe(
      'Todavía no encuentro pedidos anteriores para Bruno. ¿Qué producto busca?',
    );
    expect(offer.interactive).toBeUndefined();
    await w.turn('sí');
    expect((await w.cart())?.items ?? []).toEqual([]);
  });

  it('404 PET_NOT_FOUND → the per-pet empty reply, never a throw', async () => {
    const w = world({});
    w.history.mockRejectedValue(
      new NotFoundError(
        'pet',
        404,
        { error: 'PET_NOT_FOUND' },
        'PET_NOT_FOUND',
      ),
    );
    const offer = await w.turn('lo de siempre para Max', forPet('Max'));
    expect(offer.reply).toBe(reorderPetEmptyReply('Max'));
    expect(offer.interactive).toBeUndefined();
  });

  it('an order list without any Max line (defensive) → the per-pet empty reply', async () => {
    const w = world({});
    w.history.mockResolvedValue([structuredClone(MIXED_HISTORY[0])]);
    const offer = await w.turn('lo de siempre para Max', forPet('Max'));
    expect(offer.reply).toBe(reorderPetEmptyReply('Max'));
  });

  it('an unknown pet name → a tool error the model acts on; no history read', async () => {
    const w = world({});
    const reply = await w.turn('lo de siempre para Rocky', [
      [call('getLastOrder', { petName: 'Rocky' }), say('¿De qué mascota?')],
    ]);
    expect(w.lastOrderResults()).toEqual([
      { ok: false, error: 'no_pet_with_that_name' },
    ]);
    expect(w.history).not.toHaveBeenCalled();
    expect(reply.reply).toBe('¿De qué mascota?');
  });

  it('two pets with that name → several_pets_with_that_name (askWhichPet), unless the chosen pet is one of them', async () => {
    const w = world({
      lookup: customer([
        max(),
        max({ id: MAX_2_ID, breed: 'Pug', ageLabel: '~1 año' }),
      ]),
    });
    await w.turn('lo de siempre para Max', [
      [call('getLastOrder', { petName: 'Max' }), say('¿Cuál Max?')],
    ]);
    expect(w.lastOrderResults()).toEqual([
      { ok: false, error: 'several_pets_with_that_name' },
    ]);
    expect(w.history).not.toHaveBeenCalled();

    // The which-pet answer picks one Max: that one is used.
    const asked = await w.turn('lo de siempre para Max', [
      [call('askWhichPet'), say('¿Para cuál?')],
    ]);
    expect(asked.interactive).toBeDefined();
    const offer = await w.turn(
      'Max',
      forPet('Max'),
      `pet_pick:backend:${MAX_ID}`,
    );
    expect(w.history).toHaveBeenCalledWith('5550001111', '52', {
      petId: MAX_ID,
    });
    expect(offer.reply).toMatch(/^\*Lo último que pidió para Max\*/);
  });

  it('a pet that is not a backend pet (prospect) → the per-pet empty reply without a history read', async () => {
    const localMax: KnownPet = { ref: 'local:1', name: 'Max', source: 'local' };
    const stub = {
      prepare: jest.fn().mockResolvedValue(undefined),
      capture: jest.fn().mockResolvedValue(undefined),
      promptLines: jest.fn().mockReturnValue([]),
      afterCheckout: jest.fn().mockResolvedValue(undefined),
      knownPets: jest.fn().mockReturnValue([localMax]),
      knownPetsByRecency: jest.fn().mockReturnValue([localMax]),
      chosenPetPromptLine: jest.fn().mockReturnValue(null),
      ambiguousEntries: jest.fn().mockReturnValue([]),
      petsLoaded: jest.fn().mockReturnValue(true),
    } as unknown as CustomerPetsService;
    const w = world({ pets: stub });
    const offer = await w.turn('lo de siempre para Max', forPet('Max'));
    expect(offer.reply).toBe(reorderPetEmptyReply('Max'));
    expect(w.history).not.toHaveBeenCalled();
  });

  it('pets not loaded this turn → a tool error, no history read', async () => {
    const stub = {
      prepare: jest.fn().mockResolvedValue(undefined),
      capture: jest.fn().mockResolvedValue(undefined),
      promptLines: jest.fn().mockReturnValue([]),
      afterCheckout: jest.fn().mockResolvedValue(undefined),
      knownPets: jest.fn().mockReturnValue([]),
      knownPetsByRecency: jest.fn().mockReturnValue([]),
      chosenPetPromptLine: jest.fn().mockReturnValue(null),
      ambiguousEntries: jest.fn().mockReturnValue([]),
      petsLoaded: jest.fn().mockReturnValue(false),
    } as unknown as CustomerPetsService;
    const w = world({ pets: stub });
    await w.turn('lo de siempre para Max', forPet('Max'));
    expect(w.lastOrderResults()).toEqual([
      { ok: false, error: 'pet_memory_unavailable' },
    ]);
    expect(w.history).not.toHaveBeenCalled();
  });

  it('pins the per-pet instructions, present only with the pet store', async () => {
    expect(REORDER_PET_INSTRUCTIONS_FRAGMENT).toBe(
      ' Si el cliente pide lo de siempre o su último pedido para UNA mascota nombrada ("lo mismo de siempre para Max", "lo de siempre de Bruno", "¿qué le compré a Max la última vez?"), llame getLastOrder con petName: el nombre de esa mascota tal como lo escribió; la aplicación presenta solo lo que fue para esa mascota. Si responde several_pets_with_that_name, llame askWhichPet; si responde no_pet_with_that_name, pregunte de qué mascota habla; si responde pet_memory_unavailable, dígale con amabilidad que ahora no puede buscar lo de esa mascota y nunca llame getLastOrder sin argumentos en su lugar. Sin un nombre de mascota en el mensaje, llame getLastOrder sin argumentos.',
    );
    const withPets = world({});
    await withPets.turn('hola', [[say('Hola.')]]);
    expect(withPets.systems[0]).toContain(REORDER_PET_INSTRUCTIONS_FRAGMENT);
    const withoutPets = world({ pets: 'none' });
    await withoutPets.turn('hola', [[say('Hola.')]]);
    expect(withoutPets.systems[0]).not.toContain('petName');
  });
});

describe('T5b risk item 3: «lo de la vez pasada» without a pet is unchanged', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const normalize = (decision: Decision) =>
    JSON.parse(
      JSON.stringify({
        reply: decision.reply,
        interactive: decision.interactive,
      }).replace(/reorder_confirm:[0-9a-f-]+/g, 'reorder_confirm:<ref>'),
    ) as unknown;

  /** The same generic reorder with one current pet vs. no pet store. */
  async function run(pets: 'none' | undefined) {
    const w = world({
      pets,
      lookup: customer([max()]),
    });
    if (pets === undefined)
      await w.cartService.setCurrentPet(SENDER, { id: MAX_ID, name: 'Max' });
    const offer = await w.turn('lo de la vez pasada', generic());
    const added = await w.turn('SÍ', [[say('no se usa')]], confirmId(offer));
    return {
      w,
      offer: normalize(offer),
      added: normalize(added),
      results: w.lastOrderResults(),
      items: ((await w.cart())?.items ?? []).map(
        ({ productId, variantId, quantity, pet }) => ({
          productId,
          variantId,
          quantity,
          pet,
        }),
      ),
    };
  }

  it('tool output, offer text, buttons and accept are identical with a current pet and without the pet store; no ?petId is sent', async () => {
    const plain = await run('none');
    const withPet = await run(undefined);
    expect(withPet.offer).toEqual(plain.offer);
    expect(withPet.added).toEqual(plain.added);
    expect(withPet.results).toEqual(plain.results);
    expect(withPet.results).toEqual([
      { ok: true, presentedByApplication: true },
    ]);
    expect(withPet.items).toEqual(plain.items);
    expect(withPet.items.every((line) => line.pet === undefined)).toBe(true);
    for (const h of [plain.w.history, withPet.w.history])
      for (const args of h.mock.calls) expect(args).toHaveLength(2);
    expect((plain.offer as { reply: string }).reply).toMatch(
      /^\*Su último pedido\* \(folio EV-0101, 10 nov(?: 2026)?\)\n/,
    );
    expect((plain.offer as { reply: string }).reply).toContain(
      'El total de esa vez fue $9,999.00.',
    );
  });
});
