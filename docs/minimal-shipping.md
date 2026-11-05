# Minimal home-delivery shipping

This minimal SDK capability is **always on** (no feature flag). The backend quotes shipping
(`POST /chatbot-api/shipping/quotes`): it picks the cheapest carrier, applies
the shipping credit and signs a `quoteId` that expires. The chatbot shows the
backend's amounts verbatim and sends that `quoteId` on checkout. There is no
per-quote human approval. The customer can also choose store pickup.

## Configuration

Nothing to enable. The minimal route and order capability are always on (see [minimal order placement](minimal-order-placement.md)) and need the bot cashier; the minimal tools (`requestShippingQuote`, `chooseStorePickup`) are exposed whenever the order capability is available. The chatbot holds no carrier credentials: `SHIPPING_QUOTES_ENABLED`, `MINIMAL_CATALOG_SHIPPING_ENABLED`, `SHIPPING_DEMO_PARCEL_PROFILE_JSON` and every `SKYDROPX_*` variable were removed and have no effect if still set.

The service credential needs access to `POST /chatbot-api/shipping/quotes`; its scope is still to be published by the backend (preflight lists it as `TBD by backend`).

## Customer flow

1. Build a verified cart, select a saved address or give a new one, and confirm delivery data through the [checkout coordinator](minimal-checkout-coordinator.md). Orders to a new address go through the [atomic checkout](minimal-order-placement.md#atomic-checkout).
2. Ask for home delivery. The model calls `requestShippingQuote({})`; the server uses only the trusted sender and the confirmed address: the saved-address snapshot, or the exact confirmed destination of a new or corrected saved address (editing street, exterior or interior number, ZIP code, neighborhood, municipality, city or state makes the quote stale; label, visual references and carrier phone do not). Arguments containing identity or amounts are rejected.
3. The server makes one backend quote call with the cart lines (product, variant, quantity), the customer phone and the destination: `{shippingAddressId}` for a saved address, loose address fields for a new or corrected one. The answer is stored verbatim in `minimalCart.shipping` under one cart CAS, pinned to the cart lines and the confirmed destination. No order is created.
4. The application tells the customer the result in server-owned Spanish (the model never authors amounts, carriers, dates or order claims):

   | Result                                     | Customer reply                                                                                                                                                                                |
   | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `FREE`                                     | “Su envío al código postal {CP} no tiene costo.” + ETA line + next step                                                                                                                       |
   | `SURCHARGE` / `CARRIER_ONLY`               | carrier and service when present, cost, “Usted tiene un crédito de $X por sus productos” when the credit is above zero, “Usted paga $Y”, the ETA line, then «hacer pedido» to see the summary |
   | `PENDING` (S5)                             | “Estamos validando la entrega a su código postal {CP}. Le avisamos por aquí en cuanto quede lista; mientras tanto, si prefiere, puede recoger su pedido en tienda.”                           |
   | `DENIED` (S4)                              | “Por ahora no tenemos entrega a su código postal {CP}. Puede recoger su pedido en tienda sin costo de envío. ¿Le parece?”                                                                     |
   | packaging data missing / quote unavailable | honest explanation without any amount; try again later or pick up in store                                                                                                                    |
   | refused (cart, address or order state)     | one customer sentence per reason (for example “Antes de cotizar el envío necesito que confirme sus datos de entrega.”); internal reason codes never reach the customer                        |

   ETA line: “Llega en aproximadamente N días hábiles” from the backend `eta.days` (or `option.etaDays`); with `eta.reason = STOCK_PENDING` (S7): “La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.” No line when the backend gives no ETA.

5. The customer requests the order summary (`prepareOrder`). Its server-owned summary shows the carrier when present, the customer charge (“sin costo para usted” at zero), the credit when above zero, the ETA line and the charge-inclusive total.
6. A single order-summary `SÍ`, as the next reply after the summary was sent, consents to the entire order including shipping. There is no separate shipping-acceptance `SÍ`. Delivery-data confirmation earlier is distinct from order consent.

## Store pickup (S4)

The customer can choose store pickup at any time, and the bot offers it when the zone is `PENDING` or `DENIED`. The model calls `chooseStorePickup({})`; the server verifies the cart with fresh prices and stores `minimalCart.shipping = {mode: "pickup", cartPin}` under one cart CAS (no backend call, replaces any stored quote). It refuses an unresolved earlier order, an empty cart, promotions under review, drifted prices or a concurrent cart edit. Any cart change drops the choice, like a quote.

A pickup order sends `sale.shipping = {mode: "pickup"}` with `expectedTotalCents` = products only, and the summary says “Recoge en tienda (sin costo de envío)” and lists the customer data as “Datos del cliente” instead of “Entrega a”. The checkout contract still requires `deliveryAddress`, so a pickup order still needs confirmed delivery data (the order summary asks for it as usual); the address is saved with the order but nothing is shipped.

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
- Checkout rejections (S6) create nothing and rotate the key on a first attempt. `SHIPPING_QUOTE_EXPIRED` and `SHIPPING_QUOTE_MISMATCH` trigger one automatic re-quote and present the updated summary for a fresh `SÍ` (if the re-quote is not deliverable, the customer is asked to quote shipping again). `SHIPPING_QUOTE_NOT_FOUND`, `PACKAGING_DATA_MISSING` and a 4xx `SHIPPING_QUOTE_UNAVAILABLE` get their own replies; a 5xx stays an uncertain outcome that keeps the key.
- A delivery order without a current quote or pickup choice gets: “Antes del resumen necesito saber cómo recibirá su pedido: dígame «cotizar envío» … o «recoger en tienda» …”.

## Not ready for production

- **Zone follow-up:** the bot says a `PENDING` zone is being validated, but learning the decision (DELIVERY_ZONE cycle) and re-quoting is task U7.
- Cart CAS and WhatsApp delivery are not one transaction; partial failures may require reconciliation.

No live backend/WhatsApp calls are needed for validation:

```sh
pnpm test --runTestsByPath src/llm-agent/application/minimal-shipping.sdk.spec.ts
```
