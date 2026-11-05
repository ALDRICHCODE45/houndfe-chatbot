# Minimal home-delivery shipping

This minimal SDK capability is **off by default**. The backend quotes shipping
(`POST /chatbot-api/shipping/quotes`): it picks the cheapest carrier, applies
the shipping credit and signs a `quoteId` that expires. The chatbot shows the
backend's amounts verbatim and sends that `quoteId` on checkout. There is no
per-quote human approval. It does not offer store pickup yet.

## Enable only in controlled test environments

The minimal route and order capability are always on (see [minimal order placement](minimal-order-placement.md)); they need the bot cashier. Then configure:

| Variable                           | Value / requirement                     |
| ---------------------------------- | --------------------------------------- |
| `MINIMAL_CATALOG_SHIPPING_ENABLED` | Exact `true`; every other value is off. |

Restart after changing the gate. The minimal tool is exposed only when its gate, service and order capability are available. Gate off adds no shipping tool or instruction fragment. The Skydropx provider, measured parcel profile and `SHIPPING_QUOTES_ENABLED` are no longer used by the minimal route (task U6 removes them and their preflight checks).

## Customer flow

1. Build a verified cart, select a saved address or give a new one, and confirm delivery data through the [checkout coordinator](minimal-checkout-coordinator.md). Orders to a new address go through the [atomic checkout](minimal-order-placement.md#atomic-checkout).
2. Ask for home delivery. The model calls `requestShippingQuote({})`; the server uses only the trusted sender and the confirmed address: the saved-address snapshot, or the exact confirmed destination of a new or corrected saved address (editing street, exterior or interior number, ZIP code, neighborhood, municipality, city or state makes the quote stale; label, visual references and carrier phone do not). Arguments containing identity or amounts are rejected.
3. The server makes one backend quote call with the cart lines (product, variant, quantity), the customer phone and the destination: `{shippingAddressId}` for a saved address, loose address fields for a new or corrected one. The answer is stored verbatim in `minimalCart.shipping` under one cart CAS, pinned to the cart lines and the confirmed destination. No order is created.
4. The application tells the customer the result: cost, credit and amount to pay (or **“cubierto por su compra”**), a zone still being validated (`PENDING`), no home delivery for that ZIP (`DENIED`), missing packaging data, or quote unavailable. A `STOCK_PENDING` ETA says the delivery date depends on restock. The model never authors amounts or order claims.
5. The customer requests the order summary (`prepareOrder`). Its server-owned summary includes the backend charge and the charge-inclusive total, or **“envío cubierto por su compra”** when the charge is zero.
6. A single order-summary `SÍ`, as the next reply after the summary was sent, consents to the entire order including shipping. There is no separate shipping-acceptance `SÍ`. Delivery-data confirmation earlier is distinct from order consent.

A `savedCorrected` draft quotes the corrected ZIP and other location fields,
never its stale base snapshot. Its quote destination is a location fingerprint
(`kind: 'new'`), just like a confirmed new address. Changes require delivery
reconfirmation and, when location fields change, a new quote.
Orders with corrections go through the atomic checkout; the original
saved id/version is still revalidated before quoting and ordering.

Shipping shares the one-presentation-per-SDK-run slot with delivery confirmation and order summaries: the first attempt wins, including a refusal. Reply priority remains EXPIRATION > RESTOCK > checkout/order/shipping presentation (after any cart acknowledgement) > cart reply > model text. An unsent summary remains unarmed.

## Quote validity

- The backend computes the credit ($120 MXN per unit whose discounted price is above $500; credits sum) and `customerChargeCents = max(0, cost − credit)`. The chatbot never recomputes it.
- A delivery order needs a stored quote with zone `FREE`, `SURCHARGE` or `CARRIER_ONLY`, a non-null `quoteId`, `expiresAt` still in the future, and cart and destination pins matching the current cart and confirmed address. Otherwise the customer is asked to quote shipping again.
- The checkout sends `sale.shipping = {quoteId}` and `expectedTotalCents = products + customerChargeCents`; the quote id and charge are part of the order fingerprint, so a requote spends consent and re-presents the summary.
- Checkout rejections `SHIPPING_QUOTE_EXPIRED`, `SHIPPING_QUOTE_MISMATCH` and `SHIPPING_QUOTE_NOT_FOUND` create nothing and ask for a new quote.
- Legacy records with an `approval` sub-object still parse but never back an order (task U5 deletes the approval flow).

## Not ready for production

- **Store pickup and zone follow-up:** `PENDING`/`DENIED` replies, pickup and the DELIVERY_ZONE decision cycle are tasks U4/U7.
- Cart CAS and WhatsApp delivery are not one transaction; partial failures may require reconciliation.

No live backend/WhatsApp calls are needed for validation:

```sh
pnpm test --runTestsByPath src/llm-agent/application/minimal-shipping.sdk.spec.ts
```
