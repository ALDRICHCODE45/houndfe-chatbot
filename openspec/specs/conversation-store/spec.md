# conversation-store Spec

## Purpose

Provide a port (`ConversationStore`) for tracking per-sender conversation state in
HoundFe's chatbot. State is keyed by WhatsApp sender id and includes a `lastMessageAt`
timestamp plus an open `data: Record<string, unknown>` payload that downstream slices
(LLM agent, cart, etc.) can fill in. The port is bound through the `CONVERSATION_STORE`
injection token; the runtime default is a durable Postgres adapter (raw `pg`,
`conversation_state` table, PK on `sender_id`, `data jsonb`), and an in-memory adapter
remains valid as a test-time binding. Both adapters MUST satisfy the port contract
byte-identically; callers (notably the `AgentRunner`) require no code changes when the
binding swaps.

## Requirements

### Requirement: Manage conversation state by sender id

The system MUST provide a conversation store port that can create, read, and update conversation state by WhatsApp sender id.
The runtime MUST bind exactly one adapter through the `CONVERSATION_STORE` token that honors the port contract: `update` MUST be UPSERT (when no record exists, the adapter creates one with the supplied patch and returns it; when a record exists, the patch is shallow-merged over it with the `data` field REPLACED as a whole object except the CAS-owned `receiptAmountPointer` and `pendingHumanRequest` keys — no JSONB deep merge at the storage layer), `get` MUST return `null` when no record exists, and the sender id MUST be preserved on every returned record.
The bound adapter MAY be in-memory (valid for unit tests) or durable (Postgres — the runtime default). Both adapters MUST satisfy the contract byte-identically.
(Previously: `The slice MUST use an in-memory implementation only.` — the in-memory-only restriction has been relaxed; durable Postgres is now the runtime default while the in-memory adapter remains a valid test-time binding.)

#### Scenario: New sender state is created and read back

- GIVEN a WhatsApp sender id with no prior state
- WHEN the application creates conversation state for that sender
- THEN a subsequent read returns the stored state

#### Scenario: Existing sender state is updated

- GIVEN an existing sender conversation record
- WHEN the application updates the record
- THEN the latest state is returned on read
- AND the sender id remains the same

#### Scenario: Unknown sender has no state

- GIVEN a sender id that has never been stored
- WHEN the application reads the conversation store
- THEN the result is empty or not found

#### Scenario: Updating an unknown sender creates the record

- GIVEN a sender id with no prior state
- WHEN the application calls `update(senderId, { lastMessageAt, data })`
- THEN the adapter MUST create a new record with the supplied patch
- AND return it (no exception thrown).

### Requirement: Persist typed agent message history

`ConversationState.data` MUST be able to carry an `AgentMessage[]` field typed as the union `{ role: 'user', content: string } | { role: 'assistant', content: string } | { role: 'tool', toolCallId: string, content: unknown }`.
When the field is absent on read or write, the adapter MUST treat it as `[]` (backward-compatible default).

The slice MAY add additional optional typed convenience fields to `ConversationStateData`
without a migration, so long as (a) the adapter continues to REPLACE `data` as a whole on
`update` for ordinary keys, except the CAS-owned `pendingHumanRequest` carve-out, (b) the
new fields live under named keys (no top-level state shape change), and (c) every reader
that needs the field uses a pure helper that returns `null` when the key is missing.

(Previously: only `messages`, `cart`, and `placedSaleId` were listed as canonical
convenience fields; today `pendingHumanRequest` joins them as a fourth named key.)

#### Scenario: Missing messages field defaults to empty array

- GIVEN a stored `ConversationState` whose `data` has no `messages` key
- WHEN the runner reads the state
- THEN `data.messages` MUST resolve to `[]`.

#### Scenario: Messages round-trip through update

- GIVEN an existing sender record
- WHEN `update` is called with `data.messages = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'Hola' }]`
- THEN a subsequent `get` returns the same `messages` array unchanged.

#### Scenario: pendingHumanRequest is preserved through a data-replacing update

- GIVEN an existing sender S with `data = { messages: [m1, m2], pendingHumanRequest: { requestId: 'abc123def456', ref: 'HF-abc123def456', createdAt: '2026-09-01T00:00:00.000Z', customerNotifiedAt: '2026-09-01T00:00:01.000Z' } }`
- WHEN the runner performs
  `update(S, { lastMessageAt: T2, data: { messages: [m1, m2, m3] } })` (no marker in the
  patch, or a stale/different marker value)
