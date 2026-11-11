# Human intervention — chatbot feed consumer and request client

Connect the chatbot to backend unit 5 (create, cancel, feed, delivery outcome). Branch `feat/human-intervention-feed-consumer` from main 2649cc0.
Contracts: `docs/contracts/human-intervention-v1.md`, `docs/contracts/human-intervention-requests-5a.md`, and `docs/contracts/human-intervention-bot-contract-5b.md` (copy of the backend file at aab7fb6e: feed, item payloads, outcome, pending deliveries). Prerequisites already on main: transcript, backend_outbox, handoff mode, holds, dedup claims, durable gates.
Dev test backend: `http://localhost:3003`, branch id `ced6cc10-a037-4f41-92af-ee69bbb51c8b`, credential token read from `/tmp/houndfe-dev-bot-token.txt` at runtime only (never committed or logged).

## Specs

- S1 — Chatbot-api client methods for `POST /chatbot-api/requests`, `POST /chatbot-api/requests/:id/cancel`, `GET /chatbot-api/feed`, `POST /chatbot-api/deliveries/:deliveryId/outcome`, `GET /chatbot-api/requests/pending-deliveries`, with typed results for every documented error (`CUSTOMER_OPEN_LIMIT`, `CUSTOMER_RATE_LIMITED` + Retry-After, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `ALREADY_RESOLVED` with `resolution`, `REQUEST_CLOSED`, `CANCEL_NOT_ALLOWED`, `CURSOR_EXPIRED`, `OUTCOME_ALREADY_RECORDED`). The long-poll request timeout must exceed `waitSeconds` (25 s → about 35 s).
- S2 — Feed consumer: one consumer per database (pg advisory lock), cursor persisted in the chatbot DB, the `deliveryId` stored as a unique key BEFORE calling Meta, then `POST …/outcome` with `PROVIDER_ACCEPTED` (with `providerMessageId`), `DELIVERY_UNKNOWN` (never retried), `DEFERRED_WINDOW_CLOSED`, or `STALE`. The cursor only advances after the item's local effect is committed. Contract: "The cursor is for reading; the ACK is for delivering."
- S3 — Delivery of `request.answered`: compose the customer text from the structured fields in the customer's tú/usted style; `text` and `prefix` are only a fallback (backend: "Compose the customer text yourself from the structured fields with the customer's tú/usted; text and prefix are only a fallback"). Clarifications are delivered verbatim with the team-reply prefix. Staff `request.cancelled`: DUPLICATE silent + STALE; other reasons a short notice (or `customerNote` verbatim) only if the window is open, else STALE.
- S4 — HUMAN mode: a delivery for a conversation in HUMAN mode is not sent while the person attends (existing hold helper). Backend (verbatim): "adding outcome DEFERRED_HUMAN_SESSION … Non-terminal, the same as DEFERRED_WINDOW_CLOSED … The bot replays it after the session ends (conversation.ended, unit 11) or on the next bot-mode turn … Not allowed on request.cancelled … Until 5c lands on the dev backend, hold the deliveryId durably on your side." A held request.cancelled is not deferred: it waits locally and is decided (notice or STALE) once the conversation is back in BOT mode.
- S5 — Window: when Meta rejects for a closed 24 h window, ACK `DEFERRED_WINDOW_CLOSED`; on the customer's next inbound, fetch `pending-deliveries` for that conversation and deliver them.
- S6 — Create path for the e2e run: the bot creates an `UNKNOWN_QUESTION` request through the outbox `REQUEST_CREATE` kind (wire the HTTP delivery adapter for the kinds the backend supports; others stay retrying), tells the customer only after `201/200`, and handles the limit errors with a clear message.
- S7 — Unit 5 closes after an end-to-end run against the dev backend: create → staff resolve/cancel → feed item → outcome ACK.

## Tasks

| ID  | Specs          | Route                                                                                            | Commit  |
| --- | -------------- | ------------------------------------------------------------------------------------------------ | ------- |
| T1  | S1             | worker: chatbot-api client for requests/feed/outcome                                             | 5969a90 |
| T2a | S2, S3, S4, S5 | worker: feed consumer core, delivery ledger, request registry, cancelled + window + HUMAN holds  | —       |
| T2b | S3             | worker: wrapped decisions reconciled with the legacy delivery paths (first one wins by legacyId) | —       |
| T3  | S6             | worker: outbox HTTP adapter + UNKNOWN_QUESTION create path                                       | —       |
| T4  | S7             | parent: e2e run against the dev backend + full suite                                             | —       |

## Log

- L1 — Owner, 2026-11-10: "2. Si, merge a main de lo que recomiendes." (after recommending to connect the chatbot once the backend's unit 5 is on a test backend).
- L2 — Backend, 2026-11-10: dev test backend up at http://localhost:3003 (feat/human-intervention aab7fb6e); unit 5 closes after an end-to-end run where the chatbot feed consumer drives create → staff resolve/cancel → feed item → outcome ACK. Not built yet: the 410 recovery route and conversation.\* items (unit 11).
- L3 — 2026-11-10: T1 client committed 5969a90 (HUMAN_REQUESTS_CLIENT port; documented errors as typed results; feed timeout waitSeconds+10 s). Design note: in 5b the feed only carries wrapped DECISION answers (the legacy poll paths already deliver them) and staff cancellations; clarification answers arrive with backend unit 10. So T2 is split: T2a core consumer, T2b reconciliation with the legacy paths so the customer never gets the same answer twice (contract: "Track the answer by the request's legacyId: whichever arrives first is delivered, and the other is ACKed STALE (feed) or ignored (poll).").
