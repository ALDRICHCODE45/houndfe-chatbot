import type { CustomerPet } from './customer-profile';
import {
  breedSize,
  extractPetFacts,
  knownPetPromptLine,
  petFactsConflict,
} from './pet-facts';

describe('extractPetFacts', () => {
  it.each<[string, CustomerPet]>([
    [
      'mi perrita Luna es una labrador de 3 años 🐾',
      {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        size: 'grande',
        ageText: '3 años',
      },
    ],
    [
      'mi perrita luna es una labrador de 3 años',
      {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        size: 'grande',
        ageText: '3 años',
      },
    ],
    [
      'Mi gato se llama Michu y es siamés, tiene 8 meses',
      { name: 'Michu', species: 'gato', breed: 'siamés', ageText: '8 meses' },
    ],
    [
      'Rocky es mi perro, un pastor alemán adulto',
      {
        name: 'Rocky',
        species: 'perro',
        breed: 'pastor alemán',
        size: 'grande',
        ageText: 'adulto',
      },
    ],
    [
      'mi cachorro es un chihuahua',
      {
        species: 'perro',
        breed: 'chihuahua',
        size: 'pequeño',
        ageText: 'cachorro',
      },
    ],
    [
      'mi perro es mestizo y es mediano',
      { species: 'perro', breed: 'mestizo', size: 'mediano' },
    ],
    [
      'tengo un perrito que se llama Toby, es un bulldog francés',
      {
        name: 'Toby',
        species: 'perro',
        breed: 'bulldog francés',
        size: 'pequeño',
      },
    ],
    [
      '¿tienen croquetas para mi perro grande?',
      { species: 'perro', size: 'grande' },
    ],
    ['y arena para mi michi? 😅', { species: 'gato' }],
    [
      'mi gatita Nala tiene un año',
      { name: 'Nala', species: 'gato', ageText: '1 año' },
    ],
    [
      'mi perro senior es un yorkshire',
      {
        species: 'perro',
        breed: 'yorkshire',
        size: 'pequeño',
        ageText: 'senior',
      },
    ],
    ['mis perros son labradores', { species: 'perro' }],
  ])('%s', (text, expected) => {
    expect(extractPetFacts(text)).toEqual(expected);
  });

  it.each([
    'busco croquetas para perro grande',
    'croquetas para labrador adulto de 15 kg',
    'Holaaa 😄 oye, ¿tienes croquetas para perro? 🐶',
    'quiero 2 bultos de croquetas para cachorro',
    '¿cómo se llama ese producto?',
    'se llama Royal Canin la marca',
    'mi pedido de hace 2 meses',
    'me llamo Ana',
    'busco croquetas para ella',
    'hola',
    '',
  ])('no pet fact: %s', (text) => {
    expect(extractPetFacts(text)).toEqual({});
  });

  it('never takes a verb or a breed as the name', () => {
    expect(extractPetFacts('mi perro come mucho').name).toBeUndefined();
    expect(
      extractPetFacts('mi perro labrador ya es grande').name,
    ).toBeUndefined();
    expect(extractPetFacts('mi gata tiene 2 años').name).toBeUndefined();
  });

  it('ignores a "hace N meses" that is not the pet age', () => {
    expect(
      extractPetFacts('mi perro Max, le compré croquetas hace 2 meses'),
    ).toEqual({ name: 'Max', species: 'perro' });
  });
});

describe('breedSize', () => {
  it('maps curated breeds and leaves ambiguous ones unknown', () => {
    expect(breedSize('Labrador')).toBe('grande');
    expect(breedSize('chihuahua')).toBe('pequeño');
    expect(breedSize('gran danés')).toBe('gigante');
    expect(breedSize('mestizo')).toBeNull();
    expect(breedSize('schnauzer')).toBeNull();
    expect(breedSize('persa')).toBeNull();
  });
});

describe('petFactsConflict', () => {
  it('flags another pet (different name or species), never new facts', () => {
    const luna: CustomerPet = { name: 'Luna', species: 'perro' };
    expect(petFactsConflict(luna, { name: 'Max' })).toBe(true);
    expect(petFactsConflict(luna, { species: 'gato' })).toBe(true);
    expect(petFactsConflict(luna, { name: 'luna', breed: 'labrador' })).toBe(
      false,
    );
    expect(petFactsConflict(undefined, { name: 'Max' })).toBe(false);
  });
});

describe('knownPetPromptLine', () => {
  it('derives size and life stage and the direct search query', () => {
    const line = knownPetPromptLine({
      name: 'Luna',
      species: 'perro',
      breed: 'labrador',
      ageText: '3 años',
    });
    expect(line).toMatch(
      /^Mascota conocida: "Luna", perro, raza "labrador" \(raza grande\), edad "3 años" \(adulto\)\./,
    );
    expect(line).toContain('«croquetas perro adulto raza grande»');
    expect(line).toContain('«para ella/él»');
    expect(line).toMatch(/no pregunte especie, raza ni tamaño ya conocidos/);
  });

  it('uses a stored size over the breed and a puppy/senior stage', () => {
    expect(
      knownPetPromptLine({
        species: 'perrita',
        size: 'chica',
        ageText: '5 meses',
      }),
    ).toContain('«croquetas perro cachorro raza pequeña»');
    expect(
      knownPetPromptLine({ species: 'gato', ageText: '12 años' }),
    ).toContain('«croquetas gato senior»');
  });

  it('is null without searchable facts (a name alone is not enough)', () => {
    expect(knownPetPromptLine(undefined)).toBeNull();
    expect(knownPetPromptLine({ name: 'Luna' })).toBeNull();
  });
});
