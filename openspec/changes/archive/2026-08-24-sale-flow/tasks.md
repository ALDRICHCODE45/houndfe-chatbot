# Tasks: Sale Flow (9 tools + cart + prompt composition)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Production LoC (est.) | ~750 |
| Tests / migration / docker / lockfile (est.) | ~850 |
| Total changed lines (incl. tests) | ~1500–1700 |
| 400-line budget risk | High |
| Chained PRs recommended | No |
| Suggested split | Single PR with two reviewable commits (Wiring+Seams, Tools+Cart) |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |
| Decision needed before apply | No |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

**Delivery note (authoritative context):** the user chose "Un solo PR siempre" (single-pr) and explicitly accepts the size exception for this slice, so `Chained PRs recommended: No` and `Chain strategy: size-exception` are intentional — this is NOT a `pending` decision. The design (Risk R-C) mitigates the 400-line budget overrun by splitting the single PR into at most two reviewable commits: **Wiring+Seams** (config, domain primitives, prompt composition, module wiring) and **Tools+Cart** (the nine tool factories + registry + cart persistence). No migration, docker, or lockfile changes are expected in this slice (no new packages, no new tables — cart lives in the existing `ConversationState.data` bag).

## Phase 1: Config — `CHATBOT_API_CASHIER_USER_ID` (strict TDD)

- [x] T1.1 RED: in `src/config/env.validation.spec.ts` add `CHATBOT_API_CASHIER_USER_ID` (valid UUID `00000000-0000-4000-8000-000000000001`) to the `validEnv` fixture and add two cases — absent → Joi error, non-UUID (`"cashier-1"`) → Joi error. Also add the same var to the `VALID_ENV` fixtures in `src/config/config.module.spec.ts` and `src/llm-agent/llm-agent.module.spec.ts` (module boots would fail once the schema is required). Verify RED. <!-- sdd-owner: implementation -->
- [x] T1.2 GREEN: in `src/config/env.validation.ts` add `CHATBOT_API_CASHIER_USER_ID: Joi.string().uuid().required()` (boot fails fast before any port bind, matching the existing LLM env pattern). Verify the Phase 1 cases pass and the rest of `env.validation.spec.ts` stays green. <!-- sdd-owner: implementation -->
- [x] T1.3 RED: in `src/config/configuration.spec.ts` add `CHATBOT_API_CASHIER_USER_ID` to `MANAGED_KEYS` and assert `configuration()` exposes `chatbotApi.cashierUserId === process.env.CHATBOT_API_CASHIER_USER_ID`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T1.4 GREEN: in `src/config/configuration.ts` add `cashierUserId: process.env.CHATBOT_API_CASHIER_USER_ID as string` to the `chatbotApi` block (typed via `AppConfig`). Verify green. <!-- sdd-owner: implementation -->

## Phase 2: Domain primitives (strict TDD)

