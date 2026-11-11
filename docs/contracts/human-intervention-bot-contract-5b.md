<!-- Chatbot copy of houndfe-backend docs/chatbot-handoff/chatbot-requests-bot-contract.md at aab7fb6e (slices 5a and 5b), received 2026-11-10, plus the agreed DEFERRED_HUMAN_SESSION addition (slice 5c, pending on the dev backend). The backend file is the source of truth. -->

# Chatbot ↔ backend: human requests (slices 5a and 5b)

Create, merge, customer cancel and route budgets (5a) are summarized in `docs/contracts/human-intervention-requests-5a.md`. This file records the feed, the delivery outcome and pending deliveries (5b), which the chatbot feed consumer implements.

## Feed — `GET /chatbot-api/feed?after=<cursor>&limit=50&waitSeconds=25`

Scope `feed:read`, class `feed` (120/min, spent once when the long-poll opens; at most 2 waiting long-polls per credential, a third gets `429 RATE_LIMITED` with `Retry-After: 1`). `after` = previous `nextCursor` (omit to start from the oldest retained item); `limit` 1..50; `waitSeconds` 0..25. Out-of-range values are `400`, not clamped.

```json
{
  "items": [
    {
      "cursor": "000000001842",
      "deliveryId": "b1c0…",
      "type": "request.answered",
      "requestId": "9a7e…",
      "conversationRef": "wa:5215512345678",
      "payload": {
        "kind": "DECISION",
        "subtype": "RESTOCK",
        "action": "PROVIDE_RESTOCK_ESTIMATE",
        "legacyId": "5d0c…",
        "text": "El producto «Croquetas 20 kg» estará disponible en aproximadamente 7 días.",
        "prefix": null,
        "productName": "Croquetas 20 kg",
        "restockDays": 7
      },
      "notBefore": null,
      "expiresAt": null
    }
  ],
  "nextCursor": "000000001842"
}
```

- Items arrive in ascending cursor order, and cursor order is commit order. Store `nextCursor` **after** the page is handled. An empty page returns the `after` you sent. The cursor is per tenant and opaque. Reading never acknowledges anything.
- With no item, the request waits up to `waitSeconds` and answers `{items: [], nextCursor: <after>}`, or returns as soon as an item commits. Reconnect immediately. On a backend restart, waiting long-polls answer empty at once; keep the cursor.
- `410 CURSOR_EXPIRED` after 30 days of retention. The recovery route `GET /chatbot-api/requests?status=open&updatedSince=` is not built yet; until then restart with no `after` and de-duplicate by `deliveryId`.
- The same `after` returns the same items again: de-duplicate by `deliveryId`, stored as a unique key **before** calling Meta.
- Run one consumer per branch (advisory lock).

## Item types (5b)

| `type`              | When                                                                                                                                         | `payload`                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `request.answered`  | Staff resolved a wrapped decision (stock, expiration, delivery zone, transfer receipt), from the new resolve command or the old staff routes | `{kind: "DECISION", subtype, action, legacyId, text, prefix, …fields}` |
| `request.cancelled` | Staff cancelled a request (§12.14)                                                                                                           | `{requestId, reason, cancelledBy: "STAFF", customerNote?}`             |

`conversationRef` is `null` when the request has none (e.g. a stock request created without one). `legacyId` is the id the bot already tracks from the create answer (`legacy.id`).

**The bot composes the message from the structured fields in the customer's tú/usted register; `text`/`prefix` are only an usted fallback.** `prefix` is `"Le comparto la respuesta del equipo:"` only when `text` is what staff wrote for the customer, else `null`.

| `subtype`          | `action`                                                           | Fields                                                                                                                     |
| ------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `RESTOCK`          | `PROVIDE_RESTOCK_ESTIMATE` / `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` | `productName`; `restockDays` only for the first                                                                            |
| `EXPIRATION`       | `PROVIDE_EXPIRATION_TEXT` / `REPORT_EXPIRATION_UNAVAILABLE`        | `productName`; `expirationText` and `staffText` (same staff string) only for the first                                     |
| `DELIVERY_ZONE`    | `APPROVE_DELIVERY_ZONE` / `REJECT_DELIVERY_ZONE`                   | `zipCode`, `zoneType` (`FREE`, `SURCHARGE`, `CARRIER_ONLY`, `DENIED`); `surchargeCents` and `etaDays` only when they apply |
| `TRANSFER_RECEIPT` | `CONFIRM_RECEIPT` / `REJECT_RECEIPT`                               | a rejection carries `customerReason`, `reasonSource` and, only for `STAFF`, `staffText`                                    |

Examples:

