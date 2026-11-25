import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryConversationStore } from '../../conversation/infrastructure/in-memory-conversation.store';
import { CustomerProfileService } from '../../customer-profile/application/customer-profile.service';
import { CustomerPetsService } from '../../customer-profile/application/customer-pets.service';
import type { CustomerPetsClient } from '../../chatbot-api/domain/customer-pets.port';
import type { CustomerPet as BackendPet } from '../../chatbot-api/domain/dtos/customer-pets.dto';
import type { CustomerLookupResponse } from '../../chatbot-api/domain/dtos/customers.dto';
import { InMemoryLocalPetStore } from '../../customer-profile/infrastructure/in-memory-local-pet.store';
import type { CustomerProfileStore } from '../../customer-profile/domain/customer-profile';
import { InMemoryCustomerProfileStore } from '../../customer-profile/infrastructure/in-memory-customer-profile.store';
import { EvalFakeApi } from '../../../scripts/eval/fixtures/fake-api';
import { applyCustomerStyle } from '../domain/customer-style';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCartService } from './minimal-cart.service';
import {
  FORGET_MY_DATA_REPLY,
  MinimalCatalogAgentService,
} from './minimal-catalog-agent.service';

/**
 * S1 persistent customer memory on the real customer route: the stored
 * style seeds a fresh session, the "Cliente conocido" prompt line, the
 * rememberPetDetails tool, per-turn style/name writes and "olvida mis datos".
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-07T12:00:00.000Z');

const product = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Catalog fixture 1: Nupec adult large-breed croquetas 18 kg (no variants).
const NUPEC = 1;
const selectionRef = (p: number): string => {
  const reference = new MinimalCartSelections(SENDER).register({
    productId: product(p),
    productName: 'Fixture',
  });
  if (reference === null) throw new Error('fixture ref');
  return reference;
};

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

/** T4c-1: the exact pet-memory guidance every conversation with a profile
 *  store gets (pinned; changed deliberately from the T4b-fix A4 text;
 *  T4c-1-fix H5 adds the forgetPet `pending` sentence). */
const PET_MEMORY_INSTRUCTIONS_T4C1 =
  'Memoria del cliente: si el cliente cuenta datos de su mascota (nombre, especie, raza, tamaño, edad, alergias), llame rememberPetDetails solo con lo que él dijo; nunca invente ni deduzca datos. ' +
  'Haga como máximo una sola pregunta sobre la mascota por conversación, y solo si ayuda a una recomendación. ' +
  'Si hay una sola línea "Mascota conocida", siga su indicación: busque directo con searchCatalog con esos datos y diga brevemente por qué ("para Luna, que es labrador adulta, te recomiendo…"); pregunte solo lo que realmente falte. ' +
  'Si hay varias, siga la indicación que las acompaña. ' +
  'Si el cliente dice que una mascota ya no está (murió, se perdió, la regaló) o pide olvidarla, llame forgetPet con su nombre y el motivo que él dio; responda con tacto y calidez, en pocas palabras, sin ofrecer productos para esa mascota. ' +
  'Si forgetPet responde ok false, no se guardó nada: dígalo con amabilidad y pregunte de cuál mascota se trata. ' +
  'Si forgetPet responde pending true, todavía se está guardando: no diga que ya la olvidó; responda con tacto sin confirmarlo.';

/** T4c-1: the exact tool descriptions (pinned). */
const REMEMBER_PET_DESCRIPTION =
  'Guarda datos que el cliente dijo explícitamente sobre SU mascota para recordarlos en otras conversaciones. ' +
  'Incluya solo lo que el cliente escribió (nombre, especie, raza, tamaño, edad, alergias, notas); omita lo demás. Nunca invente ni deduzca.';
const FORGET_PET_DESCRIPTION =
  'Deja de recordar una mascota del cliente que ya no está o que pidió olvidar («Bruno ya no está», «olvida a Bruno»): la archiva, sin borrar sus pedidos. ' +
  'name: el nombre que dio el cliente. reason: el motivo en sus palabras, solo si lo dijo. Si responde ok false, no se guardó nada. ' +
  'Si responde pending true, todavía se está guardando: no diga que ya la olvidó; responda con tacto sin confirmarlo.';

/** T4b: the multi-pet store wired with a fake backend (by-phone + pets). */
interface PetsWiring {
  lookup: CustomerLookupResponse;
  client: Record<string, jest.Mock>;
}

/** T4b-fix: a stand-in pet store to control the timing of each call. */
type PetsStub = Pick<
  CustomerPetsService,
  'prepare' | 'capture' | 'promptLines' | 'afterCheckout'
> &
  Partial<
    Pick<CustomerPetsService, 'captureAllergy' | 'forgetPet' | 'forgetAll'>
  >;

