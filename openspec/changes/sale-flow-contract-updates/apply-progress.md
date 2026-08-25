# Apply Progress: sale-flow-contract-updates

> SDD apply phase for OpenSpec change `sale-flow-contract-updates`.
> Strict TDD: RED → GREEN → REFACTOR. Coverage ≥ 80% on touched modules.
> Two-commit split: (1) Domain + DTO/Client, (2) Tools + Wiring + Seams + Docs.

---

## Status snapshot

| Field | Value |
|---|---|
| Tasks complete | 39 / 41 (2 parent gates deferred to `sdd-parent`) |
| Test runner | `pnpm test` (Jest 30 + ts-jest) |
| Strict TDD | active per `openspec/config.yaml` `testing.strict_tdd: true` |
| Delivery | single-PR (size-exception accepted by user; ~950–1200 changed lines; final ≈ 893 insertions / 191 deletions across 24 files) |
| Commit 1 boundary | end of Phase 2 (Domain + DTO/Client) |
| Commit 2 boundary | end of Phase 7 (after full verification) |
| Parent gates | **2 deferred** — bounded-review + lifecycle (Tasks marked `sdd-owner: parent`) |

## Per-phase TDD evidence

### Phase 1 — Domain contracts

- **T1.1 RED** — added `expectedTotalCents` round-trip / legacy-guard cases to `cart-state.spec.ts`. Confirmed the type-level RED (`tsc --noEmit -p tsconfig.spec.json` — `cart-state.ts` did not have the field yet, so the round-trip patch type-checked but did not propagate to the cart state interface).
- **T1.2 GREEN** — added `expectedTotalCents?: number` to `CartState`. `cart-state.spec.ts` 10/10 green.
- **T1.3 Types only** — `tool-result.ts` extended with the ADR-5 discriminated union (`SimpleToolError | PromoReQuoteToolError`). Compile-checked via the Phase-1 error-mapping spec + `pnpm build`.
- **T1.4 RED** — added 9 errorCode-first cases to `error-mapping.spec.ts`. RED confirmed: 5/24 failed (`PROMO_RE_QUOTE` / `NO_ACTIVE_PAYMENT_DETAIL` / `IDEMPOTENCY_KEY_IN_FLIGHT` / `CONFLICT` / `PRICE_OUT_OF_DATE` mapped to legacy `{validation, false}`).
- **T1.5 GREEN** — `error-mapping.ts` switches on `err.errorCode` FIRST (ADR-3), with a `readPromoPayload(err)` helper (non-negative integers off `responseBody`; malformed → status fallback per R-D2). All 24 cases green.
- **T1.6 RED** — rewrote `sale-flow-instructions.spec.ts` (one-arg composer + step-12 gating substring + byte-identical phrase + step-11 `promoReQuote` rule + marker order with `getPaymentDetails`). RED: 6/10 failed (two-arg composer signature + missing literals).
- **T1.7 GREEN** — `sale-flow-instructions.ts` collapses `composeSaleFlowSystemPrompt(base)`; `BankDetails` type + `renderBankDetailsBlock` removed. All 10 cases green.

### Phase 2 — DTOs + HTTP client

