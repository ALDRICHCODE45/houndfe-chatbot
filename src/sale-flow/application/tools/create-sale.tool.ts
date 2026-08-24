import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolDeps } from '../tool-deps';
import { mapChatbotError } from '../error-mapping';
import { persistCart } from '../cart-persistence';
import {
  EMPTY_CART,
  readCart,
  writeCart,
  type CartState,
} from '../../domain/cart-state';

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
 *      - Success: clear the cart (items + key).
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
 * `contextSchema: { senderId }` is the per-tool runtime seam; the
 * sender id never enters the prompt.
 */
export function makeCreateSaleTool(deps: ToolDeps) {
  return tool({
    description:
      'Registra la venta al precio de lista (NO al precio con descuento). Usa una UUID v4 como X-Idempotency-Key (generada la primera vez, reusada en retries, limpiada en éxito). El cashierUserId se inyecta del servidor.',
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

      // 5) Outgoing DTO — cashierUserId is injected from deps.
      const dto = {
        cashierUserId: deps.cashierUserId,
        customerId: input.customerId,
        shippingAddressId: input.shippingAddressId ?? null,
        items,
      };

      try {
        const sale = await deps.chatbotApi.createSale(dto, idempotencyKey);
        // 6) Clear cart on success (includes idempotency key).
        const cleared: CartState = { items: [], idempotencyKey: '' };
        await persistCart(deps.store, senderId, state, cleared);
        // Touch EMPTY_CART to keep the import non-removable (compile guard).
        void EMPTY_CART;
        return { ok: true as const, ...sale };
      } catch (err) {
        return mapChatbotError(err);
      }
    },
  });
}
