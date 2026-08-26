# Tasks: Conversational Cancel (`cancelSale` — 11th sale-flow tool)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1230 (production ~230 incl. 11 deletions; tests ~510 incl. 9 deletions; spec deltas ~495; no proposal/design/proposal-mgmt additions) |
| 400-line budget risk | **High** |
| Chained PRs recommended | No (delivery is single-developer branch + commits + merge to main — **not** chained PRs) |
| Suggested split | Two reviewable commits on a single branch: **Commit 1 — state + tool runtime** (Phases 1–4 + T5.4 contract-suite repair), **Commit 2 — prompt + spec deltas** (Phase 5 prompt + Phase 6 spec-delta commit + T7.x verify). |
| Delivery strategy | single-dev-branch (no PRs) with internal 2-commit split |
| Chain strategy | size-exception (2 commits on a single branch, NOT chained PRs) |

Decision needed before apply: **Yes** — the forecast exceeds the 400-line budget by ~3.1×; the orchestrator MUST confirm with the user whether to accept `size-exception` (proceed with the 2-commit split) or to slice the change further (e.g. (a) split cancelSale into a follow-up slice and land only the spec deltas + state-helper, or (b) further carve the prompt step out). The 2-commit split below is the recommended path; the user may also decline `size-exception` and ask for a different shape.
Chained PRs recommended: **No**
Chain strategy: size-exception
400-line budget risk: **High**

**Honest forecast derivation (additions + deletions, file by file):**

| File | Type | ADDED | DELETED |
|---|---|---|---|
| `src/sale-flow/application/placed-sale-persistence.ts` | new | ~35 | 0 |
| `src/sale-flow/application/tools/cancel-sale.tool.ts` | new | ~80 | 0 |
| `src/chatbot-api/domain/dtos/sales.dto.ts` | mod | ~30 | 0 |
| `src/chatbot-api/domain/chatbot-api.client.ts` | mod | ~6 | 0 |
| `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` | mod | ~12 | 0 |
| `src/sale-flow/domain/tool-result.ts` | mod | ~5 | ~2 |
| `src/sale-flow/application/error-mapping.ts` | mod | ~10 | 0 |
| `src/sale-flow/application/tools/create-sale.tool.ts` | mod | ~5 | ~3 |
| `src/sale-flow/infrastructure/real-tool-registry.ts` | mod | ~5 | ~1 |
| `src/sale-flow/domain/sale-flow-instructions.ts` | mod | ~25 | ~5 |
| `src/conversation/domain/conversation-store.ts` | mod | ~3 | 0 |
| `src/sale-flow/application/placed-sale-persistence.spec.ts` | new | ~120 | 0 |
| `src/sale-flow/application/tools/cancel-sale.tool.spec.ts` | new | ~190 | 0 |
| `src/sale-flow/application/tools/create-sale.tool.spec.ts` | mod | ~45 | 0 |
| `src/sale-flow/application/error-mapping.spec.ts` | mod | ~50 | 0 |
| `src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts` | mod | ~70 | 0 |
| `src/sale-flow/infrastructure/real-tool-registry.spec.ts` | mod | ~6 | ~3 |
| `src/sale-flow/domain/sale-flow-instructions.spec.ts` | mod | ~25 | ~5 |
| `src/sale-flow/application/tools/tool-contract.spec.ts` | mod | ~5 | ~1 |
| `openspec/changes/cancel-endpoint-conversational/specs/sale-flow-tools/delta.md` | new (in change) | ~360 | 0 |
| `openspec/changes/cancel-endpoint-conversational/specs/chatbot-api-client/delta.md` | new (in change) | ~135 | 0 |
| **Total** | | **~1227** | **~20** |
| **Grand total (ADDED + DELETED)** | | **~1247** | |

The forecast excludes `proposal.md`, `design.md`, and `tasks.md` itself (SDD scaffolding already in the change folder; they are not "change" files in the review-budget sense — the prior archive slice used the same convention).

**Why the budget is blown (signal-by-signal).** Two new production modules (`placed-sale-persistence.ts`, `cancel-sale.tool.ts`) + one new DTO surface + 8 modified files + ~510 lines of new/modified tests + two sizeable spec deltas (sale-flow-tools is ~360 lines because it documents the entire cancel contract, not just the diff). Tests dominate (≈40 % of total) — unavoidable under `rules.apply.tdd: true` because every production file has a spec, and the cancel tool has 8+ spec cases. Spec deltas dominate documentation (~40 %) — they are pre-authored but still count toward "changed lines". Production code is the smallest slice (~19 %).

