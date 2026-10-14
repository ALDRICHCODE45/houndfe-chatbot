# Minimal home-delivery shipping

This experimental minimal SDK capability is **off by default** and **not production-ready**. It quotes through Skydropx internally, applies the shipping credit, and requests human approval of **every** quote, including free shipping. It does not offer store pickup.

## Enable only in controlled test environments

Enable the minimal route and order capability described in [minimal order placement](minimal-order-placement.md), including the sender allowlist and bot cashier. Then configure:

| Variable | Value / requirement |
| --- | --- |
| `MINIMAL_CATALOG_SHIPPING_ENABLED` | Exact `true`; every other value is off. |
| `SHIPPING_QUOTES_ENABLED` | Exact `true`; makes the provider port available. |
| `HUMAN_HANDOFF_ENABLED` | `true`; operations approval must be available. |
| `OPS_CHANNEL_PHONE` | Authorized operations-channel recipient. |
| Skydropx configuration | Owner-approved sandbox credentials and authoritative branch origin. |
| `SHIPPING_DEMO_PARCEL_PROFILE_JSON` | Valid measured profile matching the exact cart. |

Restart after changing gates. There is still one `ShippingModule.forRoot()` composition root. The minimal tool is exposed only when its gate, service and order capability are available. Gate off or service absent adds no shipping tool or instruction fragment. Launch preflight requires both shipping gates explicitly `false`; omission is not a launch-safe posture.

## Customer flow

1. Build a verified cart, select a saved address, and confirm delivery data through the [checkout coordinator](minimal-checkout-coordinator.md). New customers/addresses are not supported for ordering here.
2. Ask for home delivery. The model calls `requestShippingQuote({})`; the server uses only the trusted sender and confirmed saved-address snapshot. Arguments containing identity or amounts are rejected.
3. The server quotes internally and requests operations approval. The immediate reply contains **no amounts**, and no order is created. The operations channel receives the approval digest. Pending requests do not issue duplicate quotes.
4. An operations decision approves that exact, current quote. Only then does the application disclose the freight. The model never authors amounts, approvals or order claims.
5. The customer requests the order summary (`prepareOrder`). Its server-owned summary includes freight and the freight-inclusive total, or **“envío cubierto por su compra”** when the credit covers shipping.
6. A single order-summary `SÍ`, as the next reply after the summary was sent, consents to the entire order including shipping. There is no separate shipping-acceptance `SÍ`. Delivery-data confirmation earlier is distinct from order consent.

Shipping shares the one-presentation-per-SDK-run slot with delivery confirmation and order summaries: the first attempt wins, including a refusal. Reply priority remains EXPIRATION > RESTOCK > checkout/order/shipping presentation (after any cart acknowledgement) > cart reply > model text. An unsent summary remains unarmed.

## Approval, expiry and rejection

- Every quote requires human approval before customer disclosure. Credit is $120 MXN per unit priced **above** $500; credits sum. The customer pays `max(0, best rate − credit)`.
- Free shipping still requires approval; the order payload omits a shipping charge.
- Approval expires at the earliest of 30 minutes from quote creation and provider/rate validity. Expiry is **lazy on the next customer inbound**, not a scheduled proactive notification. The matching pending request is cleared; the customer is told shipping could not be confirmed and may ask again. Late operations decisions fail closed.
- Rejection offers another quote, for example using another saved address. It creates no order.
- Cart, address, quote or approval changes invalidate the summary. Before placement the application revalidates the approved charge, includes charged freight in the fingerprinted idempotency payload, and preserves the existing uncertain-outcome lock.

## Not ready for production

- **Arbitrary-cart packing:** current quoting reuses a measured-demo profile and only accepts exactly configured carts. Real product/variant weights and dimensions are missing (`packageInfo` is currently null). Never infer measurements (task log L11).
- **Backend checkout wiring:** `MinimalOrderService` still calls `POST /chatbot-api/sales`. Shipping persistence on that legacy endpoint is not a deployed contract. The new `POST /chatbot-api/checkouts` and status client exist but are **not wired into this order flow**. Resolve backend charge persistence and atomic-checkout integration before activation.
- **Delivery zones:** free-zone/surcharge/carrier-only policy, including CDMX service selection, remains unresolved.
- Cart CAS, handoff lifecycle/reservation closure and WhatsApp delivery are not one transaction; partial failures may require reconciliation.

No live Skydropx/WhatsApp calls are needed for validation:

```sh
node_modules/.bin/jest src/llm-agent/application/minimal-shipping.sdk.spec.ts
```
