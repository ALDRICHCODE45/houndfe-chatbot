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
 *      - PROMO_RE_QUOTE: clear the key (payload changed); preserve items +
 *        expectedTotalCents; the next customer-acceptance call mints fresh.
 *      - IDEMPOTENCY_KEY_CONFLICT: clear the key (the key is poisoned).
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
        // Q3 errorCode-first cart-mutation policy: re-inspect the error
        // here because mapChatbotError has no access to the store.
        // (ADR-9 — the mapper is pure; the tool owns cart writes.)
        if (err instanceof ChatbotApiError) {
          switch (err.errorCode) {
            case 'PROMO_RE_QUOTE':
            case 'IDEMPOTENCY_KEY_CONFLICT':
              // Payload changed (promo) or key poisoned (conflict) — clear
              // the key so the next call mints fresh. Preserve items +
              // expectedTotalCents so the customer's intent survives.
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
        return mapChatbotError(err);
      }
    },
  });
}

// Re-export CartState type so the file is self-contained for imports.
export type { CartState };
