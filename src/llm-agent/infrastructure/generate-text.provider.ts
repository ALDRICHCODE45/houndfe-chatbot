import type { generateText } from 'ai';

/**
 * DI injection token for the AI SDK's `generateText` function.
 *
 * This is the only network seam into the gateway. Production wiring
 * binds the real `ai.generateText` (in llm-agent.module.ts). Tests
 * bind a `jest.fn()` so no live gateway calls ever happen in CI.
 *
 * Keeping the SDK behind a Symbol (rather than importing it at the
 * top of every test file) is what guarantees the contract: the
 * `application/` and `domain/` layers never see SDK types.
 */
export const GENERATE_TEXT = Symbol('GENERATE_TEXT');

/**
 * Shape of the injected function. We declare it via Parameters/ReturnType
 * so we never need to import the SDK's `generateText` type at the type
 * level outside of the `import type` line above (which is erased at
 * compile time and never reaches the runtime).
 */
export type GenerateTextFn = typeof generateText;