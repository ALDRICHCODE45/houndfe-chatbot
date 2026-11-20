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
