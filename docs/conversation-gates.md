# Durable conversation gates (S4)

A *gate* is short-lived conversation state that decides what a customer's next
message means: "SÍ" right after an order summary, a saved-address reference,
the pending RESTOCK question. They used to live in process memory, so a
restart or redeploy dropped them mid-conversation. Now they live in the
`conversation_gates` table with the **same expiry**, the **same single-use
rules** and the **same replies**.

## Inventory

| Gate (`gate_kind`) | Owner | What it stores | Key | TTL | How it is read / spent | Before S4 |
| --- | --- | --- | --- | --- | --- | --- |
| `order_confirmation` | `MinimalOrderConfirmation` via `DurableOrderConfirmation` | Pending order summary: reference, exact order snapshot, origin message and phone-number id, `armed` | sender | 5 min | One-shot. A trusted, armed SÍ yields one candidate and spends the gate. Any other reply also drops it. A new summary overwrites it. Origin replay re-presents it. | `Map` in the domain class |
| `checkout_confirmation` | `MinimalCheckoutConfirmation` via `DurableCheckoutConfirmation` | Pending delivery summary: reference, canonical draft binding, revision, origin ids, `armed` | sender | 5 min | A SÍ yields a candidate. `finalize` spends the pending (CAS result required). A refusal drops it. A new summary overwrites it. | `Map` in the domain class |
| `checkout_confirmed` | same adapter | Local delivery confirmation: reference, draft binding, revision | sender | **24 h** (see below) | Read on every order attempt. Valid only while the durable draft still equals the confirmed binding. A draft change revokes it. | `Map`, no expiry until restart |
| `checkout_address` | `MinimalCheckoutService` via `CheckoutAddressGate` | Saved-address reference registry (addresses, pages, next-page cursors, each with its own expiry), the selected reference, the customer from the last unique lookup | sender | 5 min per binding; the row lives as long as its longest binding | Re-read on every resolve or revalidate. Expired bindings resolve to `null`. The oldest page retires at 50 addresses. | Three `Map`s in the service plus a `Map` per registry |
| `restock_pending` | `MinimalRestockRequestService` | Pending RESTOCK question: origin ids, catalog identity snapshot, canonical digest, presentation, classified message ids (≤16), `armed` | sender | 5 min | One-shot. A trusted, armed accept (exact or classified) spends it and runs **one** RESTOCK route. A decline drops it. Origin replay re-asks it. A new question overwrites it. | `Map` in the service |
| `payment_offer` | `DurablePaymentOffer` (migration 5400) | The sale the bot's «¿Cómo desea pagar?» question is about | sender | 5 min | Read by the next message; any other recorded turn clears it. | `Map` in the agent session |
| `backorder_offer` | `DurableBackorderOffer` (migration 5500) | The offer sent after a RESTOCK estimate: decision id (`sourceDecisionId`), product, variant, product name, `estimatedAt`, stated count (or `null`), `stage` (`offer`, `ask_quantity`, `ask_name`) and the chosen count | sender | **24 h** | Armed **outside a customer turn** by the RESTOCK application coordinator, only after Meta accepted the estimate message. A tap, or a bare yes / no, answers it; any other message spends it (`claim`). T6 adds the stage `retry` and an optional `customer` (the first request's customer mode) to the payload, so a retry replays the same body under the same idempotency key; no migration (only `gate_kind` is constrained). See [`minimal-backorder.md`](minimal-backorder.md). | new |
| `backorder_quantity` | `DurableBackorderQuantity` (migration 5500) | The unit count (2–999) the customer stated when the RESTOCK request was made, per product / variant topic (≤ 8) | sender | **48 h** | Written when the RESTOCK request is recorded; read and removed when the offer is armed (the request itself stores no quantity). | new |
| *expiration session* | `MinimalExpirationRequestService` | — | — | — | **Not a cross-turn gate.** Its `CatalogSession` (5-minute TTL) is created and used inside one `prepare` call. Nothing survives the call, so nothing has to survive a restart. The durable parts (reservation, post ledger) were already in Postgres. | local variable |

Process-local assumptions that are gone:

- Arming happens through `onSent`, which the dispatcher calls after Meta accepts the reply. Arming now also schedules a durable write, so an armed offer is armed after a restart too.
- Callbacks still check object identity. A turn only replaces the in-memory object when the durable row differs from what this process last wrote, so an `onSent` from the previous turn can still arm its own offer.

## Store

`conversation_gates` (migration `4200000000000_conversation_gates.js`):

| Column | Notes |
| --- | --- |
| `sender_id text` | `char_length` 1–128, collation `C` |
| `gate_kind text` | `CHECK` in the kinds above (widened by migrations 5400 and 5500) |
| `payload jsonb` | `CHECK` object, `octet_length(payload::text) <= 65536` |
| `expires_at timestamptz` | indexed for the purge |
| `created_at`, `updated_at` | `now()` defaults; `updated_at` bumps on upsert |

The primary key is `(sender_id, gate_kind)`. `down` locks the table and refuses while any unexpired gate exists.

Port: `ConversationGateStore` (`src/conversation-gates/domain`), with Postgres and in-memory adapters that share one contract spec:

- `put` upserts. Kind, sender, payload shape and the 64 KiB cap are validated before any write.
- `get` / `list` return live gates only: **expired = absent**, enforced on read with the application clock.
- `consume` is `DELETE … WHERE … expires_at > now AND payload @> match RETURNING`. Under concurrency exactly one caller gets the row.
- `delete` removes one gate. `purgeExpired(batch)` is described below.

Payloads are explicit JSON: dates as ISO-8601 strings, sets as arrays, a `CatalogSession` as its validated snapshot. Each adapter re-validates its payload on read (zod, plus the draft and catalog normalizers). A malformed row is logged with fixed fields, treated as absent, and deleted.

## How the in-memory gates stay durable

`ConversationGates` (`src/conversation-gates/application`) keeps the existing synchronous domain classes and syncs them with the store per sender:

1. **Turn start**: `MinimalCatalogAgentService.tryHandle` calls `begin(sender)`. It first retries any unsaved change, then loads the sender's live rows in one query. A row equal to what this process last wrote is skipped; anything else is restored (restart) or cleared.
2. **Every mutation**: the adapters call `touch(sender)`. This captures the state at that moment and queues the put or delete on a per-sender FIFO, so writes land in mutation order.
3. **Spending**: an accepted SÍ calls `claim(sender, kind, {reference | originMessageId})`, the atomic `consume` above. A gate another process already spent returns the existing cautious reply (`MINIMAL_ORDER_AMBIGUOUS_REPLY`, not confirmed, `MINIMAL_RESTOCK_AMBIGUOUS_REPLY`). No second order, confirmation or RESTOCK route runs.
4. **Turn end**: `settle(sender)` waits for the queue, so the turn's gate changes are durable before the reply goes out. Arming (`onSent`) runs after the send and is queued the same way.

If a write fails, the sender stays dirty and the next `begin` retries it before loading. A declined or spent gate is therefore never revived from a stale row; while the database is down the gate keeps working in memory.

Services built outside Nest (unit specs) fall back to `processLocalConversationGates()`, which is the same code over a private in-memory store.

## TTL

All pending gates keep their original 5-minute expiry (`MINIMAL_ORDER_CONFIRMATION_TTL_MS`, `MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS`, `MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS`, `MINIMAL_RESTOCK_PENDING_TTL_MS`). The expiry is absolute from when the offer was made: a restart does not extend it.

`checkout_confirmed` had no expiry (it lasted until the process stopped). Durably it is bounded to 24 hours (`MINIMAL_CHECKOUT_CONFIRMED_TTL_MS`), matching WhatsApp's customer-service window. It never authorizes anything beyond the exact draft the customer confirmed.

## Purge

`ConversationGatePurgeWorker` (registered through `ConversationGatePurgeModule`, imported only by `AppModule`):

- Deletes expired rows in batches of 500, at most 20 batches per tick, using `FOR UPDATE SKIP LOCKED`.
- First tick 60 s after bootstrap, then every 5 minutes.
- Timers are unref'd. Shutdown stops new ticks and waits for the running batch, before `PostgresPoolLifecycle` closes the pool.

The purge only reclaims space: expiry is already enforced on read.

## Gates armed outside a customer turn

`backorder_offer` is the first gate that is **not** created by a customer turn: the RESTOCK application coordinator sends the estimate from a poller. The coordinator (human decisions module) only sees `BackorderOfferCapability`, a port held by `BackorderOfferRegistry`; the LLM agent module registers `MinimalBackorderOfferService` there at boot (same late-bound pattern as `DeliveryZoneResumeRegistry`). `arm` runs `begin(sender)` (load what the sender already has), sets the in-memory offer, `touch`es and `settle`s, so the row is durable before the coordinator goes on. Its expiry (24 h) is absolute from arming.

### The customer cancel question is not a gate

The S8 cancel confirmation («¿Cancelo su pedido …?») and its pick are **not**
durable gates: they are process-local state of `MinimalBackorderManageService`
with a 5-minute expiry, so no gate kind (and no migration) was added. The
buttons carry the backorder id and are re-verified against the customer's active
list, so a tap survives a restart; only a typed yes/pick is lost. If this ever
needs to survive a restart it needs a new `gate_kind` and a migration widening
the CHECK (the pattern of 5400 / 5500).
