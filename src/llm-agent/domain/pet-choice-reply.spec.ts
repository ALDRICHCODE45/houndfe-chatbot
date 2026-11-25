import {
  INTERACTIVE_LIMITS,
  interactiveReplyText,
  parseInteractiveReplyId,
  petChoiceOptions,
  petChoicePick,
  type PetChoicePet,
} from './customer-reply';

const MAX_ID = 'a0000000-0000-4000-8000-000000000050';
const BRUNO_ID = '8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const LOCAL_ID = 'b1f0c7a2-0000-4000-8000-000000000001';

const max: PetChoicePet = {
  ref: `backend:${MAX_ID}`,
  name: 'Max',
  species: 'perro',
  breed: 'labrador',
  stage: 'adulto',
};
const bruno: PetChoicePet = {
  ref: `backend:${BRUNO_ID}`,
  name: 'Bruno',
  species: 'perro',
  breed: 'chihuahua',
  ageLabel: '~10 meses',
  stage: 'cachorro',
};
const michi: PetChoicePet = {
  ref: `local:${LOCAL_ID}`,
  name: 'Michi',
  species: 'gato',
};
const pets = (n: number): PetChoicePet[] =>
  Array.from({ length: n }, (_, i) => ({
    ref: `backend:c0000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    name: `Pet${i + 1}`,
    species: 'perro',
  }));

/** T4c-2a P2/P3 (S3, S12): the which-pet buttons, list and reply ids. */
describe('which-pet question (pet_pick)', () => {
  it('two pets → two buttons «Max (labrador, adulto)» bound to each ref', () => {
    expect(petChoicePick([max, bruno], '¿Para quién es?')).toEqual({
      interactive: {
        type: 'buttons',
        buttons: [
          { id: `pet_pick:backend:${MAX_ID}`, title: 'Max (labrador, adul…' },
          {
            id: `pet_pick:backend:${BRUNO_ID}`,
            title: 'Bruno (chihuahua, c…',
          },
        ],
        prompt: '¿Para quién es?',
        textFallback:
          '¿Para quién es? ¿Para Max (labrador, adulto) o para Bruno (chihuahua, cachorro)?',
      },
      options: [
        { ref: `backend:${MAX_ID}`, text: 'Max' },
        { ref: `backend:${BRUNO_ID}`, text: 'Bruno' },
      ],
    });
  });

  it('three pets → three buttons; a short label is kept whole; no detail → the name alone', () => {
    const result = petChoicePick(
      [{ ref: 'legacy', name: 'Luna' }, michi, max],
      '¿Para quién es?',
    );
    expect(result?.interactive).toEqual({
      type: 'buttons',
      buttons: [
        { id: 'pet_pick:legacy', title: 'Luna' },
        { id: `pet_pick:local:${LOCAL_ID}`, title: 'Michi (gato)' },
        { id: `pet_pick:backend:${MAX_ID}`, title: 'Max (labrador, adul…' },
      ],
      prompt: '¿Para quién es?',
      textFallback:
        '¿Para quién es? ¿Para Luna, Michi (gato) o para Max (labrador, adulto)?',
    });
    for (const button of result!.interactive.type === 'buttons'
      ? result!.interactive.buttons
      : [])
      expect(button.title.length).toBeLessThanOrEqual(
        INTERACTIVE_LIMITS.buttonTitle,
      );
  });

  it('four to ten pets → a list: the name as title, breed/species and age as description', () => {
    const result = petChoicePick(
      [max, bruno, michi, { ref: 'legacy', name: 'Luna' }],
      '¿Para quién es?',
    );
    expect(result?.interactive).toEqual({
      type: 'list',
      buttonText: 'Ver mascotas',
      rows: [
        {
          id: `pet_pick:backend:${MAX_ID}`,
          title: 'Max',
          description: 'labrador, adulto',
        },
        {
          id: `pet_pick:backend:${BRUNO_ID}`,
          title: 'Bruno',
          description: 'chihuahua, cachorro',
        },
        {
          id: `pet_pick:local:${LOCAL_ID}`,
          title: 'Michi',
          description: 'gato',
        },
        { id: 'pet_pick:legacy', title: 'Luna' },
      ],
      prompt: '¿Para quién es?',
      textFallback:
        '¿Para quién es? ¿Para Max (labrador, adulto), Bruno (chihuahua, cachorro), Michi (gato) o para Luna?',
    });
    const ten = petChoicePick(pets(10), 'p');
    expect(ten?.interactive.type).toBe('list');
    expect(
      ten?.interactive.type === 'list' ? ten.interactive.rows : [],
    ).toHaveLength(10);
    expect(ten?.options.map((o) => o.ref)).not.toContain('other');
  });

  it('eleven or more pets → the first nine given and the row «Otra mascota» (S12)', () => {
    const result = petChoicePick(pets(12), '¿Para quién es?');
    const rows =
      result?.interactive.type === 'list' ? result.interactive.rows : [];
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 9).map((row) => row.title)).toEqual(
      pets(9).map((pet) => pet.name),
    );
    expect(rows[9]).toEqual({
      id: 'pet_pick:other',
      title: 'Otra mascota',
      description: 'Escríbame su nombre',
    });
    expect(result?.options.at(-1)).toEqual({
      ref: 'other',
      text: 'Otra mascota',
    });
    expect(result?.options).toHaveLength(10);
  });

  it('fewer than two pets → no question', () => {
    expect(petChoicePick([], 'p')).toBeNull();
    expect(petChoicePick([max], 'p')).toBeNull();
  });

  it.each([
    [`pet_pick:backend:${MAX_ID}`, `backend:${MAX_ID}`],
    [`pet_pick:local:${LOCAL_ID}`, `local:${LOCAL_ID}`],
    ['pet_pick:legacy', 'legacy'],
    ['pet_pick:other', 'other'],
  ])('parses %j to its pet ref', (id, ref) => {
    expect(parseInteractiveReplyId(id)).toEqual({ kind: 'pet_pick', ref });
  });

  it.each([
    'pet_pick',
    'pet_pick:',
    'pet_pick:backend:',
    'pet_pick:backend',
    'pet_pick:local:',
    'pet_pick:legacy:x',
    'pet_pick:other:x',
    'pet_pick:mystery:1',
    `pet_pick:backend:${MAX_ID}:extra`,
    'pet_pick:backend:bad id',
  ])('rejects the forged or truncated id %j', (id) => {
    expect(parseInteractiveReplyId(id)).toBeNull();
  });

  it('a tapped pet keeps its title as the inbound text', () => {
    expect(
      interactiveReplyText(`pet_pick:backend:${MAX_ID}`, 'Max (labrador)'),
    ).toBe('Max (labrador)');
  });

  it('does not disturb the existing list pick ids', () => {
    expect(parseInteractiveReplyId('pick_variant:ref-1')).toEqual({
      kind: 'pick',
      choice: 'variant',
      reference: 'ref-1',
    });
  });
});

/** T4c-2a-fix J2/J3/J4 (S3, S12): readable titles, text fallback, one builder. */
describe('which-pet question hardening (T4c-2a-fix)', () => {
  const rowsOf = (result: ReturnType<typeof petChoicePick>) =>
    result?.interactive.type === 'list' ? result.interactive.rows : [];

  it('J2: two pets whose fitted button titles are identical → a list told apart by age', () => {
    const a: PetChoicePet = {
      ref: `backend:${MAX_ID}`,
      name: 'Max',
      species: 'perro',
      breed: 'labrador',
      ageLabel: '~3 años',
      stage: 'adulto',
    };
    const b: PetChoicePet = {
      ...a,
      ref: `backend:${BRUNO_ID}`,
      ageLabel: '~5 años',
    };
    const result = petChoicePick([a, b], '¿Para quién es?');
    expect(result?.interactive.type).toBe('list');
    expect(rowsOf(result)).toEqual([
      {
        id: `pet_pick:backend:${MAX_ID}`,
        title: 'Max (~3 años)',
        description: 'labrador, adulto',
      },
      {
        id: `pet_pick:backend:${BRUNO_ID}`,
        title: 'Max (~5 años)',
        description: 'labrador, adulto',
      },
    ]);
  });

  it('J2: same names without a telling age → a trailing number in the row title', () => {
    const a: PetChoicePet = {
      ref: `backend:${MAX_ID}`,
      name: 'Max',
      breed: 'labrador',
    };
    const b: PetChoicePet = { ref: 'local:x2', name: 'max', breed: 'labrador' };
    const rows = rowsOf(petChoicePick([a, b, michi], '¿Para quién es?'));
    expect(rows.map((row) => row.title)).toEqual(['Max 1', 'max 2', 'Michi']);
    expect(rows.map((row) => row.id)).toEqual([
      `pet_pick:backend:${MAX_ID}`,
      'pet_pick:local:x2',
      `pet_pick:local:${LOCAL_ID}`,
    ]);
  });

  it('J2: a name that does not fit a button title → a list (name never cut in a button)', () => {
    const long: PetChoicePet = {
      ref: `backend:${MAX_ID}`,
      name: 'Maximiliano Bigotón Tercero',
      breed: 'labrador',
    };
    const result = petChoicePick([long, bruno], 'p');
    expect(result?.interactive.type).toBe('list');
  });

  it('J2: distinct readable titles keep buttons (cut detail allowed when titles differ)', () => {
    expect(petChoicePick([max, bruno], 'p')?.interactive.type).toBe('buttons');
  });

  it('J3: the text fallback names the options («¿Para A o para B?»)', () => {
    const result = petChoicePick([max, bruno], '¿Para quién es?');
    expect(result?.interactive.textFallback).toBe(
      '¿Para quién es? ¿Para Max (labrador, adulto) o para Bruno (chihuahua, cachorro)?',
    );
  });

  it('J3: three or more → commas, then « o para » before the last', () => {
    const result = petChoicePick(
      [max, bruno, michi, { ref: 'legacy', name: 'Luna' }],
      '¿Para quién es?',
    );
    expect(result?.interactive.textFallback).toBe(
      '¿Para quién es? ¿Para Max (labrador, adulto), Bruno (chihuahua, cachorro), Michi (gato) o para Luna?',
    );
  });

  it('J4: a nameless pet shows its kind but its option is not matchable by typed text', () => {
    const nameless: PetChoicePet = {
      ref: 'legacy',
      species: 'gato',
      breed: 'siamés',
    };
    const result = petChoicePick([max, nameless], 'p');
    expect(result?.options).toEqual([
      { ref: `backend:${MAX_ID}`, text: 'Max' },
      { ref: 'legacy', text: 'Siamés', matchable: false },
    ]);
  });

  it('J4: petChoiceOptions is the one option builder (usable refs, cap, nameless flag)', () => {
    expect(
      petChoiceOptions(
        [
          max,
          { ref: 'bad ref', name: 'X' },
          { ref: 'legacy', species: 'perro' },
          bruno,
        ],
        2,
      ),
    ).toEqual([
      { ref: `backend:${MAX_ID}`, text: 'Max' },
      { ref: 'legacy', text: 'Perro', matchable: false },
    ]);
  });
});