**Mitigation (2-commit split — see T7.1/T7.2).** Commit 1 ships the runtime behaviour (everything green, end-to-end cancel works); commit 2 ships the prompt + spec deltas + contract-suite repair (no behaviour change, drift-only). Each commit is independently revertible (design.md §Rollback Design). The orchestrator MUST ask the user to confirm `size-exception` before the apply phase begins, because the budget breach is real (≈3.1× the limit).

---

## Phase 1: Domain contracts — placed-sale helpers, error union, errorCode-first mapping, prompt literal (strict TDD)

- [x] T1.1 Spec deltas authored at `openspec/changes/cancel-endpoint-conversational/specs/sale-flow-tools/delta.md` and `openspec/changes/cancel-endpoint-conversational/specs/chatbot-api-client/delta.md` (≈495 lines, pre-authored by the spec phase). Pre-resolved; no apply-phase action. <!-- sdd-owner: implementation -->
- [x] T1.2 RED: in `src/sale-flow/application/placed-sale-persistence.spec.ts` add (module file does NOT exist yet → import fails RED). Cases: `readPlacedSaleId(null) === null`; `readPlacedSaleId(stateWithoutKey) === null`; `readPlacedSaleId(stateWithEmptyString) === null`; `readPlacedSaleId(stateWithKey) === 'sale-1'`; `persistConfirmedSale` calls `store.update` exactly once with `{ lastMessageAt, data: { ...prevData, cart: EMPTY_CART, placedSaleId: 'sale-1' } }`; `clearPlacedSaleId` calls `store.update` exactly once with `{ lastMessageAt, data: { ...prevData, placedSaleId: undefined } }` (key removed); legacy `state?.data` `undefined` → spread of `{}` works (no type error). Verify RED (module absent). <!-- sdd-owner: implementation -->
- [x] T1.3 GREEN: create `src/sale-flow/application/placed-sale-persistence.ts` exporting `readPlacedSaleId(state)`, `persistConfirmedSale(store, senderId, state, saleId)`, `clearPlacedSaleId(store, senderId, state)` per design.md §d. `readPlacedSaleId` returns `typeof raw === 'string' && raw.length > 0 ? raw : null`; `persistConfirmedSale` shallow-spreads `state?.data` and overwrites `cart` and `placedSaleId`; `clearPlacedSaleId` shallow-spreads and `delete`s the key. Verify green. <!-- sdd-owner: implementation -->
- [x] T1.4 Types only: in `src/sale-flow/domain/tool-result.ts` extend `ToolErrorKind` with `'saleNotFound' | 'saleNotCancellable' | 'missingPlacedSaleId'`; update the file header comment from "eleven kind literals / 10 simple kinds" to "fourteen kind literals / 13 simple kinds" (the `Exclude<ToolErrorKind,'promoReQuote'>` for `SimpleToolError` picks the new ones up automatically). Compile-checked via the Phase-1 error-mapping spec + `pnpm build`. <!-- sdd-owner: implementation -->
- [x] T1.5 RED: in `src/sale-flow/application/error-mapping.spec.ts` add three new errorCode-first cases — `SALE_NOT_FOUND` (404) → `{ saleNotFound, false }`; `SALE_NOT_CANCELLABLE` (409) → `{ saleNotCancellable, false }`; `SALE_DELIVERED_CANNOT_CANCEL` (409) → `{ saleNotCancellable, false }`. Plus a fallback assertion: an unrecognized code (e.g. `'SOME_FUTURE_CODE'`) with statusCode 422 → `{ validation, false }` (safe degradation). Verify RED (the new kinds are not in the union yet → compile red). <!-- sdd-owner: implementation -->
- [x] T1.6 GREEN: in `src/sale-flow/application/error-mapping.ts` add three switch cases (before the subclass/status fallback) — `case 'SALE_NOT_FOUND':` → `{ saleNotFound, false }`; `case 'SALE_NOT_CANCELLABLE': case 'SALE_DELIVERED_CANNOT_CANCEL':` → `{ saleNotCancellable, false }`. `missingPlacedSaleId` is NEVER produced here (client-side guard only). Unknown codes fall through to the existing status/subclass mapping. Verify green, all existing scenarios still pass. <!-- sdd-owner: implementation -->
- [x] T1.7 Types only: in `src/conversation/domain/conversation-store.ts` add the typed optional field `placedSaleId?: string` to `ConversationStateData` with a JSDoc comment `/** Sale id persisted by createSale success; read/cleared by cancelSale. */`; the open `[key: string]: unknown` index signature remains (no migration). Compile-checked via Phase-3 tool specs + `pnpm build`. <!-- sdd-owner: implementation -->

