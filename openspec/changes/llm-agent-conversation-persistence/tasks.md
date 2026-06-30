# Tasks: LLM Agent & Conversation Persistence

```text
Decision needed before apply: Yes (LoC ceiling guard)
Chained PRs recommended: Yes (work-unit commit slicing)
Chain strategy: stacked-to-main
400-line budget risk: High
```

Estimated ~880 LoC (design); edge of 800 ceiling. Pre-approved cut: if apply >950 LoC, **defer WU 7** (lint + `jest --ci` are coupled — defer both). Solo-dev: 7 work-unit commits on 1 branch, no PRs (`work-unit-commits` skill).

---

## Phase 1 — WU 1: LLM config env

- [x] 1.1 T→I `env.validation.{spec,ts}`: 6 Joi fields require `AI_GATEWAY_API_KEY`+`LLM_MODEL`; reject non-int/<1; defaults `MAX_STEPS=3`,`HISTORY_TURNS=12`,`CEILING=8_000_000`,`IDLE=10_800_000`.
- [x] 1.2 I `configuration.ts`: surface `llm` block (`gatewayApiKey`,`model`,`maxSteps`,`historyTurns`,`monthlyTokenCeiling`,`idleTimeoutMs`).

## Phase 2 — WU 2: ConversationStore UPSERT + AgentMessage canonical

- [x] 2.1 T→I `in-memory-conversation.store.{spec,ts}`: replace `NotFoundException` test → UPSERT assert (unknown sender creates+merges); `data.messages` defaults `[]`, round-trips.
- [x] 2.2 I `conversation-store.ts`: declare canonical `AgentMessage`, type `data.messages?: AgentMessage[]`, add `readMessages()`, doc `update`=UPSERT.
- [x] 2.3 I `src/llm-agent/domain/agent-message.ts`: PURE `export type { AgentMessage } from '../../conversation/domain/conversation-store'` — no re-declaration.

## Phase 3 — WU 3: domain ports + system prompt + placeholder tool

- [x] 3.1 T→I `llm-agent.port.{ts,spec.ts}` + `tool-registry.port.{ts,spec.ts}`: `LLM_AGENT` Symbol + `LlmAgentPort`/`LlmRunResult` w/ `usage:{promptTokens,completionTokens}`; `TOOL_REGISTRY` + `ToolRegistry.getTools(): Record<string,unknown>`.
- [x] 3.2 T→I `system-prompt.{ts,spec.ts}`: `SYSTEM_PROMPT` asserts refusal phrase `esa función aún no está disponible` + neutral Mexican Spanish, forbids voseo/slang.
- [x] 3.3 T→I `placeholder-tools.ts` + `in-memory-tool-registry.{ts,spec.ts}`: `getCurrentTime` via `ai.tool()`+`zod`; registry returns it.

## Phase 4 — WU 4: VercelAiLlmAgent + CostGuard + GENERATE_TEXT

- [x] 4.0 APPLY-FIRST: `pnpm add ai zod`; confirm `inputTokens`/`outputTokens` against pinned `node_modules/ai`.
- [x] 4.1 T→I `generate-text.provider.ts` + `vercel-ai-llm-agent.{ts,spec.ts}`: maps `inputTokens→promptTokens`, `outputTokens→completionTokens` w/ `?? 0`; forwards `stopWhen:stepCountIs(MAX_STEPS)`, `model:gateway(MODEL)`, system, msgs, tools.
- [x] 4.2 T (CRITICAL gate-fix) `vercel-ai-llm-agent.spec.ts`: undefined `inputTokens`/`outputTokens` → `{promptTokens:0, completionTokens:0}` (prevents NaN aggregate).
- [x] 4.3 T→I `cost-guard.service.{ts,spec.ts}`: per-turn `promptTokens+completionTokens`; one `Logger.warn` per threshold (≥80%, ≥100%); never throws.

## Phase 5 — WU 5: AgentRunner + module wiring

- [x] 5.1 T→I `agent-runner.service.{ts,spec.ts}`: `handle({senderId,text})` — load → idle-check (`now-lastMessageAt>idleMs ⇒ history=[]`) → truncate to `historyTurns` IN MEMORY → `port.run(...)` → `costGuard.record(usage)` → UPSERT user+assistant → `{reply}`.
- [x] 5.2 T (cases) `agent-runner.service.spec.ts`: empty-store, history-truncate-while-store-keeps-all, idle-5min boundary, idle-10s within-window, tool round-trip, SDK gets `SYSTEM_PROMPT`, prompt NOT overridden.
- [x] 5.3 I `llm-agent.module.ts`: imports `ConfigModule`+`ConversationModule`; binds `LLM_AGENT→VercelAiLlmAgent`, `TOOL_REGISTRY→InMemoryToolRegistry`, `GENERATE_TEXT→generateText`; exports `AgentRunner`.
- [x] 5.4 T `config.module.spec.ts`: missing `AI_GATEWAY_API_KEY`/`LLM_MODEL` throws at boot.

## Phase 6 — WU 6: Dispatcher swap + integration

- [x] 6.1 T→I `webhook-dispatcher.service.{ts,spec.ts}` (rewrite): replace `Echo:${text}` w/ `runner.handle({senderId,text})` → UPSERT user+assistant → `sender.sendText({to,text:reply})`; idle case: no `sendText` without inbound.
- [x] 6.2 I `whatsapp.module.ts`: import `LlmAgentModule`, inject `AgentRunner`.
- [x] 6.3 I `app.module.ts`: register `LlmAgentModule`.
- [x] 6.4 T `llm-agent.module.spec.ts` (integration `TestingModule`): full graph resolves all Symbol bindings.

## Phase 7 — WU 7 (CUTTABLE if >950 LoC): CI + `.only` guard

> **DEFERRED** by apply phase: cumulative changed lines already at 2776
> at the end of WU 6 (review budget 800, pre-approved cut at ~950).
> Agent foundation (WU 1–6) stands alone; the lint + CI workflow will
> ship in a follow-up slice once the foundation is reviewed and merged.

- [ ] 7.1 I `package.json`: add `eslint-plugin-jest` devDep. _(DEFERRED)_
- [ ] 7.2 I `eslint.config.mjs`: wire `no-focused-tests` for `*.spec.ts`. _(DEFERRED)_
- [ ] 7.3 I `.github/workflows/ci.yml`: `pnpm install` → `pnpm test --ci` → `pnpm lint`. _(DEFERRED)_
