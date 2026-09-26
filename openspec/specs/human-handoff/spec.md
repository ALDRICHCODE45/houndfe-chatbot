# human-handoff Spec

## Purpose

Provide the chatbot with a durable, internal async request/response channel between the
bot and a human agent so the owner-mandated human-in-the-loop flows (`docs/conversation-analysis.md`
§"Human-in-the-loop requirements") and the pending `needs_human_review` promotion branch have a
**real mechanism** instead of LLM-phrased prompt text. The bot writes a `human_handoff_requests`
row, sends an `HF-<id>` digest to the human agent's WhatsApp number (`OPS_CHANNEL_PHONE`),
sends the customer a one-shot "under review" notice, then waits (no scheduler, no expiry) for
the agent's reply. The reply is correlated by a ref token, persisted as a per-kind
`resolution`, and re-injected as a synthetic user turn so the customer's next LLM turn resumes
the flow.

The channel is **foundation-only**: R7 (out-of-stock) + `needs_human_review` (promo) + R14
(expiration dates) wire in now; R6 (shipping-quote approval) is **deferred** to a future
shipping slice but the kind is reserved (`shipping_approval`) so R6 plugs in without
restructuring the channel.

## Requirements

### Requirement: HumanHandoffKind enum reserves four kinds with one reserved for R6

The system MUST define `HumanHandoffKind` as the discriminated string union
`'out_of_stock' | 'needs_human_review' | 'expiration_date' | 'shipping_approval'`.

The three active kinds MUST be used today: `out_of_stock` (R7), `needs_human_review`
(promotion evaluation), and `expiration_date` (R14). The `shipping_approval` kind MUST be
reserved for the future R6 shipping slice (Skydropx / Envíos Perros quotes + $120 credit
rule + Amazon check); today's `requestHumanAssistance` tool MUST reject `shipping_approval`
inputs as `kind: 'validation'` so the future slice can flip the gate without a schema break.

#### Scenario: kind union includes all four values

- GIVEN the `HumanHandoffKind` type definition
- WHEN the type is statically inspected
- THEN the union MUST contain exactly `'out_of_stock'`, `'needs_human_review'`,
  `'expiration_date'`, and `'shipping_approval'`.

#### Scenario: shipping_approval is reserved and rejected by the tool today

- GIVEN the `requestHumanAssistance` tool is invoked with `{ kind: 'shipping_approval',
digest: { ... } }`
- WHEN the tool's `execute` runs
- THEN the tool MUST return
  `{ ok: false, error: { kind: 'validation', retryable: false } }`
- AND the `human_handoff_requests` table MUST NOT receive a new row
- AND no outbound message MUST be sent.

### Requirement: HumanHandoffRequest row model and migration create the durable channel

The system MUST create the `human_handoff_requests` table via the
`migrations/1900000000000_human_handoff_requests.js` `node-pg-migrate` migration with the
following columns (snake_case in SQL, camelCase on the read model):

