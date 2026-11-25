import type { CustomerPet as BackendPet } from '../../chatbot-api/domain/dtos/customer-pets.dto';
import {
  approxAgeFromText,
  backendPetPatch,
  birthDateFromApproxAge,
  foldPetName,
  localAgeMonths,
  localCreateBody,
  localPetFromFacts,
  matchPetForFacts,
  mergeFactsIntoLocal,
  normalizeLocalPets,
  petAgeLabel,
  petNameDiminutiveOf,
  type LocalPet,
} from './customer-pets';

const NOW = new Date('2026-11-23T18:00:00.000Z');
const ID = 'b1f0c7a2-0000-4000-8000-000000000001';

const backend = (patch: Partial<BackendPet> = {}): BackendPet => ({
  id: '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11',
  customerId: '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90',
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

describe('foldPetName', () => {
  it('ignores accents, case and extra spaces', () => {
    expect(foldPetName('  Ñoño  José ')).toBe('nono jose');
    expect(foldPetName('MÁX')).toBe(foldPetName('max'));
  });
});

describe('ages (S6: never frozen text)', () => {
  it('reads a stored age text as approxAge, a stage word as a stage', () => {
    expect(approxAgeFromText('3 años')).toEqual({ years: 3 });
    expect(approxAgeFromText('1 año')).toEqual({ years: 1 });
    expect(approxAgeFromText('10 meses')).toEqual({ months: 10 });
    expect(approxAgeFromText('cachorro')).toBeUndefined();
    expect(approxAgeFromText(undefined)).toBeUndefined();
  });

  it('converts approxAge to an approximate birth date like the backend (§3)', () => {
    expect(birthDateFromApproxAge({ months: 10 }, NOW)).toEqual({
      birthDate: '2026-01-01',
      birthDatePrecision: 'MONTH',
    });
    expect(birthDateFromApproxAge({ years: 3 }, NOW)).toEqual({
      birthDate: '2023-01-01',
      birthDatePrecision: 'YEAR',
    });
    // Business timezone: 2027-01-01T03:00Z is still Dec 31 in Mexico City.
    expect(
      birthDateFromApproxAge(
        { months: 1 },
        new Date('2027-01-01T03:00:00.000Z'),
      ),
    ).toEqual({ birthDate: '2026-11-01', birthDatePrecision: 'MONTH' });
  });

  it('the local age advances by itself', () => {
    expect(localAgeMonths('2026-01-01', NOW)).toBe(10);
    expect(localAgeMonths('2026-01-01', new Date('2027-03-02T18:00:00Z'))).toBe(
      14,
    );
    expect(petAgeLabel(0)).toBe('menos de 1 mes');
    expect(petAgeLabel(1)).toBe('~1 mes');
    expect(petAgeLabel(10)).toBe('~10 meses');
    expect(petAgeLabel(14)).toBe('~1 año');
    expect(petAgeLabel(40)).toBe('~3 años');
  });
});

describe('local pets', () => {
  it('builds a local pet from facts with a birth date, never the age text', () => {
    expect(
      localPetFromFacts(
        ID,
        {
          name: 'Luna',
          species: 'perro',
          breed: 'labrador',
          size: 'grande',
          ageText: '3 años',
        },
        NOW,
      ),
    ).toEqual({
      id: ID,
      name: 'Luna',
      species: 'perro',
      breed: 'labrador',
      size: 'grande',
      birthDate: '2023-01-01',
      birthDatePrecision: 'YEAR',
      createdAt: NOW.toISOString(),
    });
    expect(
      localPetFromFacts(ID, { species: 'perro', ageText: 'cachorro' }, NOW),
    ).toEqual({
      id: ID,
      species: 'perro',
      stage: 'cachorro',
      createdAt: NOW.toISOString(),
    });
  });

  it('merges new facts; a different species is a conflict', () => {
    const luna = localPetFromFacts(ID, { name: 'Luna', species: 'perro' }, NOW);
    expect(
      mergeFactsIntoLocal(luna, { breed: 'labrador', ageText: '2 años' }, NOW),
    ).toEqual({
      ...luna,
      breed: 'labrador',
      birthDate: '2024-01-01',
      birthDatePrecision: 'YEAR',
    });
    expect(mergeFactsIntoLocal(luna, { species: 'gato' }, NOW)).toBe(
      'conflict',
    );
    expect(mergeFactsIntoLocal(luna, { species: 'perro' }, NOW)).toBe(
      'unchanged',
    );
  });

  it('the create body needs a name and a species (from the breed too); no nulls, no age text', () => {
    expect(localCreateBody({ id: ID, createdAt: '', species: 'perro' })).toBe(
      null,
    );
    expect(localCreateBody({ id: ID, createdAt: '', name: 'Luna' })).toBe(null);
    expect(
      localCreateBody({
        id: ID,
        createdAt: '',
        name: 'Luna',
        breed: 'labrador',
        size: 'grande',
        birthDate: '2023-01-01',
        birthDatePrecision: 'YEAR',
        stage: 'adulto',
        notes: 'come poco',
      }),
    ).toEqual({
      name: 'Luna',
      species: 'DOG',
      breed: 'labrador',
      size: 'LARGE',
      birthDate: '2023-01-01',
      birthDatePrecision: 'YEAR',
      notes: 'come poco',
    });
  });

  it('normalizes a stored list, dropping invalid entries', () => {
    const good: LocalPet = {
      id: ID,
      name: 'Luna',
      species: 'perro',
      createdAt: NOW.toISOString(),
    };
    expect(
      normalizeLocalPets([
        good,
        { id: '', name: 'X' },
        { id: 'x', species: 'pez', createdAt: 'z' },
        'nope',
      ]),
    ).toEqual([good]);
    expect(normalizeLocalPets(null)).toEqual([]);
    expect(normalizeLocalPets({})).toEqual([]);
  });
});

describe('backendPetPatch (C1: only changed fields)', () => {
  it('sends only what changed, age as approxAge', () => {
    expect(
      backendPetPatch(backend(), { name: 'Bruno', ageText: '2 años' }),
    ).toEqual({ approxAge: { years: 2 } });
    expect(backendPetPatch(backend(), { breed: 'pug' })).toEqual({
      breed: 'pug',
    });
  });

  it('is null when nothing changes (same breed label, close age)', () => {
    expect(
      backendPetPatch(backend({ breed: 'Chihuahua de pelo largo' }), {
        name: 'BRUNO',
        species: 'perro',
        breed: 'chihuahua',
        size: 'pequeño',
        ageText: '10 meses',
      }),
    ).toBeNull();
    expect(
      backendPetPatch(backend({ ageMonths: 11 }), { ageText: '10 meses' }),
    ).toBeNull();
    expect(
      backendPetPatch(backend({ ageMonths: 40 }), { ageText: '3 años' }),
    ).toBeNull();
  });

  it('never overwrites a stored size or notes; fills them when empty', () => {
    expect(backendPetPatch(backend(), { size: 'grande' })).toBeNull();
    expect(
      backendPetPatch(backend({ size: null }), { size: 'grande' }),
    ).toEqual({ size: 'LARGE' });
    expect(
      backendPetPatch(backend({ notes: 'POS' }), { notes: 'otra' }),
    ).toBeNull();
    expect(backendPetPatch(backend(), { notes: 'come poco' })).toEqual({
      notes: 'come poco',
    });
  });

  it('a different species is a conflict (never mix pets)', () => {
    expect(backendPetPatch(backend(), { species: 'gato' })).toBe('conflict');
  });

  it('a stage word is never written to the backend', () => {
    expect(backendPetPatch(backend(), { ageText: 'adulto' })).toBeNull();
  });
});

describe('matchPetForFacts', () => {
  const max = { ref: 'max', name: 'Max', species: 'perro' as const };
  const bruno = { ref: 'bruno', name: 'Bruno', species: 'perro' as const };
  const michi = { ref: 'michi', name: 'Michi', species: 'gato' as const };
  const nameless = { ref: 'n', species: 'perro' as const, nameable: true };

  it('matches by normalized name', () => {
    expect(matchPetForFacts([max, bruno], { name: 'máx' })).toEqual({
      kind: 'match',
      ref: 'max',
    });
  });

  it('a new name is a new pet', () => {
    expect(matchPetForFacts([max], { name: 'Toby' })).toEqual({ kind: 'new' });
  });

  it('a new name names the only compatible nameless local pet', () => {
    expect(
      matchPetForFacts([max, nameless], { name: 'Luna', species: 'perro' }),
    ).toEqual({ kind: 'match', ref: 'n' });
    expect(
      matchPetForFacts([max, nameless], { name: 'Luna', species: 'gato' }),
    ).toEqual({ kind: 'new' });
  });

  it('two same-name pets of the same species are ambiguous', () => {
    expect(
      matchPetForFacts([max, { ...max, ref: 'max2' }], { name: 'Max' }),
    ).toEqual({ kind: 'none' });
    expect(
      matchPetForFacts([max, { ...max, ref: 'cat', species: 'gato' }], {
        name: 'Max',
        species: 'gato',
      }),
    ).toEqual({ kind: 'match', ref: 'cat' });
  });

  it('nameless facts update only the single compatible pet', () => {
    expect(matchPetForFacts([max], { breed: 'husky' })).toEqual({
      kind: 'match',
      ref: 'max',
    });
    expect(
      matchPetForFacts([max, michi], { species: 'perro', breed: 'husky' }),
    ).toEqual({ kind: 'match', ref: 'max' });
    expect(
      matchPetForFacts([max, bruno], { species: 'perro', breed: 'husky' }),
    ).toEqual({ kind: 'none' });
    expect(matchPetForFacts([max, michi], { ageText: '3 años' })).toEqual({
      kind: 'none',
    });
  });

  it('nameless facts with no pets start a nameless pet', () => {
    expect(matchPetForFacts([], { species: 'perro' })).toEqual({
      kind: 'new',
    });
  });
});

describe('local upload backoff fields (T4b-fix-B B1)', () => {
  const body = { name: 'Max', species: 'DOG' as const };
  const base = {
    id: ID,
    name: 'Max',
    species: 'perro',
    createdAt: NOW.toISOString(),
  };

  it('keeps a valid attempt counter and next attempt time', () => {
    const upload = {
      customerId: 'c',
      body,
      attempts: 3,
      nextAttemptAt: '2026-11-23T18:04:00.000Z',
    };
    expect(normalizeLocalPets([{ ...base, upload }])).toEqual([
      { ...base, upload },
    ]);
  });

  it('an entry without them (or with invalid ones) is attempt 0, due now', () => {
    expect(
      normalizeLocalPets([
        { ...base, upload: { customerId: 'c', body } },
        {
          ...base,
          id: 'x',
          upload: {
            customerId: 'c',
            body,
            attempts: -1,
            nextAttemptAt: 'soon',
          },
        },
        {
          ...base,
          id: 'y',
          upload: { customerId: 'c', body, attempts: 1.5 },
        },
      ]),
    ).toEqual([
      { ...base, upload: { customerId: 'c', body } },
      { ...base, id: 'x', upload: { customerId: 'c', body } },
      { ...base, id: 'y', upload: { customerId: 'c', body } },
    ]);
  });

  it('20 maximal ASCII entries with the backoff fields stay within the 32768-byte column cap', () => {
    const long = (n: number) => 'x'.repeat(n);
    const pet: LocalPet = {
      id: ID,
      name: long(40),
      species: 'perro',
      breed: long(60),
      size: 'gigante',
      birthDate: '2020-01-01',
      birthDatePrecision: 'MONTH',
      stage: 'cachorro',
      notes: long(200),
      createdAt: NOW.toISOString(),
    };
    const created = localCreateBody(pet);
    if (created === null) throw new Error('no body');
    const full: LocalPet = {
      ...pet,
      upload: {
        customerId: '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90',
        body: created,
        blocked: true,
        attempts: 999_999,
        nextAttemptAt: NOW.toISOString(),
      },
    };
    const bytes = Buffer.byteLength(
      JSON.stringify(Array.from({ length: 20 }, () => full)),
    );
    expect(bytes).toBeLessThanOrEqual(32768);
  });
});

describe('local entry states (T4b-fix-2-C C2, C6)', () => {
  const base = {
    id: ID,
    name: 'Max',
    species: 'perro',
    createdAt: NOW.toISOString(),
  };

  it('keeps the ambiguous block and a valid merge backoff', () => {
    const merge = { attempts: 2, nextAttemptAt: '2026-11-23T18:04:00.000Z' };
    expect(
      normalizeLocalPets([{ ...base, blocked: 'ambiguous', merge }]),
    ).toEqual([{ ...base, blocked: 'ambiguous', merge }]);
  });

  it('drops unknown block values and invalid merge backoffs (attempt 0, due now); old entries read as before', () => {
    expect(
      normalizeLocalPets([
        { ...base, blocked: true, merge: { attempts: 0, nextAttemptAt: 'x' } },
        { ...base, id: 'x', merge: { attempts: 2 } },
        { ...base, id: 'y' },
      ]),
    ).toEqual([base, { ...base, id: 'x' }, { ...base, id: 'y' }]);
  });

  it('20 maximal entries with every state field stay within the 32768-byte column cap', () => {
    const long = (n: number) => 'x'.repeat(n);
    const pet: LocalPet = {
      id: ID,
      name: long(40),
      species: 'perro',
      breed: long(60),
      size: 'gigante',
      birthDate: '2020-01-01',
      birthDatePrecision: 'MONTH',
      stage: 'cachorro',
      notes: long(200),
      createdAt: NOW.toISOString(),
    };
    const created = localCreateBody(pet);
    if (created === null) throw new Error('no body');
    const full: LocalPet = {
      ...pet,
      blocked: 'ambiguous',
      merge: { attempts: 999_999, nextAttemptAt: NOW.toISOString() },
      upload: {
        customerId: '5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90',
        body: created,
        blocked: true,
        attempts: 999_999,
        nextAttemptAt: NOW.toISOString(),
      },
    };
    const bytes = Buffer.byteLength(
      JSON.stringify(Array.from({ length: 20 }, () => full)),
    );
    expect(bytes).toBeLessThanOrEqual(32768);
  });
});

describe('petNameDiminutiveOf (T4c-2b Q3, S10)', () => {
  it.each([
    ['Brunito', ['Bruno'], 'Bruno'],
    ['BRUNÍTO', ['bruno'], 'bruno'],
    ['Brunillo', ['Max', 'Bruno'], 'Bruno'],
    ['Lunita', ['Luna'], 'Luna'],
    ['Maxito', ['Max'], 'Max'],
    ['Michito', ['Michi'], 'Michi'],
    ['Pepito', ['Pepe'], 'Pepe'],
    ['Leoncito', ['León'], 'León'],
    ['Paquito', ['Paco'], 'Paco'],
    ['Manchita', ['Mancha'], 'Mancha'],
    ['Canelilla', ['Canela'], 'Canela'],
  ])('%s is a diminutive of %j → %s', (name, bases, base) => {
    expect(petNameDiminutiveOf(name, bases)).toBe(base);
  });

  it.each([
    ['Bruno', ['Bruno']],
    ['Brunito', ['Max']],
    ['Rita', ['R']],
    ['Benito', ['Bruno']],
    ['Brunito', []],
    ['Mi Brunito', ['Bruno']],
  ])('%s is not a diminutive of %j', (name, bases) => {
    expect(petNameDiminutiveOf(name, bases)).toBeNull();
  });
});
