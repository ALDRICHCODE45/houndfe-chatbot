import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { BranchInfo } from '../../chatbot-api/domain/dtos/branch.dto';
import { UpstreamError } from '../../chatbot-api/domain/errors';
import {
  EVAL_BRANCH,
  EVAL_BRANCH_WITHOUT_LOCATION,
  EvalFakeApi,
} from '../../../scripts/eval/fixtures/fake-api';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import type { GenerateTextFn } from '../infrastructure/generate-text.provider';
import { CostGuardService } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * T2 H2/H5 (S1-S3): «¿dónde están?», «¿a qué hora abren?» → the model calls
 * getStoreInfo; the application answers with the backend branch (the shared
 * store block: bold name, address, «*Horario:*»; null parts left out) and
 * attaches the store pin when the branch has coordinates. Unavailable (both
 * parts null, backend error or drift) → the tool says so and the model's own
 * reply stands; the application never writes an address or hours it did
 * not read.
 */
const SENDER = '5215550001111';
const MODEL_TEXT = 'Por ahora no puedo confirmarlo.';
const ADDRESS =
  'Av. Insurgentes Sur 1000, Del Valle, Benito Juárez, Ciudad de México, 03100';
const HOURS = 'Lunes a sábado: 09:00–19:00. Domingo: 10:00–14:00.';
const NAME = 'Tienda de mascotas HoundFe — Sucursal Centro';
const STORE_USTED = `Nos encuentra en *${NAME}*\n${ADDRESS}\n*Horario:* ${HOURS}`;
const STORE_TU = `Nos encuentras en *${NAME}*\n${ADDRESS}\n*Horario:* ${HOURS}`;
const PIN = {
  latitude: 19.3907,
  longitude: -99.1716,
  name: NAME,
  address: ADDRESS,
};

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
const say = (text = MODEL_TEXT) => step([{ type: 'text', text }], 'stop');

function world(
  options: {
    branch?: BranchInfo | Error;
    /** A client without getBranch (hand-built fakes, older wiring). */
    noBranchRead?: true;
  } = {},
) {
  const api = new EvalFakeApi({ kind: 'new' });
  const getBranch = jest.fn(() =>
    options.branch instanceof Error
      ? Promise.reject(options.branch)
      : Promise.resolve(structuredClone(options.branch ?? EVAL_BRANCH)),
  );
  if (options.noBranchRead === true)
    (api as Partial<EvalFakeApi>).getBranch = undefined;
  else api.getBranch = getBranch;
  const config = {
    get: (key: string) =>
      key === 'chatbotApi.cashierUserId'
        ? ''
        : { model: 'm', maxSteps: 8, historyTurns: 12 },
  } as unknown as ConfigService;
  const outputs: Array<{ toolName: string; output: unknown }> = [];
  const systems: string[] = [];
  const toolNames: string[][] = [];
  let scripts: unknown[][] = [];
  const generate: GenerateTextFn = async (input) => {
    systems.push(input.system as string);
    toolNames.push(Object.keys(input.tools ?? {}));
    const result = await generateText({
      ...input,
      model: new MockLanguageModelV4({
        doGenerate: scripts.shift() ?? [say()],
      } as never),
    });
    for (const s of result.steps)
      for (const r of s.toolResults)
        outputs.push({ toolName: r.toolName, output: r.output });
    return result;
  };
  const agent = new MinimalCatalogAgentService(
    api,
    generate,
    new CostGuardService(100000),
    config,
    new InMemoryMinimalCatalogSessionStore(),
  );
  const turn = (text: string, runs: unknown[][]) => {
    scripts = runs;
    return agent.tryHandle({ senderId: SENDER, text });
  };
  const storeOutputs = () =>
    outputs.filter((o) => o.toolName === 'getStoreInfo').map((o) => o.output);
  return { turn, getBranch, systems, toolNames, storeOutputs };
}

/** A fresh script each time (a turn consumes its script). */
const asksStore = () => [
  [call('getStoreInfo'), say('Estamos en Av. Inventada 1.')],
];

