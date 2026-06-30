# Delta for llm-agent

## ADDED Requirements

### Requirement: Hide LLM provider behind a port

The system MUST expose `LlmAgentPort` (Symbol DI) consumed by `application/` and `domain/`.
Port signature: `run({ senderId, text, history, systemPrompt, tools })` returns `{ reply, messages, usage: { promptTokens, completionTokens } }`.
Imports from `ai` MUST stay inside `infrastructure/`.

#### Scenario: Application consumes the port symbol only

- GIVEN the dispatcher in `application/`
- WHEN TypeScript compiles the agent wiring
- THEN no file outside `src/llm-agent/infrastructure/` imports from `ai`
- AND the dispatcher injects `LLM_AGENT` by Symbol.

### Requirement: AI SDK adapter calls generateText via AI Gateway

`VercelAiLlmAgent` MUST implement `LlmAgentPort` by calling `generateText` with the `gateway` provider, the model string from `LLM_MODEL`, the assembled history, the system prompt, the registered tools, and `stopWhen: stepCountIs(LLM_MAX_STEPS)`.

#### Scenario: Adapter returns usage and forwards the step cap

- GIVEN `LLM_MAX_STEPS=3` and a mocked `generateText` resolving with `{ text: "Hola", usage: { promptTokens: 10, completionTokens: 5 } }`
- WHEN the adapter runs
- THEN `run` resolves with `reply: "Hola"` and `usage: { promptTokens: 10, completionTokens: 5 }`
- AND `generateText` was called with `stopWhen: stepCountIs(3)`.

### Requirement: AgentRunner drives the tool-calling loop

`AgentRunner` MUST load prior history from `ConversationStore`, truncate to `LLM_HISTORY_TURNS` IN MEMORY (not in the store), invoke `LlmAgentPort.run(...)` with the active tool set, and return the assistant reply plus the assembled message list.
A `ToolRegistry` provider MUST supply at least one placeholder tool (`getCurrentTime`).

#### Scenario: History truncates in memory and tool result round-trips

- GIVEN `LLM_HISTORY_TURNS=4`, 10 stored turns, and `getCurrentTime` registered
- WHEN the runner assembles the prompt and the mocked SDK returns text after one tool-step
- THEN it MUST pass at most 4 most-recent turns to the port
- AND the store MUST still hold all 10 turns
- AND the runner's `reply` reflects the tool output.

### Requirement: Enforce idle-timeout session window

The system MUST read `LLM_IDLE_TIMEOUT_MS` at boot.
For each inbound, the runner MUST compare stored `lastMessageAt` against the timeout.
If the gap exceeds the timeout, the runner MUST treat the call as a fresh session (empty history, `lastMessageAt` overwritten).
Within the window, prior history MUST be preserved.

#### Scenario: Boundary behavior at the idle-timeout edge

- GIVEN `LLM_IDLE_TIMEOUT_MS=60000`
- WHEN an inbound arrives 5 minutes after the stored `lastMessageAt`
- THEN the runner MUST pass empty history and overwrite `lastMessageAt`.
- AND WHEN an inbound arrives 10 seconds after the stored `lastMessageAt`
- THEN the runner MUST pass the prior (truncated) history.

### Requirement: Enforce soft monthly cost guard

The system MUST count `promptTokens + completionTokens` per `run()`, maintain a process-local monthly aggregate, and compare it against `LLM_MONTHLY_TOKEN_CEILING`.
The runner MUST emit a structured `warn` log when the aggregate crosses 80% and another at 100%.
The system MUST NOT hard-fail when the ceiling is exceeded.

#### Scenario: 80% and 100% thresholds log warn without blocking

- GIVEN the aggregate is 79% of the ceiling
- WHEN a turn pushes the aggregate to 81%
- THEN exactly one `warn` log tagged `>=80%` MUST be emitted and the runner still returns a reply.
- AND WHEN the aggregate equals the ceiling and another turn runs
- THEN a `warn` log tagged `>=100%` MUST be emitted and the runner still returns a reply.

### Requirement: No-hallucination contract in the system prompt

The system prompt MUST instruct the model to: (a) reply in neutral professional Mexican Spanish; (b) never fabricate prices, stock, promotion eligibility, delivery dates, or order status; (c) when no tool supports the request, answer exactly `esa función aún no está disponible`.
The runner MUST NOT override this prompt at runtime.

#### Scenario: Refusal phrase and language contract are asserted

- GIVEN the system prompt is constructed at boot and the mocked SDK resolves with text `esa función aún no está disponible`
- WHEN the runner handles a request with no matching tool
- THEN `reply` equals `esa función aún no está disponible`
- AND the system prompt sent to the SDK contains that literal phrase
- AND it mandates neutral professional Mexican Spanish
- AND it forbids voseo and regional slang.

### Requirement: Fail fast on missing LLM env

The application MUST refuse to boot when `AI_GATEWAY_API_KEY` is absent or `LLM_MODEL` is unset.
Joi MUST validate both alongside the existing app-config schema.
The failure MUST surface before any webhook or agent traffic is accepted.

#### Scenario: Missing key or model blocks boot

- GIVEN `AI_GATEWAY_API_KEY` is unset (other required env present)
- WHEN the application starts
- THEN boot MUST fail with a configuration error mentioning the missing variable.
- AND WHEN `LLM_MODEL` is unset
- THEN boot MUST fail with a configuration error mentioning `LLM_MODEL`.
