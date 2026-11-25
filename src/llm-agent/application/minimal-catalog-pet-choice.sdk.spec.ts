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
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';
import { MINIMAL_PET_CHOICE_TTL_MS } from './gates/pet-choice.gate';

/**
 * T4c-2a (S3, S12, S13): the which-pet question on the real customer route.
 * The model calls askWhichPet; the application asks «¿Para quién es?» with
 * buttons or a list, keeps the question 15 minutes in the durable
 * `pet_choice` gate with the original request, and a tap (or the bare name)
 * continues that request with the chosen pet as the turn's pet context.
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const BRUNO_ID = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const MAX_ID = 'a0000000-0000-4000-8000-000000000050';
const STALE = 'Ese botón ya no está vigente. ¿Qué desea hacer?';

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
const client = () => ({
  listPets: jest.fn().mockResolvedValue({ kind: 'ok', pets: [] }),
  createPet: jest.fn(),
  patchPet: jest.fn(),
  archivePet: jest.fn(),
  restorePet: jest.fn(),
  deletePet: jest.fn(),
});

type PetsStub = Pick<
  CustomerPetsService,
  | 'prepare'
  | 'capture'
  | 'promptLines'
  | 'afterCheckout'
  | 'knownPets'
  | 'knownPetsByRecency'
  | 'chosenPetPromptLine'
>;

/** One process: shared durable stores survive `boot()` (a restart). */
function world(lookup: { current: CustomerLookupResponse }) {
  let now = NOW.getTime();
  const gateStore = new InMemoryConversationGateStore(() => new Date(now));
  const profileStore = new InMemoryCustomerProfileStore();
  const boot = (petsStub?: PetsStub) => {
    const api = new EvalFakeApi({ kind: 'new' });
    const config = {
      get: (key: string) =>
        key === 'chatbotApi.cashierUserId'
          ? ''
          : { model: 'm', maxSteps: 6, historyTurns: 12 },
    } as unknown as ConfigService;
    const seen: Array<{
      system?: unknown;
      tools?: Record<string, unknown>;
      messages?: Array<{ role: string; content: unknown }>;
    }> = [];
    let scripts: unknown[][] = [];
    const generate: GenerateTextFn = async (input) => {
      seen.push(input);
      const script = scripts.shift() ?? [say()];
      return generateText({
        ...input,
        model: new MockLanguageModelV4({ doGenerate: script } as never),
      });
    };
    const profiles = new CustomerProfileService(profileStore, () => NOW);
    const gates = new ConversationGates(gateStore, () => now);
    const pets =
      petsStub !== undefined
        ? (petsStub as CustomerPetsService)
        : new CustomerPetsService(
            new InMemoryLocalPetStore(profileStore),
            {
              getCustomerByPhone: () =>
                Promise.resolve(structuredClone(lookup.current)),
            },
            client() satisfies Record<keyof CustomerPetsClient, jest.Mock>,
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
      new MinimalCartService(api, new InMemoryConversationStore()),
      undefined,
      undefined,
      undefined,
      profiles,
      gates,
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
    const system = () => {
      const value = seen.at(-1)?.system;
      return typeof value === 'string' ? value : '';
    };
    const lastUser = () =>
      seen
        .at(-1)
        ?.messages?.filter((m) => m.role === 'user')
        .at(-1)?.content;
    const tools = () => Object.keys(seen.at(-1)?.tools ?? {});
    return { agent, seen, system, lastUser, tools, turn };
  };
  return {
    boot,
    gateStore,
    profileStore,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A fresh script each time (the mock model consumes its steps). */
const ask = () => [[call('askWhichPet'), say('¿Para cuál de sus perritos?')]];
const lineOf = (system: string) =>
  system.split('\n').find((l) => l.startsWith('Mascota de este pedido'));

describe('T4c-2a which-pet question (S3, S12, S13)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('P2: askWhichPet → «¿Para quién es?» with one button per pet and a 15-minute pet_choice row holding the request', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    const decision = await h.turn('busco croquetas', ask());
    expect(h.tools()).toContain('askWhichPet');
    expect(decision.reply).toBe('¿Para quién es?');
    expect(decision.interactive).toEqual({
      type: 'buttons',
      buttons: [
        {
          id: `pet_pick:backend:${BRUNO_ID}`,
          title: 'Bruno (Chihuahua, c…',
        },
        { id: `pet_pick:backend:${MAX_ID}`, title: 'Max (Labrador, adul…' },
      ],
      prompt: '¿Para quién es?',
    });
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toEqual({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: {
        purpose: 'request',
        options: [
          { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
          { ref: `backend:${MAX_ID}`, text: 'Max' },
        ],
        request: 'busco croquetas',
      },
      expiresAt: new Date(NOW.getTime() + MINIMAL_PET_CHOICE_TTL_MS),
    });
  });

  it('P2: the multi-pet prompt tells the model to call askWhichPet', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('hola');
    expect(h.system()).toContain(
      'antes de buscar llame askWhichPet (la aplicación pregunta «¿Para quién es?» con botones)',
    );
  });

  it('P3/P4: a tap continues the original request with «Mascota de este pedido» and clears the gate', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', ask());
    const decision = await h.turn(
      'Max (Labrador, adul…',
      [[say('Para Max te recomiendo Nupec adulto raza grande.')]],
      `pet_pick:backend:${MAX_ID}`,
    );
    expect(decision.reply).toBe(
      'Para Max te recomiendo Nupec adulto raza grande.',
    );
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toBe(
      'Mascota de este pedido (la eligió el cliente): "Max", perro, raza "Labrador" (raza grande), edad "~3 años" (adulto). ' +
        'Búsqueda para esta mascota: «croquetas perro adulto raza grande». ' +
        'Continúe la solicitud del cliente para esta mascota; no vuelva a preguntar para cuál es.',
    );
    // The chosen pet is settled: no second question this turn.
    expect(h.tools()).not.toContain('askWhichPet');
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it('P3: a tap with no live question is a stale button (no model call)', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('hola');
    const calls = h.seen.length;
    const decision = await h.turn('Max', [], `pet_pick:backend:${MAX_ID}`);
    expect(decision.reply).toBe(STALE);
    expect(h.seen).toHaveLength(calls);
  });

  it('P3: a tap of a pet no longer known (archived meanwhile) is stale and clears the gate', async () => {
    const lookup = { current: customer([pet({}), max()]) };
    const w = world(lookup);
    await w.boot().turn('busco croquetas', ask());
    // A new process sees only Bruno now (Max archived in the POS).
    lookup.current = customer([pet({})]);
    const h = w.boot();
    const decision = await h.turn('Max', [], `pet_pick:backend:${MAX_ID}`);
    expect(decision.reply).toBe(STALE);
    expect(h.seen).toHaveLength(0);
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it('P3: a tap of a ref the question did not offer is stale', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', ask());
    const decision = await h.turn('Luna', [], 'pet_pick:legacy');
    expect(decision.reply).toBe(STALE);
  });

  it.each(['para Max', 'Max', 'Es para max!', 'para el Max'])(
    'P3: the bare text %j answers the question like the tap',
    async (text) => {
      const w = world({ current: customer([pet({}), max()]) });
      const h = w.boot();
      await h.turn('busco croquetas', ask());
      await h.turn(text, [[say('Para Max…')]]);
      expect(h.lastUser()).toBe('busco croquetas');
      expect(lineOf(h.system())).toContain('"Max"');
      await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
    },
  );

  it('P3: any other text is a new message and clears the gate', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', ask());
    await h.turn('mejor dime el horario', [[say('Abrimos a las 9.')]]);
    expect(h.lastUser()).toBe('mejor dime el horario');
    expect(lineOf(h.system())).toBeUndefined();
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
    // The name afterwards no longer answers anything.
    await h.turn('Max', [[say('¿Qué necesita para Max?')]]);
    expect(h.lastUser()).toBe('Max');
    expect(lineOf(h.system())).toBeUndefined();
  });

  it('S13: after 15 minutes the answer is a new message', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', ask());
    w.advance(MINIMAL_PET_CHOICE_TTL_MS);
    await h.turn('para Max', [[say('¿Qué necesita para Max?')]]);
    expect(h.lastUser()).toBe('para Max');
    expect(lineOf(h.system())).toBeUndefined();
    const calls = h.seen.length;
    expect((await h.turn('Max', [], `pet_pick:backend:${MAX_ID}`)).reply).toBe(
      STALE,
    );
    expect(h.seen).toHaveLength(calls);
  });

  it('S13: just before 15 minutes the tap still continues the request', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', ask());
    w.advance(MINIMAL_PET_CHOICE_TTL_MS - 1000);
    await h.turn('Max', [[say('Ok')]], `pet_pick:backend:${MAX_ID}`);
    expect(h.lastUser()).toBe('busco croquetas');
  });

  it('P1: after a restart the tap still continues the original request', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    await w.boot().turn('quiero un shampoo antipulgas', ask());
    const restarted = w.boot();
    await restarted.turn(
      'Bruno',
      [[say('Para Bruno…')]],
      `pet_pick:backend:${BRUNO_ID}`,
    );
    expect(restarted.lastUser()).toBe('quiero un shampoo antipulgas');
    expect(lineOf(restarted.system())).toContain('"Bruno"');
  });

  it('S12: 11+ pets → a list of the 9 most recent and «Otra mascota»; that row asks the name, which then answers', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      pet({
        id: `c0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        name: `Pet${i + 1}`,
        // Pet12 is the newest, Pet1 the oldest.
        createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      }),
    );
    const w = world({ current: customer(many) });
    const h = w.boot();
    const decision = await h.turn('busco croquetas', ask());
    const rows =
      decision.interactive?.type === 'list' ? decision.interactive.rows : [];
    expect(decision.interactive).toMatchObject({
      type: 'list',
      buttonText: 'Ver mascotas',
      prompt: '¿Para quién es?',
    });
    expect(rows.map((row) => row.title)).toEqual([
      'Pet12',
      'Pet11',
      'Pet10',
      'Pet9',
      'Pet8',
      'Pet7',
      'Pet6',
      'Pet5',
      'Pet4',
      'Otra mascota',
    ]);
    expect(rows[0]).toEqual({
      id: `pet_pick:backend:${many[11].id}`,
      title: 'Pet12',
      description: 'Chihuahua, cachorro',
    });
    expect(rows[9]).toEqual({
      id: 'pet_pick:other',
      title: 'Otra mascota',
      description: 'Escríbame su nombre',
    });
    const other = await h.turn('Otra mascota', [], 'pet_pick:other');
    expect(other.reply).toBe(
      '¿Cómo se llama? Escríbame el nombre de su mascota.',
    );
    expect(other.interactive).toBeUndefined();
    await h.turn('Pet1', [[say('Para Pet1…')]]);
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toContain('"Pet1"');
  });

  it('P5: «olvida mis datos» deletes the pet_choice row', async () => {
    const w = world({ current: customer([pet({}), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', ask());
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.not.toBeNull();
    await h.turn('olvida mis datos');
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
    const calls = h.seen.length;
    expect((await h.turn('Max', [], `pet_pick:backend:${MAX_ID}`)).reply).toBe(
      STALE,
    );
    expect(h.seen).toHaveLength(calls);
  });

  it.each([
    ['no pet', []],
    ['one pet', [pet({})]],
  ])('P2: askWhichPet is not offered with %s', async (_label, pets) => {
    const w = world({ current: customer(pets) });
    const h = w.boot();
    await h.turn('busco croquetas');
    expect(h.tools()).toContain('rememberPetDetails');
    expect(h.tools()).not.toContain('askWhichPet');
  });

  it('P2: askWhichPet is not offered on a turn whose pet prepare ran over budget', async () => {
    const known: KnownPet[] = [
      { ref: `backend:${BRUNO_ID}`, name: 'Bruno', source: 'backend' },
      { ref: `backend:${MAX_ID}`, name: 'Max', source: 'backend' },
    ];
    const stub: PetsStub = {
      prepare: () => new Promise<void>(() => undefined),
      capture: () => Promise.resolve(),
      promptLines: () => null,
      afterCheckout: () => Promise.resolve(),
      knownPets: () => known,
      knownPetsByRecency: () => known,
      chosenPetPromptLine: () => null,
    };
    const w = world({ current: customer([]) });
    const h = w.boot(stub);
    await h.turn('busco croquetas');
    expect(h.tools()).toContain('rememberPetDetails');
    expect(h.tools()).not.toContain('askWhichPet');
  }, 10_000);
});