| SQL column    | Type          | Constraints                   | Maps to (TS)                                                    |
| ------------- | ------------- | ----------------------------- | --------------------------------------------------------------- |
| `id`          | `text`        | PRIMARY KEY                   | `HumanHandoffRequest.id` (12 lowercase hex chars)               |
| `customer_id` | `text`        | NOT NULL                      | `customerId` (the customer's WhatsApp senderId)                 |
| `agent_id`    | `text`        | NOT NULL                      | `agentId` (the ops wa_id, set to `OPS_CHANNEL_PHONE` at create) |
| `kind`        | `text`        | NOT NULL                      | `kind: HumanHandoffKind`                                        |
| `digest`      | `jsonb`       | NOT NULL                      | `digest: HumanHandoffDigest` (per-kind payload, Zod-validated)  |
| `status`      | `text`        | NOT NULL, DEFAULT `'pending'` | `status: 'pending' \| 'resolved'`                               |
| `resolution`  | `jsonb`       | (nullable)                    | `resolution: HumanHandoffResolution \| null`                    |
| `created_at`  | `timestamptz` | NOT NULL, DEFAULT `now()`     | `createdAt: string` (ISO)                                       |
| `resolved_at` | `timestamptz` | (nullable)                    | `resolvedAt: string \| null` (ISO)                              |

The migration MUST also create the composite index `(status, created_at)` to support
`findLatestPendingForAgent`'s `WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
query without a sequential scan.

The migration's `down` MUST drop the table (cascade drops the index). The migration MUST run
clean against an empty database; running it twice MUST be idempotent (`pgm.createTable`
throws on the second run, which the migrate runner treats as a no-op only when the table
already exists with the same shape).

#### Scenario: migration creates the table and index

- GIVEN a fresh empty database
- WHEN `node-pg-migrate up` runs the `1900000000000_human_handoff_requests` migration
- THEN a table `human_handoff_requests` MUST exist with exactly the columns above
- AND an index on `(status, created_at)` MUST exist
- AND `\d human_handoff_requests` MUST list `id` as the primary key.

#### Scenario: migration down drops the table

- GIVEN the migration has been applied
- WHEN `node-pg-migrate down` runs
- THEN the `human_handoff_requests` table MUST be removed
- AND the `(status, created_at)` index MUST be removed.

### Requirement: HumanHandoffDigest and HumanHandoffResolution are discriminated unions

The system MUST define:

```text
HumanHandoffDigest =
  | { productId: string; name: string; variantId?: string; quantity?: number }   // out_of_stock
  | { items: Array<{ productId: string; name?: string; variantId?: string;
                     quantity: number; unitPriceCents?: number }>;
      originalTotalCents?: number; recomputedTotalCents?: number }              // needs_human_review
  | { productId: string; name: string; question: string }                      // expiration_date
  | { productId?: string; quoteCandidates?: unknown[] }                         // shipping_approval (reserved)

HumanHandoffResolution =
  | { decision: 'YES_RESTOCK_IN_X_DAYS'; days: number }
  | { decision: 'NO_RESTOCK' }
  | { decision: 'APPROVED_PROMO'; totalCents: number }
  | { decision: 'EXPIRATION'; text: string }
  | { decision: 'GENERIC'; text: string }
```

Both unions MUST be Zod-validated when written to / read from the jsonb columns. The
`shipping_approval` digest shape is intentionally permissive today (any object) because the
future slice owns its detailed contract.

#### Scenario: per-kind digests validate at write time

- GIVEN a `requestHumanAssistance` call with `kind: 'out_of_stock'` and
  `digest: { productId: 'not-a-uuid', name: '' }`
- WHEN the tool's `execute` runs
- THEN the tool MUST return
  `{ ok: false, error: { kind: 'validation', retryable: false } }`
- AND no row MUST be inserted into `human_handoff_requests`.

#### Scenario: resolutions round-trip through the jsonb column

- GIVEN a `human_handoff_requests` row with `resolution: { decision: 'APPROVED_PROMO',
totalCents: 89000 }` persisted by `store.resolve(...)`
- WHEN `store.findById(id)` reads the row
- THEN the returned `resolution` MUST deep-equal
  `{ decision: 'APPROVED_PROMO', totalCents: 89000 }`.

### Requirement: HumanHandoffStore port exposes the four CRUD primitives

The system MUST expose `HUMAN_HANDOFF_STORE` (Symbol DI) consumed by `application/` and
`domain/`. The port contract MUST be:

```text
interface HumanHandoffStore {
  create(input: {
    id: string;
    customerId: string;
    agentId: string;
    kind: HumanHandoffKind;
    digest: HumanHandoffDigest;
  }): Promise<HumanHandoffRequest>;

  findById(id: string): Promise<HumanHandoffRequest | null>;

  findByRef(ref: string): Promise<HumanHandoffRequest | null>;
  // ref form: 'HF-<id>'; the adapter parses the prefix and looks up by `id`.

  findLatestPendingForAgent(agentId: string): Promise<HumanHandoffRequest | null>;
  // SELECT ... WHERE agent_id = $1 AND status = 'pending'
  //        ORDER BY created_at DESC LIMIT 1

  resolve(requestId: string, resolution: HumanHandoffResolution): Promise<HumanHandoffRequest | null>;
  // UPDATE ... SET status='resolved', resolution=$2, resolved_at=now()
  //   WHERE id = $1 AND status = 'pending' RETURNING *
}
```

The runtime MUST bind exactly one adapter (Postgres raw `pg`) through the
`HUMAN_HANDOFF_STORE` token. The adapter MUST honor the port contract byte-identically:
`create` MUST return the row including a generated `createdAt` timestamp;
`resolve` MUST transition only a pending row, setting `status` to `'resolved'`,
`resolution` to the supplied value, and `resolved_at` to `now()`. For an unknown
or already-resolved `requestId`, it MUST return `null` without modifying the row;
concurrent replies MUST NOT overwrite the first recorded decision.

#### Scenario: create inserts and returns the row

- GIVEN a fresh database with the `human_handoff_requests` migration applied
- WHEN `store.create({ id: 'abc123def456', customerId: '521...', agentId: '521...',
kind: 'out_of_stock', digest: { productId: 'p-1', name: 'X' } })` is called
- THEN the returned row MUST include `id: 'abc123def456'`, `status: 'pending'`,
  `resolution: null`, and a `createdAt` ISO timestamp within the last second
- AND a subsequent `store.findById('abc123def456')` MUST return the same row.

#### Scenario: findLatestPendingForAgent returns newest pending row for that agent

- GIVEN two pending rows for agent A1 (created at T1, T2 with T2 > T1) and one pending row
  for agent A2
- WHEN `store.findLatestPendingForAgent('A1')` is called
- THEN the returned row MUST be the T2 row (not T1, never the A2 row).

#### Scenario: resolve sets status, resolution, and resolved_at

- GIVEN a pending row with `id: 'abc123def456'`
- WHEN `store.resolve('abc123def456', { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 })` runs
- THEN the returned row MUST have `status: 'resolved'`,
  `resolution: { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 }`, and a non-null `resolvedAt`.

#### Scenario: resolve on unknown or already-resolved id is a no-op

- GIVEN no row with `id: 'unknown'`
- WHEN `store.resolve('unknown', { decision: 'GENERIC', text: 'x' })` runs
- THEN the method MUST return `null`
- AND no row MUST be inserted or modified.
- GIVEN a row already resolved with `{ decision: 'NO_RESTOCK' }`
- WHEN `store.resolve` is called again with a different decision
- THEN the method MUST return `null` and preserve the first resolution and `resolvedAt`.

### Requirement: HumanHandoffService.create writes a row, sends the digest, notifies the customer, and sets the marker

The system MUST provide `HumanHandoffService.create({ senderId, kind, digest })` that performs
the following steps in order:

1. If `enabled === false` (the `HUMAN_HANDOFF_ENABLED` kill-switch), return
   `{ ok: false, error: { kind: 'disabled', retryable: false } }` WITHOUT writing any row or
   sending any message.
2. **Idempotency guard**: read `pendingHumanRequest` from the customer's
   `ConversationState.data`. If the marker is set, return
   `{ ok: true, requestId, ref, customerNotified: true }` with the existing values — no new
   row, no new digest, no new customer notice.
3. Generate `id = crypto.randomUUID().replace(/-/g,'').slice(0,12)` (12 lowercase hex chars).
   Compute `ref = 'HF-' + id`.
4. `store.create({ id, customerId: senderId, agentId: opsChannelPhone, kind, digest })`.
5. `whatsappSender.sendText({ to: opsChannelPhone, text: renderDigest(request) })` — text-only,
   `recipient_type: 'individual'`, no media.
6. **Atomic marker CAS**: `store.setPendingHumanRequest(senderId, { requestId: id, ref,
   createdAt, customerNotifiedAt }, lastMessageAt)`. If it returns `false` (a
   different/corrupt active marker), MUST NOT send the customer notice and MUST NOT return
   success; return `{ ok: false, error: { kind: 'unavailable', retryable: false } }`. The
   step-5 ops digest may already be sent, so the caller must reconcile.
7. `whatsappSender.sendText({ to: senderId, text: UNDER_REVIEW_NOTICE })` — the literal
   one-shot customer notice, sent only AFTER the step-6 CAS succeeds.
8. Return `{ ok: true, requestId: id, ref, customerNotified: true }`.

The `UNDER_REVIEW_NOTICE` literal MUST equal exactly:
`Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.`

The digest renderer MUST include the `HF-<id>` ref token in the body and per-kind reply
grammar (`YES_RESTOCK_IN_X_DAYS:<n>` / `NO_RESTOCK` for out_of_stock;
`APPROVED_PROMO:<cents>` / `GENERIC:<texto>` for needs_human_review;
`EXPIRATION:<texto>` / `GENERIC:<texto>` for expiration_date). The reserved
`shipping_approval` digest renderer is intentionally left to the future R6 slice.

#### Scenario: happy path writes a row and sends both messages

- GIVEN `HUMAN_HANDOFF_ENABLED=true`, `OPS_CHANNEL_PHONE=5219999...`, and a sender S with no
  prior `pendingHumanRequest`
- AND a stubbed `store.create` and `whatsappSender.sendText`
- WHEN `service.create({ senderId: '521...', kind: 'out_of_stock',
digest: { productId: 'p-1', name: 'X', quantity: 1 } })` runs
- THEN `store.create` MUST be called once with `id` (12 hex chars), `customerId: '521...'`,
  `agentId: '5219999...'`, `kind: 'out_of_stock'`, and the supplied digest
- AND `whatsappSender.sendText` MUST be called twice: once with `to: '5219999...'` (the
  digest, containing `HF-<id>`) and once with `to: '521...'` (the literal
  `UNDER_REVIEW_NOTICE`)
- AND the customer's `pendingHumanRequest` marker MUST equal
  `{ requestId: '<id>', ref: 'HF-<id>', createdAt: '<iso>', customerNotifiedAt: '<iso>' }`.

#### Scenario: idempotent re-call returns the existing ref

- GIVEN a customer S whose `pendingHumanRequest` is set to
  `{ requestId: 'abc123def456', ref: 'HF-abc123def456', createdAt, customerNotifiedAt }`
- WHEN `service.create({ senderId: '521...', kind: 'out_of_stock', digest: { ... } })` is
  called again (e.g. the model retries the tool)
- THEN `store.create` MUST NOT be called
- AND `whatsappSender.sendText` MUST NOT be called
- AND the returned envelope MUST be
  `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`.

#### Scenario: disabled kill-switch returns without side effects

- GIVEN `HUMAN_HANDOFF_ENABLED=false`
- WHEN `service.create({ senderId: '521...', kind: 'out_of_stock', digest: { ... } })` runs
- THEN the returned envelope MUST be
  `{ ok: false, error: { kind: 'disabled', retryable: false } }`
- AND `store.create` MUST NOT be called
- AND `whatsappSender.sendText` MUST NOT be called.

### Requirement: The customer-facing under-review notice is sent exactly once and is byte-identical

The system MUST send the customer a one-shot text message with the exact literal
`Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.`
on every successful `service.create` call. The notice MUST be sent exactly once per
escalation (idempotency guard on re-call prevents a second notice). Any subsequent
customer inbound while the marker is still pending MUST be answered with the
`pendingHumanRequest` short-circuit reply, NOT a second "under review" notice.

#### Scenario: the notice is the literal Spanish phrase byte-identical

- GIVEN a stubbed `whatsappSender.sendText` capturing every call
- WHEN `service.create(...)` succeeds for the first time
- THEN one of the captured calls MUST equal
  `{ to: '<customer>', text: 'Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.' }`
  byte-identical (whitespace, accents, final period).

#### Scenario: a second create call does not send a second notice

- GIVEN a successful `service.create(...)` for customer S with the notice already sent
- WHEN `service.create(...)` is called again for S (idempotency path)
- THEN `whatsappSender.sendText` to the customer MUST NOT be called a second time
- AND the counter of customer-bound `sendText` calls for this escalation MUST equal 1.

### Requirement: resolveReply parses the HF-<id> token and falls back to newest-pending

For non-shipping requests, the system MUST provide
`HumanHandoffService.resolveReply({ text, from })` that performs:

1. **Ref-token parse**: try to match `/\bHF-([A-Za-z0-9_-]{4,32})\b/i` in `text`. If matched,
   look up via `store.findByRef('HF-<match>')`. If a row is found, that is the target.
2. **Newest-pending fallback**: if no token is present OR the token returned no row, try
   `store.findLatestPendingForAgent(from)`. If a row is found, that is the target.
3. **No pending request**: if both lookups return `null`, return
   `{ kind: 'no_pending', reply: ASK_FOR_REF }` and the dispatcher MUST send
   `ASK_FOR_REF` back to `from` (the agent) — no LLM turn.
4. **Decision parse**: strip the matched ref token from `text`, then parse the remainder
   case- and whitespace-tolerantly for a decision keyword:
   - `YES_RESTOCK_IN_X_DAYS[: ]?<n>` → `{ decision: 'YES_RESTOCK_IN_X_DAYS', days: n }`
   - `NO_RESTOCK` → `{ decision: 'NO_RESTOCK' }`
   - `APPROVED_PROMO[: ]?<cents>` → `{ decision: 'APPROVED_PROMO', totalCents: cents }`
   - `EXPIRATION[: ]?<text>` → `{ decision: 'EXPIRATION', text }`
   - bare prose → `{ decision: 'GENERIC', text }` (the full stripped remainder).
5. Call `store.resolve(target.id, resolution)`. If it returns `null` because the
   row is missing or another reply already resolved it, return
   `{ kind: 'no_pending', reply: ASK_FOR_REF }` without clearing pending, closing
   the reservation, or emitting a synthetic turn for the losing decision.
   A non-null result MUST match the target id/customer and have resolved status;
   otherwise fail closed.
6. **Atomic marker clear**: `store.clearPendingHumanRequest(target.customerId, target.id,
   lastMessageAt)` clears only the matching `target.requestId` to explicit JSON null. A
   `false` result MUST fail closed (throw) and MUST NOT close the reservation.
7. Close the matching legacy reservation; a false result MUST fail closed.
8. Return
   `{ kind: 'resolved', customerId: target.customerId, ref: target.ref, resolution,
     syntheticUserText: formatResolutionAsUserTurn(target, resolution) }`.

The synthetic user turn MUST be deterministic per (kind, resolution), include the ref token,
and be safe to feed back through `AgentRunner.handle({ senderId: customerId,
text: syntheticUserText })`.

#### Scenario: explicit ref token resolves the matching row

- GIVEN a pending row with `ref: 'HF-abc123def456'`, `kind: 'out_of_stock'`
- AND an ops inbound `text = 'HF-abc123def456 YES_RESTOCK_IN_X_DAYS:3'`,
  `from = '<ops-wa-id>'`
- WHEN `service.resolveReply({ text, from })` runs
- THEN `store.resolve('abc123def456', { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 })` MUST
  be called
- AND the customer's `pendingHumanRequest` MUST equal `null` (cleared)
- AND the returned envelope MUST equal `{ kind: 'resolved', customerId, ref: 'HF-abc123def456', resolution: { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 }, syntheticUserText: '<includes ref + resolution phrasing>' }`.

#### Scenario: no token falls back to newest pending for the agent

- GIVEN two pending rows for agent A (created at T1, T2 with T2 > T1)
- AND an ops inbound `text = 'NO_RESTOCK'`, `from = A`
- WHEN `service.resolveReply({ text, from })` runs
- THEN the T2 row MUST be the resolution target (not T1).

#### Scenario: no token and no pending returns the ask-for-ref

- GIVEN zero pending rows for agent A
- AND an ops inbound `text = 'ok'`, `from = A`
- WHEN `service.resolveReply({ text, from })` runs
- THEN the returned envelope MUST equal `{ kind: 'no_pending', reply: <ASK_FOR_REF> }`
- AND no row MUST be modified
- AND the customer's `pendingHumanRequest` MUST be unchanged.

#### Scenario: losing a concurrent resolve does not emit a losing decision

- GIVEN a pending row selected by `resolveReply` that another reply resolves first
- WHEN `store.resolve` returns `null`
- THEN `resolveReply` MUST return `{ kind: 'no_pending', reply: ASK_FOR_REF }`
- AND it MUST NOT clear the customer's pending marker or emit a synthetic turn.

#### Scenario: bare prose is parsed as a GENERIC resolution

- GIVEN a pending row with `kind: 'expiration_date'`
- AND an ops inbound `text = 'HF-abc123def456 vence el 30 de noviembre'`
- WHEN `service.resolveReply({ text, from })` runs
- THEN `store.resolve` MUST be called with
  `{ decision: 'EXPIRATION', text: 'vence el 30 de noviembre' }`
- AND `clearPendingHumanRequest` MUST be called for the customer.

#### Scenario: decision parser is case- and whitespace-tolerant

- GIVEN a pending row with `kind: 'out_of_stock'`
- AND an ops inbound `text = 'hf-abc123def456   yes_restock_in_x_days :  5'`
- WHEN `service.resolveReply({ text, from })` runs
- THEN the parser MUST match (case-insensitive, whitespace-tolerant)
- AND the resolved decision MUST be `{ decision: 'YES_RESTOCK_IN_X_DAYS', days: 5 }`.

### Requirement: isOpsSender classifies inbounds by senderId against OPS_CHANNEL_PHONE

The system MUST expose `HumanHandoffService.isOpsSender(senderId: string): boolean` defined
as `normalizeSandboxRecipient(senderId) === normalizeSandboxRecipient(opsChannelPhone)`.
The dispatcher MUST call `isOpsSender(message.from)` on every normalized inbound BEFORE
`AgentRunner.handle(...)`. When `true`, the dispatcher's pre-routing hook MUST invoke
`HumanHandoffService.resolveReply({ text, from })` and short-circuit the agent loop
entirely (no LLM turn, no cost-guard increment).

#### Scenario: ops senderId routes to resolveReply

- GIVEN a normalized inbound with `from = '<ops-wa-id>'` (matching
  `normalizeSandboxRecipient(OPS_CHANNEL_PHONE)`)
- WHEN the dispatcher classifies the inbound
- THEN `isOpsSender` MUST return `true`
- AND `service.resolveReply` MUST be called before `AgentRunner.handle`.

#### Scenario: customer senderId is not ops

- GIVEN a customer senderId S different from `OPS_CHANNEL_PHONE` after normalization
- WHEN `isOpsSender(S)` is called
- THEN the result MUST be `false`
- AND the dispatcher MUST proceed to `AgentRunner.handle` (or the short-circuit reply if
  the customer's `pendingHumanRequest` is set).

#### Scenario: sandbox trunk-1 is normalized on both sides

- GIVEN `OPS_CHANNEL_PHONE = '5219999888777'` (no leading `1`)
- AND a sandbox-test inbound `from = '15219999888777'` (with the trunk `1`)
- WHEN `isOpsSender('15219999888777')` is called
- THEN the result MUST be `true` (both sides pass through `normalizeSandboxRecipient`).

### Requirement: requestHumanAssistance is the sole create path and the 12th AI-SDK tool

The system MUST expose an AI-SDK tool `requestHumanAssistance` registered in
`RealToolRegistry` as the 12th sale-flow tool (replacing `InMemoryToolRegistry` as the
production binding). Its contract MUST be:

```text
inputSchema:  z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('out_of_stock'),
    digest: z.object({ productId: z.string().uuid(), name: z.string().min(1),
                       variantId: z.string().uuid().optional(),
                       quantity: z.number().int().min(1).optional() }) }),
  z.object({ kind: z.literal('needs_human_review'),
    digest: z.object({ items: z.array(z.object({
                        productId: z.string().uuid(),
                        name: z.string().optional(),
                        variantId: z.string().uuid().optional(),
                        quantity: z.number().int().min(1),
                        unitPriceCents: z.number().int().min(0).optional() })).min(1),
                       originalTotalCents: z.number().int().min(0).optional(),
                       recomputedTotalCents: z.number().int().min(0).optional() }) }),
  z.object({ kind: z.literal('expiration_date'),
    digest: z.object({ productId: z.string().uuid(), name: z.string().min(1),
                       question: z.string().min(1) }) }),
])

contextSchema: z.object({ senderId: z.string().min(1) })

execute(input, options) =
  service.create({ senderId: options.context.senderId,
                   kind: input.kind,
                   digest: input.digest })
```

`shipping_approval` MUST NOT be in the discriminated union today; the future R6 slice adds
it. `requestHumanAssistance` MUST be the ONLY entry point that creates a
`human_handoff_requests` row. The trigger tools (`checkStock`, `evaluateCart`) MUST only
**signal** via their `humanAssistance` envelope and MUST NOT call the handoff service
directly.

#### Scenario: tool input schema rejects malformed digests

- GIVEN the tool is invoked with `{ kind: 'out_of_stock', digest: {} }`
- WHEN `inputSchema` parses
- THEN the parse MUST fail (Zod error: missing `productId`, missing `name`)
- AND `execute` MUST NOT be called.

#### Scenario: tool returns the documented envelope on success

- GIVEN a stubbed `service.create` returning
  `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`
- WHEN the model invokes `requestHumanAssistance` with `{ kind: 'out_of_stock',
digest: { productId: 'p-1', name: 'X' } }` and `context.senderId = '521...'`
- THEN the tool MUST call `service.create({ senderId: '521...', kind: 'out_of_stock',
digest: { productId: 'p-1', name: 'X' } })` exactly once
- AND the returned envelope MUST deep-equal
  `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`.

#### Scenario: trigger tools do not call requestHumanAssistance directly

- GIVEN the `checkStock` and `evaluateCart` tools in `RealToolRegistry`
- WHEN the registry is constructed
- THEN neither tool's `execute` MUST inject or call `HumanHandoffService`
- AND both tools MUST only return the `humanAssistance` envelope as a signal (see the
  `sale-flow-tools` delta).

### Requirement: pendingHumanRequest marker semantics — set, clear, idempotent

The `pendingHumanRequest` field on `ConversationStateData` MUST follow this lifecycle:

1. **SET**: `service.create(...)` success persists the marker on the customer's
   `ConversationState.data` via the first-contact-safe CAS
   `ConversationStore.setPendingHumanRequest(senderId, { requestId, ref, createdAt,
   customerNotifiedAt }, lastMessageAt)` — NOT `ConversationStore.update(...)`.
2. **READ (pure helper)**: `readPendingHumanRequest(state)` returns the marker or `null`
   when missing — no validation error, no default fabrication.
3. **CLEAR**: `service.resolveReply(...)` success clears the marker to `null` on the
   customer's state.
4. **IDEMPOTENT RE-CALL**: a second `service.create(...)` for the same sender while the
   marker is set MUST NOT clear the marker, MUST NOT mint a new ref, and MUST return the
   existing `{ requestId, ref, customerNotified: true }`.
5. **DISABLED**: when `HUMAN_HANDOFF_ENABLED=false`, `service.create` short-circuits and
   MUST NOT write the marker.

The marker MUST survive the existing `LLM_IDLE_TIMEOUT_MS` reset path (the
`AgentRunner` short-circuit reads the marker AFTER the idle check via a fresh `store.get`,
and the runner's final write spreads the fresh `data` per ADR-28; see the `llm-agent`
delta).

#### Scenario: create persists the marker with required fields

- GIVEN a fresh sender S (no prior `pendingHumanRequest`)
- WHEN `service.create(...)` succeeds with `id = 'abc123def456'`
- THEN `readPendingHumanRequest(state(S))` MUST equal `{ requestId: 'abc123def456', ref: 'HF-abc123def456', createdAt: <iso>, customerNotifiedAt: <iso> }`.

#### Scenario: resolveReply clears the marker

- GIVEN a sender S whose `pendingHumanRequest` is set
- WHEN `service.resolveReply(...)` succeeds
- THEN `readPendingHumanRequest(state(S))` MUST equal `null`.

#### Scenario: readPendingHumanRequest returns null when missing

- GIVEN a stored `ConversationState` whose `data` has no `pendingHumanRequest` key
- WHEN `readPendingHumanRequest(state)` is called
- THEN the result MUST equal `null` (no default fabrication).

### Requirement: Resolution is injected as a synthetic user turn through AgentRunner

When `service.resolveReply(...)` returns `{ kind: 'resolved', customerId, ...,
syntheticUserText }`, the `WebhookDispatcherService` MUST call
`agentRunner.handle({ senderId: customerId, text: syntheticUserText })`. The dispatch
MUST happen after the ops pre-routing hook returns, and MUST NOT branch on
`pendingHumanRequest` (the marker is already cleared). The synthetic turn is a regular
user turn from the runner's perspective — it is appended to `data.messages` and persisted
alongside the assistant reply, so the customer's next turn (after the runner's LLM
response) resumes the original flow with the resolution context.

#### Scenario: synthetic turn flows through AgentRunner.handle

- GIVEN the ops pre-routing hook returned
  `{ kind: 'resolved', customerId: '521...', syntheticUserText: '...' }`
- WHEN the dispatcher processes the synthetic turn
- THEN `agentRunner.handle({ senderId: '521...', text: <synthetic> })` MUST be called once
- AND the marker MUST NOT be set (otherwise the short-circuit would fire and skip the LLM).

#### Scenario: synthetic text carries the ref and kind for the model

- GIVEN a resolution for `kind: 'out_of_stock'` with `decision: 'YES_RESTOCK_IN_X_DAYS',
days: 3` and `ref: 'HF-abc123def456'`
- WHEN `service.resolveReply(...)` builds the synthetic user text
- THEN the text MUST include the literal `HF-abc123def456` substring (so the model can
  cite the ref if asked)
- AND the text MUST identify the kind (`out_of_stock`) so the model can pick the right
  phrasing
- AND the text MUST convey the resolved value (`restock in 3 days`, in Mexican Spanish).

#### Scenario: synthetic-turn injection survives an idle wipe

- GIVEN a customer whose transcript was idle-wiped by `LLM_IDLE_TIMEOUT_MS` after the
  pending marker was set
- WHEN the ops reply arrives and `resolveReply` clears the marker + produces a synthetic
  user turn
- AND the dispatcher passes the synthetic turn through `AgentRunner.handle`
- THEN the runner MUST persist the synthetic turn + assistant reply even though the prior
  transcript is empty
- AND the customer sees a coherent reply without the lost transcript context (matches the
  cart-survives-idle pattern from archived `sale-flow` R-E).

### Requirement: No scheduler, no proactive sends, no expiry

The `human-handoff` capability MUST NOT introduce a scheduler, `setTimeout`, cron job, or
queue worker. All outbound messages in the awaiting-human branch MUST occur inside the
inbound-driven dispatcher flow:

- The digest to the ops number is sent during `WebhookDispatcherService.dispatch(...)` of
  a customer inbound that called `requestHumanAssistance`.
- The customer notice is sent during the same `dispatch(...)` call.
- The agent's reply flows back through the same dispatcher (via the pre-routing hook).
- Resolution is injected as a synthetic turn inside the dispatcher-driven runner call.

The `whatsapp-webhook` "No proactive sends occur" scenario MUST remain passing after this
slice.

#### Scenario: dispatcher produces the only outbound calls for an awaiting-human flow

- GIVEN a customer escalates via `requestHumanAssistance`
- WHEN the dispatcher processes the inbound that triggered the escalation
- THEN exactly two `whatsappSender.sendText` calls MUST occur (digest to ops, notice to
  customer), both inside that one `dispatch(...)` call
- AND no other outbound call MUST occur until the next inbound.

#### Scenario: pending requests never auto-expire

- GIVEN a pending row with `created_at` older than 7 days
- WHEN the system is queried
- THEN the row MUST still be `status = 'pending'`
- AND no background job MUST have set `status = 'expired'` or nulled `resolution`.