## Phase 2: DTO + HTTP client — CancelSaleInput, CancelSaleResult, port + POST (strict TDD)

- [x] T2.1 RED: in `src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts` add `cancelSale` cases (method absent → red). Cases: 200 body `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }], canceledAt: '2026-08-25T12:00:00.000Z' }` → resolved `CancelSaleResult` deep-equals the projection AND does NOT carry `BotSaleResponse` fields (`deliveryStatus`, `totalCents`, `subtotalCents`, etc.); outgoing request is `POST /chatbot-api/sales/sale-1/cancel` with body `{ reason: 'CUSTOMER_REQUEST', cashierUserId: '<uuid>' }` and NO `X-Idempotency-Key` header; percent-encoded saleId when it contains reserved chars; `CancelSaleInputSchema` parses the 5 valid `reason` values and rejects `'NOT_A_REASON'` and missing `cashierUserId`; 409 body `{ error: 'SALE_NOT_CANCELLABLE' }` → rejects `ChatbotApiError { statusCode: 409, errorCode: 'SALE_NOT_CANCELLABLE' }` (verbatim); already-canceled 200 body resolves as success (`status: 'CANCELED'`, no error). Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.2 GREEN: in `src/chatbot-api/domain/dtos/sales.dto.ts` add `CancelSaleInputSchema` (Zod: `reason` enum of 5 values + `cashierUserId: z.string().min(1)`), `CancelSaleInput` interface, `CancelSaleResult` interface (plain, no Zod — matches the existing response-DTO style). `CancelSaleResult` is its own DTO; the client MUST NOT reuse `BotSaleResponse`. Verify green via the spec cases above. <!-- sdd-owner: implementation -->
- [x] T2.3 GREEN: in `src/chatbot-api/domain/chatbot-api.client.ts` add `cancelSale(saleId: string, dto: CancelSaleInput): Promise<CancelSaleResult>` to the `ChatbotApiClient` port; import the two new DTOs; JSDoc per the design ("no client `X-Idempotency-Key` — backend-derived `sale:cancel:<saleId>`"). Verify build green. <!-- sdd-owner: implementation -->
- [x] T2.4 GREEN: in `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` implement `cancelSale(saleId, dto): Promise<CancelSaleResult>` — validate via `CancelSaleInputSchema.parse(dto)`, then `this.request<CancelSaleResult>({ method: 'POST', url: '/chatbot-api/sales/${encodeURIComponent(saleId)}/cancel', data: { reason: parsed.reason, cashierUserId: parsed.cashierUserId } })`. NO `headers` key → only `Authorization` + `X-Branch-Id` apply (no `X-Idempotency-Key` is sent, ADR-16). Verify green. <!-- sdd-owner: implementation -->

## Phase 3: Tools — cancel-sale tool + createSale atomic persistence (strict TDD)