- [x] T2.1 RED: create `src/sale-flow/domain/cart-state.spec.ts` — `readCart(null)` and `readCart` on a state whose `data` has no `cart` key both return `{ items: [], idempotencyKey: '' }`; `writeCart` shallow-merges a patch (adds one item + fresh key) over the existing cart without touching other `data` keys. Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.2 GREEN: create `src/sale-flow/domain/cart-state.ts` — `CartItem`, `CartState`, `EMPTY_CART`, `isCartState` guard, pure `readCart(state)` (missing/unknown → empty) and pure `writeCart(state, patch)` (shallow merge), mirroring `readMessages` style. Verify green. <!-- sdd-owner: implementation -->
- [x] T2.3 RED: create `src/sale-flow/domain/sale-flow-instructions.spec.ts` — `composeSaleFlowSystemPrompt(base, null)` deep-equals `base + '\n\n' + SALE_FLOW_INSTRUCTIONS`; with non-null `BankDetails` it appends a rendered bank block after the slice; the composed prompt contains (i) literal `esa función aún no está disponible`, (ii) the forbidden-slang block (`voseo`, `güey`, `chido`, `neta`, `chela`, `órale`), (iii) the 14-step escrow flow markers (searchCatalog → checkStock → evaluateCart → getCustomerByPhone → upsertCustomer → createSale → attachReceipt), (iv) the list-price-only instruction referencing `originalPriceCents`/`finalPriceCents`/`needs_human_review`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.4 GREEN: create `src/sale-flow/domain/sale-flow-instructions.ts` — `SALE_FLOW_INSTRUCTIONS` literal (14-step escrow flow + list-price-only rule + no-fabrication rule + human-handoff phrase "en un momento un agente te comparte los datos de pago" for the bank-details-null case), plus `composeSaleFlowSystemPrompt(base, bankDetails)` and `renderBankDetailsBlock(details)`. Verify green. <!-- sdd-owner: implementation -->
- [x] T2.5 RED: create `src/sale-flow/infrastructure/null-bank-details.provider.spec.ts` — `new NullBankDetailsProvider().get()` resolves `null`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.6 GREEN: create `src/sale-flow/domain/bank-details.provider.ts` (`BANK_DETAILS_PROVIDER` Symbol, `BankDetails { bankName, beneficiary, clabe, accountNumber }`, `BankDetailsProvider { get(): Promise<BankDetails | null> }`) and `src/sale-flow/infrastructure/null-bank-details.provider.ts` (`@Injectable() NullBankDetailsProvider`). Verify green. <!-- sdd-owner: implementation -->
- [x] T2.7 Types only (no behaviour, no test): create `src/sale-flow/domain/tool-result.ts` — `ToolErrorKind = 'auth'|'forbidden'|'notFound'|'rateLimit'|'upstream'|'validation'`, `ToolErrorResult { ok:false; error:{ kind; retryable } }`, `ToolSuccess<T>`, `ToolResult<T>`. Compile-checked via the Phase 3/4 specs and `pnpm build`. <!-- sdd-owner: implementation -->

## Phase 3: Application layer (strict TDD)

- [x] T3.1 RED: create `src/sale-flow/application/error-mapping.spec.ts` — for `AuthError`/`ForbiddenError`/`NotFoundError`/`RateLimitError`/`UpstreamError(statusCode)`/plain `ChatbotApiError(statusCode)`: 401→`{auth,false}`, 403→`{forbidden,false}`, 404→`{notFound,false}`, 429→`{rateLimit,true}`, 4xx `UpstreamError` (400/422)→`{validation,false}`, 5xx/network `UpstreamError`→`{upstream,true}`; a non-ChatbotApi error (`BranchMismatchError`) must rethrow. Verify RED. <!-- sdd-owner: implementation -->
- [x] T3.2 GREEN: create `src/sale-flow/application/error-mapping.ts` — `mapChatbotError(err): ToolErrorResult` implementing exactly the pinned mapping (4xx-not-specialized → `validation`, 5xx/network → `upstream` retryable, unknown → rethrow). Verify green. <!-- sdd-owner: implementation -->
- [x] T3.3 RED: create `src/sale-flow/application/cart-persistence.spec.ts` with a stubbed `ConversationStore` — `persistCart(store, senderId, state, nextCart)` calls `store.update` with `data` replaced as a whole object (existing `messages` preserved, `cart` key swapped, no JSONB deep-merge), and `lastMessageAt` preserved from `state` when present. Verify RED. <!-- sdd-owner: implementation -->
- [x] T3.4 GREEN: create `src/sale-flow/application/cart-persistence.ts` — `persistCart(store, senderId, state, nextCart)` performing the durable `store.update` (UPSERT path per the `conversation-store` spec). Verify green. <!-- sdd-owner: implementation -->
- [x] T3.5 Types only (no behaviour, no test): create `src/sale-flow/application/tool-deps.ts` — `ToolDeps = { chatbotApi: ChatbotApiClient; store: ConversationStore; bankDetails: BankDetailsProvider; cashierUserId: string }` (imports from `src/chatbot-api/domain/chatbot-api.client`, `src/conversation/domain/conversation-store`, `src/sale-flow/domain/bank-details.provider`). Consumed by every Phase 4 tool factory; compile-checked. <!-- sdd-owner: implementation -->

