# Design: LLM Agent & Conversation Persistence

## Technical Approach

Replace the echo path with a real agent loop behind a Symbol port. The Vercel AI SDK
(`ai` + default `gateway` provider) lives ONLY in `src/llm-agent/infrastructure/`. An
`AgentRunner` (application) owns history load/truncate, idle-timeout, system prompt, the
cost guard, and persistence orchestration; it calls `LLM_AGENT` (port) which wraps
`generateText`. `WebhookDispatcherService` is reduced to: normalize → `runner.handle()` →
`sender.sendText()`. History truncation and idle logic stay in the runner; the store stays
a dumb upsert bag (`update` relaxed to UPSERT). The SDK is **injected** (a `GENERATE_TEXT`
function token) so tests run offline with a mock — no live gateway calls. Satisfies all
three spec deltas (`llm-agent`, `conversation-store`, `whatsapp-webhook`).

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Truncation location | In `AgentRunner` | In store | Spec: store keeps all turns, runner passes ≤ N. Store stays dumb. |
| SDK injection | Inject `generateText` via `GENERATE_TEXT` token | Import `ai` directly in adapter | Determinism: tests mock the function, no network. Keeps `ai` confined to infra. |
| `update` relax | UPSERT (auto-create, return merged) | Keep `NotFoundException` | Spec MODIFIED + lets dispatcher do one write path. Strict superset → revert-safe. |
| Cost guard | Process-local counter + warn logs | Hard kill-switch | AI SDK has no kill-switch; spec says soft only, never hard-fail. |
| Idle reset | Runner compares `Date.now()` vs stored `lastMessageAt` | Cron sweep | Reactive, no background task → respects "no proactive sends". |
| Model id | `LLM_MODEL` env, NOT hardcoded | Hardcode string | ai-sdk rule: model ids verified against live gateway list at apply/runtime. |
| `forbidOnly` | `eslint-plugin-jest` `no-focused-tests` + `jest --ci` in CI | Jest `forbidOnly` config key | **Jest has no `forbidOnly` option** (that is Playwright). The lint rule blocks `.only` from landing; `--ci` is the CI runtime guard. The proposal text still says "Jest `forbidOnly`" — that is superseded by this design; tasks MUST follow the design. The `.only` lint guard and the CI workflow are COUPLED: if the chained-cut defers `ci.yml`, defer the `eslint-plugin-jest` wiring with it (do not ship a half-wired lint rule). |
| `usage` mapping | Adapter maps SDK `inputTokens/outputTokens` → port `promptTokens/completionTokens`, defaulting `undefined → 0` | Pass SDK `usage` straight through | The installed `ai` `generateText` returns `usage: { inputTokens?, outputTokens?, totalTokens? }` (all `number \| undefined`). The port/spec contract is `{ promptTokens, completionTokens }`, so the adapter MUST translate. The `?? 0` default is mandatory: the cost guard SUMS these, and an `undefined` would make the aggregate `NaN`, silently breaking the 80%/100% threshold scenarios. |
| `AgentMessage` source | Single canonical declaration in `conversation-store.ts`; `llm-agent/domain/agent-message.ts` is a pure RE-EXPORT | Declare the union in both files | Two declarations invite drift. One source of truth, re-exported for ergonomic imports inside the llm-agent feature. |

## Data Flow

    webhook(POST) ─► WebhookController ─► WebhookDispatcherService
                                              │ normalize → InboundMessage[]
                                              ▼
                                         AgentRunner.handle({senderId,text})
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                                ▼                                ▼
       ConversationStore.get          idle-check + truncate(N)          ToolRegistry.getTools()
              │                                │                                │
              └──────────────► LLM_AGENT.run({history,text,systemPrompt,tools}) ◄┘
                                               │ generateText(+stopWhen, tools fire here)
                                               ▼
                                        CostGuard.record(usage)  → warn @80/100%
                                               ▼
                          ConversationStore.update (UPSERT: +user +assistant, lastMessageAt)
                                               ▼
                                  WhatsappSenderPort.sendText({to,reply})