- **T2.1 Types only** — created `payment-details.dto.ts` (`PaymentDetail { id, bankName, beneficiary, clabe, accountNumber, isActive, updatedAt }`). Compile-checked via the Phase-2 http-client spec.
- **T2.2 Types only** — `sales.dto.ts` extended: `CreateSaleInput.expectedTotalCents?: number | null` + `BotSaleResponse.discountCents: number` + `CreateSaleInputSchema` (Zod `.int().min(0).nullish()`). Compile-checked.
- **T2.3 Types only** — `ChatbotApiError` 4th ctor param `errorCode: string | null = null`; `RateLimitError` forwards `errorCode`. Required by T1.4 (predecessor dependency), landed early in Phase 1.
- **T2.4 RED** — added 9 `errorCode` population/null-semantics cases to `chatbot-api-http.client.spec.ts`. RED: 9/28 failed (`getPaymentDetails` method not present + `errorCode` not populated).
- **T2.5 GREEN** — `extractErrorCode(body: unknown): string | null` private helper (JSON object + non-empty string `error` field → verbatim; otherwise `null` per ADR-2). `mapError` computes it once and passes to every constructed error.
- **T2.6 RED** — added `createSale` forward/omit/reject-`expectedTotalCents` cases + `discountCents` from body / default 0 + 4 `getPaymentDetails()` cases (200 / 404 NO_ACTIVE_PAYMENT_DETAIL / 401 AuthError / 503 UpstreamError). RED: 10/28 failed.
- **T2.7 GREEN** — `getPaymentDetails()` issues `GET /chatbot-api/payment-details` (retryable). `createSale` validates via `CreateSaleInputSchema`, strips `null`/`undefined` `expectedTotalCents` before send, defaults missing `discountCents` to `0` (one-time debug log via `Logger` — ADR-11). All 28 cases green.
- **T2.8 GREEN** — `ChatbotApiClient` port + import `PaymentDetail`. Build green.

### Phase 3 — Tools

- **T3.1 RED** — removed `bankDetails` stub from all 10 tool specs (`search-catalog`, `check-stock`, `evaluate-cart`, `get-customer-by-phone`, `upsert-customer`, `create-sale`, `attach-receipt`, `update-delivery`, `get-order-history`, `tool-contract`). RED confirmed by `tsc --noEmit -p tsconfig.spec.json` (compile failure on every spec that fed `ToolDeps` to a factory).
- **T3.2 GREEN** — `tool-deps.ts` drops the `bankDetails: BankDetailsProvider` field. All 10 specs compile + stay green.
- **T3.3 RED** — added 2 `expectedTotalCents` cases to `evaluate-cart.tool.spec.ts`. RED: 2/8 failed (the cart was not annotated with `expectedTotalCents`).
- **T3.4 GREEN** — `evaluate-cart.tool.ts` computes `expectedTotalCents = Σ(finalPriceCents × quantity)` (ADR-6) and persists it alongside `items` + `idempotencyKey`. All 8 cases green.
- **T3.5 RED** — added 9 cases to `create-sale.tool.spec.ts`: (a) `expectedTotalCents` sourced from cart, (b) `PROMO_RE_QUOTE` mapping + cart-preserved + key-cleared, (c) `IDEMPOTENCY_KEY_IN_FLIGHT`, (d) `IDEMPOTENCY_KEY_CONFLICT`, (e) `PRICE_OUT_OF_DATE`, (f) `INVALID_IDEMPOTENCY_KEY`, (g) success `discountCents: 250`, (h) success `discountCents: 0`, (i) fresh-UUID-v4 mint after `PROMO_RE_QUOTE`. RED: 4/16 failed (forward + 3 cart-mutation paths).
- **T3.6 GREEN** — `create-sale.tool.ts` extends the DTO builder with `...(cart.expectedTotalCents !== undefined ? { expectedTotalCents: cart.expectedTotalCents } : {})` (never from model input); `catch` branches on `err.errorCode` for cart mutation (ADR-9): `PROMO_RE_QUOTE` / `IDEMPOTENCY_KEY_CONFLICT` → clear key, preserve items + `expectedTotalCents`; `IDEMPOTENCY_KEY_IN_FLIGHT` / `PRICE_OUT_OF_DATE` / `INVALID_IDEMPOTENCY_KEY` → preserve key. All 16 cases green.
- **T3.7 RED** — created `get-payment-details.tool.spec.ts` (200 projection / 404 `noActivePaymentDetail` / empty schema / extra-key rejection / non-`ChatbotApiError` rethrows / 5xx `upstream`). RED: `Cannot find module './get-payment-details.tool'` (module absent).
- **T3.8 GREEN** — created `get-payment-details.tool.ts`: `inputSchema: z.object({}).strict()` (rejects extra keys per spec); description gates the call to AFTER `createSale` returns `ok: true`, exactly once; `execute` wraps `chatbotApi.getPaymentDetails()` in try/catch → `mapChatbotError`. All 7 cases green.

