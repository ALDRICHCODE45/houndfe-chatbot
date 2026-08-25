# Proposal: sale-flow-contract-updates

## Intent

Wire the three chatbot-api contract changes that the backend delivered in
`chatbot-sale-flow-blockers` (archived 2026-08-24) and that the bot must now
honour end-to-end. **Backend work is done**; this slice is the bot-side
implementation only. The previous slice (`sale-flow`, archived
2026-08-24) intentionally shipped with two blocked seams (R11 bank details
and R13 promo-discounted `createSale`) and a list-price `createSale` guard;
this slice closes those seams and tightens the idempotency contract.

The three contract items are:

| # | Contract item | Flows touched | New bot code |
|---|---------------|---------------|--------------|
| 1 | **Q1 (R11)** — new `GET /chatbot-api/payment-details` returns the active `PaymentDetail` (`scope payment-details:read`); `404 NO_ACTIVE_PAYMENT_DETAIL` when none active | R11 (transfer-message after `createSale` confirms) | **New 10th AI-SDK tool `getPaymentDetails`**; **remove** boot-time `BankDetailsProvider` seam entirely |
| 2 | **Q2 (R13)** — `POST /chatbot-api/sales` accepts optional `expectedTotalCents`; server re-quotes with the full POS promo engine; on mismatch returns `409 PROMO_RE_QUOTE` with `{ recomputedTotalCents, expectedTotalCents, discountCents }` and **no side effects**; `BotSaleResponse` adds `discountCents`; `PRICE_OUT_OF_DATE` (`409`) still exists | R13 (promotion pricing) | Send `expectedTotalCents` on every `createSale`; treat `PROMO_RE_QUOTE` as **normal flow** (show recomputed total, re-confirm, re-emit with **new** idempotency key); display `discountCents > 0` in the confirmation message |
| 3 | **Q3** — atomic idempotency on `registerBotSale`: `400 INVALID_IDEMPOTENCY_KEY` (before DB read), `409 IDEMPOTENCY_KEY_CONFLICT`, `409 IDEMPOTENCY_KEY_IN_FLIGHT`, replay returns cached response; payload hash excludes display names | sale-flow reliability | Mints key per distinct payload; reuses key **only** for identical-payload retries; never mutates payload under a used key; retries later on `in_flight`; mints a new key on `conflict` |

### Relationship to existing capabilities

- **MODIFIED `sale-flow-tools`** (`openspec/specs/sale-flow-tools/spec.md`):
  the 9-tool registry grows to 10 with `getPaymentDetails`; the boot-time
  `BankDetailsProvider` port + `NullBankDetailsProvider` + `BANK_DETAILS_PROVIDER`
  module binding + the `composeSaleFlowSystemPrompt` boot-time bank-block
  rendering are **deleted** (the prompt literal's step-12 already carries the
  human-handoff phrase for the `404 NO_ACTIVE_PAYMENT_DETAIL` case, so no
  prompt text is rewritten). `createSale` extends its outgoing DTO with
  `expectedTotalCents`, accepts `discountCents` from the response, and
  handles the `409 PROMO_RE_QUOTE` envelope without clearing the cart on
  conflict. `CartState` gains `expectedTotalCents?: number` so the model
  cannot fabricate the value — it is sourced from the last `evaluateCart`
  result and persisted alongside `items` + `idempotencyKey`.
- **MODIFIED `chatbot-api-client`** (`openspec/specs/chatbot-api-client/spec.md`):
  `ChatbotApiClient` port adds `getPaymentDetails(): Promise<PaymentDetail>`;
  `createSale` DTO gains optional `expectedTotalCents`; `BotSaleResponse`
  gains `discountCents: number`; `ChatbotApiError` gains the `error`-code
  passthrough so tools can discriminate `PROMO_RE_QUOTE` /
  `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT` /
  `INVALID_IDEMPOTENCY_KEY` / `NO_ACTIVE_PAYMENT_DETAIL` without parsing
  message strings. `AGENTS.md` is **NOT** modified by this slice (a follow-up
  openspec update will reconcile §4.4 with the new endpoint and contract
  fields after go-live verification — Risk R-D).