```json
{ "kind": "DECISION", "subtype": "RESTOCK", "action": "REPORT_RESTOCK_ESTIMATE_UNAVAILABLE", "legacyId": "…", "text": "Por ahora no tenemos una fecha estimada de reposición para «Croquetas 20 kg».", "prefix": null, "productName": "Croquetas 20 kg" }
{ "kind": "DECISION", "subtype": "EXPIRATION", "action": "PROVIDE_EXPIRATION_TEXT", "legacyId": "…", "text": "Caduca en marzo 2027", "prefix": "Le comparto la respuesta del equipo:", "productName": "Leche", "expirationText": "Caduca en marzo 2027", "staffText": "Caduca en marzo 2027" }
{ "kind": "DECISION", "subtype": "DELIVERY_ZONE", "action": "APPROVE_DELIVERY_ZONE", "legacyId": "…", "text": "Sí entregamos en su código postal (64000) con un cargo de envío de $1,250.00 MXN. Tiempo estimado: 3 días.", "prefix": null, "zipCode": "64000", "zoneType": "SURCHARGE", "surchargeCents": 125000, "etaDays": 3 }
{ "kind": "DECISION", "subtype": "TRANSFER_RECEIPT", "action": "REJECT_RECEIPT", "legacyId": "…", "text": "El monto no coincide, envíenos otro comprobante.", "prefix": "Le comparto la respuesta del equipo:", "customerReason": "El monto no coincide, envíenos otro comprobante.", "reasonSource": "STAFF", "staffText": "El monto no coincide, envíenos otro comprobante." }
```

- **`reasonSource`.** `STAFF`: relay `staffText` as written, with the team prefix. `DEFAULT`: no staff wording, no `staffText`, `prefix` null; compose your own "we could not validate your receipt, please send it again" in the customer's register.
- **Fallback texts** (verbatim; `«…»` productName, `N` days, `$X` es-MX amount like `$1,250.00 MXN`, `Z` postal code):
  - `RESTOCK` with estimate: `El producto «…» estará disponible en aproximadamente N días.` (`1 día` for one day); without: `Por ahora no tenemos una fecha estimada de reposición para «…».`
  - `EXPIRATION` with text: the staff text (with the team prefix); without: `Por ahora no tenemos la fecha de caducidad de «…».`
  - `FREE`: `Sí entregamos en su código postal (Z), sin costo de envío.` · `SURCHARGE`: `Sí entregamos en su código postal (Z) con un cargo de envío de $X.` (no amount or 0: `… con un cargo de envío adicional.`, never `$0.00`) · `CARRIER_ONLY`: `En su código postal (Z) el envío es solo por paquetería.` plus ` El cargo de envío es de $X.` when a surcharge is set · `DENIED`: `Por ahora no entregamos en su código postal (Z).` Every approval ends with ` Tiempo estimado: N días.` when `etaDays` is set.
  - `CONFIRM_RECEIPT`: `Le confirmamos la recepción de su comprobante de pago. ¡Gracias!`
  - `REJECT_RECEIPT` with a staff reason: that reason; default: `No pudimos validar tu comprobante. Por favor envíanos uno nuevo o contáctanos.` (in tú: the one fallback that is not usted).
- A zone answer is **one item per customer**, each with its own `conversationRef` and `deliveryId`.
- A customer who cancelled gets **no** item when staff later resolves the old row.
- **`request.cancelled`.** `reason` is `DUPLICATE`, `NOT_ACTIONABLE`, `CUSTOMER_UNREACHABLE` or `OTHER`. Forget the request's pending state. `DUPLICATE`: send nothing, ACK `STALE`. Others: a short notice (`customerNote` as written with the team prefix when present) if the window is open, ACK `PROVIDER_ACCEPTED`; window closed: send nothing, ACK `STALE`. Never `DEFERRED_WINDOW_CLOSED` (or `DEFERRED_HUMAN_SESSION`) for this type: `422 OUTCOME_NOT_ALLOWED`.

## Delivery outcome — `POST /chatbot-api/deliveries/:deliveryId/outcome`

Scope `feed:ack`, class `write`. Send it **after** the local effect. One call per attempt:

```json
{
  "attemptId": "0b8f5c0e-6d7a-4c1e-9a52-3f1d2b6a7c10",
  "outcome": "PROVIDER_ACCEPTED",
  "providerMessageId": "wamid.HBg…",
  "attemptedAt": "2026-11-10T16:20:00.000Z"
}
```

