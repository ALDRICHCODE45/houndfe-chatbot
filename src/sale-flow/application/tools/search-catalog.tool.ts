import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';

/**
 * searchCatalog — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.1: GET `/chatbot-api/catalog/search` (`catalog:read`).
 * Stateless; no cart or sender context required. The 5xx / network
 * upstream failures surface as a retryable `upstream` envelope so the
 * model can choose to retry without leaking HTTP details.
 */
export function makeSearchCatalogTool(deps: ToolDeps) {
  return tool({
    description:
      'Busca productos en el catálogo por texto. Devuelve los resultados con precios y existencias.',
    inputSchema: z.object({
      q: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    execute: async (input) => {
      try {
        const results = await deps.chatbotApi.searchCatalog(
          input.q,
          input.limit,
        );
        return { ok: true, results };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
