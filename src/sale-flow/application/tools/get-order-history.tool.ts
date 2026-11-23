import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import type { OrderHistoryResponse } from '../../../chatbot-api/domain/dtos/sales.dto';

/**
 * getOrderHistory — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.9: GET `/chatbot-api/customers/by-phone/:phone/orders`
 * (`customers:read`). Stateless — the backend returns up to 5 most
 * recent CONFIRMED sales (or `[]` if no customer matches). The per-line
 * `pet` (customer-pets T4a) is dropped: per-pet history is T5, so the tool
 * output stays the one it was before the backend added it.
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
        return { ok: true, results: results.map(withoutLinePets) };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}

function withoutLinePets(order: OrderHistoryResponse): OrderHistoryResponse {
  if (order.items.every((item) => !('pet' in item))) return order;
  return {
    ...order,
    items: order.items.map((item) => {
      const { pet: omitted, ...line } = item;
      void omitted;
      return line;
    }),
  };
}
