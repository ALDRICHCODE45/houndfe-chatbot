# E2E scripts

These scripts call a running **dev** backend. They write dev data, so never point them at production.

- `contract-smoke.ts`: live contract smoke test of `ChatbotApiHttpClient`. See `docs/e2e-contract-smoke.md`.
- `human-requests-feed-e2e.ts`: spec S7 run of the human request feed (create → staff resolve/cancel → feed item → outcome ACK), plus a read-only look at the 5c recovery route.
- `human-requests-feed-e2e.ts --phase schedule` / `schedule-feed`: unit 14 scheduled conversations (offer, booking, change, cancel, reminder and staff reschedule items).
- `backorder-e2e.ts`: restock backorder rehearsal (RESTOCK → team estimate → schedule → stock arrives → reserved → checkout with `backorderId`), with cleanup. See `backorder-e2e` below.
- `conversation-mirror-e2e.ts`: spec S8 run of the conversation mirror and media (backend unit 9): upload, mirror, idempotent resend and delivery statuses. `--phase outbox` runs the full delivery stack (outbox, drain worker, adapters, media service) instead.

## human-requests-feed-e2e

The script uses the real `ChatbotApiHttpClient`, `HumanRequestFeedConsumer` (driven through `runOnce`, with a no-op lock instead of the Postgres advisory lock) and `HumanRequestDeliveryService`, over the in-memory feed store. The other ports are fakes:

- WhatsApp sender: records each text and returns `wamid.e2e-<uuid>`. It never sends a real message.
- Handoff mode: always BOT.
- 24 h window: always open.
- Customer style: usted.

It never touches the chatbot Postgres DB. On the backend, it creates requests and records the outcome ACKs.

Defaults: base URL `http://localhost:3003` and branch `ced6cc10-a037-4f41-92af-ee69bbb51c8b`. You can override them with `CHATBOT_API_BASE_URL` and `CHATBOT_API_BRANCH_ID`. The script reads the bearer token from `/tmp/houndfe-dev-bot-token.txt` itself and never prints it. Do not pass the token on the command line or put it in an env var.

```sh
# Create one UNKNOWN_QUESTION request, then wait up to 15 min for its feed item
pnpm e2e:human-requests

# Create only, then consume in a separate run (staff resolves or cancels in between)
pnpm e2e:human-requests --phase create --phone 5550001111
pnpm e2e:human-requests --phase consume --request <requestId> --minutes 20

# Also create a wrapped RESTOCK request (it should come back as LEGACY_PATH_DELIVERS / STALE)
pnpm e2e:human-requests --with-restock <productId>

# Resume from a known cursor instead of the current feed tail
pnpm e2e:human-requests --phase consume --after <cursor>

# Read-only: walk the 5c recovery route once (all pages), ACK nothing
pnpm e2e:human-requests --phase recovery
pnpm e2e:human-requests --phase recovery --updated-since 2026-11-10T00:00:00.000Z
```

Arguments:

| Flag                                     | Default          | Meaning                                                                                                      |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `--phase create\|consume\|all\|recovery` | `all`            | Which phases to run. `recovery` runs alone                                                                   |
| `--phone`                                | `5550001111`     | 10-digit test number. The customer is `52` + phone, and `conversationRef` is `wa:521<phone>`                 |
| `--minutes`                              | `15`             | Long-poll budget for the consume phase                                                                       |
| `--after`                                | the current tail | Start cursor. Without it, the script first reads the feed with `waitSeconds=0` until a page comes back empty |
| `--with-restock <productId>`             | off              | Also create a RESTOCK request, using the human-decisions intake body as `detail`                             |
| `--request <id>`                         | none             | Repeatable. Request ids to wait for in `--phase consume`                                                     |
| `--updated-since <ISO>`                  | none             | `--phase recovery` only: `updatedSince` (canonical UTC ms, e.g. `2026-11-10T00:00:00.000Z`)                  |

### `--phase clarification` (unit 10 T2)

Consumes the staff clarification reply (`request.answered`, kind `CLARIFICATION`) of ONE request created earlier, sends it, ACKs it and mirrors it with `staffReplyId`:

