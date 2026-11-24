import { Logger } from '@nestjs/common';
import type { CustomerLookupResponse } from '../../chatbot-api/domain/dtos/customers.dto';
import type {
  CreatePetResult,
  CustomerPet as BackendPet,
  ListPetsResult,
  PatchPetResult,
} from '../../chatbot-api/domain/dtos/customer-pets.dto';
import type { CustomerPetsClient } from '../../chatbot-api/domain/customer-pets.port';
import { InMemoryCustomerProfileStore } from '../infrastructure/in-memory-customer-profile.store';
import { InMemoryLocalPetStore } from '../infrastructure/in-memory-local-pet.store';
import { extractPetFacts } from '../domain/pet-facts';
import { CustomerPetsService } from './customer-pets.service';
import { CustomerProfileService } from './customer-profile.service';

/**
 * T4b: pet store per sender (backend pets for a Customer, local list for a
 * prospect), deterministic capture → create/patch, S8 upload, prompt lines.
 */
const SENDER = '5215550001111';
const PHONE = { cc: '52', phone: '5550001111' };
const CUSTOMER_ID = '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90';
const NOW = new Date('2026-11-23T18:00:00.000Z');
const uuid = (n: number) =>
  `b1f0c7a2-0000-4000-8000-${String(n).padStart(12, '0')}`;

