import type { CustomerPet } from './customer-profile';
import {
  breedSize,
  extractPetAllergy,
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

describe('extractPetAllergy (T4c-1 G1)', () => {
  it.each<[string, { name: string; allergies: string } | null]>([
    ['Max es alérgico al pollo', { name: 'Max', allergies: 'pollo' }],
    ['luna es alergica a la res.', { name: 'Luna', allergies: 'res' }],
    [
      'oye, Kira es alérgica al pollo y al cerdo, ¿qué me recomiendas?',
      { name: 'Kira', allergies: 'pollo y al cerdo' },
    ],
    ['Bruno es alérgico a los granos', { name: 'Bruno', allergies: 'granos' }],
    ['Toby es alérgico a mariscos!', { name: 'Toby', allergies: 'mariscos' }],
    // No pet name: a pronoun, a pet word or a filler word is not a name.
    ['él es alérgico al pollo', null],
    ['mi perrita es alérgica al pollo', null],
    ['que es alérgico al pollo', null],
    ['yo soy alérgico al pollo', null],
    ['croquetas sin pollo', null],
    // Owners often call a pet «mi bebé»: not a person word.
    ['mi bebé Max es alérgico al pollo', { name: 'Max', allergies: 'pollo' }],
  ])('%s', (text, expected) => {
    expect(extractPetAllergy(text)).toEqual(expected);
  });

  // T4c-1-fix H2: questions, other people and clause joiners.
  it.each<[string, { name: string; allergies: string } | null]>([
    ['¿Max es alérgico al pollo?', null],
    ['oye, ¿y si Max es alérgico al pollo?', null],
    ['Max es alérgico al pollo?', null],
    ['mi esposo Max es alérgico al pollo', null],
    ['mi hija Luna es alérgica a la res', null],
    ['mi mamá Rosa es alérgica al gluten', null],
    ['mi amigo Toby es alérgico a los mariscos', null],
    [
      'Max es alérgico al pollo pero le gusta el pescado',
      { name: 'Max', allergies: 'pollo' },
    ],
    [
      'Max es alérgico al pollo y quiero unas croquetas',
      { name: 'Max', allergies: 'pollo' },
    ],
    [
      'Luna es alérgica a la res y le doy pavo',
      { name: 'Luna', allergies: 'res' },
    ],
    [
      'Kira es alérgica al pollo porque le da comezón',
      { name: 'Kira', allergies: 'pollo' },
    ],
    [
      'Bruno es alérgico al trigo y necesito algo sin granos',
      { name: 'Bruno', allergies: 'trigo' },
    ],
    // Kept whole: an allergy list joined by «y al».
    [
      'Max es alérgico al pollo y al pescado',
      { name: 'Max', allergies: 'pollo y al pescado' },
    ],
    // A question elsewhere in the message does not hide a statement.
    [
      'Max es alérgico al pollo. ¿Qué croquetas tienen?',
      { name: 'Max', allergies: 'pollo' },
    ],
    // A pet word before the name is still the pet.
    ['mi perro Max es alérgico al pollo', { name: 'Max', allergies: 'pollo' }],
  ])('H2: %s', (text, expected) => {
    expect(extractPetAllergy(text)).toEqual(expected);
  });

  it('bounds the allergy text', () => {
    const allergy = extractPetAllergy(`Max es alérgico al ${'a'.repeat(300)}`);
    expect(allergy?.allergies.length).toBeLessThanOrEqual(120);
  });
});
