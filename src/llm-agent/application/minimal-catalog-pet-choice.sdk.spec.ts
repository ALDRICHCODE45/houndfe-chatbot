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
  // T4c-2b Q2: read before the model on every free-text turn.
  | 'ambiguousEntries'
>;

/** One process: shared durable stores survive `boot()` (a restart). */
function world(lookup: {
  current: CustomerLookupResponse;
  /** T4c-2a-fix J1: `hang` never answers (over the prepare budget),
   *  `fail` rejects (lookup unavailable). */
  mode?: 'hang' | 'fail';
}) {
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
    const outputs: Array<{ toolName: string; output: unknown }> = [];
    const generate: GenerateTextFn = async (input) => {
      seen.push(input);
      const script = scripts.shift() ?? [say()];
      const result = await generateText({
        ...input,
        model: new MockLanguageModelV4({ doGenerate: script } as never),
      });
      for (const s of result.steps)
        for (const r of s.toolResults)
          outputs.push({ toolName: r.toolName, output: r.output });
      return result;
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
                lookup.mode === 'hang'
                  ? new Promise<CustomerLookupResponse>(() => undefined)
                  : lookup.mode === 'fail'
                    ? Promise.reject(new Error('lookup down'))
                    : Promise.resolve(structuredClone(lookup.current)),
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
    const toolOutputs = (name: string) =>
      outputs.filter((o) => o.toolName === name).map((o) => o.output);
    return { agent, seen, system, lastUser, tools, turn, toolOutputs };
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
      // T4c-2a-fix J3: sent instead when the buttons cannot be.
      textFallback:
        '¿Para quién es? ¿Para Bruno (Chihuahua, cachorro) o para Max (Labrador, adulto)?',
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
      ambiguousEntries: () => [],
    };
    const w = world({ current: customer([]) });
    const h = w.boot(stub);
    await h.turn('busco croquetas');
    expect(h.tools()).toContain('rememberPetDetails');
    expect(h.tools()).not.toContain('askWhichPet');
  }, 10_000);
});

