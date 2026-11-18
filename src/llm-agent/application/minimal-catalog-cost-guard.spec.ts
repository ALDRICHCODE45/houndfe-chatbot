import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { HumanRequestCreateService } from '../../human-requests/application/human-request-create.service';
import { CLOSING_REPLY } from '../domain/closing-message';
import {
  LLM_BUDGET_EXHAUSTED_REPLY,
  SENDER_LIMIT_REPLY,
} from '../domain/llm-spend';
import { InMemoryLlmSpendStore } from '../infrastructure/in-memory-llm-spend.store';
import { InMemoryMinimalCatalogSessionStore } from '../infrastructure/in-memory-minimal-catalog-session.store';
import { CostGuardService, type CostGuardOptions } from './cost-guard.service';
import { MinimalCatalogAgentService } from './minimal-catalog-agent.service';

/**
 * Cost protection phase 1 on the customer route (odd/tasks/
 * cost-and-abuse-phase1.md): S2 budget stop, S3 output cap, S4 inbound text
 * cap, S5 per-number limit, S6 closings without the LLM.
 */
const SENDER = '5215550001111';
const NOW = new Date('2026-11-18T18:00:00.000Z');
const usage = {
  inputTokens: { total: 1000 },
  outputTokens: { total: 100 },
} as never;
const say = (text: string) => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage,
  warnings: [],
});

type Captured = {
  maxOutputTokens?: number;
  messages?: Array<{ role: string; content: unknown }>;
};

function build(
  options: {
    guard?: CostGuardService;
    llm?: Record<string, unknown>;
    replies?: string[];
  } = {},
) {
  const replies = options.replies ?? ['Con gusto le ayudo.'];
  let index = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve(say(replies[Math.min(index++, replies.length - 1)])),
  } as never);
  const chatbotApi = {
    searchCatalog: jest.fn().mockResolvedValue([]),
    getStock: jest.fn(),
  } as unknown as jest.Mocked<ChatbotApiClient>;
  const config = {
    get: () => ({
      model: 'm',
      maxSteps: 4,
      historyTurns: 12,
      ...options.llm,
    }),
  } as unknown as ConfigService;
  const captured: Captured[] = [];
  const generate = async (params: unknown) => {
    captured.push(params as Captured);
    return generateText({ ...(params as object), model } as never);
  };
  const team = {
    askTeam: jest
      .fn()
      .mockResolvedValue({ kind: 'registered', requestId: 'r1' }),
  } satisfies Pick<HumanRequestCreateService, 'askTeam'>;
  const guard = options.guard ?? new CostGuardService();
  const service = new MinimalCatalogAgentService(
    chatbotApi,
    generate as never,
    guard,
    config,
    new InMemoryMinimalCatalogSessionStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    team,
  );
  return { service, captured, team, guard };
}

const guardWith = (
  store: InMemoryLlmSpendStore,
  over: Partial<CostGuardOptions> = {},
) =>
  new CostGuardService({
    store,
    clock: () => NOW,
    dailyBudgetUsd: 1,
    monthlyBudgetUsd: 200,
    senderLimitPerHour: 2,
    senderLimitPerDay: 10,
    ...over,
  });

const spend = async (store: InMemoryLlmSpendStore, usd: number) =>
  store.record({
    source: 'agent_turn',
    inputTokens: 1,
    outputTokens: 1,
    usd,
    at: NOW,
    periods: { day: '2026-11-18', month: '2026-11' },
    caps: { dayUsd: 1, monthUsd: 200 },
  });

const say1 = (service: MinimalCatalogAgentService, text: string) =>
  service.tryHandle({
    senderId: SENDER,
    text,
    inboundAt: '2026-11-18T18:00:00.000Z',
  });

