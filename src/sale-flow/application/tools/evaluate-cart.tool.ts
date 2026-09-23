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
 * per-unit `unitPriceCents` under `data.cart.items`.
 *
 * Backend price shape (`evaluate-cart-promotions.use-case.ts`): the DTO's
 * `originalPriceCents`, `finalPriceCents`, and `discountAmountCents` are
 * EXTENDED LINE totals (`unitPriceCents * quantity`, discounted per line),
 * while `unitPriceCents` is per unit. The backend spreads the caller's input
 * into each result line, so the response `unitPriceCents` is normally an ECHO
 * of this tool's input — not independent list-price validation. Authoritative
 * repricing happens server-side in `confirmBotSale` (engine recompute, then
 * `PROMO_RE_QUOTE` on an `expectedTotalCents` mismatch); this tool only
 * persists the per-unit field and sums each line's final total once.
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
      'Cotiza el carrito contra el backend con el precio unitario proporcionado; devuelve totales por renglón con descuentos aplicables. La venta verifica precios y promociones nuevamente. Persiste el carrito en ConversationState.data.cart.',
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
        // Persist the response's PER-UNIT `unitPriceCents`, NOT an extended
        // line total (`originalPriceCents`/`finalPriceCents`). The backend
        // echoes the caller's input here, so this is not list-price
        // validation; `confirmBotSale` owns authoritative repricing.
        const items: CartItem[] = evaluation.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId ?? undefined,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
        }));
        // Q2 / R13: sum each LINE `finalPriceCents` ONCE (it is already the
        // extended line total; multiplying by quantity double-counts).
        // ADR-6 — the CartEvaluationResult DTO has no top-level
        // `totalCents`, so the client sums it from per-line fields. This is
        // only a client-side conversation total; the backend recomputes and
        // returns `PROMO_RE_QUOTE` on mismatch.
        const expectedTotalCents = evaluation.items.reduce(
          (sum, i) => sum + i.finalPriceCents,
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
        // `requestHumanAssistance` when the customer wants to proceed. This is
        // a conversation-level signal only; it does not block `createSale`.
        // The digest mirrors the persisted cart at per-unit `unitPriceCents`,
        // never an extended line total. The backend CartEvaluationResult DTO
        // carries no top-level totals, so the optional `originalTotalCents` /
        // `recomputedTotalCents` digest fields are omitted (design intent: the
        // per-unit lines are the review payload).
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
