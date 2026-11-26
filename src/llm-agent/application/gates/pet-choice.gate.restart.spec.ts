import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import {
  DurablePetChoice,
  isOtherPetAnswer,
  MINIMAL_PET_CHOICE_TTL_MS,
  matchPetChoiceAnswer,
  PET_CHOICE_OPTIONS_MAX,
  type PetChoice,
} from './pet-choice.gate';

const SENDER = '5215550001111';
const T0 = Date.parse('2026-11-25T12:00:00.000Z');
const MAX = 'backend:a0000000-0000-4000-8000-000000000050';
const BRUNO = 'backend:8d0e0f6e-5b87-4c2c-8d3a-1f6f0c7a9b11';
const CHOICE: PetChoice = {
  purpose: 'request',
  options: [
    { ref: MAX, text: 'Max' },
    { ref: BRUNO, text: 'Bruno' },
  ],
  request: 'busco croquetas',
};

function world() {
  let now = T0;
  const clock = () => now;
  const store = new InMemoryConversationGateStore(() => new Date(now));
  const boot = () => {
    const gates = new ConversationGates(store, clock);
    return { gates, choices: new DurablePetChoice(gates) };
  };
  return {
    store,
    boot,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('pet choice gate survives a restart (T4c-2a P1, S13)', () => {
  it('restores the options and the original request in a new process', async () => {
    const w = world();
    const first = w.boot();
    first.choices.ask(SENDER, CHOICE);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    expect(restarted.choices.read(SENDER)).toBeNull();
    await restarted.gates.begin(SENDER);
    expect(restarted.choices.read(SENDER)).toEqual(CHOICE);
  });

  it('is stored for fifteen minutes and absent after that', async () => {
    const w = world();
    const first = w.boot();
    first.choices.ask(SENDER, CHOICE);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    await expect(w.store.get(SENDER, 'pet_choice')).resolves.toMatchObject({
      payload: CHOICE,
      expiresAt: new Date(T0 + MINIMAL_PET_CHOICE_TTL_MS),
    });
    expect(MINIMAL_PET_CHOICE_TTL_MS).toBe(15 * 60 * 1000);
    w.advance(MINIMAL_PET_CHOICE_TTL_MS - 1);
    expect(first.choices.read(SENDER)).toEqual(CHOICE);
    w.advance(1);
    expect(first.choices.read(SENDER)).toBeNull();
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.choices.read(SENDER)).toBeNull();
  });

  it('clearing deletes the durable row', async () => {
    const w = world();
    const first = w.boot();
    first.choices.ask(SENDER, CHOICE);
    first.gates.touch(SENDER);
    first.choices.clear(SENDER);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    await expect(w.store.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });

  it.each([
    { ...CHOICE, purpose: 'forget' },
    { ...CHOICE, options: [] },
    { ...CHOICE, request: '' },
    { ...CHOICE, extra: true },
    { ...CHOICE, options: [{ ref: MAX }] },
    { purpose: 'request', options: CHOICE.options },
    {},
  ])('treats the malformed payload %j as absent and removes it', async (p) => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: p,
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.choices.read(SENDER)).toBeNull();
    await expect(w.store.get(SENDER, 'pet_choice')).resolves.toBeNull();
  });
});

describe('typed answer to the which-pet question (T4c-2a P3)', () => {
  const options = [
    ...CHOICE.options,
    { ref: 'local:x1', text: 'Señor Bigotes' },
    { ref: 'other', text: 'Otra mascota' },
  ];
  it.each([
    ['Max', MAX],
    ['para Max', MAX],
    ['¡Es para max!', MAX],
    ['para el Max 🐶', MAX],
    ['senor bigotes', 'local:x1'],
    ['Para mi Señor Bigotes.', 'local:x1'],
  ])('%j answers with %s', (text, ref) => {
    expect(matchPetChoiceAnswer(text, options, 'other')?.ref).toBe(ref);
  });

  it.each([
    'Max quiere croquetas de pollo',
    'para los dos',
    'Otra mascota',
    'hola',
    '',
  ])('%j is not an answer', (text) => {
    expect(matchPetChoiceAnswer(text, options, 'other')).toBeNull();
  });

  it('two offered pets with the same name → no answer (a tap is needed)', () => {
    expect(
      matchPetChoiceAnswer(
        'Max',
        [...options, { ref: 'local:x2', text: 'MAX' }],
        'other',
      ),
    ).toBeNull();
  });
});

