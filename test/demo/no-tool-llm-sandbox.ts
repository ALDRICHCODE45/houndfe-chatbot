import { createOpenAI } from '@ai-sdk/openai';
import type { GenerateTextFn } from '../../src/llm-agent/infrastructure/generate-text.provider';

// M2b: test-only, bounded, no-tool LLM sandbox adapter. Authorization is
// default-deny: only exact vetted benign prompts (never raw text, senderId, or
// phone) reach the model, and only exact vetted safe replies are returned.
// It never reads `process.env`.

/** Explicit environment input (a plain record, never the live process env). */
export type NoToolSandboxEnv = Readonly<Record<string, string | undefined>>;

/** Hard ceilings. A parsed env value can never exceed these. */
export const NO_TOOL_SANDBOX_LIMITS = {
  calls: 5,
  outputTokens: 256,
  inputChars: 500,
  timeoutMs: 20_000,
} as const;

/** Allowlisted non-reasoning models only; reasoning models are rejected. */
export const NO_TOOL_SANDBOX_ALLOWED_MODELS = [
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
] as const;

const ALLOWED_MODELS: ReadonlySet<string> = new Set(
  NO_TOOL_SANDBOX_ALLOWED_MODELS,
);
const INTEGER_PATTERN = /^\d+$/;
const DIGIT_PATTERN = /\d/;
const WHITESPACE_PATTERN = /\s+/g;
const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;

/** The ONLY non-fallback strings that may ever leave the adapter as a reply. */
export const NO_TOOL_SANDBOX_SAFE_REPLIES: readonly string[] = [
  'Hola, soy el asistente de HoundFe en una demostración de sandbox sin ' +
    'catálogo real. Puedo saludar, agradecer y aclararle que el catálogo real ' +
    'aún no está conectado.',
  'Con gusto. Recuerde que en este sandbox sin catálogo real no puedo ' +
    'confirmar precios, existencias, envíos, tiempos de entrega ni pedidos.',
  'En esta demostración de sandbox sin catálogo real solo puedo saludar, ' +
    'agradecer y aclarar que el catálogo real aún no está conectado. No puedo ' +
    'confirmar precios, existencias, envíos, tiempos de entrega ni pedidos.',
];

const SAFE_REPLIES: ReadonlySet<string> = new Set(NO_TOOL_SANDBOX_SAFE_REPLIES);

/** Fixed honest reply for every non-allowlisted or oversized input. */
export const NO_TOOL_SANDBOX_NO_CATALOG_REPLY =
  'Estoy en una demostración de sandbox sin catálogo real conectado. ' +
  'No puedo confirmar existencias, precios, promociones, envíos, tiempos de ' +
  'entrega, estatus de pedido ni ventas. Cuando el catálogo real esté ' +
  'disponible le compartiré información verificada.';

/** Safe fallback for errors, empty input, the call cap, and hallucinations. */
export const NO_TOOL_SANDBOX_FALLBACK_REPLY =
  'No pude generar una respuesta en este sandbox sin catálogo real. ' +
  'Por favor, intente de nuevo más tarde.';

/** Default-deny benign allowlist: the ONLY prompts that may reach the model. */
export const NO_TOOL_SANDBOX_ALLOWED_PROMPTS: readonly string[] = [
  'Hola',
  'Hola, buenos días.',
  'Gracias por la información.',
  '¿Qué puedes hacer?',
];

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS_PATTERN, '')
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

const ALLOWED_PROMPTS_BY_NORMALIZED = new Map<string, string>(
  NO_TOOL_SANDBOX_ALLOWED_PROMPTS.map((prompt): [string, string] => [
    normalizeForMatch(prompt),
    prompt,
  ]),
);

/**
 * Returns the canonical allowlisted prompt for `text`, or `null` (default-deny).
 * Whitespace is trimmed and collapsed; any digit (e.g. a phone number) or any
 * text that is not exactly a benign entry is refused.
 */
export function resolveAllowedPrompt(text: unknown): string | null {
  if (typeof text !== 'string' || DIGIT_PATTERN.test(text)) return null;
  return ALLOWED_PROMPTS_BY_NORMALIZED.get(normalizeForMatch(text)) ?? null;
}

const SAFE_REPLY_CHOICES = NO_TOOL_SANDBOX_SAFE_REPLIES.map(
  (reply) => `"${reply}"`,
).join(' | ');

export const NO_TOOL_SANDBOX_SYSTEM_PROMPT =
  'Eres el asistente de ventas de HoundFe en una DEMOSTRACIÓN SANDBOX sin ' +
  'catálogo real. No tienes inventario, precios, promociones, cotizador de ' +
  'envíos, rastreo ni acceso a pedidos o ventas. Nunca inventes ni afirmes ' +
  'existencias, precios, descuentos, promociones, costos de envío, fechas o ' +
  'tiempos de entrega, números de guía, estatus de pedido, ni que una compra ' +
  'o venta quedó realizada. Responde SIEMPRE con EXACTAMENTE una de estas ' +
  'frases seguras, sin agregar ni quitar texto: ' +
  SAFE_REPLY_CHOICES +
  '.';

