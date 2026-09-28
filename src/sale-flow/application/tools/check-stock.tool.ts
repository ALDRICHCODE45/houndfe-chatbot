import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import {
  CatalogSession,
  catalogSessionSchema,
  CATALOG_RECOVERY,
} from '../../../conversation/domain/catalog-references';
import type {
  StockReadExecutionObserver,
  StockReadReceiptInput,
  TrustedStockSubject,
} from '../../../llm-agent/domain/stock-read-evidence';

/**
 * Structural runtime check for the server-owned observer. A malformed or
 * incomplete observer is treated as absent, never defaulted.
 */
function isStockReadExecutionObserver(
  value: unknown,
): value is StockReadExecutionObserver {
  if (value === null || typeof value !== 'object') return false;
  const observer = value as Record<string, unknown>;
  return (
    typeof observer.serverTurnId === 'string' &&
    observer.serverTurnId.trim().length > 0 &&
    typeof observer.step === 'number' &&
    Number.isSafeInteger(observer.step) &&
    observer.step >= 0 &&
    typeof observer.recordExecution === 'function'
  );
}

const stockReadObserverSchema = z.custom<StockReadExecutionObserver>(
  isStockReadExecutionObserver,
);

/** Captured server-owned observer metadata and callback, or `null`. */
interface CapturedStockReadObserver {
  serverTurnId: string;
  step: number;
  record: (receipt: StockReadReceiptInput) => void;
}

function captureStockReadObserver(
  value: unknown,
): CapturedStockReadObserver | null {
  if (!isStockReadExecutionObserver(value)) return null;
  return {
    serverTurnId: value.serverTurnId,
    step: value.step,
    record: value.recordExecution.bind(value),
  };
}

/** A genuine SDK call id, or `null` when one must not be invented. */
function genuineToolCallId(toolCallId: unknown): string | null {
  return typeof toolCallId === 'string' && toolCallId.trim().length > 0
    ? toolCallId
    : null;
}

/**
 * Record one execution privately. Observation is never authority and never
 * alters the model-visible result, even when the recorder throws.
 */
function recordStockRead(
  observer: CapturedStockReadObserver | null,
  toolCallId: string | null,
  receipt: {
    subject: TrustedStockSubject | null;
    catalogGenerationBefore: number;
    catalogGenerationAfter: number;
    output: unknown;
  },
): void {
  if (observer === null || toolCallId === null) return;
  try {
    observer.record({
      serverTurnId: observer.serverTurnId,
      toolCallId,
      step: observer.step,
      subject: receipt.subject,
      catalogGenerationBefore: receipt.catalogGenerationBefore,
      catalogGenerationAfter: receipt.catalogGenerationAfter,
      output: receipt.output,
    });
  } catch {
    // Observation failures must never change the normal tool output.
  }
}

/**
 * Revalidate the same exact subject against the current catalog session after
 * the GET. A changed generation keeps the pre-GET trusted subject so the S3a
 * recorder marks `catalog_changed`; a same-generation expiry/clear or a
 * different canonical subject records no subject at all.
 */
function revalidatedSubject(
  session: CatalogSession,
  subject: TrustedStockSubject,
  input: { productId: string; variantId?: string | null; name?: string },
  catalogGenerationBefore: number,
  catalogGenerationAfter: number,
): TrustedStockSubject | null {
  if (catalogGenerationAfter !== catalogGenerationBefore) return subject;
  let canonical: TrustedStockSubject | null = null;
  try {
    canonical = session.resolve(input);
  } catch {
    canonical = null;
  }
  return canonical !== null &&
    canonical.productId === subject.productId &&
    canonical.variantId === subject.variantId &&
    canonical.productName === subject.productName &&
    canonical.variantName === subject.variantName
    ? subject
    : null;
}

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
      stockReadObserver: stockReadObserverSchema.optional(),
    }),
    execute: async (input, options) => {
      const observer = captureStockReadObserver(
        options.context?.stockReadObserver,
      );
      const toolCallId = genuineToolCallId(options.toolCallId);

      let session: CatalogSession | null = null;
      let subject: TrustedStockSubject | null = null;
      let catalogGenerationBefore = -1;
      try {
        const candidate = options.context?.catalogSession;
        if (CatalogSession.is(candidate)) {
          session = candidate;
          catalogGenerationBefore = candidate.generation;
          subject = candidate.resolve(input);
        }
      } catch {
        subject = null;
      }

      if (session === null || subject === null) {
        recordStockRead(observer, toolCallId, {
          subject: null,
          catalogGenerationBefore,
          catalogGenerationAfter: catalogGenerationBefore,
          output: CATALOG_RECOVERY,
        });
        return CATALOG_RECOVERY;
      }

      // Non-trigger branches keep the existing shape byte-identically; every
      // branch is recorded privately before it is returned.
      const result = await (async () => {
        try {
          const stock = await deps.chatbotApi.getStock(input.productId);
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
          // requestHumanAssistance tool. A future RESTOCK effect must
          // revalidate against a fresh trusted catalog read before its
          // reserve/POST.
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
          // Failed reads are recorded too, so a prior fact is never left live.
          return mapChatbotError(err);
        }
      })();

      const catalogGenerationAfter = session.generation;
      recordStockRead(observer, toolCallId, {
        subject: revalidatedSubject(
          session,
          subject,
          input,
          catalogGenerationBefore,
          catalogGenerationAfter,
        ),
        catalogGenerationBefore,
        catalogGenerationAfter,
        output: result,
      });
      return result;
    },
  });
}
