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
import type { LocalPet } from '../domain/customer-pets';
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

/** A deferred the test settles by hand (or never). */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

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

    it('a failing capture does not block the next one (F1b: the next turn rereads the list first)', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      jest
        .spyOn(h.localStore, 'write')
        .mockRejectedValueOnce(new Error('db down'));
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      // F1b: the failed write may have landed, so the list is unknown and
      // this capture is refused instead of writing from a stale list.
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      await expect(h.local()).resolves.toEqual([]);
      // The queue is not blocked: the next turn rereads and stores.
      await h.say('mi gato Michi es persa');
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
      // F1 bounds each write at 10 s: the write starts at 20 s so it is
      // still in flight when its task passes the 25 s bound.
      const h = harness(notFound);
      // Lookup answers at 20 s, then Luna's write hangs past the task bound.
      const lookup = deferred<CustomerLookupResponse>();
      h.getCustomerByPhone.mockImplementationOnce(() => lookup.promise);
      const original = h.localStore.write.bind(h.localStore);
      const gate = deferred<void>();
      const write = jest
        .spyOn(h.localStore, 'write')
        .mockImplementationOnce(async (...args) => {
          await gate.promise;
          return original(...args);
        });
      void h.service.capture(
        SENDER,
        extractPetFacts('mi perrita Luna es labrador'),
      );
      await jest.advanceTimersByTimeAsync(20_000);
      lookup.resolve(structuredClone(notFound));
      await jest.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(BOUND_MS - 20_000);
      const michi = h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(write).toHaveBeenCalledTimes(1);
      gate.resolve();
      await jest.advanceTimersByTimeAsync(0);
      await michi;
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

describe('CustomerPetsService (T4b-fix-4)', () => {
  const IO_MS = 10_000;
  const BOUND_MS = 25_000;
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const names = async (h: ReturnType<typeof harness>) =>
    (await h.local()).map((pet) => pet.name);
  const upstream = (statusCode: number) =>
    Object.assign(new Error('upstream'), { name: 'UpstreamError', statusCode });

  describe('F1: every local store call is time-bounded (review: chain stall)', () => {
    it('a local read that never settles: the chain moves on, later turns store once the store recovers, the late (stale) answer restores nothing', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      expect(await names(h)).toEqual(['Luna']);
      h.advance(MINUTE);
      const stalled = deferred<LocalPet[]>();
      const read = jest
        .spyOn(h.localStore, 'read')
        .mockImplementationOnce(() => stalled.promise);
      const write = jest.spyOn(h.localStore, 'write');
      const turn = h.say('mi gato Michi es persa');
      await jest.advanceTimersByTimeAsync(IO_MS);
      await turn;
      // Unknown list: nothing written from the old cached list.
      expect(write).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).toContain('local read');
      // The store recovers: the next turn reads again and stores Michi.
      await h.say('mi gato Michi es persa');
      expect(read).toHaveBeenCalledTimes(2);
      expect(await names(h)).toEqual(['Luna', 'Michi']);
      // The stalled read answers late with an older list: ignored.
      stalled.resolve([]);
      await jest.advanceTimersByTimeAsync(0);
      await h.say('mi perro Toby es un husky');
      expect(await names(h)).toEqual(['Luna', 'Michi', 'Toby']);
      const prompt = h.service.promptLines(SENDER) ?? '';
      expect(prompt).toContain('"Luna"');
      expect(prompt).toContain('"Michi"');
      expect(prompt).toContain('"Toby"');
    });

    it('a local write that never settles: the chain moves on, the list is unknown until reread, the next turn writes from the stored list', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      const stalled = deferred<void>();
      const original = h.localStore.write.bind(h.localStore);
      const write = jest
        .spyOn(h.localStore, 'write')
        .mockImplementationOnce(() => stalled.promise);
      const read = jest.spyOn(h.localStore, 'read');
      const turn = h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      await jest.advanceTimersByTimeAsync(IO_MS);
      await turn;
      expect(JSON.stringify(warn.mock.calls)).toContain('local write');
      // No write from the unknown list in the meantime.
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Toby es un husky'),
      );
      expect(write).toHaveBeenCalledTimes(1);
      // The next turn rereads (not fresh any more) and writes from it.
      write.mockImplementation(original);
      await h.say('mi perro Toby es un husky');
      expect(read).toHaveBeenCalledTimes(1);
      expect(await names(h)).toEqual(['Luna', 'Toby']);
      // The timed-out write is cancelled by the store (never lands); its
      // late failure changes nothing.
      stalled.reject(new Error('canceling statement due to statement timeout'));
      await jest.advanceTimersByTimeAsync(0);
      await h.say('mi gato Michi es persa');
      expect(await names(h)).toEqual(['Luna', 'Toby', 'Michi']);
    });
  });

  describe('F1b: a rejected local write has an unknown outcome (verify: COMMIT racing the store deadline)', () => {
    it('a write that lands but is reported failed (store timeout at COMMIT): the list is unknown until reread, the next write never erases the landed pet', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      const original = h.localStore.write.bind(h.localStore);
      const write = jest
        .spyOn(h.localStore, 'write')
        .mockImplementationOnce(async (sender, pets, at) => {
          await original(sender, pets, at);
          throw Object.assign(new Error('local pet store deadline'), {
            name: 'LocalPetStoreTimeoutError',
          });
        });
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      // Unknown outcome: no write from the pre-write cached list.
      await h.service.capture(
        SENDER,
        extractPetFacts('mi perro Toby es un husky'),
      );
      expect(write).toHaveBeenCalledTimes(1);
      // The next turn rereads what the store holds and writes from it.
      await h.say('mi perro Toby es un husky');
      expect(await names(h)).toEqual(['Luna', 'Michi', 'Toby']);
    });
  });

  describe('F2: a create/merge failure after the 25 s bound still backs off', () => {
    const stalledCreate = (h: ReturnType<typeof harness>) => {
      const create = deferred<CreatePetResult>();
      h.client.createPet.mockImplementationOnce(() => create.promise);
      return create;
    };
    const retryLogged = (attempt: number) =>
      new RegExp(
        `pet create not done: 500 \\(attempt ${attempt}, next in`,
      ).test(JSON.stringify(warn.mock.calls));

    it('persists attempts/nextAttemptAt on the current list (newer changes kept) and logs the retry', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      h.setLookup(found([]));
      const create = stalledCreate(h);
      void h.service.afterCheckout(SENDER);
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      // A newer task while the first create is still out: Luna's retry is
      // IN_FLIGHT (attempt 1 persisted) and Michi is created and removed.
      h.client.createPet.mockResolvedValueOnce({
        kind: 'IDEMPOTENCY_KEY_IN_FLIGHT',
      });
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es persa'),
      );
      expect(await names(h)).toEqual(['Luna']);
      expect((await h.local())[0].upload?.attempts).toBe(1);
      create.reject(upstream(500));
      await jest.advanceTimersByTimeAsync(0);
      // Applied to the current list: Michi stays uploaded, attempt 1 counted.
      const [luna, ...rest] = await h.local();
      expect(rest).toEqual([]);
      expect(luna.upload).toMatchObject({
        attempts: 2,
        nextAttemptAt: new Date(NOW.getTime() + 2 * MINUTE).toISOString(),
      });
      expect(retryLogged(2)).toBe(true);
      // No retry before the persisted time.
      h.advance(2 * MINUTE - 1);
      await h.service.prepare(SENDER, true);
      expect(
        h.client.createPet.mock.calls.filter((c) => c[1].name === 'Luna'),
      ).toHaveLength(2);
    });

    it('a late failure with nothing newer persists attempt 1', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      h.setLookup(found([]));
      const create = stalledCreate(h);
      void h.service.afterCheckout(SENDER);
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      expect(retryLogged(1)).toBe(false);
      create.reject(upstream(500));
      await jest.advanceTimersByTimeAsync(0);
      expect((await h.local())[0].upload).toMatchObject({
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + MINUTE).toISOString(),
      });
      expect(retryLogged(1)).toBe(true);
    });

    it('a merge (twin PATCH) failing after the bound persists its backoff too', async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno tiene 2 años');
      h.setLookup(found([backend()]));
      const patch = deferred<PatchPetResult>();
      h.client.patchPet.mockImplementationOnce(() => patch.promise);
      void h.service.afterCheckout(SENDER);
      await jest.advanceTimersByTimeAsync(BOUND_MS);
      patch.reject(upstream(500));
      await jest.advanceTimersByTimeAsync(0);
      const [bruno] = await h.local();
      expect(bruno.merge).toMatchObject({
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + MINUTE).toISOString(),
      });
      expect(JSON.stringify(warn.mock.calls)).toMatch(
        /pet merge not done: 500 \(attempt 1, next in/,
      );
    });

    it('no retry log when the backoff could not be persisted (local write failed)', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      h.setLookup(found([]));
      h.client.createPet.mockRejectedValueOnce(upstream(500));
      const original = h.localStore.write.bind(h.localStore);
      // The frozen-body write lands; the backoff write fails.
      jest
        .spyOn(h.localStore, 'write')
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error('pool exhausted'));
      await h.service.afterCheckout(SENDER);
      expect((await h.local())[0].upload?.attempts).toBeUndefined();
      expect(retryLogged(1)).toBe(false);
      expect(JSON.stringify(warn.mock.calls)).toContain(
        'pet create not done: 500 (backoff not saved',
      );
    });
  });
});