describe('MinimalCatalogAgentService cost protection (phase 1)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('S3 output cap', () => {
    it('caps every agent call at LLM_MAX_OUTPUT_TOKENS (default 600)', async () => {
      const { service, captured } = build();
      await say1(service, 'busco croquetas');
      expect(captured[0].maxOutputTokens).toBe(600);
    });

    it('uses the configured cap', async () => {
      const { service, captured } = build({ llm: { maxOutputTokens: 250 } });
      await say1(service, 'busco croquetas');
      expect(captured[0].maxOutputTokens).toBe(250);
    });
  });

  describe('S4 inbound text cap', () => {
    it('cuts customer text to INBOUND_TEXT_MAX_CHARS before the model sees it', async () => {
      const { service, captured } = build({ llm: { inboundTextMaxChars: 50 } });
      await say1(service, 'a'.repeat(5000));
      const last = captured[0].messages!.at(-1)!;
      expect(last).toEqual({ role: 'user', content: 'a'.repeat(50) });
    });

    it('defaults to 1000 characters', async () => {
      const { service, captured } = build();
      await say1(service, 'b'.repeat(1500));
      expect(captured[0].messages!.at(-1)!.content).toBe('b'.repeat(1000));
    });
  });

  describe('S2 budget spent', () => {
    it('starts no LLM call, answers the fixed copy and notifies the team once per period', async () => {
      const store = new InMemoryLlmSpendStore();
      await spend(store, 1);
      const { service, captured, team } = build({ guard: guardWith(store) });
      await expect(say1(service, 'busco croquetas')).resolves.toEqual({
        kind: 'handled',
        reply: LLM_BUDGET_EXHAUSTED_REPLY,
      });
      await expect(say1(service, 'y para gato?')).resolves.toEqual({
        kind: 'handled',
        reply: LLM_BUDGET_EXHAUSTED_REPLY,
      });
      expect(captured).toHaveLength(0);
      expect(team.askTeam).toHaveBeenCalledTimes(1);
      expect(team.askTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: SENDER,
          question: 'busco croquetas',
          summary: expect.stringMatching(/tope diario de gasto/) as unknown,
        }),
      );
    });

    it('books the usage of the calls it makes in the ledger', async () => {
      const store = new InMemoryLlmSpendStore();
      const guard = guardWith(store, {
        priceInputUsdPerMtok: 1000,
        priceOutputUsdPerMtok: 0,
      });
      const { service, captured } = build({ guard });
      // $1 of input on the first turn reaches the $1 daily cap.
      await say1(service, 'busco croquetas');
      await guard.flush();
      await expect(say1(service, 'y para gato?')).resolves.toMatchObject({
        reply: LLM_BUDGET_EXHAUSTED_REPLY,
      });
      expect(captured).toHaveLength(1);
    });
  });

  describe('S2/S3 restock classifier', () => {
    type Classifier = (question: string, reply: string) => Promise<unknown>;
    const classifierOf = (service: MinimalCatalogAgentService) =>
      (
        service as unknown as { buildRestockClassifier(): Classifier }
      ).buildRestockClassifier();

    it('is output-capped and booked under its own source', async () => {
      const store = new InMemoryLlmSpendStore();
      const guard = guardWith(store);
      const record = jest.spyOn(guard, 'record');
      const { service, captured } = build({
        guard,
        replies: ['{"result":"accept"}'],
      });
      await expect(classifierOf(service)('¿Le aviso?', 'sí')).resolves.toBe(
        'accept',
      );
      expect(captured).toHaveLength(1);
      expect(captured[0].maxOutputTokens).toBe(600);
      expect(record).toHaveBeenCalledWith(
        expect.any(Object),
        'restock_classifier',
      );
    });

    it('starts no call once the budget is spent (the gate fails closed)', async () => {
      const store = new InMemoryLlmSpendStore();
      await spend(store, 1);
      const { service, captured } = build({ guard: guardWith(store) });
      await expect(classifierOf(service)('¿Le aviso?', 'sí')).rejects.toThrow(
        /budget/,
      );
      expect(captured).toHaveLength(0);
    });
  });

  describe('S5 per-number limit', () => {
    it('answers the first refusal, notifies the team, then stays silent without the LLM', async () => {
      const { service, captured, team } = build({
        guard: guardWith(new InMemoryLlmSpendStore()),
      });
      await say1(service, 'uno');
      await say1(service, 'dos');
      expect(captured).toHaveLength(2);
      await expect(say1(service, 'tres')).resolves.toEqual({
        kind: 'handled',
        reply: SENDER_LIMIT_REPLY,
      });
      expect(team.askTeam).toHaveBeenCalledTimes(1);
      expect(team.askTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: expect.stringMatching(
            /superó el límite de mensajes/,
          ) as unknown,
        }),
      );
      await expect(say1(service, 'cuatro')).resolves.toEqual({
        kind: 'handled',
        reply: '',
        silent: true,
      });
      expect(captured).toHaveLength(2);
      expect(team.askTeam).toHaveBeenCalledTimes(1);
    });
  });

  describe('S6 closings without the LLM', () => {
    it('answers a closing with the fixed reply, then nothing after a closing', async () => {
      const { service, captured } = build({
        replies: ['Listo, su pedido va en camino.'],
      });
      await say1(service, 'mi pedido ya salió?');
      expect(captured).toHaveLength(1);
      await expect(say1(service, 'gracias 👍')).resolves.toEqual({
        kind: 'handled',
        reply: CLOSING_REPLY,
      });
      await expect(say1(service, 'ok')).resolves.toEqual({
        kind: 'handled',
        reply: '',
        silent: true,
      });
      expect(captured).toHaveLength(1);
    });

    it('is silent when the bot already said goodbye', async () => {
      const { service, captured } = build({
        replies: ['¡Gracias por su compra! Que tenga un excelente día.'],
      });
      await say1(service, 'ya pagué');
      await expect(say1(service, 'muchas gracias')).resolves.toEqual({
        kind: 'handled',
        reply: '',
        silent: true,
      });
      expect(captured).toHaveLength(1);
    });

    it("keeps today's meaning while the bot has a question pending", async () => {
      const { service, captured } = build({
        replies: [
          'Encontré las croquetas. ¿Se lo agrego al carrito?',
          'Listo.',
        ],
      });
      await say1(service, 'busco croquetas');
      await say1(service, 'ok');
      expect(captured).toHaveLength(2);
    });

    it('never counts a closing against the per-number limit', async () => {
      const store = new InMemoryLlmSpendStore();
      const admit = jest.spyOn(store, 'admitTurn');
      const { service } = build({ guard: guardWith(store) });
      await say1(service, 'gracias');
      expect(admit).not.toHaveBeenCalled();
    });

    it('sends chit-chat that is not a closing to the model', async () => {
      const { service, captured } = build();
      await say1(service, 'jajaja qué buena onda');
      expect(captured).toHaveLength(1);
    });
  });
});
