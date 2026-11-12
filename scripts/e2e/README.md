# E2E scripts

These scripts call a running **dev** backend. They write dev data, so never point them at production.

- `contract-smoke.ts`: live contract smoke test of `ChatbotApiHttpClient`. See `docs/e2e-contract-smoke.md`.
- `human-requests-feed-e2e.ts`: spec S7 run of the human request feed (create → staff resolve/cancel → feed item → outcome ACK), plus a read-only look at the 5c recovery route.
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
