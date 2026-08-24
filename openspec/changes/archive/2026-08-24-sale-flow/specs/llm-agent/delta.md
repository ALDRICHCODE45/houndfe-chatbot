# Delta for llm-agent

## Out of Scope (non-goals)

This delta does NOT modify:

- LLM provider requirements. The `VercelAiLlmAgent` adapter continues to call
  the `generateText` provider seam configured for the implementation in the
  repository (`@ai-sdk/openai` + `OPENAI_API_KEY`). The pre-existing spec drift
  between this file and the shipped provider (`gateway()` + `AI_GATEWAY_API_KEY`
  in `openspec/specs/llm-agent/spec.md` vs. shipped `openai(model)` + `OPENAI_API_KEY`)
  is logged as a follow-up slice (`llm-agent-provider-spec-sync`) and is NOT
  resolved here.
- The `AgentRunner` idle-timeout, in-memory history truncation, or monthly cost
  guard semantics. Those scenarios are preserved verbatim.
- The chatbot-api contract or the `ChatbotApiClient` port surface. This delta
  only changes what the agent's `TOOL_REGISTRY` binding resolves to and how the
  system prompt is composed at module boot.

## REMOVED Requirements

None.

`## RENAMED Requirements` is intentionally unsupported in `openspec-deltas`
until executable rename semantics land.

## MODIFIED Requirements

### Requirement: AgentRunner drives the tool-calling loop

`AgentRunner` MUST load prior history from `ConversationStore`, truncate to
`LLM_HISTORY_TURNS` IN MEMORY (not in the store), invoke `LlmAgentPort.run(...)`
with the active tool set, and return the assistant reply plus the assembled
message list.
The `TOOL_REGISTRY` provider MUST supply the real sale-flow tool set
(`searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`,
`upsertCustomer`, `createSale`, `attachReceipt`, `updateDelivery`,
`getOrderHistory`) bound from `RealToolRegistry`. The registry MUST inject
`CHATBOT_API_CLIENT` and `CONVERSATION_STORE`. A historical placeholder
(`getCurrentTime`) MAY remain in the repository as a test fixture but MUST NOT
be the production binding.
(Previously: `A ToolRegistry provider MUST supply at least one placeholder tool
(getCurrentTime).` — the getCurrentTime-only placeholder constraint has been
relaxed; the production binding is now the real sale-flow tool set wired
through `RealToolRegistry`.)

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
(Previously: `The system prompt MUST instruct the model to ...` and `The
runner MUST NOT override this prompt at runtime.` — the contract is preserved
in full and tightened: composition at boot is now the only point where the
final prompt is built.)

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

## ADDED Requirements

### Requirement: LlmAgentModule resolves the real sale-flow tool set and ChatbotApiClient

`LlmAgentModule` MUST import `ChatbotApiModule` (so `CHATBOT_API_CLIENT` is
available for DI) and MUST bind `TOOL_REGISTRY` to `RealToolRegistry`. The
runner MUST observe the real tool set on every `handle(...)` call. Provider
requirements (gateway / OpenAI / etc.) are out of scope for this slice; spec
drift on the provider is logged as a follow-up.

#### Scenario: Production wiring resolves RealToolRegistry with ChatbotApiClient

- GIVEN a production `LlmAgentModule` build
- WHEN the DI container resolves both `TOOL_REGISTRY` and the runner
- THEN `TOOL_REGISTRY` MUST be bound to `RealToolRegistry`
- AND its constructor MUST have received `CHATBOT_API_CLIENT` (bound to
  `ChatbotApiHttpClient`)
- AND `tools.getTools()` MUST include every key named in the `sale-flow-tools`
  spec.

#### Scenario: Tests can override the tool registry

- GIVEN a `Test.createTestingModule({ imports: [LlmAgentModule] })` build that
  overrides `TOOL_REGISTRY` with a stub
- WHEN the runner is constructed
- THEN the runner MUST consume the stub registry (not `RealToolRegistry`)
- AND other DI bindings MUST remain intact.
