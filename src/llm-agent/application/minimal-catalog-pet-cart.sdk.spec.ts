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
import { InMemoryLocalPetStore } from '../../customer-profile/infrastructure/in-memory-local-pet.store';
import { InMemoryCustomerProfileStore } from '../../customer-profile/infrastructure/in-memory-customer-profile.store';
import {
  EvalFakeApi,
  PREVIOUS_ORDER,
} from '../../../scripts/eval/fixtures/fake-api';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * Multi-pet T5a R2 (S17) on the real customer route: with one backend pet,
 * or after the customer chose a pet in the which-pet question, what is added
 * to the cart is for that pet until the order is placed or another pet is
 * chosen. The choice is kept on the cart, so it survives turns and restarts.
 * Never from model input; prospects (local pets) never get a pet on a line.
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const BRUNO_ID = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const MAX_ID = 'a0000000-0000-4000-8000-000000000050';
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
// Catalog fixture ids: 9 sílice, 10 Kong (Chico, Mediano, Grande), 12 collar.
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
const setItem = (selectionRef: string, quantity: number, text: string) =>
  call('setCartItem', {
    selectionRef,
    quantity,
    quantityText: text,
    continuation: false,
  });
const addSilice = () => [
  [
    call('searchCatalog', { q: 'sílice' }),
    setItem(ref(SILICE), 1, 'una'),
    say(),
  ],
];
const addKong = () => [
  [
    call('searchCatalog', { q: 'kong mediano' }),
    setItem(ref(KONG, 2), 1, 'un'),
    say(),
  ],
];
const addCollar = () => [
  [
    call('searchCatalog', { q: 'collar de nylon perro talla mediana' }),
    setItem(ref(COLLAR, 2), 1, 'un'),
    say(),
  ],
];
const ask = () => [[call('askWhichPet'), say('¿Para cuál?')]];

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
const max = () =>
  pet({
    id: MAX_ID,
    name: 'Max',
    breed: 'Labrador',
    size: 'LARGE',
    birthDate: '2023-01-01',
    ageMonths: 40,
    ageLabel: '~3 años',
    createdAt: '2026-10-01T10:00:00.000Z',
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

/** One process; `boot()` again is a restart on the same durable stores. */
function world(lookup: { current: CustomerLookupResponse }) {
  const gateStore = new InMemoryConversationGateStore(() => NOW);
  const profileStore = new InMemoryCustomerProfileStore();
  const conversations = new InMemoryConversationStore();
  const boot = (petsOverride?: CustomerPetsService) => {
    const api = new EvalFakeApi({ kind: 'new' });
    const config = {
      get: (key: string) =>
        key === 'chatbotApi.cashierUserId'
          ? ''
          : { model: 'm', maxSteps: 6, historyTurns: 12 },
    } as unknown as ConfigService;
    let scripts: unknown[][] = [];
    const generate: GenerateTextFn = async (input) => {
      const script = scripts.shift() ?? [say()];
      return generateText({
        ...input,
        model: new MockLanguageModelV4({ doGenerate: script } as never),
      });
    };
    const profiles = new CustomerProfileService(profileStore, () => NOW);
    const pets =
      petsOverride ??
      new CustomerPetsService(
        new InMemoryLocalPetStore(profileStore),
        {
          getCustomerByPhone: () =>
            Promise.resolve(structuredClone(lookup.current)),
        },
        petsClient() satisfies Record<keyof CustomerPetsClient, jest.Mock>,
        profiles,
        () => NOW,
      );
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
    const turn = (
      text: string,
      runs: unknown[][] = [],
      interactiveReplyId?: string,
    ) => {
      scripts = runs.length === 0 ? [[say()]] : runs;
      return agent.tryHandle({
        senderId: SENDER,
        text,
        ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
      });
    };
    return { turn };
  };
  const cart = async () =>
    (await conversations.get(SENDER))?.data.minimalCart as
      | {
          items: Array<{
            productId: string;
            variantId?: string;
            pet?: { id: string; name: string };
          }>;
          currentPet?: { id: string; name: string };
        }
      | undefined;
  const petOf = async (productId: string) =>
    (await cart())?.items.find((item) => item.productId === productId)?.pet;
  return { boot, cart, petOf };
}

describe('T5a R2: which lines are for a pet (S17)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('with exactly one backend pet a new line is for that pet and the reply says so', async () => {
    const w = world({ current: customer([max()]) });
    const decision = await w
      .boot()
      .turn('quiero una arena de sílice', addSilice());
    expect(await w.petOf(product(SILICE))).toEqual({
      id: MAX_ID,
      name: 'Max',
    });
    expect(decision.reply).toContain('(para Max)');
    // Nothing chosen: the single pet is not stored as a choice.
    expect((await w.cart())?.currentPet).toBeUndefined();
  });

  it('«lo de la vez pasada» adds its lines without a pet, even with one pet (the per-pet reorder is T5b)', async () => {
    jest.spyOn(EvalFakeApi.prototype, 'getOrderHistory').mockResolvedValue([
      {
        ...structuredClone(PREVIOUS_ORDER),
        items: [
          {
            productId: product(SILICE),
            variantId: null,
            productName: 'Arena de sílice',
            variantName: null,
            quantity: 1,
            unitPriceCents: 25000,
          },
        ],
      },
    ]);
    const w = world({ current: customer([max()]) });
    const h = w.boot();
    const offer = await h.turn('lo de la vez pasada', [
      [call('getLastOrder'), say('Aquí está.')],
    ]);
    const interactive = offer.interactive as
      | { type: string; buttons?: Array<{ id: string }> }
      | undefined;
    const confirm = (
      interactive?.type === 'buttons' ? (interactive.buttons ?? []) : []
    ).find((button) => button.id.startsWith('reorder_confirm:'));
    expect(confirm).toBeDefined();
    await h.turn('SÍ', [[say()]], confirm!.id);
    const items = (await w.cart())?.items ?? [];
    expect(items.map((item) => item.productId)).toEqual([product(SILICE)]);
    expect(await w.petOf(product(SILICE))).toBeUndefined();
  });

  it('with two pets and no choice the line has no pet', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const decision = await w
      .boot()
      .turn('quiero una arena de sílice', addSilice());
    expect((await w.cart())?.items).toHaveLength(1);
    expect(await w.petOf(product(SILICE))).toBeUndefined();
    expect(decision.reply).not.toContain('(para');
  });

  it('a which-pet answer sets the current pet; it holds across turns and a restart, and another answer replaces it', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('quiero una arena de sílice', ask());
    await h.turn('Max', addSilice(), `pet_pick:backend:${MAX_ID}`);
    const maxPet = { id: MAX_ID, name: 'Max' };
    expect(await w.petOf(product(SILICE))).toEqual(maxPet);
    expect((await w.cart())?.currentPet).toEqual(maxPet);

    // A restart: the choice is on the cart, so the next line is for Max.
    const restarted = w.boot();
    await restarted.turn('también un kong mediano', addKong());
    expect(await w.petOf(product(KONG))).toEqual(maxPet);

    // The typed answer «para Bruno» replaces the current pet.
    await restarted.turn('quiero un collar de nylon talla mediana', ask());
    await restarted.turn('para Bruno', addCollar());
    const brunoPet = { id: BRUNO_ID, name: 'Bruno' };
    expect(await w.petOf(product(COLLAR))).toEqual(brunoPet);
    expect((await w.cart())?.currentPet).toEqual(brunoPet);
    // Earlier lines keep their pet.
    expect(await w.petOf(product(SILICE))).toEqual(maxPet);
  });

  it('a prospect (local pets only) never gets a pet on a line, nor a current pet', async () => {
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
    const w = world({ current: { found: false, customer: null } });
    await w.boot(stub).turn('quiero una arena de sílice', addSilice());
    expect((await w.cart())?.items).toHaveLength(1);
    expect(await w.petOf(product(SILICE))).toBeUndefined();
    expect((await w.cart())?.currentPet).toBeUndefined();
  });
});