## File Changes

| File | Action | Description |
|---|---|---|
| `src/llm-agent/domain/llm-agent.port.ts` | Create | `LLM_AGENT` Symbol; `LlmAgentPort.run` signature; `LlmRunResult`. |
| `src/llm-agent/domain/agent-message.ts` | Create | `AgentMessage` union (re-export shared shape used by store). |
| `src/llm-agent/domain/tool-registry.port.ts` | Create | `TOOL_REGISTRY` Symbol + `ToolRegistry.getTools()`. |
| `src/llm-agent/domain/system-prompt.ts` | Create | `SYSTEM_PROMPT` const (Mexican Spanish, no-hallucination, refusal phrase). |
| `src/llm-agent/application/agent-runner.service.ts` | Create | Load/truncate/idle/persist orchestration; `handle()`. |
| `src/llm-agent/application/cost-guard.service.ts` | Create | Per-turn counter + monthly aggregate + 80/100% warn. |
| `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` | Create | `generateText` adapter; only file importing `ai`. |
| `src/llm-agent/infrastructure/generate-text.provider.ts` | Create | Binds `GENERATE_TEXT` token to `ai`'s `generateText`. |
| `src/llm-agent/infrastructure/tools/placeholder-tools.ts` | Create | `getCurrentTime` (+ trivial `echoText`) via `tool()`+zod. |
| `src/llm-agent/infrastructure/in-memory-tool-registry.ts` | Create | Returns placeholder tool set. |
| `src/llm-agent/llm-agent.module.ts` | Create | Providers/exports/Symbol bindings. |
| `src/conversation/domain/conversation-store.ts` | Modify | Add `AgentMessage`; type `data.messages`; doc `update` = UPSERT. |
| `src/conversation/infrastructure/in-memory-conversation.store.ts` | Modify | `update` auto-creates, drop `NotFoundException`. |
| `src/whatsapp/application/webhook-dispatcher.service.ts` | Modify | Replace echo with `runner.handle()` + send. |
| `src/whatsapp/whatsapp.module.ts` | Modify | Import `LlmAgentModule`. |
| `src/app.module.ts` | Modify | Register `LlmAgentModule`. |
| `src/config/env.validation.ts` | Modify | Add 6 LLM env vars (Joi). |
| `src/config/configuration.ts` | Modify | Surface `llm` block. |
| `package.json` | Modify | Add `ai`, `zod`; add `eslint-plugin-jest`; `jest --ci` in CI. |
| `.github/workflows/ci.yml` | Create | pnpm install + pnpm test on push/PR. |

## Interfaces / Contracts

```ts
// domain/llm-agent.port.ts
export const LLM_AGENT = Symbol('LLM_AGENT');
export interface LlmRunResult {
  reply: string;
  messages: AgentMessage[];
  usage: { promptTokens: number; completionTokens: number };
}
export interface LlmAgentPort {
  run(input: {
    senderId: string;
    text: string;
    history: AgentMessage[];
    systemPrompt: string;
    tools: Record<string, unknown>; // AI SDK ToolSet; opaque to domain
  }): Promise<LlmRunResult>;
}

// domain/agent-message.ts  — PURE RE-EXPORT, do NOT re-declare the union
// Canonical declaration lives in src/conversation/domain/conversation-store.ts:
//   export type AgentMessage =
//     | { role: 'user'; content: string }
//     | { role: 'assistant'; content: string }
//     | { role: 'tool'; toolCallId: string; content: unknown };
export type { AgentMessage } from '../../conversation/domain/conversation-store';

// domain/tool-registry.port.ts
export const TOOL_REGISTRY = Symbol('TOOL_REGISTRY');
export interface ToolRegistry { getTools(): Record<string, unknown>; }

// infrastructure/generate-text.provider.ts — injectable SDK seam
export const GENERATE_TEXT = Symbol('GENERATE_TEXT');
// useValue: generateText  (real); tests override with a jest.fn
```

