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
  PET_DIMINUTIVE_PENDING_REPLY,
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
  const conversations = new InMemoryConversationStore();
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
      new MinimalCartService(api, conversations),
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
    /** T4c-2b-fix K5: one stored cart line (a purchase in progress). */
    seedCart: () =>
      conversations.commitMinimalCart(
        SENDER,
        undefined,
        {
          items: [
            {
              productId: 'd0000000-0000-4000-8000-000000000001',
              quantity: 1,
              unitPriceCents: 45000,
            },
          ],
          idempotencyKey: '',
        },
        NOW.toISOString(),
      ),
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
        '¿Bruno es Bruno (Chihuahua, cachorro), Bruno (Labrador, adulto) o es otra mascota? Si es otra, puede responder «es otra».',
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
      textFallback:
        '¿Brunito es Bruno o es otra mascota? Si es otra, puede responder «es otra».',
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
        // T4c-2b-fix K4: the message, continued once answered.
        request: 'mi perrito Brunito tiene 3 años',
      },
    });
    expect(w.backend.createPet).not.toHaveBeenCalled();
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    await expect(w.local()).resolves.toEqual([]);
  });

  it('tap «Bruno» (the forgotten one) writes nothing and the forget stands (K4: the message continues)', async () => {
    const { w, h } = await afterForget();
    await h.turn('mi perrito Brunito tiene 3 años');
    const decision = await h.turn('Bruno', [], 'pet_pick:forgotten');
    await flush();
    expect(decision.reply).toBe('Texto del modelo.');
    expect(h.lastUser()).toBe('mi perrito Brunito tiene 3 años');
    expect(w.backend.createPet).not.toHaveBeenCalled();
    expect(w.backend.patchPet).not.toHaveBeenCalled();
    expect(w.backend.restorePet).not.toHaveBeenCalled();
    await expect(w.local()).resolves.toEqual([]);
    await expect(gateRow(w)).resolves.toBeNull();
  });

  it('a typed «es Bruno» answers it like the tap (nothing written; K4: the message continues)', async () => {
    const { w, h } = await afterForget();
    await h.turn('mi perrito Brunito tiene 3 años');
    const calls = h.seen.length;
    const decision = await h.turn('es Bruno');
    await flush();
    expect(decision.reply).toBe('Texto del modelo.');
    expect(h.seen).toHaveLength(calls + 1);
    expect(h.lastUser()).toBe('mi perrito Brunito tiene 3 años');
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
    expect(decision.reply).toBe('Texto del modelo.');
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
    // K4: the message continues with Max as the turn's pet.
    expect(tapped.reply).toBe('Texto del modelo.');
    expect(h.lastUser()).toBe('Maxito es alérgico al pollo');
    expect(lineOf(h.system())).toContain('"Max"');
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

describe('T4c-2b-fix (S3, S10): pet questions only when they matter, typed «es otra», archived diminutives, the request kept', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
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
  const ambiguousWorld = async () => {
    const w = world({ current: customer([pet(), bruno2(), max()]) });
    await w.seedLocal([blocked()]);
    return w;
  };
  const createEcho = (w: ReturnType<typeof world>, id: string) =>
    w.backend.createPet.mockImplementation(
      (_c: string, body: { name: string }) =>
        Promise.resolve({
          kind: 'ok',
          created: true,
          pet: pet({ id, ...body }),
          warnings: [],
        }),
    );
  const archivedBruno = () =>
    pet({
      status: 'ARCHIVED',
      archivedAt: '2026-11-20T10:00:00.000Z',
      archivedReason: 'falleció',
      version: 4,
    });
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

  describe('K1: the ambiguous question only for a pet reference', () => {
    it('pin: «Mi dirección es Calle Bruno Traven 45, Coyoacán» asks nothing; the model runs', async () => {
      const w = await ambiguousWorld();
      const h = w.boot();
      const decision = await h.turn(
        'Mi dirección es Calle Bruno Traven 45, Coyoacán',
        [[say('Gracias, anoté su dirección.')]],
      );
      expect(decision.reply).toBe('Gracias, anoté su dirección.');
      expect(decision.interactive).toBeUndefined();
      expect(h.seen).toHaveLength(1);
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it.each([
      'Vivo en Av. Bruno Traven 12, col. Centro',
      'es en la colonia Bruno Traven, CP 04000',
      'entre calles Bruno y Juárez, esquina con Reforma',
      'Bruno Traven #45 int 2',
      'hablé con Bruno ayer',
      'Hola, soy Bruno',
      // Verify: a person named like the pet, after «ya/no/se/es».
      'soy Bruno, ya les pagué',
      'Bruno no me contesta',
      'Bruno es mi esposo, él recoge',
    ])('%j (not a pet reference) asks nothing', async (text) => {
      const w = await ambiguousWorld();
      const h = w.boot();
      const decision = await h.turn(text, [[say('Claro.')]]);
      expect(decision.reply).toBe('Claro.');
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it.each([
      'croquetas para Bruno',
      'quiero un shampoo a Bruno',
      'mi perrito Bruno tiene comezón',
      'mi mascota Bruno necesita arena',
      'Bruno tiene comezón, ¿qué le doy?',
      'Bruno come muy poco',
      'Bruno es alérgico al pollo, ¿qué croquetas?',
    ])('%j (a pet reference) asks which Bruno', async (text) => {
      const w = await ambiguousWorld();
      const h = w.boot();
      const decision = await h.turn(text);
      expect(decision.reply).toBe('¿Bruno es alguno de estos?');
      expect(h.seen).toHaveLength(0);
      await expect(gateRow(w)).resolves.toMatchObject({
        payload: { purpose: 'ambiguous', request: text },
      });
    });

    it('still holding: a greeting is not hijacked', async () => {
      const w = await ambiguousWorld();
      const h = w.boot();
      const decision = await h.turn('hola, buenas tardes', [[say('¡Hola!')]]);
      expect(decision.reply).toBe('¡Hola!');
      await expect(gateRow(w)).resolves.toBeNull();
    });
  });

  describe('K2: typed «es otra» answers the ambiguous / diminutive question', () => {
    it('pin Q2: typed «es otra mascota» uploads the entry as a new pet and the original request continues', async () => {
      const w = await ambiguousWorld();
      const h = w.boot();
      await h.turn('croquetas para Bruno');
      createEcho(w, 'c0000000-0000-4000-8000-000000000080');
      const decision = await h.turn('es otra mascota', [
        [say('Para su otro Bruno le recomiendo…')],
      ]);
      expect(decision.reply).toBe('Para su otro Bruno le recomiendo…');
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      expect(w.backend.createPet.mock.calls).toEqual([
        [
          CUSTOMER_ID,
          { name: 'Bruno', species: 'DOG', breed: 'pug' },
          `pet-local:${CUSTOMER_ID}:${LOCAL_ID}`,
        ],
      ]);
      await expect(w.local()).resolves.toEqual([]);
      expect(h.lastUser()).toBe('croquetas para Bruno');
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it('pin Q3: typed «otra» creates Brunito with the facts', async () => {
      const { w, h } = await afterForget();
      await h.turn('mi perrito Brunito tiene 3 años');
      createEcho(w, 'c0000000-0000-4000-8000-000000000081');
      await h.turn('otra', [[say('¡Qué lindo Brunito!')]]);
      await flush();
      expect(w.backend.createPet).toHaveBeenCalledTimes(1);
      expect(w.backend.createPet).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({
          name: 'Brunito',
          species: 'DOG',
          birthDate: expect.any(String) as unknown,
        }),
        expect.any(String),
      );
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it.each([
      'es otra',
      'Otra.',
      'es otra mascota',
      'otra mascota',
      'ninguno',
      'Ninguna',
      'ninguna de esas',
      'no, es otro',
    ])('Q3 typed %j answers «Es otra mascota»', async (text) => {
      const { w, h } = await afterForget();
      await h.turn('mi perrito Brunito tiene 3 años');
      createEcho(w, 'c0000000-0000-4000-8000-000000000082');
      await h.turn(text, [[say('Anotado.')]]);
      await flush();
      expect(w.backend.createPet).toHaveBeenCalledTimes(1);
      expect(w.backend.createPet).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({ name: 'Brunito' }),
        expect.any(String),
      );
    });

    it('the text fallbacks of both questions say how to answer by text', async () => {
      const a = await ambiguousWorld();
      const asked = await a.boot().turn('croquetas para Bruno');
      expect(asked.interactive).toMatchObject({
        textFallback:
          '¿Bruno es Bruno (Chihuahua, cachorro), Bruno (Labrador, adulto) o es otra mascota? Si es otra, puede responder «es otra».',
      });
      const { h } = await afterForget();
      const dim = await h.turn('mi perrito Brunito tiene 3 años');
      expect(dim.interactive).toMatchObject({
        textFallback:
          '¿Brunito es Bruno o es otra mascota? Si es otra, puede responder «es otra».',
      });
    });

    it('still holding: on a request question typed «otra mascota» is a new message, and its «Otra mascota» row still asks the name', async () => {
      const many = Array.from({ length: 11 }, (_, i) =>
        pet({
          id: `e0000000-0000-4000-8000-0000000000${String(10 + i)}`,
          name: `Mascota${String.fromCharCode(65 + i)}`,
          createdAt: `2026-10-${String(10 + i)}T10:00:00.000Z`,
        }),
      );
      const w = world({ current: customer(many) });
      const h = w.boot();
      await h.turn('busco croquetas', [[call('askWhichPet'), say('¿Cuál?')]]);
      const typed = await h.turn('otra mascota', [[say('¿Cómo se llama?')]]);
      expect(typed.reply).toBe('¿Cómo se llama?');
      await expect(gateRow(w)).resolves.toBeNull();
      await h.turn('busco croquetas', [[call('askWhichPet'), say('¿Cuál?')]]);
      const tapped = await h.turn('Otra mascota', [], 'pet_pick:other');
      expect(tapped.reply).toBe(
        '¿Cómo se llama? Escríbame el nombre de su mascota.',
      );
    });
  });

  describe('K3: a diminutive of a pet ARCHIVED in the backend', () => {
    it('pin: after a restart with Bruno ARCHIVED, «mi perrito Brunito tiene 3 años» asks; no createPet', async () => {
      const w = world({ current: customer([max()]) });
      w.backend.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [archivedBruno(), max()],
      });
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años', [
        [say('¡Qué lindo Brunito!')],
      ]);
      await flush();
      expect(decision.reply).toBe('¿Brunito es Bruno o es otra mascota?');
      expect(decision.interactive).toMatchObject({
        type: 'buttons',
        buttons: [
          { id: 'pet_pick:forgotten', title: 'Bruno' },
          { id: 'pet_pick:other', title: 'Es otra mascota' },
        ],
      });
      expect(w.backend.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
      expect(w.backend.createPet).not.toHaveBeenCalled();
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      await expect(w.local()).resolves.toEqual([]);
    });

    it('rememberPetDetails «Brunito» with Bruno ARCHIVED asks too (one listing for the turn)', async () => {
      const w = world({ current: customer([max()]) });
      w.backend.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [archivedBruno(), max()],
      });
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años', [
        [
          call('rememberPetDetails', { name: 'Brunito', ageText: '3 años' }),
          say('Anotado.'),
        ],
      ]);
      await flush();
      expect(h.toolOutputs).toEqual([
        { ok: true, remembered: false, presentedByApplication: true },
      ]);
      expect(decision.reply).toBe('¿Brunito es Bruno o es otra mascota?');
      expect(w.backend.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
      expect(w.backend.createPet).not.toHaveBeenCalled();
    });

    it('T4c-2b-fix-2 M1: the listing fails → no question, logged; the capture goes ahead as before (local entry; the I1 guard, whose listing fails too, holds the create)', async () => {
      const w = world({ current: customer([max()]) });
      w.backend.listPets.mockResolvedValue({ kind: 'FORBIDDEN' });
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años', [
        [say('¡Qué lindo Brunito!')],
      ]);
      await flush();
      expect(decision.reply).toBe('¡Qué lindo Brunito!');
      expect(decision.interactive).toBeUndefined();
      expect(w.backend.createPet).not.toHaveBeenCalled();
      await expect(w.local()).resolves.toMatchObject([
        { name: 'Brunito', species: 'perro' },
      ]);
      await expect(gateRow(w)).resolves.toBeNull();
      expect(
        warn.mock.calls.some((args) =>
          String(args[0]).includes('archived pet names'),
        ),
      ).toBe(true);
    });

    it('nothing archived with that base → captured as a new pet (no question)', async () => {
      const w = world({ current: customer([max()]) });
      createEcho(w, 'c0000000-0000-4000-8000-000000000083');
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años', [
        [say('¡Qué lindo Brunito!')],
      ]);
      await flush();
      expect(decision.reply).toBe('¡Qué lindo Brunito!');
      expect(w.backend.createPet).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({ name: 'Brunito' }),
        expect.any(String),
      );
    });

    it('a name without a diminutive ending never lists archived pets for the question', async () => {
      const w = world({ current: customer([max()]) });
      createEcho(w, 'c0000000-0000-4000-8000-000000000084');
      const h = w.boot();
      await h.turn('mi gata Michi es siamés', [[say('¡Qué linda!')]]);
      await flush();
      // Only the I1 guard's listing before the create.
      expect(w.backend.listPets).toHaveBeenCalledTimes(1);
      expect(w.backend.createPet).toHaveBeenCalledTimes(1);
    });
  });

  describe('K4: the diminutive question keeps the message and continues it', () => {
    const MESSAGE = 'mi perrito Brunito tiene 3 años, ¿qué croquetas le doy?';

    it('pin: the question stores the message; tap «Bruno» writes the facts to Bruno and the model answers the original message', async () => {
      const w = world({ current: customer([pet(), max()]) });
      const h = w.boot();
      const asked = await h.turn(MESSAGE, [[say('¿Qué croquetas…?')]]);
      expect(asked.reply).toBe('¿Brunito es Bruno o es otra mascota?');
      await expect(gateRow(w)).resolves.toMatchObject({
        payload: { purpose: 'diminutive', name: 'Brunito', request: MESSAGE },
      });
      w.backend.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: pet({ version: 4 }),
        warnings: [],
      });
      const calls = h.seen.length;
      const decision = await h.turn(
        'Bruno',
        [
          [
            call('rememberPetDetails', { name: 'Brunito', ageText: '3 años' }),
            say('Para Bruno le recomiendo croquetas de adulto.'),
          ],
        ],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      await flush();
      expect(decision.reply).toBe(
        'Para Bruno le recomiendo croquetas de adulto.',
      );
      expect(decision.interactive).toBeUndefined();
      expect(h.seen).toHaveLength(calls + 1);
      expect(h.lastUser()).toBe(MESSAGE);
      expect(lineOf(h.system())).toContain('"Bruno"');
      expect(w.backend.patchPet).toHaveBeenCalledWith(
        CUSTOMER_ID,
        BRUNO_ID,
        expect.objectContaining({ version: 3 }),
      );
      expect(w.backend.patchPet).toHaveBeenCalledTimes(1);
      expect(w.backend.createPet).not.toHaveBeenCalled();
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it('after a forget: tap «Bruno» (forgotten) writes nothing and the model answers the original message', async () => {
      const { w, h } = await afterForget();
      await h.turn(MESSAGE);
      const decision = await h.turn(
        'Bruno',
        [[say('Le recomiendo croquetas de adulto.')]],
        'pet_pick:forgotten',
      );
      await flush();
      expect(decision.reply).toBe('Le recomiendo croquetas de adulto.');
      expect(h.lastUser()).toBe(MESSAGE);
      expect(w.backend.createPet).not.toHaveBeenCalled();
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it('typed «es otra» creates Brunito and the model answers the original message', async () => {
      const { w, h } = await afterForget();
      await h.turn(MESSAGE);
      createEcho(w, 'c0000000-0000-4000-8000-000000000085');
      const decision = await h.turn('es otra', [
        [say('Para Brunito le recomiendo…')],
      ]);
      await flush();
      expect(decision.reply).toBe('Para Brunito le recomiendo…');
      expect(h.lastUser()).toBe(MESSAGE);
      expect(w.backend.createPet).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['forgotten', 'Entiendo, gracias por contarme.'],
      ['other', 'Gracias, ya la anoté como otra mascota.'],
      [`backend:${BRUNO_ID}`, 'Gracias, ya lo anoté.'],
    ])(
      'a row without the stored message (written by 60de094) still loads; tap %s replies as before (%j, no model)',
      async (ref, text) => {
        expect([
          PET_DIMINUTIVE_FORGOTTEN_REPLY,
          PET_DIMINUTIVE_NEW_REPLY,
          PET_DIMINUTIVE_SAME_REPLY,
        ]).toContain(text);
        const w = world({ current: customer([pet(), max()]) });
        createEcho(w, 'c0000000-0000-4000-8000-000000000086');
        w.backend.patchPet.mockResolvedValue({
          kind: 'ok',
          pet: pet({ version: 4 }),
          warnings: [],
        });
        await w.gateStore.put({
          senderId: SENDER,
          kind: 'pet_choice',
          payload: {
            purpose: 'diminutive',
            options: [
              ref === 'forgotten'
                ? { ref: 'forgotten', text: 'Bruno' }
                : { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
              { ref: 'other', text: 'Es otra mascota' },
            ],
            name: 'Brunito',
            facts: { name: 'Brunito', species: 'perro', ageText: '3 años' },
          },
          expiresAt: new Date(NOW.getTime() + 60_000),
        });
        const h = w.boot();
        const decision = await h.turn('Bruno', [], `pet_pick:${ref}`);
        await flush();
        expect(decision.reply).toBe(text);
        expect(h.seen).toHaveLength(0);
        await expect(gateRow(w)).resolves.toBeNull();
      },
    );
  });

  describe('K5: no diminutive question during a purchase', () => {
    it('pin: with a cart line, «mi perrito Brunito tiene 3 años» asks nothing, writes nothing; the model reply stands', async () => {
      const w = world({ current: customer([pet(), max()]) });
      await w.seedCart();
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años', [
        [say('¡Qué lindo! ¿Seguimos con su pedido?')],
      ]);
      await flush();
      expect(decision.reply).toBe('¡Qué lindo! ¿Seguimos con su pedido?');
      expect(decision.interactive).toBeUndefined();
      expect(w.backend.createPet).not.toHaveBeenCalled();
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it('rememberPetDetails «Brunito» with a cart line writes nothing and asks nothing', async () => {
      const w = world({ current: customer([pet(), max()]) });
      await w.seedCart();
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años', [
        [
          call('rememberPetDetails', { name: 'Brunito', ageText: '3 años' }),
          say('Anotado.'),
        ],
      ]);
      await flush();
      expect(decision.reply).toBe('Anotado.');
      expect(h.toolOutputs).toEqual([
        { ok: false, error: 'pet_name_needs_confirmation' },
      ]);
      expect(w.backend.createPet).not.toHaveBeenCalled();
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      await expect(gateRow(w)).resolves.toBeNull();
    });
  });
});

