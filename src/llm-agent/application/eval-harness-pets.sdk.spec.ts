import { Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { checkTurnEvidence } from '../../../scripts/eval/checks';
import { EVAL_CUSTOMER_ID } from '../../../scripts/eval/fixtures/fake-api';
import { EVAL_PET_MAX } from '../../../scripts/eval/fixtures/fake-pets-client';
import {
  EVAL_SENDER,
  buildEvalHarness,
  createEvalWorld,
  describeInteractive,
  settleBackground,
} from '../../../scripts/eval/harness';
import { SCENARIOS, type ScenarioTurn } from '../../../scripts/eval/scenarios';
import { MinimalCartSelections } from '../domain/minimal-cart-selections';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';

/**
 * Multi-pet T7: the conversation eval's agent, built exactly as
 * scripts/eval/conversation-eval.ts builds it (harness + world), wired to the
 * pet store, with a scripted model (no network). Each scenario's
 * deterministic pet checks pass when the model takes the expected step.
 */
const step = (content: unknown[], finish = 'tool-calls') => ({
  content,
  finishReason: { unified: finish, raw: undefined },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  warnings: [],
});
const call = (toolName: string, input: unknown = {}) =>
  step([
    {
      type: 'tool-call',
      toolCallId: `${toolName}-${Math.random()}`,
      toolName,
      input: JSON.stringify(input),
    },
  ]);
const say = (text = 'Texto del modelo.') =>
  step([{ type: 'text', text }], 'stop');

/** Catalog fixture product 1: Nupec salmón y camote 18 kg. */
const NUPEC = 'a0000000-0000-4000-8000-000000000001';
const nupecRef = (): string => {
  const reference = new MinimalCartSelections(EVAL_SENDER).register({
    productId: NUPEC,
    productName: 'Fixture',
  });
  if (reference === null) throw new Error('fixture ref');
  return reference;
};

interface PlayedTurn {
  turn: ScenarioTurn;
  reply: string;
  interactive: string | null;
  backend: string[];
}

/**
 * Plays a scenario's turns (restarts included) through the eval harness;
 * `runs[i]` are the model steps of turn i (one array per generateText call).
 */
async function play(
  id: string,
  runs: unknown[][][],
): Promise<{
  played: PlayedTurn[];
  inputs: string[];
  world: ReturnType<typeof createEvalWorld>;
}> {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`scenario ${id}`);
  const world = createEvalWorld(scenario.customer);
  let scripts: unknown[][] = [];
  const inputs: string[] = [];
  const generate: GenerateTextFn = async (input) => {
    inputs.push(JSON.stringify([input.system, input.messages]));
    const script = scripts.shift() ?? [say()];
    return generateText({
      ...input,
      model: new MockLanguageModelV4({ doGenerate: script } as never),
    });
  };
  const llm = { model: 'scripted', maxSteps: 6, historyTurns: 12 };
  let { agent } = buildEvalHarness(world, generate, llm);
  const played: PlayedTurn[] = [];
  for (const [index, raw] of scenario.turns.entries()) {
    const turn: ScenarioTurn = typeof raw === 'string' ? { text: raw } : raw;
    if (turn.restartBefore === true)
      ({ agent } = buildEvalHarness(world, generate, llm));
    scripts = runs[index] ?? [[say()]];
    const decision = await agent.tryHandle({
      senderId: EVAL_SENDER,
      text: turn.text,
      inboundEvent: {
        receivingPhoneNumberId: '123456789012345',
        senderId: EVAL_SENDER,
        messageId: `wamid.spec.${id}.${index}`,
      },
    });
    decision.onSent?.();
    await settleBackground();
    played.push({
      turn,
      reply: decision.reply,
      interactive: describeInteractive(decision.interactive),
      backend: world.api.drainEvents(),
    });
  }
  return { played, inputs, world };
}

/** Every T7 expectation of every turn holds. */
function expectEvidence(played: PlayedTurn[]): void {
  for (const entry of played) {
    const failed = checkTurnEvidence(entry, entry.turn).filter(
      (result) => result.severity !== 'pass',
    );
    expect({ turn: entry.turn.text, failed, backend: entry.backend }).toEqual({
      turn: entry.turn.text,
      failed: [],
      backend: entry.backend,
    });
  }
}

describe('eval harness wired to the pet store (T7)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('pets-which-pet: «¿Para quién es?» with buttons, «para Max» continues, the line says «(para Max)»', async () => {
    const { played } = await play('pets-which-pet', [
      [[call('askWhichPet'), say('¿Para cuál?')]],
      [[call('searchCatalog', { q: 'croquetas perro adulto' }), say('Aquí.')]],
      [
        [
          call('searchCatalog', { q: 'salmón camote 18 kg' }),
          call('setCartItem', {
            selectionRef: nupecRef(),
            quantity: 1,
            quantityText: 'una',
            continuation: false,
          }),
          say(),
        ],
      ],
    ]);
    expect(played[0].reply).toBe('¿Para quién es?');
    expect(played[0].interactive).toMatch(
      /^🔘 Botones: \[Bruno.*\] \[Max.*\]$/,
    );
    expect(played[2].reply).toContain('(para Max)');
    expectEvidence(played);
  });

  it('pets-allergy-forget: the allergy PATCHes Max, «Bruno ya no está» archives Bruno', async () => {
    const { played } = await play('pets-allergy-forget', [
      [[say('Anotado.')]],
      [
        [
          call('forgetPet', { name: 'Bruno', reason: 'falleció' }),
          say('Lo siento mucho.'),
        ],
      ],
    ]);
    expectEvidence(played);
  });

  it('pets-reorder: «lo mismo de siempre para Max» reads the history with ?petId', async () => {
    const { played } = await play('pets-reorder', [
      [[call('getLastOrder', { petName: 'Max' }), say('Aquí está.')]],
    ]);
    expect(played[0].backend.join('\n')).toContain(`petId=${EVAL_PET_MAX.id}`);
    expectEvidence(played);
  });

  it('returning-customer: Luna is created in the backend and known after a restart', async () => {
    const { played, inputs, world } = await play('returning-customer', []);
    expectEvidence(played);
    expect(played[1].backend.join('\n')).toMatch(/createPet\(name "Luna"/);
    // The restarted bot reads Luna from the backend (by-phone pets).
    const afterRestart = inputs.slice(-2).join('\n');
    expect(afterRestart).toContain('Luna');
    expect(world.pets.all(EVAL_CUSTOMER_ID)).toEqual([
      expect.objectContaining({
        name: 'Luna',
        species: 'DOG',
        createdVia: 'CHATBOT',
        status: 'ACTIVE',
      }),
    ]);
  });
});
