# Human-Handoff — Apply Progress

> Spec: `openspec/changes/human-handoff/specs/**` + `tasks.md` (63 tasks).
> Mode: strict TDD (`pnpm test`, RED → GREEN evidence captured per task).
> Branch: `feat/human-handoff`. Delivery: 3 commits + single PR.

---

## Commit 1 — Foundation: handoff channel (Phases 1–3) ✅

### Completed tasks

| ID | Task | Status | Notes |
|---|---|---|---|
| T1.2 | `human-handoff.types.ts` (4 kinds, 5-member resolution union, request lifecycle) | ✅ | RED spec: `human-handoff.types.spec.ts` |
| T1.4 | `human-handoff-store.port.ts` (Symbol + CRUD port) | ✅ | API matches design.md §a verbatim |
| T1.6 | `postgres-human-handoff.store.ts` (4 CRUD methods + JSONB round-trip) | ✅ | spec `postgres-human-handoff.store.spec.ts` covers findByRef/findById/findLatestPendingForAgent/resolve |
| T1.8 | `migrations/1900000000000_human_handoff_requests.js` (table + index) | ✅ | mirrors the convention of `migrations/1700000000000_*` and `migrations/1800000000000_*` byte-identically |
| T2.2 | `pending-human-request-persistence.ts` (set/clear/read pure helpers) | ✅ | spec covers all four scenarios |
| T2.4 | `human-handoff.service.ts` (create / resolveReply / isOpsSender) | ✅ | UNDER_REVIEW_NOTICE + PENDING_HUMAN_REQUEST_REPLY + ASK_FOR_REF literals exported byte-identical |
| T2.6 | `request-human-assistance.tool.ts` (12th tool, discriminated union rejects shipping_approval) | ✅ | inputSchema has 3 active kinds (out_of_stock / needs_human_review / expiration_date) |
| T2.8 | `tool-deps.ts` adds `humanHandoffService: HumanHandoffService` | ✅ | |
| T2.10 | `real-tool-registry.ts` 11 → 12 tools + HUMAN_HANDOFF_SERVICE_TOKEN injection | ✅ | HUD-OFF comment ("eleven sale-flow tools" → "twelve sale-flow tools") updated |
| T2.12 | `tool-contract.spec.ts` (12 factories) | ✅ | deps stub carries `humanHandoffService` |
| T3.2 | `env.validation.ts` adds `HUMAN_HANDOFF_ENABLED` + `OPS_CHANNEL_PHONE` + conditional-required | ✅ | spec covers a–g scenarios |
| T3.4 | `configuration.ts` exposes `humanHandoff: { enabled, opsChannelPhone }` | ✅ | normalizeSandboxRecipient at boot |
| T3.6 | `human-handoff.module.ts` + `whatsapp-sender.module.ts` + `whatsapp.module.ts` wiring + `app.module.ts` import | ✅ | ADR-30: leaf sender module breaks the cycle |
| T3.9 | `docs/operations-human-handoff.md` runbook | ✅ | ops-on shift pattern, behaviour rollback, code rollback, open follow-ups |

### Files changed

```
M src/config/configuration.ts
M src/config/env.validation.ts
M src/config/env.validation.spec.ts
M src/config/config.module.spec.ts                 (added OPS_CHANNEL_PHONE to VALID_ENV fixture)
M src/conversation/conversation.module.spec.ts     (added OPS_CHANNEL_PHONE to fixture)
M src/sale-flow/sale-flow.module.spec.ts           (added OPS_CHANNEL_PHONE to fixture)
M src/sale-flow/application/tool-deps.ts           (added humanHandoffService field)
M src/sale-flow/application/tools/tool-contract.spec.ts  (12 factories)
M src/sale-flow/infrastructure/real-tool-registry.ts    (12 tools)
M src/sale-flow/infrastructure/real-tool-registry.spec.ts
M src/llm-agent/llm-agent.module.spec.ts           (added OPS_CHANNEL_PHONE to fixture)
M src/database/database.module.spec.ts             (added OPS_CHANNEL_PHONE to fixture)
M src/whatsapp/whatsapp.module.ts                  (imports WhatsappSenderModule + HumanHandoffModule)

A migrations/1900000000000_human_handoff_requests.js
A docs/operations-human-handoff.md
A src/human-handoff/**                              (5 prod files, 4 spec files)
A src/sale-flow/application/tools/request-human-assistance.tool.ts + spec
A src/whatsapp/whatsapp-sender.module.ts
```

### Verification

- `pnpm test` — **green** (47 of 50 suites; 3 are integration-gated;
  393 tests pass, 26 skipped, 0 failures).
