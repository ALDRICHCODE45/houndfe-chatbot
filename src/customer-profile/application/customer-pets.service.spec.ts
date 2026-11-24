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
      // Same pet by name: updates the local entry (still pending upload),
      // retried once the backoff (B1: 1 min after attempt 1) has passed.
      h.advance(MINUTE);
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

  describe('local list read failure (review R4)', () => {
    const restarted = (h: ReturnType<typeof harness>) =>
      new CustomerPetsService(
        h.localStore,
        { getCustomerByPhone: h.getCustomerByPhone },
        h.client as unknown as CustomerPetsClient,
        h.profiles,
        () => NOW,
        () => uuid(50),
      );

    it('a failed local read on a cold cache never overwrites the stored list, and the next turn reads again', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      await h.say('mi gato Michi es persa');
      const service = restarted(h);
      const write = jest.spyOn(h.localStore, 'write');
      jest
        .spyOn(h.localStore, 'read')
        .mockRejectedValueOnce(new Error('pool exhausted'));
      await service.prepare(SENDER);
      await service.capture(
        SENDER,
        extractPetFacts('mi perro Max es un husky'),
      );
      expect(write).not.toHaveBeenCalled();
      expect((await h.local()).map((pet) => pet.name)).toEqual([
        'Luna',
        'Michi',
      ]);
      await service.prepare(SENDER);
      await service.capture(
        SENDER,
        extractPetFacts('mi perro Max es un husky'),
      );
      expect((await h.local()).map((pet) => pet.name)).toEqual([
        'Luna',
        'Michi',
        'Max',
      ]);
    });

    it('a Customer whose local read failed uploads nothing until a read succeeds', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      h.setLookup(found([]));
      const service = restarted(h);
      jest
        .spyOn(h.localStore, 'read')
        .mockRejectedValueOnce(new Error('pool exhausted'));
      await service.prepare(SENDER);
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect((await h.local()).map((pet) => pet.name)).toEqual(['Luna']);
      await service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
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

describe('CustomerPetsService (T4b-fix-B)', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const upstream = (statusCode: number) =>
    Object.assign(new Error('upstream'), { name: 'UpstreamError', statusCode });

  describe('B1: failed creates back off (review R4)', () => {
    it('a failed create persists attempt 1 and the next attempt time; no retry before it', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perro Max es un husky');
      const [entry] = await h.local();
      expect(entry.upload).toMatchObject({
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + MINUTE).toISOString(),
      });
      expect(JSON.stringify(warn.mock.calls)).toMatch(/500.*attempt 1/);
      // Due after one minute: the second attempt fails → 2 minutes.
      h.advance(MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
      expect((await h.local())[0].upload).toMatchObject({
        attempts: 2,
        nextAttemptAt: new Date(NOW.getTime() + 3 * MINUTE).toISOString(),
      });
      // A refresh before the next attempt time does not retry.
      h.advance(MINUTE);
      await h.service.prepare(SENDER);
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(3);
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
      // Nor does a capture about the same pet.
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Max tiene 2 años'),
      );
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
      h.advance(MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(3);
      // Same key and bytes on every attempt.
      const calls = h.client.createPet.mock.calls;
      expect(calls[2]).toEqual(calls[0]);
    });

    it('the backoff is capped at one hour', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perro Max es un husky');
      for (let i = 0; i < 12; i += 1) {
        h.advance(61 * MINUTE);
        await h.service.prepare(SENDER);
      }
      const [entry] = await h.local();
      expect(entry.upload?.attempts).toBe(13);
      const wait =
        Date.parse(entry.upload?.nextAttemptAt ?? '') -
        (NOW.getTime() + 12 * 61 * MINUTE);
      expect(wait).toBe(60 * MINUTE);
      expect(JSON.stringify(warn.mock.calls)).toContain('attempt 13');
    });

    it('a non-ok create answer (IDEMPOTENCY_KEY_IN_FLIGHT) backs off too and is logged with its status', async () => {
      const h = harness(found([]));
      h.client.createPet.mockResolvedValue({
        kind: 'IDEMPOTENCY_KEY_IN_FLIGHT',
      });
      await h.say('mi perro Max es un husky');
      expect((await h.local())[0].upload).toMatchObject({ attempts: 1 });
      expect(JSON.stringify(warn.mock.calls)).toMatch(
        /IDEMPOTENCY_KEY_IN_FLIGHT.*attempt 1/,
      );
    });

    it('an existing entry without the new fields is attempt 0, due now (no migration)', async () => {
      const h = harness(found([]));
      const body = { name: 'Max', species: 'DOG' as const, breed: 'husky' };
      await h.localStore.write(
        SENDER,
        [
          {
            id: uuid(7),
            name: 'Max',
            species: 'perro',
            breed: 'husky',
            createdAt: NOW.toISOString(),
            upload: { customerId: CUSTOMER_ID, body },
          },
        ],
        NOW,
      );
      await h.service.prepare(SENDER);
      expect(h.client.createPet.mock.calls).toEqual([
        [CUSTOMER_ID, body, `pet-local:${CUSTOMER_ID}:${uuid(7)}`],
      ]);
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a success after failures removes the entry', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValueOnce(upstream(503));
      await h.say('mi perro Max es un husky');
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      await expect(h.local()).resolves.toEqual([]);
    });
  });

  describe('B2: staff notes are internal (review R1-001)', () => {
    it('backend notes stay in the prompt marked internal, with the instruction never to quote them', async () => {
      const h = harness(found([backend({ notes: 'Cliente moroso' })]));
      await h.service.prepare(SENDER);
      const text = h.service.promptLines(SENDER) ?? '';
      expect(text).toContain('notas internas de la tienda "Cliente moroso"');
      expect(text).not.toContain('notas "Cliente moroso"');
      expect(text).toMatch(/nunca las cite, repita ni revele/i);
    });

    it('with several pets the instruction appears once', async () => {
      const h = harness(
        found([
          backend({ notes: 'Muerde' }),
          backend({ id: uuid(50), name: 'Max', notes: 'Nervioso' }),
        ]),
      );
      await h.service.prepare(SENDER);
      const text = h.service.promptLines(SENDER) ?? '';
      expect(text.match(/nunca las cite/g)).toHaveLength(1);
      expect(text).toContain('notas internas de la tienda "Muerde"');
      expect(text).toContain('notas internas de la tienda "Nervioso"');
    });

    it('notes the customer gave (local pet) are not marked internal and add no instruction', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, {
        name: 'Luna',
        species: 'perro',
        notes: 'come poco',
      });
      const text = h.service.promptLines(SENDER) ?? '';
      expect(text).toContain('notas "come poco"');
      expect(text).not.toMatch(/internas|nunca las cite/);
    });
  });

  describe('B3: a shadowed legacy pet is not a match candidate (review R3)', () => {
    it('legacy and backend pet with the same name and species → the facts PATCH the backend pet, the legacy pet is untouched', async () => {
      const h = harness(found([backend()]));
      await h.profiles.record(SENDER, {
        pet: { name: 'Bruno', species: 'perro' },
      });
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: backend({ version: 4 }),
        warnings: [],
      });
      await h.service.prepare(SENDER);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrito Bruno ya tiene 2 años'),
        h.profiles.cached(SENDER)?.pet,
      );
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, { version: 3, approxAge: { years: 2 } }],
      ]);
      expect(h.profiles.cached(SENDER)?.pet).toEqual({
        name: 'Bruno',
        species: 'perro',
      });
    });

    it('legacy and local pet with the same name → the local pet gets the facts', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      await h.profiles.record(SENDER, {
        pet: { name: 'Luna', species: 'perro' },
      });
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna tiene 3 años'),
        h.profiles.cached(SENDER)?.pet,
      );
      expect((await h.local())[0]).toMatchObject({
        name: 'Luna',
        birthDate: '2023-01-01',
      });
      expect(h.profiles.cached(SENDER)?.pet).toEqual({
        name: 'Luna',
        species: 'perro',
      });
    });

    it('a legacy pet of another species with the same name is still a candidate', async () => {
      const h = harness(found([backend()]));
      await h.profiles.record(SENDER, {
        pet: { name: 'Bruno', species: 'gato' },
      });
      await h.service.prepare(SENDER);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Bruno es siamés'),
        h.profiles.cached(SENDER)?.pet,
      );
      expect(h.client.patchPet).not.toHaveBeenCalled();
      expect(h.profiles.cached(SENDER)?.pet).toMatchObject({
        name: 'Bruno',
        breed: 'siamés',
      });
    });
  });

  describe('B4: read-only scopes still record legacy pet facts (review R3)', () => {
    const legacyCase = async (lookup: CustomerLookupResponse | Error) => {
      const h = harness(lookup);
      await h.profiles.record(SENDER, {
        pet: { name: 'Luna', species: 'perro' },
      });
      await h.service.prepare(SENDER);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
        h.profiles.cached(SENDER)?.pet,
      );
      return h;
    };

    it('lookup unavailable → the legacy pet is updated through the profile, no pet route or local write', async () => {
      const h = await legacyCase(new Error('down'));
      expect(h.profiles.cached(SENDER)?.pet).toMatchObject({
        name: 'Luna',
        breed: 'labrador',
      });
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });

    it('`pets` absent → the legacy pet is updated through the profile', async () => {
      const h = await legacyCase(found(undefined));
      expect(h.profiles.cached(SENDER)?.pet).toMatchObject({
        name: 'Luna',
        breed: 'labrador',
      });
      await expect(h.local()).resolves.toEqual([]);
    });

    it('facts about another pet are not mixed into the legacy pet (baseline conflict rule)', async () => {
      const h = await legacyCase(new Error('down'));
      const before = h.profiles.cached(SENDER)?.pet;
      expect(before).toMatchObject({ name: 'Luna', breed: 'labrador' });
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Max es un husky'),
        before,
      );
      expect(h.profiles.cached(SENDER)?.pet).toEqual(before);
    });
  });

  describe('B5: captures and local writes are serialized per sender (review R3)', () => {
    it('two overlapping captures both keep their entry', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      const original = h.localStore.write.bind(h.localStore);
      jest.spyOn(h.localStore, 'write').mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return original(...args);
      });
      await Promise.all([
        h.service.capture(
          SENDER,
          extractPetFacts('mi perrita Luna es labrador'),
        ),
        h.service.capture(SENDER, extractPetFacts('mi gato Michi es persa')),
      ]);
      expect((await h.local()).map((pet) => pet.name).sort()).toEqual([
        'Luna',
        'Michi',
      ]);
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida:/g),
      ).toHaveLength(2);
    });

    it('a capture overlapping a refresh never loses its entry', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      h.advance(2 * MINUTE);
      const original = h.localStore.write.bind(h.localStore);
      jest.spyOn(h.localStore, 'write').mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return original(...args);
      });
      await Promise.all([
        h.service.capture(
          SENDER,
          extractPetFacts('mi perrita Luna es labrador'),
        ),
        h.service.prepare(SENDER),
      ]);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      expect((await h.local()).map((pet) => pet.name).sort()).toEqual([
        'Luna',
        'Michi',
      ]);
    });

    const prospectThenCustomer = async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      h.setLookup(found([]));
      // A fresh process (cold cache), like a background prepare after restart.
      const service = new CustomerPetsService(
        h.localStore,
        { getCustomerByPhone: h.getCustomerByPhone },
        h.client as unknown as CustomerPetsClient,
        h.profiles,
        () => NOW,
        () => uuid(80),
      );
      h.getCustomerByPhone.mockClear();
      return { h, service };
    };

    it('two overlapping prepares → one by-phone lookup and one create (single flight)', async () => {
      const { h, service } = await prospectThenCustomer();
      await Promise.all([service.prepare(SENDER), service.prepare(SENDER)]);
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(1);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      await expect(h.local()).resolves.toEqual([]);
    });

    it('two overlapping afterCheckout prepares (forced) → one lookup and one create', async () => {
      const { h, service } = await prospectThenCustomer();
      await Promise.all([
        service.afterCheckout(SENDER),
        service.afterCheckout(SENDER),
        service.prepare(SENDER),
      ]);
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(1);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
    });

    it('afterCheckout during a running prepare still reads again afterwards (the checkout may have created the Customer)', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      h.advance(2 * MINUTE);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.getCustomerByPhone.mockImplementationOnce(async () => {
        await gate;
        return structuredClone(notFound);
      });
      const running = h.service.prepare(SENDER);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(2);
      h.setLookup(found([]));
      const checkout = h.service.afterCheckout(SENDER);
      const capture = h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      release();
      await Promise.all([running, checkout, capture]);
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(3);
      // Luna uploaded by the forced prepare, Michi by the capture after it.
      expect(h.client.createPet.mock.calls.map((c) => c[1].name)).toEqual([
        'Luna',
        'Michi',
      ]);
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a failing capture does not block the next one', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      jest
        .spyOn(h.localStore, 'write')
        .mockRejectedValueOnce(new Error('db down'));
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      expect((await h.local()).map((pet) => pet.name)).toEqual(['Michi']);
    });
  });

  describe('B6: no local duplicate of a backend pet (verify N4)', () => {
    const twoBrunos = () => [
      backend(),
      backend({
        id: uuid(60),
        breed: null,
        ageMonths: 30,
        ageLabel: '~2 años',
      }),
    ];

    it('two ACTIVE backend pets with the local pet’s name and species → no create, no patch, the local entry is kept blocked as ambiguous (C2), no extra prompt line', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno es un pug');
      h.setLookup(found(twoBrunos()));
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toMatchObject([
        { name: 'Bruno', blocked: 'ambiguous' },
      ]);
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida: "Bruno"/g),
      ).toHaveLength(2);
    });

    it('a blocked entry never adds a second prompt line for the backend pet with its name and species', async () => {
      const h = harness(found([]));
      h.client.createPet.mockResolvedValue({
        kind: 'IDEMPOTENCY_KEY_CONFLICT',
      });
      await h.say('mi perro Max es un husky');
      expect((await h.local())[0].upload?.blocked).toBe(true);
      h.setLookup(
        found([backend({ id: uuid(70), name: 'Max', breed: 'husky' })]),
      );
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida: "Max"/g),
      ).toHaveLength(1);
    });

    it('facts about a pet held by the backend and by a pending local entry go to the backend pet', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perro Max es un husky');
      h.setLookup(
        found([backend({ id: uuid(70), name: 'Max', breed: 'husky' })]),
      );
      h.advance(30 * MINUTE);
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: backend({ id: uuid(70), name: 'Max', breed: 'husky', version: 4 }),
        warnings: [],
      });
      await h.service.prepare(SENDER);
      h.client.patchPet.mockClear();
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Max tiene 5 años'),
      );
      expect(h.client.patchPet.mock.calls.map((call) => call[1])).toEqual([
        uuid(70),
      ]);
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida: "Max"/g),
      ).toHaveLength(1);
    });
  });
});

