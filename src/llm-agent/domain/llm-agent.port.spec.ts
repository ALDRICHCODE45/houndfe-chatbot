import {
  LLM_AGENT,
  type LlmAgentPort,
  type LlmRunInput,
  type LlmRunResult,
} from './llm-agent.port';

/**
 * Domain contract tests for the LLM agent port.
 *
 * These exercise the type-level invariants of the port — there is no
 * behaviour yet because the adapter is implemented in infrastructure/.
 * They serve as living documentation of the contract that the runner
 * and adapter must agree on.
 */
describe('LLM agent port', () => {
  // ─── Scenario: Application consumes the port symbol only ───────────
  describe('LLM_AGENT symbol', () => {
    it('is a unique Symbol usable as a NestJS DI token', () => {
      expect(typeof LLM_AGENT).toBe('symbol');
      // Distinct from other tokens in the codebase (sanity check).
      expect(LLM_AGENT).not.toBe(Symbol('LLM_AGENT'));
    });
  });

  // ─── Scenario: Adapter returns usage + forwards stopWhen ───────────
  describe('LlmRunResult usage contract', () => {
    it('requires promptTokens and completionTokens (no undefined)', () => {
      const result: LlmRunResult = {
        reply: 'Hola',
        messages: [{ role: 'assistant', content: 'Hola' }],
        usage: { promptTokens: 10, completionTokens: 5 },
      };

      expect(result.usage.promptTokens).toBe(10);
      expect(result.usage.completionTokens).toBe(5);
      expect(Number.isFinite(result.usage.promptTokens)).toBe(true);
      expect(Number.isFinite(result.usage.completionTokens)).toBe(true);
    });

    it('accepts zero usage (adapter MUST default undefined fields to 0)', () => {
      const result: LlmRunResult = {
        reply: '',
        messages: [],
        usage: { promptTokens: 0, completionTokens: 0 },
      };

      expect(result.usage.promptTokens + result.usage.completionTokens).toBe(0);
    });
  });

  describe('LlmRunInput contract', () => {
    it('requires senderId, text, history, systemPrompt, tools', () => {
      const input: LlmRunInput = {
        senderId: '5215550001111',
        text: 'hola',
        history: [{ role: 'user', content: 'hola' }],
        systemPrompt: 'system prompt here',
        tools: {},
      };

      expect(input.senderId).toBe('5215550001111');
      expect(input.tools).toEqual({});
    });
  });

  // ─── Scenario: Port is mockable in tests ───────────────────────────
  describe('mockability', () => {
    it('a jest.fn implementing LlmAgentPort satisfies the type', async () => {
      const fake: jest.Mocked<LlmAgentPort> = {
        run: jest.fn(async () => ({
          reply: 'mock reply',
          messages: [{ role: 'assistant', content: 'mock reply' }],
          usage: { promptTokens: 1, completionTokens: 1 },
        })),
      };

      const result = await fake.run({
        senderId: 's',
        text: 't',
        history: [],
        systemPrompt: 'sys',
        tools: {},
      });

      expect(result.reply).toBe('mock reply');
      expect(fake.run).toHaveBeenCalledTimes(1);
    });
  });
});