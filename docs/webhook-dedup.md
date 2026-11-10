# Webhook dedup (S6)

Meta redelivers a webhook when it does not get a timely 200, for up to 7 days.
`processed_webhook_messages` makes sure each inbound `message.id` is handled
once, without losing a message when the process crashes.

## Claim before processing

| Step                                                                 | What the dispatcher does                                                | Row                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| Echo of our own send                                                 | skipped, no row                                                         | —                                                              |
| Inbound arrives                                                      | `claim(id)`: `INSERT … ON CONFLICT` takes the id                        | `PROCESSING`, `claim_token`, `lease_expires_at = now + 10 min` |
| Second delivery while the claim is live                              | `claim` throws `WebhookClaimInFlightError`: not acknowledged (500)      | unchanged; Meta retries until `DONE` or the lease expires      |
| Delivery of a `DONE` message                                         | `claim` returns `null`: duplicate, skipped (200)                        | unchanged                                                      |
| Handled (reply sent, HUMAN-mode mirror, receipt admitted, ops reply) | `markSeen(id)`                                                          | `DONE`                                                         |
| Error before anything was sent                                       | `release(id, token)` deletes the claim, then the error propagates (500) | gone, the redelivery processes it                              |
| Process crashes mid-turn                                             | nothing                                                                 | claim expires; the next redelivery takes it over               |

- Only one of several concurrent claims wins (row lock + re-checked `WHERE`).
- `release` only deletes the caller's own `PROCESSING` claim, never a `DONE`
  row or a claim another delivery took over.
- A failed claim write, or a live claim, propagates before any processing
  with nothing to release or mark (Meta redelivers). Only `DONE` gets a 200.
  A failed `markSeen` or `release` only warns.
- Statuses never create rows. `DONE` stays a duplicate until it is purged.
- The receipt admission still writes its marker in its own transaction
  (`INSERT (message_id) … DO NOTHING`, default `DONE`). Under a claim that
  insert is a no-op, so the dispatcher marks the message `DONE` after every
  admission outcome.

## Lease: 10 minutes

The lease must be longer than the slowest turn (several LLM steps plus backend
calls of up to 45 s each). Otherwise a redelivery could take over a turn that
is still running and reply twice. A crash only delays the retry by up to
10 minutes, and Meta keeps retrying for days.

## Accepted duplicate

The guarantee is at least once. If the process crashes after Meta accepted the
reply but before `markSeen`, the redelivery after the lease answers again. The
same happens if a step after the send throws (only `onSent` can). One duplicate
reply is better than a lost customer message.

## Purge

`WebhookDedupPurgeWorker` (registered in `WhatsappModule`, which only
`AppModule` imports) runs one minute after boot and then every hour. Each run
deletes up to 20 batches of 1000 rows whose `seen_at` (the last state change)
is older than 8 days: `DONE` rows, and abandoned claims whose lease ended
before the cutoff. It uses the `seen_at` index and `FOR UPDATE SKIP LOCKED`.
On shutdown it finishes the current batch before the pool closes.

## Migration 4100

It adds `status` (`PROCESSING | DONE`, default `DONE`, so existing rows become
`DONE`), `claim_token`, `claimed_at`, `lease_expires_at` with CHECKs, and the
`seen_at` index. `down` refuses while a live claim exists. It deletes expired
claims (they were never answered, and the old schema would treat them as
processed) and keeps `DONE` rows.