describe('pet choice options (T4c-2a-fix J4)', () => {
  it('a row written by 5ab9410 (options without `matchable`) still loads and answers', async () => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: {
        purpose: 'request',
        options: [
          { ref: MAX, text: 'Max' },
          { ref: BRUNO, text: 'Bruno' },
        ],
        request: 'busco croquetas',
      },
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    const live = restarted.choices.read(SENDER);
    expect(live).toEqual(CHOICE);
    expect(matchPetChoiceAnswer('Max', live!.options, 'other')?.ref).toBe(MAX);
  });

  it('a nameless option keeps its display text across a restart but never matches a typed answer', async () => {
    const w = world();
    const first = w.boot();
    const choice: PetChoice = {
      ...CHOICE,
      options: [
        ...CHOICE.options,
        { ref: 'local:siames', text: 'Siamés', matchable: false },
      ],
    };
    first.choices.ask(SENDER, choice);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    const live = restarted.choices.read(SENDER);
    expect(live).toEqual(choice);
    expect(matchPetChoiceAnswer('siames', live!.options, 'other')).toBeNull();
    expect(
      matchPetChoiceAnswer('para el siamés', live!.options, 'other'),
    ).toBeNull();
  });

  it('the options cap is the exported PET_CHOICE_OPTIONS_MAX', async () => {
    expect(PET_CHOICE_OPTIONS_MAX).toBe(50);
    const w = world();
    const options = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ref: `local:p${i}`,
        text: `P${i}`,
      }));
    for (const [n, kept] of [
      [PET_CHOICE_OPTIONS_MAX, true],
      [PET_CHOICE_OPTIONS_MAX + 1, false],
    ] as const) {
      await w.store.put({
        senderId: SENDER,
        kind: 'pet_choice',
        payload: { purpose: 'request', options: options(n), request: 'x' },
        expiresAt: new Date(T0 + 60_000),
      });
      const restarted = w.boot();
      await restarted.gates.begin(SENDER);
      expect(restarted.choices.read(SENDER) !== null).toBe(kept);
    }
  });
});

describe('pet choice purposes (T4c-2b Q1-Q3)', () => {
  const FORGET: PetChoice = {
    purpose: 'forget',
    options: [
      { ref: BRUNO, text: 'Bruno' },
      { ref: 'local:b2', text: 'Bruno' },
    ],
    name: 'Bruno',
    reason: 'falleció',
  };
  const AMBIGUOUS: PetChoice = {
    purpose: 'ambiguous',
    options: [
      { ref: BRUNO, text: 'Bruno' },
      { ref: 'backend:b0000000-0000-4000-8000-000000000060', text: 'Bruno' },
      { ref: 'other', text: 'Es otra mascota' },
    ],
    localId: 'b1f0c7a2-0000-4000-8000-000000000001',
    request: 'croquetas para Bruno',
  };
  const DIMINUTIVE: PetChoice = {
    purpose: 'diminutive',
    options: [
      { ref: 'forgotten', text: 'Bruno' },
      { ref: 'other', text: 'Es otra mascota' },
    ],
    name: 'Brunito',
    facts: { name: 'Brunito', species: 'perro', ageText: '3 años' },
  };

  it.each([
    ['forget', FORGET],
    ['ambiguous', AMBIGUOUS],
    ['diminutive', DIMINUTIVE],
    ['forget without a reason', { ...FORGET, reason: undefined }],
  ])(
    'a %s question survives a restart with its own data',
    async (_label, choice) => {
      const w = world();
      const first = w.boot();
      const clean = JSON.parse(JSON.stringify(choice)) as PetChoice;
      first.choices.ask(SENDER, clean);
      first.gates.touch(SENDER);
      await first.gates.settle(SENDER);
      await expect(w.store.get(SENDER, 'pet_choice')).resolves.toMatchObject({
        payload: clean,
      });
      const restarted = w.boot();
      await restarted.gates.begin(SENDER);
      expect(restarted.choices.read(SENDER)).toEqual(clean);
    },
  );

  it.each([
    { ...FORGET, name: '' },
    { ...FORGET, request: 'x' },
    { ...AMBIGUOUS, localId: '' },
    { ...AMBIGUOUS, request: undefined },
    { ...DIMINUTIVE, facts: { name: 'Brunito', extra: 'x' } },
    { ...DIMINUTIVE, facts: undefined },
    // T4c-2b-fix K4: a diminutive row may keep the message, never empty.
    { ...DIMINUTIVE, request: '' },
  ])('treats the malformed purpose payload %j as absent', async (p) => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: JSON.parse(JSON.stringify(p)) as Record<string, unknown>,
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.choices.read(SENDER)).toBeNull();
  });
});

