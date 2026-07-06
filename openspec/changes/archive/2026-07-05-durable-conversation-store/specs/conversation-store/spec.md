# Delta for conversation-store

## Out of Scope (non-goals)

This delta does NOT introduce:

- Vector search, embeddings, or RAG retrieval.
- Direct access to the `houndfe-backend` Postgres. The chatbot uses its OWN Postgres; the architectural separation is preserved.
- Data migration from the in-memory adapter. Pre-existing in-memory state is process-local and is discarded on restart; the durable adapter starts empty.

The port (`CONVERSATION_STORE` symbol, `ConversationStore` interface, `AgentMessage` union, `ConversationState`, `ConversationStateData`) is **UNCHANGED**.

## MODIFIED Requirements

### Requirement: Manage conversation state by sender id

The system MUST provide a conversation store port that can create, read, and update conversation state by WhatsApp sender id.
The runtime MUST bind exactly one adapter through the `CONVERSATION_STORE` token that honors the port contract: `update` MUST be UPSERT (when no record exists, the adapter creates one with the supplied patch and returns it; when a record exists, the patch is shallow-merged over it with the `data` field REPLACED as a whole object — no JSONB deep merge at the storage layer), `get` MUST return `null` when no record exists, and the sender id MUST be preserved on every returned record.
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

## ADDED Requirements

### Requirement: Conversation state survives process restart

The durable adapter MUST persist every committed `create` and `update` so that a fresh adapter instance connected to the same database reads back the same state previously written by another instance.

#### Scenario: State survives adapter instance restart

- GIVEN a sender's state has been written by adapter instance A against database D
- WHEN a fresh adapter instance A' is constructed against the same database D
- AND A' calls `get(senderId)`
- THEN the returned state MUST deep-equal the state written by A.

### Requirement: Adapter honors UPSERT semantics on update

Every adapter bound to `CONVERSATION_STORE` MUST satisfy the port's documented UPSERT semantics byte-identically. `get` MUST return `null` when no record exists. `update` MUST create a record from the patch when none exists and MUST shallow-merge the patch over the existing record otherwise; the patch's `data` field REPLACES the prior `data` object as a whole (no JSONB deep merge at the storage layer).

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