## Phase 4: The nine tools (strict TDD — test first, then factory)

- [x] T4.1 RED: create `src/sale-flow/application/tools/tool-contract.spec.ts` — shared suite iterating over the 9 factories (imports the not-yet-existing modules): each returns `{ description: string, inputSchema: ZodObject, execute: function }`; a representative malformed input is rejected by the schema before `execute` (e.g. `attachReceipt` with `saleId: "not-a-uuid"`, `mediaUrl: "not-a-url"`, `declaredAmountCents: 0`). Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.2 RED: create `src/sale-flow/application/tools/search-catalog.tool.spec.ts` and `check-stock.tool.spec.ts` — searchCatalog maps `q`/`limit` to `chatbotApi.searchCatalog` (limit default 10; rejects limit 0/21), returns `{ ok:true, results }`; checkStock maps `productId` (uuid) to `chatbotApi.getStock`; both catch a thrown `UpstreamError` into `{ ok:false, error:{ kind:'upstream', retryable:true } }` without propagating. Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.3 GREEN: create `src/sale-flow/application/tools/search-catalog.tool.ts` (`makeSearchCatalogTool(deps)`) and `check-stock.tool.ts` (`makeCheckStockTool(deps)`) — AI-SDK `tool({ description, inputSchema, execute })` per the design signatures; `execute` wraps `mapChatbotError`. Verify green. <!-- sdd-owner: implementation -->
- [x] T4.4 RED: create `src/sale-flow/application/tools/evaluate-cart.tool.spec.ts` — with stubbed `chatbotApi.evaluateCart` returning `items[{ productId, variantId, quantity, originalPriceCents: 1000, finalPriceCents: 800 }]`, the tool persists via `persistCart` a cart whose `unitPriceCents === 1000` (never 800) and keeps an existing `idempotencyKey`; `contextSchema` carries `senderId`; success returns `{ ok:true, ...evaluation }`; thrown `NotFoundError` → `{ ok:false, error:{ kind:'notFound', retryable:false } }`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.5 GREEN: create `src/sale-flow/application/tools/evaluate-cart.tool.ts` (`makeEvaluateCartTool(deps)`) — quote via `chatbotApi.evaluateCart(input.items)`, persist `items` with `unitPriceCents = originalPriceCents`, `contextSchema: z.object({ senderId: z.string() })`, `execute(input, { context })` uses `context.senderId`. Verify green. <!-- sdd-owner: implementation -->
- [x] T4.6 RED: create `get-customer-by-phone.tool.spec.ts` and `upsert-customer.tool.spec.ts` — getCustomerByPhone maps `phoneCountryCode`/`phone` to `chatbotApi.getCustomerByPhone(cc, phone)`; upsertCustomer forwards the full DTO (Zod: `firstName` min 1 max 100, `address.street` required min 1 max 200, `phoneCountryCode` min 1 max 10, `phone` min 1 max 20, optional `preferredPaymentMethod` max 50) and rejects a missing `address.street`; both return error envelopes on thrown errors. Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.7 GREEN: create `get-customer-by-phone.tool.ts` (`makeGetCustomerByPhoneTool(deps)`) and `upsert-customer.tool.ts` (`makeUpsertCustomerTool(deps)`). Verify green. <!-- sdd-owner: implementation -->
- [x] T4.8 RED: create `src/sale-flow/application/tools/create-sale.tool.spec.ts` — (a) first attempt: cart empty → `{ ok:false, error:{ kind:'validation', retryable:false } }` without any HTTP call; (b) with a populated cart: generates a UUID v4 via `crypto.randomUUID()`, persists it on the cart, the outgoing `createSale` call includes it as the idempotency key, a second call reuses the same key; (c) list-price enforcement: cart has `unitPriceCents 1000`, input has `finalPriceCents 800` in scope — outgoing body uses `1000` and contains no `800`; (d) `cashierUserId` injected from deps (never from model input); (e) on `{ ok:true, saleId }` the cart is cleared to `EMPTY_CART` (incl. idempotency key); (f) success returns `{ ok:true, ...BotSaleResponse }`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.9 GREEN: create `src/sale-flow/application/tools/create-sale.tool.ts` (`makeCreateSaleTool(deps)`) — read cart via `readCart`, empty-cart guard, idempotency key persist/reuse, list-price body built from the persisted cart (borrowing `productName`/`variantName` from input matched by `productId`+`variantId`; missing line → `validation`), `dto` includes `cashierUserId: deps.cashierUserId`, `chatbotApi.createSale(dto, key)`, clear cart to `EMPTY_CART` on success. Verify green. <!-- sdd-owner: implementation -->
- [x] T4.10 RED: create `attach-receipt.tool.spec.ts`, `update-delivery.tool.spec.ts`, and `get-order-history.tool.spec.ts` — attachReceipt maps `saleId`/`mediaUrl`/`declaredAmountCents` (+ optional `declaredDate` ISO datetime, `declaredReference`) to `chatbotApi.attachReceipt` and rejects `mediaUrl: "not-a-url"` / `declaredAmountCents: 0`; updateDelivery maps `saleId`/`carrierName`/`trackingRef`/`estimatedDeliveryAt` to `chatbotApi.updateDelivery` and returns `{ ok:true }` (registered only — no slice scenario invokes it end-to-end); getOrderHistory maps `phone`/`phoneCountryCode` to `chatbotApi.getOrderHistory(phone, cc)` → `{ ok:true, results }`; each tool returns the error envelope on thrown errors. Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.11 GREEN: create `attach-receipt.tool.ts` (`makeAttachReceiptTool(deps)`), `update-delivery.tool.ts` (`makeUpdateDeliveryTool(deps)`), and `get-order-history.tool.ts` (`makeGetOrderHistoryTool(deps)`). Verify green. <!-- sdd-owner: implementation -->
- [x] T4.12 GREEN: `tool-contract.spec.ts` (from T4.1) now passes against the nine factories — run the file and confirm all contract cases pass. <!-- sdd-owner: implementation -->