- `pnpm build` — pending (Commit 2/3 first).
- The 5 module specs that were failing (`conversation`, `config`, `sale-flow`,
  `llm-agent`, `database`) now have `OPS_CHANNEL_PHONE` set in their
  `VALID_ENV` / `MANAGED_KEYS` fixtures.

### Module graph after Commit 1

```
AppModule
├── AppConfigModule
├── DatabaseModule
├── ConversationModule
├── LlmAgentModule
│   ├── ToolRegistry → RealToolRegistry (12 tools)
│   │   └── deps: chatbotApi, store, cashierUserId, humanHandoffService
│   │   └── 12th: requestHumanAssistance → humanHandoffService.create
├── ChatbotApiModule
├── SaleFlowModule
│   └── RealToolRegistry injected with HUMAN_HANDOFF_SERVICE_TOKEN
├── WhatsappSenderModule                          (NEW — leaf, ADR-30)
│   └── WHATSAPP_SENDER → MetaWhatsappSender
├── HumanHandoffModule                            (NEW)
│   ├── HUMAN_HANDOFF_STORE → PostgresHumanHandoffStore
│   ├── HumanHandoffService                        (uses ConversationStore, WhatsappSender, ConfigService)
│   ├── HUMAN_HANDOFF_SERVICE_TOKEN → useExisting: HumanHandoffService
└── WhatsappModule
    ├── WebhookDispatcherService                   (Commit 2 wires HumanHandoffService)
    ├── RECENT_OUTBOUND
    ├── WEBHOOK_DEDUP
    ├── SignatureGuard
    ├── re-exports SignatureGuard, WebhookDispatcherService
    └── imports: ConversationModule, LlmAgentModule, DatabaseModule, HumanHandoffModule, WhatsappSenderModule
```

### Deviations from design

None. The persisted-task checkboxes are updated inline as commits land.

---

## Commit 2 — Routing: pending-marker + dispatcher pre-routing hook (Phases 4–5) ✅

### Completed tasks

| ID | Task | Status | TDD evidence |
|---|---|---|---|
| T4.1–T4.4 | `ConversationStateData.pendingHumanRequest` + `PendingHumanRequest` type + `readPendingHumanRequest` pure helper (+ `conversation-store.spec.ts`) | ✅ | RED: helper absent + field missing (type + runtime); GREEN: `pnpm exec jest src/conversation/domain/conversation-store.spec.ts` passes |
| T4.5–T4.6 | `AgentRunner` short-circuit (ADR-29) + fresh-state spread (ADR-28) + idle-reset marker preservation | ✅ | RED: new first-contact regression test failed (`store.update` not called when post-run re-fetch returns null); GREEN: runner spec 14/14 + e2e green (see below) |
| T4.7–T4.8 | `toolsContext.requestHumanAssistance.senderId` in `vercel-ai-llm-agent.ts` | ✅ | runner-level tool spec validates `options.context.senderId` |
| T5.1–T5.2 | `WebhookMetadataDto` + `WebhookValueDto.metadata` + `InboundMessage.receivingPhoneNumberId` | ✅ | RED: normalizer tests failed (`normalizeInboundMessages is not a function` — export + interface field absent); GREEN: dispatcher spec 11/11 |
| T5.3–T5.4 | Ops pre-routing hook + pending-marker short-circuit + synthetic-turn injection | ✅ | dispatcher spec covers 8 scenarios; RED/GREEN per scenario set |
| T5.5–T5.6 | `WhatsappModule` imports `HumanHandoffModule` | ✅ | `pnpm build` + full suite green |

### Deviation fixed during apply (first-contact ADR-28 regression)

The staged runner skipped the persist whenever the post-`run` `get` returned `null`. With a real store (e2e `InMemoryConversationStore`), first contact returns `null` for both reads → the transcript was never persisted (violates "assistant turn is persisted after a successful run"). Fix: treat post-run `null` as a race ONLY when the pre-run state existed (`state !== null`); first contact falls back to `data: { messages: nextTurns }` (UPSERT creates the record). RED captured in `agent-runner.service.spec.ts` (new test), GREEN after the fix; `pnpm test:e2e` 2/2 green.

## Commit 3 — Triggers: R7 / promo-review envelopes + prompt step 16 (Phase 6) ✅

### Completed tasks

