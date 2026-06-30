# Proposal: LLM Agent & Conversation Persistence

## Intent

The previous slice (`whatsapp-channel-foundation`) wired the chatbot repo end-to-end as an echo bot, but every customer message is currently answered with `Echo: ${text}`. This slice replaces the echo with a real LLM agent loop and gives the agent persistent per-sender conversation memory, so subsequent slices (catalog, cart, Skydropx shipping, human handoff) can plug real tools into a working foundation. No real sale/cart flow is delivered here — only the chassis.

## Goal & Success Criteria

- Inbound WhatsApp text → agent loop runs → placeholder tool can fire → assistant reply persisted to per-sender state → returned via `WhatsappSenderPort`.
- `pnpm test` passes; new specs cover the LlmAgentPort adapter (mocked SDK), AgentRunner, ToolRegistry, history truncation, idle-timeout, cost guard, dispatcher swap, store upsert relaxation, and env fail-fast.
- Boot fails loudly when `AI_GATEWAY_API_KEY` is missing or `LLM_MODEL` is unset (Joi fail-fast, matches existing `app-config` pattern).
- A long chat within one `senderId` survives inside the agent context; the next inbound message after the idle timeout starts a fresh context.
- The agent refuses to invent prices, stock, promotion eligibility, delivery dates, or order status when no tool can answer — asserted by a system-prompt integration test.
- CI workflow runs `pnpm test` on PR; `forbidOnly: true` in Jest blocks `.only` from landing.

## Scope

### In Scope

- LLM provider integration via Vercel AI SDK + AI Gateway, hidden behind `LlmAgentPort` (Symbol DI); model string from env.
- Agent loop: `generateText` + `tools` + `stopWhen` step cap; `ToolRegistry` provider for future real tools; 1-2 placeholder tools (`getCurrentTime`, trivial echo) to prove the loop fires.
- Extend `ConversationState.data` with typed `messages: AgentMessage[]`; history truncation in the agent assembler (not the store); idle-timeout session window from env; session reset path.
- Soft cost guard: per-turn token counter + monthly ceiling env + structured-log warnings at 80% and 100%.
- Wire `WebhookDispatcherService` to call `agent.run(...)` instead of the echo path.
- Folded follow-ups: relax `InMemoryConversationStore.update` to upsert behavior (agent does upsert-style writes); add `.github/workflows/ci.yml` + Jest `forbidOnly: true` (no CI exists yet).
- New env vars (Joi fail-fast, exposed via `AppConfig`): `AI_GATEWAY_API_KEY`, `LLM_MODEL`, `LLM_MAX_STEPS`, `LLM_MONTHLY_TOKEN_CEILING`, `LLM_IDLE_TIMEOUT_MS`, `LLM_HISTORY_TURNS`.

### Out of Scope

- Real `chatbot-api` tools (catalog, pricing, customer, sales) — next chained slice; `ChatbotApiClient` is not modified this slice (the `rules.proposal` "verify against chatbot-api contract" check is satisfied vacuously: zero new endpoint calls).
- Skydropx shipping, human handoff, image recognition — later slices.
- Durable DB persistence (Postgres `ConversationStore` adapter + migration) — next chained slice; in-memory losses on restart are accepted for the foundation.
- Deferred follow-ups (explicitly NOT folded): PII redaction in chatbot-api client logging; distinct 4xx-other error class; `multer` advisory bump. None touch code this slice modifies.

## Capabilities

### New Capabilities

- `llm-agent`: LlmAgentPort (Symbol DI), AI SDK adapter (`generateText` + `gateway`), AgentRunner with tool-calling loop, ToolRegistry provider, 1-2 placeholder tools, soft cost guard (per-turn + monthly token ceiling), idle-timeout session window, history truncation.

### Modified Capabilities

- `conversation-store`: `ConversationState.data` gains typed `messages: AgentMessage[]`; `update` returns the merged record (or auto-creates) instead of throwing `NotFoundException` when the sender is missing — the agent does upsert-style writes.
- `whatsapp-webhook`: dispatcher invokes the agent and persists the assistant turn; the `Echo: ${text}` reply is removed.