export type NoToolSandboxConfigErrorCode =
  | 'missing_required_value'
  | 'malformed_value'
  | 'model_not_allowed'
  | 'limit_exceeded';

/** Rejection carrying only the env field name and a code, never a value. */
export class NoToolSandboxConfigError extends Error {
  constructor(
    readonly code: NoToolSandboxConfigErrorCode,
    readonly field: string,
  ) {
    super(`No-tool sandbox config rejected "${field}" (${code})`);
    this.name = 'NoToolSandboxConfigError';
  }
}

export interface NoToolLlmSandboxConfig {
  readonly apiKey: string;
  readonly modelId: string;
  readonly maxCalls: number;
  readonly maxOutputTokens: number;
  readonly maxInputChars: number;
  readonly timeoutMs: number;
}

function requireValue(env: NoToolSandboxEnv, key: string): string {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new NoToolSandboxConfigError('missing_required_value', key);
  }
  return raw.trim();
}

function readBoundedInt(
  env: NoToolSandboxEnv,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !INTEGER_PATTERN.test(raw.trim())) {
    throw new NoToolSandboxConfigError('malformed_value', key);
  }
  const value = Number(raw.trim());
  if (value < 1 || value > max) {
    throw new NoToolSandboxConfigError('limit_exceeded', key);
  }
  return value;
}

/** Parses an explicit env record; missing/malformed/over-cap values fail closed. */
export function parseNoToolLlmSandboxConfig(
  env: NoToolSandboxEnv,
): NoToolLlmSandboxConfig {
  const apiKey = requireValue(env, 'OPENAI_API_KEY');
  const modelId = requireValue(env, 'OPENAI_SANDBOX_MODEL');
  if (!ALLOWED_MODELS.has(modelId)) {
    throw new NoToolSandboxConfigError(
      'model_not_allowed',
      'OPENAI_SANDBOX_MODEL',
    );
  }
  return {
    apiKey,
    modelId,
    maxCalls: readBoundedInt(
      env,
      'OPENAI_SANDBOX_MAX_CALLS',
      NO_TOOL_SANDBOX_LIMITS.calls,
      NO_TOOL_SANDBOX_LIMITS.calls,
    ),
    maxOutputTokens: readBoundedInt(
      env,
      'OPENAI_SANDBOX_MAX_OUTPUT_TOKENS',
      NO_TOOL_SANDBOX_LIMITS.outputTokens,
      NO_TOOL_SANDBOX_LIMITS.outputTokens,
    ),
    maxInputChars: readBoundedInt(
      env,
      'OPENAI_SANDBOX_MAX_INPUT_CHARS',
      NO_TOOL_SANDBOX_LIMITS.inputChars,
      NO_TOOL_SANDBOX_LIMITS.inputChars,
    ),
    timeoutMs: readBoundedInt(
      env,
      'OPENAI_SANDBOX_TIMEOUT_MS',
      NO_TOOL_SANDBOX_LIMITS.timeoutMs,
      NO_TOOL_SANDBOX_LIMITS.timeoutMs,
    ),
  };
}

/** Minimal drop-in shape matching the M1 fake `AgentRunner.handle`. */
export interface NoToolSandboxAgentRunner {
  handle(input: {
    readonly senderId: string;
    readonly text: string;
  }): Promise<{ reply: string }>;
}

export interface CreateNoToolSandboxRunnerDeps {
  readonly config: NoToolLlmSandboxConfig;
  readonly generateText: GenerateTextFn;
}

/**
 * Builds a bounded, no-tool, default-deny `AgentRunner` drop-in. The OpenAI
 * provider uses the explicit parsed key, never the `process.env` fallback.
 */
export function createNoToolSandboxAgentRunner(
  deps: CreateNoToolSandboxRunnerDeps,
): NoToolSandboxAgentRunner {
  const { config, generateText } = deps;
  const model = createOpenAI({ apiKey: config.apiKey })(config.modelId);
  let calls = 0;

  return {
    async handle(input): Promise<{ reply: string }> {
      const text = typeof input?.text === 'string' ? input.text : '';
      if (text.trim() === '') {
        return { reply: NO_TOOL_SANDBOX_FALLBACK_REPLY };
      }
      const canonical = resolveAllowedPrompt(text);
      if (canonical === null || text.length > config.maxInputChars) {
        return { reply: NO_TOOL_SANDBOX_NO_CATALOG_REPLY };
      }
      if (calls >= config.maxCalls) {
        return { reply: NO_TOOL_SANDBOX_FALLBACK_REPLY };
      }
      calls += 1;
      try {
        const result = await generateText({
          model,
          system: NO_TOOL_SANDBOX_SYSTEM_PROMPT,
          prompt: canonical,
          maxOutputTokens: config.maxOutputTokens,
          maxRetries: 0,
          timeout: config.timeoutMs,
          tools: {},
          toolChoice: 'none',
        });
        const reply = (result as { text?: unknown } | undefined)?.text;
        if (typeof reply === 'string' && SAFE_REPLIES.has(reply.trim())) {
          return { reply: reply.trim() };
        }
        return { reply: NO_TOOL_SANDBOX_FALLBACK_REPLY };
      } catch {
        return { reply: NO_TOOL_SANDBOX_FALLBACK_REPLY };
      }
    },
  };
}
