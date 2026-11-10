# Human intervention contract v1 — chatbot excerpt

Source of truth: `houndfe-backend/docs/proposals/human-intervention-backend-proposal.md`, branch `docs/human-intervention-proposal` (contract v1 closed in b2fe56af; chatbot reconciliation recorded as §11.2). This file keeps the parts the chatbot implements, so chatbot workers do not have to read across repositories. If the two differ, the backend file wins.

## Clarifications agreed with the backend (2026-11-10, §11.2)

- `409 CUSTOMER_OPEN_LIMIT`: at most 20 open requests per customer, counting all subtypes together. The body carries `{limit, open}`.
- The mirror carries all traffic in both directions from cutover, bot-mode turns included. A bot outbound message is sent as `direction: OUT` plus `author: BOT`; there is no `OUTBOUND_BOT` value. `messages:batch` carries no epoch. The epoch travels only in `session-ack` and in feed events.
- New credential scopes, on top of the existing ones: `requests:create`, `requests:read`, `requests:cancel`, `feed:read`, `feed:ack`, `conversation:write`, `media:write`.
- `session-ack STARTED` is sent as soon as muted mode is durably saved, without waiting on Meta. A failed greeting is reported separately.
- Audio is always uploaded and mirrored. With nobody attending, the bot also asks the customer to write it. Video and location are not stored in v1.
- Scheduling slots carry no `label`. They always include the branch IANA `timeZone`, and the bot formats `startsAt` itself in the customer's tú/usted style.
- Traffic budgets are sized for 60 inbound/min per branch with headroom, configurable.

## Endpoints chatbot → backend (§3.9)

All use `Authorization: Bearer svc_…` and `X-Branch-Id`, and answer with `Cache-Control: no-store`. Common errors: `401`, `403 INSUFFICIENT_SCOPE`, `429 RATE_LIMITED` (with `Retry-After`), `400 VALIDATION_ERROR`.

| Method and route                                                | Scope                | Idempotency                                    | Main payload                                                                                                 | Typed errors                                                                                          |
| --------------------------------------------------------------- | -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `POST /chatbot-api/requests`                                    | `requests:create`    | `X-Idempotency-Key` = `sourceRequestId` + hash | Common envelope (§3.2) + `scheduledFor?` + `detail`                                                          | `409 IDEMPOTENCY_CONFLICT`, `409 CUSTOMER_OPEN_LIMIT`, `409 SLOT_UNAVAILABLE`, `422 SUBTYPE_DISABLED` |
| `POST /chatbot-api/requests/:id/cancel`                         | `requests:cancel`    | `X-Idempotency-Key`                            | `{reason, triggerWaMessageId}`                                                                               | `404`, `409 ALREADY_RESOLVED` (includes the answer), `409 IDEMPOTENCY_CONFLICT`                       |
| `POST /chatbot-api/requests/cancel-batch` (optional)            | `requests:cancel`    | `X-Idempotency-Key`                            | `{ids[], reason}`                                                                                            | `409 MIXED_CUSTOMERS`                                                                                 |
| `POST /chatbot-api/requests/:id/reschedule`                     | `requests:create`    | `X-Idempotency-Key`                            | `{scheduledFor}`                                                                                             | `409 SLOT_UNAVAILABLE`, `409 REQUEST_CLOSED`                                                          |
| `GET /chatbot-api/scheduling/slots?conversationRef=`            | `requests:read`      | —                                              | → `{timeZone, whatsappWindowClosesAt, slots[]}`                                                              | `422 SCHEDULING_DISABLED`                                                                             |
| `GET /chatbot-api/requests?status=open&updatedSince=`           | `requests:read`      | —                                              | Recovery after `410 CURSOR_EXPIRED`                                                                          | —                                                                                                     |
| `GET /chatbot-api/requests/pending-deliveries?conversationRef=` | `feed:read`          | —                                              | Deliveries in `DEFERRED_WINDOW_CLOSED`                                                                       | —                                                                                                     |
| `GET /chatbot-api/feed?after=&limit=50&waitSeconds=25`          | `feed:read`          | Cursor                                         | → `{items[], nextCursor}`                                                                                    | `410 CURSOR_EXPIRED`                                                                                  |
| `POST /chatbot-api/deliveries/:deliveryId/outcome`              | `feed:ack`           | `attemptId` + evidence hash                    | `{attemptId, outcome, providerMessageId?, attemptedAt}`                                                      | `404`, `409 OUTCOME_ALREADY_RECORDED`, `409 IDEMPOTENCY_CONFLICT`                                     |
| `POST /chatbot-api/conversations/:ref/messages:batch`           | `conversation:write` | Per `waMessageId`                              | `{messages:[{waMessageId, direction, author, type, text?, mediaId?, providerTimestamp, observedAt}]}` (≤ 50) | `413 BATCH_TOO_LARGE`                                                                                 |
| `POST /chatbot-api/messages/statuses:batch`                     | `conversation:write` | Per `(providerMessageId, status)`              | `{statuses:[{providerMessageId, status, occurredAt, errorCode?}]}`                                           | —                                                                                                     |
| `POST /chatbot-api/conversations/:ref/session-ack`              | `conversation:write` | Per `(epoch, state)`                           | `{epoch, state: STARTED \| ENDED, providerMessageId?}`                                                       | `409 STALE_EPOCH`                                                                                     |
| `GET /chatbot-api/conversations/:ref/state`                     | `requests:read`      | —                                              | → `{mode, handoffEpoch, requestId, assigneeFirstName}`                                                       | `404`                                                                                                 |
| `POST /chatbot-api/media`                                       | `media:write`        | `X-Idempotency-Key` (+ `sha256`)               | multipart image, PDF or audio up to 10 MB → `{mediaId}`                                                      | `413 MEDIA_TOO_LARGE`, `415 MEDIA_TYPE_NOT_ALLOWED`                                                   |