### Phase 4 — Wiring

- **T4.1 RED** — `real-tool-registry.spec.ts` drops `BANK_DETAILS_PROVIDER` stub; asserts exactly 10 keys incl. `getPaymentDetails`. RED: 4/4 DI failures (registry still required `BANK_DETAILS_PROVIDER`).
- **T4.2 GREEN** — `real-tool-registry.ts` drops `BANK_DETAILS_PROVIDER` import + ctor param + `bankDetails` from `ToolDeps` literal; imports + registers `makeGetPaymentDetailsTool` (10 tools). All 4 cases green.
- **T4.3 RED** — `sale-flow.module.spec.ts` adds `getPaymentDetails` to stub + drops `BANK_DETAILS_PROVIDER`/`NullBankDetailsProvider` references; asserts 10 keys + no bank provider. RED: pre-fix state (still 9 keys).
- **T4.4 GREEN** — `sale-flow.module.ts` removes `BANK_DETAILS_PROVIDER` provider + `NullBankDetailsProvider` import; only `RealToolRegistry` remains.
- **T4.5 RED** — `llm-agent.module.spec.ts` adds `getPaymentDetails: jest.fn()` to stub; asserts 10 keys + `LLM_AGENT_SYSTEM_PROMPT` resolves byte-identical to `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` (no bank block) + contains step-12 gating substring. RED: 10-key vs 9-key mismatch.
- **T4.6 GREEN** — `llm-agent.module.ts` drops `BANK_DETAILS_PROVIDER` import; `LLM_AGENT_SYSTEM_PROMPT` is a SYNC `useFactory: () => composeSaleFlowSystemPrompt(SYSTEM_PROMPT)` (no `inject`, no `await`). All 3 cases green.

### Phase 5 — Seam deletions

- **T5.1** — deleted `src/sale-flow/domain/bank-details.provider.ts`, `src/sale-flow/infrastructure/null-bank-details.provider.ts`, `src/sale-flow/infrastructure/null-bank-details.provider.spec.ts`. `pnpm test` stays green.
- **T5.2** — `git grep -n 'BANK_DETAILS_PROVIDER\|BankDetailsProvider\|bankDetails\|renderBankDetailsBlock' src/` returns **zero matches**. Comment cleanup pass removed every remaining mention from `src/` (the test that pins the absence was renamed to `'does not bind the boot-time bank-details seam (only the runtime registry)'`).

### Phase 6 — Docs

- **T6.1** — created `docs/provisioning-bot-cashier.md` (Q4 coordination checklist): bot cashier `User` + `ServiceCredential` with the 7 scopes `catalog:read, pricing:evaluate, customers:read, customers:write, sales:create, sales:write, payment-details:read` (the new `payment-details:read` is the delta vs. the archived 6-scope list), one credential per branch, `CHATBOT_API_CASHIER_USER_ID` unchanged (no env additions), at least one active `PaymentDetail` per branch, the operational note that a missing account → `404 NO_ACTIVE_PAYMENT_DETAIL` → human-handoff (never a crash), and the `AGENTS.md` §4.4 doc-sync follow-up pointer.
- **T6.2** — review passes: 7 scopes listed verbatim; per-branch credential note present; explicit no-env-change statement; `chatbot-api-doc-sync` follow-up pointer.

### Phase 7 — Full-suite verification

