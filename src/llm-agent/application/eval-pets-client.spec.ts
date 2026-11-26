import { EVAL_CUSTOMER_ID } from '../../../scripts/eval/fixtures/fake-api';
import {
  EVAL_PET_BRUNO,
  EVAL_PET_MAX,
  EvalFakePetsClient,
  evalCustomerLookup,
} from '../../../scripts/eval/fixtures/fake-pets-client';

/**
 * Multi-pet T7: the conversation eval's in-memory pets backend
 * (scripts/eval/fixtures/fake-pets-client.ts) follows
 * docs/contracts/customer-pets-bot-contract.md: versions, idempotent create,
 * conflicts, archive/restore/delete and the by-phone lookup.
 */
const NOW = new Date('2026-11-25T12:00:00.000Z');
const OTHER_CUSTOMER = 'c0000000-0000-4000-8000-000000000099';

function client() {
  const events: string[] = [];
  const pets = new EvalFakePetsClient({ events, now: () => NOW });
  pets.addCustomer(EVAL_CUSTOMER_ID, [EVAL_PET_MAX, EVAL_PET_BRUNO]);
  return { pets, events };
}

describe('eval fake pets client (customer-pets contract)', () => {
  it('lists ACTIVE pets by name with the age computed at read time', async () => {
    const { pets } = client();
    const listed = await pets.listPets(EVAL_CUSTOMER_ID);
    expect(listed.kind).toBe('ok');
    if (listed.kind !== 'ok') return;
    expect(listed.pets.map((pet) => [pet.name, pet.ageLabel])).toEqual([
      ['Bruno', '~10 meses'],
      ['Max', '~3 años'],
    ]);
    expect(listed.pets.every((pet) => pet.version === 1)).toBe(true);
    expect(await pets.listPets(OTHER_CUSTOMER)).toEqual({
      kind: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('creates idempotently: same key and body replays, another body conflicts', async () => {
    const { pets, events } = client();
    const input = {
      name: 'Luna',
      species: 'DOG' as const,
      approxAge: { years: 3 },
    };
    const first = await pets.createPet(EVAL_CUSTOMER_ID, input, 'k1');
    expect(first).toMatchObject({
      kind: 'ok',
      created: true,
      warnings: [],
      pet: {
        name: 'Luna',
        createdVia: 'CHATBOT',
        version: 1,
        birthDate: '2023-01-01',
        birthDatePrecision: 'YEAR',
        ageLabel: '~3 años',
      },
    });
    const replay = await pets.createPet(EVAL_CUSTOMER_ID, input, 'k1');
    expect(replay).toMatchObject({ kind: 'ok', created: false });
    if (first.kind !== 'ok' || replay.kind !== 'ok') return;
    expect(replay.pet.id).toBe(first.pet.id);
    expect(pets.activePets(EVAL_CUSTOMER_ID)).toHaveLength(3);
    expect(
      await pets.createPet(EVAL_CUSTOMER_ID, { ...input, breed: 'Pug' }, 'k1'),
    ).toEqual({ kind: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await pets.createPet(EVAL_CUSTOMER_ID, input, '  ')).toEqual({
      kind: 'INVALID_IDEMPOTENCY_KEY',
    });
    expect(await pets.createPet(OTHER_CUSTOMER, input, 'k2')).toEqual({
      kind: 'CUSTOMER_NOT_FOUND',
    });
    expect(events[0]).toBe(
      'createPet(name "Luna", species "DOG", approxAge {"years":3}) → created Luna v1',
    );
  });

  it('warns PET_NAME_DUPLICATE for a second active pet with the same folded name', async () => {
    const { pets } = client();
    const twin = await pets.createPet(
      EVAL_CUSTOMER_ID,
      { name: ' máx ', species: 'DOG' },
      'k-twin',
    );
    expect(twin).toMatchObject({
      kind: 'ok',
      warnings: ['PET_NAME_DUPLICATE'],
    });
  });

  it('PATCH: stale version conflicts, absent fields stay, null clears, version +1', async () => {
    const { pets, events } = client();
    expect(
      await pets.patchPet(EVAL_CUSTOMER_ID, EVAL_PET_MAX.id, {
        version: 7,
        allergies: 'Pollo',
      }),
    ).toEqual({ kind: 'PET_VERSION_CONFLICT', currentVersion: 1 });
    const patched = await pets.patchPet(EVAL_CUSTOMER_ID, EVAL_PET_MAX.id, {
      version: 1,
      allergies: 'Pollo',
      size: null,
    });
    expect(patched).toMatchObject({
      kind: 'ok',
      warnings: [],
      pet: {
        version: 2,
        allergies: 'Pollo',
        size: null,
        breed: 'Labrador',
        updatedAt: NOW.toISOString(),
      },
    });
    expect(events).toContain(
      'patchPet(Max v1 size null, allergies "Pollo") → ACTIVE v2',
    );
    expect(
      await pets.patchPet(
        EVAL_CUSTOMER_ID,
        'f9999999-0000-4000-8000-000000000000',
        {
          version: 1,
        },
      ),
    ).toEqual({ kind: 'PET_NOT_FOUND' });
    // A pet of another customer is not found either (§4).
    pets.addCustomer(OTHER_CUSTOMER);
    expect(
      await pets.patchPet(OTHER_CUSTOMER, EVAL_PET_MAX.id, { version: 2 }),
    ).toEqual({ kind: 'PET_NOT_FOUND' });
  });

  it('archive, then archived writes are refused; restore brings it back', async () => {
    const { pets, events } = client();
    const archived = await pets.archivePet(
      EVAL_CUSTOMER_ID,
      EVAL_PET_BRUNO.id,
      {
        version: 1,
        reason: 'Falleció',
      },
    );
    expect(archived).toMatchObject({
      kind: 'ok',
      pet: {
        status: 'ARCHIVED',
        version: 2,
        archivedAt: NOW.toISOString(),
        archivedReason: 'Falleció',
      },
    });
    expect(events).toContain(
      'archivePet(Bruno v1 reason "Falleció") → ARCHIVED v2',
    );
    expect(pets.activePets(EVAL_CUSTOMER_ID).map((pet) => pet.name)).toEqual([
      'Max',
    ]);
    const all = await pets.listPets(EVAL_CUSTOMER_ID, 'ARCHIVED');
    expect(all.kind === 'ok' && all.pets.map((pet) => pet.name)).toEqual([
      'Bruno',
    ]);
    // §4.2 order: version is checked before the state.
    expect(
      await pets.archivePet(EVAL_CUSTOMER_ID, EVAL_PET_BRUNO.id, {
        version: 1,
      }),
    ).toEqual({ kind: 'PET_VERSION_CONFLICT', currentVersion: 2 });
    expect(
      await pets.archivePet(EVAL_CUSTOMER_ID, EVAL_PET_BRUNO.id, {
        version: 2,
      }),
    ).toEqual({ kind: 'PET_ARCHIVED' });
    expect(
      await pets.patchPet(EVAL_CUSTOMER_ID, EVAL_PET_BRUNO.id, {
        version: 2,
        notes: 'x',
      }),
    ).toEqual({ kind: 'PET_ARCHIVED' });
    const restored = await pets.restorePet(
      EVAL_CUSTOMER_ID,
      EVAL_PET_BRUNO.id,
      {
        version: 2,
      },
    );
    expect(restored).toMatchObject({
      kind: 'ok',
      pet: {
        status: 'ACTIVE',
        version: 3,
        archivedAt: null,
        archivedReason: null,
      },
    });
    expect(
      await pets.restorePet(EVAL_CUSTOMER_ID, EVAL_PET_BRUNO.id, {
        version: 3,
      }),
    ).toEqual({ kind: 'PET_NOT_ARCHIVED' });
  });

  it('delete: stale version conflicts; done once, then PET_NOT_FOUND (a retry means done)', async () => {
    const { pets } = client();
    expect(await pets.deletePet(EVAL_CUSTOMER_ID, EVAL_PET_MAX.id, 3)).toEqual({
      kind: 'PET_VERSION_CONFLICT',
      currentVersion: 1,
    });
    expect(await pets.deletePet(EVAL_CUSTOMER_ID, EVAL_PET_MAX.id, 1)).toEqual({
      kind: 'ok',
    });
    expect(await pets.deletePet(EVAL_CUSTOMER_ID, EVAL_PET_MAX.id, 1)).toEqual({
      kind: 'PET_NOT_FOUND',
    });
    const all = await pets.listPets(EVAL_CUSTOMER_ID, 'ALL');
    expect(all.kind === 'ok' && all.pets.map((pet) => pet.name)).toEqual([
      'Bruno',
    ]);
  });

  it('refuses a 21st active pet', async () => {
    const pets = new EvalFakePetsClient({ now: () => NOW });
    pets.addCustomer(EVAL_CUSTOMER_ID);
    for (let i = 0; i < 20; i += 1)
      await pets.createPet(
        EVAL_CUSTOMER_ID,
        { name: `Pet ${i}`, species: 'CAT' },
        `k${i}`,
      );
    expect(
      await pets.createPet(
        EVAL_CUSTOMER_ID,
        { name: 'Extra', species: 'CAT' },
        'k-extra',
      ),
    ).toEqual({ kind: 'PET_LIMIT_REACHED' });
  });
});

describe('eval by-phone lookup for the pet store', () => {
  it('finds an existing fixture customer with its current ACTIVE pets', async () => {
    const pets = new EvalFakePetsClient({ now: () => NOW });
    const lookup = evalCustomerLookup(
      {
        kind: 'existing',
        firstName: 'Mariana',
        zip: '03100',
        pets: [EVAL_PET_MAX, EVAL_PET_BRUNO],
      },
      pets,
      new Map(),
    );
    await pets.archivePet(EVAL_CUSTOMER_ID, EVAL_PET_BRUNO.id, { version: 1 });
    const found = await lookup.getCustomerByPhone('52', '5550001111');
    expect(found.found).toBe(true);
    expect(found.customer?.customerId).toBe(EVAL_CUSTOMER_ID);
    expect(found.customer?.pets?.map((pet) => pet.name)).toEqual(['Max']);
  });

  it('a new customer is a prospect until a checkout creates the Customer (S8)', async () => {
    const pets = new EvalFakePetsClient({ now: () => NOW });
    const orders = new Map<string, { customer: { firstName: string } }>();
    const lookup = evalCustomerLookup({ kind: 'new' }, pets, orders);
    expect(await lookup.getCustomerByPhone('52', '5550001111')).toEqual({
      found: false,
      customer: null,
    });
    expect(pets.hasCustomer(EVAL_CUSTOMER_ID)).toBe(false);
    orders.set('key', { customer: { firstName: 'Laura' } });
    const found = await lookup.getCustomerByPhone('52', '5550001111');
    expect(found.customer).toMatchObject({ firstName: 'Laura', pets: [] });
    expect(pets.hasCustomer(EVAL_CUSTOMER_ID)).toBe(true);
  });
});
