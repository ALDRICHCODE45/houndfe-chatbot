import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { ConversationGates } from '../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import { CustomerPetsService } from '../../customer-profile/application/customer-pets.service';
import type { CustomerPetsClient } from '../../chatbot-api/domain/customer-pets.port';
import type { CustomerPet as BackendPet } from '../../chatbot-api/domain/dtos/customer-pets.dto';
import type { CustomerLookupResponse } from '../../chatbot-api/domain/dtos/customers.dto';
import type { LocalPet } from '../../customer-profile/domain/customer-pets';
import { InMemoryLocalPetStore } from '../../customer-profile/infrastructure/in-memory-local-pet.store';
import { InMemoryCustomerProfileStore } from '../../customer-profile/infrastructure/in-memory-customer-profile.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import {
  MinimalCatalogAgentService,
  PET_CHOICE_UNAVAILABLE_REPLY,
  PET_DIMINUTIVE_FORGOTTEN_REPLY,
  PET_DIMINUTIVE_NEW_REPLY,
  PET_DIMINUTIVE_SAME_REPLY,
  PET_FORGET_DONE_REPLY,
  PET_FORGET_PENDING_REPLY,
} from './minimal-catalog-agent.service';
import { MINIMAL_PET_CHOICE_TTL_MS } from './gates/pet-choice.gate';

