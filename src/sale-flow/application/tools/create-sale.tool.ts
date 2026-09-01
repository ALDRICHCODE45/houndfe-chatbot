import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import { persistCart } from '../cart-persistence';
import { persistConfirmedSale } from '../placed-sale-persistence';
import { readCart, writeCart, type CartState } from '../../domain/cart-state';
import { ChatbotApiError } from '../../../chatbot-api/domain/errors';

/**
 * createSale — AI-SDK tool factory.
 *
 * AGENTS.md §4.4.6: POST `/chatbot-api/sales` (`sales:create`) +
 * `X-Idempotency-Key` header. Stateful — reads + clears the cart.
 *
 * Hard rules (pinned by spec):
 *
 *   1. List-price enforcement: the outgoing `unitPriceCents` is the
 *      PERSISTED cart's value (`originalPriceCents` from the previous
 *      `evaluateCart`), never the model's input nor `finalPriceCents`.
 *
 *   2. Idempotency key: client-side UUID v4 (`crypto.randomUUID()`).
 *      - First attempt: mint + persist on cart.
 *      - Retry within the session: reuse the persisted key.
 *      - Success: clear the cart (items + key + expectedTotalCents).
 *      - PROMO_RE_QUOTE: clear the key (payload changed) AND replace
 *        `expectedTotalCents` with the backend's `recomputedTotalCents`
 *        so the next customer-acceptance call (a fresh UUID + the
 *        recomputed total on the wire) cannot loop on the stale total.
 *        Items are preserved. When the PROMO_RE_QUOTE body is malformed
 *        (any of `recomputedTotalCents`, `expectedTotalCents`, or
 *        `discountCents` is missing or not a non-negative integer — the
 *        same shape `mapChatbotError`'s `readPromoPayload` validates)
 *        the cart does NOT adopt a fabricated value — items + prior
 *        `expectedTotalCents` stay intact, only the key is cleared
 *        (R-D2 / ADR-5: never invent totals). The durable replacement
 *        happens ONLY when the SAME mapped result returned to the
 *        caller is `{error.kind:'promoReQuote', ...}` from the canonical
 *        parser — state mutation and returned envelope can never
 *        disagree.
 *      - IDEMPOTENCY_KEY_CONFLICT: clear the key (the key is poisoned);
 *        preserve items + the current `expectedTotalCents` (the conflict
 *        is unrelated to the total).
 *      - IDEMPOTENCY_KEY_IN_FLIGHT: preserve the key (same payload, retry
 *        later).
 *      - Success: clear the cart (items + key + expectedTotalCents) AND
 *        SET `data.placedSaleId = sale.saleId` (used by `cancelSale`).
 *        Both happen in ONE atomic `ConversationStore.update` via
 *        `persistConfirmedSale` (ADR-13; cancel-endpoint-conversational).
 *      The backend's `SaleIdempotency` table keys on the header value,
 *      so a stable client UUID is enough — no env var needed.
 *
 *   3. `cashierUserId` is INJECTED from `deps.cashierUserId`
 *      (sourced from `CHATBOT_API_CASHIER_USER_ID`). The model can never
 *      pick this id.
 *
 *   4. Empty cart guard: if the persisted cart has no items (model
 *      called createSale before evaluateCart populated the cart), return
 *      a `validation` envelope — never an empty HTTP call.
 *
 *   5. Line mismatch: if the model passes fewer `items` than the
 *      persisted cart holds, treat it as a bad payload (validation).
 *      `productName` / `variantName` are borrowed from the model's
 *      matched input line (the backend requires `productName`).
 *
 *   6. `expectedTotalCents` is sourced from the persisted cart, NEVER
 *      from the model's input. The wire omits the key when the cart has
 *      none (legacy carts). The HTTP client normalises this via the
 *      `CreateSaleInputSchema` — the tool just forwards the cart value.
 *
 *   7. The error→cart-mutation side effect is owned here, NOT in
 *      `mapChatbotError`: the mapper is pure (no store / senderId) and
 *      `createSale` re-inspects `err.errorCode` for the cart write.
 *
 *   8. On success, the tool persists `data.cart = EMPTY_CART` AND
 *      `data.placedSaleId = sale.saleId` atomically via
 *      `persistConfirmedSale` (single `ConversationStore.update`).
 *      A new `createSale` overwrites any prior `placedSaleId`;
 *      `cancelSale` reads / clears it (cancel-endpoint-conversational).
 *
 * `contextSchema: { senderId }` is the per-tool runtime seam; the
 * sender id never enters the prompt.
 */