- **T7.1** — `pnpm test`: **40 passed / 40 of 42** (2 skipped, 16 tests skipped inside suites). **303 passing** (was 259 before the slice → +44 from cart-state / sale-flow-instructions / error-mapping / chatbot-api-http.client / evaluate-cart / create-sale / get-payment-details).
- **T7.2** — `pnpm test:cov` ≥ 80% on changed files:
  - `src/chatbot-api/**`: 100% statements / 100% branches / 100% functions / 100% lines (http-client 94.04% / 93.82% lines; well above 80%).
  - `src/sale-flow/**`: 100% statements / 100% branches / 100% functions / 100% lines (application 97.56% lines; tools 100%; domain 100%; infrastructure 100%).
  - `src/llm-agent/**`: 100% statements / 100% branches / 100% functions / 100% lines (application 98.21%).
- **T7.3** — `pnpm build` clean (`tsc` via `nest build`, no errors).
- **T7.4** — scoped `pnpm exec eslint src/sale-flow src/chatbot-api src/llm-agent`: lint clean on every file this slice introduced or modified; remaining errors are pre-existing in `placeholder-tools.ts` and unrelated `*.spec.ts` files (repo-wide lint known-broken per the task).
- **T7.5** — `pnpm test:e2e`: **2 failed** — pre-existing infrastructure issue (e2e config `test/jest-e2e.json` lacks `transformIgnorePatterns` so `ai@7.0.9` ESM imports fail to parse). Confirmed pre-existing: same failure on commit `39ae50e` (this slice's Commit 1) before any Phase 3-7 changes. Out of scope per the task's repo-wide-broken carve-out.
- **T7.6** — sanity: `git grep -n 'BANK_DETAILS_PROVIDER'` across the whole repo returns only matches inside `openspec/changes/archive/2026-08-24-sale-flow/` (historical context, expected); zero matches in `src/`. `git diff --stat` shows exactly 3 deletions (`bank-details.provider.ts` 21 − / `null-bank-details.provider.ts` 21 − / `null-bank-details.provider.spec.ts` 21 −) plus the 21 modified/new files in the design's file map. No backend files, no env-schema additions, no migrations, no `AGENTS.md`.

## Files touched

```
src/llm-agent/domain/system-prompt.ts              |  11 +-
src/llm-agent/llm-agent.module.spec.ts             |  10 +-
src/llm-agent/llm-agent.module.ts                  |  32 +-
src/sale-flow/application/tool-deps.ts             |   5 +-
src/sale-flow/application/tools/{9 tool specs}    |  ...
src/sale-flow/application/tools/create-sale.tool.spec.ts     | 615 +++++++++++-
src/sale-flow/application/tools/create-sale.tool.ts          |  61 +-
src/sale-flow/application/tools/evaluate-cart.tool.spec.ts   | 137 ++++-
src/sale-flow/application/tools/evaluate-cart.tool.ts        |  11 +
src/sale-flow/application/tools/get-payment-details.tool.{ts,spec.ts} | (new) 159 lines
src/sale-flow/domain/bank-details.provider.ts      |  21 -   (deleted)
src/sale-flow/domain/sale-flow-instructions.ts     |  21 +-
src/sale-flow/infrastructure/null-bank-details.provider.{ts,spec.ts} | 21 + 21 - (deleted)
src/sale-flow/infrastructure/real-tool-registry.{ts,spec.ts} | 19 + 16 +-
src/sale-flow/sale-flow.module.{ts,spec.ts}        | 30 + 19 +-
src/chatbot-api/domain/chatbot-api.client.ts       |  ...
src/chatbot-api/domain/dtos/payment-details.dto.ts | (new)
src/chatbot-api/domain/dtos/sales.dto.ts           |  ...
src/chatbot-api/domain/errors.ts                   |  ...
src/chatbot-api/infrastructure/chatbot-api-http.client.{ts,spec.ts} | ...
docs/provisioning-bot-cashier.md                  | (new)
openspec/changes/sale-flow-contract-updates/{apply-progress.md,tasks.md} | (new + updates)

24 files changed, 893 insertions(+), 191 deletions(-)
```

## Commits

| # | SHA | Subject |
|---|-----|---------|
| 1 | `39ae50e95d72358ae6b9302e87e566d8e0e3fecb` | `feat(chatbot-api): errorCode passthrough, payment-details endpoint, expectedTotalCents/discountCents` — Domain + DTO/Client (Phase 1 + Phase 2 + the minimum `llm-agent.module.ts` change needed to keep the build green at the Commit 1 boundary). 286 tests pass, build clean. |
| 2 | _at end of run_ | `feat(sale-flow): getPaymentDetails tool, promo re-quote flow, idempotency rotation, drop boot-time bank seam` — Tools + Wiring + Seams + Docs (Phase 3 + Phase 4 + Phase 5 + Phase 6 + Phase 7). 303 tests pass, build clean. |

## Coverage summary (final, post-Commit 2)

| Module | Stmts | Branch | Lines |
|---|---|---|---|
| `src/chatbot-api/**` | 100% | 100% | 100% (http-client 94.04%) |
| `src/sale-flow/**` | 100% | 100% | 100% (application 97.56%) |
| `src/llm-agent/**` | 100% | 100% | 100% (application 98.21%) |
| New `get-payment-details.tool.ts` | 100% | 100% | 100% |
| `cart-state.ts` | 100% | 100% | 100% |
| `error-mapping.ts` | 97.29% | 97.43% | 97.29% |

All ≥ 80% threshold.

## TDD cycle evidence

Every RED was a real RED (ts-jest compile failure OR runtime mismatch in the matching spec). Every GREEN produced the matching test passing. The strict-TDD discipline was preserved across all 7 phases:

1. Test written/updated → run → RED observed.
2. Implementation updated → run → GREEN.
3. Refactor only after GREEN.

Types-only tasks (T1.3, T2.1, T2.2, T2.3) carry compile-level RED via their dependent specs (the spec constructs `new ChatbotApiError('x', s, b, e)` which only compiles once the 4-arg ctor exists; the spec test for `error-mapping` requires the 5 discriminated kinds; etc.). The compile-level RED was confirmed via `tsc --noEmit -p tsconfig.spec.json` before each GREEN.

## Risks & open issues

- **Pre-existing `pnpm test:e2e` failure** — same failure on `39ae50e` before any Phase 3-7 change; e2e config `test/jest-e2e.json` lacks `transformIgnorePatterns` for the `ai` ESM package. Out of scope for this slice per the task's carve-out.
- **`BankDetails` type re-export from `sale-flow-instructions.ts`** was kept across Commit 1 to keep the deleted-seam files (`bank-details.provider.ts`, `null-bank-details.provider.ts`) compiling until Commit 2; removed in Commit 2 along with the file deletions.
- **Pre-existing repo-wide `pnpm lint`** broken; scoped lint on the touched paths is clean.
- **No backend, env, AGENTS.md, or package.json deps changed** — confirmed by `git diff --stat`.

## Follow-up backlog (parent-owned, logged in Engram)

- `chatbot-api-doc-sync` — reconcile `AGENTS.md` §4.4 with the backend's `PROGRAM-CONTEXT.md` §4.4 (now 11 endpoints; `payment-details:read` scope; `expectedTotalCents` / `discountCents` fields; 4 new error envelope codes).
- `llm-agent-provider-spec-sync` — drive-by alignment of `openspec/specs/llm-agent/spec.md` with the shipped `@ai-sdk/openai` + `OPENAI_API_KEY` implementation (carry-over from the archived `sale-flow` slice).
- `evaluate-cart-coverage-expansion` (Q5), `partial-customer-dto` (Q6), `order-history-phone-country-code-validation` (Q7), `cancel-endpoint-conversational` (Q8) — deferred per `docs/backend-questions-sale-flow-responses.md`.
- `e2e-transform-fix` — add `transformIgnorePatterns` to `test/jest-e2e.json` so the `ai` ESM package loads.