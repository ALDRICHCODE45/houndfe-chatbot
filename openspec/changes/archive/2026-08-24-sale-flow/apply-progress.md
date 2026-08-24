# Apply Progress — sale-flow

**Change**: `sale-flow`
**Mode**: Strict TDD (`openspec/config.yaml` `testing.strict_tdd: true`, `rules.apply.tdd: true`)
**Status**: Implementation complete — all 44 implementation tasks done, full suite green.
**Note**: Persisted post-hoc by the orchestrator because the `sdd-apply` subagent timed out at 20 min during T7 before writing this artifact; the verify phase independently confirmed every task's code and tests exist and pass (see `verify-report.md`).

---

## TDD Cycle Evidence

Every row: RED (failing spec written first) → GREEN (implementation) → refactor where applicable.
"RED verified" means the spec was written against a not-yet-existing module and the focused
run failed before implementation, per the repo convention.

| Cycle | RED (test written first) | GREEN (implementation) | Evidence |
|---|---|---|---|
| Config env | `env.validation.spec.ts` (absent + non-UUID cases) | `env.validation.ts` `CHATBOT_API_CASHIER_USER_ID: Joi.string().uuid().required()` | `config.env.validation.spec.ts` green |
| Config surface | `configuration.spec.ts` (`MANAGED_KEYS` + `chatbotApi.cashierUserId`) | `configuration.ts` `cashierUserId` in `chatbotApi` block | `config.configuration.spec.ts` green |
| Cart domain | `cart-state.spec.ts` (missing→empty, shallow-merge) | `cart-state.ts` (`CartItem`/`CartState`/`EMPTY_CART`/`readCart`/`writeCart`) | `sale-flow/domain/cart-state.spec.ts` green |
| Prompt composition | `sale-flow-instructions.spec.ts` (base+'\n\n'+slice, 4 contract strings, bank block) | `sale-flow-instructions.ts` (`SALE_FLOW_INSTRUCTIONS` + `composeSaleFlowSystemPrompt` + `renderBankDetailsBlock`) | `sale-flow/domain/sale-flow-instructions.spec.ts` green |
| Bank seam | `null-bank-details.provider.spec.ts` (`get()` → null) | `bank-details.provider.ts` (port + `BANK_DETAILS_PROVIDER`) + `null-bank-details.provider.ts` | `sale-flow/infrastructure/null-bank-details.provider.spec.ts` green |
| Tool result types | (types-only, no behaviour) | `tool-result.ts` (`ToolErrorKind`/`ToolErrorResult`/`ToolSuccess`/`ToolResult`) | compile via `pnpm build` |
| Error mapping | `error-mapping.spec.ts` (all classes → exact `{kind,retryable}`; 4xx→validation; rethrow) | `error-mapping.ts` (`mapChatbotError` pinned mapping) | `sale-flow/application/error-mapping.spec.ts` green |
| Cart persistence | `cart-persistence.spec.ts` (whole-object `data` replace, `lastMessageAt` preserved) | `cart-persistence.ts` (`persistCart`) | `sale-flow/application/cart-persistence.spec.ts` green |
| Tool deps | (types-only, no behaviour) | `tool-deps.ts` (`ToolDeps`) | compile via `pnpm build` |
| Tool contract | `tool-contract.spec.ts` (9 factories → description/Zod/execute; malformed rejected) | nine factories in `application/tools/*.tool.ts` | `tool-contract.spec.ts` green (T4.12) |
| searchCatalog | `search-catalog.tool.spec.ts` (q/limit mapping, default 10, upstream envelope) | `search-catalog.tool.ts` | spec green |
| checkStock | `check-stock.tool.spec.ts` (uuid productId, notFound envelope) | `check-stock.tool.ts` | spec green |
| evaluateCart | `evaluate-cart.tool.spec.ts` (persists originalPriceCents, keeps key, contextSchema) | `evaluate-cart.tool.ts` | spec green |
| getCustomerByPhone | `get-customer-by-phone.tool.spec.ts` (cc/phone mapping, envelopes) | `get-customer-by-phone.tool.ts` | spec green |
| upsertCustomer | `upsert-customer.tool.spec.ts` (full DTO, missing street rejected) | `upsert-customer.tool.ts` | spec green |
| createSale | `create-sale.tool.spec.ts` (empty-cart guard, UUID v4 idempotency persist/reuse/clear, list-price, cashier inject) | `create-sale.tool.ts` | spec green |
| attachReceipt | `attach-receipt.tool.spec.ts` (url/int validations, envelopes) | `attach-receipt.tool.ts` | spec green |
| updateDelivery | `update-delivery.tool.spec.ts` (registered only) | `update-delivery.tool.ts` | spec green |
| getOrderHistory | `get-order-history.tool.spec.ts` (phone/cc mapping) | `get-order-history.tool.ts` | spec green |
| RealToolRegistry | `real-tool-registry.spec.ts` (exactly 9 keys, Zod schemas, DI) | `real-tool-registry.ts` | spec green |
| SaleFlowModule | `sale-flow.module.spec.ts` (resolves/exports registry + null provider) | `sale-flow.module.ts` | spec green |
| toolsContext | `vercel-ai-llm-agent.spec.ts` (generateText receives `toolsContext` senderId) | `vercel-ai-llm-agent.ts` forwards `toolsContext` | spec green |
| Module wiring | `llm-agent.module.spec.ts` (`TOOL_REGISTRY`→`RealToolRegistry`, 9 keys, imports, composed prompt, override) | `llm-agent.module.ts` (imports `ChatbotApiModule`+`SaleFlowModule`, `useExisting`, `LLM_AGENT_SYSTEM_PROMPT` async factory) + `system-prompt.ts` (`LLM_AGENT_SYSTEM_PROMPT` symbol) | spec green |
| Runner prompt | `agent-runner.service.spec.ts` (sentinel composed prompt, no runtime override) | `agent-runner.service.ts` injects `LLM_AGENT_SYSTEM_PROMPT` | spec green |

## Full-suite verification (T8)

| Check | Result |
|---|---|
| `pnpm test` | PASS — 40 suites / 259 tests / 16 skipped (Postgres/Testcontainers) |
| `pnpm test:cov` | PASS — global 89.38% stmts / 89.4% lines; `src/sale-flow` 100%, `src/config` 100%, changed `src/llm-agent` ≥80% |
| `pnpm build` | PASS — clean `nest build` |
| Scoped lint `pnpm exec eslint src/sale-flow src/llm-agent src/config` | 7 pre-existing errors in `llm-agent` (documented repo-wide-broken baseline); 0 new from this slice; `src/sale-flow` + `src/config` 0 errors |
| Consumer-only + no-migration | `git diff --stat` shows zero production changes under `src/chatbot-api/**`, `src/conversation/**`, `src/app.module.ts`; `in-memory-tool-registry.ts` untouched (fixture) |

## Task checkboxes

All 44 implementation-owned tasks (`T1.1`–`T8.5`) are marked `- [x]` in `tasks.md`.
Both parent-owned lifecycle rows are marked `- [x]`: the follow-up-backlog gate was
confirmed (4 Engram observations 3927–3930), and the bounded-review gate was accepted by
the user as deferred to delivery (single-PR with `size-exception`, two-commit split;
rollback path verified in verify-report.md). This slice never starts a review actor per
sdd-orchestrator-workflow "SDD completion adds no review pass".