## Approach

Design-intent only — the design phase picks the concrete module/folder layout and sequence diagrams.

- **Provider**: Vercel AI SDK (`ai`) with `gateway` as the model provider; `AI_GATEWAY_API_KEY` carries the credential. A `VercelAiLlmAgent` adapter implements an `LlmAgentPort` (Symbol) so the SDK never leaks into `application/` or `domain/` layers. Model string (e.g. `anthropic/claude-sonnet-4.5` or a cheap tier) read from `LLM_MODEL` env. Provider swap = env change, no code change.
- **Agent loop**: `generateText` with `tools` + `stopWhen: stepCountIs(N)`. A `ToolRegistry` provider returns the active tool set; placeholder tools (`getCurrentTime`, `echoText`) ship this slice so the loop is provably wired, real tools plug in later without touching the loop.
- **Persistence**: extend `ConversationState.data` with `messages: AgentMessage[]` (typed `user | assistant | tool` union). Truncation (last N turns) lives in the **agent assembler**, not the store, so the store stays a dumb bag. Idle timeout (configurable ms) flips a per-sender `lastMessageAt` check; on timeout the next inbound starts a fresh context.
- **Dispatcher swap**: replace `Echo: ${text}` with `agent.run({ senderId, text })`; on success, persist the assistant turn via `conversationStore.update` (now upsert). No proactive sends — keep inside the WhatsApp 24h free service window.
- **Cost guard**: counter increments per `generateText.usage` (`promptTokens` + `completionTokens`); aggregate compared to `LLM_MONTHLY_TOKEN_CEILING`; warn logs at 80% and 100% (no hard kill-switch in the AI SDK; soft guard only).
- **CI + TDD guard**: `.github/workflows/ci.yml` runs `pnpm install` + `pnpm test` on push/PR; `forbidOnly: true` added to the Jest config to prevent `.only` from landing.

## Product Requirements

