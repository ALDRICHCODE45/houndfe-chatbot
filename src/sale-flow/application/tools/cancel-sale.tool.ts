import { tool } from 'ai';
import { z } from 'zod';
import { ChatbotApiError } from '../../../chatbot-api/domain/errors';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import {
  clearPlacedSaleId,
  readPlacedSaleId,
} from '../placed-sale-persistence';

/**
 * cancelSale — AI-SDK tool factory (cancel-endpoint-conversational slice).
 *
 * The 11th sale-flow tool. Wraps `chatbotApi.cancelSale()`
 * (`POST /chatbot-api/sales/:saleId/cancel`, scope `sales:write`).
 *
 * Hard rules (pinned by spec):
 *
 *   1. `inputSchema: z.object({}).strict()` — no model-supplied `saleId`,
 *      `reason`, or `cashierUserId`. The id is sourced from the durable
 *      `ConversationState.data.placedSaleId` (set by `createSale` success),
 *      the reason is hardcoded `CUSTOMER_REQUEST`, and the cashier id is
 *      injected from `deps.cashierUserId` (`CHATBOT_API_CASHIER_USER_ID`).
 *      ADR-15 / ADR-21.
 *
 *   2. `contextSchema: z.object({ senderId })` — the per-tool runtime
 *      seam; `senderId` never enters the prompt.
 *
 *   3. Client-side guard: missing `placedSaleId` returns
 *      `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }`
 *      WITHOUT any HTTP call. `missingPlacedSaleId` is NEVER produced by
 *      `mapChatbotError`; it is a tool-layer concept.
 *
 *   4. State-write policy mirrors ADR-18 (Q3 errorCode-first cart-mutation
 *      pattern): permanent codes
 *      (`SALE_NOT_FOUND` / `SALE_NOT_CANCELLABLE` /
 *      `SALE_DELIVERED_CANNOT_CANCEL` / `IDEMPOTENCY_KEY_CONFLICT`) clear
 *      `placedSaleId`; everything else (incl. `IDEMPOTENCY_KEY_IN_FLIGHT`,
 *      transient, unknown) preserves so the model can retry the same id.
 *
 *   5. Replay success: a sale already `CANCELED` server-side resolves as
 *      a normal 200 (no "already canceled" code, ADR-20). The tool treats
 *      it as success and clears the id.
 *
 *   6. The error-envelope + state-write split mirrors ADR-9 / ADR-17: the
 *      mapper is pure (no store / senderId) and the tool owns the
 *      `placedSaleId` side effect via `clearPlacedSaleId`.
 */
export function makeCancelSaleTool(deps: ToolDeps) {
  return tool({
    description:
      'Cancela SOLO la venta recién confirmada en esta sesión. Lee el id desde el estado durable (nunca desde el modelo ni desde getOrderHistory). reason siempre CUSTOMER_REQUEST y cashierUserId se inyecta del servidor.',
    inputSchema: z.object({}).strict(),
    contextSchema: z.object({ senderId: z.string() }),
    execute: async (_input, options) => {
      const senderId = options.context.senderId;
      const state = await deps.store.get(senderId);
      const placedSaleId = readPlacedSaleId(state);
      if (placedSaleId === null) {
        return {
          ok: false as const,
          error: {
            kind: 'missingPlacedSaleId' as const,
            retryable: false,
          },
        };
      }
      try {
        const canceledSale = await deps.chatbotApi.cancelSale(placedSaleId, {
          reason: 'CUSTOMER_REQUEST',
          cashierUserId: deps.cashierUserId,
        });
        await clearPlacedSaleId(deps.store, senderId, state);
        return { ok: true as const, ...canceledSale };
      } catch (err) {
        // ADR-18 / Q3-style: re-inspect errorCode for the state write because
        // mapChatbotError has no access to the store. Permanent codes clear
        // the (stale) placedSaleId; transient / unknown codes preserve it so
        // the model can retry the same call later.
        if (err instanceof ChatbotApiError) {
          switch (err.errorCode) {
            case 'SALE_NOT_FOUND':
            case 'SALE_NOT_CANCELLABLE':
            case 'SALE_DELIVERED_CANNOT_CANCEL':
            case 'IDEMPOTENCY_KEY_CONFLICT':
              await clearPlacedSaleId(deps.store, senderId, state);
              break;
            default:
              // IDEMPOTENCY_KEY_IN_FLIGHT + transient/unknown → preserve.
              break;
          }
        }
        return mapChatbotError(err);
      }
    },
  });
}
