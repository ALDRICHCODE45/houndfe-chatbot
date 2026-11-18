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

const BACKOFF_MS = 15 * 60_000;
const movingClock = () => {
  let at = NOW.getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
};

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

  describe('R1-001 product photo admission', () => {
    it('counts the photo turn once: the admitted agent turn does not admit again', async () => {
      const store = new InMemoryLlmSpendStore();
      const admit = jest.spyOn(store, 'admitTurn');
      const { service, captured } = build({ guard: guardWith(store) });
      await expect(
        service.admitPhotoTurn({ senderId: SENDER, text: '' }),
      ).resolves.toBeNull();
      await service.tryHandle({
        senderId: SENDER,
        text: '¿Tienen este producto?\n[Imagen enviada]',
        llmAdmitted: true,
      });
      expect(admit).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
    });

    it('a limited sender gets the first notice, then silence, without any LLM call', async () => {
      const store = new InMemoryLlmSpendStore();
      const { service, captured, team } = build({ guard: guardWith(store) });
      await say1(service, 'uno');
      await say1(service, 'dos');
      await expect(
        service.admitPhotoTurn({ senderId: SENDER, text: '¿hay?' }),
      ).resolves.toEqual({ kind: 'handled', reply: SENDER_LIMIT_REPLY });
      await expect(
        service.admitPhotoTurn({ senderId: SENDER, text: '' }),
      ).resolves.toEqual({ kind: 'handled', reply: '', silent: true });
      expect(team.askTeam).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
    });
  });

  describe('S2/S5 notice released when the team request fails (R4)', () => {
    it.each([
      ['throws', () => Promise.reject(new Error('db down'))],
      [
        'returns failed',
        () => Promise.resolve({ kind: 'failed', reason: 'insert_failed' }),
      ],
    ])(
      'sender limit: askTeam %s → the notice and the request are retried after the 15-minute backoff (S4)',
      async (_label, failure) => {
        const store = new InMemoryLlmSpendStore();
        const clock = movingClock();
        const { service, captured, team } = build({
          guard: guardWith(store, { clock: clock.now }),
        });
        await say1(service, 'uno');
        await say1(service, 'dos');
        team.askTeam.mockImplementationOnce(failure as never);
        await expect(say1(service, 'tres')).resolves.toEqual({
          kind: 'handled',
          reply: SENDER_LIMIT_REPLY,
        });
        clock.advance(BACKOFF_MS);
        // Not silenced for good: the notice was released, so it is retried.
        await expect(say1(service, 'cuatro')).resolves.toEqual({
          kind: 'handled',
          reply: SENDER_LIMIT_REPLY,
        });
        expect(team.askTeam).toHaveBeenCalledTimes(2);
        // Once a request is created, later refusals are silent.
        await expect(say1(service, 'cinco')).resolves.toMatchObject({
          silent: true,
        });
        expect(team.askTeam).toHaveBeenCalledTimes(2);
        expect(captured).toHaveLength(2);
      },
    );

    it('budget: a failed request is retried after the backoff, then once per period', async () => {
      const store = new InMemoryLlmSpendStore();
      await spend(store, 1);
      const clock = movingClock();
      const { service, team } = build({
        guard: guardWith(store, { clock: clock.now }),
      });
      team.askTeam.mockRejectedValueOnce(new Error('db down'));
      await say1(service, 'busco croquetas');
      clock.advance(BACKOFF_MS);
      await say1(service, 'y para gato?');
      await say1(service, 'hola?');
      clock.advance(BACKOFF_MS);
      await say1(service, '¿sigue?');
      expect(team.askTeam).toHaveBeenCalledTimes(2);
    });

    describe('follow-ups S4: notice retry backoff', () => {
      const failing = (team: { askTeam: jest.Mock }) =>
        team.askTeam.mockRejectedValue(new Error('db down'));

      it('sender limit: a request that keeps failing costs one notice + one request per 15 minutes; silence in between', async () => {
        const clock = movingClock();
        const { service, captured, team } = build({
          guard: guardWith(new InMemoryLlmSpendStore(), { clock: clock.now }),
        });
        await say1(service, 'uno');
        await say1(service, 'dos');
        failing(team);
        await expect(say1(service, 'tres')).resolves.toEqual({
          kind: 'handled',
          reply: SENDER_LIMIT_REPLY,
        });
        const silent = { kind: 'handled', reply: '', silent: true };
        await expect(say1(service, 'cuatro')).resolves.toEqual(silent);
        clock.advance(BACKOFF_MS - 1);
        await expect(say1(service, 'cinco')).resolves.toEqual(silent);
        expect(team.askTeam).toHaveBeenCalledTimes(1);
        clock.advance(1);
        await expect(say1(service, 'seis')).resolves.toEqual({
          kind: 'handled',
          reply: SENDER_LIMIT_REPLY,
        });
        await expect(say1(service, 'siete')).resolves.toEqual(silent);
        expect(team.askTeam).toHaveBeenCalledTimes(2);
        // The request finally goes through: later refusals stay silent.
        team.askTeam.mockResolvedValue({ kind: 'registered', requestId: 'r' });
        clock.advance(BACKOFF_MS);
        await expect(say1(service, 'ocho')).resolves.toEqual({
          kind: 'handled',
          reply: SENDER_LIMIT_REPLY,
        });
        clock.advance(BACKOFF_MS);
        await expect(say1(service, 'nueve')).resolves.toEqual(silent);
        expect(team.askTeam).toHaveBeenCalledTimes(3);
        expect(captured).toHaveLength(2);
      });

      it('budget: within the backoff the fixed reply goes out without a new request', async () => {
        const store = new InMemoryLlmSpendStore();
        await spend(store, 1);
        const clock = movingClock();
        const { service, captured, team } = build({
          guard: guardWith(store, { clock: clock.now }),
        });
        failing(team);
        for (const text of ['a', 'b', 'c'])
          await expect(say1(service, text)).resolves.toEqual({
            kind: 'handled',
            reply: LLM_BUDGET_EXHAUSTED_REPLY,
          });
        expect(team.askTeam).toHaveBeenCalledTimes(1);
        clock.advance(BACKOFF_MS);
        await say1(service, 'd');
        await say1(service, 'e');
        expect(team.askTeam).toHaveBeenCalledTimes(2);
        expect(captured).toHaveLength(0);
      });

      it('the backoff is per sender: another number still gets its own first notice and request', async () => {
        const store = new InMemoryLlmSpendStore();
        await spend(store, 1);
        const { service, team } = build({ guard: guardWith(store) });
        failing(team);
        await say1(service, 'a');
        await service.tryHandle({ senderId: `${SENDER}9`, text: 'hola' });
        expect(team.askTeam).toHaveBeenCalledTimes(2);
      });
    });

    it('logs the failure without the phone number or the text', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const store = new InMemoryLlmSpendStore();
      await spend(store, 1);
      const { service, team } = build({ guard: guardWith(store) });
      team.askTeam.mockRejectedValueOnce(new Error(`boom ${SENDER}`));
      await say1(service, 'busco croquetas secretas');
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toMatch(/team request failed/);
      expect(logged).not.toMatch(new RegExp(SENDER));
      expect(logged).not.toMatch(/secretas/);
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
