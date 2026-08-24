import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * getOrderHistory — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.9: GET `/chatbot-api/customers/by-phone/:phone/orders`
 * (`customers:read`). Stateless — the backend returns up to 5 most
 * recent CONFIRMED sales (or `[]` if no customer matches).
 */
export function makeGetOrderHistoryTool(deps: ToolDeps) {
  return tool({
    description:
      'Consulta el historial de pedidos recientes del cliente por teléfono (hasta 5 ventas confirmadas).',
    inputSchema: z.object({
      phone: z.string().min(1).max(20),
      phoneCountryCode: z.string().min(1).max(10),
    }),
    execute: async (input) => {
      try {
        const results = await deps.chatbotApi.getOrderHistory(
          input.phone,
          input.phoneCountryCode,
        );
        return { ok: true, results };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
