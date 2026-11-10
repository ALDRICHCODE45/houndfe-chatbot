# Backend outbox

S2 of the human-intervention prerequisites (contract v1 §10.1). Every fact the backend must learn from the bot is first committed to `backend_outbox` in the chatbot database, then delivered by a drain worker. That covers the transcript mirror, outbound wamids, Meta statuses, request creations and cancellations, session ACKs and feed delivery outcomes. Code lives in `src/backend-outbox/`. The migration is `3900000000000_backend_outbox.js`.

## Enqueue

```ts
await backendOutbox.enqueue({
  conversationRef: conversationRefFor(waId), // "wa:<raw wa_id>"
  kind: 'MESSAGE_MIRROR',
  idempotencyKey: `mirror:${waMessageId}`,
  payload: { ... },                          // JSON object, sent as-is
});
```

- Import `BackendOutboxEnqueueModule` and inject `BackendOutboxService`.
- The idempotency key is unique across the table. Enqueueing the same key again is a no-op and returns the existing row, even if that row is DONE or DEAD.
- Pass `{ client }` to enqueue inside your own open transaction. The row then commits or rolls back with your write. Without it, the call uses its own transaction.
- Invalid input throws: a bad `conversationRef`, unknown kind, empty or oversized key, or a payload that is not an object. Nothing is dropped silently.

## Kinds enqueued today

| Kind             | Producer                                                     | conversationRef     | Idempotency key                       | Payload                                                                                 |
| ---------------- | ------------------------------------------------------------ | ------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `MESSAGE_MIRROR` | `TranscriptRecorder`, same transaction as the transcript row | `wa:<sender_id>`    | `mirror:<wa_message_id>`              | `{waMessageId, direction, author, type, text?, media?, providerTimestamp?, observedAt}` |
| `MESSAGE_STATUS` | `WebhookDispatcherService`, from Meta `value.statuses[]`     | `wa:<recipient_id>` | `status:<providerMessageId>:<status>` | `{providerMessageId, status, occurredAt, errorCode?}` (statuses:batch item)             |

Statuses (`normalizeMetaStatuses` in `src/whatsapp/application/meta-status-normalizer.ts`):

- Only `sent`, `delivered`, `read` and `failed` are kept. Other values and malformed items are skipped with a debug log.
- `occurredAt` is Meta's seconds timestamp as ISO-8601 UTC with ms. `errorCode` is the first `errors[].code` as a string.
- Statuses never reach the LLM and never trigger a reply. A statuses-only webhook answers 200 after one enqueue per status.
- Statuses for the ops phone are skipped. An enqueue failure only logs a warning; the messages in the same webhook are still processed.

Feature modules import `BackendOutboxEnqueueModule` (store and `BackendOutboxService` only). `BackendOutboxModule`, imported only by `AppModule`, adds the delivery port and the single drain worker.

## Ordering

- Each conversation has a `seq` that starts at 1. It comes from `backend_outbox_sequences`, incremented with `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the enqueue transaction.
- The counter row stays locked until the enqueue commits, so commit order equals seq order. Concurrent enqueues to one conversation are serialized, including for the length of a caller transaction.
- Only the conversation head is claimable: the lowest seq that is neither DONE nor DEAD.
- Claims use `FOR UPDATE SKIP LOCKED` plus a 60 s lease (the lease owner is a random id per process). Several instances can drain safely, and an expired lease is reclaimed.
- A failing head blocks only its own conversation.
- The worker claims up to 20 heads per tick and delivers them concurrently. They belong to different conversations, so order holds.

## Retry and DEAD rows

The delivery port (`BackendOutboxDeliveryPort.deliver`) returns one of three results:

| Result               | Row becomes                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELIVERED`          | `DONE` (`done_at` set). Purged after 7 days, in batches.                                                                                                                                              |
| `RETRY` (or a throw) | `PENDING` again, `attempts + 1`, `last_error` set. Next try after an exponential backoff of 1 s doubling to 5 min, with jitter, or after the backend's `Retry-After` (capped at 1 h). No retry limit. |
| `PERMANENT`          | `DEAD`, `last_error` set, an error is logged, and the next seq of that conversation proceeds.                                                                                                         |

`classifyBackendResponse(status, { code, retryAfter })` holds the HTTP rules for the future adapter:

- 2xx and "already recorded" 409s (`OUTCOME_ALREADY_RECORDED`, `ALREADY_RESOLVED`) count as delivered.
- 408, 429 and 5xx are retried.
- Every other 4xx is permanent, including `409 IDEMPOTENCY_CONFLICT` and `409 STALE_EPOCH`.

Network errors and timeouts should be thrown or returned as `RETRY`. The drain worker also bounds every `deliver` call with `deliveryTimeoutMs` (default: 3/4 of the lease, 45 s for the 60 s lease; it must stay below the lease). A call that runs out of time is rescheduled as `RETRY` (`backend outbox delivery timed out after N ms`) before its lease can be reclaimed, and its late result is ignored.

DEAD rows are never purged and never retried automatically. To inspect them:

```sql
SELECT id, conversation_ref, seq, kind, attempts, last_error
FROM backend_outbox WHERE status = 'DEAD' ORDER BY id;
```

To replay a DEAD row after a fix, set `status = 'PENDING', next_attempt_at = now()`. Later seqs of that conversation may already be delivered, so the replayed row arrives out of order; the backend must accept that for the kind.

## Wiring a kind

Backend unit 5 does not exist yet. Until it does, `BACKEND_OUTBOX_DELIVERY` is `NotWiredBackendOutboxDelivery`:

- Every row is retried, so rows accumulate safely and nothing is lost.
- It logs `backend outbox delivery not wired for kind X; will retry` at most once per kind per minute.
- It never makes an HTTP call.

When an endpoint exists:

1. Write an HTTP adapter implementing `BackendOutboxDeliveryPort`. Dispatch on `entry.kind` and send `entry.idempotencyKey` as `X-Idempotency-Key` where the contract asks for it. Map responses with `classifyBackendResponse`.
2. Return `RETRY` for kinds the adapter does not handle yet, so those rows stay queued.
3. Replace the `BACKEND_OUTBOX_DELIVERY` provider in `backend-outbox.module.ts`.

Delivery must be idempotent: a crash after delivery, or an expired lease, replays the same row.