| ID | Task | Status | TDD evidence |
|---|---|---|---|
| T6.1–T6.2 | `checkStock` `humanAssistance` envelope on `out_of_stock` (name from input or catalog response; signal-only) | ✅ | RED: 2 envelope tests failed; GREEN: check-stock spec 8/8 |
| T6.3–T6.4 | `evaluateCart` `humanAssistance` envelope on `needs_human_review` (digest items at list price; signal-only) | ✅ | RED: envelope test failed; GREEN: evaluate-cart spec 11/11 (with check-stock 19/19 combined) |
| T6.5–T6.6 | `SALE_FLOW_INSTRUCTIONS` step 16 (R14) + step 5 R7 rule + step 8 `needs_human_review` rule + awaiting-human posture; byte-identical preserved strings | ✅ | RED: 6 prompt-contract tests failed; GREEN: instructions spec 17/17 |

### Spec discrepancy (design intent implemented — flagged per apply contract)

- `evaluateCart` digest: the delta scenario shows `originalTotalCents` in the digest, but the real `CartEvaluationResult` DTO (`src/chatbot-api/domain/dtos/pricing.dto.ts`) has NO top-level totals. The delta marks `originalTotalCents?` / `recomputedTotalCents?` optional; the implementation omits them (the list-price lines are the review payload). No value is invented.
- `checkStock` digest shape: the delta's illustrative `stock: { status, quantity }` nesting does not match the real `StockCheckResponse` (`stock.stock.status`); the envelope is added to the EXISTING real payload byte-identically.
- Prompt byte-identical list: the delta lists `PROMO_RE_QUOTE`; the prompt's actual pre-existing literal is the error-kind `promoReQuote` (backend code is `PROMO_RE_QUOTE`). The prompt was NOT edited to add the code form; the existing literal is preserved.

## Final verification gates (all on branch `feat/human-handoff`, full working tree)

| Gate | Command | Result |
|---|---|---|
| Unit + integration | `pnpm test` | **green — 426 passed, 26 skipped, 48 suites (0 failures)** |
| e2e | `pnpm test:e2e` | **green — 2/2 passed** |
| Build | `pnpm build` | **clean (`nest build`)** |
| Coverage | `pnpm test:cov` | **All files: 87.69% statements / 78.70% branches / 85.08% functions / 87.61% lines (≥80% overall ✓)** — note: Postgres adapters (`postgres-human-handoff.store.ts` 23.8% lines, `postgres-conversation.store.ts` 25%) are DB-gated (Testcontainers specs skipped without Docker) |
| Scoped lint | `pnpm exec eslint src/human-handoff src/whatsapp src/llm-agent src/sale-flow src/conversation src/config` | **217 errors / 4 warnings — ALL pre-existing or slice-authored-before-this-apply patterns (prettier formatting of legacy spec idioms, `no-unnecessary-type-assertion`, `no-unsafe-*`, `unbound-method`); 11+ errors reproduce on untouched-at-HEAD files. Files authored/edited in this apply are lint-clean. Per tasks.md T7.5 this is known-broken pre-existing debt, out of slice scope.** |
| Migration | `pnpm migrate` | **NOT RUN** — no live Postgres/Docker in the apply environment (T7.4); file verified structurally (T1.7/T1.8) |

## Commit log

1. `feat(human-handoff): foundation channel — module, migration, service, 12th tool, config` (src/human-handoff/**, migration, src/config/*, database.module.spec, request-human-assistance tool, tool-deps, real-tool-registry, sale-flow.module, tool-spec stubs, llm-agent.module.spec, docs runbook, openspec artifacts). **Includes `src/whatsapp/whatsapp-sender.module.ts` + `src/conversation/conversation.module.spec.ts` + `test/echo.e2e-spec.ts` fixture fix** — deviating from the parent's commit-2 placement because `HumanHandoffModule`/`SaleFlowModule` (commit-1 files) import `WhatsappSenderModule` and the commit-1 env-validation change requires the `OPS_CHANNEL_PHONE` fixture; without them commit 1 cannot compile/pass (tasks.md T3.6/T8.1 and the earlier apply-progress also place these in Commit 1).
2. `feat(whatsapp): ops reply routing, pending-marker short-circuit, fresh-state spread` (whatsapp-sender wiring, whatsapp.module, webhook-dispatcher.service.*, webhook-event.dto.ts, inbound-message.ts, agent-runner.service.*, vercel-ai-llm-agent.*, conversation-store.ts + spec, pending-human-request-persistence.ts canonical move).
3. `feat(sale-flow): human-handoff triggers (R7, promo review, R14) + prompt step 16` (check-stock.tool.*, evaluate-cart.tool.*, sale-flow-instructions.ts + spec).

Commit SHAs are recorded in the apply-phase handoff (this file cannot reference commit 1's SHA before commit 1 exists; the log above lists messages + scope).