describe('CustomerPetsService (T4b-fix-2-C)', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const upstream = (statusCode: number) =>
    Object.assign(new Error('upstream'), { name: 'UpstreamError', statusCode });
  /** Max as staff entered him: staff size and notes, no breed or age. */
  const twinMax = (patch: Partial<BackendPet> = {}) =>
    backend({
      id: uuid(70),
      name: 'Max',
      breed: null,
      size: 'SMALL',
      notes: 'staff',
      birthDate: null,
      birthDatePrecision: null,
      ageMonths: null,
      ageLabel: null,
      ...patch,
    });
  const twoBrunos = () => [
    backend(),
    backend({ id: uuid(60), breed: null, ageMonths: 30, ageLabel: '~2 años' }),
  ];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** The next by-phone lookup waits for `release()`. */
  const gateLookup = (
    h: ReturnType<typeof harness>,
    response: CustomerLookupResponse,
  ) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.getCustomerByPhone.mockImplementationOnce(async () => {
      await gate;
      return structuredClone(response);
    });
    return () => release();
  };

  describe('C1: a pending entry hidden by one ACTIVE backend twin PATCHes it (review R3)', () => {
    it('no create retry: its facts PATCH the twin (staff size and notes kept) and the entry is removed', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perro Max es un husky de 3 años');
      expect((await h.local())[0].upload?.attempts).toBe(1);
      h.setLookup(found([twinMax()]));
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: twinMax({ breed: 'husky', version: 4 }),
        warnings: [],
      });
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      expect(h.client.patchPet.mock.calls).toEqual([
        [
          CUSTOMER_ID,
          uuid(70),
          { version: 3, breed: 'husky', approxAge: { years: 3 } },
        ],
      ]);
      await expect(h.local()).resolves.toEqual([]);
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida: "Max"/g),
      ).toHaveLength(1);
    });

    it('nothing to change on the twin → no PATCH, no create, the entry is removed', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perro Max es un husky');
      h.setLookup(found([twinMax({ breed: 'Husky' })]));
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });
  });

  describe('C2: two or more ACTIVE twins block the entry as ambiguous (verify B6)', () => {
    it('a pending entry (create already attempted) with two twins is blocked instead of retrying its create', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perrito Bruno es un pug');
      h.setLookup(found(twoBrunos()));
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toMatchObject([
        { name: 'Bruno', blocked: 'ambiguous' },
      ]);
    });

    it('the blocked entry stays for T4c: never created, patched or shown, even when one twin remains', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno es un pug');
      h.setLookup(found(twoBrunos()));
      await h.service.afterCheckout(SENDER);
      h.setLookup(found([backend()]));
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toMatchObject([
        { name: 'Bruno', breed: 'pug', blocked: 'ambiguous' },
      ]);
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida:/g),
      ).toHaveLength(1);
      expect(h.service.promptLines(SENDER)).not.toContain('pug');
    });
  });

  describe('C3: each per-sender queue task is time-bounded (review R4)', () => {
    const BOUND_MS = 25_000;
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a stalled prepare releases the queue after the bound: the queued capture then runs', async () => {
      const h = harness(notFound);
      h.getCustomerByPhone.mockImplementationOnce(
        () => new Promise<CustomerLookupResponse>(() => undefined),
      );
      let prepared = false;
      let captured = false;
      void h.service.prepare(SENDER).then(() => {
        prepared = true;
      });
      void h.service
        .capture(SENDER, extractPetFacts('mi perrita Luna es labrador'))
        .then(() => {
          captured = true;
        });
      await jest.advanceTimersByTimeAsync(BOUND_MS - 1);
      expect(prepared).toBe(false);
      expect(captured).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(prepared).toBe(true);
      expect(captured).toBe(true);
      expect((await h.local()).map((pet) => pet.name)).toEqual(['Luna']);
      expect(JSON.stringify(warn.mock.calls)).toContain('25000 ms');
    });

    it('a stale in-flight load is not joined: a later prepare reads again', async () => {
      const h = harness(notFound);
      h.getCustomerByPhone.mockImplementationOnce(
        () => new Promise<CustomerLookupResponse>(() => undefined),
      );
      void h.service.prepare(SENDER);
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      let done = false;
      void h.service.prepare(SENDER).then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(2);
    });

    it('a task that finishes in time leaves no timer behind', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('C4: no write after «olvida mis datos» (review R1)', () => {
    it('forget during the lookup of an upload → no create and no local write', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es una labrador');
      h.advance(2 * MINUTE);
      const release = gateLookup(h, found([]));
      const write = jest.spyOn(h.localStore, 'write');
      const running = h.service.afterCheckout(SENDER);
      await tick();
      await h.profiles.forget(SENDER);
      release();
      await running;
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    });

    it('forget during a capture → the local list is not written (the deleted row is not recreated)', async () => {
      const h = harness(notFound);
      const release = gateLookup(h, notFound);
      const write = jest.spyOn(h.localStore, 'write');
      const running = h.service.capture(
        SENDER,
        extractPetFacts('mi perro Max es un husky'),
      );
      await tick();
      await h.profiles.forget(SENDER);
      release();
      await running;
      expect(write).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });

    it('forget during a capture about a backend pet → no PATCH', async () => {
      const h = harness(found([backend()]));
      const release = gateLookup(h, found([backend()]));
      const running = h.service.capture(
        SENDER,
        extractPetFacts('mi perrito Bruno ya tiene 2 años'),
      );
      await tick();
      await h.profiles.forget(SENDER);
      release();
      await running;
      expect(h.client.patchPet).not.toHaveBeenCalled();
    });
  });

  describe('C5: local species compare like backend species', () => {
    it('a local cat is not hidden by an OTHER-species backend pet with its name', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi gato Michi es persa');
      h.setLookup(
        found([
          backend({
            id: uuid(71),
            name: 'Michi',
            species: 'OTHER',
            speciesOther: 'hurón',
            breed: null,
          }),
        ]),
      );
      h.advance(2 * MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.patchPet).not.toHaveBeenCalled();
      expect(
        h.service.promptLines(SENDER)?.match(/Mascota conocida: "Michi"/g),
      ).toHaveLength(2);
    });
  });

  describe('C6: failed PATCH merges back off like creates (verify)', () => {
    it('a failed merge persists attempt 1 and its next time; no retry before it; a due retry that succeeds removes the entry', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet.mockRejectedValueOnce(upstream(500));
      await h.service.afterCheckout(SENDER);
      expect((await h.local())[0].merge).toEqual({
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + MINUTE).toISOString(),
      });
      expect(JSON.stringify(warn.mock.calls)).toMatch(/merge.*500.*attempt 1/);
      await h.service.afterCheckout(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      h.advance(MINUTE);
      h.client.patchPet.mockResolvedValueOnce({
        kind: 'ok',
        pet: backend({ version: 4 }),
        warnings: [],
      });
      await h.service.afterCheckout(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(2);
      expect(h.client.createPet).not.toHaveBeenCalled();
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a non-ok PATCH answer backs off too, with its status', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet.mockResolvedValue({ kind: 'PET_ARCHIVED' });
      await h.service.afterCheckout(SENDER);
      expect((await h.local())[0].merge?.attempts).toBe(1);
      expect(JSON.stringify(warn.mock.calls)).toMatch(
        /merge.*PET_ARCHIVED.*attempt 1/,
      );
    });

    it('a failed twin PATCH of a pending entry advances the entry’s create counter (one backoff per entry)', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(upstream(500));
      await h.say('mi perro Max es un husky');
      h.setLookup(found([twinMax()]));
      h.client.patchPet.mockRejectedValue(upstream(503));
      h.advance(MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      expect((await h.local())[0].upload).toMatchObject({
        attempts: 2,
        nextAttemptAt: new Date(NOW.getTime() + 3 * MINUTE).toISOString(),
      });
      h.advance(MINUTE);
      await h.service.prepare(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      expect(h.client.createPet).toHaveBeenCalledTimes(1);
    });
  });

  describe('C7: read-only scopes record the first pet (baseline)', () => {
    it.each([
      ['lookup unavailable', new Error('down')],
      ['`pets` absent', found(undefined)],
    ] as const)(
      '%s, no legacy pet → the facts become the legacy pet through the profile',
      async (_label, lookup) => {
        const h = harness(lookup);
        await h.service.prepare(SENDER);
        await h.service.capture(
          SENDER,
          extractPetFacts('mi perrita Luna es labrador'),
          undefined,
        );
        expect(h.profiles.cached(SENDER)?.pet).toMatchObject({
          name: 'Luna',
          breed: 'labrador',
        });
        expect(h.client.createPet).not.toHaveBeenCalled();
        expect(h.client.patchPet).not.toHaveBeenCalled();
        await expect(h.local()).resolves.toEqual([]);
      },
    );
  });
});