/**
 * T4c-2b (S7, S10, S11, S3): the pet_choice gate for its other purposes on
 * the real customer route — forget one of two same-name pets by tap (Q1),
 * resolve a local entry blocked as ambiguous (Q2), and confirm a diminutive
 * («Brunito») before any write (Q3).
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const BRUNO_ID = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const BRUNO2_ID = 'b0000000-0000-4000-8000-000000000060';
const MAX_ID = 'a0000000-0000-4000-8000-000000000050';
const LOCAL_ID = 'b1f0c7a2-0000-4000-8000-000000000001';
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

const pet = (patch: Partial<BackendPet> = {}): BackendPet => ({
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
const bruno2 = (patch: Partial<BackendPet> = {}) =>
  pet({
    id: BRUNO2_ID,
    breed: 'Labrador',
    size: 'LARGE',
    birthDate: '2023-01-01',
    ageMonths: 40,
    ageLabel: '~3 años',
    createdAt: '2026-10-01T10:00:00.000Z',
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

/** One process: shared durable stores (and backend) survive `boot()`. */
function world(lookup: {
  current: CustomerLookupResponse;
  mode?: 'hang' | 'fail';
}) {
  const now = NOW.getTime();
  const gateStore = new InMemoryConversationGateStore(() => new Date(now));
  const profileStore = new InMemoryCustomerProfileStore();
  const localStore = new InMemoryLocalPetStore(profileStore);
  const backend = client();
  let ids = 100;
  const boot = () => {
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
    const toolOutputs: unknown[] = [];
    let scripts: unknown[][] = [];
    const generate: GenerateTextFn = async (input) => {
      seen.push(input);
      const script = scripts.shift() ?? [say()];
      const result = await generateText({
        ...input,
        model: new MockLanguageModelV4({ doGenerate: script } as never),
      });
      for (const s of result.steps)
        for (const r of s.toolResults) toolOutputs.push(r.output);
      return result;
    };
    const profiles = new CustomerProfileService(profileStore, () => NOW);
    const gates = new ConversationGates(gateStore, () => now);
    const pets = new CustomerPetsService(
      localStore,
      {
        getCustomerByPhone: () =>
          lookup.mode === 'hang'
            ? new Promise<CustomerLookupResponse>(() => undefined)
            : lookup.mode === 'fail'
              ? Promise.reject(new Error('lookup down'))
              : Promise.resolve(structuredClone(lookup.current)),
      },
      backend satisfies Record<keyof CustomerPetsClient, jest.Mock>,
      profiles,
      () => NOW,
      () => `b1f0c7a2-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
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
    return { agent, seen, system, lastUser, toolOutputs, turn };
  };
  return {
    boot,
    backend,
    gateStore,
    profileStore,
    local: () => localStore.read(SENDER),
    seedLocal: (pets: LocalPet[]) => localStore.write(SENDER, pets, NOW),
  };
}

/** Background pet work (captures, uploads) settles. */
const flush = async () => {
  for (let i = 0; i < 20; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};
const lineOf = (system: string) =>
  system.split('\n').find((l) => l.startsWith('Mascota de este pedido'));
const gateRow = (w: ReturnType<typeof world>) =>
  w.gateStore.get(SENDER, 'pet_choice');
const archived = (patch: Partial<BackendPet>) => ({
  kind: 'ok',
  pet: pet({ status: 'ARCHIVED', version: 4, ...patch }),
  warnings: [],
});

describe('T4c-2b Q1: forget one of two pets with the same name (S7, S11)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const forgetBruno = () => [
    [
      call('forgetPet', { name: 'Bruno', reason: 'falleció' }),
      say('Lo siento mucho por Bruno.'),
    ],
  ];

  it('forgetPet with two Brunos asks which one with buttons; the gate keeps purpose, options, name and reason; nothing archived', async () => {
    const w = world({ current: customer([pet(), bruno2(), max()]) });
    const h = w.boot();
    const decision = await h.turn('Bruno ya no está, falleció', forgetBruno());
    expect(h.toolOutputs).toEqual([{ ok: true, presentedByApplication: true }]);
    expect(decision.reply).toBe('¿De cuál Bruno se trata?');
    expect(decision.interactive).toEqual({
      type: 'buttons',
      buttons: [
        { id: `pet_pick:backend:${BRUNO_ID}`, title: 'Bruno (Chihuahua, c…' },
        { id: `pet_pick:backend:${BRUNO2_ID}`, title: 'Bruno (Labrador, ad…' },
      ],
      prompt: '¿De cuál Bruno se trata?',
      textFallback:
        '¿De cuál Bruno se trata? ¿Bruno (Chihuahua, cachorro) o Bruno (Labrador, adulto)?',
    });
    await expect(gateRow(w)).resolves.toEqual({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: {
        purpose: 'forget',
        options: [
          { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
          { ref: `backend:${BRUNO2_ID}`, text: 'Bruno' },
        ],
        name: 'Bruno',
        reason: 'falleció',
      },
      expiresAt: new Date(NOW.getTime() + MINIMAL_PET_CHOICE_TTL_MS),
    });
    expect(w.backend.archivePet).not.toHaveBeenCalled();
  });

  it('the tap archives exactly that Bruno with the reason, replies with tact (no model, no products) and opens the H1 window', async () => {
    const w = world({ current: customer([pet(), bruno2(), max()]) });
    const h = w.boot();
    await h.turn('Bruno ya no está, falleció', forgetBruno());
    w.backend.archivePet.mockResolvedValue(
      archived({ id: BRUNO2_ID, archivedReason: 'falleció' }),
    );
    const calls = h.seen.length;
    const decision = await h.turn(
      'Bruno (Labrador, ad…',
      [],
      `pet_pick:backend:${BRUNO2_ID}`,
    );
    expect(decision.reply).toBe(PET_FORGET_DONE_REPLY);
    expect(PET_FORGET_DONE_REPLY).toBe(
      'Lo siento mucho. Ya no la tendré presente en sus pedidos; aquí estoy para lo que necesite.',
    );
    expect(decision.interactive).toBeUndefined();
    expect(h.seen).toHaveLength(calls);
    expect(w.backend.archivePet.mock.calls).toEqual([
      [CUSTOMER_ID, BRUNO2_ID, { version: 3, reason: 'falleció' }],
    ]);
    await expect(gateRow(w)).resolves.toBeNull();
    // H1: the name stays forgotten for a while; the other Bruno is not
    // patched by a statement about «Bruno» right after.
    await h.turn('mi perrito Bruno es chihuahua de 2 años', [[say('Ok.')]]);
    await flush();
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    expect(w.backend.createPet).not.toHaveBeenCalled();
    const known = h
      .system()
      .split('\n')
      .filter((line) => line.startsWith('Mascota conocida'));
    expect(known.join('\n')).not.toContain('Labrador", edad "~3 años"');
  });

  it('a stale ref (that Bruno is gone from a loaded list) → stale button, nothing archived', async () => {
    const lookup = { current: customer([pet(), bruno2(), max()]) };
    const w = world(lookup);
    await w.boot().turn('Bruno ya no está', forgetBruno());
    lookup.current = customer([pet(), max()]);
    const h = w.boot();
    const decision = await h.turn('Bruno', [], `pet_pick:backend:${BRUNO2_ID}`);
    expect(decision.reply).toBe(STALE);
    expect(w.backend.archivePet).not.toHaveBeenCalled();
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('pets not loaded (lookup down after a restart) → «no pude ahora», nothing archived, the question is dropped', async () => {
    const lookup: { current: CustomerLookupResponse; mode?: 'fail' } = {
      current: customer([pet(), bruno2(), max()]),
    };
    const w = world(lookup);
    await w.boot().turn('Bruno ya no está', forgetBruno());
    lookup.mode = 'fail';
    const h = w.boot();
    const decision = await h.turn('Bruno', [], `pet_pick:backend:${BRUNO2_ID}`);
    expect(decision.reply).toBe(PET_CHOICE_UNAVAILABLE_REPLY);
    expect(PET_CHOICE_UNAVAILABLE_REPLY).toBe(
      'Disculpe, en este momento no pude actualizar los datos de sus mascotas. ¿Me lo puede pedir de nuevo en un momento?',
    );
    expect(w.backend.archivePet).not.toHaveBeenCalled();
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('an archive slower than 1500 ms → a tactful reply that does not confirm it; the archive finishes in the background', async () => {
    const w = world({ current: customer([pet(), bruno2(), max()]) });
    const h = w.boot();
    await h.turn('Bruno ya no está', forgetBruno());
    let finish: (value: unknown) => void = () => undefined;
    w.backend.archivePet.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const decision = await h.turn('Bruno', [], `pet_pick:backend:${BRUNO2_ID}`);
    expect(decision.reply).toBe(PET_FORGET_PENDING_REPLY);
    expect(PET_FORGET_PENDING_REPLY).toBe(
      'Lo siento mucho. Aquí estoy para lo que necesite.',
    );
    expect(w.backend.archivePet).toHaveBeenCalledTimes(1);
    finish(archived({ id: BRUNO2_ID }));
    await flush();
  });

  it('still holding: forgetPet with a single Bruno archives it directly (no question)', async () => {
    const w = world({ current: customer([pet(), max()]) });
    const h = w.boot();
    w.backend.archivePet.mockResolvedValue(archived({}));
    const decision = await h.turn('Bruno ya no está', forgetBruno());
    expect(decision.reply).toBe('Lo siento mucho por Bruno.');
    expect(decision.interactive).toBeUndefined();
    expect(h.toolOutputs).toEqual([{ ok: true, forgotten: true }]);
    expect(w.backend.archivePet.mock.calls).toEqual([
      [CUSTOMER_ID, BRUNO_ID, { version: 3, reason: 'falleció' }],
    ]);
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('still holding: askWhichPet writes the request purpose row', async () => {
    const w = world({ current: customer([pet(), max()]) });
    const h = w.boot();
    await h.turn('busco croquetas', [[call('askWhichPet'), say('¿Cuál?')]]);
    await expect(gateRow(w)).resolves.toMatchObject({
      payload: {
        purpose: 'request',
        options: [
          { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
          { ref: `backend:${MAX_ID}`, text: 'Max' },
        ],
        request: 'busco croquetas',
      },
    });
  });
});

describe('T4c-2b Q2: a local entry blocked as ambiguous (S3)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const blocked = (): LocalPet => ({
    id: LOCAL_ID,
    name: 'Bruno',
    species: 'perro',
    breed: 'pug',
    createdAt: '2026-11-20T10:00:00.000Z',
    blocked: 'ambiguous',
  });
  const setup = async () => {
    const w = world({ current: customer([pet(), bruno2(), max()]) });
    await w.seedLocal([blocked()]);
    return w;
  };

  it('a message naming the blocked Bruno asks «¿Bruno es …?» with its candidates and «Es otra mascota», keeping the message (no model)', async () => {
    const w = await setup();
    const h = w.boot();
    const decision = await h.turn('croquetas para Bruno');
    expect(h.seen).toHaveLength(0);
    expect(decision.reply).toBe('¿Bruno es alguno de estos?');
    expect(decision.interactive).toEqual({
      type: 'buttons',
      buttons: [
        { id: `pet_pick:backend:${BRUNO_ID}`, title: 'Bruno (Chihuahua, c…' },
        { id: `pet_pick:backend:${BRUNO2_ID}`, title: 'Bruno (Labrador, ad…' },
        { id: 'pet_pick:other', title: 'Es otra mascota' },
      ],
      prompt: '¿Bruno es alguno de estos?',
      textFallback:
        '¿Bruno es Bruno (Chihuahua, cachorro), Bruno (Labrador, adulto) o es otra mascota?',
    });
    await expect(gateRow(w)).resolves.toMatchObject({
      payload: {
        purpose: 'ambiguous',
        options: [
          { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
          { ref: `backend:${BRUNO2_ID}`, text: 'Bruno' },
          { ref: 'other', text: 'Es otra mascota' },
        ],
        localId: LOCAL_ID,
        request: 'croquetas para Bruno',
      },
    });
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    expect(w.backend.createPet).not.toHaveBeenCalled();
  });

  it('tapping a candidate resolves the entry into it (PATCH with the bare id) and continues the request with that pet', async () => {
    const w = await setup();
    const h = w.boot();
    await h.turn('croquetas para Bruno');
    w.backend.patchPet.mockResolvedValue({
      kind: 'ok',
      pet: bruno2({ breed: 'Labrador', version: 4 }),
      warnings: [],
    });
    const decision = await h.turn(
      'Bruno (Labrador, ad…',
      [[say('Para Bruno le recomiendo…')]],
      `pet_pick:backend:${BRUNO2_ID}`,
    );
    expect(decision.reply).toBe('Para Bruno le recomiendo…');
    expect(w.backend.patchPet.mock.calls).toEqual([
      [CUSTOMER_ID, BRUNO2_ID, { version: 3, breed: 'pug' }],
    ]);
    await expect(w.local()).resolves.toEqual([]);
    expect(h.lastUser()).toBe('croquetas para Bruno');
    expect(lineOf(h.system())).toContain('"Bruno"');
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('«Es otra mascota» uploads the entry as a new pet and continues the request', async () => {
    const w = await setup();
    const h = w.boot();
    await h.turn('croquetas para Bruno');
    w.backend.createPet.mockImplementation(
      (_c: string, body: { name: string }) =>
        Promise.resolve({
          kind: 'ok',
          created: true,
          pet: pet({ id: 'c0000000-0000-4000-8000-000000000070', ...body }),
          warnings: [],
        }),
    );
    await h.turn(
      'Es otra mascota',
      [[say('¡Anotado! Para su otro Bruno…')]],
      'pet_pick:other',
    );
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    expect(w.backend.createPet.mock.calls).toEqual([
      [
        CUSTOMER_ID,
        // The seeded entry's own facts (no size stored).
        { name: 'Bruno', species: 'DOG', breed: 'pug' },
        `pet-local:${CUSTOMER_ID}:${LOCAL_ID}`,
      ],
    ]);
    await expect(w.local()).resolves.toEqual([]);
    expect(h.lastUser()).toBe('croquetas para Bruno');
  });

  it('asked at most once per entry: the next message naming Bruno goes to the model', async () => {
    const w = await setup();
    const h = w.boot();
    await h.turn('croquetas para Bruno');
    const decision = await h.turn('mejor arena para Bruno', [[say('Claro.')]]);
    expect(decision.reply).toBe('Claro.');
    await expect(gateRow(w)).resolves.toBeNull();
    expect((await w.local())[0]).toMatchObject({ blocked: 'ambiguous' });
  });

  it('a message that does not name the pet goes to the model (nothing asked)', async () => {
    const w = await setup();
    const h = w.boot();
    const decision = await h.turn('busco croquetas', [[say('Claro.')]]);
    expect(decision.reply).toBe('Claro.');
    await expect(gateRow(w)).resolves.toBeNull();
  });
});

describe('T4c-2b Q3: a diminutive of a forgotten or known pet (S10, I4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const afterForget = async () => {
    const w = world({ current: customer([pet(), max()]) });
    const h = w.boot();
    w.backend.archivePet.mockResolvedValue(archived({}));
    await h.turn('Bruno ya no está', [
      [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
    ]);
    await flush();
    return { w, h };
  };

  it('pin: «mi perrito Brunito tiene 3 años» after «Bruno ya no está» asks «¿Brunito es Bruno o es otra mascota?»; nothing created or patched', async () => {
    const { w, h } = await afterForget();
    const decision = await h.turn('mi perrito Brunito tiene 3 años', [
      [say('¡Qué lindo Brunito!')],
    ]);
    await flush();
    expect(decision.reply).toBe('¿Brunito es Bruno o es otra mascota?');
    expect(decision.interactive).toEqual({
      type: 'buttons',
      buttons: [
        { id: 'pet_pick:forgotten', title: 'Bruno' },
        { id: 'pet_pick:other', title: 'Es otra mascota' },
      ],
      prompt: '¿Brunito es Bruno o es otra mascota?',
      textFallback: '¿Brunito es Bruno o es otra mascota?',
    });
    await expect(gateRow(w)).resolves.toMatchObject({
      payload: {
        purpose: 'diminutive',
        options: [
          { ref: 'forgotten', text: 'Bruno' },
          { ref: 'other', text: 'Es otra mascota' },
        ],
        name: 'Brunito',
        facts: { name: 'Brunito', species: 'perro', ageText: '3 años' },
      },
    });
    expect(w.backend.createPet).not.toHaveBeenCalled();
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    await expect(w.local()).resolves.toEqual([]);
  });

  it('tap «Bruno» (the forgotten one) writes nothing and the forget stands', async () => {
    const { w, h } = await afterForget();
    await h.turn('mi perrito Brunito tiene 3 años');
    const decision = await h.turn('Bruno', [], 'pet_pick:forgotten');
    await flush();
    expect(decision.reply).toBe(PET_DIMINUTIVE_FORGOTTEN_REPLY);
    expect(PET_DIMINUTIVE_FORGOTTEN_REPLY).toBe(
      'Entiendo, gracias por contarme.',
    );
    expect(w.backend.createPet).not.toHaveBeenCalled();
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    expect(w.backend.restorePet).not.toHaveBeenCalled();
    await expect(w.local()).resolves.toEqual([]);
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('a typed «es Bruno» answers it like the tap (nothing written, no model)', async () => {
    const { w, h } = await afterForget();
    await h.turn('mi perrito Brunito tiene 3 años');
    const calls = h.seen.length;
    const decision = await h.turn('es Bruno');
    await flush();
    expect(decision.reply).toBe(PET_DIMINUTIVE_FORGOTTEN_REPLY);
    expect(h.seen).toHaveLength(calls);
    expect(w.backend.createPet).not.toHaveBeenCalled();
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('tap «Es otra mascota» writes the captured facts as a new pet', async () => {
    const { w, h } = await afterForget();
    await h.turn('mi perrito Brunito tiene 3 años');
    w.backend.createPet.mockImplementation(
      (_c: string, body: { name: string }) =>
        Promise.resolve({
          kind: 'ok',
          created: true,
          pet: pet({ id: 'c0000000-0000-4000-8000-000000000071', ...body }),
          warnings: [],
        }),
    );
    const decision = await h.turn('Es otra mascota', [], 'pet_pick:other');
    await flush();
    expect(decision.reply).toBe(PET_DIMINUTIVE_NEW_REPLY);
    expect(PET_DIMINUTIVE_NEW_REPLY).toBe(
      'Gracias, ya la anoté como otra mascota.',
    );
    expect(w.backend.createPet).toHaveBeenCalledTimes(1);
    expect(w.backend.createPet).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({ name: 'Brunito', species: 'DOG' }),
      expect.any(String),
    );
    expect(w.backend.patchPet).not.toHaveBeenCalled();
  });

  it('rememberPetDetails with «Maxito» (a known Max) asks first; the tap «Max» sends the facts to Max (never renamed)', async () => {
    const w = world({ current: customer([pet(), max()]) });
    const h = w.boot();
    const decision = await h.turn('Maxito es alérgico al pollo', [
      [
        call('rememberPetDetails', { name: 'Maxito', allergies: 'pollo' }),
        say('Anotado.'),
      ],
    ]);
    await flush();
    expect(h.toolOutputs).toEqual([
      { ok: true, remembered: false, presentedByApplication: true },
    ]);
    expect(decision.reply).toBe('¿Maxito es Max o es otra mascota?');
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    expect(w.backend.createPet).not.toHaveBeenCalled();
    w.backend.patchPet.mockResolvedValue({
      kind: 'ok',
      pet: max({ allergies: 'pollo', version: 4 }),
      warnings: [],
    });
    const tapped = await h.turn('Max', [], `pet_pick:backend:${MAX_ID}`);
    await flush();
    expect(tapped.reply).toBe(PET_DIMINUTIVE_SAME_REPLY);
    expect(PET_DIMINUTIVE_SAME_REPLY).toBe('Gracias, ya lo anoté.');
    expect(w.backend.patchPet.mock.calls).toEqual([
      [CUSTOMER_ID, MAX_ID, { version: 3, allergies: 'pollo' }],
    ]);
    expect(w.backend.createPet).not.toHaveBeenCalled();
  });

  it('still holding: a new unrelated name is captured with no question', async () => {
    const w = world({ current: customer([pet(), max()]) });
    const h = w.boot();
    w.backend.createPet.mockImplementation(
      (_c: string, body: { name: string }) =>
        Promise.resolve({
          kind: 'ok',
          created: true,
          pet: pet({ id: 'c0000000-0000-4000-8000-000000000072', ...body }),
          warnings: [],
        }),
    );
    const decision = await h.turn('mi gata Michi es siamés', [
      [say('¡Qué linda Michi!')],
    ]);
    await flush();
    expect(decision.reply).toBe('¡Qué linda Michi!');
    expect(decision.interactive).toBeUndefined();
    expect(w.backend.createPet).toHaveBeenCalledTimes(1);
    expect(w.backend.createPet).toHaveBeenCalledWith(
      CUSTOMER_ID,
      expect.objectContaining({ name: 'Michi', species: 'CAT' }),
      expect.any(String),
    );
    await expect(gateRow(w)).resolves.toBeNull();
  });
});
