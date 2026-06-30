# Archive Report: llm-agent-conversation-persistence

**Change**: `llm-agent-conversation-persistence`
**Branch**: `feat/llm-agent-conversation-persistence`
**Mode**: Strict TDD, OpenSpec
**Verdict**: PASS WITH WARNINGS
**Archived**: 2026-06-30 → `openspec/changes/archive/2026-06-30-llm-agent-conversation-persistence/`
**Engram topic key**: `sdd/llm-agent-conversation-persistence/archive-report`

---

## Summary

Replaced the echo path with a real LLM agent loop and gave the agent persistent per-sender
conversation memory. The foundation slice ships 3 delta specs (`llm-agent` new,
`conversation-store` and `whatsapp-webhook` modified). 17 spec scenarios COMPLIANT, 110 / 110
tests green, `pnpm build` clean. WU 7 (CI workflow + `eslint-plugin-jest` `no-focused-tests`
guard) was **DEFERRED** to a follow-up slice per the pre-approved LoC cut (apply reported
~2,801 changed lines vs. ~950 hard cut). The deferral is **intentional, pre-approved, and
designed-in** — the lint rule and the CI workflow are COUPLED in the design (decision row
`forbidOnly`), and the design mandates deferring BOTH halves together so no half-wired rule
ships.

## What Was Delivered (WU 1 – 6)