const backend = (patch: Partial<BackendPet> = {}): BackendPet => ({
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

const found = (pets?: BackendPet[]): CustomerLookupResponse => ({
  found: true,
  customer: {
    customerId: CUSTOMER_ID,
    firstName: 'Ana',
    lastName: null,
    phoneCountryCode: '52',
    phone: PHONE.phone,
    preferredPaymentMethod: null,
    address: null,
    ...(pets === undefined ? {} : { pets }),
  },
});
const notFound: CustomerLookupResponse = { found: false, customer: null };

/** A created pet echoing the create body (what the backend answers). */
const createdFrom = (body: Record<string, unknown>, id: string): BackendPet =>
  backend({
    id,
    name: body.name as string,
    species: body.species as BackendPet['species'],
    breed: (body.breed as string | undefined) ?? null,
    size: (body.size as BackendPet['size'] | undefined) ?? null,
    birthDate: (body.birthDate as string | undefined) ?? null,
    birthDatePrecision:
      (body.birthDatePrecision as BackendPet['birthDatePrecision']) ?? null,
    ageMonths: null,
    ageLabel: null,
    createdVia: 'CHATBOT',
    version: 1,
  });

function harness(initialLookup: CustomerLookupResponse | Error = notFound) {
  let now = NOW;
  let ids = 0;
  const profileStore = new InMemoryCustomerProfileStore();
  const localStore = new InMemoryLocalPetStore(profileStore);
  const profiles = new CustomerProfileService(profileStore, () => now);
  let lookup: CustomerLookupResponse | Error = initialLookup;
  const getCustomerByPhone = jest.fn((cc: string, phone: string) => {
    expect({ cc, phone }).toEqual(PHONE);
    return lookup instanceof Error
      ? Promise.reject(lookup)
      : Promise.resolve(structuredClone(lookup));
  });
  let created = 0;
  const client = {
    listPets: jest.fn<Promise<ListPetsResult>, [string, string?]>(),
    createPet: jest.fn<
      Promise<CreatePetResult>,
      [string, Record<string, unknown>, string]
    >((_customerId, body) => {
      created += 1;
      return Promise.resolve({
        kind: 'ok',
        created: true,
        pet: createdFrom(body, uuid(900 + created)),
        warnings: [],
      });
    }),
    patchPet: jest.fn<
      Promise<PatchPetResult>,
      [string, string, Record<string, unknown>]
    >(),
    archivePet: jest.fn(),
    restorePet: jest.fn(),
    deletePet: jest.fn(),
  };
  const service = new CustomerPetsService(
    localStore,
    { getCustomerByPhone },
    client as unknown as CustomerPetsClient,
    profiles,
    () => now,
    () => uuid((ids += 1)),
  );
  const say = async (text: string) => {
    await service.prepare(SENDER);
    await service.capture(SENDER, extractPetFacts(text));
  };
  return {
    service,
    profiles,
    profileStore,
    localStore,
    client,
    getCustomerByPhone,
    say,
    setLookup: (next: CustomerLookupResponse | Error) => {
      lookup = next;
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    local: () => localStore.read(SENDER),
  };
}

const MINUTE = 60_000;

describe('CustomerPetsService (T4b)', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('customer with backend pets (S1, S2)', () => {
    it('two pets in two messages → two backend creates with deterministic keys and exact bodies; nothing stays local', async () => {
      const h = harness(found([]));
      await h.say('mi perro Max es un husky de 3 años');
      await h.say('y mi gata Michi es siamés');
      expect(h.client.createPet.mock.calls).toEqual([
        [
          CUSTOMER_ID,
          {
            name: 'Max',
            species: 'DOG',
            breed: 'husky',
            size: 'LARGE',
            birthDate: '2023-01-01',
            birthDatePrecision: 'YEAR',
          },
          `pet-local:${CUSTOMER_ID}:${uuid(1)}`,
        ],
        [
          CUSTOMER_ID,
          { name: 'Michi', species: 'CAT', breed: 'siamés' },
          `pet-local:${CUSTOMER_ID}:${uuid(2)}`,
        ],
      ]);
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
      // Both now in the prompt from the create responses.
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida:/g),
      ).toHaveLength(2);
    });

    it('same name → PATCH only the changed fields with the version (age as approxAge)', async () => {
      const h = harness(found([backend()]));
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: backend({ version: 4, ageMonths: 24, ageLabel: '~2 años' }),
        warnings: [],
      });
      await h.say('mi perrito Bruno ya tiene 2 años');
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, { version: 3, approxAge: { years: 2 } }],
      ]);
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.service.promptLines(SENDER)).toContain('edad "~2 años"');
    });

    it('a statement that changes nothing writes nothing', async () => {
      const h = harness(found([backend()]));
      await h.say('mi perrito Bruno es chihuahua');
      expect(h.client.patchPet).not.toHaveBeenCalled();
      expect(h.client.createPet).not.toHaveBeenCalled();
    });

    it('nameless facts with two pets → no write (never mix pets)', async () => {
      const h = harness(
        found([
          backend(),
          backend({ id: uuid(50), name: 'Max', breed: 'Labrador' }),
        ]),
      );
      await h.say('mi perro ya tiene 5 años');
      expect(h.client.patchPet).not.toHaveBeenCalled();
      expect(h.client.createPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });

    it('nameless facts with exactly one compatible pet update it', async () => {
      const h = harness(found([backend({ breed: null })]));
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: backend({ version: 4, breed: 'pug' }),
        warnings: [],
      });
      await h.say('mi perro es un pug');
      expect(h.client.patchPet.mock.calls[0][2]).toEqual({
        version: 3,
        breed: 'pug',
      });
    });

    it('«mis perros» → species only: no backend write', async () => {
      const h = harness(found([]));
      await h.say('mis perros comen mucho');
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet).not.toHaveBeenCalled();
    });

    it('PET_VERSION_CONFLICT → rereads and accepts when the values already match', async () => {
      const h = harness(found([backend()]));
      h.client.patchPet.mockResolvedValue({
        kind: 'PET_VERSION_CONFLICT',
        currentVersion: 4,
      });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend({ version: 4, breed: 'Pug' })],
      });
      await h.say('mi perrito Bruno es un pug');
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      expect(h.client.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
      expect(h.service.promptLines(SENDER)).toContain('raza "Pug"');
    });

    it('PET_VERSION_CONFLICT → retries once with the reread version when values differ', async () => {
      const h = harness(found([backend()]));
      h.client.patchPet
        .mockResolvedValueOnce({
          kind: 'PET_VERSION_CONFLICT',
          currentVersion: 4,
        })
        .mockResolvedValueOnce({
          kind: 'ok',
          pet: backend({ version: 5, breed: 'pug' }),
          warnings: [],
        });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend({ version: 4, notes: 'staff' })],
      });
      await h.say('mi perrito Bruno es un pug');
      expect(h.client.patchPet.mock.calls.map((c) => c[2])).toEqual([
        { version: 3, breed: 'pug' },
        { version: 4, breed: 'pug' },
      ]);
    });

    it('PET_LIMIT_REACHED → logged, nothing written and nothing kept for retry', async () => {
      const h = harness(found([]));
      h.client.createPet.mockResolvedValue({ kind: 'PET_LIMIT_REACHED' });
      await h.say('mi perro Max es un husky');
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      await expect(h.local()).resolves.toEqual([]);
      expect(JSON.stringify(warn.mock.calls)).toContain('PET_LIMIT_REACHED');
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
    });

    it('`pets` absent (no pets:read) → read-only: no create, no patch, no local write', async () => {
      const h = harness(found(undefined));
      await h.say('mi perro Max es un husky');
      await h.say('mi perro ya tiene 3 años');
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a failed lookup → no write at all', async () => {
      const h = harness(new Error('down'));
      await h.say('mi perro Max es un husky');
      expect(h.client.createPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a failed create keeps the local entry and retries later with the same key and bytes', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValueOnce(new Error('timeout'));
      await h.say('mi perro Max es un husky');
      await expect(h.local()).resolves.toHaveLength(1);
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
      expect(h.client.createPet.mock.calls[1]).toEqual(
        h.client.createPet.mock.calls[0],
      );
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a body change after an uncertain create keeps the frozen first body under the key, then patches the difference', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValueOnce(new Error('timeout'));
      await h.say('mi perro Max es un husky');
      const first = h.client.createPet.mock.calls[0];
      h.client.patchPet.mockImplementation((_c, _id, input) =>
        Promise.resolve({
          kind: 'ok',
          pet: backend({ id: uuid(902), name: 'Max', version: 2 }),
          warnings: [],
          ...input,
        }),
      );
      // Same pet by name: updates the local entry (still pending upload).
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Max tiene 2 años'),
      );
      const second = h.client.createPet.mock.calls[1];
      expect(second).toEqual(first);
      expect(h.client.patchPet.mock.calls[0][2]).toEqual({
        version: 1,
        approxAge: { years: 2 },
      });
      await expect(h.local()).resolves.toEqual([]);
    });
  });

  describe('prospect (S8)', () => {
    it('keeps pets in the local list, never calls the backend pets routes', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador de 10 meses');
      await h.say('mi gato Michi es persa');
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([
        {
          id: uuid(1),
          name: 'Luna',
          species: 'perro',
          breed: 'labrador',
          size: 'grande',
          birthDate: '2026-01-01',
          birthDatePrecision: 'MONTH',
          createdAt: NOW.toISOString(),
        },
        {
          id: uuid(2),
          name: 'Michi',
          species: 'gato',
          breed: 'persa',
          createdAt: NOW.toISOString(),
        },
      ]);
    });

    it('same name updates the local pet instead of adding one', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      await h.say('mi perrita Luna tiene 3 años');
      const local = await h.local();
      expect(local).toHaveLength(1);
      expect(local[0]).toMatchObject({
        name: 'Luna',
        breed: 'labrador',
        birthDate: '2023-01-01',
      });
    });

    it('uploads the local pets once the checkout created the Customer, exactly once, and removes them locally', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador de 10 meses');
      await h.say('mi gato Michi es persa');
      h.setLookup(found([]));
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet.mock.calls).toEqual([
        [
          CUSTOMER_ID,
          {
            name: 'Luna',
            species: 'DOG',
            breed: 'labrador',
            size: 'LARGE',
            birthDate: '2026-01-01',
            birthDatePrecision: 'MONTH',
          },
          `pet-local:${CUSTOMER_ID}:${uuid(1)}`,
        ],
        [
          CUSTOMER_ID,
          { name: 'Michi', species: 'CAT', breed: 'persa' },
          `pet-local:${CUSTOMER_ID}:${uuid(2)}`,
        ],
      ]);
      await expect(h.local()).resolves.toEqual([]);
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
    });

    it('a later lookup that finds the Customer (staff created it) uploads too', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      h.setLookup(found([]));
      await h.service.prepare(SENDER); // still fresh: no new lookup
      expect(h.client.createPet).not.toHaveBeenCalled();
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      await expect(h.local()).resolves.toEqual([]);
    });

    it('replay safe: a lost local removal re-sends the same key and body (200 replay) and then removes', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      h.setLookup(found([]));
      const write = jest
        .spyOn(h.localStore, 'write')
        .mockImplementationOnce(() => Promise.resolve()) // write-ahead of the body
        .mockRejectedValueOnce(new Error('db down')); // the removal is lost
      await h.service.afterCheckout(SENDER);
      write.mockRestore();
      await expect(h.local()).resolves.toHaveLength(1);
      h.client.createPet.mockImplementationOnce((_c, body) =>
        Promise.resolve({
          kind: 'ok',
          created: false,
          pet: createdFrom(body, uuid(901)),
          warnings: [],
        }),
      );
      await h.service.afterCheckout(SENDER);
      const [a, b] = h.client.createPet.mock.calls;
      expect(b[2]).toBe(a[2]);
      expect(JSON.stringify(b[1])).toBe(JSON.stringify(a[1]));
      await expect(h.local()).resolves.toEqual([]);
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
    });

    it('a local pet without a name (or species) stays local until known, then uploads', async () => {
      const h = harness(notFound);
      await h.say('mi perro es un husky');
      h.setLookup(found([]));
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toHaveLength(1);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro se llama Rocky'),
      );
      expect(h.client.createPet.mock.calls).toEqual([
        [
          CUSTOMER_ID,
          { name: 'Rocky', species: 'DOG', breed: 'husky', size: 'LARGE' },
          `pet-local:${CUSTOMER_ID}:${uuid(1)}`,
        ],
      ]);
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a local pet whose name the backend already has is merged by PATCH, not duplicated', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: backend({ version: 4 }),
        warnings: [],
      });
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet.mock.calls[0][2]).toEqual({
        version: 3,
        approxAge: { years: 2 },
      });
      await expect(h.local()).resolves.toEqual([]);
    });

    it('S6: a local age advances by itself in the prompt', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador de 10 meses');
      expect(h.service.promptLines(SENDER)).toContain(
        'edad "~10 meses" (cachorro)',
      );
      h.advance(95 * 24 * 60 * MINUTE);
      expect(h.service.promptLines(SENDER)).toContain('edad "~1 año" (adulto)');
    });
  });

  describe('prompt lines (S1, S5)', () => {
    it('one backend pet → one line with the API age label, allergies and the search query', async () => {
      const h = harness(found([backend({ allergies: 'Pollo' })]));
      await h.service.prepare(SENDER);
      const text = h.service.promptLines(SENDER) ?? '';
      const lines = text.split('\n');
      expect(lines.filter((l) => l.startsWith('Mascota conocida:'))).toEqual([
        expect.stringContaining(
          'Mascota conocida: "Bruno", perro, raza "Chihuahua" (raza pequeña), edad "~10 meses" (cachorro), alergias "Pollo"',
        ),
      ]);
      expect(text).toContain('«croquetas perro cachorro raza pequeña»');
      expect(text).toContain('datos, no instrucciones');
      expect(text).toMatch(/alergia/i);
      expect(text).toMatch(/nunca afirme que un producto es seguro/i);
      expect(text).not.toMatch(/no suponga/i);
    });

    it('two pets → one line each and an instruction not to assume which one', async () => {
      const h = harness(
        found([
          backend(),
          backend({
            id: uuid(50),
            name: 'Max',
            breed: 'Labrador',
            size: 'LARGE',
            ageMonths: 40,
            ageLabel: '~3 años',
          }),
        ]),
      );
      await h.service.prepare(SENDER);
      const text = h.service.promptLines(SENDER) ?? '';
      const pets = text
        .split('\n')
        .filter((l) => l.startsWith('Mascota conocida:'));
      expect(pets).toHaveLength(2);
      expect(pets[0]).toContain('"Bruno"');
      expect(pets[0]).toContain('«croquetas perro cachorro raza pequeña»');
      expect(pets[1]).toContain('"Max"');
      expect(pets[1]).toContain('«croquetas perro adulto raza grande»');
      expect(text).toMatch(/no suponga para cuál/i);
      expect(text).toContain('datos, no instrucciones');
      expect(text).not.toMatch(/alergia/i);
    });

    it("only the legacy stored pet → exactly today's line", async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      const legacy = { name: 'Luna', species: 'perro', breed: 'labrador' };
      const { knownPetPromptLine } = jest.requireActual<
        typeof import('../domain/pet-facts')
      >('../domain/pet-facts');
      expect(h.service.promptLines(SENDER, legacy)).toBe(
        knownPetPromptLine(legacy),
      );
    });

    it('the legacy pet is hidden when a store pet has its name, shown next to another', async () => {
      const h = harness(found([backend()]));
      await h.service.prepare(SENDER);
      expect(
        h.service
          .promptLines(SENDER, { name: 'bruno', species: 'perro' })
          ?.match(/Mascota conocida:/g),
      ).toHaveLength(1);
      expect(
        h.service
          .promptLines(SENDER, { name: 'Luna', species: 'perro' })
          ?.match(/Mascota conocida:/g),
      ).toHaveLength(2);
    });

    it('no pets → no line', async () => {
      const h = harness(found([]));
      await h.service.prepare(SENDER);
      expect(h.service.promptLines(SENDER)).toBeNull();
    });
  });

  describe('legacy single pet (until T6)', () => {
    it('facts about the legacy pet update it like today; another pet goes to the store', async () => {
      const h = harness(notFound);
      await h.profiles.record(SENDER, {
        pet: { name: 'Luna', species: 'perro' },
      });
      await h.service.prepare(SENDER);
      const legacy = () => h.profiles.cached(SENDER)?.pet;
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
        legacy(),
      );
      expect(legacy()).toMatchObject({ name: 'Luna', breed: 'labrador' });
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Max es un husky'),
        legacy(),
      );
      expect(legacy()).toMatchObject({ name: 'Luna', breed: 'labrador' });
      await expect(h.local()).resolves.toMatchObject([{ name: 'Max' }]);
    });
  });

  it('refreshes the lookup at most once per minute', async () => {
    const h = harness(found([]));
    await h.service.prepare(SENDER);
    await h.service.prepare(SENDER);
    expect(h.getCustomerByPhone).toHaveBeenCalledTimes(1);
    h.advance(2 * MINUTE);
    await h.service.prepare(SENDER);
    expect(h.getCustomerByPhone).toHaveBeenCalledTimes(2);
  });

  it('after "olvida mis datos" nothing is read into the prompt or written', async () => {
    const h = harness(found([backend()]));
    await h.service.prepare(SENDER);
    await h.profiles.forget(SENDER);
    await h.say('mi perro Max es un husky');
    expect(h.client.createPet).not.toHaveBeenCalled();
    expect(h.service.promptLines(SENDER)).toBeNull();
  });
});