Unchanged during the per-subtype migration: `POST/GET /chatbot-api/human-decisions[/:id]`, `POST …/:id/application-outcome`, `POST /chatbot-api/sales/:id/receipts`, `GET /chatbot-api/receipts/:id`.

## Create request (§3.2)

Common envelope plus a per-subtype `detail`. For RESTOCK, EXPIRATION and DELIVERY_ZONE, `detail` is exactly today's intake body.

```json
{
  "sourceRequestId": "5d0c…",
  "subtype": "UNKNOWN_QUESTION",
  "customer": {
    "phoneCountryCode": "52",
    "phone": "5512345678",
    "displayName": "Juan"
  },
  "conversationRef": "wa:5215512345678",
  "lastCustomerMessageAt": "2026-11-09T16:02:11Z",
  "summary": "¿El shampoo X sirve para cachorros de 2 meses?",
  "needs": "El cliente pregunta si el producto es apto para cachorros.",
  "context": { "cartRef": "…", "productIds": ["…"] },
  "dedupKey": "UNKNOWN_QUESTION:product:7f3e…",
  "triggerWaMessageId": "wamid.HBg…",
  "detail": {}
}
```

Response `201` (created) or `200` (identical replay or merged):

```json
{
  "id": "…",
  "status": "NEW",
  "outcome": "CREATED | REPLAYED | MERGED",
  "mergedIntoId": null,
  "businessHours": { "openNow": false, "nextOpenAt": "2026-11-10T15:00:00Z" }
}
```

- The bot picks the out-of-hours message from `businessHours`; it never computes hours itself.
- Receipts are not created here. They still enter through `POST /chatbot-api/sales/:id/receipts`.
- The bot only says "Ya le pregunté al equipo" after a `201/200`. Before that it says something neutral and never promises.

## Feed (§3.3)

`GET /chatbot-api/feed?after=<cursor>&limit=50&waitSeconds=25`:

```json
{
  "items": [
    {
      "cursor": "000000001842",
      "deliveryId": "b1…",
      "type": "request.answered",
      "requestId": "…",
      "conversationRef": "wa:52155…",
      "payload": {
        "kind": "CLARIFICATION",
        "text": "Sí, es apto desde las 8 semanas.",
        "prefix": "Le comparto la respuesta del equipo:"
      },
      "notBefore": null,
      "expiresAt": null
    },
    {
      "cursor": "000000001843",
      "deliveryId": "b2…",
      "type": "conversation.staff_message",
      "requestId": "…",
      "payload": { "handoffEpoch": 3, "seq": 17, "messageId": "…", "text": "…" }
    }
  ],
  "nextCursor": "000000001843"
}
```

- **Item types:** `request.answered` (decision with fixed text per option, clarification verbatim, receipt rejection with `customerReason`), `request.overdue_notice` (once), `request.cancel_ack`, `conversation.started`, `conversation.staff_message`, `conversation.ended`, `conversation.scheduled_reminder`, `conversation.rescheduled`, `template.requested` (only from the staff command, never automatic).
- **The cursor is for reading; the ACK is for delivering.** Report each delivery with `POST /chatbot-api/deliveries/:deliveryId/outcome` and body `{attemptId, outcome: PROVIDER_ACCEPTED | DELIVERY_UNKNOWN | DEFERRED_WINDOW_CLOSED | STALE, providerMessageId?, attemptedAt}`. One terminal ACK per delivery; a different second outcome gets `409`.
- **No double delivery:** store `deliveryId` as a unique key before calling Meta. If it is unknown whether Meta sent it, report `DELIVERY_UNKNOWN` and do not retry.
- `DEFERRED_WINDOW_CLOSED` keeps the delivery pending until the customer writes again; then fetch `pending-deliveries`.
- Feed retention is 30 days. An older cursor gets `410 CURSOR_EXPIRED`; recover with `GET /chatbot-api/requests?status=open&updatedSince=`.