export function makeCreateSaleTool(deps: ToolDeps) {
  return tool({
    description:
      'Registra la venta. Envía expectedTotalCents desde el carrito (NO desde el modelo). Usa una UUID v4 como X-Idempotency-Key (generada la primera vez, reusada en retries, rotada en promoReQuote/conflict, preservada en in-flight, limpiada en éxito). El cashierUserId se inyecta del servidor.',
    inputSchema: z.object({
      customerId: z.uuid(),
      shippingAddressId: z.uuid().nullish(),
      items: z
        .array(
          z.object({
            productId: z.uuid(),
            variantId: z.uuid().nullish(),
            productName: z.string().min(1),
            variantName: z.string().nullish(),
            quantity: z.number().int().min(1),
            unitPriceCents: z.number().int().min(0),
          }),
        )
        .min(1),
    }),
    contextSchema: z.object({ senderId: z.string() }),
    execute: async (input, options) => {
      const senderId = options.context.senderId;

      // 1) Load cart from the durable store.
      const state = await deps.store.get(senderId);
      const cart = readCart(state);

      // 2) Empty-cart guard.
      if (cart.items.length === 0) {
        return {
          ok: false as const,
          error: { kind: 'validation' as const, retryable: false },
        };
      }

      // 3) Idempotency key: mint + persist on first attempt, reuse on retry.
      let idempotencyKey = cart.idempotencyKey;
      if (idempotencyKey === '') {
        idempotencyKey = randomUUID();
        const persisted = writeCart(state, {
          ...cart,
          idempotencyKey,
        });
        await persistCart(deps.store, senderId, state, persisted);
      }

      // 4) List-price enforcement: build the outgoing body from the
      //    persisted cart. Borrow productName/variantName from the
      //    model's input lines, matched by productId (+ variantId).
      const items: Array<{
        productId: string;
        variantId: string | null;
        productName: string;
        variantName: string | null;
        quantity: number;
        unitPriceCents: number;
      }> = [];
      for (const ci of cart.items) {
        const match = input.items.find(
          (li) =>
            li.productId === ci.productId &&
            (li.variantId ?? null) === (ci.variantId ?? null),
        );
        if (!match) {
          // Line mismatch — refuse (validation), never call the backend
          // with an incomplete body.
          return {
            ok: false as const,
            error: { kind: 'validation' as const, retryable: false },
          };
        }
        items.push({
          productId: ci.productId,
          variantId: ci.variantId ?? null,
          productName: match.productName,
          variantName: match.variantName ?? null,
          quantity: ci.quantity,
          unitPriceCents: ci.unitPriceCents, // list price, NOT finalPriceCents
        });
      }

      // 5) Outgoing DTO — cashierUserId is injected from deps; the
      //    top-level `expectedTotalCents` is forwarded only when the
      //    persisted cart carries it (legacy carts omit the key).
      const dto: Parameters<typeof deps.chatbotApi.createSale>[0] = {
        cashierUserId: deps.cashierUserId,
        customerId: input.customerId,
        shippingAddressId: input.shippingAddressId ?? null,
        items,
        ...(cart.expectedTotalCents !== undefined
          ? { expectedTotalCents: cart.expectedTotalCents }
          : {}),
      };

      try {
        const sale = await deps.chatbotApi.createSale(dto, idempotencyKey);
        // 6) Atomic cart clear + placedSaleId set (ONE store.update
        //    write). Replaces the old persistCart(EMPTY_CART) flow.
        //    EMPTY_CART leaves the optional `expectedTotalCents` field
        //    absent — backwards-compatible with legacy readers.
        await persistConfirmedSale(deps.store, senderId, state, sale.saleId);
        return { ok: true as const, ...sale };
      } catch (err) {
        // Single source of truth: call the canonical mapper once and
        // drive BOTH the cart mutation AND the returned envelope from
        // the SAME result. State mutation and envelope MUST agree: a
        // durable `expectedTotalCents` replacement only happens when the
        // mapper accepted the payload and returned a `promoReQuote`
        // envelope. For every other error kind (including a malformed
        // PROMO_RE_QUOTE body the mapper rejects) we never invent a
        // total — items + prior `expectedTotalCents` stay intact and
        // only the `idempotencyKey` is cleared when the key is unsafe
        // to reuse (R-D2 / ADR-5).
        //
        // The mapper rethrows non-ChatbotApiError; assigning its result
        // never completes in that case, so the cart-switch below is
        // naturally skipped.
        const result = mapChatbotError(err);
        if (err instanceof ChatbotApiError) {
          switch (err.errorCode) {
            case 'PROMO_RE_QUOTE':
              if (result.error.kind === 'promoReQuote') {
                // Backend rejected the stale total and the payload was
                // well-formed: persist the recomputed total so the
                // customer-acceptance retry sends 900 (not the stale
                // 1000), and clear the key so that retry mints a fresh
                // UUID v4. Items stay intact (the customer's order
                // survives). The recomputed value is read off the
                // canonical `result.error.recomputedTotalCents` — no
                // duplicated payload validation here.
                await persistCart(deps.store, senderId, state, {
                  ...cart,
                  idempotencyKey: '',
                  expectedTotalCents: result.error.recomputedTotalCents,
                });
              } else {
                // Malformed PROMO_RE_QUOTE body — the mapper fell
                // through to status mapping. We DO NOT fabricate a
                // total: items + prior `expectedTotalCents` stay
                // intact and only the key is cleared (the payload
                // still changed, so the prior key is unsafe to reuse).
                await persistCart(deps.store, senderId, state, {
                  ...cart,
                  idempotencyKey: '',
                });
              }
              break;
            case 'IDEMPOTENCY_KEY_CONFLICT':
              // Key is poisoned (backend saw this key with a different
              // payload). Clear the key, but preserve items + the
              // current `expectedTotalCents` — the conflict is
              // unrelated to the total.
              await persistCart(deps.store, senderId, state, {
                ...cart,
                idempotencyKey: '',
              });
              break;
            case 'IDEMPOTENCY_KEY_IN_FLIGHT':
            case 'PRICE_OUT_OF_DATE':
            case 'INVALID_IDEMPOTENCY_KEY':
            default:
              // Preserve the key (retry the same call later) — no write.
              break;
          }
        }
        return result;
      }
    },
  });
}

// Re-export CartState type so the file is self-contained for imports.
export type { CartState };