- **UNCHANGED**: `llm-agent`, `conversation-store`, `whatsapp-sender`,
  `whatsapp-webhook`, `app-config`. The system-prompt literal in
  `src/sale-flow/domain/sale-flow-instructions.ts` keeps step 12 ("en un
  momento un agente te comparte los datos de pago") verbatim — the new
  `getPaymentDetails` tool teaches the model when to call it; no boot-time
  prompt composition runs any more.
- **UNCHANGED backend code** (READ-ONLY constraint, hard).

### Authoritative user decisions encoded in this proposal

1. **Bank details = runtime tool, not boot-time seam.** New 10th AI-SDK
   tool `getPaymentDetails` that the model calls at step 12 **after**
   `createSale` succeeds. Fresh data per message; `404
   NO_ACTIVE_PAYMENT_DETAIL` → human-handoff phrase, never a crash. This
   **replaces** the boot-time seam entirely: remove `BankDetailsProvider`
   port, `NullBankDetailsProvider`, the boot-time prompt block, and the
   `BANK_DETAILS_PROVIDER` module binding. Rationale: stale bank data
   captured at process start is a real risk (admin updates the account,
   the bot keeps sending the old CLABE); a per-turn tool call is the only
   source-of-truth that survives restarts and admin changes without a
   cache-coherency problem.
2. **`PROMO_RE_QUOTE` = normal flow, not error.** When the bot sees the
   `409 PROMO_RE_QUOTE` envelope, it tells the customer the new
   `recomputedTotalCents` (`discountCents` included), asks for explicit
   confirmation, and on acceptance **re-emits `createSale` with a NEW
   `X-Idempotency-Key`** (the persisted key is cleared — see Q3 rule: same
   key ONLY for identical-payload retries). If the customer declines, the
   sale does not happen: the cart is preserved (items + key cleared so
   the next acceptance mints a fresh key) and the bot offers alternatives
   (edit quantities, remove items, or escalate). Rationale: a price change
   between quote and confirm is the documented happy path of R13; treating
   it as an error would break sales the moment any promo expires or a
   tier price re-evaluates.
3. **`discountCents > 0` is displayed in the order confirmation message**
   ("Descuento aplicado: $X") so the customer sees why the total differs
   from the sum of list prices. `discountCents === 0` is silent.
4. **Q4 provisioning is documentation only.** No code, no env additions.
   A coordination checklist (bot cashier `User` record + `ServiceCredential`
   with `payment-details:read` scope, plus the existing 6 scopes) lives in
   `docs/provisioning-bot-cashier.md`. The backend team owns the seed;
   the bot reads `cashierUserId` from `CHATBOT_API_CASHIER_USER_ID` as it
   already does (no env additions).

## Scope

### In Scope

- **New tool `getPaymentDetails`** (`src/sale-flow/application/tools/get-payment-details.tool.ts`):
  AI-SDK `tool()` factory, Zod `inputSchema: z.object({})` (no params), wraps
  `chatbotApi.getPaymentDetails()`, returns `{ ok: true, paymentDetail: { id,
  bankName, beneficiary, clabe, accountNumber, isActive, updatedAt } }` on
  200 or `{ ok: false, error: { kind: 'noActivePaymentDetail' | 'auth' |
  'forbidden' | 'rateLimit' | 'upstream' | 'validation', retryable: ... } }`
  on failure. `404 NO_ACTIVE_PAYMENT_DETAIL` is a **new discriminated kind
  `noActivePaymentDetail`** (`retryable: false`) — the model's prompt
  branch reads this kind and emits the human-handoff phrase ("en un momento
  un agente te comparte los datos de pago").
- **`ChatbotApiClient` port + HTTP impl** (`src/chatbot-api/domain/chatbot-api.client.ts`,
  `src/chatbot-api/infrastructure/chatbot-api-http.client.ts`):
  - New method `getPaymentDetails(): Promise<PaymentDetail>` →
    `GET /chatbot-api/payment-details` (no params, scope override
    `payment-details:read` lives server-side).
  - `CreateSaleInput` adds optional `expectedTotalCents?: number | null`
    (Zod `.int().min(0).nullish()`); when the tool sends it, it sends the
    persisted cart value, never the model's input.
  - `BotSaleResponse` adds `discountCents: number` (`0` when no promo).
  - `ChatbotApiError.responseBody.error` (the backend envelope field) is
    surfaced as `ChatbotApiError.errorCode: string | null` so tools can
    branch on `PROMO_RE_QUOTE`, `PRICE_OUT_OF_DATE`,
    `IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_IN_FLIGHT`,
    `INVALID_IDEMPOTENCY_KEY`, `NO_ACTIVE_PAYMENT_DETAIL` without parsing
    message strings.
- **`createSale` tool** (`src/sale-flow/application/tools/create-sale.tool.ts`):
  - Adds `expectedTotalCents` to the outgoing `CreateSaleInput` from the
    persisted `CartState.expectedTotalCents` (set by the last
    `evaluateCart` success path; absent → field omitted, never `0`).
  - Branches on `errorCode === 'PROMO_RE_QUOTE'`: returns `{ ok: false,
    error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents,
    expectedTotalCents, discountCents } }` — a **new discriminated kind**.
    The cart is **NOT cleared**; `idempotencyKey` **IS cleared** so the
    model's next `createSale` mints a fresh key per Q3 rule.
  - Branches on `errorCode === 'IDEMPOTENCY_KEY_IN_FLIGHT'`: returns `{ ok:
    false, error: { kind: 'idempotencyInFlight', retryable: true } }` —
    the model waits and retries the same call.
  - Branches on `errorCode === 'IDEMPOTENCY_KEY_CONFLICT'`: returns `{ ok:
    false, error: { kind: 'idempotencyConflict', retryable: false } }`
    and **clears** the persisted `idempotencyKey` so the next call mints a
    fresh key.
  - Branches on `errorCode === 'PRICE_OUT_OF_DATE'`: unchanged from today
    (validation, retryable false).
  - Branches on `errorCode === 'INVALID_IDEMPOTENCY_KEY'`: validation
    (retryable false); should be unreachable because the bot mints a UUID
    v4 ≤ 36 chars, but the branch is wired so a regression is visible.
  - On `{ ok: true, ...sale }`, extracts `discountCents` from the response
    and the tool's success envelope surfaces it to the model so the
    confirmation message ("Descuento aplicado: $X") can render.
- **`evaluateCart` tool** (`src/sale-flow/application/tools/evaluate-cart.tool.ts`):
  - Persists the response's `totalCents` as
    `CartState.expectedTotalCents` so a later `createSale` can send it
    without the model needing to remember. The field is **optional** in
    `CartState`; legacy carts read as `undefined` and `createSale`
    omits `expectedTotalCents` on the wire (backwards-compatible with the
    archived slice).
- **`CartState`** (`src/sale-flow/domain/cart-state.ts`): adds
  `expectedTotalCents?: number`; `isCartState` guard accepts the missing
  field for legacy carts. `readCart`/`writeCart` are pure add-ons — no
  behavioural change for existing callers.
- **Removal of the boot-time seam**:
  - **Delete** `src/sale-flow/domain/bank-details.provider.ts` (the port
    and `BANK_DETAILS_PROVIDER` symbol).
  - **Delete** `src/sale-flow/infrastructure/null-bank-details.provider.ts`.
  - **Remove** the `BANK_DETAILS_PROVIDER` binding from
    `src/sale-flow/sale-flow.module.ts`.
  - **Remove** the `BANK_DETAILS_PROVIDER` import + factory in
    `src/llm-agent/llm-agent.module.ts`; the `LLM_AGENT_SYSTEM_PROMPT`
    factory collapses back to `SYSTEM_PROMPT + '\n\n' +
    SALE_FLOW_INSTRUCTIONS` (no more `renderBankDetailsBlock` call).
  - **Remove** `bankDetails` from `ToolDeps` (delete the
    `bankDetails: BankDetailsProvider` field); `RealToolRegistry` drops
    the `@Inject(BANK_DETAILS_PROVIDER)` constructor param and stops
    passing `bankDetails` to the nine existing factories.
  - **Delete** `composeSaleFlowSystemPrompt`'s `bankDetails` parameter
    and the `renderBankDetailsBlock` export; the function becomes
    `(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`. The
    `sale-flow-instructions.spec.ts` is updated to reflect the new
    signature; the literal itself is unchanged.
  - **Delete** `BankDetails` type and any references in `tool-deps.ts` /
    `real-tool-registry.ts` / `create-sale.tool.ts` etc.
- **Tests** (strict TDD per `openspec/config.yaml` `rules.apply.tdd: true`):
  - Unit per new/changed tool (mock `ChatbotApiClient`, assert error-code
    discrimination for all 5 new branches, assert `expectedTotalCents` is
    sourced from the cart and never from model input, assert `discountCents`
    is surfaced on success).
  - `error-mapping.ts` grows 5 new discriminated `kind`s
    (`noActivePaymentDetail`, `promoReQuote`, `idempotencyInFlight`,
    `idempotencyConflict`, `priceOutOfDate`) keyed off
    `ChatbotApiError.errorCode`; `priceOutOfDate` is folded in to replace
    today's blanket 4xx→validation mapping for the `createSale` path.
  - `CartState` spec adds the `expectedTotalCents` round-trip case.
  - `RealToolRegistry` spec asserts the registry now exposes **exactly 10
    keys** including `getPaymentDetails`.
  - `SaleFlowModule` spec asserts `BANK_DETAILS_PROVIDER` is **not** in
    the providers list and `RealToolRegistry` does **not** inject it.
  - `LlmAgentModule` spec asserts `LLM_AGENT_SYSTEM_PROMPT` resolves to
    `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` byte-identical (no
    bank block appended, no `await bankDetails.get()` call in the
    factory).
  - `ChatbotApiHttpClient` spec asserts `createSale` sends
    `expectedTotalCents` when present and omits it when absent; asserts
    `getPaymentDetails` hits `/chatbot-api/payment-details` with `GET`.
  - `provisioning-bot-cashier.md` (new docs file) contains the Q4
    coordination checklist.
- **No env changes.** No new packages. `crypto.randomUUID()` and the
  existing `ai` + `zod` deps are sufficient.

### Out of Scope

- **Backend code** (READ-ONLY constraint, hard). Backend work for Q1/Q2/Q3
  is already merged in `chatbot-sale-flow-blockers` (archived
  2026-08-24). The bot does not modify or relocate any backend file.
- **Shipping / Skydropx** (R2–R5), **card payment / Link EVO** (R16),
  **image recognition** (R1), **human-handoff channel rework** (R6/R7/R14),
  **cancel endpoint** (Q8 / `POST /chatbot-api/sales/:saleId/cancel`),
  **`evaluate-cart` coverage beyond `PRODUCT_DISCOUNT`** (Q5 — confirmed
  unchanged), **partial customer DTO** (Q6 — deferred), **`phoneCountryCode`
  validation in order-history** (Q7 — deferred). All logged as follow-up
  slices.
- **Provisioning code.** No env additions, no credential-creation logic, no
  user-seeding scripts. Coordination lives in
  `docs/provisioning-bot-cashier.md` only.
- **`AGENTS.md` updates.** §4.4 endpoint table does not yet list
  `GET /chatbot-api/payment-details` or the `expectedTotalCents` /
  `discountCents` fields. The backend's `PROGRAM-CONTEXT.md` §4.4 was
  already updated (Q1/Q2/Q3 responses, 2026-08-24); a follow-up
  `chatbot-api-doc-sync` change reconciles `AGENTS.md` after the bot is
  verified against the new contract.
- **Q5 / Q6 / Q7 spec changes.** They are no-change confirmations per the
  backend responses; the existing `evaluate-cart` / `upsert-customer` /
  `get-order-history` behaviours stay exactly as the archived slice
  shipped them.
- **`CartState` migration of legacy carts.** The `expectedTotalCents?`
  field is optional; legacy carts read as `undefined` and behave
  identically. No data backfill, no `ConversationStore` migration.

## Capabilities

### Modified Capabilities

- **`sale-flow-tools`** (`openspec/specs/sale-flow-tools/spec.md`) — the
  registry grows from 9 tools to 10 (`getPaymentDetails` added); the
  `BankDetailsProvider` port + null-impl + `BANK_DETAILS_PROVIDER` binding
  + boot-time prompt composition are removed; `CartState` gains the
  `expectedTotalCents` field; `createSale` extends its outgoing DTO with
  `expectedTotalCents` and handles 5 new discriminated error codes; the
  confirmation message renders `discountCents > 0`; `ChatbotApiError`
  surfaces the backend's `error` envelope field for code-based
  discrimination. Spec scenarios added for: R11 happy path, R11
  `NO_ACTIVE_PAYMENT_DETAIL` (human-handoff), R13 `PROMO_RE_QUOTE` happy
  path (re-confirm + new key), R13 `PROMO_RE_QUOTE` decline path (cart
  preserved, key cleared), Q3 idempotency conflict/in-flight branches,
  Q3 key rotation on `PROMO_RE_QUOTE`, `discountCents` rendering.
- **`chatbot-api-client`** (`openspec/specs/chatbot-api-client/spec.md`) —
  port gains `getPaymentDetails()`; `CreateSaleInput` gains optional
  `expectedTotalCents`; `BotSaleResponse` gains `discountCents`;
  `ChatbotApiError` gains `errorCode: string | null` passthrough. New DTO
  spec: `PaymentDetail { id, bankName, beneficiary, clabe,
  accountNumber, isActive, updatedAt }` (bot-safe projection, no
  `tenantId`, no `createdAt` per backend response).

### Unchanged Capabilities

- **`llm-agent`** — the system-prompt composition simplifies (drops the
  `bankDetails` injection) but the literal `SYSTEM_PROMPT` is
  byte-identical and `SALE_FLOW_INSTRUCTIONS` is byte-identical (step 12
  already carries the human-handoff phrase). No spec delta for
  `llm-agent` beyond an updated scenario for the prompt factory signature.
- **`conversation-store`** — no schema change. `CartState` lives under
  `ConversationState.data.cart` as before; the new field is
  backwards-compatible.
- **`whatsapp-sender`**, **`whatsapp-webhook`**, **`app-config`** — no
  delta.

## Approach

**Architecture follow-through**: keep the screaming-layout NestJS module
from `sale-flow`. Files land under
`src/sale-flow/{domain, application, infrastructure}/…` and
`src/chatbot-api/{domain, infrastructure}/…`. The "chatbot is
consumer-only" constraint stays (no direct DB writes; all writes go
through chatbot-api).

**Tool pattern**: each new/changed tool follows the existing factory
shape `(deps: { chatbotApi, store, cashierUserId }) → tool({ description,
inputSchema, execute })`. The old `bankDetails` field is gone from
`ToolDeps`. `execute` wraps `mapChatbotError`; the error-mapping layer
now discriminates on `ChatbotApiError.errorCode` for the 5 new branches.

**Cart state**: persisted at `ConversationState.data.cart`; new field
`expectedTotalCents?: number` is set by `evaluateCart` on success and
read by `createSale`. On `PROMO_RE_QUOTE` / `IDEMPOTENCY_KEY_CONFLICT`
the key is cleared so the next call mints fresh; the items and
`expectedTotalCents` stay (the customer's intent is preserved).

**Prompt composition**: `composeSaleFlowSystemPrompt` collapses to
`(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`. Step 12 of
the literal stays byte-identical; the new `getPaymentDetails` tool is
the runtime source for the bank block. The prompt's instruction
("Llama a `getPaymentDetails` después de que `createSale` confirme …
Si devuelve 404 NO_ACTIVE_PAYMENT_DETAIL, di EXACTAMENTE: 'en un
momento un agente te comparte los datos de pago'") is the only textual
addition — the existing phrasing is preserved verbatim.

**Idempotency**: `createSale` mints a UUID v4 with `crypto.randomUUID()`
on the first call attempt and persists it to the cart. The Q3 contract
adds these branches:
- Identical-payload retry within the same session → reuse the key
  (existing behaviour, unchanged).
- `IDEMPOTENCY_KEY_IN_FLIGHT` → return `idempotencyInFlight`
  (`retryable: true`); model retries the same call later.
- `IDEMPOTENCY_KEY_CONFLICT` → clear the persisted key; return
  `idempotencyConflict` (`retryable: false`); model's next attempt
  mints a fresh key.
- `PROMO_RE_QUOTE` → clear the persisted key (payload changed); return
  `promoReQuote` (`retryable: false`) with the new totals surfaced; on
  model re-acceptance the new call mints a fresh key.
- `INVALID_IDEMPOTENCY_KEY` → validation (the bot mints UUID v4, so this
  is a defensive branch).

**Strict TDD**: failing test first (red), minimal impl to green,
refactor when green. Test commands: `pnpm test`, `pnpm test:cov`,
`pnpm test:e2e`. Coverage threshold 80%.

**Backend answers already merged**:
- Q1 endpoint lives at backend's `openspec/specs/payment-details/spec.md`
  and is reachable via the existing
  `ChatbotApiHttpClient.request('GET', '/chatbot-api/payment-details')`
  pattern.
- Q2 / Q3 contract changes are reachable via the existing
  `ChatbotApiHttpClient.request('POST', '/chatbot-api/sales', …)` pattern
  — no transport changes needed, only DTO + error-shape extensions.

## Affected Areas

| Area | Impact |
|------|--------|
| `src/sale-flow/application/tools/get-payment-details.tool.ts` | **New**: 10th AI-SDK tool, wraps `getPaymentDetails()` |
| `src/sale-flow/application/tools/create-sale.tool.ts` | **Modified**: send `expectedTotalCents`, branch on `PROMO_RE_QUOTE` / `IDEMPOTENCY_KEY_*`, surface `discountCents`, clear idempotency key on conflict/requote |
| `src/sale-flow/application/tools/evaluate-cart.tool.ts` | **Modified**: persist `expectedTotalCents` on the cart from the response's `totalCents` |
| `src/sale-flow/application/error-mapping.ts` + `error-mapping.spec.ts` | **Modified**: 5 new discriminated `kind`s keyed off `ChatbotApiError.errorCode`; `priceOutOfDate` folded in |
| `src/sale-flow/domain/cart-state.ts` + `cart-state.spec.ts` | **Modified**: add optional `expectedTotalCents?: number`; `isCartState` guard accepts legacy carts |
| `src/sale-flow/domain/tool-result.ts` | **Modified**: add the 5 new `ToolErrorKind` literals |
| `src/sale-flow/domain/bank-details.provider.ts` | **DELETED** |
| `src/sale-flow/infrastructure/null-bank-details.provider.ts` | **DELETED** |
| `src/sale-flow/domain/sale-flow-instructions.ts` + `sale-flow-instructions.spec.ts` | **Modified**: `composeSaleFlowSystemPrompt(base)` (drop `bankDetails` param); `renderBankDetailsBlock` deleted; `BankDetails` type deleted; `SALE_FLOW_INSTRUCTIONS` literal: add the new step-12 instruction about `getPaymentDetails` (human-handoff phrase unchanged, byte-identical) |
| `src/sale-flow/application/tool-deps.ts` | **Modified**: drop `bankDetails: BankDetailsProvider` from `ToolDeps` |
| `src/sale-flow/infrastructure/real-tool-registry.ts` + `real-tool-registry.spec.ts` | **Modified**: drop `@Inject(BANK_DETAILS_PROVIDER)`; wire the 10th tool `getPaymentDetails` |
| `src/sale-flow/sale-flow.module.ts` + `sale-flow.module.spec.ts` | **Modified**: drop `BANK_DETAILS_PROVIDER` binding; drop `NullBankDetailsProvider` import |
| `src/llm-agent/llm-agent.module.ts` + `llm-agent.module.spec.ts` | **Modified**: drop `BANK_DETAILS_PROVIDER` import; collapse `LLM_AGENT_SYSTEM_PROMPT` factory to `composeSaleFlowSystemPrompt(SYSTEM_PROMPT)` (no `await bankDetails.get()`) |
| `src/chatbot-api/domain/chatbot-api.client.ts` | **Modified**: add `getPaymentDetails(): Promise<PaymentDetail>`; `CreateSaleInput` gains `expectedTotalCents?`; `BotSaleResponse` gains `discountCents` |
| `src/chatbot-api/domain/dtos/sales.dto.ts` + `pricing.dto.ts` | **Modified**: new `PaymentDetail` DTO; extend `CreateSaleInput` + `BotSaleResponse` |
| `src/chatbot-api/domain/errors.ts` | **Modified**: `ChatbotApiError` gains `errorCode: string \| null` (sourced from `responseBody.error`) |
| `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` + `*.spec.ts` | **Modified**: `createSale` forwards `expectedTotalCents` when present; new `getPaymentDetails()` GET; `mapError` populates `errorCode` from `responseBody.error` |
| `docs/provisioning-bot-cashier.md` | **New**: Q4 coordination checklist (bot cashier `User` + `ServiceCredential` with `payment-details:read` scope) |
| `openspec/specs/sale-flow-tools/spec.md` (delta.md) | **Modified**: 10 tools, 5 new error-code branches, `expectedTotalCents` / `discountCents` scenarios, bank-details-runtime-tool scenarios |
| `openspec/specs/chatbot-api-client/spec.md` (delta.md) | **Modified**: new method, new DTO fields, `errorCode` passthrough |
| `docs/backend-questions-sale-flow-responses.md`, `AGENTS.md` | **UNCHANGED** (referenced; the AGENTS.md §4.4 sync is logged as follow-up) |
| `openspec/specs/llm-agent/spec.md` | **UNCHANGED** (system-prompt literal byte-identical; factory signature change is internal) |

## Risks

| # | Risk | Lik | Impact | Mitigation |
|---|------|-----|--------|-----------|
| R-1 | **Stale `ChatbotApiError.errorCode` mapping.** If the backend ever renames an `error` envelope field, the bot's 5 new branches silently fall back to today's blanket 4xx→validation mapping. | Med | Med | The branch order in `error-mapping.ts` is `errorCode`-first; the spec scenario asserts that for every new code the corresponding `kind` wins (no fallback). A new spec scenario for `errorCode === undefined` (legacy backend) still maps to `validation` so the bot degrades safely. |
| R-2 | **`PROMO_RE_QUOTE` produces a runaway retry loop** if the model keeps re-emitting `createSale` without fresh totals. | Low | Med | The branch returns `retryable: false`; the prompt step 11 is updated to make `PROMO_RE_QUOTE` a single re-confirmation round, not an auto-retry. Spec scenario pins exactly one re-emit with a fresh key on customer acceptance. |
| R-3 | **Removal of the boot-time `BankDetailsProvider` breaks a downstream consumer** we haven't audited. | Low | Med | `grep` shows `BANK_DETAILS_PROVIDER` / `BankDetailsProvider` / `bankDetails` are referenced only in: `bank-details.provider.ts` (deleted), `null-bank-details.provider.ts` (deleted), `tool-deps.ts` (modified), `real-tool-registry.ts` (modified), `llm-agent.module.ts` (modified), `sale-flow.module.ts` (modified), `sale-flow-instructions.ts` (modified). No other imports. The archive report for `sale-flow` (2026-08-24) confirms the same. |
| R-4 | **`expectedTotalCents` drift between `evaluateCart` and a subsequent cart edit.** If the customer edits a quantity after `evaluateCart` runs, `expectedTotalCents` becomes stale; `createSale` then sends a wrong guard and triggers `PROMO_RE_QUOTE` even when no promo changed. | Med | Med | The spec scenario asserts that `evaluateCart` re-runs on any cart mutation before `createSale` can be called (model-driven; pinned by step-8 of the literal: "Llama a `evaluateCart` … antes de pedir confirmación"). The model's prompt already enforces this; we document the invariant. |
| R-5 | **`AGENTS.md` §4.4 is now out of date.** It does not list `GET /chatbot-api/payment-details` nor the `expectedTotalCents` / `discountCents` fields. Future contract audits would miss them. | Med | Med | A follow-up change `chatbot-api-doc-sync` reconciles §4.4 from the backend's `PROGRAM-CONTEXT.md` §4.4. The bot code is the source of truth for the next 2 weeks. |
| R-6 | **Spec drift already present** (carry-over from R-D in the archived slice): `llm-agent` spec mentions Vercel AI Gateway + `AI_GATEWAY_API_KEY`, impl uses `@ai-sdk/openai` + `OPENAI_API_KEY`. This slice does not touch the LLM provider. | Med | Med | Unchanged from archive; logged as follow-up `llm-agent-provider-spec-sync`. |
| R-7 | **`discountCents` rendering shows a misleading value if the backend's response has a stale `discountCents` (e.g. promo revoked between `PROMO_RE_QUOTE` and the final `createSale`).** | Low | Low | The displayed value is the one the backend returned on the *final* `createSale`; if the customer disagrees they can decline the next round. The message says "Descuento aplicado: $X" (past tense, fixed amount), not a guarantee of future pricing. |
| R-8 | **`getPaymentDetails` exposed to the model at every turn.** The AI-SDK toolset is available to every agent turn; a customer could theoretically provoke the model to call `getPaymentDetails` before `createSale` succeeded. | Low | Low | Step 12 of the prompt literal explicitly forbids calling it before `createSale`. The spec scenario asserts the prompt contains the gating language. The tool itself does not gate — the prompt does. |
| R-9 | **No env / provisioning changes in this slice mean a misconfigured deployment could 401 / 403 on the new scope.** | Med | Med | Boot-time validation already requires `CHATBOT_API_CASHIER_USER_ID` (archived slice). The new scope `payment-details:read` is provisioned by the backend team per `docs/provisioning-bot-cashier.md`; the bot surfaces a `forbidden` error envelope (existing kind) and the operator sees the failure. |
| R-10 | **Idempotency key rotated but customer re-sends the same payload verbatim.** Per Q3 the bot must NOT reuse a key after a `PROMO_RE_QUOTE` even if the model would emit the same `createSale` body. | Low | Med | The `createSale` tool always clears `idempotencyKey` on `PROMO_RE_QUOTE` and `IDEMPOTENCY_KEY_CONFLICT`; the next mint is fresh via `crypto.randomUUID()`. The spec scenario asserts the second call's key differs from the first by structure (UUID v4 vs. the prior value). |

## Rollback

Two clean rollback paths, used depending on what goes wrong:

1. **Behaviour rollback** — re-introduce the boot-time seam and revert the
   `createSale` / `evaluateCart` changes. Concrete steps:
   - Re-add `BankDetailsProvider` port + `NullBankDetailsProvider` + the
     `BANK_DETAILS_PROVIDER` binding; restore `composeSaleFlowSystemPrompt`'s
     `bankDetails` parameter and `renderBankDetailsBlock`.
   - Restore `bankDetails` in `ToolDeps`; restore `@Inject(BANK_DETAILS_PROVIDER)`
     in `RealToolRegistry`; restore the `LLM_AGENT_SYSTEM_PROMPT` factory
     injection.
   - Revert `createSale` to the archived behaviour (no `expectedTotalCents`,
     no `PROMO_RE_QUOTE` branch, no `errorCode` discrimination).
   - Revert `evaluateCart` to NOT persist `expectedTotalCents`.
   - **Keep** the `getPaymentDetails` tool registered but stop relying on
     it (the prompt's step 12 reverts to the human-handoff branch).
   - The bot immediately returns to the archived slice's "wait for human"
     behaviour on R11; R13 sales succeed at list price only; idempotency
     contract reverts to the relaxed archived behaviour. No data is lost
     (cart state remains; the `expectedTotalCents` field is optional and
     ignored by the reverted path).
2. **Code rollback** — revert the merge commit. Conventional single-PR
   delivery keeps the revert to one commit. The archived slice's
   `composeSaleFlowSystemPrompt`, `NullBankDetailsProvider`, and
   list-price `createSale` are still in git history; no destructive
   deletes occur (git tracks renames).

## Dependencies

### Existing (no change)

- `houndfe-backend` chatbot-api (read-only) — 11 endpoints documented in
  the backend's `PROGRAM-CONTEXT.md` §4.4 (was 9; `payment-details` and
  `discountCents` were added by `chatbot-sale-flow-blockers`).
- `ChatbotApiHttpClient`
  (`src/chatbot-api/infrastructure/chatbot-api-http.client.ts`) — already
  has the `request()` transport path that the new `getPaymentDetails()`
  and extended `createSale()` reuse.
- `ConversationStore` (`src/conversation/infrastructure/`) — UPSERT
  contract supports the extended `cart` state bag (`expectedTotalCents`
  is optional).
- `ai` (Vercel AI SDK) + `zod` — already added by the
  `llm-agent-conversation-persistence` slice.
- `crypto.randomUUID()` — Node built-in for the idempotency key.

### New (package additions, if any)

- None expected. All required primitives are already in the tree.

### External (blocking for live sales, NOT for code)

- Seeded bot cashier `User` record (`AGENTS.md` §5.3) — backend team seed.
- `ServiceCredential` with scopes `catalog:read, pricing:evaluate,
  customers:read, customers:write, sales:create, sales:write,
  payment-details:read` (the new scope is the delta from the archived
  slice's 6 scopes). Provisioning checklist:
  `docs/provisioning-bot-cashier.md` (this slice).
- At least one active `PaymentDetail` per branch/tenant — backend team
  seed. Without this, every `getPaymentDetails()` returns `404
  NO_ACTIVE_PAYMENT_DETAIL` and the bot enters the human-handoff branch
  for every sale (operational, not a crash).

## Success Criteria

- [ ] 10 tools registered via `RealToolRegistry`; `getPaymentDetails` is
      the 10th key and behaves per the spec (200 success, 404
      `NO_ACTIVE_PAYMENT_DETAIL` → human-handoff prompt branch).
- [ ] `BankDetailsProvider` port, `NullBankDetailsProvider`,
      `BANK_DETAILS_PROVIDER` module binding, and the boot-time bank
      block in `composeSaleFlowSystemPrompt` are **removed** from the
      codebase (verified by `git grep BANK_DETAILS_PROVIDER` returning
      nothing).
- [ ] `LLM_AGENT_SYSTEM_PROMPT` resolves to `SYSTEM_PROMPT + '\n\n' +
      SALE_FLOW_INSTRUCTIONS` byte-identical (no bank block appended,
      no `await bankDetails.get()` call in the factory).
- [ ] `CartState` includes `expectedTotalCents?: number`; `isCartState`
      accepts the missing field (legacy carts); `evaluateCart` persists
      it; `createSale` reads it and sends it; legacy carts (no field)
      omit `expectedTotalCents` on the wire (backwards-compatible).
- [ ] `ChatbotApiError.errorCode` is populated from the backend's
      `responseBody.error` field for all 5xx / 4xx responses and is
      `null` only when the transport itself failed.
- [ ] `error-mapping.ts` discriminates 5 new `kind`s (`noActivePaymentDetail`,
      `promoReQuote`, `idempotencyInFlight`, `idempotencyConflict`,
      `priceOutOfDate`) keyed off `errorCode`; `createSale` wires all 5
      into the right cart-mutation path (clear key / preserve key).
- [ ] `createSale` clears the persisted `idempotencyKey` on
      `PROMO_RE_QUOTE`, `IDEMPOTENCY_KEY_CONFLICT`; preserves the key on
      `IDEMPOTENCY_KEY_IN_FLIGHT`; preserves `items` + `expectedTotalCents`
      on `PROMO_RE_QUOTE` decline path (cart is preserved, key cleared).
- [ ] `BotSaleResponse.discountCents` is surfaced on every successful
      `createSale`; the model's confirmation message renders "Descuento
      aplicado: $X" when `discountCents > 0` and omits the line when
      `discountCents === 0`.
- [ ] `ChatbotApiHttpClient.createSale` forwards `expectedTotalCents`
      when present in the DTO and omits the key entirely when absent;
      `getPaymentDetails()` issues `GET /chatbot-api/payment-details`
      with no params and no body.
- [ ] `pnpm test` and `pnpm test:e2e` are green; `pnpm build` is clean.
- [ ] `pnpm lint` passes on changed files (repo-wide lint is broken
      pre-existing; use scoped `pnpm exec eslint src/sale-flow
      src/chatbot-api src/llm-agent`).
- [ ] `docs/provisioning-bot-cashier.md` exists and contains the Q4
      coordination checklist (bot cashier `User` + `ServiceCredential`
      with `payment-details:read` scope, plus the 6 existing scopes;
      one credential per branch).
- [ ] Two spec files are updated with deltas: `openspec/specs/sale-flow-tools/spec.md`
      and `openspec/specs/chatbot-api-client/spec.md`. All new scenarios
      are Given/When/Then with RFC 2119 keywords.
- [ ] Manual smoke test against a sandbox backend with `payment-details:read`
      provisioned: bot browses → builds a 2-item cart → evaluates pricing
      → upserts customer → creates a sale with `expectedTotalCents` →
      sees `discountCents > 0` rendered → calls `getPaymentDetails` →
      renders the transfer message; on a promo that re-quotes between
      evaluate and confirm, the bot shows the new total, asks for
      confirmation, and on acceptance re-emits `createSale` with a fresh
      UUID v4 key.
- [ ] Follow-up backlog items created (Engram, project
      `houndfe-chatbot`): `chatbot-api-doc-sync` (AGENTS.md §4.4
      reconciliation), `llm-agent-provider-spec-sync` (carry-over),
      `evaluate-cart-coverage-expansion` (Q5 follow-up), `partial-customer-dto`
      (Q6 follow-up), `order-history-phone-country-code-validation`
      (Q7 follow-up), `cancel-endpoint-conversational` (Q8 follow-up).

## Follow-up Slices (out of scope, tracked here so they are not lost)

1. **`chatbot-api-doc-sync`** — reconcile `AGENTS.md` §4.4 with the
   backend's `PROGRAM-CONTEXT.md` §4.4 (now 11 endpoints; add
   `payment-details:read` scope; document `expectedTotalCents` /
   `discountCents` fields and the 4 idempotency error codes). Risk R-5.
2. **Shipping quote slice** (R2–R5) — depends on backend Skydropx
   integration; unlocks `updateDelivery` end-to-end in the flow.
3. **`evaluate-cart` coverage expansion** (Q5) — depends on backend
   re-using the full promo engine inside `evaluate-cart` (today only
   `PRODUCT_DISCOUNT` is supported in that endpoint; the
   server-side `confirmBotSale` re-evaluation covers the gap).
4. **Partial customer DTO** (Q6) — depends on backend relaxing
   `PUT /chatbot-api/customers/by-phone` to allow `address` / `street`
   optional.
5. **`phoneCountryCode` validation in order-history** (Q7) — depends on
   backend adding a `@Query()` DTO to
   `GET /chatbot-api/customers/by-phone/:phone/orders`.
6. **Cancel endpoint (Q8)** — `POST /chatbot-api/sales/:saleId/cancel`
   is documented in the backend but unused by the bot; conversational
   cancellation is a future slice.
7. **Card payment / Link EVO** (R16) — depends on Link EVO partner
   integration.
8. **Image-recognition** (R1), **human-handoff channel rework**
   (R6/R7/R14), **WhatsApp media hosting** (AGENTS.md §11 item 12) —
   all future slices, unchanged from the archived `sale-flow` proposal.
9. **`llm-agent-provider-spec-sync`** — small drive-by slice to bring
   `openspec/specs/llm-agent/spec.md` into alignment with the shipped
   `@ai-sdk/openai` + `OPENAI_API_KEY` implementation. Risk R-6.