describe('CustomerPetsService (T4c-1)', () => {
  let warn: jest.SpiedFunction<Logger['warn']>;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const max = (patch: Partial<BackendPet> = {}) =>
    backend({
      id: uuid(50),
      name: 'Max',
      breed: 'Labrador',
      size: 'LARGE',
      ageMonths: 40,
      ageLabel: '~3 años',
      ...patch,
    });
  const patched = (h: ReturnType<typeof harness>, pet: BackendPet) =>
    h.client.patchPet.mockResolvedValue({ kind: 'ok', pet, warnings: [] });

  describe('G1: allergies stated by the customer (S5)', () => {
    it('a backend pet without allergies gets the customer’s allergy by PATCH (only that member)', async () => {
      const h = harness(found([backend(), max()]));
      patched(h, max({ allergies: 'pollo', version: 4 }));
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, { name: 'Max', allergies: 'pollo' });
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, uuid(50), { version: 3, allergies: 'pollo' }],
      ]);
      expect(h.service.promptLines(SENDER)).toContain('alergias "pollo"');
    });

    it('a staff-entered allergy is never replaced: the customer’s one is appended once', async () => {
      const h = harness(found([max({ allergies: 'Res' })]));
      patched(h, max({ allergies: 'Res; pollo', version: 4 }));
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, { name: 'Max', allergies: 'pollo' });
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, uuid(50), { version: 3, allergies: 'Res; pollo' }],
      ]);
      // Stated again (other case, accents): deduplicated, no PATCH.
      await h.service.capture(SENDER, { name: 'max', allergies: 'Pollo' });
      expect(h.client.patchPet).toHaveBeenCalledTimes(1);
    });

    it('an allergy already inside the staff text is not appended', async () => {
      const h = harness(found([max({ allergies: 'Pollo y res' })]));
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, { name: 'Max', allergies: 'pollo' });
      expect(h.client.patchPet).not.toHaveBeenCalled();
    });

    it.each([
      ['fresas', 'res', 'fresas; res'],
      ['No es alérgico a pollo', 'pollo', 'No es alérgico a pollo; pollo'],
      ['Sin pollo, res', 'pollo', 'Sin pollo, res; pollo'],
    ])(
      'H3: stored %j + stated %j is not a duplicate (whole words; a «no»/«sin» segment never counts) → PATCH %j',
      async (stored, stated, sent) => {
        const h = harness(found([max({ allergies: stored })]));
        patched(h, max({ allergies: sent, version: 4 }));
        await h.service.prepare(SENDER);
        await h.service.capture(SENDER, { name: 'Max', allergies: stated });
        expect(h.client.patchPet.mock.calls).toEqual([
          [CUSTOMER_ID, uuid(50), { version: 3, allergies: sent }],
        ]);
      },
    );

    it.each([
      ['Pollo', 'pollo'],
      ['Res; Pollo de granja', 'pollo de granja'],
      ['lácteos.\ntrigo', 'Trigo'],
    ])(
      'H3: stored %j already says %j (whole words, accents and case ignored) → no PATCH',
      async (stored, stated) => {
        const h = harness(found([max({ allergies: stored })]));
        await h.service.prepare(SENDER);
        await h.service.capture(SENDER, { name: 'Max', allergies: stated });
        expect(h.client.patchPet).not.toHaveBeenCalled();
      },
    );

    it('an append past the 500-character limit is not sent (staff value kept) and is logged', async () => {
      const h = harness(found([max({ allergies: 'x'.repeat(495) })]));
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, { name: 'Max', allergies: 'pollo' });
      expect(h.client.patchPet).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).toContain(
        'pet allergies not stored: over 500 characters',
      );
    });

    it('a prospect’s pet keeps its allergies locally (appended, deduplicated) and shows them with the S5 warning', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, {
        name: 'Luna',
        species: 'perro',
        allergies: 'pollo',
      });
      await h.service.capture(SENDER, { name: 'Luna', allergies: 'res' });
      await h.service.capture(SENDER, { name: 'Luna', allergies: 'Pollo' });
      await expect(h.local()).resolves.toMatchObject([
        { name: 'Luna', species: 'perro', allergies: 'pollo; res' },
      ]);
      const text = h.service.promptLines(SENDER) ?? '';
      expect(text).toContain('alergias "pollo; res"');
      expect(text).toMatch(/nunca afirme que un producto es seguro/i);
    });

    it('the upload of a local pet carries its allergies in the create body', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, {
        name: 'Luna',
        species: 'perro',
        allergies: 'pollo',
      });
      h.setLookup(found([]));
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet.mock.calls).toEqual([
        [
          CUSTOMER_ID,
          { name: 'Luna', species: 'DOG', allergies: 'pollo' },
          `pet-local:${CUSTOMER_ID}:${uuid(1)}`,
        ],
      ]);
    });

    it('a local twin merge appends its allergy to the staff one', async () => {
      const h = harness(notFound);
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, {
        name: 'Max',
        species: 'perro',
        allergies: 'pollo',
      });
      h.setLookup(found([max({ allergies: 'Res', breed: null })]));
      patched(h, max({ allergies: 'Res; pollo', version: 4 }));
      await h.service.afterCheckout(SENDER);
      expect(h.client.createPet).not.toHaveBeenCalled();
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, uuid(50), { version: 3, allergies: 'Res; pollo' }],
      ]);
      await expect(h.local()).resolves.toEqual([]);
    });

    it('facts without allergies never send an allergies member (previous behaviour)', async () => {
      const h = harness(found([max({ breed: null })]));
      patched(h, max({ version: 4 }));
      await h.service.prepare(SENDER);
      await h.service.capture(SENDER, { name: 'Max', breed: 'labrador' });
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, uuid(50), { version: 3, breed: 'labrador' }],
      ]);
    });

    describe('captureAllergy (deterministic «<Nombre> es alérgico a X»)', () => {
      it('goes to the known pet with that name', async () => {
        const h = harness(found([backend(), max()]));
        patched(h, max({ allergies: 'pollo', version: 4 }));
        await h.service.prepare(SENDER);
        await h.service.captureAllergy(SENDER, {
          name: 'max',
          allergies: 'pollo',
        });
        expect(h.client.patchPet.mock.calls).toEqual([
          [CUSTOMER_ID, uuid(50), { version: 3, allergies: 'pollo' }],
        ]);
      });

      it('an unknown name never starts a new pet (no local entry, no create)', async () => {
        const h = harness(found([backend()]));
        await h.service.prepare(SENDER);
        await h.service.captureAllergy(SENDER, {
          name: 'Toby',
          allergies: 'pollo',
        });
        expect(h.client.createPet).not.toHaveBeenCalled();
        expect(h.client.patchPet).not.toHaveBeenCalled();
        await expect(h.local()).resolves.toEqual([]);
      });

      it('a nameless pet is not completed by an allergy statement', async () => {
        const h = harness(notFound);
        await h.service.prepare(SENDER);
        await h.service.capture(SENDER, { species: 'perro', breed: 'pug' });
        await h.service.captureAllergy(SENDER, {
          name: 'Toby',
          allergies: 'pollo',
        });
        const [entry] = await h.local();
        expect(entry.name).toBeUndefined();
        expect(entry.allergies).toBeUndefined();
      });

      it('a known local pet gets it appended', async () => {
        const h = harness(notFound);
        await h.service.prepare(SENDER);
        await h.service.capture(SENDER, { name: 'Luna', species: 'perro' });
        await h.service.captureAllergy(SENDER, {
          name: 'Luna',
          allergies: 'pollo',
        });
        await expect(h.local()).resolves.toMatchObject([
          { name: 'Luna', allergies: 'pollo' },
        ]);
      });

      it('after «olvida mis datos» nothing is written', async () => {
        const h = harness(found([max()]));
        await h.service.prepare(SENDER);
        await h.profiles.forget(SENDER);
        await h.service.captureAllergy(SENDER, {
          name: 'Max',
          allergies: 'pollo',
        });
        expect(h.client.patchPet).not.toHaveBeenCalled();
      });
    });
  });

  describe('G2: forget one pet with tact (S7)', () => {
    const archived = (pet: BackendPet, reason: string | null = null) => ({
      kind: 'ok' as const,
      pet: {
        ...pet,
        status: 'ARCHIVED' as const,
        archivedAt: NOW.toISOString(),
        archivedReason: reason,
        version: pet.version + 1,
      },
      warnings: [],
    });

    it('one matching backend pet → archived with the reason; it leaves the prompt', async () => {
      const h = harness(found([backend(), max()]));
      h.client.archivePet.mockResolvedValue(archived(backend(), 'falleció'));
      await h.service.prepare(SENDER);
      await expect(
        h.service.forgetPet(SENDER, 'bruno', 'falleció'),
      ).resolves.toBe('archived');
      expect(h.client.archivePet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, { version: 3, reason: 'falleció' }],
      ]);
      const text = h.service.promptLines(SENDER) ?? '';
      expect(text).not.toContain('"Bruno"');
      expect(text).toContain('"Max"');
    });

    it('without a reason the archive body carries only the version', async () => {
      const h = harness(found([backend()]));
      h.client.archivePet.mockResolvedValue(archived(backend()));
      await h.service.prepare(SENDER);
      await h.service.forgetPet(SENDER, 'Bruno');
      expect(h.client.archivePet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, { version: 3 }],
      ]);
    });

    it('a legacy twin of the archived backend pet is cleared too: it never resurfaces in the prompt or knownPets (review R3)', async () => {
      const h = harness(found([backend(), max()]));
      await h.profiles.record(SENDER, {
        pet: { name: 'Bruno', species: 'perro' },
      });
      h.client.archivePet.mockResolvedValue(archived(backend(), 'falleció'));
      await h.service.prepare(SENDER);
      await expect(
        h.service.forgetPet(SENDER, 'Bruno', 'falleció'),
      ).resolves.toBe('archived');
      expect(h.profiles.cached(SENDER)?.pet).toBeUndefined();
      const legacy = h.profiles.cached(SENDER)?.pet;
      expect(h.service.promptLines(SENDER, legacy) ?? '').not.toContain(
        'Bruno',
      );
      expect(h.service.knownPets(SENDER).map((pet) => pet.name)).toEqual([
        'Max',
      ]);
    });

    it('a legacy pet of another species with the same name is not cleared when the backend pet is archived', async () => {
      const h = harness(found([backend(), max()]));
      await h.profiles.record(SENDER, {
        pet: { name: 'Bruno', species: 'gato' },
      });
      h.client.archivePet.mockResolvedValue(archived(backend()));
      await h.service.prepare(SENDER);
      await h.service.forgetPet(SENDER, 'Bruno');
      expect(h.profiles.cached(SENDER)?.pet).toEqual({
        name: 'Bruno',
        species: 'gato',
      });
    });

    it('PET_VERSION_CONFLICT → rereads (ALL) and archives with the current version', async () => {
      const h = harness(found([backend()]));
      h.client.archivePet
        .mockResolvedValueOnce({
          kind: 'PET_VERSION_CONFLICT',
          currentVersion: 5,
        })
        .mockResolvedValueOnce(archived(backend({ version: 5 })));
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend({ version: 5, breed: 'Chihuahua' })],
      });
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'archived',
      );
      expect(h.client.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
      expect(
        (h.client.archivePet.mock.calls as unknown[][]).map((c) => c[2]),
      ).toEqual([{ version: 3 }, { version: 5 }]);
    });

    it('a conflict whose reread shows the pet already archived is done (no second archive)', async () => {
      const h = harness(found([backend()]));
      h.client.archivePet.mockResolvedValueOnce({
        kind: 'PET_VERSION_CONFLICT',
        currentVersion: 4,
      });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [archived(backend()).pet],
      });
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'archived',
      );
      expect(h.client.archivePet).toHaveBeenCalledTimes(1);
      expect(h.service.promptLines(SENDER)).toBeNull();
    });

    it('a thrown archive is reported as failed and the pet stays', async () => {
      const h = harness(found([backend()]));
      h.client.archivePet.mockRejectedValue(new TypeError('timeout'));
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'failed',
      );
      expect(h.service.promptLines(SENDER)).toContain('"Bruno"');
    });

    it('a local twin entry of the archived pet is removed (never re-created later)', async () => {
      const h = harness(found([]));
      h.client.createPet.mockRejectedValue(
        Object.assign(new Error('x'), { statusCode: 500 }),
      );
      await h.say('mi perrito Bruno es un pug');
      expect(await h.local()).toHaveLength(1);
      h.setLookup(found([backend()]));
      h.advance(2 * MINUTE);
      // Merge into the twin fails and backs off: the entry is still there.
      h.client.patchPet.mockRejectedValue(new TypeError('down'));
      await h.service.prepare(SENDER, true);
      expect(await h.local()).toHaveLength(1);
      h.client.archivePet.mockResolvedValue(archived(backend()));
      await h.service.forgetPet(SENDER, 'Bruno');
      await expect(h.local()).resolves.toEqual([]);
    });

    it('a local (prospect) pet → removed', async () => {
      const h = harness(notFound);
      await h.say('mi perrita Luna es labrador');
      await h.say('mi gato Michi es siamés');
      await expect(
        h.service.forgetPet(SENDER, 'Luna', 'se perdió'),
      ).resolves.toBe('removed');
      await expect(h.local()).resolves.toMatchObject([{ name: 'Michi' }]);
      expect(h.service.promptLines(SENDER)).not.toContain('Luna');
      expect(h.client.archivePet).not.toHaveBeenCalled();
    });

    it('the legacy single pet → cleared (other profile fields kept)', async () => {
      const h = harness(notFound);
      await h.profiles.record(SENDER, {
        preferredName: 'Ana',
        pet: { name: 'Luna', species: 'perro', breed: 'labrador' },
      });
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Luna')).resolves.toBe(
        'cleared',
      );
      const stored = await h.profileStore.read(SENDER);
      expect(stored?.pet).toBeUndefined();
      expect(stored?.preferredName).toBe('Ana');
      expect(h.profiles.cached(SENDER)?.pet).toBeUndefined();
      expect(
        h.service.promptLines(SENDER, h.profiles.cached(SENDER)?.pet),
      ).toBeNull();
    });

    it('no pet with that name → none, nothing written', async () => {
      const h = harness(found([backend()]));
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Toby')).resolves.toBe('none');
      expect(h.client.archivePet).not.toHaveBeenCalled();
    });

    it('two pets with that name → ambiguous, nothing written', async () => {
      const h = harness(
        found([backend(), backend({ id: uuid(60), species: 'CAT' })]),
      );
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'ambiguous',
      );
      expect(h.client.archivePet).not.toHaveBeenCalled();
    });

    it('read-only scopes (no pets:read, lookup down) → unavailable, nothing written', async () => {
      const h = harness(found(undefined));
      await h.service.prepare(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'unavailable',
      );
      const down = harness(new Error('down'));
      await down.service.prepare(SENDER);
      await expect(down.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'unavailable',
      );
      expect(h.client.archivePet).not.toHaveBeenCalled();
      expect(down.client.archivePet).not.toHaveBeenCalled();
    });

    it('after «olvida mis datos» → unavailable, nothing written', async () => {
      const h = harness(found([backend()]));
      await h.service.prepare(SENDER);
      await h.profiles.forget(SENDER);
      await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
        'unavailable',
      );
      expect(h.client.archivePet).not.toHaveBeenCalled();
    });

    describe('T4c-1-fix H6: a conflict reread that fails is not reported as archived', () => {
      const conflict = {
        kind: 'PET_VERSION_CONFLICT' as const,
        currentVersion: 4,
      };

      it.each<[string, () => Promise<unknown>]>([
        [
          'the list answers FORBIDDEN',
          () => Promise.resolve({ kind: 'FORBIDDEN' }),
        ],
        ['the list throws', () => Promise.reject(new TypeError('down'))],
      ])(
        '%s → failed, logged; the pet, its local twin and its legacy twin stay',
        async (_label, list) => {
          const h = harness(found([]));
          h.client.createPet.mockRejectedValue(
            Object.assign(new Error('x'), { statusCode: 500 }),
          );
          await h.say('mi perrito Bruno es un pug');
          await h.profiles.record(SENDER, {
            pet: { name: 'Bruno', species: 'perro' },
          });
          h.setLookup(found([backend()]));
          h.advance(2 * MINUTE);
          h.client.patchPet.mockRejectedValue(new TypeError('down'));
          await h.service.prepare(SENDER, true);
          h.client.archivePet.mockResolvedValue(conflict);
          h.client.listPets.mockImplementation(list as never);
          await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
            'failed',
          );
          expect(h.client.archivePet).toHaveBeenCalledTimes(1);
          expect(h.client.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
          expect(JSON.stringify(warn.mock.calls)).toContain(
            'pet archive not done: reread failed',
          );
          expect(h.service.promptLines(SENDER)).toContain('"Bruno"');
          expect(h.service.knownPets(SENDER).map((pet) => pet.source)).toEqual([
            'backend',
          ]);
          await expect(h.local()).resolves.toMatchObject([{ name: 'Bruno' }]);
          expect(h.profiles.cached(SENDER)?.pet).toEqual({
            name: 'Bruno',
            species: 'perro',
          });
        },
      );

      it('a reread that lists no such pet (deleted) is still done: archived, dropped from the prompt', async () => {
        const h = harness(found([backend(), max()]));
        h.client.archivePet.mockResolvedValue(conflict);
        h.client.listPets.mockResolvedValue({ kind: 'ok', pets: [max()] });
        await h.service.prepare(SENDER);
        await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
          'archived',
        );
        expect(h.client.archivePet).toHaveBeenCalledTimes(1);
        expect(h.service.knownPets(SENDER).map((pet) => pet.name)).toEqual([
          'Max',
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('reread failed');
      });

      it('the patch path keeps its behaviour: a failed conflict reread drops the pet from the cache and fails the PATCH', async () => {
        const h = harness(found([backend()]));
        h.client.patchPet.mockResolvedValue(conflict);
        h.client.listPets.mockResolvedValue({ kind: 'FORBIDDEN' });
        await h.say('mi perrito Bruno es un pug');
        expect(h.client.patchPet).toHaveBeenCalledTimes(1);
        expect(h.service.promptLines(SENDER)).toBeNull();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('reread failed');
      });
    });

    describe('T4c-1-fix H7: a twin removal that fails after an archive is reported and retried', () => {
      /** A local Bruno twin that stayed pending (failed create, then a
       *  failed merge into the backend Bruno that appeared). */
      const withLocalTwin = async () => {
        const h = harness(found([]));
        h.client.createPet.mockRejectedValueOnce(
          Object.assign(new Error('x'), { statusCode: 500 }),
        );
        await h.say('mi perrito Bruno es un pug');
        h.setLookup(found([backend()]));
        h.advance(2 * MINUTE);
        h.client.patchPet.mockRejectedValue(new TypeError('down'));
        await h.service.prepare(SENDER, true);
        expect(await h.local()).toHaveLength(1);
        h.client.createPet.mockClear();
        h.client.archivePet.mockResolvedValue(archived(backend()));
        return h;
      };

      it('the write fails → logged; the entry is never uploaded and is removed on the next prepare', async () => {
        const h = await withLocalTwin();
        jest
          .spyOn(h.localStore, 'write')
          .mockRejectedValueOnce(new TypeError('store down'));
        await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
          'archived',
        );
        expect(JSON.stringify(warn.mock.calls)).toContain(
          'pet archive: twin entry not removed, kept from upload',
        );
        await expect(h.local()).resolves.toMatchObject([{ name: 'Bruno' }]);
        // The backend pet is archived (not ACTIVE any more); hours later the
        // next prepare would create it again: it removes the entry instead.
        h.setLookup(found([]));
        h.advance(3 * 60 * MINUTE);
        await h.service.prepare(SENDER, true);
        expect(h.client.createPet).not.toHaveBeenCalled();
        expect(h.client.patchPet).toHaveBeenCalledTimes(1);
        await expect(h.local()).resolves.toEqual([]);
        // Removed: a Bruno stated later is a new pet again (uploaded).
        await h.say('mi perrito Bruno es un pug');
        expect(h.client.createPet).toHaveBeenCalledTimes(1);
      });

      it('a removal that fails again in upload keeps the entry from upload until it lands', async () => {
        const h = await withLocalTwin();
        const write = jest
          .spyOn(h.localStore, 'write')
          .mockRejectedValueOnce(new TypeError('store down'));
        await h.service.forgetPet(SENDER, 'Bruno');
        h.setLookup(found([]));
        h.advance(3 * 60 * MINUTE);
        write.mockRejectedValueOnce(new TypeError('store down'));
        await h.service.prepare(SENDER, true);
        expect(h.client.createPet).not.toHaveBeenCalled();
        await expect(h.local()).resolves.toHaveLength(1);
        h.advance(2 * MINUTE);
        await h.service.prepare(SENDER, true);
        expect(h.client.createPet).not.toHaveBeenCalled();
        await expect(h.local()).resolves.toEqual([]);
      });

      it('the write lands (previous behaviour): removed, nothing logged', async () => {
        const h = await withLocalTwin();
        await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
          'archived',
        );
        await expect(h.local()).resolves.toEqual([]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('twin');
      });

      it('no twin entry and no legacy twin: nothing logged', async () => {
        const h = harness(found([backend(), max()]));
        h.client.archivePet.mockResolvedValue(archived(backend()));
        await h.service.prepare(SENDER);
        await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
          'archived',
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('twin');
      });

      it('a legacy twin that cannot be cleared is logged (the archive stays done)', async () => {
        const h = harness(found([backend(), max()]));
        await h.profiles.record(SENDER, {
          pet: { name: 'Bruno', species: 'perro' },
        });
        jest.spyOn(h.profiles, 'clearPet').mockResolvedValue(false);
        h.client.archivePet.mockResolvedValue(archived(backend()));
        await h.service.prepare(SENDER);
        await expect(h.service.forgetPet(SENDER, 'Bruno')).resolves.toBe(
          'archived',
        );
        expect(JSON.stringify(warn.mock.calls)).toContain(
          'pet archive: legacy twin not cleared',
        );
      });
    });
  });

  describe('G3: «olvida mis datos» deletes every backend pet', () => {
    const archivedMax = max({
      status: 'ARCHIVED',
      archivedAt: NOW.toISOString(),
      version: 7,
    });

    it('lists ALL pets and deletes each with its version, even once the profile is forgotten', async () => {
      const h = harness(found([backend()]));
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend(), archivedMax],
      });
      h.client.deletePet.mockResolvedValue({ kind: 'ok' });
      await h.service.prepare(SENDER);
      const erase = h.service.forgetAll(SENDER);
      await h.profiles.forget(SENDER);
      await erase;
      expect(h.client.listPets.mock.calls).toEqual([[CUSTOMER_ID, 'ALL']]);
      expect(h.client.deletePet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, 3],
        [CUSTOMER_ID, uuid(50), 7],
      ]);
      expect(h.service.promptLines(SENDER)).toBeNull();
    });

    it('resolves the Customer when nothing is cached', async () => {
      const h = harness(found([]));
      h.client.listPets.mockResolvedValue({ kind: 'ok', pets: [backend()] });
      h.client.deletePet.mockResolvedValue({ kind: 'ok' });
      await h.service.forgetAll(SENDER);
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(1);
      expect(h.client.deletePet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, 3],
      ]);
    });

    it('404 PET_NOT_FOUND is done; a conflict retries with currentVersion; a thrown delete retries once with the same version (404 then = done)', async () => {
      const h = harness(found([]));
      const third = backend({ id: uuid(61), name: 'Kira', version: 2 });
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend(), max(), third],
      });
      h.client.deletePet
        .mockResolvedValueOnce({ kind: 'PET_NOT_FOUND' })
        .mockResolvedValueOnce({
          kind: 'PET_VERSION_CONFLICT',
          currentVersion: 9,
        })
        .mockResolvedValueOnce({ kind: 'ok' })
        .mockRejectedValueOnce(new TypeError('timeout'))
        .mockResolvedValueOnce({ kind: 'PET_NOT_FOUND' });
      await h.service.forgetAll(SENDER);
      expect(h.client.deletePet.mock.calls).toEqual([
        [CUSTOMER_ID, backend().id, 3],
        [CUSTOMER_ID, uuid(50), 3],
        [CUSTOMER_ID, uuid(50), 9],
        [CUSTOMER_ID, uuid(61), 2],
        [CUSTOMER_ID, uuid(61), 2],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('not deleted');
    });

    it('a missing pets:delete scope stops at the first FORBIDDEN', async () => {
      const h = harness(found([]));
      h.client.listPets.mockResolvedValue({
        kind: 'ok',
        pets: [backend(), max()],
      });
      h.client.deletePet.mockResolvedValue({ kind: 'FORBIDDEN' });
      await h.service.forgetAll(SENDER);
      expect(h.client.deletePet).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).toContain(
        'customer pets erase stopped: FORBIDDEN',
      );
    });

    it('a prospect has no backend pets: nothing listed or deleted', async () => {
      const h = harness(notFound);
      await h.service.forgetAll(SENDER);
      expect(h.client.listPets).not.toHaveBeenCalled();
      expect(h.client.deletePet).not.toHaveBeenCalled();
      // H4: nothing new logged for a prospect.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('erase');
    });

    it('H4: a lookup that fails skips the erase with a distinct warning', async () => {
      const h = harness(new Error('down'));
      await expect(h.service.forgetAll(SENDER)).resolves.toBeUndefined();
      expect(h.getCustomerByPhone).toHaveBeenCalledTimes(1);
      expect(h.client.listPets).not.toHaveBeenCalled();
      expect(h.client.deletePet).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).toContain(
        'customer pets erase skipped: lookup unavailable',
      );
    });

    it('a failing list or lookup never throws', async () => {
      const h = harness(found([]));
      h.client.listPets.mockRejectedValue(new TypeError('down'));
      await expect(h.service.forgetAll(SENDER)).resolves.toBeUndefined();
      const down = harness(new Error('down'));
      await expect(down.service.forgetAll(SENDER)).resolves.toBeUndefined();
      expect(down.client.listPets).not.toHaveBeenCalled();
    });

    it('is bounded by the queue task bound: no new delete once it passed', async () => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      try {
        const h = harness(found([]));
        h.client.listPets.mockResolvedValue({
          kind: 'ok',
          pets: [backend(), max()],
        });
        let release: () => void = () => undefined;
        h.client.deletePet.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ kind: 'ok' });
            }),
        );
        const erase = h.service.forgetAll(SENDER);
        await jest.advanceTimersByTimeAsync(25_000);
        await expect(erase).resolves.toBeUndefined();
        release();
        await jest.advanceTimersByTimeAsync(0);
        expect(h.client.deletePet).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('G4: read accessors and ambiguous resolution for T4c-2', () => {
    it('knownPets: backend, local and the unshadowed legacy pet, in prompt order', async () => {
      const h = harness(found([backend({ allergies: 'Pollo' })]));
      h.client.createPet.mockRejectedValue(
        Object.assign(new Error('x'), { statusCode: 500 }),
      );
      await h.profiles.record(SENDER, {
        pet: { name: 'Luna', species: 'perrita', ageText: '3 años' },
      });
      await h.service.prepare(SENDER);
      await h.service.capture(
        SENDER,
        extractPetFacts('mi gato Michi es siamés'),
      );
      expect(h.service.knownPets(SENDER)).toEqual([
        {
          ref: `backend:${backend().id}`,
          name: 'Bruno',
          species: 'perro',
          breed: 'Chihuahua',
          ageLabel: '~10 meses',
          stage: 'cachorro',
          source: 'backend',
        },
        {
          ref: `local:${uuid(1)}`,
          name: 'Michi',
          species: 'gato',
          breed: 'siamés',
          source: 'local',
        },
        {
          ref: 'legacy',
          name: 'Luna',
          species: 'perro',
          ageLabel: '3 años',
          stage: 'adulto',
          source: 'legacy',
        },
      ]);
    });

    it('knownPets is empty when unknown or forgotten', async () => {
      const h = harness(found([backend()]));
      expect(h.service.knownPets(SENDER)).toEqual([]);
      await h.service.prepare(SENDER);
      await h.profiles.forget(SENDER);
      expect(h.service.knownPets(SENDER)).toEqual([]);
    });

    const twoBrunos = () => [
      backend(),
      backend({
        id: uuid(60),
        breed: null,
        ageMonths: 30,
        ageLabel: '~2 años',
      }),
    ];
    const blockedBruno = async () => {
      const h = harness(notFound);
      await h.say('mi perrito Bruno es un pug');
      h.setLookup(found(twoBrunos()));
      await h.service.afterCheckout(SENDER);
      return h;
    };

    it('ambiguousEntries lists each blocked entry with its candidate backend pets', async () => {
      const h = await blockedBruno();
      expect(h.service.ambiguousEntries(SENDER)).toEqual([
        {
          localId: uuid(1),
          name: 'Bruno',
          species: 'perro',
          candidates: [
            expect.objectContaining({
              ref: `backend:${backend().id}`,
              source: 'backend',
            }),
            expect.objectContaining({
              ref: `backend:${uuid(60)}`,
              ageLabel: '~2 años',
            }),
          ],
        },
      ]);
    });

    it('resolveAmbiguous PATCHes the chosen pet with the entry’s facts and removes the entry', async () => {
      const h = await blockedBruno();
      h.client.patchPet.mockResolvedValue({
        kind: 'ok',
        pet: backend({ id: uuid(60), breed: 'pug', version: 4 }),
        warnings: [],
      });
      await expect(
        h.service.resolveAmbiguous(SENDER, uuid(1), uuid(60)),
      ).resolves.toBe('resolved');
      expect(h.client.patchPet.mock.calls).toEqual([
        [CUSTOMER_ID, uuid(60), { version: 3, breed: 'pug' }],
      ]);
      await expect(h.local()).resolves.toEqual([]);
      expect(h.service.ambiguousEntries(SENDER)).toEqual([]);
    });

    it('resolveAmbiguous refuses a pet that is not a twin of the entry, or an unknown entry', async () => {
      const h = await blockedBruno();
      await expect(
        h.service.resolveAmbiguous(SENDER, uuid(1), uuid(99)),
      ).resolves.toBe('not_found');
      await expect(
        h.service.resolveAmbiguous(SENDER, uuid(7), uuid(60)),
      ).resolves.toBe('not_found');
      expect(h.client.patchPet).not.toHaveBeenCalled();
      expect(await h.local()).toHaveLength(1);
    });

    it('a failed PATCH keeps the entry blocked', async () => {
      const h = await blockedBruno();
      h.client.patchPet.mockRejectedValue(new TypeError('down'));
      await expect(
        h.service.resolveAmbiguous(SENDER, uuid(1), uuid(60)),
      ).resolves.toBe('failed');
      await expect(h.local()).resolves.toMatchObject([
        { name: 'Bruno', blocked: 'ambiguous' },
      ]);
    });

    it('after «olvida mis datos» → unavailable, nothing written', async () => {
      const h = await blockedBruno();
      await h.profiles.forget(SENDER);
      await expect(
        h.service.resolveAmbiguous(SENDER, uuid(1), uuid(60)),
      ).resolves.toBe('unavailable');
      expect(h.client.patchPet).not.toHaveBeenCalled();
    });
  });
});