```ts
// infrastructure/tools/placeholder-tools.ts
import { tool } from 'ai';
import { z } from 'zod';
export const getCurrentTime = tool({
  description: 'Return the current server time (ISO 8601).',
  inputSchema: z.object({}),
  execute: async () => ({ now: new Date().toISOString() }),
});
```

```ts
// application/agent-runner.service.ts
@Injectable()
export class AgentRunner {
  async handle(input: { senderId: string; text: string }): Promise<{ reply: string }>;
  // 1 get state → 2 idle-check (Date.now()-lastMessageAt > idleMs ⇒ history=[])
  // 3 truncate to last historyTurns → 4 port.run(...) → 5 costGuard.record(usage)
  // 6 store.update(UPSERT: history+user+assistant, lastMessageAt=now) → return {reply}
}
```

```ts
// conversation-store.ts (modified) — update now UPSERT
update(senderId, patch): Promise<ConversationState>; // creates if missing, returns merged
// ConversationState.data typed bag: { messages?: AgentMessage[]; [k: string]: unknown }
// readMessages(state) helper defaults missing field → []
```

VercelAiLlmAgent maps `history`→AI SDK messages, calls
`generateText({ model: gateway(LLM_MODEL), system, messages, tools, stopWhen: stepCountIs(LLM_MAX_STEPS) })`,
then returns `{ reply: result.text, messages: <assembled>, usage: { promptTokens, completionTokens } }`.

**`usage` mapping (RESOLVED — mandatory, not an open question):** the installed `ai`
`generateText` result exposes `usage: { inputTokens?, outputTokens?, totalTokens? }`, all
`number | undefined`. The adapter MUST translate to the port contract with a zero default:
```ts
const usage = {
  promptTokens: result.usage?.inputTokens ?? 0,
  completionTokens: result.usage?.outputTokens ?? 0,
};
```
The `?? 0` is REQUIRED: `CostGuard` sums these into a running aggregate; an `undefined`
would propagate to `NaN` and silently defeat the 80%/100% threshold scenarios. The adapter
unit test MUST cover the `undefined`-usage path (asserts `0`, aggregate stays numeric).
**Apply-time check**: re-confirm the field names against the PINNED installed `ai` version
(`node_modules/ai/`) after `pnpm add ai zod`, since the shape has changed across majors.
Model id resolved from the live gateway list, not memory.

## Config Additions

| Env | Joi | Default | Surfaces as |
|---|---|---|---|
| `AI_GATEWAY_API_KEY` | `string().required()` | — (fail-fast) | `llm.gatewayApiKey` |
| `LLM_MODEL` | `string().required()` | — (fail-fast) | `llm.model` |
| `LLM_MAX_STEPS` | `number().integer().min(1).default(3)` | 3 | `llm.maxSteps` |
| `LLM_HISTORY_TURNS` | `number().integer().min(1).default(12)` | 12 | `llm.historyTurns` |
| `LLM_MONTHLY_TOKEN_CEILING` | `number().integer().min(1).default(8_000_000)` | 8M | `llm.monthlyTokenCeiling` |
| `LLM_IDLE_TIMEOUT_MS` | `number().integer().min(1).default(10_800_000)` | 3h | `llm.idleTimeoutMs` |

**`LLM_IDLE_TIMEOUT_MS` default = 10_800_000 ms (3 hours).** Justification: a HoundFe
purchase conversation (browse → cart → address → receipt) realistically spans up to a
couple of hours with human reply gaps; 3h keeps that single session coherent without
bleeding stale cart context into an unrelated next-day chat. It sits well under WhatsApp's
24h free service window (so context resets long before billing windows matter) yet far
above a too-aggressive few-minutes reset that would forget mid-purchase. Defaults:
`MAX_STEPS=3` (enough for one tool round-trip + final answer, caps runaway loops),
`HISTORY_TURNS=12` (~6 exchanges — enough memory, bounded prompt cost),
`CEILING=8M tokens/mo` (soft proxy for the ~$200 ceiling on a cheap tier; tune at apply).