function harness(
  profileStore: CustomerProfileStore,
  petsWiring?: PetsWiring,
  petsStub?: PetsStub,
) {
  const api = new EvalFakeApi({ kind: 'new' });
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
  // T4b-fix-2 D: the tool outputs of each run, and a hook that runs before
  // the model (to act while a turn is in flight).
  const toolOutputs: unknown[] = [];
  const hooks: { beforeModel?: () => Promise<void> } = {};
  let scripts: unknown[][] = [];
  const generate: GenerateTextFn = async (input) => {
    seen.push(input);
    await hooks.beforeModel?.();
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
  let ids = 0;
  const pets =
    petsStub !== undefined
      ? (petsStub as CustomerPetsService)
      : petsWiring === undefined
        ? undefined
        : new CustomerPetsService(
            new InMemoryLocalPetStore(
              profileStore as InMemoryCustomerProfileStore,
            ),
            {
              getCustomerByPhone: () =>
                Promise.resolve(structuredClone(petsWiring.lookup)),
            },
            petsWiring.client as unknown as CustomerPetsClient,
            profiles,
            () => NOW,
            () =>
              `b1f0c7a2-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
          );
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    new MinimalCartService(api, store),
    undefined,
    undefined,
    undefined,
    profiles,
    undefined,
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
    extra: { profileName?: string } = {},
  ) => {
    scripts = runs.length === 0 ? [[say()]] : runs;
    return agent.tryHandle({ senderId: SENDER, text, ...extra });
  };
  const cartItems = async () =>
    (
      (await store.get(SENDER))?.data.minimalCart as
        | { items: unknown[] }
        | undefined
    )?.items ?? [];
  const system = () => {
    const value = seen.at(-1)?.system;
    return typeof value === 'string' ? value : '';
  };
  return { agent, seen, system, turn, cartItems, toolOutputs, hooks };
}

describe('S1 persistent customer memory', () => {
  it('a fresh session (after a restart) starts with the stored tú style', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      { register: 'tu', emojis: true, tone: 'casual' },
      NOW,
    );
    const h = harness(profileStore);
    expect(h.agent.customerStyle(SENDER, 'hola').register).toBe('usted');
    await h.turn('hola');
    expect(h.system()).toContain('Estilo del cliente: tutea');
    expect(h.agent.customerStyle(SENDER, 'gracias').register).toBe('tu');
  });

  it('the current explicit usted wins over the stored tú', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(SENDER, { register: 'tu' }, NOW);
    const h = harness(profileStore);
    await h.turn('Buenas tardes, ¿usted me podría ayudar?');
    expect(h.system()).toContain('Estilo del cliente: de usted');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      register: 'usted',
    });
  });

  it('persists the latest explicit style; a message with no signal keeps it', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    await h.turn('oye, ¿tienes croquetas? 😄');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      register: 'tu',
      emojis: true,
      tone: 'casual',
    });
    // A restart later: "hola" carries no register, the stored tú stays.
    const next = harness(profileStore);
    await next.turn('hola');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      register: 'tu',
      // No emoji in the latest messages: no emojis (S5 rule).
      emojis: false,
    });
    expect(next.system()).toContain('Estilo del cliente: tutea');
  });

  it('adds the "Cliente conocido" line with name, pet and last order (never the phone)', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      {
        displayName: 'Ana P',
        preferredName: 'Anita',
        pet: { name: 'Luna', species: 'perro', breed: 'labrador' },
        lastOrder: {
          folio: 'A-12',
          confirmedAt: '2026-11-01T10:00:00.000Z',
          totalCents: 89900,
        },
      },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('hola');
    const line = h
      .system()
      .split('\n')
      .find((text) => text.startsWith('Cliente conocido:'));
    expect(line).toBeDefined();
    expect(line).toContain('"Anita"');
    expect(line).toContain('"Luna"');
    expect(line).toContain('A-12');
    expect(h.system()).not.toContain(SENDER);
  });

  it('H2: known pet facts reach the prompt as a "Mascota conocida" search hint, not duplicated', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      {
        register: 'tu',
        preferredName: 'Mariana',
        pet: {
          name: 'Luna',
          species: 'perro',
          breed: 'labrador',
          ageText: '3 años',
        },
      },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('busco croquetas para ella');
    const lines = h.system().split('\n');
    const known = lines.find((text) => text.startsWith('Cliente conocido:'));
    const pet = lines.find((text) => text.startsWith('Mascota conocida:'));
    expect(known).toContain('"Mariana"');
    expect(known).not.toContain('labrador');
    expect(pet).toContain('"Luna", perro, raza "labrador" (raza grande)');
    expect(pet).toContain('edad "3 años" (adulto)');
    expect(pet).toContain('«croquetas perro adulto raza grande»');
    expect(pet).toMatch(/no pregunte especie, raza ni tamaño ya conocidos/);
  });

  it('captures a pet statement deterministically when the model calls no tool, and uses it after a restart', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    await h.turn('mi perrita Luna es una labrador de 3 años 🐾', [
      [say('¡Qué linda Luna! 🐾')],
    ]);
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      pet: {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        size: 'grande',
        ageText: '3 años',
      },
    });
    const next = harness(profileStore);
    await next.turn('busco croquetas para ella');
    expect(next.system()).toContain('«croquetas perro adulto raza grande»');
  });

  it('a product query is never stored as a pet fact', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    await h.turn('busco croquetas para perro grande');
    expect((await profileStore.read(SENDER))?.pet).toBeUndefined();
  });

  it('never mixes another pet into the stored one', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      { pet: { name: 'Luna', species: 'perro', breed: 'labrador' } },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('mi perro Max es un husky');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      pet: { name: 'Luna', breed: 'labrador' },
    });
  });

  it.each(['adjustCartItem', 'prepareCartItem'])(
    'a pet statement never writes the cart even if the model calls %s',
    async (toolName) => {
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore);
      await h.turn('Holaaa 😄 oye, ¿tienes croquetas para perro? 🐶', [
        [
          call('searchCatalog', { q: 'croquetas para perro' }),
          say('Tengo varias croquetas para perro.'),
        ],
      ]);
      const input =
        toolName === 'prepareCartItem'
          ? {
              selectionRef: selectionRef(NUPEC),
              operation: 'add',
              quantity: 3,
              quantityText: '3',
              continuation: false,
            }
          : {
              selectionRef: selectionRef(NUPEC),
              delta: 3,
              quantityText: '3',
              continuation: false,
            };
      await h.turn('mi perrita Luna es una labrador de 3 años 🐾', [
        [call(toolName, input), say('¡Listo, agregado!')],
      ]);
      expect(await h.cartItems()).toEqual([]);
      expect((await profileStore.read(SENDER))?.pet?.name).toBe('Luna');
    },
  );

  it('has no "Cliente conocido" line for an unknown customer', async () => {
    const h = harness(new InMemoryCustomerProfileStore());
    await h.turn('hola');
    expect(h.system()).not.toContain('Cliente conocido:');
  });

  it('rememberPetDetails stores only what the model passes, merged with earlier facts', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    expect(Object.keys(h.seen.at(-1)?.tools ?? {})).toEqual([]);
    await h.turn('mi perrita Luna es una labrador de 3 años', [
      [
        call('rememberPetDetails', {
          name: 'Luna',
          species: 'perro',
          breed: 'labrador',
          ageText: '3 años',
        }),
        say('¡Qué linda Luna!'),
      ],
    ]);
    expect(Object.keys(h.seen[0].tools ?? {})).toContain('rememberPetDetails');
    expect(h.system()).toMatch(/rememberPetDetails/);
    expect(h.system()).toMatch(/una sola pregunta sobre la mascota/i);
    await h.turn('ya está grande, pesa 30 kg', [
      [call('rememberPetDetails', { size: 'grande' }), say('Entendido.')],
    ]);
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      pet: {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        ageText: '3 años',
        size: 'grande',
      },
    });
  });

  it('stores the WhatsApp profile name and an explicit "llámame X"', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore);
    await h.turn('hola', [], { profileName: 'Ana Pérez' });
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      displayName: 'Ana Pérez',
    });
    await h.turn('llámame Anita por favor');
    await expect(profileStore.read(SENDER)).resolves.toMatchObject({
      displayName: 'Ana Pérez',
      preferredName: 'Anita',
    });
  });

  it('"olvida mis datos" deletes the profile, confirms without the model and stops writing', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      { preferredName: 'Anita', register: 'tu', pet: { name: 'Luna' } },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('hola');
    const calls = h.seen.length;
    const forgot = await h.turn('olvida mis datos porfa');
    expect(h.seen).toHaveLength(calls);
    // Styled with the style known when the request arrived (tú).
    expect(forgot.reply).toBe(
      applyCustomerStyle(FORGET_MY_DATA_REPLY, {
        register: 'tu',
        emojis: false,
        tone: 'casual',
      }),
    );
    expect(forgot.reply).not.toMatch(/\b(usted|su|sus)\b/);
    await expect(profileStore.read(SENDER)).resolves.toBeNull();
    await h.turn('oye, ¿tienes collares?', [], { profileName: 'Ana' });
    await expect(profileStore.read(SENDER)).resolves.toBeNull();
    expect(h.system()).not.toContain('Cliente conocido:');
  });

  it('a failing profile store never blocks the reply', async () => {
    const failing: CustomerProfileStore = {
      read: () => Promise.reject(new Error('down')),
      upsert: () => Promise.reject(new Error('down')),
      delete: () => Promise.reject(new Error('down')),
      clearPet: () => Promise.reject(new Error('down')),
    };
    const h = harness(failing);
    const result = await h.turn('hola', [[say('Hola, ¿en qué le ayudo?')]]);
    expect(result.reply).toBe('Hola, ¿en qué le ayudo?');
    expect(h.system()).toContain('Estilo del cliente: de usted');
  });
});

describe('T4b multi-pet memory on the customer route', () => {
  const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
  const pet = (patch: Partial<BackendPet>): BackendPet => ({
    id: '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11',
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
    createdAt: '2026-11-23T16:20:11.000Z',
    updatedAt: '2026-11-23T16:20:11.000Z',
    ...patch,
  });
  const customer = (pets?: BackendPet[]): CustomerLookupResponse => ({
    found: true,
    customer: {
      customerId: CUSTOMER_ID,
      firstName: 'Ana',
      lastName: null,
      phoneCountryCode: '52',
      phone: '5550001111',
      preferredPaymentMethod: null,
      address: null,
      ...(pets === undefined ? {} : { pets }),
    },
  });
  const client = () => {
    let n = 0;
    return {
      listPets: jest.fn(),
      createPet: jest.fn<
        Promise<unknown>,
        [string, Record<string, unknown>, string]
      >((_c, body) =>
        Promise.resolve({
          kind: 'ok',
          created: true,
          pet: pet({
            id: `c0000000-0000-4000-8000-00000000000${(n += 1)}`,
            name: body.name as string,
            species: body.species as BackendPet['species'],
            breed: (body.breed as string | undefined) ?? null,
            size: (body.size as BackendPet['size'] | undefined) ?? null,
            birthDate: null,
            birthDatePrecision: null,
            ageMonths: null,
            ageLabel: null,
            version: 1,
          }),
          warnings: [],
        }),
      ),
      patchPet: jest.fn<
        Promise<unknown>,
        [string, string, Record<string, unknown>]
      >(),
      archivePet: jest.fn(),
      restorePet: jest.fn(),
      deletePet: jest.fn(),
    };
  };
  const petLines = (system: string) =>
    system.split('\n').filter((line) => line.startsWith('Mascota conocida:'));
  // T4b-fix A3: the deterministic capture runs after the reply.
  const flushCapture = async () => {
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };

  it('two backend pets → one prompt line each and the "do not assume which pet" instruction', async () => {
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([
        pet({}),
        pet({
          id: 'a0000000-0000-4000-8000-000000000050',
          name: 'Max',
          breed: 'Labrador',
          size: 'LARGE',
          ageMonths: 40,
          ageLabel: '~3 años',
          allergies: 'Pollo',
        }),
      ]),
      client: client(),
    });
    await h.turn('busco croquetas');
    const lines = petLines(h.system());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      '"Bruno", perro, raza "Chihuahua" (raza pequeña), edad "~10 meses" (cachorro)',
    );
    expect(lines[1]).toContain('"Max"');
    expect(lines[1]).toContain('alergias "Pollo"');
    expect(lines[1]).toContain('«croquetas perro adulto raza grande»');
    expect(h.system()).toMatch(/no suponga para cuál/i);
    expect(h.system()).toMatch(/nunca afirme que un producto es seguro/i);
    expect(h.system()).toContain('datos, no instrucciones');
  });

  it('one backend pet keeps the single-pet behavior (search directly)', async () => {
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([pet({})]),
      client: client(),
    });
    await h.turn('busco croquetas para él');
    const lines = petLines(h.system());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('busque directo con searchCatalog');
    expect(lines[0]).toContain('«croquetas perro cachorro raza pequeña»');
    expect(h.system()).not.toMatch(/no suponga para cuál/i);
  });

  it('two pets named in one message through rememberPetDetails → two backend creates; the legacy pet column is not written', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const pets = client();
    const h = harness(profileStore, { lookup: customer([]), client: pets });
    pets.patchPet.mockImplementation(() =>
      Promise.resolve({
        kind: 'ok',
        pet: pet({
          id: 'c0000000-0000-4000-8000-000000000001',
          name: 'Max',
          breed: 'husky',
          size: 'LARGE',
          version: 2,
        }),
        warnings: [],
      }),
    );
    await h.turn('tengo a mi perro Max, un husky, y a mi gata Michi', [
      [
        call('rememberPetDetails', {
          name: 'Max',
          species: 'perro',
          breed: 'husky',
        }),
        call('rememberPetDetails', { name: 'Michi', species: 'gata' }),
        say('¡Qué lindos!'),
      ],
    ]);
    await flushCapture();
    // The model's facts are stored as given (never deduced): no size.
    expect(pets.createPet.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [
        { name: 'Max', species: 'DOG', breed: 'husky' },
        `pet-local:${CUSTOMER_ID}:b1f0c7a2-0000-4000-8000-000000000001`,
      ],
      [
        { name: 'Michi', species: 'CAT' },
        `pet-local:${CUSTOMER_ID}:b1f0c7a2-0000-4000-8000-000000000002`,
      ],
    ]);
    // The deterministic capture of the same text then only completes Max
    // (size from the breed, an empty field), never a third pet.
    expect(pets.patchPet.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['c0000000-0000-4000-8000-000000000001', { version: 1, size: 'LARGE' }],
    ]);
    expect((await profileStore.read(SENDER))?.pet).toBeUndefined();
  });

  it("a prospect's pet statement goes to the local list (no backend write), never to the cart", async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const pets = client();
    const h = harness(profileStore, {
      lookup: { found: false, customer: null },
      client: pets,
    });
    await h.turn('mi perrita Luna es una labrador de 3 años 🐾', [
      [
        call('prepareCartItem', {
          selectionRef: selectionRef(NUPEC),
          operation: 'add',
          quantity: 3,
          quantityText: '3',
          continuation: false,
        }),
        say('¡Listo, agregado!'),
      ],
    ]);
    await flushCapture();
    expect(await h.cartItems()).toEqual([]);
    expect(pets.createPet).not.toHaveBeenCalled();
    expect((await profileStore.read(SENDER))?.pet).toBeUndefined();
    await expect(
      new InMemoryLocalPetStore(profileStore).read(SENDER),
    ).resolves.toMatchObject([
      {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        birthDate: '2023-01-01',
      },
    ]);
    await h.turn('busco croquetas para ella');
    expect(h.system()).toContain('«croquetas perro adulto raza grande»');
  });

  it('a customer without `pets` (no pets:read) → nothing written anywhere', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    const pets = client();
    const h = harness(profileStore, {
      lookup: customer(undefined),
      client: pets,
    });
    await h.turn('mi perro Max es un husky');
    await flushCapture();
    expect(pets.createPet).not.toHaveBeenCalled();
    expect(pets.patchPet).not.toHaveBeenCalled();
    await expect(
      new InMemoryLocalPetStore(profileStore).read(SENDER),
    ).resolves.toEqual([]);
  });
});

describe('T4b-fix A2-A4: the pet store never holds the reply', () => {
  // A4: the exact guidance every conversation with a profile store gets.
  // T4c-1 (deliberate change): allergies in the field list, forgetPet and
  // the tact instruction appended.
  const PET_MEMORY_INSTRUCTIONS_TEXT = PET_MEMORY_INSTRUCTIONS_T4C1;
  const STUB_LINE = 'Mascota conocida: "Bruno" (stub)';
  const REPLY = 'Hola, ¿en qué le ayudo?';
  const NOT_YET = Symbol('not yet');
  const flush = async () => {
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  /** Resolves with the turn, or NOT_YET after `ms` of real time. */
  const within = <T>(promise: Promise<T>, ms = 500) =>
    Promise.race([
      promise,
      new Promise<typeof NOT_YET>((resolve) =>
        setTimeout(() => resolve(NOT_YET), ms),
      ),
    ]);
  /** With fake timers: flushes until the turn settled (or gives up). */
  const settled = async <T>(promise: Promise<T>) => {
    let value: T | typeof NOT_YET = NOT_YET;
    void promise.then((result) => {
      value = result;
    });
    for (let i = 0; i < 40 && value === NOT_YET; i += 1) await flush();
    return value as T | typeof NOT_YET;
  };
  const stub = (patch: Partial<Record<keyof PetsStub, jest.Mock>> = {}) => ({
    prepare: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    capture: jest.fn(() => Promise.resolve()),
    promptLines: jest.fn((): string | null => STUB_LINE),
    afterCheckout: jest.fn(() => Promise.resolve()),
    ...patch,
  });
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const warnings = () =>
    (warn.mock.calls as unknown[][]).map((c) => String(c[0]));

  it('A4: pins the exact PET_MEMORY_INSTRUCTIONS text, followed by the pet lines of a fast prepare', async () => {
    const pets = stub();
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const result = await h.turn('hola', [[say(REPLY)]]);
    expect(result.reply).toBe(REPLY);
    expect(h.system()).toContain(
      `\n\n${PET_MEMORY_INSTRUCTIONS_TEXT}\n${STUB_LINE}`,
    );
    // The prompt is built after the prepare settled.
    expect(pets.prepare.mock.calls).toEqual([[SENDER]]);
    expect(pets.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      pets.promptLines.mock.invocationCallOrder[0],
    );
  });

  it('A4: without pet lines the block is exactly the instructions', async () => {
    const pets = stub({ promptLines: jest.fn(() => null) });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    await h.turn('hola', [[say(REPLY)]]);
    expect(h.system()).toContain(`\n\n${PET_MEMORY_INSTRUCTIONS_TEXT}`);
    expect(h.system()).not.toContain('Mascota conocida:');
  });

  it('A2: a prepare inside the 1500 ms budget is awaited and its pets reach the prompt', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    let loaded = false;
    const pets = stub({
      prepare: jest.fn(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              loaded = true;
              resolve();
            }, 1400),
          ),
      ),
      promptLines: jest.fn(() => (loaded ? STUB_LINE : null)),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const turn = h.turn('hola', [[say(REPLY)]]);
    await jest.advanceTimersByTimeAsync(1400);
    const result = await settled(turn);
    expect(result).not.toBe(NOT_YET);
    expect((result as { reply: string }).reply).toBe(REPLY);
    expect(h.system()).toContain(
      `${PET_MEMORY_INSTRUCTIONS_TEXT}\n${STUB_LINE}`,
    );
  });

  it('A2: a prepare past the 1500 ms budget does not hold the turn; the prompt uses the state the store already has', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const pets = stub({
      prepare: jest.fn(() => new Promise<void>(() => undefined)),
      promptLines: jest.fn(() => 'Mascota conocida: "Bruno" (stale)'),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const turn = h.turn('hola', [[say(REPLY)]]);
    await jest.advanceTimersByTimeAsync(1499);
    expect(await settled(turn)).toBe(NOT_YET);
    await jest.advanceTimersByTimeAsync(1);
    const result = await settled(turn);
    expect(result).not.toBe(NOT_YET);
    expect((result as { reply: string }).reply).toBe(REPLY);
    expect(h.system()).toContain(
      `${PET_MEMORY_INSTRUCTIONS_TEXT}\nMascota conocida: "Bruno" (stale)`,
    );
  });

  it('A2: past the budget the turn writes no pets (tool or deterministic); the prepare finishes in the background and the next turn writes again', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    let finish: () => void = () => undefined;
    const pets = stub({
      prepare: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore, undefined, pets);
    const turn = h.turn('mi perro Max es un husky', [
      [
        call('rememberPetDetails', {
          name: 'Max',
          species: 'perro',
          breed: 'husky',
        }),
        say('¡Qué lindo Max!'),
      ],
    ]);
    await jest.advanceTimersByTimeAsync(1500);
    const result = await settled(turn);
    expect((result as { reply: string }).reply).toBe('¡Qué lindo Max!');
    await flush();
    expect(pets.capture).not.toHaveBeenCalled();
    // The legacy pet column is not a fallback either.
    expect((await profileStore.read(SENDER))?.pet).toBeUndefined();
    finish();
    await flush();
    // Next turn: the prepare is fast again, captures run.
    pets.prepare.mockImplementation(() => Promise.resolve());
    await h.turn('mi perro Max es un husky', [[say('¡Qué lindo Max!')]]);
    await flush();
    expect(pets.capture.mock.calls).toEqual([
      [SENDER, expect.objectContaining({ name: 'Max' }), undefined],
    ]);
    expect(warnings()).toEqual([
      'customer pets prepare over budget (1500 ms): continuing without pet writes this turn',
    ]);
  });

  it('A2: a rejected prepare is logged without throwing and the turn continues', async () => {
    const pets = stub({
      prepare: jest.fn(() => Promise.reject(new TypeError(`down ${SENDER}`))),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const result = await h.turn('hola', [[say(REPLY)]]);
    expect(result.reply).toBe(REPLY);
    expect(warnings()).toContain('customer pets prepare failed: TypeError');
    expect(warnings().join('\n')).not.toContain(SENDER);
  });

  it('A3: a capture that never settles does not delay the reply', async () => {
    const pets = stub({
      capture: jest.fn(() => new Promise<void>(() => undefined)),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const result = await within(
      h.turn('mi perro Max es un husky', [[say('¡Qué lindo Max!')]]),
    );
    expect(result).not.toBe(NOT_YET);
    expect((result as { reply: string }).reply).toBe('¡Qué lindo Max!');
    expect(pets.capture.mock.calls).toEqual([
      [
        SENDER,
        expect.objectContaining({
          name: 'Max',
          species: 'perro',
          breed: 'husky',
        }),
        undefined,
      ],
    ]);
  });

  it('A3: a rejected capture is logged without throwing and the reply is unchanged', async () => {
    const pets = stub({
      capture: jest.fn(() => Promise.reject(new TypeError(`down ${SENDER}`))),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const result = await h.turn('mi perro Max es un husky', [
      [say('¡Qué lindo Max!')],
    ]);
    await flush();
    expect(result.reply).toBe('¡Qué lindo Max!');
    expect(warnings()).toContain('customer pets capture failed: TypeError');
    expect(warnings().join('\n')).not.toContain(SENDER);
  });

  // ─── T4b-fix-2 D1: rememberPetDetails waits at most the budget ────────
  const MAX_TOOL = {
    name: 'Max',
    species: 'perro',
    breed: 'husky',
  };
  const toolTurn = (h: ReturnType<typeof harness>) =>
    h.turn('hola', [
      [call('rememberPetDetails', MAX_TOOL), say('¡Qué lindo Max!')],
    ]);

  it('D1: a fast tool capture keeps today’s result and reply', async () => {
    const pets = stub();
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const result = await toolTurn(h);
    expect(result.reply).toBe('¡Qué lindo Max!');
    expect(h.toolOutputs).toEqual([{ ok: true, remembered: true }]);
    // The tool's capture (the deterministic one of rememberTurn follows).
    expect(pets.capture).toHaveBeenNthCalledWith(
      1,
      SENDER,
      expect.objectContaining(MAX_TOOL),
      undefined,
    );
    expect(warnings()).toEqual([]);
  });

  it('D1: a tool capture that fails inside the budget is still a tool error, as today (no pending result)', async () => {
    const pets = stub({
      capture: jest
        .fn()
        .mockImplementationOnce(() => Promise.reject(new TypeError('down')))
        .mockImplementation(() => Promise.resolve()),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const result = await toolTurn(h);
    expect(result.reply).toBe('¡Qué lindo Max!');
    expect(h.toolOutputs).toEqual([]);
    expect(warnings().join('\n')).not.toContain('over budget');
  });

  it('D1: a tool capture that never settles waits exactly the 1500 ms budget, then the tool returns pending and the reply goes out', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const pets = stub({
      capture: jest.fn(() => new Promise<void>(() => undefined)),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const turn = toolTurn(h);
    expect(await settled(turn)).toBe(NOT_YET);
    await jest.advanceTimersByTimeAsync(1499);
    expect(await settled(turn)).toBe(NOT_YET);
    await jest.advanceTimersByTimeAsync(1);
    const result = await settled(turn);
    expect(result).not.toBe(NOT_YET);
    expect((result as { reply: string }).reply).toBe('¡Qué lindo Max!');
    expect(h.toolOutputs).toEqual([
      { ok: true, remembered: false, pending: true },
    ]);
    expect(warnings()).toContain(
      'customer pets capture over budget (1500 ms): continuing in the background',
    );
  });

  it('D1: a tool capture that fails after the budget is logged by error name only, never thrown', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    let fail: (error: Error) => void = () => undefined;
    const pets = stub({
      capture: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              fail = reject;
            }),
        )
        .mockImplementation(() => Promise.resolve()),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    const turn = toolTurn(h);
    await jest.advanceTimersByTimeAsync(1500);
    const result = await settled(turn);
    expect((result as { reply: string }).reply).toBe('¡Qué lindo Max!');
    fail(new TypeError(`down ${SENDER}`));
    await flush();
    expect(warnings()).toContain('customer pets capture failed: TypeError');
    expect(warnings().join('\n')).not.toContain(SENDER);
  });

  // ─── T4b-fix-2 D2: one pet prepare budget per inbound message ─────────
  it('D2: the dispatcher warm-up never waits for the pets; the turn joins that prepare and pays one 1500 ms budget in total', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const pets = stub({
      prepare: jest.fn(() => new Promise<void>(() => undefined)),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    // The warm-up returns without any timer advancing.
    expect(
      await settled(h.agent.prepareCustomer(SENDER, { warmUp: true })),
    ).not.toBe(NOT_YET);
    const turn = h.turn('hola', [[say(REPLY)]]);
    await jest.advanceTimersByTimeAsync(1499);
    expect(await settled(turn)).toBe(NOT_YET);
    await jest.advanceTimersByTimeAsync(1);
    const result = await settled(turn);
    expect((result as { reply: string }).reply).toBe(REPLY);
    // One prepare for the message: the turn joined the warm-up's.
    expect(pets.prepare.mock.calls).toEqual([[SENDER]]);
    expect(warnings()).toEqual([
      'customer pets prepare over budget (1500 ms): continuing without pet writes this turn',
    ]);
  });

  it('D2: a warm-up whose prepare settled is not joined; the turn prepares again (today’s calls and reply)', async () => {
    const pets = stub();
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    await h.agent.prepareCustomer(SENDER, { warmUp: true });
    await flush();
    const result = await h.turn('hola', [[say(REPLY)]]);
    expect(result.reply).toBe(REPLY);
    expect(pets.prepare.mock.calls).toEqual([[SENDER], [SENDER]]);
    expect(h.system()).toContain(
      `${PET_MEMORY_INSTRUCTIONS_TEXT}\n${STUB_LINE}`,
    );
  });

  it('D2: a warm-up during a running turn never flips petsOverBudget for that turn', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const pets = stub();
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    let release: () => void = () => undefined;
    let reached = false;
    h.hooks.beforeModel = () =>
      new Promise<void>((resolve) => {
        reached = true;
        release = resolve;
      });
    const turn = toolTurn(h);
    for (let i = 0; i < 40 && !reached; i += 1) await flush();
    expect(reached).toBe(true);
    // A second message of the same sender arrives: its warm-up prepare
    // never settles and runs past the budget while the turn is in flight.
    pets.prepare.mockImplementation(() => new Promise<void>(() => undefined));
    void h.agent.prepareCustomer(SENDER, { warmUp: true });
    await jest.advanceTimersByTimeAsync(1500);
    release();
    const result = await settled(turn);
    expect((result as { reply: string }).reply).toBe('¡Qué lindo Max!');
    expect(h.toolOutputs).toEqual([{ ok: true, remembered: true }]);
    expect(pets.capture).toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it('D2: a rejected warm-up prepare is logged by error name only and never thrown', async () => {
    const pets = stub({
      prepare: jest.fn(() => Promise.reject(new TypeError(`down ${SENDER}`))),
    });
    const h = harness(new InMemoryCustomerProfileStore(), undefined, pets);
    await expect(
      h.agent.prepareCustomer(SENDER, { warmUp: true }),
    ).resolves.toBeUndefined();
    await flush();
    expect(warnings()).toEqual(['customer pets prepare failed: TypeError']);
  });
});

describe('T4c-1: allergies, forget one pet, forget my data (S5, S7)', () => {
  const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
  const BRUNO_ID = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
  const MAX_ID = 'a0000000-0000-4000-8000-000000000050';
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
    createdAt: '2026-11-23T16:20:11.000Z',
    updatedAt: '2026-11-23T16:20:11.000Z',
    ...patch,
  });
  const maxPet = (patch: Partial<BackendPet> = {}) =>
    pet({
      id: MAX_ID,
      name: 'Max',
      breed: 'Labrador',
      size: 'LARGE',
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
    listPets: jest.fn(),
    createPet: jest.fn(),
    patchPet: jest.fn(),
    archivePet: jest.fn(),
    restorePet: jest.fn(),
    deletePet: jest.fn(),
  });
  const flush = async () => {
    for (let i = 0; i < 10; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('pins the exact guidance and both tool descriptions; the tools are offered together', async () => {
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([]),
      client: client(),
    });
    await h.turn('hola');
    expect(h.system()).toContain(`\n\n${PET_MEMORY_INSTRUCTIONS_T4C1}`);
    const tools = h.seen[0].tools as Record<string, { description?: string }>;
    expect(tools.rememberPetDetails.description).toBe(REMEMBER_PET_DESCRIPTION);
    expect(tools.forgetPet.description).toBe(FORGET_PET_DESCRIPTION);
  });

  it('G1: rememberPetDetails passes the customer’s allergies; a staff allergy is appended, never replaced', async () => {
    const pets = client();
    pets.patchPet.mockResolvedValue({
      kind: 'ok',
      pet: maxPet({ allergies: 'Res; pollo', version: 4 }),
      warnings: [],
    });
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([pet({}), maxPet({ allergies: 'Res' })]),
      client: pets,
    });
    await h.turn('a Max le hace daño el pollo', [
      [
        call('rememberPetDetails', { name: 'Max', allergies: 'pollo' }),
        say('Gracias por avisarme.'),
      ],
    ]);
    await flush();
    expect(h.toolOutputs).toEqual([{ ok: true, remembered: true }]);
    expect(pets.patchPet.mock.calls).toEqual([
      [CUSTOMER_ID, MAX_ID, { version: 3, allergies: 'Res; pollo' }],
    ]);
  });

  it('G1: rememberPetDetails without allergies keeps today’s body and result', async () => {
    const pets = client();
    pets.patchPet.mockResolvedValue({
      kind: 'ok',
      pet: maxPet({ breed: 'labrador', version: 4 }),
      warnings: [],
    });
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([maxPet({ breed: null })]),
      client: pets,
    });
    await h.turn('hola', [
      [
        call('rememberPetDetails', { name: 'Max', breed: 'labrador' }),
        say('¡Qué lindo!'),
      ],
    ]);
    await flush();
    expect(h.toolOutputs).toEqual([{ ok: true, remembered: true }]);
    expect(pets.patchPet.mock.calls).toEqual([
      [CUSTOMER_ID, MAX_ID, { version: 3, breed: 'labrador' }],
    ]);
  });

  it('G1: «Max es alérgico al pollo» is captured deterministically for the known Max (after the reply)', async () => {
    const pets = client();
    pets.patchPet.mockResolvedValue({
      kind: 'ok',
      pet: maxPet({ allergies: 'pollo', version: 4 }),
      warnings: [],
    });
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([pet({}), maxPet()]),
      client: pets,
    });
    const result = await h.turn('Max es alérgico al pollo', [
      [say('Entendido.')],
    ]);
    expect(result.reply).toBe('Entendido.');
    await flush();
    expect(pets.patchPet.mock.calls).toEqual([
      [CUSTOMER_ID, MAX_ID, { version: 3, allergies: 'pollo' }],
    ]);
  });

  it('G1: an allergy statement about an unknown name writes nothing', async () => {
    const pets = client();
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore, {
      lookup: customer([pet({})]),
      client: pets,
    });
    await h.turn('Toby es alérgico al pollo', [[say('Entendido.')]]);
    await flush();
    expect(pets.patchPet).not.toHaveBeenCalled();
    expect(pets.createPet).not.toHaveBeenCalled();
    await expect(
      new InMemoryLocalPetStore(profileStore).read(SENDER),
    ).resolves.toEqual([]);
  });

  it('G2: forgetPet archives the single matching pet with the reason; the model writes the reply', async () => {
    const pets = client();
    pets.archivePet.mockResolvedValue({
      kind: 'ok',
      pet: pet({ status: 'ARCHIVED', archivedReason: 'falleció', version: 4 }),
      warnings: [],
    });
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([pet({}), maxPet()]),
      client: pets,
    });
    const result = await h.turn('Bruno ya no está, falleció ayer', [
      [
        call('forgetPet', { name: 'Bruno', reason: 'falleció' }),
        say('Lo siento mucho por Bruno.'),
      ],
    ]);
    expect(result.reply).toBe('Lo siento mucho por Bruno.');
    expect(h.toolOutputs).toEqual([{ ok: true, forgotten: true }]);
    expect(pets.archivePet.mock.calls).toEqual([
      [CUSTOMER_ID, BRUNO_ID, { version: 3, reason: 'falleció' }],
    ]);
    await h.turn('busco croquetas');
    const lines = h
      .system()
      .split('\n')
      .filter((line) => line.startsWith('Mascota conocida:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"Max"');
  });

  it.each([
    ['Toby', [pet({})], 'no_pet_with_that_name'],
    [
      'Bruno',
      [pet({}), pet({ id: MAX_ID, species: 'CAT' })],
      'several_pets_with_that_name',
    ],
  ])(
    'G2: forgetPet(%s) with no single match writes nothing and says so',
    async (name, list, error) => {
      const pets = client();
      const h = harness(new InMemoryCustomerProfileStore(), {
        lookup: customer(list),
        client: pets,
      });
      await h.turn('olvida a mi mascota', [
        [call('forgetPet', { name }), say('¿De cuál mascota se trata?')],
      ]);
      expect(h.toolOutputs).toEqual([{ ok: false, error }]);
      expect(pets.archivePet).not.toHaveBeenCalled();
    },
  );

  it('G2: without the pet store, forgetPet clears the matching legacy pet', async () => {
    const profileStore = new InMemoryCustomerProfileStore();
    await profileStore.upsert(
      SENDER,
      { preferredName: 'Ana', pet: { name: 'Luna', species: 'perro' } },
      NOW,
    );
    const h = harness(profileStore);
    await h.turn('Luna ya no está', [
      [call('forgetPet', { name: 'luna' }), say('Lo siento mucho.')],
    ]);
    expect(h.toolOutputs).toEqual([{ ok: true, forgotten: true }]);
    const stored = await profileStore.read(SENDER);
    expect(stored?.pet).toBeUndefined();
    expect(stored?.preferredName).toBe('Ana');
    await h.turn('olvida a Toby', [
      [call('forgetPet', { name: 'Toby' }), say('No lo encuentro.')],
    ]);
    expect(h.toolOutputs.at(-1)).toEqual({
      ok: false,
      error: 'no_pet_with_that_name',
    });
  });

  it('G2: a forgetPet that never settles waits the 1500 ms budget, then returns pending', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const stub = {
      prepare: jest.fn(() => Promise.resolve()),
      capture: jest.fn(() => Promise.resolve()),
      captureAllergy: jest.fn(() => Promise.resolve()),
      promptLines: jest.fn(() => null),
      afterCheckout: jest.fn(() => Promise.resolve()),
      forgetPet: jest.fn(() => new Promise<never>(() => undefined)),
    };
    const h = harness(new InMemoryCustomerProfileStore(), undefined, stub);
    let done = false;
    const turn = h
      .turn('Bruno ya no está', [
        [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
      ])
      .then((result) => {
        done = true;
        return result;
      });
    await jest.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const result = await turn;
    expect(result.reply).toBe('Lo siento mucho.');
    expect(h.toolOutputs).toEqual([
      { ok: true, forgotten: false, pending: true },
    ]);
    expect(stub.forgetPet.mock.calls).toEqual([[SENDER, 'Bruno', undefined]]);
  });

  it('G3: «olvida mis datos» deletes every backend pet; the reply text is unchanged', async () => {
    const pets = client();
    pets.listPets.mockResolvedValue({
      kind: 'ok',
      pets: [pet({}), maxPet({ status: 'ARCHIVED', version: 6 })],
    });
    pets.deletePet.mockResolvedValue({ kind: 'ok' });
    const profileStore = new InMemoryCustomerProfileStore();
    const h = harness(profileStore, {
      lookup: customer([pet({})]),
      client: pets,
    });
    await h.turn('hola');
    const calls = h.seen.length;
    const forgot = await h.turn('olvida mis datos');
    expect(h.seen).toHaveLength(calls);
    expect(forgot.reply).toBe(
      applyCustomerStyle(FORGET_MY_DATA_REPLY, {
        register: 'usted',
        emojis: false,
        tone: 'neutral',
      }),
    );
    await flush();
    expect(pets.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
    expect(pets.deletePet.mock.calls).toEqual([
      [CUSTOMER_ID, BRUNO_ID, 3],
      [CUSTOMER_ID, MAX_ID, 6],
    ]);
    await expect(profileStore.read(SENDER)).resolves.toBeNull();
  });

  it('G3: a pet erase that never settles never delays the forget reply', async () => {
    const pets = client();
    pets.listPets.mockImplementation(() => new Promise(() => undefined));
    const h = harness(new InMemoryCustomerProfileStore(), {
      lookup: customer([pet({})]),
      client: pets,
    });
    await h.turn('hola');
    const NOT_YET = Symbol('not yet');
    const forgot = await Promise.race([
      h.turn('olvida mis datos'),
      new Promise<typeof NOT_YET>((resolve) =>
        setTimeout(() => resolve(NOT_YET), 200),
      ),
    ]);
    expect(forgot).not.toBe(NOT_YET);
    expect((forgot as { reply: string }).reply).toBe(
      applyCustomerStyle(FORGET_MY_DATA_REPLY, {
        register: 'usted',
        emojis: false,
        tone: 'neutral',
      }),
    );
    await flush();
    expect(pets.listPets).toHaveBeenCalledTimes(1);
  });

  it('G3: a rejected erase is logged by error name only', async () => {
    const stub = {
      prepare: jest.fn(() => Promise.resolve()),
      capture: jest.fn(() => Promise.resolve()),
      promptLines: jest.fn(() => null),
      afterCheckout: jest.fn(() => Promise.resolve()),
      forgetAll: jest.fn(() => Promise.reject(new TypeError(`down ${SENDER}`))),
    };
    const h = harness(new InMemoryCustomerProfileStore(), undefined, stub);
    const forgot = await h.turn('olvida mis datos');
    expect(forgot.reply).toContain('Listo, borré los datos');
    await flush();
    expect(stub.forgetAll.mock.calls).toEqual([[SENDER]]);
    const warned = (
      (Logger.prototype.warn as unknown as jest.Mock).mock.calls as unknown[][]
    ).map((c) => String(c[0]));
    expect(warned).toContain('customer pets forget failed: TypeError');
    expect(warned.join('\n')).not.toContain(SENDER);
  });

  describe('T4c-1-fix H1: a forgotten pet is never re-created in the same turn (S7)', () => {
    const FORGET_TEXT = 'mi perrito Bruno ya no está, se murió';
    const archived = () =>
      pet({ status: 'ARCHIVED', archivedReason: 'se murió', version: 4 });
    const localPets = (profileStore: InMemoryCustomerProfileStore) =>
      new InMemoryLocalPetStore(profileStore).read(SENDER);

    it('N1: a nameless description in the forgetting message never lands on the pet that remains', async () => {
      const pets = client();
      pets.archivePet.mockResolvedValue({
        kind: 'ok',
        pet: archived(),
        warnings: [],
      });
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore, {
        lookup: customer([pet({}), maxPet()]),
        client: pets,
      });
      await h.turn('ya no está mi perrito, era un chihuahua de 10 años', [
        [
          call('forgetPet', { name: 'Bruno', reason: 'ya no está' }),
          say('Lo siento mucho.'),
        ],
      ]);
      await flush();
      expect(h.toolOutputs).toEqual([{ ok: true, forgotten: true }]);
      expect(pets.archivePet).toHaveBeenCalledTimes(1);
      expect(pets.patchPet).not.toHaveBeenCalled();
      expect(pets.createPet).not.toHaveBeenCalled();
      await expect(localPets(profileStore)).resolves.toEqual([]);
      // The next turn captures again: a nameless fact goes to Max.
      pets.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: maxPet({ version: 4 }),
        warnings: [],
      });
      await h.turn('mi perro tiene 5 años', [[say('¡Qué bien!')]]);
      await flush();
      expect(
        (pets.patchPet.mock.calls as unknown[][]).map((c) => c[1]),
      ).toEqual([MAX_ID]);
    });

    it('N2: in the forgetting message a diminutive of the forgotten name is not created either', async () => {
      const pets = client();
      pets.archivePet.mockResolvedValue({
        kind: 'ok',
        pet: archived(),
        warnings: [],
      });
      const h = harness(new InMemoryCustomerProfileStore(), {
        lookup: customer([pet({}), maxPet()]),
        client: pets,
      });
      await h.turn('mi perrito Brunito ya no está', [
        [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
      ]);
      await flush();
      expect(pets.createPet).not.toHaveBeenCalled();
      expect(pets.patchPet).not.toHaveBeenCalled();
    });

    it('backend pet: archived, then the deterministic capture of the same text sends no create or PATCH', async () => {
      const pets = client();
      pets.archivePet.mockResolvedValue({
        kind: 'ok',
        pet: archived(),
        warnings: [],
      });
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore, {
        lookup: customer([pet({}), maxPet()]),
        client: pets,
      });
      const result = await h.turn(FORGET_TEXT, [
        [
          call('forgetPet', { name: 'Bruno', reason: 'se murió' }),
          say('Lo siento mucho por Bruno.'),
        ],
      ]);
      await flush();
      expect(result.reply).toBe('Lo siento mucho por Bruno.');
      expect(h.toolOutputs).toEqual([{ ok: true, forgotten: true }]);
      expect(pets.archivePet.mock.calls).toEqual([
        [CUSTOMER_ID, BRUNO_ID, { version: 3, reason: 'se murió' }],
      ]);
      expect(pets.createPet).not.toHaveBeenCalled();
      expect(pets.patchPet).not.toHaveBeenCalled();
      await expect(localPets(profileStore)).resolves.toEqual([]);
      expect((await profileStore.read(SENDER))?.pet).toBeUndefined();
      // Next turn inside the window: still not re-created.
      await h.turn('mi perrito Bruno era muy bueno', [[say('Lo sé.')]]);
      await flush();
      expect(pets.createPet).not.toHaveBeenCalled();
      expect(pets.patchPet).not.toHaveBeenCalled();
      await expect(localPets(profileStore)).resolves.toEqual([]);
      const lines = h
        .system()
        .split('\n')
        .filter((line) => line.startsWith('Mascota conocida:'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"Max"');
    });

    it('rememberPetDetails for the pet forgotten earlier in the run returns pet_recently_forgotten and writes nothing', async () => {
      const pets = client();
      pets.archivePet.mockResolvedValue({
        kind: 'ok',
        pet: archived(),
        warnings: [],
      });
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore, {
        lookup: customer([pet({})]),
        client: pets,
      });
      await h.turn('Bruno ya no está', [
        [
          call('forgetPet', { name: 'Bruno' }),
          call('rememberPetDetails', { name: 'bruno', species: 'perro' }),
          say('Lo siento mucho.'),
        ],
      ]);
      await flush();
      expect(h.toolOutputs).toEqual([
        { ok: true, forgotten: true },
        { ok: false, error: 'pet_recently_forgotten' },
      ]);
      expect(pets.createPet).not.toHaveBeenCalled();
      expect(pets.patchPet).not.toHaveBeenCalled();
      await expect(localPets(profileStore)).resolves.toEqual([]);
    });

    it('prospect: the local entry is removed and the same text does not add it back', async () => {
      const pets = client();
      const profileStore = new InMemoryCustomerProfileStore();
      await new InMemoryLocalPetStore(profileStore).write(
        SENDER,
        [
          {
            id: 'b1f0c7a2-0000-4000-8000-000000000099',
            name: 'Bruno',
            species: 'perro',
            createdAt: NOW.toISOString(),
          },
        ],
        NOW,
      );
      const h = harness(profileStore, {
        lookup: { found: false, customer: null },
        client: pets,
      });
      await h.turn(FORGET_TEXT, [
        [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
      ]);
      await flush();
      expect(h.toolOutputs).toEqual([{ ok: true, forgotten: true }]);
      await expect(localPets(profileStore)).resolves.toEqual([]);
      expect(pets.createPet).not.toHaveBeenCalled();
    });

    it('an unknown name: forgetPet says so and the same text still creates nothing', async () => {
      const pets = client();
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore, {
        lookup: { found: false, customer: null },
        client: pets,
      });
      await h.turn(FORGET_TEXT, [
        [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
      ]);
      await flush();
      expect(h.toolOutputs).toEqual([
        { ok: false, error: 'no_pet_with_that_name' },
      ]);
      await expect(localPets(profileStore)).resolves.toEqual([]);
      expect(pets.createPet).not.toHaveBeenCalled();
    });

    it('without the pet store: the legacy pet stays cleared (no deterministic patch, no rememberPetDetails)', async () => {
      const profileStore = new InMemoryCustomerProfileStore();
      await profileStore.upsert(
        SENDER,
        { preferredName: 'Ana', pet: { name: 'Bruno', species: 'perro' } },
        NOW,
      );
      const h = harness(profileStore);
      await h.turn(FORGET_TEXT, [
        [
          call('forgetPet', { name: 'Bruno' }),
          call('rememberPetDetails', { name: 'Bruno', species: 'perro' }),
          say('Lo siento mucho.'),
        ],
      ]);
      expect(h.toolOutputs).toEqual([
        { ok: true, forgotten: true },
        { ok: false, error: 'pet_recently_forgotten' },
      ]);
      const stored = await profileStore.read(SENDER);
      expect(stored?.pet).toBeUndefined();
      expect(stored?.preferredName).toBe('Ana');
      await h.turn('mi perrito Bruno era muy bueno', [[say('Lo sé.')]]);
      expect((await profileStore.read(SENDER))?.pet).toBeUndefined();
    });

    it('another pet named in the same window is still captured', async () => {
      const pets = client();
      pets.archivePet.mockResolvedValue({
        kind: 'ok',
        pet: archived(),
        warnings: [],
      });
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore, {
        lookup: { found: false, customer: null },
        client: pets,
      });
      await h.turn(FORGET_TEXT, [
        [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
      ]);
      await h.turn('ahora tengo una perrita que se llama Kira', [
        [say('¡Qué linda!')],
      ]);
      await flush();
      await expect(localPets(profileStore)).resolves.toMatchObject([
        { name: 'Kira', species: 'perro' },
      ]);
    });

    it('after the window the name is captured again', async () => {
      const realNow = Date.now.bind(Date);
      let offset = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
      const pets = client();
      const profileStore = new InMemoryCustomerProfileStore();
      const h = harness(profileStore, {
        lookup: { found: false, customer: null },
        client: pets,
      });
      await h.turn(FORGET_TEXT, [
        [call('forgetPet', { name: 'Bruno' }), say('Lo siento mucho.')],
      ]);
      await flush();
      offset = 5 * 60_000 + 1;
      await h.turn('mi perrito Bruno es chihuahua', [[say('¡Qué lindo!')]]);
      await flush();
      await expect(localPets(profileStore)).resolves.toMatchObject([
        { name: 'Bruno', species: 'perro' },
      ]);
    });
  });
});
