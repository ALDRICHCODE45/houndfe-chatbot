# Restock backorder — bot contract (copy from the backend)

Copy of `houndfe-backend/docs/chatbot-handoff/restock-backorder-bot-contract.md` (backend main d13bec43, received through intercom on 2026-11-20). The backend file is the source of truth; this copy is what chatbot workers read. Feature tracker: `odd/tasks/restock-backorder.md`.

## What is live when

| Part | Backend task | State |
| --- | --- | --- |
| Schedule (`POST`), read (`GET :id`), list (`GET`), customer cancel (`POST :id/cancel`), scopes, errors, `BackorderBot` | T1 | built (backend main d13bec43, deploy pending) |
| Reserve on arrival (WAITING → RESERVED), 24 h confirm window, `currentPriceCents`/`finalPriceCents`, reservation expiry, lot swap, the `backorder.*` feed items, outcome `PROVIDER_REJECTED`, staff alert | T2 | not live |
| Confirm through the normal checkout with `sale.items[i].backorderId` | T3 | not live |
| Overdue ETA re-estimate, `backorder.eta_updated` / `backorder.eta_unavailable` | T4 | not live |
| Staff API in the POS, stock fields, `STOCK_RESERVED_FOR_BACKORDER`, staff notices | T5 | not live (nothing for the bot) |

After T1 a backorder is created `WAITING` and stays `WAITING` until the bot or staff cancel it. Until T2 is announced, tell the customer only that the order is scheduled and that we will notify them when stock arrives; do not promise the 24 h reservation message.

## Owner decisions

| # | Decision | Live |
| --- | --- | --- |
| D1 | Price: min(reference price at scheduling, current price at arrival) | reference: T1; min: T2 |
| D2 | On arrival, reserve for waiting backorders by scheduling order; reserved units are not sellable at the counter; partial arrival reserves the later backorders that fit, the head keeps its place | T2 |
| D3 | 24 h to confirm from reservation, reminder 3 h before expiry | T2 |
| D4 | Any stock increase leaving sellable stock > 0 triggers matching | T2 |
| D5 | Pay on arrival, never in advance. Confirm = normal checkout | T3 |
| D6 | Overdue ETA: new staff estimate BEFORE telling the customer; once; one re-estimate per product/variant | T4 |
| D7 | Customer cancels from chat; staff list and cancel in the POS | cancel: T1; staff: T5 |

## Model (what the bot sees)

