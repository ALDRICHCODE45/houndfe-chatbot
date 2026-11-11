# Human request feed consumer

The chatbot side of backend unit 5b (`docs/contracts/human-intervention-bot-contract-5b.md`): it reads `GET /chatbot-api/feed`, handles each item locally, and reports one delivery outcome per attempt. Code: `src/human-requests/`. Task: `odd/tasks/human-intervention-feed-consumer.md` (T2a; decision L4).

> The cursor is for reading; the ACK is for delivering.

## Tables (migration 4300)

| Table                       | Purpose                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human_request_feed_cursor` | One row, keyed by the consumer name `human_request_feed:consumer`. `cursor` NULL = start from the oldest retained item.                                                                                                                                                                                                          |
| `human_request_deliveries`  | Delivery ledger. `delivery_id` is the primary key, inserted **before** any Meta call. `payload` keeps the whole parsed feed item. Local state, decision, the current attempt (`attempt_id`, `attempted_at`, `provider_message_id`) and the durable ACK (`ack_state`, `ack_outcome`, `ack_attempts`, `next_ack_at`, `ack_error`). |
| `human_request_registry`    | Requests the bot created or that staff cancelled: `request_id`, `conversation_ref`, `subtype`, `legacy_id`, `status` (`OPEN`, `CANCELLED`, `RESOLVED`). The create path (T3) writes `OPEN` rows; a staff `request.cancelled` closes them.                                                                                        |

`local_state`: `RECEIVED`, `SENDING`, `SENT`, `STALE`, `UNKNOWN`, `DEFERRED_WINDOW`, `HELD_HUMAN`. `decision`: `LEGACY_PATH_DELIVERS`, `DUPLICATE`, `WINDOW_CLOSED`, `CANCEL_NOTICE`, `CLARIFICATION`, `UNKNOWN_TYPE`, `UNKNOWN_KIND`, `NO_CONVERSATION`. `ack_state`: NULL (nothing owed), `PENDING`, `ACKED`, `FAILED_PERMANENT`.

Indexes: due ACKs (`next_ack_at` where `ack_state = 'PENDING'`), per-conversation replay (`conversation_ref, local_state`), and the global sweeps of `HELD_HUMAN`/`SENDING` rows. `down` refuses while a delivery owes work (PENDING ACK, SENDING, HELD_HUMAN) or a request is OPEN.

## Consumer loop

`HumanRequestFeedConsumer`, started by `HumanRequestFeedLifecycle` on bootstrap and stopped in `onModuleDestroy` (before the pool closes).

1. One consumer per database: `pg_try_advisory_lock` on a dedicated pool connection, held while consuming. Not acquired → sleep 15 s and retry. The lock is checked before each page; a dropped connection loses it and the loop reacquires.
2. `readFeed({after: cursor, limit: 50, waitSeconds: 25})`.
3. Each item in order: insert the ledger row (`ON CONFLICT DO NOTHING`; an existing row keeps its stored state and is never sent again), then handle it.
4. After the whole page is handled, save `nextCursor`. If an item throws, the cursor stays put and the page is read again.
5. Throws back off exponentially (1 s doubling, up to 60 s). After 3 failures at the same cursor, each further failure logs an **error** with the count; the page is never skipped. `RATE_LIMITED` sleeps `Retry-After`. `CURSOR_EXPIRED` logs a warning and restarts with cursor NULL (the ledger de-duplicates).
6. Stop does not wait for an open long-poll: that page is dropped unsaved and read again later.

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

- Held clarification: `HELD_HUMAN`, ACK `DEFERRED_HUMAN_SESSION`. If the backend answers `VALIDATION_ERROR` (slice 5c not live yet), the hold stays local (`ack_state` NULL), without an error.
- Held cancellation: `HELD_HUMAN` with no ACK at all; it is decided (notice or `STALE`) once the conversation is BOT again.
- An unreadable mode fails the item (retried), never sends.
- The sweep re-handles `HELD_HUMAN` rows when the conversation is BOT again, with a new `attempt_id`.

## Window replay (S5)

`HumanRequestDeliveryService.onCustomerInbound(conversationRef)` fetches `listPendingDeliveries({conversationRef})`, records unknown items, re-handles deferred ones with a new `attempt_id`, then re-handles this conversation's `HELD_HUMAN` rows if it is BOT. It never throws. The WhatsApp dispatcher calls it with `wa:<sender_id>` on each customer inbound that passes the S7 HUMAN gate, next to the profile warm-up, without awaiting it; a rejection or a sync throw is only logged and never delays or breaks the reply.

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
- `IDEMPOTENCY_CONFLICT`, `OUTCOME_ALREADY_RECORDED`, `OUTCOME_NOT_ALLOWED`, `NOT_FOUND`, other `VALIDATION_ERROR` → `FAILED_PERMANENT` with an error log.

All ledger writes are compare-and-set on `(local_state, attempt_id)`, so the consumer, a replay and the sweeps on several instances never claim the same send twice.

## Not built yet

- Delivering wrapped decisions from the feed and retiring the legacy poll paths (T2b, backend unit 13).
- `conversation.started` / `conversation.ended` items and the session ACKs (backend unit 11); today they are ACKed `STALE` as unknown types.
- The 410 recovery route (`GET /chatbot-api/requests?status=open&updatedSince=`).
- `TALK_TO_HUMAN` / `COMPLAINT` creates and customer cancels from the conversation (the outbox adapter already delivers `REQUEST_CANCEL`).
- No feature flag: the consumer starts with the app; a backend without `feed:read` keeps it in backoff with error logs.
