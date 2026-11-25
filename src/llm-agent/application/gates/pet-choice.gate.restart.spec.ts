import { ConversationGates } from '../../../conversation-gates/application/conversation-gates';
import { InMemoryConversationGateStore } from '../../../conversation-gates/infrastructure/in-memory-conversation-gate.store';
import {
  DurablePetChoice,
  MINIMAL_PET_CHOICE_TTL_MS,
  matchPetChoiceAnswer,
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
