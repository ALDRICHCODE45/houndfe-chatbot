import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import {
  CatalogSession,
  catalogSessionSchema,
  CATALOG_RECOVERY,
} from '../../../conversation/domain/catalog-references';

/**
 * checkStock — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.2: GET `/chatbot-api/catalog/:productId/stock`
 * (`catalog:read`). Run-local catalog evidence gates GET; fresh backend
 * stock remains the authority for the escalation signal.
 */
export function makeCheckStockTool(deps: ToolDeps) {
  return tool({
    description:
      'Consulta la disponibilidad y existencias de un producto (y sus variantes). Devuelve 404 si el producto no existe.',
    inputSchema: z.object({
      productId: z.uuid(),
      variantId: z.uuid().optional(),
      // Accepted for compatibility with existing callers, but NEVER used as
      // product identity in the escalation digest: the backend name wins.
      name: z.string().min(1).optional(),
    }),
    contextSchema: z.object({
      catalogSession: catalogSessionSchema.optional(),
    }),
    execute: async (input, options) => {
      try {
        const session = options.context?.catalogSession;
        if (!CatalogSession.is(session) || !session.matches(input)) {
          return CATALOG_RECOVERY;
        }
      } catch {
        return CATALOG_RECOVERY;
      }
      try {
        const stock = await deps.chatbotApi.getStock(input.productId);
        // Non-trigger branches keep the existing shape byte-identically.
        const success = { ok: true as const, ...stock };
        if (
          stock.productId !== input.productId ||
          stock.stock.status !== 'out_of_stock' ||
          typeof stock.name !== 'string' ||
          stock.name.trim().length === 0
        ) {
          return success;
        }
        // A model-provided variant is not evidence of its association or
        // shortage. Neither is stock.quantity a customer-requested quantity.
        const selected = input.variantId
          ? stock.variants.find((v) => v.variantId === input.variantId)
          : undefined;
        if (
          input.variantId !== undefined &&
          (!selected || selected.stock.status !== 'out_of_stock')
        ) {
          return success;
        }
        // R7 signal only; the model still decides whether to call the sole
        // requestHumanAssistance tool. A future RESTOCK effect must revalidate
        // against a fresh trusted catalog read before its reserve/POST.
        const digest = {
          productId: stock.productId,
          name: stock.name,
          ...(selected ? { variantId: selected.variantId } : {}),
        };
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