- THEN a subsequent `get(S).data.pendingHumanRequest` MUST deep-equal the prior value
  (the stale patch value MUST be stripped and the LIVE marker re-applied)
- AND a subsequent `readPendingHumanRequest(state(S))` MUST return that value (not `null`).

### Requirement: Conversation state survives process restart

The durable adapter MUST persist every committed `create` and `update` so that a fresh adapter instance connected to the same database reads back the same state previously written by another instance.

#### Scenario: State survives adapter instance restart

- GIVEN a sender's state has been written by adapter instance A against database D
- WHEN a fresh adapter instance A' is constructed against the same database D
- AND A' calls `get(senderId)`
- THEN the returned state MUST deep-equal the state written by A.

### Requirement: Adapter honors UPSERT semantics on update

Every adapter bound to `CONVERSATION_STORE` MUST satisfy the port's documented UPSERT semantics byte-identically. `get` MUST return `null` when no record exists. `update` MUST create a record from the patch when none exists and MUST shallow-merge the patch over the existing record otherwise; the patch's `data` field REPLACES the prior `data` object as a whole except for the CAS-owned `receiptAmountPointer` and `pendingHumanRequest` keys (no JSONB deep merge at the storage layer).

#### Scenario: update() with no prior record creates and returns

- GIVEN no existing record for sender S
- WHEN the adapter's `update(S, { lastMessageAt, data })` is called
- THEN a new record MUST be created from the patch
- AND the returned state MUST deep-equal the patch plus `senderId`.

#### Scenario: update() with prior record shallow-merges and preserves senderId

- GIVEN an existing record for sender S with `data.messages = [m1]`
- WHEN `update(S, { lastMessageAt: T2, data: { messages: [m1, m2], extra: 'x' } })` is called
- THEN the returned state's `data.messages` MUST equal `[m1, m2]`
- AND `data.extra` MUST equal `'x'`
- AND `senderId` MUST remain S.

#### Scenario: get() of missing sender returns null

- GIVEN no record for sender S
- WHEN `get(S)` is called
- THEN the adapter MUST return `null`.

### Requirement: data payload round-trips unchanged through the durable adapter

The durable adapter MUST persist `ConversationState.data` (including its `messages: AgentMessage[]` field with user/assistant/tool variants and arbitrary additional string-keyed entries) such that a read returns a value deep-equal to what was written.

#### Scenario: Mixed-variant messages and extra keys round-trip intact

- GIVEN a state whose `data` contains a `messages` array with user, assistant, and tool variants AND additional keys (e.g. `cart`, `lastIntent`)
- WHEN the durable adapter persists it
- AND a fresh adapter instance reads it back
- THEN `data.messages` MUST deep-equal the original array with every `role` discriminator, `content`, and `toolCallId` preserved
- AND the additional keys MUST be preserved with their original types intact.

### Requirement: lastMessageAt round-trips at millisecond precision

The durable adapter MUST persist `ConversationState.lastMessageAt` (an ISO 8601 string in the domain) and return the same value on read with no loss of millisecond precision.

#### Scenario: Known ISO timestamp round-trips at ms precision

- GIVEN `lastMessageAt = "2026-06-30T15:24:13.456Z"`
- WHEN the durable adapter persists the state
- AND a fresh adapter instance reads it back
- THEN `get(senderId).lastMessageAt` MUST equal `"2026-06-30T15:24:13.456Z"`.

### Requirement: CONVERSATION_STORE token resolves to the durable adapter at runtime

At runtime, the `CONVERSATION_STORE` injection token MUST resolve to the durable (Postgres-backed) adapter. The `AgentRunner` consumer MUST observe the same `ConversationStore` contract and MUST require no code changes for this binding swap.

#### Scenario: Boot resolves the durable adapter

- GIVEN a valid environment with `DATABASE_URL`
- WHEN the Nest application is built and the `CONVERSATION_STORE` provider is resolved
- THEN the resolved instance MUST be the durable adapter.

#### Scenario: AgentRunner consumes the bound adapter without code changes

- GIVEN the `CONVERSATION_STORE` binding is the durable adapter
- WHEN the `AgentRunner` exercises an existing sender
- THEN it MUST read/write state through the bound adapter
- AND no modifications to `AgentRunner` source are required by this slice.

### Requirement: Service refuses to start without a valid DATABASE_URL