- [x] T3.1 RED: create `src/sale-flow/application/tools/cancel-sale.tool.spec.ts` (module absent → red). Cases: (a) **happy path** — sender S with `data.placedSaleId: 'sale-1'`, stubbed `chatbotApi.cancelSale` resolves to a `CancelSaleResult` → tool calls `chatbotApi.cancelSale('sale-1', { reason: 'CUSTOMER_REQUEST', cashierUserId: '<boot-injected-id>' })` exactly once, returns `{ ok: true, ...canceledSale }`, and a follow-up `readPlacedSaleId` on the updated state is `null`; (b) **missing-placedSaleId guard** — no `placedSaleId` in `data` → returns `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }` WITHOUT calling `chatbotApi.cancelSale`; (c) **fixed reason/cashier** — outgoing DTO carries `reason: 'CUSTOMER_REQUEST'` (never another enum) and the injected `cashierUserId` (never model-supplied; inputSchema is `z.object({}).strict()`); (d) **`SALE_NOT_FOUND`** — stub throws `ChatbotApiError(404, body, 'SALE_NOT_FOUND')` → `{ saleNotFound, false }` AND `readPlacedSaleId` is `null`; (e) **`SALE_DELIVERED_CANNOT_CANCEL`** — stub throws `ChatbotApiError(409, body, 'SALE_DELIVERED_CANNOT_CANCEL')` → `{ saleNotCancellable, false }` AND `readPlacedSaleId` is `null`; (f) **`IDEMPOTENCY_KEY_IN_FLIGHT`** — stub throws `ChatbotApiError(409, body, 'IDEMPOTENCY_KEY_IN_FLIGHT')` → `{ idempotencyInFlight, true }` AND `readPlacedSaleId` is still `'sale-1'`; (g) **unknown code** — stub throws `ChatbotApiError(422, body, 'SOME_FUTURE_CODE')` → `{ validation, false }` (safe degradation) AND `readPlacedSaleId` preserved; (h) **replay success** — out-of-band canceled → resolves with `status: 'CANCELED'` → `{ ok: true, status: 'CANCELED' }`, no error kind, `readPlacedSaleId` cleared; (i) **inputSchema rejects extras** — `safeParse({ extra: 'x' })` fails. Verify RED. <!-- sdd-owner: implementation -->
- [x] T3.2 GREEN: create `src/sale-flow/application/tools/cancel-sale.tool.ts` exporting `makeCancelSaleTool(deps: ToolDeps)` per design.md §e. Imports: `tool` from `ai`, `z` from `zod`, `ChatbotApiError`, `mapChatbotError`, `readPlacedSaleId`, `clearPlacedSaleId`. `description` gates the call to AFTER `createSale` returns `ok: true`, only the just-confirmed sale, `reason: 'CUSTOMER_REQUEST'` always, `cashierUserId` injected. `inputSchema: z.object({}).strict()`; `contextSchema: z.object({ senderId: z.string() })`. `execute`: (1) `state = await deps.store.get(senderId)`; `placedSaleId = readPlacedSaleId(state)`; (2) if `null` → return `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }`; (3) try block calls `deps.chatbotApi.cancelSale(placedSaleId, { reason: 'CUSTOMER_REQUEST', cashierUserId: deps.cashierUserId })`; on success → `await clearPlacedSaleId(deps.store, senderId, state)` then return `{ ok: true, ...canceledSale }`; (4) catch block: if `err instanceof ChatbotApiError`, switch on `err.errorCode` — `SALE_NOT_FOUND` / `SALE_NOT_CANCELLABLE` / `SALE_DELIVERED_CANNOT_CANCEL` / `IDEMPOTENCY_KEY_CONFLICT` → `await clearPlacedSaleId(deps.store, senderId, state)` then break; `default` (incl. `IDEMPOTENCY_KEY_IN_FLIGHT`, transient, unknown) → preserve id; finally `return mapChatbotError(err)`. Verify green, including replay-success and unknown-code fallback. <!-- sdd-owner: implementation -->
- [x] T3.3 RED: in `src/sale-flow/application/tools/create-sale.tool.spec.ts` add cases (placedSaleId absent → red; the existing helper `stubStoreWithCart` ignores placedSaleId). Cases: (a) **success sets placedSaleId atomically with cart clear** — cart with one item + idempotencyKey, backend returns `{ saleId: 'sale-1', discountCents: 0 }` → tool's success envelope includes `saleId: 'sale-1'`; persisted `data` contains `cart: { items: [], idempotencyKey: '', expectedTotalCents: undefined }` AND `placedSaleId: 'sale-1'`; exactly ONE `ConversationStore.update` write occurred (assert `store.update.mock.calls.length === 1` for the success path, not 2); (b) **a new createSale overwrites the prior placedSaleId** — initial `data.placedSaleId: 'sale-1'`, new backend `{ saleId: 'sale-2' }` → persisted `data.placedSaleId === 'sale-2'`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T3.4 GREEN: in `src/sale-flow/application/tools/create-sale.tool.ts` replace `await persistCart(deps.store, senderId, state, EMPTY_CART); void EMPTY_CART;` with `await persistConfirmedSale(deps.store, senderId, state, sale.saleId);` (atomic cart clear + placedSaleId set). Swap the import: drop `persistCart`/`EMPTY_CART` from the `cart-persistence`/`cart-state` imports (keep `readCart`, `writeCart`, `CartState`, `EMPTY_CART` type re-export). Update the JSDoc hard-rule #2 to mention placedSaleId is set on success, and rule #6 to mention placedSaleId is overwritten by a new sale. Verify green. <!-- sdd-owner: implementation -->

