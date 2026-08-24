import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * checkStock — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.2: GET `/chatbot-api/catalog/:productId/stock`
 * (`catalog:read`). Stateless; the backend already returns 404 with
 * `NotFoundError` when the product does not exist.
 */
export function makeCheckStockTool(deps: ToolDeps) {
  return tool({
    description:
      'Consulta la disponibilidad y existencias de un producto (y sus variantes). Devuelve 404 si el producto no existe.',
    inputSchema: z.object({
      productId: z.uuid(),
    }),
    execute: async (input) => {
      try {
        const stock = await deps.chatbotApi.getStock(input.productId);
        return { ok: true, ...stock };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