The chatbot service MUST validate `DATABASE_URL` (and other DB env) at boot via the existing Joi validation pipeline. A missing or unparseable `DATABASE_URL` MUST cause startup to abort with a clear validation error before any HTTP request is accepted.

#### Scenario: Boot fails when DATABASE_URL is missing

- GIVEN no `DATABASE_URL` in the environment
- WHEN the application starts
- THEN startup MUST abort with a Joi validation error
- AND the service MUST NOT bind to any port.

#### Scenario: Boot fails when DATABASE_URL is malformed

- GIVEN `DATABASE_URL` set to a non-parseable string
- WHEN the application starts
- THEN startup MUST abort with a clear validation error.

### Requirement: Database pool closes on shutdown

The chatbot MUST enable NestJS shutdown hooks. On application shutdown, the singleton Postgres connection pool MUST be closed (`pool.end()`) via `OnModuleDestroy` so that no connections are leaked.

#### Scenario: Pool closes on SIGTERM

- GIVEN a running chatbot instance with an open pool
- WHEN the process receives SIGTERM
- THEN shutdown hooks MUST fire `OnModuleDestroy`
- AND the pool MUST be ended (`pool.end()` resolves)
- AND no further queries are issued.

#### Scenario: OnModuleDestroy ends the singleton pool before process exit

- GIVEN the Nest application has reached the shutdown phase
- WHEN the lifecycle hook runs
- THEN it MUST call `pool.end()` on the singleton pool before returning.

### Requirement: PendingHumanRequest type and pendingHumanRequest field on ConversationStateData

`ConversationStateData` MUST gain the optional typed field
`pendingHumanRequest?: PendingHumanRequest | null` (sibling of `cart` and `placedSaleId`).
The marker MUST be typed as:

```text
PendingHumanRequest = {
  requestId: string;          // == HumanHandoffRequest.id (12 hex chars)
  ref: string;                // 'HF-' + requestId
  createdAt: string;          // ISO 8601, set by the handoff service on create
  customerNotifiedAt: string; // ISO 8601, set by the handoff service when the one-shot
                              // under-review notice is sent
}
```

A missing key MUST read as `null`. The adapter MUST treat `pendingHumanRequest` as a
CAS-owned carve-out of the ordinary `data`-REPLACE `update` semantics, exactly like the
sibling `receiptAmountPointer` carve-out: every patch value for that key is stripped and the
LIVE stored value (including explicit JSON null) is re-applied under the row lock. Callers
no longer need to read and re-include the marker through a data-replacing write.

#### Scenario: typed field is present and optional

- GIVEN the `ConversationStateData` type
- WHEN the type is statically inspected
- THEN the type MUST include the optional field
  `pendingHumanRequest?: PendingHumanRequest | null`.

#### Scenario: missing key reads as null via the helper

- GIVEN a stored `ConversationState` whose `data` has no `pendingHumanRequest` key
- WHEN `readPendingHumanRequest(state)` is called
- THEN the result MUST equal `null` (no default fabrication, no validation error).

#### Scenario: CAS clear stores explicit null

- GIVEN a sender S whose `pendingHumanRequest` is currently set
- WHEN `clearPendingHumanRequest(S, requestId, lastMessageAt)` succeeds for that marker
- THEN the stored key MUST be explicit JSON null
- AND a subsequent `readPendingHumanRequest(state(S))` MUST equal `null`.
- A plain `update` patch carrying `pendingHumanRequest: null` MUST NOT clear a live marker.

### Requirement: readPendingHumanRequest is a pure helper

The system MUST expose a pure helper `readPendingHumanRequest(state): PendingHumanRequest | null`
in `src/conversation/domain/conversation-store.ts`. The helper MUST:

- Accept a `ConversationState` (or a `ConversationStateData`) value.
- Return the typed `PendingHumanRequest` object when the key is present.
- Return `null` when the key is missing or when the value is explicitly `null`.
- Return `null` when the stored value does NOT structurally match `PendingHumanRequest`
  (defensive default — never throw, never fabricate the four required fields).

The helper MUST NOT mutate the input and MUST NOT touch the durable store. The dispatcher
short-circuit and the `AgentRunner` short-circuit both call this helper on a freshly
loaded state (after the existing idle check) so the marker is always current.

#### Scenario: readPendingHumanRequest returns the typed object

- GIVEN a state with `data.pendingHumanRequest = { requestId: 'abc123def456', ref: 'HF-abc123def456', createdAt: '2026-09-01T00:00:00.000Z', customerNotifiedAt: '2026-09-01T00:00:01.000Z' }`
- WHEN `readPendingHumanRequest(state)` is called
- THEN the result MUST deep-equal that object.

