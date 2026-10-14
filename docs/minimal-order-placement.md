# Minimal order placement

`MinimalOrderService` lets an allowlisted WhatsApp customer turn the minimal cart into a **real backend ONLINE sale** after explicit consent, then sends the transfer payment details.

It is **off by default** and not ready for production. Optional [minimal shipping](minimal-shipping.md) now quotes and binds approved freight. Placement can go through the backend atomic checkout behind its own default-off switch ([below](#atomic-checkout-switch)); that backend endpoint is not deployed yet, and production shipping prerequisites remain unresolved.

## Enable it (test environments only)

| Variable                                  | Required value        | Why                                                                                               |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `MINIMAL_CATALOG_AGENT_ENABLED`           | `true`                | The minimal SDK route itself.                                                                     |
| `MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS`   | test senders          | Only these WhatsApp senders reach the route.                                                      |
| `MINIMAL_CATALOG_ORDER_ENABLED`           | `true`                | Exposes `prepareOrder`; any other value keeps it hidden.                                          |
| `CHATBOT_API_CASHIER_USER_ID`             | bot cashier `User.id` | Server-owned `cashierUserId`; empty disables ordering.                                            |
| `MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED` | `true` (optional)     | Places orders via `POST /chatbot-api/checkouts`; any other value keeps `POST /chatbot-api/sales`. |

The store must implement `commitMinimalCart` and `commitMinimalCheckoutDraft`.

## Who can order in this slice

- A **unique** registered customer, found by the trusted WhatsApp number.
- A **saved** address, selected and confirmed through the checkout flow (`docs/minimal-checkout-coordinator.md`).
- A non-empty cart whose promotions are fully evaluated.

New customers and new addresses get a clear "not yet" reply. This route never calls customer upsert or address mutations.

## Flow

1. The model calls `prepareOrder` (no arguments).
2. The server re-checks everything fresh:
   - the confirmed delivery data still equals the current draft, byte for byte;
   - the saved address still has the same `version` upstream;
   - prices and stock come from a new cart evaluation.
3. The server replies with its own summary: items, product total, delivery address and "shipping not included" when shipping is off. With [minimal shipping](minimal-shipping.md) enabled, a fresh approved quote is required and the summary includes freight and total, or "envío cubierto por su compra". It is armed only after the transport sends it.
4. Only a strict `SÍ` from the same sender and receiving phone creates the sale, and only as the very next reply to the summary (within 5 minutes). Any other turn — a mixed answer, a question, a RESTOCK or delivery confirmation — drops the summary, and so does a `SÍ` that is refused (from another phone, or before the summary was sent) or a message rejected because a reply is still in progress; a later `SÍ` never creates it. The order is re-checked again; if anything changed, the customer gets a new summary instead of a sale.
5. On success: the reply has the folio, the backend total and the transfer details. The cart is cleared and the sale is recorded as `placedSale`.

## Duplicate protection

The `X-Idempotency-Key` is a UUID stored in the `minimalCart` slot through its CAS **before** `POST /chatbot-api/sales`, together with a SHA-256 fingerprint of the exact sale payload (customer, address, expected total, items and any approved shipping charge).

| Backend outcome                                                                                          | Key                   | Reply                                   |
| -------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------- |
| Created                                                                                                  | cleared with the cart | folio + total + payment details         |
| `PROMO_RE_QUOTE`, other definite 4xx (not 408/429) on the **first** attempt                              | rotated               | "no se pudo crear el pedido"            |
| Same definite rejection on a **later** attempt (an earlier one was uncertain)                            | kept                  | "comuníquese con la tienda"             |
| `IDEMPOTENCY_KEY_IN_FLIGHT`, `IDEMPOTENCY_KEY_CONFLICT`, 408, 429, 5xx, network error, malformed success | kept                  | "no pude confirmar si quedó registrado" |

A retry reuses the kept key only when the new payload has the same fingerprint. If the payload changed while a key is outstanding (another saved address, a promotion that moves the total), the server sends nothing and replies that an earlier order request could not be confirmed, so it never rotates into a possible duplicate. `IDEMPOTENCY_KEY_CONFLICT` keeps the key because the backend already saw it with another payload, so a sale may exist under it.

The slot also keeps `idempotencyAttempts`, written through the CAS **before** each call. A definite rejection proves only that this call created nothing, so it rotates the key only on the first attempt.

### Uncertain outcome locks the order (S7)

While a key is outstanding (any uncertain outcome, or a crash mid-call), the order is locked:

- Only the identical order may be retried. The customer asks for the summary again and replies `SÍ`, and the same key is replayed; the backend never duplicates it.
- Cart changes are refused (`order_unresolved`) and the cart is left untouched.
- A changed payload is held, and a later definite rejection keeps the key. In both cases the customer is asked to contact the store.

The lock ends only with a confirmed sale, or with a definite rejection of the first attempt. A failed payment-details read or a lost post-sale cart write never hides a created order.

### Atomic checkout switch

With `MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED=true` (exact string; anything else is off), `place()` sends one `POST /chatbot-api/checkouts` instead of `POST /chatbot-api/sales`. With it off, the legacy path is unchanged. Launch preflight requires it explicitly `false`: the backend endpoint is committed in `houndfe-backend` but not deployed.

- Same scope as above: customer mode `existing` and deliveryAddress mode `existing` with the confirmed snapshot `version` as `expectedVersion`. Phone comes from the trusted WhatsApp sender. New customers/addresses are still out of scope.
- The fingerprint covers the exact checkout payload (including any approved shipping charge); key, attempts counter and the S7 lock work as above, with one POST per consent.
- **Recovery:** before replaying an outstanding key with the same fingerprint, the server reads `GET /chatbot-api/checkouts/status` for that key (a status read is not counted as an attempt):

  | Status                       | Action                                                                            |
  | ---------------------------- | --------------------------------------------------------------------------------- |
  | `succeeded` with a sale      | Treated as the created order: cart cleared, `placedSale`, success reply; no POST. |
  | `not_observed`               | Same payload replayed with the **same** key (never a fresh one).                  |
  | anything else, or read fails | Lock kept; "no pude confirmar si quedó registrado".                               |

- Errors: `CHECKOUT_RETRY_REQUIRED` keeps the key. `ADDRESS_VERSION_CONFLICT` is a definite rejection that asks the customer to re-select and confirm their delivery data. Other codes follow the table above.

## Reply priority in one SDK run

EXPIRATION > RESTOCK > checkout, order or optional shipping presentation (after any cart acknowledgement) > cart reply > model text.

Before the SDK runs, a `SÍ` is checked against RESTOCK, then the delivery confirmation, then the order summary.

## Not in this slice

- Shipping quotes, charges and approval are a separate default-off capability: [minimal shipping](minimal-shipping.md).
- Customer and address creation (backend proposal pending owner decision).
- Order cancellation from the minimal route.

## Check

```sh
node_modules/.bin/jest src/llm-agent/domain/minimal-order-confirmation.spec.ts \
  src/llm-agent/application/minimal-order.service.spec.ts \
  src/llm-agent/application/minimal-order.sdk.spec.ts \
  src/chatbot-api/domain/dtos/checkout.dto.spec.ts \
  src/chatbot-api/infrastructure/chatbot-api-http.checkout.spec.ts
```
