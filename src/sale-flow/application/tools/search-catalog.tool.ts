import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import {
  CatalogSession,
  CATALOG_RECOVERY,
  catalogSessionSchema,
} from '../../../conversation/domain/catalog-references';
import type {
  CatalogItemResponse,
  CatalogItemVariantResponse,
} from '../../../chatbot-api/domain/dtos/catalog.dto';

/** Model-facing variant without any stock field. */
type ProjectedCatalogVariant = Omit<CatalogItemVariantResponse, 'stock'>;

/** Model-facing catalog item: identity + price, never inventory. */
type ProjectedCatalogItem = Omit<CatalogItemResponse, 'stock' | 'variants'> & {
  variants: ProjectedCatalogVariant[];
};

/**
 * Build a fresh projection that strips product AND variant stock. Every
 * source object is read-only here: the raw backend DTO (installed into the
 * CatalogSession for trusted identity) is never mutated.
 */
export function projectCatalogResults(
  results: readonly CatalogItemResponse[],
): ProjectedCatalogItem[] {
  return results.map((item) => ({
    productId: item.productId,
    name: item.name,
    brand: item.brand,
    imageUrl: item.imageUrl,
    description: item.description,
    price: { ...item.price },
    packageInfo: { ...item.packageInfo },
    variants: item.variants.map((variant) => ({
      variantId: variant.variantId,
      name: variant.name,
      option: variant.option,
      value: variant.value,
      priceCents: variant.priceCents,
    })),
  }));
}

/**
 * searchCatalog — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.1: GET `/chatbot-api/catalog/search` (`catalog:read`).
 * Shared factory; identity is stored only in the server-supplied run session.
 * Direct legacy callers without a session may still search. The 5xx / network
 * upstream failures retain the retryable `upstream` envelope, but guidance
 * forbids extra model-driven automatic retries. HTTP retry policy is unchanged.
 *
 * R2: the raw backend results are installed into the CatalogSession first
 * (trusted identity), then a stock-free projection is returned to the model
 * with an explicit `requires_check_stock` marker. Search is never inventory
 * evidence; only a later `checkStock` can confirm availability.
 */
export function makeSearchCatalogTool(deps: ToolDeps) {
  return tool({
    description:
      'Busca por el nombre principal del producto. Devuelve candidatos reales con su identidad y precios, incluidos los agotados, pero sin existencias: confirma disponibilidad con checkStock antes de afirmarla. Sigue los pasos 2–5 del flujo para confirmar presentación y distinguir coincidencias, errores y falta de stock.',
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
        return {
          ok: true as const,
          requires_check_stock: true as const,
          results: projectCatalogResults(results),
        };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
