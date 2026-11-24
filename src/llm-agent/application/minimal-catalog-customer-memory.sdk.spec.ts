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

/** T4b: the multi-pet store wired with a fake backend (by-phone + pets). */
interface PetsWiring {
  lookup: CustomerLookupResponse;
  client: Record<string, jest.Mock>;
}

function harness(profileStore: CustomerProfileStore, petsWiring?: PetsWiring) {
  const api = new EvalFakeApi({ kind: 'new' });
  const store = new InMemoryConversationStore();
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 6, historyTurns: 12 },
  } as unknown as ConfigService;
  const seen: Array<{ system?: unknown; tools?: Record<string, unknown> }> = [];
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
  let ids = 0;
  const pets =
    petsWiring === undefined
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
  return { agent, seen, system, turn, cartItems };
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
    expect(pets.createPet).not.toHaveBeenCalled();
    expect(pets.patchPet).not.toHaveBeenCalled();
    await expect(
      new InMemoryLocalPetStore(profileStore).read(SENDER),
    ).resolves.toEqual([]);
  });
});