describe('typed «es otra» (T4c-2b-fix K2)', () => {
  it.each([
    'es otra',
    'otra',
    'Otra.',
    'es otra mascota',
    'Otra mascota',
    'ninguno',
    'Ninguna',
    'ninguna de esas',
    'ninguno de esos',
    'no, es otro',
    'No es otra',
    '¡Es otra!',
  ])('%j is an «other» answer', (text) => {
    expect(isOtherPetAnswer(text)).toBe(true);
  });

  it.each([
    'no',
    'es Bruno',
    'otra cosa, quiero croquetas',
    'quiero otra bolsa',
    'otra vez',
    '',
  ])('%j is not', (text) => {
    expect(isOtherPetAnswer(text)).toBe(false);
  });

  it('a diminutive row with the customer message round-trips; one without it still loads', async () => {
    const w = world();
    const first = w.boot();
    const withRequest: PetChoice = {
      purpose: 'diminutive',
      options: [
        { ref: BRUNO, text: 'Bruno' },
        { ref: 'other', text: 'Es otra mascota' },
      ],
      name: 'Brunito',
      facts: { name: 'Brunito', ageText: '3 años' },
      request: 'mi perrito Brunito tiene 3 años, ¿qué croquetas le doy?',
    };
    first.choices.ask(SENDER, withRequest);
    first.gates.touch(SENDER);
    await first.gates.settle(SENDER);
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.choices.read(SENDER)).toEqual(withRequest);
    const { request: _dropped, ...legacy } = withRequest;
    void _dropped;
    await w.store.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: legacy,
      expiresAt: new Date(T0 + 60_000),
    });
    const again = w.boot();
    await again.gates.begin(SENDER);
    expect(again.choices.read(SENDER)).toEqual(legacy);
  });
});

describe('a pet_choice row from an older build (T6b)', () => {
  it('T6b: a row an older build stored with the `legacy` ref loads; that option is no longer offered (the durable row is untouched)', async () => {
    const w = world();
    const payload = {
      purpose: 'request',
      options: [
        { ref: 'legacy', text: 'Luna' },
        { ref: MAX, text: 'Max' },
      ],
      request: 'busco croquetas',
    };
    await w.store.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload,
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    const live = restarted.choices.read(SENDER);
    expect(live).toEqual({
      purpose: 'request',
      options: [{ ref: MAX, text: 'Max' }],
      request: 'busco croquetas',
    });
    expect(matchPetChoiceAnswer('Luna', live!.options, 'other')).toBeNull();
    restarted.gates.touch(SENDER);
    await restarted.gates.settle(SENDER);
    await expect(w.store.get(SENDER, 'pet_choice')).resolves.toMatchObject({
      payload,
    });
  });

  it('T6b: a row whose only option is `legacy` loads with no option offered', async () => {
    const w = world();
    await w.store.put({
      senderId: SENDER,
      kind: 'pet_choice',
      payload: {
        purpose: 'forget',
        options: [{ ref: 'legacy', text: 'Luna' }],
        name: 'Luna',
      },
      expiresAt: new Date(T0 + 60_000),
    });
    const restarted = w.boot();
    await restarted.gates.begin(SENDER);
    expect(restarted.choices.read(SENDER)).toEqual({
      purpose: 'forget',
      options: [],
      name: 'Luna',
    });
  });
});