```sh
pnpm e2e:human-requests --phase create --phone 5550006666
# ... staff replies on the backend (give them the cursor just before the item) ...
pnpm -s e2e:human-requests --phase clarification --request <requestId> --phone 5550006666 --minutes 10
pnpm -s e2e:human-requests --phase clarification --request <requestId> --phone 5550006666 --after <cursor-before-the-item>
```

- `--request` is required (exactly one). `--minutes` defaults to 10. `--after` starts right after that feed cursor (12 digits, e.g. `000000000006`) instead of the tail, so a reply that arrives before the consumer is listening is not missed.
- `[consume] listening cursor=…` is written with `writeSync` as soon as the start cursor is known, so a background log shows it at once.
- Sender: the REAL `MetaWhatsappSender` over a stub `HttpService.post` that returns `wamid.e2e-<runId>-<n>` (Meta is never called). Its production transcript path runs unchanged (`staffReplyId` → `details.staffReplyId`), into the real `TranscriptRecorder` (in-memory transcript store, `InMemoryBackendOutboxStore`). The 24 h window is a stub (always open).
- Once the item is handled and ACKed, the outbox is drained with the real `BackendOutboxDrainWorker`, `RoutingBackendOutboxDelivery`, `MirrorMessagesDelivery`, `MirrorStatusesDelivery` and `MirrorMediaService` against the real `ChatbotApiHttpClient`. An axios interceptor records the `messages:batch` status and whether each message body carried `staffReplyId` (never headers or keys).
- Output: `[result] item` (type, kind, replyId), `[result] ack` (outcome, state, HTTP), `[result] sent` (text, and whether `staffReplyId` leaked into the Meta payload), `[outbox]` final states, `[mirror]` the batch call, `[result] mirror` (OUT `waMessageId`, `staffReplyIdPresent`), `[summary]`.
- Exit code 1 when the item kind is not `CLARIFICATION`, the ACK is not `PROVIDER_ACCEPTED` with HTTP 200, no `messages:batch` call returned 200, `staffReplyId` is missing from the mirror body or leaked into the Meta payload, or an outbox row is not DONE.

Output lines:

- `[create.*]`: the request id and folio.
- `[item]`: one line per feed item, with the cursor, type, requestId, decision, local state, ACK outcome and state, the ACK's HTTP status and code, and the client result.
- `[summary]`: item counts per ACK outcome, the text of every fake send, and every non-200 ACK with its code.
- `[recovery]` (`--phase recovery`): one line per request (id, folio, kind, subtype, status, the conversation masked as `wa:…1234`, its pending deliveries with cursor, deliveryId, type and `deferredReason`, the truncated flag and `undeliveredResumeAfter`), then a summary: pages, counts per status, pending deliveries per `deferredReason`, truncated requests, `nextCursor` (and whether it was the same on every page) and the resume position `min(nextCursor, undeliveredResumeAfter…)`. It never ACKs or writes anything.

The run stops when every created (or `--request`) request has had an item handled. It also stops at the time limit, on Ctrl-C, after 5 consecutive page failures, or on `CURSOR_EXPIRED`. It stops on `CURSOR_EXPIRED` instead of running the recovery, because the recovery would ACK unrelated dev deliveries; inspect the route with `--phase recovery` instead. The exit code is 1 when an ACK was not 200 or a watched request got no item.

Every item from the starting cursor on is handled and ACKed, including items for other dev requests. That is how the real consumer behaves.

### `--phase live-create` and `--phase live` (unit 11 T9)

Drive the live conversation (silence protocol: started → staff messages → ended) against the dev backend. Needs the credential scopes `media:read` and `conversation:write` (plus `media:write` for the mirror).

```sh
# 1. Create a TALK_TO_HUMAN request through the real create path (writes a dev request)
pnpm -s e2e:human-requests --phase live-create --phone 5550007777
#    prints: [live-create] ok requestId=… folio=… cursor=…   (cursor = the feed tail after the create)

# 2. Start consuming right after that cursor, then let staff claim / write / end on the backend
pnpm -s e2e:human-requests --phase live --phone 5550007777 --request <requestId> --after <cursor> --minutes 10
pnpm -s e2e:human-requests --phase live --phone 5550007777 --request <requestId> --after <cursor> --window-closed
```

`--phase live-create` uses `HumanRequestCreateService.requestTalkToHuman` over the real `ChatbotApiHttpClient` (dedupKey merges a repeat into the open request: then `outcome=MERGED`). It prints `requestId`, `folio` and the feed `cursor`, and sends nothing to the customer. It exits 1 when the create is not registered.

