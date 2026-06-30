import { generateText } from 'ai';

/**
 * DI injection token for the AI SDK's `generateText` function.
 *
 * This is the only network seam into the gateway. Production wiring
 * binds `generateTextImpl` (re-exported below) via llm-agent.module.ts.
 * Tests bind a `jest.fn()` so no live gateway calls ever happen in CI.
 *
 * Keeping the SDK behind a Symbol (rather than importing it at the
 * top of every test file) is what guarantees the contract: the
 * `application/` and `domain/` layers never see SDK types.
 */
export const GENERATE_TEXT = Symbol('GENERATE_TEXT');

/**
 * Runtime re-export of the AI SDK's `generateText`. This is the SINGLE
 * place the `ai` package value is imported. The module composition root
 * binds GENERATE_TEXT to this value instead of importing `ai` directly,
 * so the spec contract holds literally: only `infrastructure/` imports
 * from `ai`.
 */
export const generateTextImpl = generateText;

/**
 * Shape of the injected function, derived from the SDK value so we never
 * hand-maintain the signature.
 */
export type GenerateTextFn = typeof generateText;