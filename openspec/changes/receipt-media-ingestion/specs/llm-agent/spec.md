# Delta for LLM Agent

## MODIFIED Requirements

### Requirement: AgentRunner drives the tool-calling loop

`AgentRunner` MUST load prior history from `ConversationStore`, truncate to
`LLM_HISTORY_TURNS` IN MEMORY (not in the store), invoke `LlmAgentPort.run(...)`
with the active tool set, and return the assistant reply plus the assembled
message list.
The `TOOL_REGISTRY` provider MUST supply the real sale-flow tool set
(`searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`,
`upsertCustomer`, `createSale`, `attachReceipt`, `updateDelivery`,
`getOrderHistory`, `getPaymentDetails`, `cancelSale`, `requestHumanAssistance`)
bound from `RealToolRegistry`. The registry MUST inject `CHATBOT_API_CLIENT`,
`CONVERSATION_STORE`, and `HUMAN_HANDOFF_SERVICE`.

When `readPendingHumanRequest(state)` returns a non-null marker AND the inbound's
`senderId` matches the customer's `pendingHumanRequest` customerId, the runner MUST
short-circuit: return the canned literal reply `seguimos esperando respuesta del
agente, te avisamos en cuanto tengamos`, skip `LlmAgentPort.run(...)`, skip
`costGuard.record(...)`, and skip the per-turn `ConversationStore.update(...)` write
(transcript stays clean so the awaited-human turn doesn't bloat history).

(Previously: registry listed eleven sale-flow tools without `requestHumanAssistance`;
no short-circuit path existed; the runner always executed an LLM turn for every
customer-side inbound.)

#### Scenario: History truncates in memory and tool result round-trips

- GIVEN `LLM_HISTORY_TURNS=4`, 10 stored turns, and the real sale-flow tool set
  registered through `RealToolRegistry`
- WHEN the runner assembles the prompt and the mocked SDK returns text after one
  tool step (`searchCatalog`, `checkStock`, or `evaluateCart`)
- THEN it MUST pass at most 4 most-recent turns to the port
- AND the store MUST still hold all 10 turns
- AND the runner's `reply` reflects the tool output.

#### Scenario: Unknown sender has no state

- GIVEN a sender id that has never been stored
- WHEN the runner reads the conversation store
- THEN the result is empty or not found
- AND the tool registry is still asked for tools (which MUST resolve, even with
  no prior state).

#### Scenario: pendingHumanRequest is present triggers a short-circuit reply

- GIVEN a sender S whose `data.pendingHumanRequest` is set to
  `{ requestId: 'abc123def456', ref: 'HF-abc123def456', createdAt,
  customerNotifiedAt }`
- AND an inbound from S (customer-side) with `text = '¿siguen?'`
- WHEN the runner handles the inbound
- THEN `LlmAgentPort.run(...)` MUST NOT be called (no LLM turn)
- AND `costGuard.record(...)` MUST NOT be called (no token accounting for this turn)
- AND `ConversationStore.update(...)` MUST NOT be called (no transcript append)
- AND the returned `reply` MUST equal the literal
  `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos`
  byte-identical (whitespace, final period, no trailing newline).

#### Scenario: pendingHumanRequest absent follows the normal LLM path

- GIVEN a sender S whose `data.pendingHumanRequest` is `null`
- WHEN the runner handles an inbound from S
- THEN the runner MUST follow the normal flow: load history, truncate to
  `LLM_HISTORY_TURNS`, invoke `LlmAgentPort.run(...)`, record cost, persist user +
  assistant turns.

#### Scenario: ops-side inbound never reaches the runner

- GIVEN an inbound with `from = OPS_CHANNEL_PHONE` (after normalization)
- WHEN the dispatcher classifies the inbound
- THEN `WebhookDispatcherService` MUST route the inbound to
  `HumanHandoffService.resolveReply(...)` BEFORE `AgentRunner.handle(...)`
- AND `AgentRunner.handle(...)` MUST NOT be called for ops-side inbounds.

Receipt-specific deterministic routing and safe semantic context MAY be appended after this canonical requirement; protected receipt identifiers and URLs MUST remain unavailable to the model.

## ADDED Requirements

### Requirement: Generic LLM execution remains available after deterministic receipt outcomes

After a receipt flow reaches a state requiring ordinary conversational guidance, the runner MAY invoke the LLM with safe semantic status and customer-facing context only; the model MUST not perform attachment or choose protected identifiers.

#### Scenario: safe guidance after terminal receipt outcome

- GIVEN receipt processing has reached a definite terminal failure
- WHEN the customer asks a follow-up question
- THEN the runner MAY use the LLM for Spanish guidance while protected identifiers remain absent.