## Phase 4: Wiring — RealToolRegistry 11th key (strict TDD)

- [x] T4.1 RED: in `src/sale-flow/infrastructure/real-tool-registry.spec.ts` (a) add `cancelSale: jest.fn()` to the `stubChatbotApi` object; (b) change the exact-keys assertion from the current 10 keys (`searchCatalog, checkStock, evaluateCart, getCustomerByPhone, upsertCustomer, createSale, attachReceipt, updateDelivery, getOrderHistory, getPaymentDetails`) to the 11 keys ending with `..., getPaymentDetails, cancelSale`. Verify RED (today: `cancelSale` is undefined on the registry, so `Object.keys(tools).sort()` includes only 10). <!-- sdd-owner: implementation -->
- [x] T4.2 GREEN: in `src/sale-flow/infrastructure/real-tool-registry.ts` add `import { makeCancelSaleTool } from '../application/tools/cancel-sale.tool';`, register `cancelSale: makeCancelSaleTool(deps),` as the 11th key (after `getPaymentDetails`), and update the class JSDoc from "ten sale-flow tools" → "eleven sale-flow tools" with a one-line note "11th: `cancelSale`". Verify green. <!-- sdd-owner: implementation -->

## Phase 5: Prompt + contract-suite repair — step 14 cancel, close renumbered 15 (strict TDD)

- [x] T5.1 RED: in `src/sale-flow/domain/sale-flow-instructions.spec.ts` add (a) **step 14 cancel rule** — `expect(SALE_FLOW_INSTRUCTIONS).toMatch(/cancelSale/)`, `expect(SALE_FLOW_INSTRUCTIONS).toContain('¿Confirmas la cancelación? Sí/No')`, `expect(SALE_FLOW_INSTRUCTIONS).toMatch(/saleNotCancellable/)`, and an order-assertion that `cancelSale` appears AFTER `getPaymentDetails` (the cancel step is added between `attachReceipt` and the closing step); (b) **close renumbered to 15** — assert the closing instruction is now step 15 (`SALE_FLOW_INSTRUCTIONS` contains `15.` and the substring `Cierra la conversación` follows the cancel step). Verify RED (today: SALE_FLOW_INSTRUCTIONS is the 14-step literal with no cancel). <!-- sdd-owner: implementation -->
- [x] T5.2 GREEN: in `src/sale-flow/domain/sale-flow-instructions.ts` insert the cancel step as the new step 14 and renumber the closing step 14 → 15 per design.md §h. The step body MUST contain (verbatim) the byte-identical confirm phrase `¿Confirmas la cancelación? Sí/No` and the byte-identical missing-id reply `no hay una venta reciente por cancelar`. Update the header comment from "14-step" → "15-step". Verify green (T5.1 assertions pass, T1.6/T1.7 marker-order test for the 10-tool registry still passes since the marker order covers `searchCatalog`…`attachReceipt` and the new step 14 is between `attachReceipt` and the close). <!-- sdd-owner: implementation -->
- [x] T5.3 RED: in `src/sale-flow/application/tools/tool-contract.spec.ts` the `factories` array currently lists only 9 tools (omits `getPaymentDetails` AND the new `cancelSale`). Add `import { makeGetPaymentDetailsTool } from './get-payment-details.tool';` and `import { makeCancelSaleTool } from './cancel-sale.tool';`; append `['getPaymentDetails', makeGetPaymentDetailsTool as Factory]` and `['cancelSale', makeCancelSaleTool as Factory]` to the `factories` array (9 → 11). Verify RED (today: the contract suite covers only 9 of the 11 tools; the 10th and 11th would silently drift if their schemas broke). <!-- sdd-owner: implementation -->
- [x] T5.4 GREEN: same edit lands with T5.3; the new `cancelSale` factory should be added alongside the existing tools in the contract suite. Verify green — `factories.length === 11`, both `it.each(factories)` loops cover all 11 keys. <!-- sdd-owner: implementation -->

## Phase 6: Full-suite verification (no new tests)

