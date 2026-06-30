import { tool } from 'ai';
import { z } from 'zod';

/**
 * Placeholder tool: returns the current server time as an ISO 8601
 * string. Useful as a smoke-test tool that exercises the SDK's tool
 * round-trip without any business-logic dependencies.
 *
 * Declared via the AI SDK's `tool()` helper with a Zod input schema
 * (empty object → no parameters). Only the infrastructure layer imports
 * the `ai` package — domain code stays tool-agnostic.
 */
export const getCurrentTime = tool({
  description: 'Return the current server time as an ISO 8601 string.',
  inputSchema: z.object({}),
  execute: async () => ({ now: new Date().toISOString() }),
});