describe('T4c-2a-fix which-pet hardening (J1, J4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const OPTION_LINE = (name: string) =>
    `Mascota de este pedido (la eligió el cliente): "${name}" (sus datos no están disponibles en este turno). ` +
    'Continúe la solicitud del cliente para esta mascota; no vuelva a preguntar para cuál es.';

  it('J1: after a restart with a lookup slower than 1500 ms, the tap continues the request from the gate option', async () => {
    const lookup: Parameters<typeof world>[0] = {
      current: customer([pet({}), max()]),
    };
    const w = world(lookup);
    await w.boot().turn('busco croquetas', ask());
    lookup.mode = 'hang';
    const h = w.boot();
    const decision = await h.turn(
      'Max (Labrador, adul…',
      [[say('Para Max…')]],
      `pet_pick:backend:${MAX_ID}`,
    );
    expect(decision.reply).toBe('Para Max…');
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toBe(OPTION_LINE('Max'));
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  }, 10_000);

  it('J1: with the lookup unavailable, the typed «para Max» continues the request', async () => {
    const lookup: Parameters<typeof world>[0] = {
      current: customer([pet({}), max()]),
    };
    const w = world(lookup);
    await w.boot().turn('busco croquetas', ask());
    lookup.mode = 'fail';
    const h = w.boot();
    await h.turn('para Max', [[say('Para Max…')]]);
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toBe(OPTION_LINE('Max'));
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it('J1: in a read-only scope (customer without pets) the tap continues the request', async () => {
    const lookup: Parameters<typeof world>[0] = {
      current: customer([pet({}), max()]),
    };
    const w = world(lookup);
    await w.boot().turn('busco croquetas', ask());
    const readOnly = customer([]);
    delete (readOnly.customer as { pets?: unknown }).pets;
    lookup.current = readOnly;
    const h = w.boot();
    await h.turn(
      'Bruno',
      [[say('Para Bruno…')]],
      `pet_pick:backend:${BRUNO_ID}`,
    );
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toBe(OPTION_LINE('Bruno'));
  });

  it('J1: «Otra mascota» with pets not loaded asks the name; a shown name then continues', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      pet({
        id: `c0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        name: `Pet${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      }),
    );
    const lookup: Parameters<typeof world>[0] = { current: customer(many) };
    const w = world(lookup);
    await w.boot().turn('busco croquetas', ask());
    lookup.mode = 'fail';
    const h = w.boot();
    const other = await h.turn('Otra mascota', [], 'pet_pick:other');
    expect(other.reply).toBe(
      '¿Cómo se llama? Escríbame el nombre de su mascota.',
    );
    await h.turn('Pet12', [[say('Para Pet12…')]]);
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toBe(OPTION_LINE('Pet12'));
  });

  /** A model run that calls askWhichPet, then records the prompt it sees. */
  const askAndRecord = (sink: string[]) => {
    let calls = 0;
    return ((options: { prompt: unknown }) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(call('askWhichPet'));
      sink.push(
        JSON.stringify(
          (options.prompt as Array<{ role: string }>).filter(
            (message) => message.role === 'tool',
          ),
        ),
      );
      return Promise.resolve(say('¿Para cuál?'));
    }) as unknown as unknown[];
  };
  const stubOf = (knownPets: () => KnownPet[]): PetsStub => ({
    prepare: () => Promise.resolve(),
    capture: () => Promise.resolve(),
    promptLines: () => null,
    afterCheckout: () => Promise.resolve(),
    knownPets,
    knownPetsByRecency: knownPets,
    chosenPetPromptLine: () => null,
    ambiguousEntries: () => [],
  });
  const two: KnownPet[] = [
    { ref: `backend:${BRUNO_ID}`, name: 'Bruno', source: 'backend' },
    { ref: `backend:${MAX_ID}`, name: 'Max', source: 'backend' },
  ];

  it.each([
    [
      'no_valid_options',
      'busco croquetas',
      () => [
        { ref: 'backend:bad id', name: 'Bruno', source: 'backend' as const },
        { ref: 'mystery', name: 'Max', source: 'backend' as const },
      ],
    ],
    ['blank_request', '   ', () => two],
  ])('J4: askWhichPet answers %s', async (code, text, known) => {
    const w = world({ current: customer([]) });
    const h = w.boot(stubOf(known));
    const sink: string[] = [];
    await h.turn(text, [askAndRecord(sink)]);
    expect(sink.join('')).toContain(code);
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it('J4: askWhichPet answers fewer_than_two_pets when a pet went away mid-turn', async () => {
    let reads = 0;
    const w = world({ current: customer([]) });
    const h = w.boot(stubOf(() => (++reads <= 1 ? two : two.slice(0, 1))));
    const sink: string[] = [];
    await h.turn('busco croquetas', [askAndRecord(sink)]);
    expect(sink.join('')).toContain('fewer_than_two_pets');
  });
});

describe('T6b a pet_choice row from an older build with the `legacy` ref', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** The row an older build stored when it offered the legacy single pet. */
  const legacyRow = (w: ReturnType<typeof world>, purpose = 'request') =>
    w.gateStore.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload:
        purpose === 'forget'
          ? {
              purpose: 'forget',
              options: [
                { ref: 'legacy', text: 'Luna' },
                { ref: `backend:${MAX_ID}`, text: 'Luna' },
              ],
              name: 'Luna',
            }
          : {
              purpose: 'request',
              options: [
                { ref: 'legacy', text: 'Luna' },
                { ref: `backend:${MAX_ID}`, text: 'Max' },
              ],
              request: 'busco croquetas',
            },
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

  it.each([
    ['pets loaded', undefined],
    ['lookup unavailable', 'fail' as const],
    ['lookup over the budget', 'hang' as const],
  ])(
    '%s: the tap pet_pick:legacy loads without throwing, is stale and clears the gate',
    async (_label, mode) => {
      const w = world({ current: customer([pet({}), max()]), mode });
      await legacyRow(w);
      const h = w.boot();
      const decision = await h.turn('Luna', [], 'pet_pick:legacy');
      expect(decision.reply).toBe(STALE);
      expect(h.seen).toHaveLength(0);
      await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
    },
    10_000,
  );

  it('the forget question: the tap on the legacy row is stale, nothing archived', async () => {
    const w = world({ current: customer([pet({}), max()]), mode: 'fail' });
    await legacyRow(w, 'forget');
    const h = w.boot();
    const decision = await h.turn('Luna', [], 'pet_pick:legacy');
    expect(decision.reply).toBe(STALE);
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it('the typed name of the legacy option is a new message (never the legacy pet), the gate cleared', async () => {
    const w = world({ current: customer([pet({}), max()]), mode: 'fail' });
    await legacyRow(w);
    const h = w.boot();
    await h.turn('Luna', [[say('¿En qué le ayudo?')]]);
    expect(h.lastUser()).toBe('Luna');
    expect(lineOf(h.system())).toBeUndefined();
    await expect(w.gateStore.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it('the other options of the same row still answer it (J1: from the gate option)', async () => {
    const w = world({ current: customer([pet({}), max()]), mode: 'fail' });
    await legacyRow(w);
    const h = w.boot();
    await h.turn('para Max', [[say('Para Max…')]]);
    expect(h.lastUser()).toBe('busco croquetas');
    expect(lineOf(h.system())).toContain('"Max"');
  });

  /**
   * T2-fix J3: the which-pet question keeps the original request (its tap
   * re-runs it), so a store question asked after it in the same run is
   * deferred to that re-run; a store block the run already promised rides
   * on the question (text and text fallback), buttons unchanged.
   */
  describe('T2-fix J3: which-pet question and the store block', () => {
    // The fake backend's branch (scripts/eval EvalFakeApi default).
    const STORE =
      'Nos encuentra en *Tienda de mascotas HoundFe — Sucursal Centro*\n' +
      'Av. Insurgentes Sur 1000, Del Valle, Benito Juárez, Ciudad de México, 03100\n' +
      '*Horario:* Lunes a sábado: 09:00–19:00. Domingo: 10:00–14:00.';
    const TEXT = 'busco croquetas, ¿y dónde están?';

    it('askWhichPet first → getStoreInfo answers store_info_deferred; the question is unchanged and carries no pin', async () => {
      const base = await world({ current: customer([pet({}), max()]) })
        .boot()
        .turn(TEXT, ask());
      const h = world({ current: customer([pet({}), max()]) }).boot();
      const decision = await h.turn(TEXT, [
        [call('askWhichPet'), call('getStoreInfo'), say('¿Para cuál?')],
      ]);
      expect(h.toolOutputs('getStoreInfo')).toEqual([
        { ok: false, error: 'store_info_deferred' },
      ]);
      expect(decision.reply).toBe(base.reply);
      expect(decision.interactive).toEqual(base.interactive);
      expect(decision).not.toHaveProperty('location');
    });

    it('getStoreInfo first → the question, then the store block (also in the text fallback) and the pin', async () => {
      const base = await world({ current: customer([pet({}), max()]) })
        .boot()
        .turn(TEXT, ask());
      const h = world({ current: customer([pet({}), max()]) }).boot();
      const decision = await h.turn(TEXT, [
        [call('getStoreInfo'), call('askWhichPet'), say('¿Para cuál?')],
      ]);
      expect(decision.reply).toBe(`${base.reply}\n\n${STORE}`);
      const interactive = decision.interactive as {
        buttons: unknown;
        prompt: string;
        textFallback: string;
      };
      const baseInteractive = base.interactive as typeof interactive;
      expect(interactive.buttons).toEqual(baseInteractive.buttons);
      expect(interactive.prompt).toBe(baseInteractive.prompt);
      expect(interactive.textFallback).toBe(
        `${baseInteractive.textFallback}\n\n${STORE}`,
      );
      expect(decision.location).toEqual({
        latitude: 19.3907,
        longitude: -99.1716,
        name: 'Tienda de mascotas HoundFe — Sucursal Centro',
        address:
          'Av. Insurgentes Sur 1000, Del Valle, Benito Juárez, Ciudad de México, 03100',
      });
    });
  });
});