1. **Language**: All customer-facing bot replies are written in **neutral professional Mexican Spanish** (no voseo, no regional slang). Encoded in the system prompt and asserted by a system-prompt integration test.
2. **No-hallucination contract**: the system prompt MUST instruct the model to honestly say "esa función aún no está disponible" when asked for something not yet tool-supported. MUST NOT fabricate prices, stock, promotion eligibility, delivery dates, or order status. Encoded as a hard requirement in the `llm-agent` spec.
3. **In-memory persistence is acceptable** for this foundation slice; history is lost on process restart. Documented in deployment notes; the durable slice is chained next.
4. **Idle-timeout window is configurable** via `LLM_IDLE_TIMEOUT_MS`; the design phase proposes a default (TBD) based on WhatsApp 24h service-window heuristics. On timeout, the next inbound starts a fresh context.
5. **AI Gateway is the confirmed billing/provider path**; the API key lives in `AI_GATEWAY_API_KEY`. A single key + model-string swap covers all providers.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/llm-agent/` | New | LlmAgentPort, VercelAiLlmAgent adapter, AgentRunner, ToolRegistry, placeholder tools, cost guard, session-timeout service |
| `src/conversation/domain/conversation-store.ts` | Modified | Add `AgentMessage` type; `data` gains typed `messages`; `update` becomes upsert |
| `src/conversation/infrastructure/in-memory-conversation.store.ts` | Modified | Implement upsert on `update`; update spec |
| `src/whatsapp/application/webhook-dispatcher.service.ts` | Modified | Replace `Echo:` with `agent.run(...)`; persist assistant turn |
| `src/whatsapp/whatsapp.module.ts` | Modified | Import `LlmAgentModule` |
| `src/app.module.ts` | Modified | Register `LlmAgentModule` |
| `src/config/env.validation.ts` | Modified | Add LLM env vars (Joi) |
| `src/config/configuration.ts` | Modified | Surface LLM settings under `appConfig.llm` |
| `package.json` | Modified | Add `ai` (default Gateway import from `ai`; no extra provider package required) |
| `package.json` (jest key) | Modified | Add `forbidOnly: true` |
| `.github/workflows/ci.yml` | New | pnpm install + pnpm test on push/PR |
| Existing `webhook-dispatcher.service.spec.ts` | Modified | Replace echo assertions with agent-mock assertions |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| $200/mo soft ceiling breached (no hard kill-switch in AI SDK) | Med | Per-turn token counter + monthly aggregator; warn at 80% and 100% via structured log; alarm route is human-ops follow-up; cheap-tier default model recommended |
| Provider lock-in via AI SDK shape | Low | `LlmAgentPort` abstraction + model-string swap on Gateway = provider-agnostic; can drop to direct provider SDKs without touching call sites |
| In-memory history lost on restart | Med | Documented as accepted for foundation slice; durable slice is the immediate next chained delivery; reactive 24h service window limits user-facing damage |
| AI Gateway billing account not provisioned | Med | Boot must require `AI_GATEWAY_API_KEY` (Joi fail-fast) so a missing key fails loud, not silent |
| Default idle-timeout TBD | Low | Configurable env; design phase proposes a default based on WhatsApp 24h service-window heuristics |
| Hallucination in foundation (no real tools yet) | Med | Hard system-prompt requirement + spec scenario + integration test asserting refusal behavior |
| Slice size > 800 LoC budget | Low-Med | Forecast ~750-950 LoC; natural chained cut is to defer CI workflow + reset-path tests if it grows during apply (see Sizing) |

## Rollback Plan

The slice is additive. Revert the feature branch: drop `src/llm-agent/`, revert `webhook-dispatcher.service.ts` to its `Echo: ${text}` version, drop the LLM env-var additions and Jest `forbidOnly`, drop the new dependency. The pre-existing echo behavior is preserved in git history. `ConversationStore` changes are forward-compatible — `messages` defaults to `[]`, and `update` returning the merged record is a strict superset of throwing; reverting returns the original behavior. The two folded follow-ups (update relax + CI) are independently revertible. The skill-registry entry for `ai-sdk` is consumed only by this slice and is harmless if unused.

## Dependencies

- `ai` (Vercel AI SDK, includes `gateway` default provider) — added this slice.
- `ConversationStore` + `WhatsappSenderPort` — already shipped in `whatsapp-channel-foundation`; this slice consumes them.
- AI Gateway billing account with `AI_GATEWAY_API_KEY` — pre-requisite; without it, `pnpm start` fails at boot (intentional, fail-fast).
- (No new `chatbot-api` calls this slice; `ChatbotApiClient` spec is unmodified — `rules.proposal` contract check satisfied.)

## Sizing / Delivery

Target: single slice, fast-forward merge to main, no PR (solo dev workflow, no GitHub PRs). Forecast: **~750-950 LoC** (code + tests), at the edge of the user-set ~800 LoC review ceiling.

Natural chained-slice boundaries AFTER this one:

1. **Durable persistence slice** — Postgres `ConversationStore` adapter + migration. ~300-500 LoC, swap is a one-line module binding change.
2. **Real tools slice** — `chatbot-api` catalog/pricing/customer/sales tools registered in the existing `ToolRegistry`. ~400-600 LoC.
3. **Skydropx shipping slice** — separate concern.
4. **Human handoff slice** — separate concern.

If the foundation slice grows past ~950 LoC during apply, the natural break is to defer the CI workflow + reset-path test coverage to a tiny follow-up chained slice (the rest of the foundation stands on its own).

## WhatsApp flows affected (per `openspec/config.yaml` `rules.proposal`)

This slice **unblocks** every R1–R16 flow in `docs/conversation-analysis.md` by giving them a working agent + persistent memory substrate. The placeholder tools mean the agent will honestly tell customers "esa función aún no está disponible" for any tool not yet wired (Product Requirement #2). **No R-flow is closed end-to-end here**; close-out happens in the chained slices (real-tools, shipping, handoff, image-recognition).
