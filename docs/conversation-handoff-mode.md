# Conversation handoff mode (S7)

While a staff member talks to a customer, the bot stays silent for that
conversation. Contract: `docs/contracts/human-intervention-v1.md`, "Live
conversation (§4), chatbot obligations".

## State

Stored in `conversation_state.data.handoff`, one per sender:

```ts
{ mode: 'BOT' | 'HUMAN', epoch: number /* integer >= 0 */, requestId: string | null, updatedAt: string | null }
```

- No value (or JSON null) means the default `{ mode: 'BOT', epoch: 0, requestId: null }`.
- `HUMAN` requires a non-empty `requestId`.
- The key is CAS-owned, like `pendingHumanRequest`. `update()` drops any
  `handoff` in the patch and keeps the stored value, so normal turn writes
  can never overwrite or erase it. The other CAS writers merge with `||`, so
  they keep it too.
- A stored value that exists but is malformed is never guessed at:
  `getHandoff` throws `CorruptHandoffStateError` and `applyHandoff` refuses
  with `INVALID`. Someone has to repair it by hand.

Code: `src/conversation/domain/handoff-mode.ts` (types and the CAS rule),
both adapters in `src/conversation/infrastructure/`, and
`HandoffModeService` in `src/conversation/application/`.

## CAS rules (`decideHandoffTransition`)

Every order carries the backend's `handoffEpoch`.

| Incoming vs stored                  | Result                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| epoch < stored                      | `STALE_EPOCH` (no change)                                         |
| epoch > stored                      | applied (either mode)                                             |
| same epoch, HUMAN → BOT             | applied (that session ended)                                      |
| same epoch, BOT → BOT               | `DUPLICATE`                                                       |
| same epoch, HUMAN → HUMAN, same req | `DUPLICATE`                                                       |
| same epoch, BOT → HUMAN             | `STALE_EPOCH` (an ended session cannot restart at the same epoch) |
| same epoch, HUMAN with another req  | `STALE_EPOCH`                                                     |
| malformed order                     | `INVALID`                                                         |

When an order is refused, nothing is written and no row is created, so
replaying an order does nothing. The two adapters share the same rule
(`resolveHandoffApply`). In Postgres, `applyHandoff` runs one transaction:
it creates the row if missing (`INSERT … ON CONFLICT DO NOTHING`), locks it
with `SELECT … FOR UPDATE`, decides, and then either writes only
`data.handoff` or rolls back. Concurrent orders for the same sender run one
after another, so the highest epoch always wins. An existing row keeps its
`last_message_at`. A row created by a handoff order gets the time the order
was applied.

## Dispatcher gate

`WebhookDispatcherService` checks `HandoffModeService.isHumanMode(sender)`
in step 3b. That happens after the echo filter, the transcript recording
(1b), dedup and the ops-phone hook, and before the profile warm-up, the
pending-marker canned reply, customer media routing and the agent. In
HUMAN mode:

- No LLM/agent call, no reply, no receipt ingress, no vision call.
- The inbound was already recorded in the transcript, so T3 mirrors it to
  the backend outbox. This includes images and documents: a receipt sent
  during a human session is mirrored like any other message, and staff
  handle it. The bot does not reply to it.
- The message is marked seen, so Meta redeliveries are deduplicated.
- If the mode can't be read (DB error or corrupt value), the dispatcher
  throws. Meta redelivers, and the bot never speaks while it doesn't know
  the mode.

The ops phone is never gated, because it isn't a customer conversation. But
when an ops reply resolves a request (`kind: 'resolved'`), the dispatcher
checks the customer's mode before the synthetic resume turn. In HUMAN mode
it runs no `AgentRunner` turn and sends nothing to the customer. It still
marks the ops message seen and logs at info. An unreadable mode is handled
the same way, with a warning: the request is already resolved, so a
redelivery could not resume it.

The mode is checked again right before the agent reply is sent. If a
session started during the turn, the reply (text, images, interactive) is
dropped, the RESTOCK pending is not armed, and the message is marked seen.
A read error at this point throws, like the gate does.

BOT mode behaves exactly as before.

## Proactive senders

Flows that message a customer on their own call `checkHandoffSendHold`
(`src/conversation/application/handoff-send-hold.ts`) right before the
send. A HUMAN mode holds the send, and so does an unreadable mode (fail
closed). A held send is deferred through the flow's own retry; it is never
marked delivered or failed, and never ACKed to the backend.

| Flow                                               | Hold result and retry                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXPIRATION notice (`ExpirationDeliveryService`)    | `hold` before `claimPending`; the ledger row stays PENDING and a later sweep retries it. Expiry goes through the stale path, which never sends.                                                                                                      |
| RESTOCK notice (`RestockApplicationCoordinator`)   | `pending` before `preparePending`; the in-process poller re-queues it (bounded by its 24 h watch). An expired candidate goes on, because it never sends.                                                                                             |
| DELIVERY_ZONE notice (`DeliveryZoneNotifier`)      | The row stays RESOLVED, with `last_polled_at` touched so it moves behind other due rows; the next tick retries it.                                                                                                                                   |
| Receipt notices (`ReceiptMediaNotificationWorker`) | Checked after the lease check, before the 24 h window gate and the send. The worker returns with no bookkeeping: no `reschedule`, no attempt counted. The 60 s SENDING lease expires and the claim picks the row up again with `attempts` unchanged. |

Each plain class takes the reader as an optional `isHumanMode` port (the
worker as an optional last constructor argument), so hand-built test
harnesses keep compiling; without a reader the send goes ahead.

Production wiring passes `HandoffModeService` in every case:

| Composition root                                           | Builds                           |
| ---------------------------------------------------------- | -------------------------------- |
| `ExpirationPreparationRuntime` (`HumanDecisionsModule`)    | `ExpirationDeliveryService`      |
| `RestockApplicationRuntime` (`HumanDecisionsModule`)       | `RestockApplicationCoordinator`  |
| `DeliveryZoneRuntime` (`DeliveryZonesModule`)              | `DeliveryZoneNotifier`           |
| `ReceiptMediaNotificationLifecycle` (`ReceiptMediaModule`) | `ReceiptMediaNotificationWorker` |

Those modules import `ConversationModule`, which exports the service and
imports only `DatabaseModule`, so there is no import cycle. The runtimes and
the dispatcher inject `HandoffModeService` without `@Optional()`, so a broken
DI graph fails at boot instead of silently losing the hold. The dispatcher
keeps it optional in TypeScript only so hand-built test harnesses keep
compiling.

## Ops phone sends

`MetaWhatsappSender` doesn't record sends to `OPS_CHANNEL_PHONE` in the
transcript, so they are never mirrored as a customer conversation. The
comparison works like `isOpsSender`: exact by default, with both sides
rewritten only when `META_SANDBOX_RECIPIENT_NORMALIZATION=true`.

## Not built yet

- The feed consumer (backend unit 5). It will call
  `HandoffModeService.applyStarted(sender, epoch, requestId)` on
  `conversation.started` and `applyEnded(sender, epoch)` on
  `conversation.ended`, send "Le atiende…" and the farewell, and post
  `session-ack`. The service itself never sends messages.
- Staff message delivery (`seq` ordering, `messageId` dedup).
- Reconciling with `GET /chatbot-api/conversations/:ref/state` at startup
  and every 5 min while muted.
- The safety notice after the feed has been down for 10 min.
