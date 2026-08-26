import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import { persistCart } from '../cart-persistence';
import { readCart } from '../../domain/cart-state';
import type { CartItem } from '../../domain/cart-state';

/**
 * evaluateCart — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.3: POST `/chatbot-api/pricing/evaluate-cart`
 * (`pricing:evaluate`). Stateful — quotes the cart AND persists the
 * canonical list-price (`originalPriceCents`) under `data.cart.items`.
 *
 * The persisted `unitPriceCents` is the *list price* the backend
 * returned (`originalPriceCents`), never the model's input price or
 * the discounted `finalPriceCents`. This is the list-price enforcement
 * pinned in the spec (Q2 of `docs/backend-questions-sale-flow.md`):
 * later `createSale` overrides each line from the persisted cart, so
 * the tool, not the model, owns the price.
 *
 * The existing `idempotencyKey` is preserved across writes (only
 * `createSale` mints a new UUID v4 on first attempt). Read-then-write
 * keeps the key stable across retries within a sender session.
 *
 * `contextSchema: { senderId }` is the only seam the AI-SDK exposes for
 * per-tool runtime values that the LLM must NOT see — sender identity
 * flows through `toolsContext` (see `VercelAiLlmAgent.run`).
 */
export function makeEvaluateCartTool(deps: ToolDeps) {
  return tool({
    description:
      'Cotiza el carrito contra el backend. Devuelve el precio de lista original y, si aplica, el precio con descuento. Persiste el carrito en ConversationState.data.cart.',
    inputSchema: z.object({
      items: z
        .array(
          z.object({
            productId: z.uuid(),
            variantId: z.uuid().optional(),
            quantity: z.number().int().min(1),
            unitPriceCents: z.number().int().min(0),
          }),
        )
        .min(1),
    }),
    contextSchema: z.object({ senderId: z.string() }),
    execute: async (input, options) => {
      const senderId = options.context.senderId;
      try {
        const evaluation = await deps.chatbotApi.evaluateCart(input.items);
        // List-price enforcement: persist `originalPriceCents` as
        // `unitPriceCents`, NOT the model's input price nor the
        // discounted `finalPriceCents`.
        const items: CartItem[] = evaluation.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId ?? undefined,
          quantity: i.quantity,
          unitPriceCents: i.originalPriceCents,
        }));
        // Q2 / R13: compute Σ(finalPriceCents × quantity) — the
        // discounted total the bot quoted at step 8. ADR-6 — the
        // CartEvaluationResult DTO has no top-level `totalCents`, so
        // the client sums it from per-line fields. The result is
        // persisted on the cart so a later `createSale` can send it
        // as the top-level `expectedTotalCents` guard.
        const expectedTotalCents = evaluation.items.reduce(
          (sum, i) => sum + i.finalPriceCents * i.quantity,
          0,
        );
        const state = await deps.store.get(senderId);
        const existingCart = readCart(state);
        await persistCart(deps.store, senderId, state, {
          items,
          idempotencyKey: existingCart.idempotencyKey,
          expectedTotalCents,
        });
        // Non-trigger branches keep the existing shape byte-identically.
        const success = { ok: true as const, ...evaluation };
        if (evaluation.promotionEvaluationStatus !== 'needs_human_review') {
          return success;
        }
        // `needs_human_review` signal envelope (spec §"evaluateCart returns
        // a humanAssistance envelope"): the tool ONLY signals — the model
        // renders the existing quote first and escalates via
        // `requestHumanAssistance` when the customer wants to proceed. The
        // digest mirrors the persisted cart at LIST price
        // (`unitPriceCents = originalPriceCents`), never the discounted
        // `finalPriceCents`. The backend CartEvaluationResult DTO carries no
        // top-level totals, so the optional `originalTotalCents` /
        // `recomputedTotalCents` digest fields are omitted (design intent:
        // the list-price lines are the review payload).
        return {
          ...success,
          humanAssistance: {
            kind: 'needs_human_review' as const,
            digest: { items },
          },
        };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