## Phase 5: RealToolRegistry (strict TDD)

- [x] T5.1 RED: create `src/sale-flow/infrastructure/real-tool-registry.spec.ts` — (a) with stubbed `CHATBOT_API_CLIENT` + `CONVERSATION_STORE` + `NullBankDetailsProvider` + `cashierUserId`, `getTools()` returns exactly the 9 keys `searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`, `attachReceipt`, `updateDelivery`, `getOrderHistory` (and nothing else); (b) each entry is an AI-SDK tool whose `inputSchema` is a Zod object; (c) a `Test.createTestingModule`-style DI resolution builds the registry with the injected deps. Verify RED. <!-- sdd-owner: implementation -->
- [x] T5.2 GREEN: create `src/sale-flow/infrastructure/real-tool-registry.ts` — `@Injectable() RealToolRegistry implements ToolRegistry` injecting `CHATBOT_API_CLIENT`, `CONVERSATION_STORE`, `BANK_DETAILS_PROVIDER`, `ConfigService` (for `chatbotApi.cashierUserId`), builds the 9-tool ToolSet once in its constructor, `getTools()` returns it. Verify green. <!-- sdd-owner: implementation -->

## Phase 6: SaleFlowModule (strict TDD)

- [x] T6.1 RED: create `src/sale-flow/sale-flow.module.spec.ts` — a TestingModule importing `SaleFlowModule` (with stubbed providers for `CHATBOT_API_CLIENT`/`CONVERSATION_STORE`/`ConfigService`) resolves `RealToolRegistry` and `BANK_DETAILS_PROVIDER` bound to `NullBankDetailsProvider`, and both are exported. Verify RED. <!-- sdd-owner: implementation -->
- [x] T6.2 GREEN: create `src/sale-flow/sale-flow.module.ts` — imports `ChatbotApiModule` + `ConversationModule`; providers: `RealToolRegistry`, `BANK_DETAILS_PROVIDER` (`useClass: NullBankDetailsProvider`); exports both. Verify green. <!-- sdd-owner: implementation -->

