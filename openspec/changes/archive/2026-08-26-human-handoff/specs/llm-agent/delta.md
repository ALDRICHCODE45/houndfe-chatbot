# Delta for llm-agent

## Out of Scope (non-goals)

This delta does NOT introduce:

- **A new LLM provider.** The `LlmAgentPort` abstraction is unchanged; this slice only
  changes the runner's pre- and post-LLM bookkeeping around an awaited-human branch.
- **A new conversation-state shape beyond `data.pendingHumanRequest`.** The marker lives
  in the open `data` bag (see the `conversation-store` delta). No new module-owned
  storage, no schema migration.
- **Changes to the cost-guard thresholds or to the `LLM_HISTORY_TURNS` truncation.** The
  short-circuit path is the only behavioral change to the runner.
- **Tools other than the existing sale-flow set plus the 12th
  `requestHumanAssistance`.** The `toolsContext` injection from
  `vercel-ai-llm-agent` gains `requestHumanAssistance: { senderId }`; the runner does
  NOT receive a new context field.
- **Echo/dedup changes.** The existing `RECENT_OUTBOUND` and `WEBHOOK_DEDUP` guards
  continue to apply to ops inbounds unchanged; the dispatcher pre-routing hook runs
  AFTER both (see the `whatsapp-webhook` delta).

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

### Requirement: Enforce idle-timeout session window

The system MUST read `LLM_IDLE_TIMEOUT_MS` at boot.
For each inbound, the runner MUST compare stored `lastMessageAt` against the timeout.
If the gap exceeds the timeout, the runner MUST treat the call as a fresh session (empty history, `lastMessageAt` overwritten).
Within the window, prior history MUST be preserved.

When `data.pendingHumanRequest` is set on a sender whose `lastMessageAt` is older than
`LLM_IDLE_TIMEOUT_MS`, the idle-reset path MUST preserve the marker: the freshly loaded
`data` already carries the marker (because `HumanHandoffService.create(...)` wrote it on
a prior turn), and the runner's idle-reset UPSERT MUST carry `pendingHumanRequest` equal
to that freshly read value (ADR-28 — fresh-state spread write, see below).

#### Scenario: Boundary behavior at the idle-timeout edge

- GIVEN `LLM_IDLE_TIMEOUT_MS=60000`
- WHEN an inbound arrives 5 minutes after the stored `lastMessageAt`
- THEN the runner MUST pass empty history and overwrite `lastMessageAt`.
- AND WHEN an inbound arrives 10 seconds after the stored `lastMessageAt`
- THEN the runner MUST pass the prior (truncated) history.

#### Scenario: idle reset preserves the pendingHumanRequest marker

- GIVEN a sender S whose `pendingHumanRequest` is set
- AND `LLM_IDLE_TIMEOUT_MS` has elapsed since `lastMessageAt`
- WHEN the runner's idle-reset path runs
- THEN the new `lastMessageAt` is set (idle boundary)
- AND the persisted `data.pendingHumanRequest` MUST equal the pre-reset value
  (no clobbering, no fabrication of a fresh marker).

### Requirement: Tools return a stable error envelope instead of raw HTTP

(This requirement is unchanged; the 12th tool `requestHumanAssistance` does NOT call the
backend chatbot-api and therefore does not return one of the backend-driven `kind`
values. The discriminated mapping in `src/sale-flow/application/error-mapping.ts` is
extended only with two non-HTTP kinds used by the new tool: `disabled` (kill-switch)
and `validation` (reserved kind / malformed digest). See the `sale-flow-tools` delta.)

(Previously: no `disabled` kind; no `requestHumanAssistance` tool.)

#### Scenario: 5xx upstream error envelope is unchanged

