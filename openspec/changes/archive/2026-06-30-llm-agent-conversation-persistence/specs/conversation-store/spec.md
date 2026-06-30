# Delta for conversation-store

## MODIFIED Requirements

### Requirement: Manage conversation state by sender id

The system MUST provide a conversation store port that can create, read, and update conversation state by WhatsApp sender id.
The slice MUST use an in-memory implementation only.
`update` MUST be UPSERT: when no record exists for the sender, the adapter MUST create one with the supplied patch and return the merged record (no `NotFoundException` thrown from `update`).
(Previously: `update` threw `NotFoundException` when the sender was missing.)

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

### Requirement: Persist typed agent message history

`ConversationState.data` MUST be able to carry an `AgentMessage[]` field typed as the union `{ role: 'user', content: string } | { role: 'assistant', content: string } | { role: 'tool', toolCallId: string, content: unknown }`.
When the field is absent on read or write, the adapter MUST treat it as `[]` (backward-compatible default).

#### Scenario: Missing messages field defaults to empty array

- GIVEN a stored `ConversationState` whose `data` has no `messages` key
- WHEN the runner reads the state
- THEN `data.messages` MUST resolve to `[]`.

#### Scenario: Messages round-trip through update

- GIVEN an existing sender record
- WHEN `update` is called with `data.messages = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'Hola' }]`
- THEN a subsequent `get` returns the same `messages` array unchanged.