## Phase 7: llm-agent integration (strict TDD)

- [x] T7.1 RED: in `src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts` add a case asserting the `generateText` call receives `toolsContext` containing `{ senderId: <input.senderId> }`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T7.2 GREEN: in `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` forward `toolsContext: { senderId: input.senderId }` in the `generateText` args (per-tool `contextSchema` receives it). Verify green. <!-- sdd-owner: implementation -->
- [x] T7.3 RED: in `src/llm-agent/llm-agent.module.spec.ts` update the wiring assertions — `TOOL_REGISTRY` resolves to `RealToolRegistry` and `getTools()` contains all 9 sale-flow keys (drop the `getCurrentTime` assertion; the placeholder MAY remain as a fixture but MUST NOT be the binding); assert `ChatbotApiModule` + `SaleFlowModule` are imported and `LLM_AGENT_SYSTEM_PROMPT` resolves to a composed prompt containing the literal refusal phrase; keep the "tests can override `TOOL_REGISTRY` with a stub" scenario working. Verify RED. <!-- sdd-owner: implementation -->
- [x] T7.4 GREEN: in `src/llm-agent/domain/system-prompt.ts` add `export const LLM_AGENT_SYSTEM_PROMPT = Symbol('LLM_AGENT_SYSTEM_PROMPT')` — `SYSTEM_PROMPT` literal byte-identical (existing `system-prompt.spec.ts` must stay green). <!-- sdd-owner: implementation -->
- [x] T7.5 GREEN: in `src/llm-agent/llm-agent.module.ts` import `ChatbotApiModule` + `SaleFlowModule`; rebind `TOOL_REGISTRY` to `useExisting: RealToolRegistry`; add `LLM_AGENT_SYSTEM_PROMPT` async factory injecting `BANK_DETAILS_PROVIDER` and composing via `composeSaleFlowSystemPrompt(SYSTEM_PROMPT, await bankDetails.get())` (one-shot at boot; rollback stays a one-line `useClass: InMemoryToolRegistry` revert). Verify green. <!-- sdd-owner: implementation -->
- [x] T7.6 RED: in `src/llm-agent/application/agent-runner.service.spec.ts` replace the "forwards SYSTEM_PROMPT verbatim" assertion with a sentinel composed prompt passed through `AgentRunner.forTest(...)` `config.systemPrompt`, asserting the runner forwards it verbatim on every `handle` call and never overrides it (composition-once contract). Verify RED. <!-- sdd-owner: implementation -->
- [x] T7.7 GREEN: in `src/llm-agent/application/agent-runner.service.ts` inject `@Inject(LLM_AGENT_SYSTEM_PROMPT) systemPrompt: string`, cache it in the constructor (remove the `SYSTEM_PROMPT` import); `forTest` still receives `config.systemPrompt`. Verify green. <!-- sdd-owner: implementation -->

## Phase 8: Full-suite verification (no new tests)