A backorder belongs to one sucursal (the credential's tenant), one customer, one product (and variant) and one quantity of whole units. It is created from a RESTOCK human decision that staff answered with `PROVIDE_RESTOCK_ESTIMATE`.

- `folio`: `BO-000001`, per-sucursal counter. Show it to the customer.
- `referencePriceCents`: unit price when scheduled, computed by the server for that customer and quantity (list price, no promotions; PUBLICO for a customer created by `createIfAbsent`).
- `scheduledAt`: the queue key (first come, first served; ties by `id`).
- `estimatedAt = decision.resolvedAt + restockDays`; it may already be in the past.

States:

```
WAITING ──(stock arrives, full quantity available)──▶ RESERVED                         (T2)
RESERVED ──(bot checkout with backorderId)──▶ CONFIRMED (terminal; saleId set)         (T3)
RESERVED ──(24 h without checkout)──▶ EXPIRED (terminal)                               (T2)
RESERVED ──(reserved lot expired, no valid lot to swap)──▶ WAITING (front of the queue) (T2)
WAITING | RESERVED ──(customer or staff cancel)──▶ CANCELLED (terminal)                (T1 customer; T5 staff)
```

After `EXPIRED` or `CANCELLED` the bot may offer to schedule again: a new backorder at the back of the queue. Only one active (`WAITING`/`RESERVED`) backorder per customer + product + variant.

## Customer resolution

`customer: { "mode": "existing", "customerId" }` or `{ "mode": "createIfAbsent", "firstName", "lastName"? }`, plus `phoneCountryCode` (`^[0-9]{1,10}$`) and `phone` (`^[0-9]{1,20}$`), exact match like checkout. No address until checkout.

- `existing`: the phone must belong to exactly that customer, otherwise `404 CUSTOMER_NOT_FOUND`.
- `createIfAbsent`: one customer with that phone → used (names ignored); none → created without address; several → `409 CUSTOMER_PHONE_AMBIGUOUS`.

## Bot API (live in T1)

`Authorization: Bearer svc_…`. New scopes on the chatbot credential: `backorders:create`, `backorders:read`, `backorders:cancel` (missing scope → `403`). `POST` and cancel use the `write` rate bucket, the `GET`s the `read` bucket (`429` + `Retry-After`). Every answer is `Cache-Control: no-store`. Errors: `{ "statusCode", "error", "message" }` with `error === message` plus the detail member listed. Unknown failure `500 BACKORDER_REQUEST_FAILED`; `503 BACKORDER_RETRY_REQUIRED` = aborted transaction, retry with the same key.

### POST /chatbot-api/backorders (scope `backorders:create`, `X-Idempotency-Key` required)

```json
{
  "phoneCountryCode": "52", "phone": "5512349901",
  "customer": { "mode": "existing", "customerId": "uuid" },
  "productId": "uuid", "variantId": "uuid|null", "quantity": 2,
  "expectedReferencePriceCents": 114900,
  "sourceDecisionId": "uuid",
  "chatbotRequestId": "uuid|null"
}
```

- `variantId`, `expectedReferencePriceCents`, `chatbotRequestId` optional (omitted = null). `quantity` integer ≥ 1, no upper limit. Unknown members → `400`.
- `201 { "backorder": BackorderBot }`. Same key + same body → `200` with the current state; same key + different body → `409 IDEMPOTENCY_KEY_CONFLICT`; concurrent same key → `409 IDEMPOTENCY_KEY_IN_FLIGHT` (retry). Key per sucursal, 1–200 chars trimmed.
- `sourceDecisionId`: RESTOCK decision of this sucursal, same product/variant, answered `PROVIDE_RESTOCK_ESTIMATE`.
- Rescheduling after `EXPIRED`/`CANCELLED`: same `sourceDecisionId` allowed; joins the back of the queue with the same `estimatedAt`.
- Two simultaneous requests for the same customer + product + variant create exactly one backorder (the other gets `BACKORDER_DUPLICATE`).

| Status | `error` (+ detail) | When |
| --- | --- | --- |
| 400 | `INVALID_BACKORDER_REQUEST` | body not exactly the shape above |
| 400 | `INVALID_IDEMPOTENCY_KEY` | key missing, blank or > 200 chars |
| 409 | `STOCK_AVAILABLE_NOW {availableToSell}` | sellable stock covers `quantity`: sell normally (`availableToSell: null` for a product that does not track stock) |
| 409 | `BACKORDER_DUPLICATE {backorderId}` | active backorder already exists for that customer/product/variant |
| 409 | `PRICE_OUT_OF_DATE {currentPriceCents}` | `expectedReferencePriceCents` sent and different |
| 409 | `SOURCE_DECISION_NOT_ESTIMATED` | decision pending or answered "estimate unavailable" |
| 404 | `PRODUCT_NOT_FOUND` / `VARIANT_NOT_FOUND` / `SOURCE_DECISION_NOT_FOUND` / `CUSTOMER_NOT_FOUND` | (`SOURCE_DECISION_NOT_FOUND` also for another sucursal/type/product) |
| 404 | `CHATBOT_REQUEST_NOT_FOUND` | `chatbotRequestId` not of the sucursal |
| 422 | `VARIANT_REQUIRED` / `VARIANT_NOT_OF_PRODUCT` | variant missing / wrong product |
| 422 | `PRICE_UNAVAILABLE` | no catalog price for the customer |
| 409 | `CUSTOMER_PHONE_AMBIGUOUS`, `IDEMPOTENCY_KEY_IN_FLIGHT`, `IDEMPOTENCY_KEY_CONFLICT` | as checkout |

### GET /chatbot-api/backorders/:id (scope `backorders:read`)

`{ "backorder": BackorderBot }` or `404 BACKORDER_NOT_FOUND` (also another sucursal or non-UUID).

### GET /chatbot-api/backorders?phoneCountryCode=&phone=&status=&updatedSince= (scope `backorders:read`)

`{ "items": BackorderBot[] }`, `updatedAt` desc (ties `id` desc), max 50. Phone params both or neither (unknown phone → `[]`; shared phone → `409 CUSTOMER_PHONE_AMBIGUOUS`). `status`: comma list. `updatedSince`: ISO instant with zone, `updatedAt >= updatedSince`; doubles as feed recovery. Other/repeated/malformed keys → `400 INVALID_BACKORDER_REQUEST`. Used for «¿cómo va mi pedido?» (`queuePosition`, `estimatedAt`).

### POST /chatbot-api/backorders/:id/cancel (scope `backorders:cancel`)

Body optional `{ "reason": "≤280" }` (blank → null). `200 { "backorder" }` with `status: "CANCELLED"`, `cancelledByKind: "CUSTOMER"`. `404 BACKORDER_NOT_FOUND`; `409 BACKORDER_NOT_CANCELLABLE {status}` (a retried successful cancel answers this with `status: "CANCELLED"`: treat as done); `400 INVALID_BACKORDER_REQUEST`.

### BackorderBot

```json
{
  "id": "uuid", "folio": "BO-000012", "status": "WAITING",
  "productId": "uuid", "productName": "Croquetas Adulto Raza Grande 18 kg",
  "variantId": null, "variantName": null, "quantity": 2,
  "referencePriceCents": 114900, "currentPriceCents": null, "finalPriceCents": null,
  "scheduledAt": "2026-11-20T15:00:00.000Z",
  "estimatedAt": "2026-11-27T15:00:00.000Z", "estimatedArrivalDays": 7,
  "reservedAt": null, "reservedUntil": null, "reminderAt": null,
  "queuePosition": 3, "saleId": null,
  "cancelledByKind": null, "cancelReason": null, "branchName": "Centro",
  "customerFirstName": "Rosa"
}
```

`queuePosition` 1-based only while `WAITING`. Reservation and current/final price fields null until T2; `saleId` at T3. Names are read live. **Timestamps are UTC with `Z`**; convert to America/Mexico_City on the chatbot side.

## Price

Reference (T1): list price for that customer and quantity, no promotions. Current (T2): price that day through the bot with automatic promotions (what `evaluate-cart` returns as final unit price). Final (T2) = min(reference, current), frozen at reservation, shown in the arrival message. At checkout (T3) the line is priced at final with no promotion applied again.

## Confirm = checkout with backorderId (T3, not live)

`POST /chatbot-api/checkouts` gains optional `sale.items[i].backorderId`: backorder must be `RESERVED` and `reservedUntil > now` (else `409 BACKORDER_NOT_RESERVED {status}` / `409 BACKORDER_RESERVATION_EXPIRED`); same customer/product/variant/quantity (else `409 BACKORDER_MISMATCH {field}`); `unitPriceCents = finalPriceCents`, no price-list check and no promotions; backorder → `CONFIRMED` with `saleId`. Other lines as today; shipping, pickup and pay-in-store hold unchanged.

## Overdue ETA (T4, not live)

One re-estimate per (sucursal, product, variant), before telling the customer anything; later overdue backorders attach to the pending one. Answer `PROVIDE_RESTOCK_ESTIMATE` → each attached backorder gets a new `estimatedAt` and `backorder.eta_updated {estimatedAt, restockDays}`; `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` → `backorder.eta_unavailable`. Once per backorder. No generic `request.answered` for it.

## Feed items (T2 and T4, not live)

New feed subject `backorderId`, delivered to the customer's conversation like sale items; ACK `POST /chatbot-api/deliveries/:id/outcome`; deferrals rejected (`422 OUTCOME_NOT_ALLOWED`).

| Type | Task | Payload (plus `backorderId`, `folio`, `productName`, `variantName`, `quantity`, `branchName`, `customerFirstName`) |
| --- | --- | --- |
| `backorder.reserved` | T2 | `referencePriceCents`, `currentPriceCents`, `finalPriceCents`, `reservedUntil`, `reminderAt` |
| `backorder.reservation_reminder` | T2 | `reservedUntil` |
| `backorder.reservation_expired` | T2 | `expiredAt` |
| `backorder.cancelled_by_staff` | T2 | `reason` |
| `backorder.reservation_lost` | T2 | `reason: "LOT_EXPIRED"`, `queuePosition`, `estimatedAt` (apologise) |
| `backorder.eta_updated` | T4 | `estimatedAt`, `restockDays` |
| `backorder.eta_unavailable` | T4 | — |

Outcomes: `PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN`, `STALE`, plus new terminal `PROVIDER_REJECTED {reason ≤280}` (backorder items only); on `backorder.reserved`/`reservation_reminder` it alerts staff to call the customer. The 24 h window starts at reservation.

## Deploy checklist (backend T1)

1. Apply backend migration `20261120000000_backorders` (additive).
2. Add `backorders:create`, `backorders:read`, `backorders:cancel` to the chatbot's `svc_` credential.

## Update: backend T2 built (backend main ec838050, received 2026-11-20)

Live now on the backend branch (deploy pending): reservation on arrival, 24 h window, reminder, expiry, expired-lot swap, the feed items `backorder.reserved`, `backorder.reservation_reminder`, `backorder.reservation_expired`, `backorder.reservation_lost`, and the outcome `PROVIDER_REJECTED`. `backorder.cancelled_by_staff` ships with backend T5, `eta_*` with T4, checkout with `backorderId` with T3.

### Matching and sweep
- Every stock increase (adjustment, initial stock, cancelled sale, lapsed sale hold, released reservation) walks the product/variant `WAITING` queue by `scheduledAt, id` and reserves every backorder whose whole quantity fits; `backorder.reserved` is written in the same transaction (exactly once per reservation).
- `reservedUntil = reservedAt + 24 h`, `reminderAt = reservedUntil − 3 h`, regardless of delivery.
- Sweep every 30 s: reminder once (skipped if the sweep was down past the deadline: expires directly); expiry → `EXPIRED`, units to the next fitting backorder (its own `backorder.reserved`) or general stock, `backorder.reservation_expired`, staff notice; expired lot → silent swap (no item) or back to `WAITING` front with `backorder.reservation_lost`; safety-net allocation.
- Customer cancel vs expiry serialize: if the expiry wins, cancel answers `409 BACKORDER_NOT_CANCELLABLE {status: "EXPIRED"}`. Customer cancel writes no feed item. Cancelling a `RESERVED` backorder hands the units to the next one.
- After `EXPIRED` the reservation fields keep their values; after `reservation_lost` they are cleared.

### Feed envelope (differs from sale items)
Standard item with `requestId: null` and **no `saleId` key**; `backorderId` is inside `payload`:

```json
{
  "cursor": "000000004311", "deliveryId": "5b1f…", "type": "backorder.reserved",
  "requestId": null, "conversationRef": "wa:5215512349901",
  "payload": {
    "backorderId": "uuid", "folio": "BO-000012",
    "productName": "Croquetas Adulto Raza Grande 18 kg", "variantName": null,
    "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "version": 3,
    "referencePriceCents": 114900, "currentPriceCents": 109900, "finalPriceCents": 109900,
    "reservedUntil": "2026-11-21T15:00:00.000Z", "reminderAt": "2026-11-21T12:00:00.000Z"
  },
  "notBefore": null, "expiresAt": null
}
```

`conversationRef` is the customer's mirrored chat, or `null` (none or several): then resolve the customer through `GET /chatbot-api/backorders/:id`. Common payload fields: `backorderId`, `folio`, `productName`, `variantName`, `quantity`, `branchName`, `customerFirstName`, `version`. Per type: reserved (`referencePriceCents`, `currentPriceCents`, `finalPriceCents`, `reservedUntil`, `reminderAt`); reservation_reminder (`reservedUntil`); reservation_expired (`expiredAt`); reservation_lost (`reason: "LOT_EXPIRED"`, `queuePosition`, `estimatedAt`); cancelled_by_staff (`reason` or null, T5); eta_updated (`estimatedAt`, `restockDays`, T4); eta_unavailable (T4). At most one item per backorder, type and `version`; dedupe by `deliveryId`. Timestamps UTC `Z`.

### ACK outcomes for `backorder.*`
`POST /chatbot-api/deliveries/:deliveryId/outcome`, same body rules as every item:
- `PROVIDER_ACCEPTED` (`providerMessageId`, `attemptedAt`), `DELIVERY_UNKNOWN` (`attemptedAt`; do not retry), `STALE` (not sent).
- **`PROVIDER_REJECTED`** (new, terminal, backorder items only): `{attemptId, outcome: "PROVIDER_REJECTED", attemptedAt, reason}`, `reason` required 1–280 (e.g. `TEMPLATE_NOT_APPROVED`, `UNREACHABLE`), no `providerMessageId`. On `backorder.reserved`/`reservation_reminder` it creates a staff notice to call the customer.
- `DEFERRED_WINDOW_CLOSED`, `DEFERRED_HUMAN_SESSION` → `422 OUTCOME_NOT_ALLOWED` for backorder items (send an approved template or ACK `STALE`/`PROVIDER_REJECTED`).
- `PROVIDER_REJECTED` on a non-backorder item → `422 OUTCOME_NOT_ALLOWED` (was 400). `reason` with another outcome or invalid reason → `400 VALIDATION_ERROR`. Same `attemptId` with another reason → `409 IDEMPOTENCY_CONFLICT`; another attempt after a terminal outcome → `409 OUTCOME_ALREADY_RECORDED`.

### Recovery after `410 CURSOR_EXPIRED`
`GET /chatbot-api/backorders?…&updatedSince=` also returns `backorderUndeliveredResumeAfter` (12-digit cursor of the sucursal's oldest unacknowledged backorder item minus one, or null). Resume the feed from the smallest of `nextCursor`, any `undeliveredResumeAfter`, `saleUndeliveredResumeAfter` and `backorderUndeliveredResumeAfter` (fixed-width string compare). Backorder items never appear in `pending-deliveries` nor in the request recovery walk.

### Deploy order (T2)
1. The chatbot feed consumer must accept `requestId: null` without `saleId`, the `backorder.*` types (ACK `STALE` for types not handled yet) and be able to report `PROVIDER_REJECTED` **before** the backend deploys T2.
2. Backend T2 must not go live before the chatbot can check out a reservation (backend T3 + chatbot T5).
3. Backend migrations `20261120010000_backorder_stock_movements`, `20261121000000_backorder_feed`, `20261121000100_backorder_feed`; the bot must not report `PROVIDER_REJECTED` against a database without the last one (500).

## Update: backend T3 built — confirm = checkout with backorderId (backend main a0c8ea03, live on dev :3003)

`POST /chatbot-api/checkouts` accepts optional `sale.items[i].backorderId` (UUID; null = omitted). Only on checkouts: legacy `POST /chatbot-api/sales` rejects it (400). Success response unchanged (same 201); the backorder line appears in the sale with priceSource `custom` and customPriceCents = finalPriceCents.

```json
{
  "phoneCountryCode": "52", "phone": "5512349901",
  "customer": { "mode": "existing", "customerId": "uuid" },
  "sale": {
    "cashierUserId": "uuid",
    "items": [
      { "productId": "uuid", "productName": "Croquetas Adulto Raza Grande 18 kg",
        "quantity": 2, "unitPriceCents": 109900, "backorderId": "uuid-of-the-reserved-backorder" },
      { "productId": "uuid", "productName": "Collar", "quantity": 1, "unitPriceCents": 50000 }
    ],
    "expectedTotalCents": 269800,
    "shipping": { "mode": "pickup" }
  }
}
```

Rules for a line with `backorderId`:
1. Backorder exists in the sucursal, `RESERVED`, `reservedUntil > now`.
2. An expired reserved lot is swapped silently (committed before the checkout) or the reservation is lost (never sell an expired lot).
3. Same customer, productId, variantId (omitted = null) and quantity.
4. `unitPriceCents = finalPriceCents`; that line skips the list-price check and promotions, is its own line (never stacks with another line of the same product). Other lines keep today's rules. The bypass exists only for a valid reservation.
5. Reserved units consumed by the sale in the same transaction; backorder → `CONFIRMED` with `saleId`, `confirmedAt`, `version + 1`.

```
expectedTotalCents = Σ(finalPriceCents × quantity of backorder lines)
                   + total of the ordinary lines (evaluate-cart of ONLY those lines)
                   + shipping charge
```
Backorder lines are outside the promotion base. Wrong total → `409 PROMO_RE_QUOTE {recomputedTotalCents, …}` computed the same way.

| Status | `error` (+ detail) | When / bot action |
| --- | --- | --- |
| 404 | `BACKORDER_NOT_FOUND` | no such backorder in this sucursal |
| 409 | `BACKORDER_NOT_RESERVED {status}` | WAITING/CONFIRMED/EXPIRED/CANCELLED (second checkout of a confirmed one → `{status:"CONFIRMED"}`) |
| 409 | `BACKORDER_RESERVATION_EXPIRED` | `reservedUntil` passed (even before the sweep) |
| 409 | `BACKORDER_RESERVATION_LOST` | reserved lot expired, no valid stock; back to WAITING and `backorder.reservation_lost` is also emitted: apologise, do not retry |
| 409 | `BACKORDER_MISMATCH {field}` | customerId/productId/variantId/quantity |
| 409 | `PRICE_OUT_OF_DATE {currentPriceCents}` | unitPriceCents ≠ finalPriceCents (detail = finalPriceCents). Ordinary line stale price = old code-only PRICE_OUT_OF_DATE |
| 409 | `BACKORDER_RESERVATION_UNAVAILABLE` | data fault; tell the customer staff will call |
| 400 | `INVALID_CHECKOUT_REQUEST` | backorderId not a UUID or repeated in the cart |
| 503 | `BACKORDER_CHECKOUT_UNAVAILABLE` | backend misconfigured |

A refused checkout charges nothing; the same `X-Idempotency-Key` may be retried (except after RESERVATION_LOST). `backorderId` joins the request hash only when present; same key with another/no backorderId → `409 IDEMPOTENCY_KEY_CONFLICT`. Races with sweep/cancel/allocator: exactly one wins; nothing charged twice. Mixed carts, shipping/pickup and pay-in-store hold unchanged; if the sale is later cancelled or its hold expires, units return to general stock and the next WAITING backorder is reserved; the CONFIRMED backorder stays CONFIRMED.

Dev :3003: all backorder migrations applied; scopes backorders:* added to credentials «dev-chatbot-human-intervention» and «dev-chatbot-e2e (all scopes) 2026-11-06». Test: schedule on an out-of-stock product, then a positive POST /inventory/adjustments reserves it and emits backorder.reserved.

Deploy (T3): no backend migration; deploy the bot's handling of BACKORDER_* and PRICE_OUT_OF_DATE {currentPriceCents} with or before the backend; backend T2 must not go live before the bot sends backorderId.

## Update: backend T4 + T4b built (backend main 2a114337, live on dev :3003)

- **Overdue ETA (§8):** when a WAITING backorder's `estimatedAt` passes, the server asks staff ONE RESTOCK re-estimate per (sucursal, product, variant) BEFORE telling the customer anything; meanwhile the bot gets nothing and `GET` still shows the old past `estimatedAt` (do not invent a date). When staff answer, every still-WAITING attached backorder gets exactly once:
  - `backorder.eta_updated {estimatedAt, restockDays}` → tell the customer the new approximate date (a human estimate, not a guarantee; may be close or already past).
  - `backorder.eta_unavailable` (no extra member; date stays in the past) → staff have no confirmed date; it does NOT mean never: the backorder stays WAITING in its place and is reserved when stock arrives. Offer to keep waiting or cancel.
  - Skipped (no item) if the backorder became RESERVED/CONFIRMED/CANCELLED/EXPIRED before the answer. Only once per backorder; no expiry if staff never answer.
- The server-created re-estimate request is staff-only: the bot never receives `request.answered` for it nor sees it in request recovery (the earlier STALE workaround is no longer needed).
- `sourceDecisionId` in every `BackorderBot` (the decision the bot sent) and in `backorder.reservation_expired` / `backorder.cancelled_by_staff` payloads: reschedule with it.
- **T4b:** `phoneCountryCode` and `phone` (or null/null when the customer has none) in `BackorderBot` (create, GET :id, list, cancel) and in EVERY `backorder.*` payload. When `conversationRef` is null, reach the customer with that pair.
- Home delivery with a backorder line + an ordinary line of the same product: quote once with the summed quantity; the checkout's quote binding sums quantities per (productId, variantId), so no `SHIPPING_QUOTE_MISMATCH [LINES]`.
- Concurrent checkouts of the same product: `409 STOCK_INSUFFICIENT_AT_CONFIRM` instead of `500 CHECKOUT_CREATE_FAILED`.
- No new backend migrations for T3/T4. Deploy order: the bot must parse eta_* and the new members before the backend deploys T4.