- [x] T6.1 Run `pnpm test` — full unit + integration suite green (sale-flow, chatbot-api, llm-agent, conversation, config, whatsapp). <!-- sdd-owner: implementation -->
- [x] T6.2 Run `pnpm test:cov` — coverage ≥ 80% on changed files (`src/sale-flow/**`, `src/chatbot-api/**`, `src/conversation/**`). <!-- sdd-owner: implementation -->
- [x] T6.3 Run `pnpm build` — clean `tsc` compile (proves the types-only files `tool-result.ts`, `sales.dto.ts`, `conversation-store.ts` compile, and the port/HTTP/ToolDeps wiring is in sync). <!-- sdd-owner: implementation -->
- [x] T6.4 Run scoped lint `pnpm exec eslint src/sale-flow src/chatbot-api src/conversation` — clean (repo-wide `pnpm lint` is known-broken pre-existing; do not attempt to fix it in this slice). <!-- sdd-owner: implementation -->
- [x] T6.5 Run `pnpm test:e2e` — green. <!-- sdd-owner: implementation -->
- [x] T6.6 Sanity: `git grep -n 'cancelSale\|placedSaleId\|saleNotFound\|saleNotCancellable\|missingPlacedSaleId' src/ openspec/specs/` returns the expected set (no orphans in unrelated features, no missing references in tool/registry/spec wiring); `git diff --stat` shows the touched set matches the design file map exactly (no backend files, no env-schema additions, no migrations, no `AGENTS.md`). <!-- sdd-owner: implementation -->

## Phase 7: Delivery — 2-commit split, branch + merge to main

> The user preflight chose `single-developer, NO PRs (branch + commits + merge to main; user handles push/merge)`. The 2-commit split is the recommended review-budget mitigation (see Review Workload Forecast at the top). The orchestrator MUST have asked the user to confirm `size-exception` before T7.1 lands.

- [x] T7.1 **Commit 1 — state + tool runtime (Phases 1–4 + T5.4 contract-suite repair).** Single commit on the feature branch with all of the runtime behaviour: `placed-sale-persistence.ts` (+spec), `tool-result.ts`, `error-mapping.ts` (+spec), `conversation-store.ts`, `sales.dto.ts`, `chatbot-api.client.ts`, `chatbot-api-http.client.ts` (+spec), `create-sale.tool.ts` (+spec), `cancel-sale.tool.ts` (+spec), `real-tool-registry.ts` (+spec), and `tool-contract.spec.ts` (factories 9 → 11). After this commit: `pnpm test`, `pnpm build`, and `pnpm test:e2e` are green; end-to-end cancel works (T6.1–T6.5 verified BEFORE T7.2). Conventional-commit message e.g. `feat(sale-flow): cancel-sale 11th tool with durable placedSaleId`. <!-- sdd-owner: implementation -->
- [x] T7.2 **Commit 2 — prompt + spec deltas (Phase 5 + spec-delta commit).** Single commit with `sale-flow-instructions.ts` (+spec — step 14 + close renumbered to 15), and the already-authored spec deltas under `openspec/changes/cancel-endpoint-conversational/specs/`. No production-code or test changes; drift-only. After this commit: `pnpm test` still green (the byte-identical prompt assertions now exercise step 14); `pnpm build` clean. Conventional-commit message e.g. `feat(sale-flow): prompt step 14 cancel + spec deltas`. <!-- sdd-owner: implementation -->
- [x] T7.3 **Merge to main.** Fast-forward or merge commit per repo policy; user handles the actual `git push` per the delivery contract. No remote-side PR is created — `Chained PRs recommended: No`. <!-- sdd-owner: implementation -->

## Parent (post-apply lifecycle gates)