describe('CustomerPetsService (T4b-fix-3)', () => {
  const BOUND_MS = 25_000;
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const names = async (h: ReturnType<typeof harness>) =>
    (await h.local()).map((pet) => pet.name);
  /** The next by-phone lookup waits for `release()`. */
  const gateLookup = (
    h: ReturnType<typeof harness>,
    response: CustomerLookupResponse,
  ) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.getCustomerByPhone.mockImplementationOnce(async () => {
      await gate;
      return structuredClone(response);
    });
    return () => release();
  };
  /** The next local write waits for `release()` (then lands). */
  const gateWrite = (h: ReturnType<typeof harness>) => {
    const original = h.localStore.write.bind(h.localStore);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = jest
      .spyOn(h.localStore, 'write')
      .mockImplementationOnce(async (...args) => {
        await gate;
        return original(...args);
      });
    return { release: () => release(), write };
  };

  describe('E1: a timed-out queue task is fenced (verify C3/S8)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('verify reproduction: stalled lookup, capture saves Luna, stalled lookup resolves, next capture saves Michi → both kept', async () => {
      const h = harness(notFound);
      const release = gateLookup(h, notFound);
      void h.service.prepare(SENDER);
      const luna = h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      await luna;
      expect(await names(h)).toEqual(['Luna']);
      release();
      await jest.advanceTimersByTimeAsync(0);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      expect(await names(h)).toEqual(['Luna', 'Michi']);
      const prompt = h.service.promptLines(SENDER) ?? '';
      expect(prompt).toContain('"Luna"');
      expect(prompt).toContain('"Michi"');
    });

    it('two tasks concurrent after a timeout cannot each write a list from the same old snapshot', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      const { release, write } = gateWrite(h);
      void h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      const michi = h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      await jest.advanceTimersByTimeAsync(0);
      // Michi's write waits for Luna's in-flight write…
      expect(write).toHaveBeenCalledTimes(1);
      release();
      await jest.advanceTimersByTimeAsync(0);
      await michi;
      // …and is computed from the list that write left.
      expect(
        write.mock.calls.map((call) => call[1].map((p) => p.name)),
      ).toEqual([['Luna'], ['Luna', 'Michi']]);
      expect(await names(h)).toEqual(['Luna', 'Michi']);
    });

    it('a capture that resumes after its bound writes nothing (no older or overwriting list)', async () => {
      const h = harness(notFound);
      const release = gateLookup(h, notFound);
      const write = jest.spyOn(h.localStore, 'write');
      void h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      release();
      await jest.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledTimes(1);
      expect(await names(h)).toEqual(['Michi']);
    });

    it('a fenced upload removes nothing; the next prepare replays the create and removes the entry', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      h.setLookup(found([]));
      let releaseCreate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      h.client.createPet.mockImplementationOnce(async (_c, body) => {
        await gate;
        return {
          kind: 'ok',
          created: true,
          pet: createdFrom(body, uuid(950)),
          warnings: [],
        };
      });
      void h.service.afterCheckout(SENDER);
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      releaseCreate();
      await jest.advanceTimersByTimeAsync(0);
      expect(await names(h)).toEqual(['Luna']);
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).toHaveBeenCalledTimes(2);
      expect(h.client.createPet.mock.calls[1][2]).toBe(
        h.client.createPet.mock.calls[0][2],
      );
      await expect(h.local()).resolves.toEqual([]);
    });
  });

  describe('E2: a forgotten PATCH merge is not a failed attempt', () => {
    it('forget during the version-conflict reread → no second PATCH, no retry log, no backoff write', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet.mockResolvedValueOnce({
        kind: 'PET_VERSION_CONFLICT',
        currentVersion: 4,
      });
      h.client.listPets.mockImplementationOnce(async () => {
        await h.profiles.forget(SENDER);
        return { kind: 'ok', pets: [backend({ version: 4 })] };
      });
      const write = jest.spyOn(h.localStore, 'write');
      await h.service.afterCheckout(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /not done: forgotten/,
      );
      expect(write).not.toHaveBeenCalled();
    });
  });

  describe('E3: a twin renamed before the conflict reread is not patched', () => {
    it('reread twin no longer matches (name) → no PATCH to it, the entry stays pending without an attempt', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet
        .mockResolvedValueOnce({
          kind: 'PET_VERSION_CONFLICT',
          currentVersion: 4,
        })
        .mockResolvedValueOnce({
          kind: 'ok',
          pet: backend({ name: 'Rocky', version: 5 }),
          warnings: [],
        });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend({ name: 'Rocky', version: 4 })],
      });
      await h.service.afterCheckout(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      const [entry] = await h.local();
      expect(entry).toMatchObject({ name: 'Bruno' });
      expect(entry.merge).toBeUndefined();
      expect(entry.upload).toBeUndefined();
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/merge not done/);
    });

    it('reread twin of another species → no PATCH to it either', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet.mockResolvedValueOnce({
        kind: 'PET_VERSION_CONFLICT',
        currentVersion: 4,
      });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend({ species: 'CAT', version: 4 })],
      });
      await h.service.afterCheckout(SENDER);
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
      expect(await names(h)).toEqual(['Bruno']);
    });

    it('reread twin still matching → the retry PATCH still happens (baseline)', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      h.client.patchPet
        .mockResolvedValueOnce({
          kind: 'PET_VERSION_CONFLICT',
          currentVersion: 4,
        })
        .mockResolvedValueOnce({
          kind: 'ok',
          pet: backend({ version: 5, ageMonths: 24 }),
          warnings: [],
        });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend({ name: 'BRUNO ', version: 4 })],
      });
      await h.service.afterCheckout(SENDER);
      expect(h.client.patchPet.mock.calls.map((c) => c[2].version)).toEqual([
        3, 4,
      ]);
      await expect(h.local()).resolves.toEqual([]);
    });
  });
});