- [x] T8.1 Run `pnpm test` — all unit + integration specs green (config, sale-flow, llm-agent, chatbot-api, conversation, whatsapp). <!-- sdd-owner: implementation -->
- [x] T8.2 Run `pnpm test:cov` — coverage ≥ 80% on changed files (`src/sale-flow/**`, changed files under `src/llm-agent`, `src/config`). <!-- sdd-owner: implementation -->
- [x] T8.3 Run `pnpm build` — clean `tsc` compile (also proves the types-only files `tool-result.ts`/`tool-deps.ts` compile). <!-- sdd-owner: implementation -->
- [x] T8.4 Run scoped lint `pnpm exec eslint src/sale-flow src/llm-agent src/config` — clean (repo-wide `pnpm lint` is known-broken pre-existing; do not attempt to fix it in this slice). <!-- sdd-owner: implementation -->
- [x] T8.5 Sanity: `git diff --stat` shows zero changes under `src/chatbot-api/**`, `src/conversation/**`, `src/app.module.ts` (consumer-only + no-migration constraint) and confirms `src/llm-agent/infrastructure/in-memory-tool-registry.ts` is untouched (kept as a fixture, not the production binding). <!-- sdd-owner: implementation -->

## Parent (post-apply lifecycle gates)

- [x] Start or reuse bounded review: review the single PR as the two-commit split (Wiring+Seams, Tools+Cart) against the 400-line budget, acknowledging the accepted size exception; verify the behaviour-rollback path (one-line `TOOL_REGISTRY` revert → refusal phrase, no data loss) is intact. <!-- sdd-owner: parent --> (deferred to delivery: single-PR bounded review with size-exception, two-commit split; rollback path verified in verify-report.md)
- [x] Lifecycle gate: confirm follow-up backlog items exist in Engram (project `houndfe-chatbot`): `promo-discounted-createSale`, `bank-details-source-impl`, `llm-agent-provider-spec-sync`, `meta-media-cdn-url-expiry`; then proceed to `sdd-verify`/archive. <!-- sdd-owner: parent -->

## Spec Scenario → Test Task Mapping

| Spec | Test task |
|---|---|
| sale-flow-tools: missing/malformed `CHATBOT_API_CASHIER_USER_ID` blocks boot | T1.1 + T1.2 |
| sale-flow-tools: createSale forwards the env-resolved cashier id | T4.8 + T4.9 |
| sale-flow-tools: registry exposes all nine tools | T5.1 + T5.2 |
| sale-flow-tools: placeholder registry no longer the production binding | T7.3 + T7.5 + T8.5 |
| sale-flow-tools: representative schema rejects malformed inputs | T4.1 + T4.12 |
| sale-flow-tools: upstream 5xx → retryable upstream envelope | T3.1 + T3.2 + per-tool error-envelope specs (T4.2/T4.4/T4.8/T4.10) |
| sale-flow-tools: 404 → non-retryable notFound envelope | T3.1 + T3.2 + T4.4 |
| sale-flow-tools: cart round-trips through durable store / missing cart defaults empty | T2.1 + T2.2 + T3.3 + T3.4 |
| sale-flow-tools: first attempt persists / reuses / clears idempotency key | T4.8 + T4.9 |
| sale-flow-tools: list price sent, not final price | T4.8 + T4.9 (and T4.4 + T4.5 on the evaluateCart side) |
| sale-flow-tools: cart cleared on success | T4.8 + T4.9 |
| sale-flow-tools: null provider triggers human-handoff phrase | T2.3 + T2.4 + T7.5 |
| sale-flow-tools: provider swap needs no tool/model changes | T6.1 + T6.2 (DI binding only) |
| sale-flow-tools: composed prompt contains the four contractual strings | T2.3 + T2.4 + T7.3 |
| sale-flow-tools: composition at boot, not per turn | T7.6 + T7.7 |
| sale-flow-tools: updateDelivery registered but not exercised | T5.1 + T5.2 + T4.10 + T4.11 |
| llm-agent: history truncates in memory and tool result round-trips | T7.6 (runner scenario preserved, sentinel prompt) |
| llm-agent: refusal phrase and language contract asserted (base layer) | T2.3 + T7.6 |
| llm-agent: composed prompt contains all four contract strings | T2.3 + T2.4 + T7.3 |
| llm-agent: production wiring resolves RealToolRegistry with ChatbotApiClient | T7.3 + T7.5 |
| llm-agent: tests can override the tool registry | T7.3 |
