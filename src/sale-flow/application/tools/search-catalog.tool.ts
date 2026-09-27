import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import {
  CatalogSession,
  CATALOG_RECOVERY,
  catalogSessionSchema,
} from '../../../conversation/domain/catalog-references';

/**
 * searchCatalog — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.1: GET `/chatbot-api/catalog/search` (`catalog:read`).
 * Shared factory; identity is stored only in the server-supplied run session.
 * Direct legacy callers without a session may still search. The 5xx / network
 * upstream failures retain the retryable `upstream` envelope, but guidance
 * forbids extra model-driven automatic retries. HTTP retry policy is unchanged.
 */
export function makeSearchCatalogTool(deps: ToolDeps) {
  return tool({
    description:
      'Busca por el nombre principal del producto. Devuelve candidatos reales con precios y existencias, incluidos los agotados. Sigue los pasos 2–5 del flujo para confirmar presentación y distinguir coincidencias, errores y falta de stock.',
    inputSchema: z.object({
      q: z
        .string()
        .min(1)
        .describe(
          'Nombre principal, por ejemplo "ibuprofeno" para "ibuprofeno de 400 mg". Conserva dosis y forma como criterios de selección de resultados, no como filtro inicial.',
        ),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    contextSchema: z.object({
      catalogSession: catalogSessionSchema.optional(),
    }),
    execute: async (input, options) => {
      let session: CatalogSession | undefined;
      let ticket: number | undefined;
      try {
        session = options.context?.catalogSession;
        if (session !== undefined && !CatalogSession.is(session))
          return CATALOG_RECOVERY;
        ticket = session?.beginSearch();
      } catch {
        return CATALOG_RECOVERY;
      }
      try {
        const results = await deps.chatbotApi.searchCatalog(
          input.q,
          input.limit,
        );
        if (session && ticket !== undefined)
          session.installSearch(ticket, results);
        return { ok: true, results };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