| `outcome`                | Meaning                                                                                                                                                                                                                  | Body                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `PROVIDER_ACCEPTED`      | Meta accepted the message                                                                                                                                                                                                | `providerMessageId` and `attemptedAt` required                    |
| `DELIVERY_UNKNOWN`       | Unknown whether it was sent; **do not retry**                                                                                                                                                                            | `attemptedAt` required, `providerMessageId` optional              |
| `DEFERRED_WINDOW_CLOSED` | 24 h window closed; stays pending. Not for `request.cancelled`                                                                                                                                                           | `attemptedAt` required, no `providerMessageId`                    |
| `DEFERRED_HUMAN_SESSION` | **Slice 5c, pending on the dev backend.** A person is attending; same non-terminal semantics as `DEFERRED_WINDOW_CLOSED`; served by pending-deliveries with `deferredReason: HUMAN_SESSION`. Not for `request.cancelled` | as `DEFERRED_WINDOW_CLOSED`                                       |
| `STALE`                  | Nothing was sent and nothing needs to be                                                                                                                                                                                 | `attemptId` only (`attemptedAt` optional, no `providerMessageId`) |

Exactly those keys; anything else is `400`. `attemptId` is a lowercase UUID; `attemptedAt` canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; `providerMessageId` 1..512 chars, trimmed, no control characters.

`200 {deliveryId, outcome, attemptId, ackReceivedAt}` (`ackReceivedAt` null for a deferral). An exact replay (same `attemptId` and evidence) answers `200`, even for an older attempt. `409 IDEMPOTENCY_CONFLICT`: same `attemptId`, other evidence. `409 OUTCOME_ALREADY_RECORDED`: a new `attemptId` after a terminal outcome. `422 OUTCOME_NOT_ALLOWED`: a deferral for `request.cancelled`. `404` (`Delivery not found`). Retry a lost ACK with the **same body**. A new send after a deferral uses a **new `attemptId`**.

## Pending deliveries — `GET /chatbot-api/requests/pending-deliveries?conversationRef=` (or `?requestId=`)

Scope `feed:read`, class `read`. Exactly one filter. Returns `{items: [...]}` (feed item shape, up to 50, ascending cursor) whose last outcome is a deferral and that have no terminal outcome. Ask when the customer writes again (or, for HUMAN_SESSION, after the session ends or on the next bot-mode turn), deliver, and ACK each with a new `attemptId`. Use `requestId` for requests without a `conversationRef`.

## No double delivery

- Store `deliveryId` as a unique key before calling Meta; if a send is uncertain, report `DELIVERY_UNKNOWN` and do not retry.
- While both paths exist (feed and legacy poll of the same decision), track by `legacyId`: whichever arrives first is delivered; the other is ACKed `STALE` (feed) or ignored (poll).
- One consumer per branch.

## Slice 5c (live on the dev backend at ce503ea2, 2026-11-11)

### `DEFERRED_HUMAN_SESSION` and `deferredReason`

`DEFERRED_HUMAN_SESSION` is live: non-terminal, same body as `DEFERRED_WINDOW_CLOSED` (`attemptId`, `attemptedAt`, no `providerMessageId`), `422 OUTCOME_NOT_ALLOWED` on `request.cancelled`. Pending deliveries now return both deferrals (up to 50, ascending cursor), in the feed item shape plus `deferredReason`:

| `deferredReason` | Replay it when                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `WINDOW_CLOSED`  | The customer writes again (the 24 h window is open). Deliver and ACK with a new `attemptId`.                                              |
| `HUMAN_SESSION`  | The human session ended (`conversation.ended`, unit 11) or the conversation's next bot-mode turn. Deliver and ACK with a new `attemptId`. |

### Recovery after `410 CURSOR_EXPIRED` — `GET /chatbot-api/requests?status=open&updatedSince=<ISO>&cursor=&limit=50`

Scope `requests:read`, class `read`.

| Param          | Rule                                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | Required, exactly `open`.                                                                                                                                                                                                                                                                                |
| `updatedSince` | Optional, canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Adds requests **closed at or after** it (`RESOLVED`/`CANCELLED`); the backend reaches 5 s earlier (replica clock skew), so dedupe by `id`. Open requests are always all returned. Send an instant earlier than your last complete sync, never later. |
| `cursor`       | The previous page's `nextPage`; omit for the first page. Opaque.                                                                                                                                                                                                                                         |
| `limit`        | 1..50, default 50.                                                                                                                                                                                                                                                                                       |

Anything else is `400 VALIDATION_ERROR`. Pages ordered by `(updatedAt, id)`, keyset-paginated; a request updated during the walk may be seen again, none is skipped.