## Module Wiring

`LlmAgentModule` imports `ConfigModule`, `ConversationModule`. Providers: `AgentRunner`,
`CostGuard`, `{ provide: LLM_AGENT, useClass: VercelAiLlmAgent }`,
`{ provide: TOOL_REGISTRY, useClass: InMemoryToolRegistry }`,
`{ provide: GENERATE_TEXT, useValue: generateText }`. Exports: `AgentRunner`.
`WhatsappModule` imports `LlmAgentModule` (injects `AgentRunner` into the dispatcher).
`AppModule` registers `LlmAgentModule`. Token flow: dispatcher → `AgentRunner` →
`LLM_AGENT` + `TOOL_REGISTRY` + `CONVERSATION_STORE` + config; `VercelAiLlmAgent` →
`GENERATE_TEXT` + `llm.model/maxSteps`.

## Sequence (inbound text)

1. Controller verifies signature → `dispatcher.dispatch(event)`.
2. Dispatcher normalizes → for each text msg calls `runner.handle({senderId,text})`.
3. Runner: `store.get` → idle-check (reset history if expired) → truncate to N turns.
4. `LLM_AGENT.run({history,text,systemPrompt,tools})` → `generateText` (**tools fire here** inside the SDK step loop, capped by `stopWhen`).
5. `costGuard.record(usage)` → warn at 80%/100%.
6. `store.update` (UPSERT) appends user + assistant, sets `lastMessageAt=now`.
7. Dispatcher `sender.sendText({to:senderId,text:reply})`. No proactive sends anywhere.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | adapter usage map + `undefined`→0 + `stopWhen` forwarding | mock `GENERATE_TEXT` jest.fn; assert `stopWhen` via call-args shape (closure, not deep-equal); assert `usage` maps `inputTokens/outputTokens`→`promptTokens/completionTokens` AND that absent fields default to `0` |
| Unit | runner truncate/idle/persist | mock `LLM_AGENT`, real in-memory store |
| Unit | cost guard 80/100% | spy `Logger.warn`, drive aggregate |
| Unit | tool registry returns `getCurrentTime` | direct |
| Unit | store UPSERT + messages default `[]` | direct on in-memory store |
| Unit | system prompt contract | assert literal phrase + Spanish + no-voseo |
| Integration | dispatcher swap | Nest TestingModule, mocked `LLM_AGENT`/sender |
| Boot | Joi fail-fast missing key/model | `AppConfigModule.forRoot()` with unset env |

Test files: `vercel-ai-llm-agent.spec.ts`, `agent-runner.service.spec.ts`,
`cost-guard.service.spec.ts`, `in-memory-tool-registry.spec.ts`, `system-prompt.spec.ts`,
modified `in-memory-conversation.store.spec.ts`, rewritten `webhook-dispatcher.service.spec.ts`,
`env.validation.spec.ts` additions. **No live LLM/gateway calls** — `GENERATE_TEXT` is the
only network seam and is always mocked.

## Migration / Rollout

No data migration (in-memory, additive). `messages` defaults to `[]`; `update` UPSERT is a
strict superset of the prior throw. Fully revert-safe per the proposal rollback plan.

## Sizing / Chained Cut

Forecast **~880 LoC** (code+tests), at the edge of the 800 budget. If apply exceeds ~950,
take the proposal's pre-approved cut: defer `.github/workflows/ci.yml` + the idle-reset-path
test to a tiny follow-up slice. The agent foundation stands alone without them.

## Open Questions

- [x] ~~Confirm `ai` `usage` field names~~ — RESOLVED: SDK exposes `inputTokens/outputTokens` (optional); adapter maps to `promptTokens/completionTokens` with `?? 0`. See Interfaces section + adapter test. Re-confirm against pinned version at apply.
- [ ] Confirm concrete `LLM_MODEL` value against live gateway list (cheap tier) before live traffic.
