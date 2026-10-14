# Delta for Conversation Store

## ADDED Requirements

### Requirement: Receipt pointer state is typed and preserves siblings

Conversation state MAY contain only a small typed pointer for the active receipt flow; lifecycle, idempotency, attempts, captured sale association, object identity, and attachment outcome MUST remain in the durable receipt-media store. Any state write MUST preserve unrelated fresh sibling fields under the existing whole-data replacement contract.

#### Scenario: active pointer survives an agent write

- GIVEN fresh state contains an active receipt pointer and `placedSaleId`
- WHEN an agent turn writes messages
- THEN both the pointer and `placedSaleId` MUST remain unchanged.

#### Scenario: missing pointer is inactive

- GIVEN state has no receipt pointer
- WHEN receipt routing checks the state
- THEN it MUST treat the sender as having no active amount/confirmation flow without fabricating a receipt.

### Requirement: Durable state supports restart recovery

Receipt routing MUST use durable state rather than only conversation JSONB for reservation, status, provider message/media uniqueness, captured sale id, retry attempts, and attach outcome. A fresh process MUST be able to load and resume an incomplete receipt without losing its correlation or creating a duplicate.

#### Scenario: durable reservation is recovered after restart

- GIVEN a receipt reservation persisted before process termination
- WHEN a fresh application instance loads it
- THEN it MUST observe the same lifecycle status, sender, captured sale id, and retry counters and may resume idempotently.

#### Scenario: concurrent state does not retarget a receipt

- GIVEN a receipt captured sale A and later conversation state changes to sale B
- WHEN the receipt resumes
- THEN its durable association MUST remain sale A.
