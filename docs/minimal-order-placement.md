# Minimal order placement

`MinimalOrderService` lets an allowlisted WhatsApp customer turn the minimal cart into a **real backend ONLINE sale** after explicit consent, then sends the transfer payment details.

It is **off by default**. It is not ready for production: shipping is not quoted or charged yet.

## Enable it (test environments only)

| Variable                                | Required value        | Why                                                      |
| --------------------------------------- | --------------------- | -------------------------------------------------------- |
| `MINIMAL_CATALOG_AGENT_ENABLED`         | `true`                | The minimal SDK route itself.                            |
| `MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS` | test senders          | Only these WhatsApp senders reach the route.             |
| `MINIMAL_CATALOG_ORDER_ENABLED`         | `true`                | Exposes `prepareOrder`; any other value keeps it hidden. |
| `CHATBOT_API_CASHIER_USER_ID`           | bot cashier `User.id` | Server-owned `cashierUserId`; empty disables ordering.   |

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
3. The server replies with its own summary: items, product total, delivery address and "shipping not included". It is armed only after the transport sends it.
4. Only a strict `SÍ` from the same sender and receiving phone creates the sale, and only as the very next reply to the summary (within 5 minutes). Any other turn — a mixed answer, a question, a RESTOCK or delivery confirmation — drops the summary; a later `SÍ` never creates it. The order is re-checked again; if anything changed, the customer gets a new summary instead of a sale.
5. On success: the reply has the folio, the backend total and the transfer details. The cart is cleared and the sale is recorded as `placedSale`.

## Duplicate protection

The `X-Idempotency-Key` is a UUID stored in the `minimalCart` slot through its CAS **before** `POST /chatbot-api/sales`.

| Backend outcome                                                                | Key                   | Reply                                                                 |
| ------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------- |
| Created                                                                        | cleared with the cart | folio + total + payment details                                       |
| `PROMO_RE_QUOTE`, `IDEMPOTENCY_KEY_CONFLICT`, other definite 4xx (not 408/429) | rotated               | "no se pudo crear el pedido"                                          |
| `IDEMPOTENCY_KEY_IN_FLIGHT`, 408, 429, 5xx, network error, malformed success   | kept                  | "no pude confirmar si quedó registrado"; a retry replays the same key |

Any cart change resets the key. A failed payment-details read or a lost post-sale cart write never hides a created order.

## Reply priority in one SDK run

EXPIRATION > RESTOCK > checkout or order presentation (after any cart acknowledgement) > cart reply > model text.

Before the SDK runs, a `SÍ` is checked against RESTOCK, then the delivery confirmation, then the order summary.

## Not in this slice

- Shipping quotes, charges and approval.
- Customer and address creation (backend proposal pending owner decision).
- Order cancellation from the minimal route.

## Check

```sh
node_modules/.bin/jest src/llm-agent/domain/minimal-order-confirmation.spec.ts \
  src/llm-agent/application/minimal-order.service.spec.ts \
  src/llm-agent/application/minimal-order.sdk.spec.ts
```
