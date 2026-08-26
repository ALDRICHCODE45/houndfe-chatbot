# Delta for conversation-store

## Out of Scope (non-goals)

This delta does NOT introduce:

- **A new storage table for the pending marker.** The marker lives under
  `ConversationState.data.pendingHumanRequest` — a sibling of `cart` and `placedSaleId`
  in the open JSONB bag. No migration, no new module-owned storage.
- **Deep-merge of `data` at the storage layer.** The existing UPSERT contract still
  REPLACES `data` as a whole; the marker survives because the helper preserves it on
  write (see the human-handoff spec's `pendingHumanRequest` lifecycle).
- **Changes to the `CONVERSATION_STORE` port signature.** The `update` method is
  unchanged; the new field is read/written through pure helpers.
- **A schema-validation change on `ConversationStateData`.** The type stays an open
  `Record<string, unknown>` from the storage layer's view; the typed optional
  `pendingHumanRequest?: PendingHumanRequest | null` is a domain-layer narrowing only.

## MODIFIED Requirements

### Requirement: Persist typed agent message history

`ConversationState.data` MUST be able to carry an `AgentMessage[]` field typed as the union
`{ role: 'user', content: string } | { role: 'assistant', content: string } | { role: 'tool', toolCallId: string, content: unknown }`.
When the field is absent on read or write, the adapter MUST treat it as `[]` (backward-compatible default).

The slice MAY add additional optional typed convenience fields to `ConversationStateData`
without a migration, so long as (a) the adapter continues to REPLACE `data` as a whole on
`update`, (b) the new fields live under named keys (no top-level state shape change), and
(c) every reader that needs the field uses a pure helper that returns `null` when the key
is missing.

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

- GIVEN an existing sender S with
  `data = { messages: [m1, m2], pendingHumanRequest: { requestId: 'abc123def456',
    ref: 'HF-abc123def456', createdAt: '2026-09-01T00:00:00.000Z',
    customerNotifiedAt: '2026-09-01T00:00:01.000Z' } }`
- WHEN the runner performs
  `update(S, { lastMessageAt: T2, data: { messages: [m1, m2, m3], pendingHumanRequest: <preserved> } })`
- THEN a subsequent `get(S).data.pendingHumanRequest` MUST deep-equal the prior value
- AND a subsequent `readPendingHumanRequest(state(S))` MUST return that value (not `null`).

## ADDED Requirements

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

A missing key MUST read as `null`. The field MUST NOT alter the UPSERT semantics: the
adapter still REPLACES `data` as a whole on `update`. Callers that need to preserve the
marker through a data-replacing write MUST read the marker first and re-include it in the
patch.

#### Scenario: typed field is present and optional

- GIVEN the `ConversationStateData` type
- WHEN the type is statically inspected
- THEN the type MUST include the optional field
  `pendingHumanRequest?: PendingHumanRequest | null`.

#### Scenario: missing key reads as null via the helper

- GIVEN a stored `ConversationState` whose `data` has no `pendingHumanRequest` key
- WHEN `readPendingHumanRequest(state)` is called
- THEN the result MUST equal `null` (no default fabrication, no validation error).

#### Scenario: explicit null clears the marker

- GIVEN a sender S whose `pendingHumanRequest` is currently set
- WHEN a write carries `data: { ..., pendingHumanRequest: null }`
- THEN a subsequent `readPendingHumanRequest(state(S))` MUST equal `null`.

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

- GIVEN a state with `data.pendingHumanRequest = { requestId: 'abc123def456',
  ref: 'HF-abc123def456', createdAt: '2026-09-01T00:00:00.000Z',
  customerNotifiedAt: '2026-09-01T00:00:01.000Z' }`
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

### Requirement: pendingHumanRequest survives an LLM_IDLE_TIMEOUT_MS reset

The `AgentRunner` idle-reset path (see the `llm-agent` delta) MUST preserve the
`pendingHumanRequest` marker across the existing `LLM_IDLE_TIMEOUT_MS` reset. The
reset path's UPSERT MUST carry `pendingHumanRequest` equal to the value freshly read from
the durable state (which itself carries the marker because `service.create(...)` already
wrote it on a prior turn), so the marker is preserved byte-identically.

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