describe('T2: store location and hours (getStoreInfo)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('H5: the tool and one instruction are offered when the branch read exists', async () => {
    const w = world();
    await w.turn('Hola', [[say('Hola')]]);
    expect(w.toolNames[0]).toContain('getStoreInfo');
    expect(w.systems[0]).toContain('Herramienta getStoreInfo');
    expect(w.systems[0]).toMatch(/nunca escriba una dirección ni un horario/i);
  });

  it('H5: no tool and no instruction without a branch read', async () => {
    const w = world({ noBranchRead: true });
    await w.turn('Hola', [[say('Hola')]]);
    expect(w.toolNames[0]).not.toContain('getStoreInfo');
    expect(w.systems[0]).not.toContain('getStoreInfo');
  });

  it('H2/H3: usted — the application answers with the store block and attaches the pin', async () => {
    const w = world();
    const decision = await w.turn(
      '¿Dónde están y a qué hora abren?',
      asksStore(),
    );
    expect(decision.reply).toBe(STORE_USTED);
    expect(decision.location).toEqual(PIN);
    expect(w.storeOutputs()).toEqual([
      { ok: true, presentedByApplication: true },
    ]);
    // The model's own text (an invented address) is never sent.
    expect(decision.reply).not.toContain('Inventada');
  });

  it('H2: tú form for a customer who tutea', async () => {
    const decision = await world().turn(
      'oye, ¿dónde quedan? ¿abres el domingo?',
      asksStore(),
    );
    expect(decision.reply).toBe(STORE_TU);
  });

  it('H2: hours null → address only (no «Horario» line)', async () => {
    const decision = await world({
      branch: { ...EVAL_BRANCH, hours: null },
    }).turn('¿Dónde están?', asksStore());
    expect(decision.reply).toBe(`Nos encuentra en *${NAME}*\n${ADDRESS}`);
    expect(decision.reply).not.toContain('Horario');
  });

  it('H2: address null → name and hours (the pin without an address label)', async () => {
    const decision = await world({
      branch: { ...EVAL_BRANCH, address: null },
    }).turn('¿A qué hora abren?', asksStore());
    expect(decision.reply).toBe(
      `Nos encuentra en *${NAME}*\n*Horario:* ${HOURS}`,
    );
    expect(decision.location).toEqual({
      latitude: PIN.latitude,
      longitude: PIN.longitude,
      name: NAME,
    });
  });

  it('H4/H3: no coordinates → the same text and no pin', async () => {
    const decision = await world({
      branch: EVAL_BRANCH_WITHOUT_LOCATION,
    }).turn('¿Dónde están y a qué hora abren?', asksStore());
    expect(decision.reply).toBe(STORE_USTED);
    expect(decision).not.toHaveProperty('location');
  });

  it.each([
    [
      'address and hours both null',
      { ...EVAL_BRANCH, address: null, hours: null },
    ],
    ['a 5xx / drift (UpstreamError)', new UpstreamError('invalid', 502)],
    ['a network failure', new Error('ECONNRESET')],
  ])(
    'H2: %s → unavailable; the model reply stands and nothing is invented',
    async (_name, branch) => {
      const w = world({ branch });
      const decision = await w.turn('¿Dónde están?', [
        [call('getStoreInfo'), say(MODEL_TEXT)],
      ]);
      expect(w.storeOutputs()).toEqual([
        { ok: false, error: 'store_info_unavailable' },
      ]);
      expect(decision.reply).toBe(MODEL_TEXT);
      expect(decision).not.toHaveProperty('location');
      expect(decision.reply).not.toContain(NAME);
    },
  );

  it('H2: once per turn — a second call is refused and the backend is read once', async () => {
    const w = world();
    const decision = await w.turn('¿Dónde están?', [
      [call('getStoreInfo'), call('getStoreInfo'), say()],
    ]);
    expect(w.storeOutputs()).toEqual([
      { ok: true, presentedByApplication: true },
      { ok: false, error: 'store_info_settled' },
    ]);
    expect(w.getBranch).toHaveBeenCalledTimes(1);
    expect(decision.reply).toBe(STORE_USTED);
  });

  it('a turn that never asks keeps the model reply and carries no pin', async () => {
    const decision = await world().turn('Hola', [[say('¡Hola!')]]);
    expect(decision.reply).toBe('¡Hola!');
    expect(decision).not.toHaveProperty('location');
  });
});