```json
{
  "items": [
    {
      "id": "9a7e…",
      "folio": "S-000123",
      "kind": "DECISION",
      "subtype": "RESTOCK",
      "status": "RESOLVED",
      "conversationRef": "wa:5215512345678",
      "legacyId": "5d0c…",
      "whatsappWindowClosesAt": "2026-11-11T16:20:00.000Z",
      "cancelReason": null,
      "createdAt": "2026-11-10T10:00:00.000Z",
      "updatedAt": "2026-11-10T16:00:00.000Z",
      "closedAt": "2026-11-10T16:00:00.000Z",
      "pendingDeliveries": [
        {
          "cursor": "000000001842",
          "deliveryId": "b1c0…",
          "type": "request.answered",
          "requestId": "9a7e…",
          "conversationRef": "wa:5215512345678",
          "payload": { "kind": "DECISION", "…": "…" },
          "notBefore": null,
          "expiresAt": null,
          "deferredReason": null
        }
      ],
      "undeliveredTruncated": false,
      "undeliveredResumeAfter": null
    }
  ],
  "nextCursor": "000000001900",
  "nextPage": "eyJ1Ijoi…"
}
```

- `conversationRef` contains the customer's phone: keep it out of logs.
- `pendingDeliveries`: the request's latest 5 feed items with no terminal outcome, oldest first, feed shape plus `deferredReason` (`null` if no attempt was reported). A closed request keeps showing its answer until acknowledged.
- `undeliveredTruncated` / `undeliveredResumeAfter`: when more than 5 are undelivered, `true` and the feed `after` that re-serves the oldest one; otherwise `false`/`null`. Resume from the **smallest** of every `undeliveredResumeAfter` and `nextCursor`, comparing the fixed-width strings (no arithmetic); dedupe by `deliveryId`. Do not use pending-deliveries for this.
- `nextCursor`: the tenant feed position when the first page was served; the same on every page of one walk; never below the retention watermark.
- `nextPage`: next page cursor, `null` on the last page.

Procedure: (1) stop using the expired cursor; (2) call with `status=open` and `updatedSince` = the last instant your state was complete (omit if unknown); (3) walk every page until `nextPage` is null, keeping the first page's `nextCursor`; (4) reconcile records: `NEW`/`IN_PROGRESS` → hold a pending record; `RESOLVED`/`CANCELLED`, or a local record not listed as open → drop it; handle each `pendingDeliveries` item as a feed item (dedupe by `deliveryId`, ACK each); (5) only after every page is processed and saved, store as the feed position `nextCursor` (or the smaller `undeliveredResumeAfter`) and resume `GET /chatbot-api/feed?after=<that>`.

## Staff merge — `request.merged` (agreed 2026-11-11, backend slice 4b; E2E passed on dev 2026-11-11)

- E2E 2026-11-11 against dev :3003 (backend HEAD 95313805): two `UNKNOWN_QUESTION` requests on `wa:5215550002222` without `dedupKey` (A 176fbefe…, B bf579e3e…); backend manager claimed A and merged it into B (both 200). The consumer read cursor 2 as `request.merged` (payload `{requestId, intoRequestId, conversationRef}`), sent nothing, ledger decision `DUPLICATE`, ACK `STALE` → HTTP 200 `ACKED`. Intake dedup is by `dedupKey` only; a staff claim emits no feed item.

- When staff merges a repeated request A into B (same customer, same subtype, both open, **same `conversationRef`**; otherwise `409 MERGE_NOT_ALLOWED`), the backend enqueues `request.merged {requestId: A, intoRequestId: B, conversationRef}` in the same transaction. A closes as `CANCELLED`/`SUPERSEDED`.
- Informational: the bot sends nothing to the customer, closes A in its registry (pointing to B) and ACKs `STALE`. `PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN` and any deferral answer `422 OUTCOME_NOT_ALLOWED`.
- When B is answered, only B gets `request.answered`; A gets nothing more.
- Chatbot handler (landed 2026-11-11): `parseFeedItem` reads `request.merged` (`requestId` accepted at the top level or in the payload — the top level wins when it is valid text; `intoRequestId` is the first valid text of the payload, then the top level, until the backend shape is final; missing `conversationRef`/`notBefore`/`expiresAt` read as `null`; a malformed one falls back to an unknown item, ACKed `STALE` with ledger decision `UNKNOWN_TYPE`, never rejecting the page, and logs a distinct warning — `request.merged was malformed` with the `deliveryId`, never the customer phone — because the merged request may stay open in the registry). The delivery service closes A as `CANCELLED` in the registry, keeps B open, logs the A → B pointer (the registry has no pointer column), sends nothing and ACKs `STALE` with ledger decision `DUPLICATE`.