`--phase live` wires the real production pieces: `HumanRequestFeedConsumer` (`runOnce`, no advisory lock), `HumanRequestDeliveryService`, `LiveConversationService` with the real `HandoffModeService` over an `InMemoryConversationStore`, the real `ChatbotApiHttpClient` (feed, session-ack, state, staff media download, outcome ACKs, `messages:batch`), the real `MetaWhatsappSender` over a stub transport (fake wamids `wamid.e2e-<runId>-<n>` and fake Meta media ids `e2e-media-<runId>-<n>`: Meta is never called), the real `TranscriptRecorder` with an in-memory outbox, and, at the end, the real mirror drain. The 24 h window is a stub: open, or closed with `--window-closed` (it only affects the local window checks; the stub transport always accepts a send).

- `--request` is required (exactly one). `--minutes` defaults to 10. `--after` starts right after that cursor (without it, the current tail). `[consume] listening …` is written with `writeSync` as soon as the start cursor is known.
- Only items of the conversation `wa:521<phone>` are handled. Items of other conversations are skipped (logged as `skipped item of another conversation`, never handled or ACKed), because a live item would session-ack somebody else's session on dev.
- The run stops when a `conversation.ended` of the watched request was handled, or at the time bound (Ctrl-C also stops it).
- Output, in order of occurrence: `[live] session-ack` (state, epoch, HTTP, the answer), `[live] outcome-ack` (including replayed deliveries), `[live] staff media downloaded` (mimeType, filename, size, sha256) and `[live] meta upload (stub)`, `[live] would send` (origin BOT|STAFF|TEMPLATE, `wouldMirror`, text verbatim, for media the mimeType, `sentAs` image|document and the downloaded sha256, mode and epoch at send time), and per item `[live] item` (type, epoch, decision, local state, ACK outcome and HTTP, `modeAfter`, `epochAfter`). Then `[outbox]` and `[mirror] messages:batch` (per message: direction, author, type, whether `staffReplyId` was present, text only for BOT messages; plus the `{mode, handoffEpoch}` hint) and `[summary]`.
- Exit code 1 when: no `conversation.ended` was handled; a greeting went out without a prior session-ack STARTED of its epoch, or after a non-200 one; a staff message or template was enqueued for the mirror or appears in a `messages:batch` (by wamid, by text, or with a `staffReplyId`); a BOT message (greeting, farewell, reassignment, resume) was not mirrored as BOT in a 200 call; a staff message or template was sent while the mode was not HUMAN (or, for a staff item handled directly, on another epoch than the item's); the farewell was not the first send of its `ended` item, or a replayed outcome ACK or the session-ack ENDED came before it; a send was never recorded in the transcript; or an outbox row is not DONE.

### `--phase schedule` and `--phase schedule-feed` (unit 14 T7)

Drive scheduled conversations against the dev backend (branch with scheduling ON). Both WRITE dev data.

```sh
# 1. Simulated customer: ask for a person → offer → book → "¿a qué hora quedé?" → change. Books a real dev appointment.
pnpm -s e2e:human-requests --phase schedule --phone 5550008888
pnpm -s e2e:human-requests --phase schedule --phone 5550008888 --cancel      # also "cancela mi cita" at the end
pnpm -s e2e:human-requests --phase schedule --phone 5550008888 --no-drill    # skip the lost-answer retry drill
#    prints: [e] … requestId=… cursor=… scheduledFor=… scheduleVersion=…   (use them below)

# 2. Staff reschedules (or the reminder comes due) on the backend, then consume the feed item:
pnpm -s e2e:human-requests --phase schedule-feed --phone 5550008888 --request <requestId> --after <cursor> \
  --scheduled-for <ISO from [e]> --version <n from [e]> --minutes 10
```

`--phase schedule` wires the real `SchedulingOutOfHoursPolicy`, `AppointmentIntentService` and `SchedulingStateService` over an `InMemoryConversationStore`, the real `ChatbotApiHttpClient` (also behind `SCHEDULING_CLIENT`) and the real customer styling. Nothing is sent to WhatsApp: each bot reply is printed as `text` (usted, as the dispatcher sends it) and `tuText`. Every backend call is printed as `[backend] <METHOD> <route>` (conversation ref masked, only the first 8 characters of an idempotency key, never headers).

Steps:

- `a`: "quiero hablar con una persona" → `planAsk` → `listSlots` (`openNow`, `nextOpenAt`, `timeZone`, `slots`) → the offer text. If the branch is OPEN now, the out-of-hours offer cannot be exercised: the script says so and stores an offer built from the first slots, so change / cancel still run.
- `b`: "2" (or "1" when open) → inline booking (`requestId`, `folio`, `scheduledFor`, `scheduleVersion`, `requiresTemplateAtStart`) → booked text. A phone that already holds a scheduled request gets `ALREADY_SCHEDULED` and the run continues with that request.
- `c`: "¿a qué hora quedé?" → what-time text.
- `d`: "quiero cambiar mi cita" → reschedule offer → a slot other than the current one → reschedule → rescheduled text. By default a **retry drill** runs: the first reschedule call is processed by the backend but its answer is replaced by `RETRYABLE` (a timeout after the commit); the bot must keep the offer and key, and the same message is then redelivered (same timestamp) and must reuse the same `X-Idempotency-Key`. `--no-drill` skips it.
- `e`: prints the feed tail `cursor`, `requestId` and the stored appointment, so staff can reschedule it on the backend; stops (exit 0) unless `--cancel`, which sends "cancela mi cita" and expects the cancelled text and no stored appointment.

Exit code 1 when: the booking was not an inline 2xx scheduled answer, the backend outbox was used, or the unscheduled create was called; any scheduling call (`slots`, scheduled create, reschedule) lacks `lastCustomerMessageAt` (checked on the typed input and on the wire); a reply is not the output of an approved builder (`scheduling-copy.ts`, recomputed from what the backend answered); a reschedule retry did not reuse its key; the stored appointment does not hold the chosen slot.

`--phase schedule-feed` consumes from `--after` with the real `HumanRequestFeedConsumer` (`runOnce`, no advisory lock), `HumanRequestDeliveryService` and `ScheduledConversationService`, whose reader / writer are `StoredAppointmentReader` / `SchedulingStateService` over an in-memory store seeded with the appointment of `--scheduled-for` and `--version`. The real `ChatbotApiHttpClient` and the real `MetaWhatsappSender` over a stub transport are used (Meta is never called); the 24 h window is a stub (open, or closed with `--window-closed`). Required: `--request`, `--after`, `--scheduled-for`, `--version`; `--minutes` defaults to 10.

- Only `conversation.rescheduled` / `conversation.scheduled_reminder` of the request are handled; everything else (other requests, live items) is skipped and never ACKed.
- Per item it prints type, `scheduledFor`, `previousScheduledFor`, `scheduleVersion`, decision, local state, ACK outcome and HTTP, the text sent, and the stored appointment before and after. It stops after the first handled item of the request, or at the time bound.
- Exit code 1 when: an ACK outcome is not `PROVIDER_ACCEPTED` / `DELIVERY_UNKNOWN` / `STALE` or its HTTP is not 200; nothing was sent and the ACK is not `STALE`; the sent text is not the approved builder's output; a `rescheduled` item left the stored appointment without the item's time and version; or no item was handled before the time bound.

## conversation-mirror-e2e

Drives the real `ChatbotApiHttpClient` methods `uploadMedia`, `mirrorMessages` and `recordMessageStatuses` (with `mediaIdempotencyKey`) against the dev backend. It needs the credential scopes `conversation:write` and `media:write`. No chatbot Postgres, no WhatsApp: only the backend is called, and it **writes dev data** (a media file, a conversation `wa:521<phone>` and its messages).

Same config as the feed script: `CHATBOT_API_BASE_URL` (default `http://localhost:3003`), `CHATBOT_API_BRANCH_ID`, and the bearer token read from `/tmp/houndfe-dev-bot-token.txt`. It never prints the token, headers, the phone or the full conversation ref (masked as `wa:…1234`).

```bash
pnpm e2e:conversation-mirror
pnpm e2e:conversation-mirror --phone 5550004444
pnpm e2e:conversation-mirror --phase outbox --phone 5550005555
```

| Flag      | Default      | Meaning                                                                                |
| --------- | ------------ | -------------------------------------------------------------------------------------- |
| `--phase` | `client`     | `client`: the client-level flow below. `outbox`: the full delivery stack (see the end) |
| `--phone` | `5550004444` | 10-digit test number. `conversationRef` is `wa:521<phone>`                             |

Steps (every id is unique per run: `e2e-image-<runId>`, `wamid.e2e-<runId>-<n>`):

1. `[media.upload]` uploads a tiny generated PNG (key `mediaIdempotencyKey('e2e-image-<runId>')`) and prints `mediaId`, `created`, `mimeType`, `sizeBytes`. `[media.replay]` uploads it again with the same key and expects `created=false` and the same `mediaId`.
2. `[mirror]` sends one batch, in order: IN text, OUT text with `Opciones: …`, IN text (button reply title), IN image (the `mediaId`), IN `UNSUPPORTED` `LOCATION`, OUT text. It prints each `waMessageId` with its `seq`.
3. `[mirror.resend]` sends the same batch again and expects every message back as a duplicate.
4. `[statuses]` sends SENT → DELIVERED → READ for message 2, FAILED (`errorCode` 131026) for message 6, and one unknown id; it prints `applied`, `ignored` and `unknown`.
5. `[summary]` prints the masked conversation, the `mediaId` and the `waMessageId`s, so the backend can check the staff read.

The exit code is 1 when a step returns a non-ok typed result (the line shows `kind` and any status/code, never the phone) or when an idempotency expectation fails (replay `created=true`, resend not all duplicates, unknown id not reported). The generated PNG is left in a temp directory under the OS temp dir.

### `--phase outbox`: the real delivery stack

Builds the production pieces by hand, with no Nest app and no chatbot Postgres:

- `InMemoryBackendOutboxStore` and `BackendOutboxService.enqueue`, the same enqueue API production uses. Mirror payloads come from the production `mirrorPayload` builder.
- `BackendOutboxDrainWorker` (driven through `tick()`), `RoutingBackendOutboxDelivery`, and the real `MirrorMessagesDelivery` and `MirrorStatusesDelivery` with one `MirrorDeliveryGate`.
- `MirrorMediaService` with an `InMemoryMirrorMediaCacheStore` and the real `LinkMirrorFetcher`. The Meta downloader is a stub that fails the run if it is ever called (no inbound media here).
- The real `ChatbotApiHttpClient` over an axios instance whose interceptors count every HTTP call per route (the conversation ref is replaced by `:ref`).

Rows enqueued for `wa:521<phone>`, in this order:

1. A `DELIVERED` status for OUT message 14, before its mirror row (the race).
2. 55 `MESSAGE_MIRROR` rows (50 + 5, so two batches): IN/OUT text, one OUT interactive with `options` (message 10), one OUT product photo with `media.link` (message 20, a public `raw.githubusercontent.com` PNG, printed in `[config]`), one IN `location` (30) and one old-style OUT row with no `providerTimestamp` or `contractType` (40, the backfill path).
3. Statuses: `DELIVERED` for 2, 4, 6, 10, 20; `READ` for 2, 10, 20; `FAILED` (131026) for 8; `SENT` for 12; and `DELIVERED` for an id that is never mirrored.

The worker is ticked until nothing is PENDING/IN_FLIGHT or 3 minutes pass. Output:

- `[pass1] rows`: final state counts (`DONE`, `RETRY` = pending with attempts, `DEAD`, leftover `PENDING`/`IN_FLIGHT`), and any row that is not DONE with its (truncated) last error. The total includes the rows the status adapter re-enqueued for unknown ids.
- `[pass1] http`: calls per route with the HTTP statuses seen. Expected: 2 `messages:batch` calls, 1 `POST /media`, and a few `statuses:batch` calls (the race, the main batch, and the retries of the never-mirrored id until the adapter gives up after 3 attempts).
- `[pass1] media`: the uploaded product photo `mediaId`, link opens and Meta downloads.
- `[pass2]`: a new OUT product-photo row with the same URL is enqueued and drained. It must resolve from the cache with the same `mediaId` and no new `POST /media`.

Exit code 1 on any DEAD row, any row left open (RETRY/PENDING/IN_FLIGHT), no photo `mediaId`, a cache miss in pass 2, or a Meta download. It writes dev data on the backend (one media file, the conversation and its messages). The default Nest logger prints the adapters' log lines, with the conversation masked.

## backorder-e2e

Rehearsal of the restock backorder (spec `odd/tasks/restock-backorder.md` T7, S1-S9) against the dev backend on `http://localhost:3003`. It uses the chatbot's own clients (`ChatbotApiHttpClient`: RESTOCK intake and poll, feed, delivery ACK, checkout; `BackorderHttpClient`) and a staff session only for what the team does (answer the RESTOCK, raise the stock, cancel the sale).

```sh
# load the dev environment into the shell first (never edit or print the env file)
pnpm e2e:backorder
```

Environment (never printed):

| Variable                                 | Meaning                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CHATBOT_API_BASE_URL` (required)        | Must be `http://localhost:3003` (or `127.0.0.1:3003`); any other value is refused          |
| `SERVICE_KEY` (required)                 | Chatbot `svc_` key with the `backorders:*`, catalog, checkout and `human-decisions` scopes |
| `CHATBOT_API_BRANCH_ID`                  | Branch header; default the dev branch of the other e2e scripts                             |
| `CHATBOT_API_CASHIER_USER_ID`            | Sale cashier; default the dev bot cashier                                                  |
| `E2E_STAFF_EMAIL` / `E2E_STAFF_PASSWORD` | Staff login; default the documented dev demo account (safe: the base URL is local only)    |
| `E2E_BACKORDER_ACK=0`                    | Observe `backorder.reserved` without ACKing it (default: ACK `STALE`, nobody is messaged)  |

Steps (each prints PASS, WARN or FAIL with the HTTP status and the error code):

0. Staff login; preflight (product «Premios Pro Plan Biscuits Pollo 300 g» has stock 0, no variants and no active backorder, otherwise abort without changes); feed tail.
1. RESTOCK intake through `submitRestockIntake` (keeps the decision id).
2. Staff reads the decision version and answers `PROVIDE_RESTOCK_ESTIMATE` (7 days); the bot's `getRestockDecision` poll shows it; `request.answered` is only observed (WARN if it does not appear).
3. `createBackorder` (quantity 2, test customer) → 201 `WAITING`; the same key replays 200; the phone list contains it.
4. Staff stock adjustment +2 → backorder `RESERVED` (`finalPriceCents`, `reservedUntil` about 24 h, phone present); `backorder.reserved` on the feed (same price, phone) and ACK `STALE`.
5. A deliberately wrong checkout (`finalPriceCents + 1`) must be `409 PRICE_OUT_OF_DATE`, mapped by `backorderCheckoutFailure` with `currentPriceCents`; then the real pickup checkout (`sale.items[0].backorderId`, total `finalPriceCents × 2`) → 201 and the backorder is `CONFIRMED` with the sale id.
6. Cleanup in a `finally` (also after a failure): cancel the sale (`ORDER_ERROR`) or the active backorder, adjust the stock back to 0 (`DATA_ENTRY_CORRECTION`), then verify stock 0 and no active backorder. Whatever it could not clean is printed as `NOT_CLEANED` and the exit code is 1. The RESTOCK decision and the test customer cannot be deleted and stay in the dev database.

Exit code: 0 all steps passed and clean; 1 a step failed or something is not cleaned; 2 missing env or a refused base URL. Writes DEV data only.

## pets-e2e

Live rehearsal of multi-pet customer profiles (spec `odd/tasks/multi-pet-profiles.md` T7, S1-S9, S14-S16; contract `docs/contracts/customer-pets-bot-contract.md`) against the dev backend. It drives the chatbot's real `ChatbotApiHttpClient` (customers by-phone, pets, catalog search, evaluate-cart, checkout, order history, sale cancel). A staff session is used only as a fallback to cancel the test sale when the bot cancel is refused.

```sh
# load the dev environment into the shell first (never edit or print the env file)
pnpm e2e:pets
```

Environment (never printed; every output line is redacted for the key, any `svc_…` value, `Bearer …` tokens and the staff password):

| Variable                                 | Meaning                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CHATBOT_API_BASE_URL` (required)        | Must be plain `http://` on an allow-listed dev host (`localhost:3003`, `127.0.0.1:3003`; `DEV_HOST_ALLOW_LIST` in `pets-e2e-lib.ts`)     |
| `SERVICE_KEY` (required)                 | Chatbot `svc_` key with `customers:read/write`, `pets:read/write/delete`, `catalog:read`, `pricing:evaluate`, checkout and `sales:write` |
| `CHATBOT_API_BRANCH_ID`                  | Branch header; default the dev branch of the other e2e scripts                                                                           |
| `CHATBOT_API_CASHIER_USER_ID`            | Sale cashier; default the dev bot cashier                                                                                                |
| `E2E_PETS_PHONE`                         | Test phone (country code `52`); must be 10 digits starting with `555`; default `5550002222`                                              |
| `E2E_PETS_PRODUCT_QUERIES`               | Comma-separated catalog searches used to pick 2 plain in-stock products; default `croquetas,premios,shampoo,juguete,collar,arena`        |
| `E2E_STAFF_EMAIL` / `E2E_STAFF_PASSWORD` | Staff login for the cancel fallback only; default the documented dev demo account                                                        |

Safety: before any write, a customer found by the test phone whose first name does not start with `E2E ` is refused (exit 1, nothing written). Only the test customer's pets named `Max` / `Bruno` are ever deleted; any other pet is left alone.

Steps (each prints PASS, SKIP or FAIL with the HTTP status and the error code; the first FAIL stops the run and the cleanup still runs):

1. `1a` by-phone lookup (refuses a non-test customer), `1b` `PUT customers/by-phone` (first name `E2E Pets`, a CDMX address), `1c` by-phone resolves to the same customer and carries `customer.pets` (else the credential lacks `pets:read`).
2. `2` list pets `?status=ALL` and delete leftover `Max` / `Bruno` pets of earlier runs (with version; one reread on a conflict; 404 = gone).
3. `3a` create Max (DOG, Labrador, LARGE, birth date YEAR → stored `YYYY-01-01`, `ageLabel` with `~`, `createdVia` CHATBOT, version 1) under an idempotency key; `3b` same key + body → 200 identical; `3c` changed body, same key → `409 IDEMPOTENCY_KEY_CONFLICT`.
4. `4` create Bruno (DOG, Chihuahua, SMALL, MONTH precision → stored on the 1st) → `ageLabel` and `ageMonths` present.
5. `5` by-phone `customer.pets` lists both, ACTIVE.
6. `6a` PATCH Max allergies «pollo» with the version → version + 1; `6b` the stale version → `409 PET_VERSION_CONFLICT` with `currentVersion`.
7. `7a` pickup checkout for the test customer with two different products (picked by catalog search: no variants, price, stock ≥ 2; prices from evaluate-cart), one line `petId` = Max and one without pet → 201; `7b` the same product on two lines with Max and Bruno → rejected with `400` (`DUPLICATE_CART_LINE` on the live backend, which checks duplicate lines before pets; `INVALID_CHECKOUT_REQUEST` also accepted). Both SKIP when fewer than 2 products are found.
8. `8a` order history `?petId=Max` contains the sale, the Max line has `pet {id, name}` and the other line `pet: null` (SKIP without a checkout); `8b` `?petId=Bruno` → `200 []`; `8c` unknown `petId` → `404 PET_NOT_FOUND`.
9. `9a` archive Bruno with a reason → ARCHIVED; `9b` by-phone lists Max and not Bruno; `9c` restore → ACTIVE; `9d` archive again.
10. `10a` delete Bruno with the version → 204; `10b` again → `404 PET_NOT_FOUND`.
11. Cleanup in a `finally` (also after a failure): cancel every sale the run created (bot `cancelSale` `ORDER_ERROR`, staff cancel as fallback), delete every pet the run created, then verify no `Max` / `Bruno` pet is left. Whatever could not be cleaned is printed as `NOT_CLEANED`. The test customer stays (the chatbot API has no customer delete), and so do the cancelled sales in its history.

Exit code: 0 every non-SKIP step passed and everything was cleaned; 1 a step failed, the run aborted or something is not cleaned; 2 missing env, a refused base URL or a refused test phone. Writes DEV data only.

The pure parts (allow-list, phone and customer guards, redaction, step runner, exit code) are pinned by `pets-e2e-lib.spec.ts`. Jest's `rootDir` is `src`, so run it with:

```sh
pnpm test --roots '<rootDir>/../scripts/e2e' --runTestsByPath scripts/e2e/pets-e2e-lib.spec.ts
```
