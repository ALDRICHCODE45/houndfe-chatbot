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
      variantId: z.uuid().optional(),
      // Optional model-supplied product name — used as the digest `name`
      // source for the R7 `humanAssistance` envelope when present (per
      // the sale-flow-tools spec: sourced from prior searchCatalog or
      // from this input — NEVER fabricated).
      name: z.string().min(1).optional(),
    }),
    execute: async (input) => {
      try {
        const stock = await deps.chatbotApi.getStock(input.productId);
        // Non-trigger branches keep the existing shape byte-identically.
        const success = { ok: true as const, ...stock };
        if (stock.stock.status !== 'out_of_stock') {
          return success;
        }
        // R7 signal envelope — the trigger tool NEVER writes the row or
        // sends messages; the model decides when to call
        // `requestHumanAssistance` (the sole row-writing entry point,
        // ADR-9).
        const digest: {
          productId: string;
          name?: string;
          variantId?: string;
          quantity?: number;
        } = { productId: input.productId };
        const name =
          input.name ?? (stock.name.length > 0 ? stock.name : undefined);
        if (name !== undefined) {
          digest.name = name;
        }
        if (input.variantId !== undefined) {
          digest.variantId = input.variantId;
        }
        if (stock.stock.quantity !== null) {
          digest.quantity = stock.stock.quantity;
        }
        return {
          ...success,
          humanAssistance: {
            kind: 'out_of_stock' as const,
            digest,
          },
        };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