## Cancel (§3.4) and merge (§3.5)

- `POST /chatbot-api/requests/:id/cancel` with `{reason: "CUSTOMER_WITHDREW" | "AUTO_RESOLVED", triggerWaMessageId}`. `409 ALREADY_RESOLVED` includes the answer, so the bot delivers it instead of saying "cancelled".
- A live conversation is not cancelled through this route: what the customer writes goes to the person attending.
- With several open requests, the bot decides which to cancel; `cancel-batch` only checks they share a `customerKey`.
- The bot sends a stable `dedupKey` (e.g. `RESTOCK:variant:<id>`, `UNKNOWN_QUESTION:<normalized hash>`). An open request with the same key answers `200 outcome: MERGED` with `mergedIntoId`. The backend never guesses sameness from free text.

## Staff cancellation (contract v1.1, §12)

Staff can cancel a clarification, or a `TALK_TO_HUMAN`/`COMPLAINT` while its session is still WAITING. Reasons: `DUPLICATE | NOT_ACTIONABLE | CUSTOMER_UNREACHABLE | OTHER`. Each cancellation produces the feed item `request.cancelled {requestId, reason, cancelledBy: STAFF}`, ACKed like any other delivery. Bot behavior, agreed 2026-11-10:

- Always clear local pending state for that request.
- `DUPLICATE`: send nothing, ACK `STALE`.
- Other reasons: a short fixed notice composed by the bot in the customer's style, ACK `PROVIDER_ACCEPTED`.
- Window closed: send nothing, ACK `STALE` (never `DEFERRED_WINDOW_CLOSED`).
- Optional `customerNote` (at most 500 chars, accepted in backend §12.14): when present and the window is open, the bot sends it verbatim with the team-reply prefix instead of the generic notice. Feed item: `request.cancelled {requestId, reason, cancelledBy: STAFF, customerNote?}`.
- The server rejects staff cancellation of a `TALK_TO_HUMAN`/`COMPLAINT` whose session is STARTING, ACTIVE or ENDING with `409 CANCEL_NOT_ALLOWED`, checked under the request row lock.

## Live conversation (§4), chatbot obligations

- **Every order carries an epoch** (`handoffEpoch`, incremented each time the conversation goes to a human). The bot ignores orders from an older epoch.
- **Session states:** WAITING (bot keeps helping, no promises) → STARTING (claim; feed `conversation.started{epoch, staffFirstName}`) → ACTIVE (after the bot's `session-ack STARTED`) → ENDING (finish, 2 h auto-return or forced) → ENDED (after `session-ack ENDED`). Without an ACK within 60 s, STARTING reverts to WAITING.
- **On `conversation.started`:** durably persist muted mode with the epoch, send "Le atiende <nombre>…" in the customer's style, then `session-ack STARTED` with `providerMessageId` when available.
- **While muted:** never call the LLM. Mirror customer messages through the outbox (deduplicated by `waMessageId`).
- **Staff messages:** reject stale epochs, deduplicate by `messageId`, send in `seq` order (hold a later `seq` up to 30 s waiting for the missing one), send the text verbatim with no prefix, then ACK the delivery with the `providerMessageId`.
- **On `conversation.ended`:** unmute, send the farewell, then `session-ack ENDED`.
- **Safety rule:** if the feed fails for more than 10 min while muted, send once "Tenemos una falla técnica, en cuanto se resuelva le respondemos" and stay muted. Never speak on its own while the epoch is HUMAN.
- **Reconcile mode** with `GET /chatbot-api/conversations/:ref/state` at startup and every 5 min while muted. The backend always wins.
- **Window:** Meta is the source of truth. If Meta rejects for a closed window, report `DEFERRED_WINDOW_CLOSED`.
- **Template:** on `template.requested{templateName, deliveryId}`, send the template and ACK `{providerMessageId | error}`, then report its status.

## Chatbot prerequisites (§10.1, §11)

Durable transcript, durable conversation gates, replacing the one-active-reservation index, `processed_webhook_messages` purge and write-before-reply, `backend_outbox` with per-conversation `seq`, and a Meta statuses normalizer. Backend unit 5 is not done until the bot consumes the feed end to end against the test backend.
