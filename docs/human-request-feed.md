# Human request feed consumer

The chatbot side of backend units 5b and 5c (`docs/contracts/human-intervention-bot-contract-5b.md`): it reads `GET /chatbot-api/feed`, handles each item locally, and reports one delivery outcome per attempt. Code: `src/human-requests/`. Task: `odd/tasks/human-intervention-feed-consumer.md` (T2a, T5; decision L4).

> The cursor is for reading; the ACK is for delivering.

## Tables (migrations 4300, 4500)

| Table                       | Purpose                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human_request_feed_cursor` | Row `human_request_feed:consumer`: `cursor` NULL = start from the oldest retained item. Row `human_request_feed:consumer:synced_at`: the consumer's synced_at (canonical UTC ms in the `cursor` column), written in the same statement as the cursor. No schema change.                                                          |
| `human_request_deliveries`  | Delivery ledger. `delivery_id` is the primary key, inserted **before** any Meta call. `payload` keeps the whole parsed feed item. Local state, decision, the current attempt (`attempt_id`, `attempted_at`, `provider_message_id`) and the durable ACK (`ack_state`, `ack_outcome`, `ack_attempts`, `next_ack_at`, `ack_error`). |
| `human_request_registry`    | Requests the bot created or that staff cancelled: `request_id`, `conversation_ref`, `subtype`, `legacy_id`, `status` (`OPEN`, `CANCELLED`, `RESOLVED`). The create path (T3) writes `OPEN` rows; a staff `request.cancelled` closes them.                                                                                        |

`local_state`: `RECEIVED`, `SENDING`, `SENT`, `STALE`, `UNKNOWN`, `DEFERRED_WINDOW`, `HELD_HUMAN`. `decision`: `LEGACY_PATH_DELIVERS`, `DUPLICATE`, `WINDOW_CLOSED`, `CANCEL_NOTICE`, `CLARIFICATION`, `UNKNOWN_TYPE`, `UNKNOWN_KIND`, `NO_CONVERSATION`, `LOCAL_FAILURE` (4500: a poison item the consumer gave up). `ack_state`: NULL (nothing owed), `PENDING`, `ACKED`, `FAILED_PERMANENT`.

Indexes: due ACKs (`next_ack_at` where `ack_state = 'PENDING'`), per-conversation replay (`conversation_ref, local_state`), the global sweeps of `HELD_HUMAN`/`SENDING` rows, and the retention purge (4500: `updated_at` where `local_state IN ('SENT', 'STALE', 'UNKNOWN')`). The 4500 `down` refuses while a `LOCAL_FAILURE` row exists. `down` refuses while a delivery owes work (PENDING ACK, SENDING, HELD_HUMAN) or a request is OPEN.

## Consumer loop

`HumanRequestFeedConsumer`, started by `HumanRequestFeedLifecycle` on bootstrap and stopped in `onModuleDestroy` (before the pool closes).

1. One consumer per database: `pg_try_advisory_lock` on a dedicated pool connection, held while consuming. Not acquired → sleep 15 s and retry. The lock is checked before each page; a dropped connection loses it and the loop reacquires.
2. `readFeed({after: cursor, limit: 50, waitSeconds: 25})`.
3. Each item in order: insert the ledger row (`ON CONFLICT DO NOTHING`; an existing row keeps its stored state and is never sent again), then handle it.
4. After the whole page is handled, save `nextCursor` together with synced_at = the instant the read began (also for an empty page: the local state was complete up to then). If an item throws, the cursor stays put and the page is read again.
   - Poison item: once the same `deliveryId` has failed at least 5 consecutive times **and** for at least 10 minutes since its first failure (both tracked together; a different `deliveryId` or a success resets them), `HumanRequestDeliveryService.abandon` records it and the page moves on, with an error log naming the `deliveryId`. Until then the page is re-read with backoff and the stuck-page error log keeps firing, so a short dependency outage (handoff-mode or window read) never gives up a valid delivery. A `RECEIVED` row (nothing sent, but a delivery may still be owed) becomes `UNKNOWN` / `LOCAL_FAILURE` + ACK `DELIVERY_UNKNOWN` with `attemptedAt` and no `providerMessageId`, so staff sees it "to reconcile" (`STALE` would tell the backend nothing needs to be sent). A `SENDING` row is left to the stuck-send sweep (`DELIVERY_UNKNOWN`). An already decided row keeps its state. With no ledger row (the insert itself fails), one inline ACK `STALE` is sent. If the ledger cannot be read, `abandon` throws and the page stays stuck. Never a resend. A page the client rejects as a whole (malformed) keeps the stuck-page behavior below.
5. Throws back off exponentially (1 s doubling, up to 60 s). After 3 failures at the same cursor, each further failure logs an **error** with the count; the page is never skipped. `RATE_LIMITED` sleeps `Retry-After`. `CURSOR_EXPIRED` logs a warning and runs the recovery below.
6. `stop` is idempotent and does not wait for an open long-poll: that page is dropped unsaved and read again later. In the middle of a page, it finishes only the item in progress. The cursor stays at the last whole page; the items already handled are in the ledger and replay without a resend. A stop during the lock acquisition opens no long-poll, and the lock connection is always released. Each wait races a per-call stop listener that is removed when the wait settles; one long-lived stop promise would retain every page. The HTTP long-poll itself is not aborted (the client has no abort signal): it ends on its own (≤ 35 s) and its result is discarded.

## Recovery after `410 CURSOR_EXPIRED` (5c)

`HumanRequestFeedConsumer.recover`, following the contract's 5-step procedure (`GET /chatbot-api/requests?status=open`, scope `requests:read`):

1. The expired cursor is no longer read from; it stays stored until step 5.
2. `updatedSince` = the stored synced_at, sent as is (the backend already reaches 5 s back); omitted when unknown (never saved).
3. Every page is walked (`cursor` = the previous `nextPage` until it is null, `limit` 50); the first page's `nextCursor` is kept. `RATE_LIMITED` sleeps `Retry-After` and asks for the same page again.
4. Per request: `NEW`/`IN_PROGRESS` → an `OPEN` registry row (from `conversationRef`, `subtype`, `legacyId`; skipped without a usable `conversationRef`; an existing row is left as is); `RESOLVED`/`CANCELLED` → the row is closed with that status. Each `pendingDeliveries` item goes through the same path as a feed item (ledger dedup by `deliveryId`, ACK each, the same poison-item rule). After the walk, local `OPEN` rows the backend did not list as open are closed (`RESOLVED`); rows created less than 60 s before the walk started are left alone (app/database clock skew, creates racing the walk).
5. Only after every page is handled and saved: the feed position = the smallest of `nextCursor` and every `undeliveredResumeAfter`, by plain string comparison (fixed-width cursors, no arithmetic), saved with synced_at = the walk start. The feed resumes from it; re-served items are de-duplicated by the ledger.

Any failure (a page, a pending delivery, a store write, `VALIDATION_ERROR` with an error log) throws: nothing past the handled items is saved, the expired cursor stays, and the next pass gets `410` again and walks from the first page. A stop during the walk saves nothing. Logs show only counts, cursors and masked refs.

## Handling

Every send first checks the HUMAN hold (`checkHandoffSendHold`), and goes through the existing `WhatsappSender`. Fixed copy uses the customer's stored style (`CustomerProfileService.styleFor` + `applyCustomerStyle`; usted when unknown). Staff text is never restyled.

| Item                                               | Action                                                                                                                                                                                                        | ACK                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `request.answered`, `kind: DECISION` (any subtype) | No send. Decision `LEGACY_PATH_DELIVERS` (L4: the legacy poll paths are the only delivery path for wrapped decisions while both exist).                                                                       | `STALE`                       |
| `request.answered`, `kind: CLARIFICATION`          | Send styled prefix (`Le comparto la respuesta del equipo:` / `Te comparto…`) + newline + staff text verbatim.                                                                                                 | `PROVIDER_ACCEPTED`           |
| `request.answered`, unrecognized kind              | No send, warning with the raw kind.                                                                                                                                                                           | `STALE`                       |
| `request.cancelled`, `DUPLICATE`                   | Close the registry row, no send.                                                                                                                                                                              | `STALE`                       |
| `request.cancelled`, other reasons                 | Close the registry row. Window open: `customerNote` verbatim after the styled prefix, else the styled notice "El equipo cerró su consulta. Si necesita algo más, escríbame por aquí." Window closed: no send. | `PROVIDER_ACCEPTED` / `STALE` |
| Unknown item type (e.g. `conversation.*`)          | No send, warning.                                                                                                                                                                                             | `STALE`                       |
| A send with no usable `conversationRef`            | No send, warning (`NO_CONVERSATION`).                                                                                                                                                                         | `STALE`                       |

Send order: mark `SENDING` with a new `attempt_id` (compare-and-set) → call Meta → store `provider_message_id` and `SENT` → ACK. Outcomes of the send:

- Meta error `131047` (re-engagement: the 24 h window is closed, surfaced as `WhatsappSendError.graphErrorCode`): `DEFERRED_WINDOW` + `DEFERRED_WINDOW_CLOSED`; for `request.cancelled`, `STALE` (never a deferral).
- Any other send error (timeout, network, ambiguous): `UNKNOWN` + `DELIVERY_UNKNOWN`. Never retried.
- A row left in `SENDING` by a crash is turned into `UNKNOWN` + `DELIVERY_UNKNOWN` (same attempt) by the sweep after 10 minutes. The consumer itself never touches a `SENDING` row.

The 24 h window for cancellation notices is read from the customer inbound observations (`readCustomerWindowOpen`, same rule as the receipt notices). A failed read throws and the page is retried.

## HUMAN holds (S4)

- Held clarification: `HELD_HUMAN`, ACK `DEFERRED_HUMAN_SESSION` (live since 5c, backend ce503ea2). A `VALIDATION_ERROR` on it is a real error: error log and `FAILED_PERMANENT` for that ACK attempt; the row stays `HELD_HUMAN` locally and is still replayed.
- Held cancellation: `HELD_HUMAN` with no ACK at all; it is decided (notice or `STALE`) once the conversation is BOT again.
- An unreadable mode fails the item (retried), never sends.
- Replay: the backend lists the deferral in pending-deliveries with `deferredReason: HUMAN_SESSION`; the next bot-mode turn (`onCustomerInbound`, below) delivers it together with the local `HELD_HUMAN` rows, once per `deliveryId`.
- The sweep re-handles `HELD_HUMAN` rows when the conversation is BOT again, with a new `attempt_id`. It reads them least recently checked first (`updated_at`). A row still held, or one whose check failed, is touched (`updated_at = now()`, guarded by state and attempt) so it moves behind the others. Conversations that stay HUMAN therefore never starve the rest.

## Window replay (S5)

`HumanRequestDeliveryService.onCustomerInbound(conversationRef)` fetches `listPendingDeliveries({conversationRef})` (both `deferredReason`s, `WINDOW_CLOSED` and `HUMAN_SESSION`), records unknown items and re-handles deferred ones with a new `attempt_id`. Then it re-handles this conversation's local `DEFERRED_WINDOW` rows: the backend does not list a deferral whose ACK is still pending or failed. Last come its `HELD_HUMAN` rows, if the conversation is BOT. Each `deliveryId` is handled at most once per call, and every claim is the compare-and-set transition. It never throws. The WhatsApp dispatcher calls it with `wa:<sender_id>` on each customer inbound that passes the S7 HUMAN gate, next to the profile warm-up, without awaiting it; a rejection or a sync throw is only logged and never delays or breaks the reply.

## Create path (S6, `askTeam`)

The minimal LLM route exposes the tool `askTeam` when `HumanRequestCreateService` is wired. The prompt fragment tells the model never to invent what a person decides (dates, discounts, returns, technical answers): when the catalog and the tools have no data it calls `askTeam` instead of guessing, and keeps helping with other things. Tool input: `question` (the customer's words, 1..1000), `summary` (one Spanish line, 1..140), optional `productIds` / `variantIds` (UUIDs, ≤ 20). One create per turn.

Envelope (`buildUnknownQuestionRequest`, `src/human-requests/domain/human-request-create.ts`): `subtype: UNKNOWN_QUESTION`, `sourceRequestId` UUID v4 (also the idempotency key), `customer` from `parseMexicanWhatsAppPhone(senderId)` (`52` + 10 digits), `conversationRef: wa:<raw sender id>`, `lastCustomerMessageAt` = the triggering inbound's time in ISO UTC (now when missing or outside the backend bounds), `summary`, `needs` = the question, `context {productIds?, variantIds?}`, `dedupKey: UNKNOWN_QUESTION:<first 24 hex of sha256(normalized question)>` (NFKC, lowercase, whitespace collapsed), `triggerWaMessageId` = the inbound wamid when bound.

The create is synchronous. The customer reply is fixed copy, styled tú/usted (the model's text is dropped):

| Create result                                                     | Local effect                                     | Reply (usted)                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `201`/`200` CREATED, REPLAYED, MERGED                             | Registry row `OPEN` (`mergedIntoId ?? id`)       | "Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan."                        |
| `CUSTOMER_OPEN_LIMIT`                                             | none                                             | "Ya tiene varias consultas abiertas con el equipo; en cuanto respondan le aviso por aquí."   |
| `CUSTOMER_RATE_LIMITED` (no auto-retry)                           | none                                             | "El equipo ya tiene sus consultas recientes; por favor espere un poco antes de enviar otra." |
| Throw (network, 5xx, timeout), `RATE_LIMITED`, `VERSION_CONFLICT` | `REQUEST_CREATE` enqueued with the same envelope | "Estoy registrando su consulta con el equipo; le aviso por aquí." (never "ya le pregunté")   |
| Other documented errors, or the enqueue also fails                | error log                                        | "Por ahora no puedo registrar esa consulta de información."                                  |

A queued create is delivered by the backend outbox adapter, which sends the one-time confirmation when the window is open and the conversation is BOT (`docs/backend-outbox.md`, including the head-of-line limitation). The tú variants of all this copy, the team prefix and the cancel notice are curated pairs in `src/llm-agent/domain/customer-style.ts`.

`HumanRequestsServicesModule` holds the store and both services (imported by `WhatsappModule` and `LlmAgentModule`); `HumanRequestsModule`, imported by `AppModule` only, adds the feed consumer, the sweeps and the outbox route registration.

## Durable ACKs

The ACK body is rebuilt from the row (`attemptId`, `outcome`, `attemptedAt`, `providerMessageId`), so a retry sends the **same body**. The first attempt runs inline; on failure the row stays `PENDING` and `HumanRequestMaintenanceWorker` (every 15 s, on every instance) retries due rows:

- `200` → `ACKED`.
- Thrown error (5xx, network) → backoff (1 s doubling, up to 5 min, jittered).
- `RATE_LIMITED` → `Retry-After`.
- `IDEMPOTENCY_CONFLICT`, `OUTCOME_ALREADY_RECORDED`, `OUTCOME_NOT_ALLOWED`, `NOT_FOUND`, `VALIDATION_ERROR` (including on `DEFERRED_HUMAN_SESSION`) → `FAILED_PERMANENT` with an error log.

All ledger writes are compare-and-set on `(local_state, attempt_id)`, so the consumer, a replay and the sweeps on several instances never claim the same send twice.

## Retention

`HumanRequestMaintenanceWorker` also purges ledger rows in a terminal local state (`SENT`, `STALE`, `UNKNOWN`) last updated more than 35 days ago (feed retention is 30 days, so the backend can no longer re-serve them), at most 500 of each kind per tick (`FOR UPDATE SKIP LOCKED`):

- `ack_state = 'ACKED'`: deleted.
- `ack_state = 'FAILED_PERMANENT'`: only the payload is replaced by a stub (`{type: 'unknown', rawType, cursor, deliveryId, raw: {purged: true}}`); the row keeps its dedup key and ACK evidence. The backend never recorded that outcome; after a deferral it could still list the delivery in pending-deliveries, and a deleted row would be sent again.
- Rows owing work (`RECEIVED`, `SENDING`, `HELD_HUMAN`, `DEFERRED_WINDOW`, a `PENDING` ACK) are never touched.

Logs of this module show a conversation as `wa:…<last 4 digits>`, never the full phone.

## Not built yet

- Delivering wrapped decisions from the feed and retiring the legacy poll paths (T2b, backend unit 13).
- `conversation.started` / `conversation.ended` items and the session ACKs (backend unit 11); today they are ACKed `STALE` as unknown types.
- `TALK_TO_HUMAN` / `COMPLAINT` creates and customer cancels from the conversation (the outbox adapter already delivers `REQUEST_CANCEL`).
- No feature flag: the consumer starts with the app; a backend without `feed:read` keeps it in backoff with error logs.
