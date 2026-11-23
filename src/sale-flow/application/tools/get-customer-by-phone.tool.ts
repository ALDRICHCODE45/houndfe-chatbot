import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * getCustomerByPhone — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.4: GET `/chatbot-api/customers/by-phone`
 * (`customers:read`). Stateless; the customer record (or `found: false`)
 * is returned as-is, except `customer.pets` (customer-pets T4a): pets reach
 * the model only through the pet memory (T4b), so the tool output stays the
 * one it was before the backend added them.
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
        if (lookup.customer?.pets === undefined) return { ok: true, ...lookup };
        const { pets: omitted, ...customer } = lookup.customer;
        void omitted;
        return { ok: true, ...lookup, customer };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