#### Scenario: readPendingHumanRequest returns null for an unrelated shape

- GIVEN a state with `data.pendingHumanRequest = { requestId: 'x' }` (missing `ref`,
  `createdAt`, `customerNotifiedAt`)
- WHEN `readPendingHumanRequest(state)` is called
- THEN the result MUST equal `null` (defensive default; never throw).

#### Scenario: readPendingHumanRequest does not mutate the state

- GIVEN a state with `data.pendingHumanRequest` set
- WHEN `readPendingHumanRequest(state)` is called
- THEN the input state's `data.pendingHumanRequest` MUST remain set (no mutation, no
  deletion).

### Requirement: Atomic conditional pendingHumanRequest clear

The `ConversationStore` port MUST expose
`clearPendingHumanRequest(senderId, requestId): Promise<boolean>`, implemented
byte-identically by every bound adapter (durable Postgres — the runtime default — and
in-memory). It MUST reject an empty `senderId` or a `requestId` that is not exactly
twelve lowercase hex characters, and MUST transition the stored marker only when
`data.pendingHumanRequest` is a CANONICAL marker: exactly the four keys
`requestId`/`ref`/`createdAt`/`customerNotifiedAt`, all non-empty strings, a valid
twelve-lowercase-hex `requestId`, `ref === 'HF-' + requestId`, and the stored `requestId`
equal to the supplied `requestId`. On a match it MUST set `data.pendingHumanRequest` to
JSON `null` while RETAINING the key, and MUST preserve every sibling `data` key
(including `receiptAmountPointer` and `shippingApproval`) plus `lastMessageAt`. On any
absent, malformed, extended, or mismatched marker it MUST return `false` and perform no
write. The durable adapter MUST implement this as a single conditional `UPDATE` that
sets the key with `jsonb_set` to JSON `null`, and MUST derive success from the
affected-row count only. This primitive MUST NOT be described or relied upon as
cross-store atomic.

#### Scenario: Canonical matching marker is cleared to JSON null

- GIVEN a sender S whose `data.pendingHumanRequest` is a canonical marker for
  `requestId = 'abc123def456'`
- WHEN `clearPendingHumanRequest(S, 'abc123def456')` is called
- THEN the result MUST be `true`
- AND `data.pendingHumanRequest` MUST be JSON `null` with the key still present
- AND every sibling `data` key and `lastMessageAt` MUST be unchanged.

#### Scenario: Absent, malformed, or mismatched marker is left untouched

- GIVEN a sender S whose stored `pendingHumanRequest` is absent, is not a plain object,
  is missing a required key, carries an extra key, has a malformed `ref` or id, or is a
  canonical marker with a different `requestId`
- WHEN `clearPendingHumanRequest(S, 'abc123def456')` is called
- THEN the result MUST be `false`
- AND the stored marker MUST be unchanged (no write).

#### Scenario: Invalid arguments never touch the store

- GIVEN any stored state
- WHEN `clearPendingHumanRequest` is called with an empty sender or a `requestId` that is
  not exactly twelve lowercase hex characters
- THEN the result MUST be `false` with no write.

### Requirement: pendingHumanRequest survives an LLM_IDLE_TIMEOUT_MS reset

The `AgentRunner` idle-reset path (see the `llm-agent` delta) MUST preserve the
`pendingHumanRequest` marker across the existing `LLM_IDLE_TIMEOUT_MS` reset. The
adapter's UPSERT MUST preserve the live marker under the row lock even if the runner's
patch contains a stale marker or omits it; the marker is preserved byte-identically.

#### Scenario: idle reset preserves the marker

- GIVEN a sender S whose `pendingHumanRequest` is set
- AND `LLM_IDLE_TIMEOUT_MS` has elapsed since `lastMessageAt`
- WHEN the runner's idle-reset path runs
- THEN the new `lastMessageAt` is set (idle boundary)
- AND the persisted `data.pendingHumanRequest` MUST equal the pre-reset value (no
  clobbering, no fabrication of a fresh marker, no loss of `ref`).

#### Scenario: idle reset on a sender without a marker stays marker-less

- GIVEN a sender S with no `pendingHumanRequest`
- WHEN the runner's idle-reset path runs
- THEN the persisted `data.pendingHumanRequest` MUST equal `null` (or be absent, reading
  as `null` via the helper).