| WU | Deliverable | Notes |
|----|-------------|-------|
| **WU 1** | LLM env config | 6 Joi fields: `AI_GATEWAY_API_KEY` + `LLM_MODEL` fail-fast; defaults `MAX_STEPS=3`, `HISTORY_TURNS=12`, `CEILING=8_000_000`, `IDLE=10_800_000` (3h). Surfaced as `appConfig.llm`. |
| **WU 2** | `ConversationStore` UPSERT + `AgentMessage` canonical | `update` no longer throws `NotFoundException` — auto-creates + merges. `ConversationState.data.messages` defaults `[]`, round-trips. `AgentMessage` declared once in `conversation-store.ts`; `llm-agent/domain/agent-message.ts` is a PURE `export type { … }` re-export (no drift). |
| **WU 3** | Domain ports + system prompt + placeholder tool | `LLM_AGENT` Symbol + `LlmAgentPort` / `LlmRunResult` (`usage: { promptTokens, completionTokens }`); `TOOL_REGISTRY` + `ToolRegistry.getTools()`. `SYSTEM_PROMPT` asserts literal `esa función aún no está disponible`, neutral professional Mexican Spanish, forbids voseo and regional slang. `getCurrentTime` placeholder via `ai.tool()` + `zod`. |
| **WU 4** | `VercelAiLlmAgent` + `CostGuard` + `GENERATE_TEXT` seam | `generateText` adapter maps `inputTokens` → `promptTokens`, `outputTokens` → `completionTokens` with mandatory `?? 0` (NaN-prevention for `CostGuard`'s sum). Forwards `stopWhen: stepCountIs(LLM_MAX_STEPS)`, `model: gateway(LLM_MODEL)`. `GENERATE_TEXT` Symbol = injectable SDK seam; tests inject a `jest.fn` (no live gateway calls). `CostGuard` emits exactly ONE `warn` log per threshold (≥80%, ≥100%); never throws. |
| **WU 5** | `AgentRunner` + module wiring | Load → idle-check (`now - lastMessageAt > idleMs ⇒ history = []`) → truncate to `historyTurns` IN MEMORY → `port.run(...)` → `costGuard.record(usage)` → UPSERT user + assistant → `{ reply }`. `LlmAgentModule` binds Symbols (`LLM_AGENT → VercelAiLlmAgent`, `TOOL_REGISTRY → InMemoryToolRegistry`, `GENERATE_TEXT → generateText`); exports `AgentRunner`. |
| **WU 6** | Dispatcher swap + integration | `WebhookDispatcherService` replaced `Echo: ${text}` with `runner.handle({ senderId, text })` → UPSERT user + assistant → `sender.sendText({ to, text: reply })`. `WhatsappModule` imports `LlmAgentModule`. `AppModule` registers `LlmAgentModule`. No proactive sends anywhere — keeps every outbound message inside the WhatsApp 24h free service window. |

**Side deliverables committed during apply**:
- `ai` SDK confined to `src/llm-agent/infrastructure/` (confinement fix `122e960`, verified by grep). All `from 'ai'` imports live under that subtree; `application/` and `domain/` only import the Symbol ports.

## Test & Build Results

```
$ pnpm build    → nest build → tsc → exit 0  (clean, no TS errors)
$ pnpm test     → Test Suites: 17 passed, 17 total
                   Tests:       110 passed, 110 total
                   Snapshots:   0 total
                   Time:        ~1.9 s
```

No live LLM / gateway calls — `GENERATE_TEXT` is the only network seam and is always mocked.
Test layer distribution: ~98 unit, ~12 Nest `TestingModule` integration, 0 E2E. Spec/assertion
quality vetted: no tautologies, no ghost loops, healthy mock/assertion ratios.

**Spec compliance**: 17 / 17 scenarios COMPLIANT (every requirement has a real,
behavior-asserting, passing test).
**Design conformance**: 9 / 9 decisions honored (incl. usage `?? 0`, canonical `AgentMessage`,
`GENERATE_TEXT` seam, defaults, Joi fail-fast, `ai` confined to infrastructure).
**Scope adherence**: NO real `chatbot-api` tools, NO DB persistence, `ChatbotApiClient`
untouched (verified via `git diff --stat`).

## DEFERRED — WU 7 (Planned Follow-Up Slice, Not a Defect)

The design COUPLES the two halves (lint guard and CI workflow) into one slice because shipping
the rule without the workflow that enforces it would leave the rule unguarded at CI level.
Both halves are deferred together per the design:

| # | Task | Status |
|---|------|--------|
| 7.1 | Add `eslint-plugin-jest` devDep in `package.json` | 🔲 DEFERRED |
| 7.2 | Wire `no-focused-tests` rule into `eslint.config.mjs` for `*.spec.ts` | 🔲 DEFERRED |
| 7.3 | Create `.github/workflows/ci.yml` (`pnpm install` → `pnpm test --ci` → `pnpm lint`) | 🔲 DEFERRED |

**Rationale recorded in `tasks.md`**: cumulative changed lines already at ~2,801 at end of WU 6
against an 800-line review budget / ~950 hard cut. The agent foundation (WU 1 – 6) stands alone
and is fully tested / fully functional without CI and without the `.only` lint guard; both
ship in a tiny follow-up slice so the foundation can be reviewed in a sensible chunk.

## Specs Synced → `openspec/specs/`

| Domain | Action | Details |
|--------|--------|---------|
| `llm-agent` | **Created** (new capability) | 7 ADDED requirements + 7 scenarios consolidated from the delta |
| `conversation-store` | **Modified** | Replaced `Manage conversation state by sender id` (UPSERT) + added the `Updating an unknown sender creates the record` scenario; added new requirement `Persist typed agent message history` (2 scenarios) |
| `whatsapp-webhook` | **Modified** | Replaced `Accept signed inbound events` body (echo → agent dispatch, added `Signed inbound text reaches agent dispatch` scenario); added new requirement `Dispatcher invokes the agent and persists the assistant turn` (2 scenarios). `Verify webhook challenge` preserved unchanged. |

The archived spec deltas under `openspec/changes/archive/2026-06-30-llm-agent-conversation-persistence/specs/`
are preserved as the AUDIT TRAIL for what changed in this slice.

## Archive Contents

- `proposal.md` ✅
- `design.md` ✅
- `specs/` ✅ (`conversation-store/`, `llm-agent/`, `whatsapp-webhook/`)
- `tasks.md` ✅ (21/21 WU 1–6 tasks complete; 3 WU 7 tasks documented as DEFERRED, not failures)
- `verify-report.md` ✅

## Source-of-Truth Updated

The following specs now reflect the new behavior end-to-end:
- `openspec/specs/llm-agent/spec.md` (NEW)
- `openspec/specs/conversation-store/spec.md` (UPSERT + AgentMessage)
- `openspec/specs/whatsapp-webhook/spec.md` (echo → agent dispatch)

## Risks

| Risk | Status |
|------|--------|
| Provider-lock via AI SDK shape | Mitigated: `LlmAgentPort` Symbol + model-string swap on Gateway = provider-agnostic |
| $200/mo soft ceiling breached | Mitigated: per-turn token counter + monthly aggregator + warn logs at 80% and 100%; soft-only by spec (no hard kill-switch in AI SDK) |
| In-memory history lost on process restart | Accepted for foundation; durable Postgres `ConversationStore` adapter is the immediate next chained slice (one-line module-binding swap) |
| Hallucination in foundation (no real tools yet) | Mitigated: hard system-prompt requirement + spec scenario + integration test asserting refusal phrase |

## Carried-Forward Follow-Ups (for the next session / slice)

### 1. WU 7 from THIS slice (CI + lint guard)
- `.github/workflows/ci.yml` (pnpm install + pnpm test on push/PR)
- `eslint-plugin-jest` `no-focused-tests` wired into the ESLint 9 flat config for `*.spec.ts`
- `jest --ci` for runtime `.only` rejection
- **Lint guard and CI are COUPLED — ship together.**

### 2. Deferred follow-ups from the PRIOR slice (`whatsapp-channel-foundation`) — NOT folded here
- PII redaction in `chatbot-api` client logging
- Distinct 4xx-other error class (400/409/422 currently collapse into `UpstreamError`)
- `multer` transitive advisory bump

### 3. Next program slices per the seed (`houndfe-chatbot`)
- **(a) Durable Postgres `ConversationStore` adapter + migration** — swap is a one-line module-binding change in `LlmAgentModule`. ~300–500 LoC.
- **(b) Real `chatbot-api` tools** — catalog / pricing / customer / sales tools registered in the existing `ToolRegistry` port. ~400–600 LoC.

### 4. Optional 1-line hardening from `verify-report.md`
- Dedicated end-to-end test asserting the refusal phrase `esa función aún no está disponible`
  is returned as the runner's `reply` (currently proven transitively via system-prompt verbatim
  passthrough).

### 5. Pre-live external prereqs (do not block code)
- Concrete `LLM_MODEL` value picked from the live AI Gateway list (cheap tier) — `design.md` open question.
- `AI_GATEWAY_API_KEY` provisioned.
- Still-pending go-live prereqs from the program seed (`AGENTS.md §7`): Meta WhatsApp number verification status, VPS 2 provisioning, `ServiceCredential` provisioning, dedicated bot cashier `User` record.

## SDD Cycle Complete

The change has been fully **planned (proposal + design)**, **implemented (WU 1–6 + 1 confinement fix)**, **verified (110 / 110 green, build clean, PASS WITH WARNINGS)**, and **archived (specs synced, change folder moved)**. Ready for the orchestrator to merge `feat/llm-agent-conversation-persistence` into `main` and start the next change.
