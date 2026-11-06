# Minimal home-delivery shipping

This minimal SDK capability is **always on** (no feature flag). The backend quotes shipping
(`POST /chatbot-api/shipping/quotes`): it picks the cheapest carrier, applies
the shipping credit and signs a `quoteId` that expires. The chatbot shows the
backend's amounts verbatim and sends that `quoteId` on checkout. There is no
per-quote human approval. The customer can also choose store pickup.

## Configuration

Nothing to enable. The minimal route and order capability are always on (see [minimal order placement](minimal-order-placement.md)) and need the bot cashier; the minimal tools (`requestShippingQuote`, `chooseStorePickup`) are exposed whenever the order capability is available. The chatbot holds no carrier credentials: `SHIPPING_QUOTES_ENABLED`, `MINIMAL_CATALOG_SHIPPING_ENABLED`, `SHIPPING_DEMO_PARCEL_PROFILE_JSON` and every `SKYDROPX_*` variable were removed and have no effect if still set.

The service credential needs the `shipping:quote` scope for `POST /chatbot-api/shipping/quotes` (contract: [docs/contracts/shipping-quotes.md](contracts/shipping-quotes.md)); preflight lists the route with that scope.

## Customer flow

1. Build a verified cart, select a saved address or give a new one, and confirm delivery data through the [checkout coordinator](minimal-checkout-coordinator.md). Orders to a new address go through the [atomic checkout](minimal-order-placement.md#atomic-checkout).
2. Ask for home delivery. The model calls `requestShippingQuote({})`; the server uses only the trusted sender and the confirmed address: the saved-address snapshot, or the exact confirmed destination of a new or corrected saved address (editing street, exterior or interior number, ZIP code, neighborhood, municipality, city or state makes the quote stale; label, visual references and carrier phone do not). Arguments containing identity or amounts are rejected.
3. The server makes one backend quote call with the cart lines (product, variant, quantity), the customer phone and the destination: `{shippingAddressId}` for a saved address, or exactly `{zipCode, state, municipality, neighborhood}` for a new or corrected one (`municipality` falls back to `city`; street and numbers are not sent). A loose destination missing any of the four fields is refused before the call. The answer is stored verbatim in `minimalCart.shipping` under one cart CAS, pinned to the cart lines and the confirmed destination. No order is created.
4. The application tells the customer the result in server-owned Spanish (the model never authors amounts, carriers, dates or order claims):

   | Result                                     | Customer reply                                                                                                                                                                                |
   | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `FREE`                                     | “Su envío al código postal {CP} no tiene costo.” + ETA line + next step                                                                                                                       |
   | `SURCHARGE` / `CARRIER_ONLY`               | carrier and service when present, cost, “Usted tiene un crédito de $X por sus productos” when the credit is above zero, “Usted paga $Y”, the ETA line, then «hacer pedido» to see the summary |
   | `PENDING` (S5)                             | “Estamos validando la entrega a su código postal {CP}. Le avisamos por aquí en cuanto quede lista; mientras tanto, si prefiere, puede recoger su pedido en tienda.”                           |
   | `DENIED` (S4)                              | “Por ahora no tenemos entrega a su código postal {CP}. Puede recoger su pedido en tienda sin costo de envío. ¿Le parece?”                                                                     |
   | `PRICE_OUT_OF_DATE`                        | the cart prices changed: ask to see the cart for the updated prices, then quote again                                                                                                         |
   | `PRODUCT_NOT_FOUND` / `VARIANT_NOT_FOUND` / `DUPLICATE_CART_LINE` | a cart product is no longer available that way: fix the cart (choose the product or presentation again, or remove it) and ask for shipping again                         |
   | `SHIPPING_ADDRESS_NOT_FOUND` / `SHIPPING_ADDRESS_INCOMPLETE` / `INVALID_SHIPPING_DESTINATION` | ask the customer to confirm or correct the delivery address                                                                                       |
   | `CUSTOMER_PHONE_AMBIGUOUS`                 | the order phone-ambiguous reply (contact the store)                                                                                                                                           |
   | `PACKAGING_DATA_MISSING` / `NO_SHIPPING_BOX_FITS` / `SHIPPING_ORIGIN_NOT_CONFIGURED` / `SHIPPING_QUOTE_UNAVAILABLE` (503, also CARRIER_ONLY until the backend has the Skydropx adapter) / anything else | honest explanation without any amount; try again later or pick up in store |
   | refused (cart, address or order state)     | one customer sentence per reason (for example “Antes de cotizar el envío necesito que confirme sus datos de entrega.”); internal reason codes never reach the customer                        |

   The backend always sends `eta: {days, reason}` with `reason` null or `STOCK_PENDING`. `FREE` and `SURCHARGE` have `option: null`; `CARRIER_ONLY` has a carrier option. `PENDING` and `DENIED` carry `quoteId: null`, `expiresAt: null` and zero amounts (the backend stores nothing); any other shape fails closed. Internal codes never reach the customer.

   ETA line: “Llega en aproximadamente N días hábiles” from the backend `eta.days` (or `option.etaDays`); with `eta.reason = STOCK_PENDING` (S7): “La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.” No line when the backend gives no ETA.

5. The customer requests the order summary (`prepareOrder`). Its server-owned summary shows the carrier when present, the customer charge (“sin costo para usted” at zero), the credit when above zero, the ETA line and the charge-inclusive total.
6. A single order-summary `SÍ`, as the next reply after the summary was sent, consents to the entire order including shipping. There is no separate shipping-acceptance `SÍ`. Delivery-data confirmation earlier is distinct from order consent.

## Store pickup (S4)

The customer can choose store pickup at any time, and the bot offers it when the zone is `PENDING` or `DENIED`. The model calls `chooseStorePickup({})`; the server verifies the cart with fresh prices and stores `minimalCart.shipping = {mode: "pickup", cartPin}` under one cart CAS (no backend call, replaces any stored quote). It refuses an unresolved earlier order, an empty cart, promotions under review, drifted prices or a concurrent cart edit. A change of products or quantities drops the choice. A price or promotion change keeps it (pickup has no price-dependent charge): the order re-presents the updated summary with “Su pedido cambió desde el último resumen …” for a fresh `SÍ`.

A pickup order sends `sale.shipping = {mode: "pickup"}` with `expectedTotalCents` = products only, and the summary says “Recoge en tienda (sin costo de envío)” and lists the customer data as “Datos del cliente” instead of “Entrega a”. A pickup order needs **no delivery data**: no address and no delivery confirmation. The summary only needs the customer identity, read by a fresh sender-bound `GET /customers/checkout-context`: a unique registered customer is sent as `customer: {mode: "existing", customerId}`; with no registered customer, the name from the local checkout draft (the model saves it with `updateCheckoutDetails`, `firstName`/`lastName` only) is sent as `customer: {mode: "createIfAbsent", firstName, lastName?}` with the top-level `phoneCountryCode`/`phone`. The checkout never carries `deliveryAddress` for pickup. Without a name the bot asks only for the name; an ambiguous phone gets the contact-the-store reply; a failed lookup asks to retry.

After a pickup order is created, the order-created message adds the backend `pickupLocation`: “Recójalo en {name}: {address.formatted}.” and, when hours are configured, “Horario: {hours.summary}”. A null address prints only “Recójalo en {name}.”; null hours or a missing `pickupLocation` omit those parts (nothing is invented). The same applies to an order recovered through `GET /checkouts/status`, which returns the cached checkout body.

A `savedCorrected` draft quotes the corrected ZIP and other location fields,
never its stale base snapshot. Its quote destination is a location fingerprint
(`kind: 'new'`), just like a confirmed new address. Changes require delivery
reconfirmation and, when location fields change, a new quote.
Orders with corrections go through the atomic checkout; the original
saved id/version is still revalidated before quoting and ordering.

Shipping shares the one-presentation-per-SDK-run slot with delivery confirmation and order summaries: the first attempt wins, including a refusal. Reply priority remains EXPIRATION > RESTOCK > checkout/order/shipping presentation (after any cart acknowledgement) > cart reply > model text. An unsent summary remains unarmed.

## Quote validity

- The backend computes the credit ($120 MXN per unit whose discounted price is above $500; credits sum) and `customerChargeCents = max(0, cost − credit)`. The chatbot never recomputes it.
- A delivery order needs a stored quote with zone `FREE`, `SURCHARGE` or `CARRIER_ONLY`, a non-null `quoteId`, `expiresAt` still in the future, and cart and destination pins matching the current cart (including prices, since the credit depends on them) and confirmed address. Otherwise the customer is asked to quote shipping again.
- The checkout sends `sale.shipping = {quoteId}` and `expectedTotalCents = products + customerChargeCents`; the quote id and charge are part of the order fingerprint, so a requote spends consent and re-presents the summary.
- Checkout rejections (S6) create nothing and rotate the key on a first attempt. `SHIPPING_QUOTE_EXPIRED`, `SHIPPING_QUOTE_MISMATCH` (when `mismatches[]` has only `LINES`/`DESTINATION`) and `SHIPPING_QUOTE_ALREADY_USED` trigger one automatic re-quote and present the updated summary for a fresh `SÍ` (if the re-quote is not deliverable, the customer is asked to quote shipping again). `SHIPPING_QUOTE_NOT_FOUND`, `PACKAGING_DATA_MISSING` and a 4xx `SHIPPING_QUOTE_UNAVAILABLE` get their own replies; a 5xx stays an uncertain outcome that keeps the key. `SHIPPING_QUOTE_ALREADY_USED` (no `saleId`) first reads `GET /checkouts/status` with the stored key: if it shows a sale, that is our own order and it is completed like a normal success; otherwise the re-quote runs. `SHIPPING_QUOTE_MISMATCH` with `CUSTOMER` in `mismatches[]` clears the saved-address selection and asks the customer to review their data («quiero comprar») instead of re-quoting. A 400 `INVALID_CHECKOUT_REQUEST` is logged and answered with the generic “No se pudo crear el pedido…” reply.
- A delivery order without a current quote or pickup choice gets: “Antes del resumen necesito saber cómo recibirá su pedido: dígame «cotizar envío» … o «recoger en tienda» …”.

## Zone validation (S5, S8)

When a quote comes back `zoneStatus: PENDING`, the customer gets the PENDING reply above and the bot registers them for the backend DELIVERY_ZONE decision (contract: `docs/contracts/delivery-zone-bot-cycle.md`). A staff user validates or denies the ZIP in the backend; the bot learns the outcome and tells the customer.

**Flow**

1. **Intake.** `MinimalShippingService` calls the zone intake with the same destination it quoted: the saved address fields, or the confirmed new/corrected fields (`municipality` falls back to `city`). The request is `POST /chatbot-api/human-decisions` with `type: "DELIVERY_ZONE"`, `X-Idempotency-Key` = `sourceRequestId`, the sender phone, `conversationRef = "wa:" + sender`, and `lastCustomerMessageAt` (provider time of the latest verified inbound, or now).
   - One open requester per sender + ZIP. A repeated PENDING quote for that ZIP reuses the open requester and re-sends the stored body byte for byte, so the backend replays it instead of creating a new requester.
   - An intake failure never changes the customer reply. A transient failure (network, 5xx, 429) is retried by the poller with the same `sourceRequestId`. A 400/404/409/422 closes the requester as `FAILED`.
   - If the ZIP already has an active zone, the backend resolves the intake at once (`EXISTING_ZONE`). The bot stores it as resolved and the poller delivers it on its next tick, like any poll result.
2. **Poll.** The poller runs on boot and every 60 s (`DeliveryZonePoller` option `intervalMs`). Each tick reads a batch of up to 20 due requesters from the database and calls `GET /chatbot-api/human-decisions/:id` with the requester id. A requester is polled at most once per minute during its first hour, then every 5 minutes. There is no time horizon: a validation can stay pending for days.
3. **Notify.** On `RESOLVED` the bot sends exactly one message:
   - **Inside the customer's 24 h WhatsApp window** (latest verified inbound less than 24 h old), it sends a text:
     - `FREE`, `SURCHARGE` or `CARRIER_ONLY`: “¡Listo! Ya tenemos entrega a su código postal {CP}. Pídame de nuevo el envío y le muestro el costo actualizado.” The surcharge is not quoted, because the backend quote applies the product credit; only the new quote shows what the customer pays.
     - `DENIED`: “Revisamos su código postal {CP} y por ahora no tenemos entrega ahí. Puede recoger su pedido en tienda sin costo de envío.”
   - **Outside that window, or with no inbound evidence,** it sends the utility template `zona_entrega_revisada` (`es_MX`) with one body parameter, the ZIP.
   - A stored PENDING-zone quote for that sender is then removed, so the next shipping request re-quotes.
4. **ACK.** `POST /chatbot-api/human-decisions/:id/application-outcome`, with the same body as the RESTOCK ACK (the same client call):
   - `PROVIDER_ACCEPTED` when Meta accepted the text or template before `applyBefore` (`resolvedAt + 24 h`).
   - `DELIVERY_UNKNOWN` when the send failed (for example, the template is not approved yet) or the bot crashed mid-send.
   - Acceptance after `applyBefore` is recorded locally as `PROVIDER_ACCEPTED_LATE` with no ACK, because the backend rejects ACKs outside the window.
   - A transient ACK failure is retried on the next tick with the same `attemptId` and evidence. A 4xx closes the requester locally.

**Durability.** Each requester is a row in `delivery_zone_requesters` (migration `3200000000000_delivery_zone_requesters.js`, required by preflight). The row holds the stored intake body, the requester id, the status, the last poll time, the resolution, and the delivery and ACK evidence. Status moves `INTAKE_PENDING → PENDING → RESOLVED → SEND_STARTED → NOTIFIED → CLOSED`, and every step is a status compare-and-set. `SEND_STARTED` is written before the provider call, so a restart never sends twice: a row found in `SEND_STARTED` is recorded as `DELIVERY_UNKNOWN`. A restart resumes from the table.

**Template dependency.** The owner must create the utility template `zona_entrega_revisada` (`es_MX`, body “Hola, ya revisamos la entrega a su código postal {{1}}. Responda a este mensaje para continuar con su pedido.”) and Meta must approve it. Until then, late notices fail and are recorded once as `DELIVERY_UNKNOWN`. In-window texts are unaffected.

## Not ready for production

- **Zone template:** late zone notices need the `zona_entrega_revisada` template approved by Meta (see Zone validation).
- **Zone backend:** the DELIVERY_ZONE routes live on backend branch `feat/shipping-zones`, not yet in `main`.
- Cart CAS and WhatsApp delivery are not one transaction; partial failures may require reconciliation.

No live backend/WhatsApp calls are needed for validation:

```sh
pnpm test --runTestsByPath src/llm-agent/application/minimal-shipping.sdk.spec.ts
```
