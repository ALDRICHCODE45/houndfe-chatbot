# Conversation transcript (S1)

The chatbot keeps a durable copy of every WhatsApp message exchanged with customers in the `conversation_messages` table (migration `3800000000000_conversation_transcript.js`). The backend human-intervention mirror reads from this table (contract v1). The copy starts with the messages seen after the migration; older history cannot be backfilled.

## What is stored

One row per WhatsApp message, unique by `wa_message_id`. Writes use `ON CONFLICT DO NOTHING`, so a Meta re-delivery or a retried write never duplicates a row.

| Column               | Content                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sender_id`          | Customer `wa_id`, the same value as `conversation_state.sender_id`                                                  |
| `wa_message_id`      | Inbound wamid, or the outbound id Meta returned                                                                     |
| `direction`          | `IN` or `OUT`                                                                                                       |
| `author`             | `CUSTOMER`, `BOT`, or `STAFF` (STAFF is reserved for the live human conversation)                                   |
| `type`               | Meta message type: `text`, `interactive`, `button`, `image`, `document`, `template`…                                |
| `text`               | Text, caption, interactive body, or tapped-option text                                                              |
| `media`              | Provider reference only (`providerMediaId`, `mimeType`, `filename`, or `link` for outbound images); never the bytes |
| `details`            | Extra provider fields: tapped reply id, interactive controls, template name/language/parameters                     |
| `provider_timestamp` | Meta timestamp (inbound only)                                                                                       |
| `observed_at`        | When the bot saw or sent the message                                                                                |
| `purge_after`        | `observed_at` + 12 months                                                                                           |

All times are ISO-8601 UTC.

## Where messages are recorded

- **Inbound:** `WebhookDispatcherService` records each normalized customer message right after the echo filter and before dedup and the reply. Ops-phone messages and echoes of the bot's own sends are not recorded.
- **Outbound:** `MetaWhatsappSender` records every message Meta accepted: text, image, interactive (both messages of a long split send) and template. Rows use the raw `wa_id`, before any sandbox recipient rewrite. This covers every caller of `WHATSAPP_SENDER`: replies, receipt notices, restock and delivery-zone notices.

Recording is best-effort. A database error or an invalid message only logs a warning; it never blocks or fails the customer reply.

The LLM still reads its history from `conversation_state`. The transcript is write-only for now.

## Backend mirror

Every row that is actually inserted is also queued in the backend outbox (see `docs/backend-outbox.md`) as one `MESSAGE_MIRROR`:

- `conversationRef` is `wa:<sender_id>` and the idempotency key is `mirror:<wa_message_id>`.
- The payload is the contract `messages:batch` item built from the stored row: `waMessageId`, `direction`, `author`, `type`, `text?`, `media?`, `providerTimestamp?`, `observedAt`. Null fields are left out. `media` is the provider reference as stored; the future HTTP adapter uploads it and sends `mediaId` instead.
- The transcript insert and the enqueue run in one Postgres transaction (`append(message, onInserted)` hands its client to the outbox). If the enqueue fails, both roll back and a warning is logged, so a mirror is never lost or duplicated. An inbound is recorded again on Meta's re-delivery.
- A duplicate wamid inserts nothing and queues nothing.
- The same exclusions apply as for the transcript: echoes and ops-phone inbounds are never recorded, so they are never mirrored.

## Retention and purge

The owner decided a conversation is deleted after 12 months. `TranscriptPurgeWorker` (in `TranscriptPurgeModule`, imported only by `AppModule`) works like this:

- It first runs one minute after boot, then every hour.
- Each run deletes due rows (`purge_after <= now`) in batches of 1000, using `FOR UPDATE SKIP LOCKED`, with at most 20 batches per run.
- On shutdown it stops scheduling and waits only for the batch in progress.

Media bytes do not live in this table. They are deleted with the media they belong to.
