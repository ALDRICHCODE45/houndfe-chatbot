# conversation-store Spec

## Purpose

Provide a port (`ConversationStore`) for tracking per-sender conversation state in
HoundFe's chatbot. State is keyed by WhatsApp sender id and includes a `lastMessageAt`
timestamp plus an open `data: Record<string, unknown>` payload that downstream slices
(LLM agent, cart, etc.) can fill in. This slice ships an in-memory implementation only;
the port lets future slices swap in PostgreSQL or another durable store without changing
callers.

## Requirements

### Requirement: Manage conversation state by sender id

The system MUST provide a conversation store port that can create, read, and update conversation state by WhatsApp sender id.
The slice MUST use an in-memory implementation only.

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
