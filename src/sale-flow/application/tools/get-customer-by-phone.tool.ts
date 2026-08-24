import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * getCustomerByPhone — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.4: GET `/chatbot-api/customers/by-phone`
 * (`customers:read`). Stateless; the customer record (or `found: false`)
 * is returned as-is.
 */
export function makeGetCustomerByPhoneTool(deps: ToolDeps) {
  return tool({
    description:
      'Busca un cliente por código de país + teléfono. Devuelve { found, customer } o { found: false } si no existe.',
    inputSchema: z.object({
      phoneCountryCode: z.string().min(1).max(10),
      phone: z.string().min(1).max(20),
    }),
    execute: async (input) => {
      try {
        const lookup = await deps.chatbotApi.getCustomerByPhone(
          input.phoneCountryCode,
          input.phone,
        );
        return { ok: true, ...lookup };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
