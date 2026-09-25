import type { GenerateTextFn } from '../../src/llm-agent/infrastructure/generate-text.provider';
import {
  NO_TOOL_SANDBOX_FALLBACK_REPLY,
  NO_TOOL_SANDBOX_NO_CATALOG_REPLY,
  NO_TOOL_SANDBOX_SAFE_REPLIES,
  NO_TOOL_SANDBOX_SYSTEM_PROMPT,
  NoToolSandboxConfigError,
  createNoToolSandboxAgentRunner,
  parseNoToolLlmSandboxConfig,
} from './no-tool-llm-sandbox';

const API_KEY = 'sk-test-not-a-real-secret';
const BASE_ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: API_KEY,
  OPENAI_SANDBOX_MODEL: 'gpt-4.1-mini',
};
const ALLOWED_MESSAGE = 'Hola, buenos días.';
const SAFE_REPLY = NO_TOOL_SANDBOX_SAFE_REPLIES[0];
const UNKNOWN_ASKS: readonly string[] = [
  '¿Cuánto cuesta el lector de código de barras?',
  'Where is my package?',
  'mi teléfono es 5512345678',
];

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

function fakeGenerate(outcome: string | Error = 'ok') {
  const options: Array<Record<string, unknown>> = [];
  const mock = jest.fn(async (input: Record<string, unknown>) => {
    options.push(input);
    if (outcome instanceof Error) throw outcome;
    return { text: outcome };
  });
  return { generateText: mock as unknown as GenerateTextFn, mock, options };
}

describe('no-tool LLM sandbox (core contract)', () => {
  const config = parseNoToolLlmSandboxConfig(BASE_ENV);

  it('parses an allowlisted model with bounded defaults', () => {
    expect(config.modelId).toBe('gpt-4.1-mini');
    expect(config.maxCalls).toBe(5);
    expect(config.maxOutputTokens).toBe(256);
    expect(config.maxInputChars).toBe(500);
    expect(config.timeoutMs).toBe(20000);
  });

  it('fails closed when the explicit API key is missing', () => {
    const error = captureError(() =>
      parseNoToolLlmSandboxConfig({ ...BASE_ENV, OPENAI_API_KEY: undefined }),
    );
    expect(error).toBeInstanceOf(NoToolSandboxConfigError);
    expect((error as NoToolSandboxConfigError).code).toBe(
      'missing_required_value',
    );
  });

  it.each(UNKNOWN_ASKS)(
    'returns the fixed no-catalog reply for default-denied ask %j with no call',
    async (text) => {
      const { generateText, mock } = fakeGenerate();
      const runner = createNoToolSandboxAgentRunner({ config, generateText });
      const result = await runner.handle({ senderId: '5215550001111', text });
      expect(result.reply).toBe(NO_TOOL_SANDBOX_NO_CATALOG_REPLY);
      expect(mock).not.toHaveBeenCalled();
    },
  );

  it('calls generateText once with the canonical prompt and tool-none options', async () => {
    const { generateText, options } = fakeGenerate(SAFE_REPLY);
    const runner = createNoToolSandboxAgentRunner({ config, generateText });
    const result = await runner.handle({
      senderId: '5215550009999',
      text: `  ${ALLOWED_MESSAGE}  `,
    });

    expect(result.reply).toBe(SAFE_REPLY);
    expect(options).toHaveLength(1);
    const call = options[0];
    expect(call).toMatchObject({
      system: NO_TOOL_SANDBOX_SYSTEM_PROMPT,
      prompt: ALLOWED_MESSAGE,
      maxOutputTokens: 256,
      maxRetries: 0,
      timeout: 20000,
      tools: {},
      toolChoice: 'none',
    });
    expect(call.messages).toBeUndefined();
    const rendered = JSON.stringify(call);
    expect(rendered).not.toContain('5215550009999');
    expect(rendered).not.toContain(API_KEY);
  });

  it('stops calling the provider after the bounded five-call cap', async () => {
    const { generateText, mock } = fakeGenerate(SAFE_REPLY);
    const runner = createNoToolSandboxAgentRunner({ config, generateText });
    const replies: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const result = await runner.handle({ senderId: 's', text: 'Hola' });
      replies.push(result.reply);
    }
    expect(replies.slice(0, 5).every((r) => r === SAFE_REPLY)).toBe(true);
    expect(replies[5]).toBe(NO_TOOL_SANDBOX_FALLBACK_REPLY);
    expect(mock).toHaveBeenCalledTimes(5);
  });

  it('returns a safe fallback and consumes a call on provider error', async () => {
    const { generateText, mock } = fakeGenerate(new Error('boom'));
    const runner = createNoToolSandboxAgentRunner({ config, generateText });
    const first = await runner.handle({ senderId: 's', text: 'Hola' });
    const second = await runner.handle({ senderId: 's', text: 'Hola' });
    expect(first.reply).toBe(NO_TOOL_SANDBOX_FALLBACK_REPLY);
    expect(second.reply).toBe(NO_TOOL_SANDBOX_FALLBACK_REPLY);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