- [x] ~~Start or reuse bounded review~~ **NOT APPLICABLE**: receipt-driven development is OFF (decided global; `gentle-ai review mode status` = off). Delivery follows ordinary repository policy; the quality gate for this slice is the `sdd-verify` phase. Both rollback paths were reviewed at design level (design.md §Rollback Design): behaviour rollback (drop the `cancelSale` key + import from `real-tool-registry.ts`, revert `createSale` success write to `persistCart(…, EMPTY_CART)`, delete `cancel-sale.tool.ts` + `placed-sale-persistence.ts`; cancellation requests fall through to the existing refusal phrase `esa función aún no está disponible`; a leftover `data.placedSaleId` key is inert since no reader remains) and code rollback (revert the merge commit; single-developer delivery keeps each commit independently revertible). <!-- sdd-owner: parent -->
- [x] Lifecycle gate: follow-up backlog confirmed in Engram (project `houndfe-chatbot`). This slice closes `cancel-endpoint-conversational` (#3963 in the previous gate). The non-blocking follow-ups tracked at proposal §Follow-up Slices remain open: `chatbot-api-doc-sync` (reconcile `AGENTS.md` §4.4 with backend `PROGRAM-CONTEXT.md` §4.4.10 — now including `payment-details` and `cancel`), `historical-multi-order-cancel` (post-shipping refund rules), `placedSaleId-idle-cleanup` (only if edge case 7 proves operationally noisy). Proceeding to `sdd-verify`/archive. <!-- sdd-owner: parent -->

## Spec Scenario → Test Task Mapping

| Spec delta | Test task(s) |
|---|---|
| sale-flow-tools: `cancelSale` happy path + clears `placedSaleId` | T3.1(a) + T3.2 |
| sale-flow-tools: missing `placedSaleId` guard (no HTTP) | T3.1(b) + T3.2 |
| sale-flow-tools: `reason`/`cashierUserId` never model-chosen | T3.1(c) + T3.2 |
| sale-flow-tools: `SALE_NOT_FOUND` non-retryable + clears id | T3.1(d) + T3.2 |
| sale-flow-tools: `saleNotCancellable` → human handoff + clears id | T3.1(e) + T3.2 |
| sale-flow-tools: transient (`IDEMPOTENCY_KEY_IN_FLIGHT`) preserves id | T3.1(f) + T3.2 |
| sale-flow-tools: unknown code falls back to status mapping | T3.1(g) + T2.1 + T1.5 + T1.6 |
| sale-flow-tools: already-canceled = replay success (no error kind) | T3.1(h) + T3.2 + T2.1 |
| sale-flow-tools: explicit confirmation gate (`¿Confirmas la cancelación? Sí/No`) | T5.1 + T5.2 (byte-identical assertion) |
| sale-flow-tools: `placedSaleId` lifecycle (SET / READ / CLEAR / OVERWRITE) | T1.2 + T1.3 + T3.3 + T3.4 + T3.1 |
| sale-flow-tools: 11-tool registry (`cancelSale` is the 11th key) | T4.1 + T4.2 |
| sale-flow-tools: tool contract suite covers all 11 tools (no drift) | T5.3 + T5.4 |
| sale-flow-tools: errorCode-first mapping + 3 new `ToolErrorKind` literals | T1.4 + T1.5 + T1.6 |
| sale-flow-tools: step 15 close + step 14 cancel ordering | T5.1 + T5.2 |
| chatbot-api-client: 200 `CancelSaleResult` projection (NOT `BotSaleResponse`) | T2.1 + T2.2 + T2.4 |
| chatbot-api-client: POST shape + DTO body + NO `X-Idempotency-Key` header | T2.1 + T2.4 |
| chatbot-api-client: `CancelSaleInputSchema` validates 5 reasons + requires `cashierUserId` | T2.1 + T2.2 |
| chatbot-api-client: 409 `SALE_NOT_CANCELLABLE` → `errorCode` passthrough | T2.1 + T2.4 |
| chatbot-api-client: already-canceled 200 replay success | T2.1 + T2.4 |
| chatbot-api-client: `errorCode` populates on every mapped subclass | T2.1 (covered by existing Phase-2 errorCode cases from the archived slice) |

## Review Workload Forecast (recap)

Estimated changed lines: **~1247** (production ~247 incl. 11 deletions; tests ~520 incl. 9 deletions; spec deltas ~495; spec delta and design.md are pre-authored and `proposal.md`/`design.md`/`tasks.md` themselves excluded from the budget). Chained PRs recommended: **No** (single-developer branch + commits + merge). 400-line budget risk: **High** (~3.1× the limit). Decision needed before apply: **Yes** — the orchestrator MUST re-confirm the `size-exception` with the user; see Phase 7 above for the recommended 2-commit split.

## Tasks summary

Total tasks: **31** (29 implementation, 2 parent lifecycle gates). Pre-resolved `[x]`: 1 (T1.1 — spec deltas). Open `[ ]`: 30.