describe('T4c-2b-fix-2 (S3, S10): pet facts never dropped silently nor confirmed when not written', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const createEcho = (w: ReturnType<typeof world>, id: string) =>
    w.backend.createPet.mockImplementation(
      (_c: string, body: { name: string }) =>
        Promise.resolve({
          kind: 'ok',
          created: true,
          pet: pet({ id, ...body }),
          warnings: [],
        }),
    );
  const archivedNegra = () =>
    pet({
      id: 'f0000000-0000-4000-8000-000000000090',
      name: 'Negra',
      status: 'ARCHIVED',
      archivedAt: '2026-11-20T10:00:00.000Z',
      archivedReason: 'falleció',
      version: 4,
    });
  const NEGRITA = 'mi perrita Negrita tiene 2 años';
  const archivedLogged = () =>
    warn.mock.calls.some((args) =>
      String(args[0]).includes('archived pet names'),
    );

  describe('M1: a failed archived-name lookup never drops a capture', () => {
    it('pin: «mi perrita Negrita tiene 2 años» with the listing failing → no question; the entry is created (I1 guard listing ok)', async () => {
      const w = world({ current: customer([max()]) });
      w.backend.listPets
        .mockRejectedValueOnce(new TypeError('down'))
        .mockResolvedValue({ kind: 'ok', pets: [max()] });
      createEcho(w, 'c0000000-0000-4000-8000-000000000091');
      const h = w.boot();
      const decision = await h.turn(NEGRITA, [[say('¡Qué linda Negrita!')]]);
      await flush();
      expect(decision.reply).toBe('¡Qué linda Negrita!');
      expect(decision.interactive).toBeUndefined();
      await expect(gateRow(w)).resolves.toBeNull();
      expect(w.backend.createPet).toHaveBeenCalledTimes(1);
      expect(w.backend.createPet).toHaveBeenCalledWith(
        CUSTOMER_ID,
        expect.objectContaining({ name: 'Negrita', species: 'DOG' }),
        expect.any(String),
      );
      expect(archivedLogged()).toBe(true);
    });

    it('pin: with Negra ARCHIVED found → «¿Negrita es Negra o es otra mascota?», nothing written', async () => {
      const w = world({ current: customer([max()]) });
      w.backend.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [archivedNegra(), max()],
      });
      const h = w.boot();
      const decision = await h.turn(NEGRITA, [[say('¡Qué linda Negrita!')]]);
      await flush();
      expect(decision.reply).toBe('¿Negrita es Negra o es otra mascota?');
      expect(w.backend.createPet).not.toHaveBeenCalled();
      await expect(w.local()).resolves.toEqual([]);
    });

    it('rememberPetDetails «Negrita» with the listing failing captures it (no pet_name_needs_confirmation)', async () => {
      const w = world({ current: customer([max()]) });
      w.backend.listPets.mockResolvedValue({ kind: 'FORBIDDEN' });
      const h = w.boot();
      await h.turn(NEGRITA, [
        [
          call('rememberPetDetails', {
            name: 'Negrita',
            species: 'perro',
            ageText: '2 años',
          }),
          say('Anotado.'),
        ],
      ]);
      await flush();
      expect(h.toolOutputs).toEqual([{ ok: true, remembered: true }]);
      await expect(w.local()).resolves.toMatchObject([{ name: 'Negrita' }]);
      await expect(gateRow(w)).resolves.toBeNull();
    });

    it('still holding (K1 Q3): a diminutive of a known pet still asks before any write', async () => {
      const w = world({ current: customer([pet(), max()]) });
      const h = w.boot();
      const decision = await h.turn('mi perrito Brunito tiene 3 años');
      await flush();
      expect(decision.reply).toBe('¿Brunito es Bruno o es otra mascota?');
      expect(w.backend.patchPet).not.toHaveBeenCalled();
      expect(w.backend.createPet).not.toHaveBeenCalled();
    });
  });

  /** A diminutive row about Bruno (known, backend), with or without the
   *  customer's stored message. */
  const diminutiveRow = (w: ReturnType<typeof world>, request?: string) =>
    w.gateStore.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: {
        purpose: 'diminutive',
        options: [
          { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
          { ref: 'other', text: 'Es otra mascota' },
        ],
        name: 'Brunito',
        facts: { name: 'Brunito', species: 'perro', ageText: '3 años' },
        ...(request === undefined ? {} : { request }),
      },
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

  describe('M2: a failed or pending write is never confirmed', () => {
    it('a failed PATCH (row without the message) → «no pude», never «Gracias, ya lo anoté.»', async () => {
      const w = world({ current: customer([pet(), max()]) });
      w.backend.patchPet.mockRejectedValue(new TypeError('down'));
      await diminutiveRow(w);
      const h = w.boot();
      const decision = await h.turn(
        'Bruno',
        [],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      await flush();
      expect(decision.reply).toBe(PET_CHOICE_UNAVAILABLE_REPLY);
      expect(decision.reply).not.toBe(PET_DIMINUTIVE_SAME_REPLY);
      expect(h.seen).toHaveLength(0);
      expect(w.backend.patchPet).toHaveBeenCalledTimes(1);
    });

    it('a PATCH slower than 1500 ms → a reply that does not confirm it; it finishes in the background', async () => {
      const w = world({ current: customer([pet(), max()]) });
      let finish: (value: unknown) => void = () => undefined;
      w.backend.patchPet.mockReturnValue(
        new Promise((resolve) => (finish = resolve)),
      );
      await diminutiveRow(w);
      const h = w.boot();
      const decision = await h.turn(
        'Bruno',
        [],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      expect(decision.reply).toBe(PET_DIMINUTIVE_PENDING_REPLY);
      expect(PET_DIMINUTIVE_PENDING_REPLY).toBe('Gracias por contarme.');
      finish({ kind: 'ok', pet: pet({ version: 4 }), warnings: [] });
      await flush();
    });

    it('a failed PATCH with the stored message → the message continues with no chosen-pet line, no second question; rememberPetDetails is told the name needs confirmation (M3)', async () => {
      const w = world({ current: customer([pet(), max()]) });
      w.backend.patchPet.mockRejectedValue(new TypeError('down'));
      await diminutiveRow(
        w,
        'mi perrito Brunito tiene 3 años, ¿qué croquetas?',
      );
      const h = w.boot();
      const decision = await h.turn(
        'Bruno',
        [
          [
            call('rememberPetDetails', { name: 'Brunito', ageText: '3 años' }),
            say('Le recomiendo croquetas de adulto.'),
          ],
        ],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      await flush();
      expect(decision.reply).toBe('Le recomiendo croquetas de adulto.');
      expect(decision.interactive).toBeUndefined();
      expect(h.toolOutputs).toEqual([
        { ok: false, error: 'pet_name_needs_confirmation' },
      ]);
      expect(h.lastUser()).toBe(
        'mi perrito Brunito tiene 3 años, ¿qué croquetas?',
      );
      expect(lineOf(h.system())).toBeUndefined();
    });

    it('still holding (Q3): tap «es Bruno» with a successful PATCH replies «Gracias, ya lo anoté.»', async () => {
      const w = world({ current: customer([pet(), max()]) });
      w.backend.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: pet({ version: 4 }),
        warnings: [],
      });
      await diminutiveRow(w);
      const h = w.boot();
      const decision = await h.turn(
        'Bruno',
        [],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      await flush();
      expect(decision.reply).toBe(PET_DIMINUTIVE_SAME_REPLY);
      expect(w.backend.patchPet).toHaveBeenCalledTimes(1);
    });
  });

  describe('M3: an answer that wrote nothing does not block rememberPetDetails', () => {
    it('pin: pets unavailable on a row with the message → the message continues and rememberPetDetails «Brunito» is recorded (not silenced)', async () => {
      const lookup: Parameters<typeof world>[0] = {
        current: customer([pet(), max()]),
      };
      const w = world(lookup);
      const message = 'mi perrito Brunito tiene 3 años, ¿qué croquetas?';
      await diminutiveRow(w, message);
      lookup.mode = 'fail';
      const h = w.boot();
      const decision = await h.turn(
        'Bruno',
        [
          [
            call('rememberPetDetails', { name: 'Brunito', ageText: '3 años' }),
            say('Le recomiendo croquetas de adulto.'),
          ],
        ],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      await flush();
      expect(decision.reply).toBe('Le recomiendo croquetas de adulto.');
      expect(h.lastUser()).toBe(message);
      expect(h.toolOutputs).not.toContainEqual({
        ok: true,
        remembered: false,
      });
      expect(h.toolOutputs).toEqual([{ ok: true, remembered: true }]);
    });

    it('still holding (K4): after a successful «es Bruno» the continued turn does not write Brunito again', async () => {
      const w = world({ current: customer([pet(), max()]) });
      w.backend.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: pet({ version: 4 }),
        warnings: [],
      });
      await diminutiveRow(w, 'mi perrito Brunito tiene 3 años');
      const h = w.boot();
      await h.turn(
        'Bruno',
        [
          [
            call('rememberPetDetails', { name: 'Brunito', ageText: '3 años' }),
            say('Anotado.'),
          ],
        ],
        `pet_pick:backend:${BRUNO_ID}`,
      );
      await flush();
      expect(h.toolOutputs).toEqual([{ ok: true, remembered: false }]);
      expect(w.backend.patchPet).toHaveBeenCalledTimes(1);
      expect(w.backend.createPet).not.toHaveBeenCalled();
    });
  });

  describe('M4: a failed resolveAmbiguous is not continued as resolved', () => {
    const setup = async () => {
      const w = world({ current: customer([pet(), bruno2(), max()]) });
      await w.seedLocal([
        {
          id: LOCAL_ID,
          name: 'Bruno',
          species: 'perro',
          breed: 'pug',
          createdAt: '2026-11-20T10:00:00.000Z',
          blocked: 'ambiguous',
        },
      ]);
      return w;
    };

    it('pin: a failed PATCH → the message continues with no chosen-pet line, the entry stays blocked and is asked again next time', async () => {
      const w = await setup();
      const h = w.boot();
      await h.turn('croquetas para Bruno');
      w.backend.patchPet.mockRejectedValue(new TypeError('down'));
      const decision = await h.turn(
        'Bruno (Labrador, ad…',
        [[say('Le recomiendo…')]],
        `pet_pick:backend:${BRUNO2_ID}`,
      );
      expect(decision.reply).toBe('Le recomiendo…');
      expect(h.lastUser()).toBe('croquetas para Bruno');
      expect(lineOf(h.system())).toBeUndefined();
      await expect(w.local()).resolves.toMatchObject([
        { id: LOCAL_ID, blocked: 'ambiguous' },
      ]);
      // The 24 h suppression is not kept: the next mention asks again.
      const again = await h.turn('arena para Bruno');
      expect(again.reply).toBe('¿Bruno es alguno de estos?');
    });

    it('still holding (Q2): a candidate tap that resolves continues with that pet', async () => {
      const w = await setup();
      const h = w.boot();
      await h.turn('croquetas para Bruno');
      w.backend.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: bruno2({ breed: 'Labrador', version: 4 }),
        warnings: [],
      });
      await h.turn(
        'Bruno (Labrador, ad…',
        [[say('Para Bruno le recomiendo…')]],
        `pet_pick:backend:${BRUNO2_ID}`,
      );
      expect(lineOf(h.system())).toContain('"Bruno"');
      await expect(w.local()).resolves.toEqual([]);
    });
  });
});