- GIVEN the `evaluateCart` tool is invoked with a valid input
- AND the stubbed `ChatbotApiHttpClient.evaluateCart` throws `UpstreamError`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'upstream', retryable: true } }`
- AND the thrown error MUST NOT propagate.

### Requirement: No-hallucination contract in the system prompt

The system prompt sent to the model MUST be the literal string
`SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`, composed exactly once at
module boot. The composed prompt MUST instruct the model to: (a) reply in
neutral professional Mexican Spanish; (b) never fabricate prices, stock,
promotion eligibility, delivery dates, or order status; (c) when no tool
supports the request, answer exactly `esa función aún no está disponible`.
`AgentRunner` MUST NOT override the composed prompt at runtime — composition
happens at module boot, not per turn. The base `SYSTEM_PROMPT` MUST be
appended unmodified (`SALE_FLOW_INSTRUCTIONS` adds to it, never replaces).

The short-circuit reply is OUTSIDE the composed system prompt — it is the
runner returning a hard-coded canned string when `pendingHumanRequest` is set,
NOT a model-generated response. The composed prompt is unchanged by this slice
beyond the new step and the three edits documented in the `sale-flow-tools`
delta.

(Previously: no short-circuit reply path; the composed prompt was the only
mechanism.)

#### Scenario: Refusal phrase and language contract are asserted (base layer)

- GIVEN the system prompt is composed at boot (base + slice) and the mocked SDK
  resolves with text `esa función aún no está disponible`
- WHEN the runner handles a request with no matching tool
- THEN `reply` equals `esa función aún no está disponible`
- AND the composed system prompt sent to the SDK contains that literal phrase
- AND it mandates neutral professional Mexican Spanish
- AND it forbids voseo and regional slang.

#### Scenario: Composed prompt contains all four contract strings (base + slice)

- GIVEN `LlmAgentModule` is built with `SaleFlowModule` imported
- WHEN the runner reads the composed system prompt from its config source
- THEN the prompt MUST contain (i) the literal refusal phrase
  `esa función aún no está disponible`; (ii) the forbidden slang block from
  `SYSTEM_PROMPT` (voseo and the regional examples listed there);
  (iii) the sale-flow step list declared in the `sale-flow-tools` spec;
  (iv) the explicit list-price-only instruction
  (call `createSale` at `originalPriceCents`, never at a discounted
  `finalPriceCents`).

#### Scenario: short-circuit reply is a hard-coded runner string, not a model reply

- GIVEN a sender S with `pendingHumanRequest` set
- WHEN the runner short-circuits
- THEN the canned reply MUST be the literal
  `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos`
- AND the canned reply MUST be returned without invoking the SDK
- AND the canned reply MUST NOT be added to `data.messages`.

## ADDED Requirements

### Requirement: AgentRunner final write spreads fresh state (ADR-28)

After `LlmAgentPort.run(...)` returns, the runner MUST re-fetch the durable state via
`ConversationStore.get(senderId)` and persist
`data: { ...freshState.data, messages: nextTurns }` (fresh-state spread). The pre-LLM
state MUST NOT be spread over the post-LLM write, because tools executed during the LLM
turn can persist typed convenience fields (`cart`, `placedSaleId`,
`pendingHumanRequest`, future siblings) that the runner's current
`data: { messages: nextTurns }` write would otherwise clobber.

The fresh-state spread write MUST preserve the byte-identical values of every sibling
key the tools wrote during the LLM turn. The runner MUST emit a structured `error` log
when the post-`run` `get` returns `null` (a race where the state was deleted during the
LLM turn) and MUST NOT attempt a `null`-spread write in that case.

#### Scenario: cart written by a tool during the turn survives the post-run write

- GIVEN a sender S with a pre-LLM state whose `data` has `cart: undefined`
- AND a tool invoked during the LLM turn persists
  `data: { ..., cart: { items: [{ productId: 'p-1', quantity: 1, unitPriceCents: 1000 }],
                            idempotencyKey: '', expectedTotalCents: undefined } }`
- WHEN the LLM turn completes
- THEN the runner's post-`run` `get(S)` MUST return `state.data.cart === <the tool's cart>`
- AND the runner's final UPSERT MUST carry `data.cart === <the tool's cart>` (fresh-state
  spread, no clobbering back to the pre-LLM `undefined`).

#### Scenario: pendingHumanRequest written by requestHumanAssistance survives the post-run write

- GIVEN a sender S with no prior `pendingHumanRequest`
- AND `requestHumanAssistance` invoked during the LLM turn persists the marker on
  `data.pendingHumanRequest`
- WHEN the LLM turn completes
- THEN the runner's post-`run` `get(S).data.pendingHumanRequest` MUST equal the
  marker the tool wrote
- AND the runner's final UPSERT MUST carry that marker (not `null` and not the
  pre-LLM absent state).

#### Scenario: post-run get returning null logs an error and skips the spread write

- GIVEN a sender S whose state was deleted between `llm.run` and the post-`run` `get`
- WHEN the post-`run` `get(S)` returns `null`
- THEN the runner MUST emit a structured `error` log tagged `state-deleted-during-run`
  with `senderId`
- AND the runner MUST NOT perform a `null`-spread `update` (no key collision, no
  UPSERT of an empty record).

#### Scenario: pendingHumanRequest is not cleared by the runner

- GIVEN a sender S with `pendingHumanRequest` set BEFORE the LLM turn
- AND no tool in the turn touches `pendingHumanRequest`
- WHEN the LLM turn completes
- THEN the persisted `data.pendingHumanRequest` MUST equal the pre-LLM value
  (no automatic clearing by the runner; clearing is the
  `HumanHandoffService.resolveReply(...)` responsibility, NOT the runner's).

### Requirement: toolsContext gains requestHumanAssistance.senderId

The `VercelAiLlmAgent` infrastructure adapter MUST expose a `toolsContext` object whose
shape is the union of `{ senderId: string }` (already in place for the other tools)
plus the new field `requestHumanAssistance: { senderId: string }`. The `requestHumanAssistance`
factory reads `options.context.senderId` (NOT `options.context.requestHumanAssistance.senderId`)
because the tool schema declares `contextSchema: z.object({ senderId: z.string().min(1) })`
— the context envelope key matches the tool name, but the inner schema is uniform.

#### Scenario: toolsContext exposes the requestHumanAssistance.senderId field

- GIVEN a registered `RealToolRegistry` with the 12th tool
- WHEN the runner builds the toolsContext for an inbound from sender S
- THEN `toolsContext.requestHumanAssistance.senderId` MUST equal S
- AND `toolsContext.senderId` MUST equal S (the canonical field used by every other tool).

#### Scenario: requestHumanAssistance.execute uses options.context.senderId

- GIVEN the tool is invoked with
  `input = { kind: 'out_of_stock', digest: {...} }` and
  `options.context = { senderId: '521...' }`
- WHEN `execute(input, options)` runs
- THEN the tool MUST call
  `service.create({ senderId: options.context.senderId, ... })`
  (NOT `options.context.requestHumanAssistance.senderId`).

### Requirement: AgentRunner does not enter the LLM path while pendingHumanRequest is set

The short-circuit branch MUST run BEFORE any LLM-side work (history load, truncation,
`llm.run(...)`, `costGuard.record(...)`, `ConversationStore.update(...)`). When the
marker is set on a customer-side inbound, the runner MUST return within one
`readPendingHumanRequest(state)` + canned-reply assignment cycle — no other side
effects.

#### Scenario: short-circuit path has zero LLM and zero store side effects

- GIVEN a sender S with `pendingHumanRequest` set
- WHEN the runner handles a customer-side inbound from S
- THEN the runner MUST NOT call `LlmAgentPort.run(...)`
- AND the runner MUST NOT call `costGuard.record(...)`
- AND the runner MUST NOT call `ConversationStore.update(...)` for this turn
- AND the runner MUST return `{ reply: <canned>, messages: <unchanged> }`.

#### Scenario: short-circuit does not depend on LLM_IDLE_TIMEOUT_MS

- GIVEN a sender S with `pendingHumanRequest` set
- AND `lastMessageAt` is fresh (well within `LLM_IDLE_TIMEOUT_MS`)
- WHEN the runner handles an inbound from S
- THEN the runner MUST still short-circuit (marker presence is the discriminator, NOT
  the idle boundary).
- AND WHEN `lastMessageAt` is older than `LLM_IDLE_TIMEOUT_MS`
- THEN the runner MUST still short-circuit (the idle path also preserves the marker
  per the fresh-state spread write).