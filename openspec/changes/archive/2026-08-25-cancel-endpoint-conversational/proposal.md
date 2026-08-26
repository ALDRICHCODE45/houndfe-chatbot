# Proposal: cancel-endpoint-conversational

## Intent

Add conversational order cancellation as the **11th sale-flow AI-SDK tool**
(`cancelSale`) wired to the already-documented but bot-unused backend endpoint
`POST /chatbot-api/sales/:saleId/cancel` (backend `PROGRAM-CONTEXT.md` §4.4.10,
`sales:write`). Today the bot can create, price, and attach a receipt to a
sale, but it has no way to *undo* the sale it just confirmed — the endpoint
exists server-side (Q8 follow-up, logged in the `sale-flow-contract-updates`
proposal) but no bot code touches it.

This slice is intentionally **narrow**: only the sale the bot **just confirmed
in the current session** is cancellable. To make that unambiguous, `createSale`
persists the returned `saleId` as `placedSaleId` in `ConversationState.data`
on success, and the new `cancelSale` tool reads that durable id (never a
model-supplied id), shows the customer the folio + total + status, asks for an
**explicit** "¿Confirmas la cancelación? Sí/No", and only then calls the
endpoint. Everything post-delivery (SHIPPED / DELIVERED, partial refunds,
returns) is **out of scope**; a backend precondition failure degrades to a
human handoff.

### Relationship to existing capabilities

- **MODIFIED `sale-flow-tools`** (`openspec/specs/sale-flow-tools/spec.md`):
  the 10-tool registry grows to 11 with `cancelSale`; `CartState` is **not**
  extended (the placed sale id is a sibling of the cart, not a cart line);
  `ConversationState.data` gains an optional `placedSaleId` field; the
  `SALE_FLOW_INSTRUCTIONS` literal gains a cancel step (new step 14) and the
  closing step is renumbered 14 → 15.
- **MODIFIED `chatbot-api-client`** (`openspec/specs/chatbot-api-client/spec.md`):
  `ChatbotApiClient` port gains `cancelSale(saleId, dto)`; new
  `CancelSaleInput` DTO (the 5-value `reason` enum + injected `cashierUserId`);
  the cancel response maps to its own `CancelSaleResult` DTO — `BotSaleResponse`
      is NOT reused. The backend `cancelSale` returns `{ saleId, status:
      'CANCELED', refundedCents, restockedItems, canceledAt }` (a different
      projection, confirmed at `src/sales/sales.service.ts` `buildResult`).
- **UNCHANGED**: `llm-agent` (no provider/prompt-composition change beyond the
  literal), `conversation-store` (the `data` bag is already an open
  `[key: string]: unknown`; `placedSaleId` only adds a typed convenience field),
  `whatsapp-sender`, `whatsapp-webhook`, `app-config`. No env additions — the
  bot already reads `CHATBOT_API_CASHIER_USER_ID` for `createSale`.
- **UNCHANGED backend code** (READ-ONLY constraint, hard).

### Authoritative user decisions encoded in this proposal

1. **Scope = just-confirmed sale only.** Only the sale `createSale` confirmed
   in the current session is cancellable. Historical orders and multi-order
   selection are **out** — the model is never allowed to pull a `saleId` from
   `getOrderHistory` and cancel it.
2. **Durable `placedSaleId`.** `createSale` persists `placedSaleId` in
   `ConversationState.data` on success so the model reads the id from durable
   state (zero ambiguity), and clears it on cancel success or when a new sale
   is placed.
3. **Explicit confirmation gate.** Before calling the endpoint, the bot shows
   folio + total + status and requests an explicit "¿Confirmas la cancelación?
   Sí/No"; the endpoint is only called after an explicit "sí". The confirmation
   is a conversational turn, not a tool parameter.
4. **`reason` and `cashierUserId` are never model-chosen.** `reason` is fixed
   to `CUSTOMER_REQUEST` in the tool (the conversational cancel is always
   customer-initiated; the other four enum values are operational/internal and
   unreachable from a customer asking "cancela mi pedido"). `cashierUserId` is
   injected from `deps.cashierUserId` (sourced from
   `CHATBOT_API_CASHIER_USER_ID`), exactly as `createSale` does today.
5. **Non-goals.** Post-delivery states (SHIPPED/DELIVERED), partial refunds,
   and returns are out. If the backend rejects the cancel because the sale is
   no longer cancellable, the bot degrades to a human handoff rather than
   retrying or fabricating an outcome.

## Business Problem / Customer Value

`docs/conversation-analysis.md` documents a transfer-payment sale flow where the
customer and "Andrea" build an order, confirm data, register the sale, and then
wait for the transfer receipt. The document's "POS sale lifecycle question"
notes the sale moves through **draft → confirmed → paid → shipped** states
(R15) and that the state machine was still open for design. In that flow there
is a real window between "sale confirmed" and "item shipped" where a customer
may notice a mistake — wrong quantity, wrong address, wrong product, or simply
changed their mind — and today the only recourse is to wait for a human.

This slice closes that window for the just-confirmed sale:

- **Customer value:** a customer who says "me equivoqué, cancela mi pedido"
  gets an immediate, in-conversation cancellation instead of a handoff, while
  the sale is still cancellable (before shipping).
- **Operational value:** fewer manual cancellation tickets for the
  human-in-the-loop cases the owner explicitly wants to keep for shipping
  quotes (R6) and out-of-stock (R7); the bot handles the low-risk, reversible
  correction itself.
- **Trust value:** the explicit folio + total + status confirmation and the
  "Sí/No" gate mirror the order-summary pattern the real conversation uses
  (R10), so the bot never cancels silently or surprises the customer.

## Scope

### In Scope

- **`cancelSale` tool** (`src/sale-flow/application/tools/cancel-sale.tool.ts`):
  AI-SDK `tool()` factory. `inputSchema: z.object({}).strict()` (no model
  inputs — the id, reason, and cashier id are all sourced server-side/state),
  `contextSchema: z.object({ senderId: z.string() })`. `execute`:
  1. Load state via `deps.store.get(senderId)`; read `placedSaleId` via
     `readPlacedSaleId(state)`.
  2. Missing → return `{ ok: false, error: { kind: 'missingPlacedSaleId',
     retryable: false } }` (no HTTP call).
  3. Call `deps.chatbotApi.cancelSale(placedSaleId, { reason:
     'CUSTOMER_REQUEST', cashierUserId: deps.cashierUserId })`.
  4. Success → clear `placedSaleId` (durable write) and return
     `{ ok: true, ...canceledSale }`.
  5. Error → error-code-first state-mutation policy (mirrors `createSale`):
     permanent codes (`saleNotFound`, `saleNotCancellable`, `idempotencyConflict`)
     clear `placedSaleId` (the id is now stale/unusable); transient codes
     (`rateLimit`, `upstream`, in-flight) preserve it so the model can retry;
     then return `mapChatbotError(err)`.
- **`createSale` success-path persistence**
  (`src/sale-flow/application/tools/create-sale.tool.ts`): replace the
  `persistCart(…, EMPTY_CART)` success write with a single atomic write that
  sets `data.cart = EMPTY_CART` **and** `data.placedSaleId = sale.id` (the
  returned `saleId`). This is one store round-trip — never two sequential
  `data`-replacing writes (the second would clobber the first's cart clear).
- **Placed-sale state helpers** (`src/sale-flow/application/cart-persistence.ts`,
  or a sibling `placed-sale` module): `readPlacedSaleId(state)`,
  `persistConfirmedSale(store, senderId, state, saleId)`, and
  `clearPlacedSaleId(store, senderId, state)`. `ConversationStateData` in
  `src/conversation/domain/conversation-store.ts` gains the typed optional
  field `placedSaleId?: string` (the open bag already permits it; the type
  documents the invariant).
- **`ChatbotApiClient` + HTTP impl** (`src/chatbot-api/domain/chatbot-api.client.ts`,
  `src/chatbot-api/infrastructure/chatbot-api-http.client.ts`):
  - `cancelSale(saleId: string, dto: CancelSaleInput): Promise<CancelSaleResult>`.
  - HTTP: `POST /chatbot-api/sales/${encodeURIComponent(saleId)}/cancel` with
    `data: dto`. **No `X-Idempotency-Key` header** — idempotency is
    backend-derived from `sale:cancel:<saleId>` (differs from `createSale`,
    which mints a client UUID).
  - DTO `CancelSaleInput { reason: 'CUSTOMER_REQUEST'|'ORDER_ERROR'|
    'OUT_OF_STOCK'|'DUPLICATE_SALE'|'OTHER'; cashierUserId: string }` in
    `src/chatbot-api/domain/dtos/sales.dto.ts`, with an optional
    `CancelSaleInputSchema` (Zod) for wire validation.
- **Error mapping + `ToolErrorKind`**
  (`src/sale-flow/domain/tool-result.ts`, `src/sale-flow/application/error-mapping.ts`):
  add kinds — `saleNotFound`, `saleNotCancellable` (backend errorCode-discriminated),
  reuses existing `idempotencyConflict` / `idempotencyInFlight`, and adds
  `missingPlacedSaleId` (client-side guard, not an errorCode). The backend does NOT
  emit a distinct "already canceled" code — a sale already `CANCELED` returns a
  **replay success** (`status: 'CANCELED'`), so the bot sees a normal success and
  clears `placedSaleId`. `mapChatbotError` gains errorCode-first cases for
  the cancel endpoint (see §Backend Contract); unknown codes fall through to
  the existing subclass/status mapping (404 → `notFound`, 403 → `forbidden`,
  4xx → `validation`, 5xx → `upstream`) so a code mismatch degrades safely.
- **Registry** (`src/sale-flow/infrastructure/real-tool-registry.ts`): add
  `cancelSale: makeCancelSaleTool(deps)` as the 11th key; bump the docstring
  "ten sale-flow tools" → "eleven sale-flow tools".
- **Prompt step** (`src/sale-flow/domain/sale-flow-instructions.ts`): insert a
  cancel step (new step 14) and renumber the closing step 14 → 15. The step
  encodes: just-confirmed-in-this-session only, never historical/multi-order,
  folio+total+status summary, explicit "Sí/No" confirmation before calling
  `cancelSale`, and the `saleNotCancellable` → human-handoff branch.
- **Contract-suite repair** (`src/sale-flow/application/tools/tool-contract.spec.ts`):
  the shared `factories` array is stale (9 entries, missing `getPaymentDetails`);
  it must list **all 11** tools, including `getPaymentDetails` and `cancelSale`.
- **Tests** (strict TDD per `openspec/config.yaml` `rules.apply.tdd: true`):
  - `cancel-sale.tool.spec.ts` — reads `placedSaleId` from state; guards on
    missing id; sends `reason: 'CUSTOMER_REQUEST'` + injected `cashierUserId`;
    clears `placedSaleId` on success and on permanent error codes; preserves it
    on transient; returns `{ ok: true, ...canceledSale }`.
  - `create-sale.tool.spec.ts` — asserts the success path persists
    `placedSaleId` **and** clears the cart in one write.
  - `error-mapping.spec.ts` — 3 new errorCode-first cases + fallback assertions.
  - `real-tool-registry.spec.ts` — registry exposes **exactly 11 keys**.
  - `sale-flow-instructions.spec.ts` — new step 14 + close renumbered to 15;
    explicit-confirmation phrase asserted byte-identical.
  - `chatbot-api-http.client.spec.ts` — `cancelSale` POSTs to
    `/chatbot-api/sales/:saleId/cancel` with the DTO body and **no**
    `X-Idempotency-Key` header.
  - `tool-contract.spec.ts` — `factories` covers all 11 tools.
- **Spec deltas**: `openspec/specs/sale-flow-tools/spec.md` (11 tools, cancel
  step, new error kinds, `placedSaleId` lifecycle) and
  `openspec/specs/chatbot-api-client/spec.md` (new method + DTO).

### Out of Scope (Non-Goals)

- **Historical / multi-order cancellation.** `getOrderHistory`-derived
  `saleId` cancellation and "which order do you mean?" disambiguation are out.
- **Post-delivery states.** SHIPPED / DELIVERED cancellation, partial refunds,
  returns, and restock-verification surfacing are out; the backend
  precondition failure → human handoff, the bot does not model refunds.
- **The other four `reason` enum values** (`ORDER_ERROR`, `OUT_OF_STOCK`,
  `DUPLICATE_SALE`, `OTHER`) — not reachable from the conversational flow;
  the DTO declares them for contract completeness but the tool hardcodes
  `CUSTOMER_REQUEST`.
- **Backend code.** The endpoint, derived idempotency key, restock/refund
  behavior, and `sale.canceled` emission are already implemented server-side
  (`PROGRAM-CONTEXT.md` §4.4.10). No backend file is touched.
- **`AGENTS.md` §4.4 endpoint-table sync.** The table still lists the original
  9 endpoints; `getPaymentDetails` and now `cancel` are documented in the
  backend's `PROGRAM-CONTEXT.md` §4.4 but not yet reconciled in `AGENTS.md`.
  Carried as the existing `chatbot-api-doc-sync` follow-up, not this slice.
- **Returning-customer reorder** (R12), **shipping** (R2–R5), **card payment /
  Link EVO** (R16), **image recognition** (R1), **human-handoff channel rework**
  (R6/R7/R14) — unchanged future slices.

## Current-State Gap

- **10 tools, no cancel.** `RealToolRegistry` registers `searchCatalog`,
  `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`,
  `createSale`, `attachReceipt`, `updateDelivery`, `getOrderHistory`,
  `getPaymentDetails`. The endpoint `POST /chatbot-api/sales/:saleId/cancel`
  is absent from `ChatbotApiClient` entirely.
- **`createSale` clears the cart and drops the id.** On success it calls
  `persistCart(deps.store, senderId, state, EMPTY_CART)` and returns
  `{ ok: true, ...sale }`. The `saleId` lives **only** in the tool-result
  content of the conversation transcript — nothing persists it durably. There
  is no `saleId` in `CartState` (which holds only `items`, `idempotencyKey`,
  and optional `expectedTotalCents`).
- **No durable "which sale just confirmed" signal.** `ConversationState.data`
  is an open bag (`messages?` + arbitrary keys), but no key records the placed
  sale. A `cancelSale` tool cannot be made unambiguous without adding one.
- **Stale contract suite.** `tool-contract.spec.ts` lists only 9 factories and
  silently omits `getPaymentDetails` — a drift that would hide an 11-tool
  regression if left unfixed.
- **No cancel instructions.** `SALE_FLOW_INSTRUCTIONS` is a 14-step linear
  escrow flow (greet → search → stock → cart → evaluate → customer → summary →
  createSale → getPaymentDetails → receipt → close) with no cancel step and no
  side-intent for "cancela mi pedido".
- **`ToolErrorKind` has no cancel vocabulary.** The 11 existing kinds
  (`auth`, `forbidden`, `notFound`, `rateLimit`, `upstream`, `validation`,
  `noActivePaymentDetail`, `promoReQuote`, `idempotencyInFlight`,
  `idempotencyConflict`, `priceOutOfDate`) cover create/evaluate/payment
  failures but nothing cancel-specific, so a cancel failure would collapse to
  a misleading `notFound` / `validation` / `upstream` message.

## Backend Contract

`POST /chatbot-api/sales/:saleId/cancel` (backend `PROGRAM-CONTEXT.md` §4.4.10):

| Property | Value |
|---|---|
| Method / path | `POST /chatbot-api/sales/:saleId/cancel` |
| Scope | `sales:write` |
| Idempotency | Derived key `sale:cancel:<saleId>` (backend-side; **no client `X-Idempotency-Key`**) |
| Body | `{ reason: 'CUSTOMER_REQUEST'\|'ORDER_ERROR'\|'OUT_OF_STOCK'\|'DUPLICATE_SALE'\|'OTHER', cashierUserId }` |
| Success | `200` → the canceled sale (`CancelSaleResult` projection) |
| Side effects | Restocks items, builds refunds, emits `sale.canceled`; `cashierUserId` → `canceledByUserId`; creator-ownership NOT enforced |

**Error handling (confirmed from backend `DomainExceptionFilter` + `SalesService.cancelSale`).** The
backend maps `BusinessRuleViolationError` codes this way; the HTTP client
surfaces the `code` verbatim as `ChatbotApiError.errorCode` (ADR-1/ADR-2). These
are the **confirmed** codes — plus an important nuance: a sale already `CANCELED`
returns a **replay success** (no error) rather than a distinct error code.

| errorCode (confirmed) | HTTP | New `ToolErrorKind` | Model behaviour |
|---|---|---|---|
| `SALE_NOT_FOUND` | 404 | `saleNotFound` (retryable: false) | "No encontré la venta" → no retry, clear `placedSaleId` |
| `SALE_NOT_CANCELLABLE` | 409 | `saleNotCancellable` (retryable: false) | "Ya no es posible cancelar por este medio" → **human handoff** |
| `SALE_DELIVERED_CANNOT_CANCEL` | 409 | `saleNotCancellable` (retryable: false) | "Ya fue entregada, no se puede cancelar" → **human handoff** |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | `idempotencyConflict` (retryable: false) | estado estable; `placedSaleId` ya limpio |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | `idempotencyInFlight` (retryable: true) | reintentar más tarde; preservar `placedSaleId` |
| *(missing placedSaleId, client-side)* | — | `missingPlacedSaleId` (retryable: false) | "No hay una venta reciente por cancelar" |
| *(any unrecognised code)* | 4xx/5xx | existing `notFound` / `forbidden` / `validation` / `upstream` | existing stable envelope |

## Proposed Change (concise)

1. **Persist `placedSaleId`.** `createSale` success writes `data.cart =
   EMPTY_CART` and `data.placedSaleId = sale.saleId` in one atomic
   `ConversationStore.update`. `cancelSale` success clears it; a new
   `createSale` overwrites it. A `readPlacedSaleId` accessor gives a
   `string | null` from any `ConversationState`.
2. **`cancelSale` tool (11th).** No model-supplied `saleId`/`reason`/
   `cashierUserId`; reads `placedSaleId` from state, sends
   `reason: 'CUSTOMER_REQUEST'` + injected `cashierUserId`, clears the id on
   success/permanent failure, preserves it on transient failure.
3. **Prompt step.** New step 14 for cancellation + close renumbered to 15, with
   the explicit "¿Confirmas la cancelación? Sí/No" gate and the
   `saleNotCancellable` → handoff branch. The model shows folio + total +
   status (from the `createSale` success result already in the current
   transcript) before asking for confirmation.
4. **Explicit-confirm flow.** The model never calls `cancelSale` directly on a
   customer's first "cancela"; it first re-shows the sale summary and waits for
   an explicit "sí".

## Edge Cases

| # | Case | Behaviour |
|---|---|---|
| 1 | Cancel requested after the sale was shipped/delivered | Backend returns `saleNotCancellable` (or equivalent) → model says cancellation is no longer possible by this channel and hands off to a human; `placedSaleId` cleared. Non-goal, but degradable. |
| 2 | Duplicate cancel (customer says "cancela" twice) | First call cancels and clears `placedSaleId`; the second call hits the `missingPlacedSaleId` guard → "no hay una venta reciente por cancelar". Backend idempotency (`sale:cancel:<saleId>`) also protects a same-id replay at the HTTP layer. |
| 3 | Already canceled server-side (out-of-band) | Backend idempotency returns a **replay success** (`status: 'CANCELED'`) — no error. The bot sees a normal success; a "ya estaba cancelada" nuance is surfaced by the model from the returned status; `placedSaleId` cleared. |
| 4 | Sale not found server-side | Backend returns `saleNotFound` → model reports no matching sale; `placedSaleId` cleared. |
| 5 | `placedSaleId` missing (no sale in this session, or a stale/idle-expired session) | Tool returns `missingPlacedSaleId` before any HTTP call → model says there is no recent sale to cancel (never fabricates a sale). |
| 6 | Transient backend failure (rate limit / 5xx / in-flight) | `placedSaleId` preserved; model may retry the same `cancelSale` call later (idempotent server-side). |
| 7 | `placedSaleId` from a prior session (idle-expired) | The explicit-confirm gate requires the model to show folio + total + status, which only exist in the current transcript. If the transcript was trimmed, the model cannot present the summary and must **not** cancel — it hands off instead of trusting the durable id alone. |

## Capabilities

### Modified Capabilities

- **`sale-flow-tools`** (`openspec/specs/sale-flow-tools/spec.md`) — registry
  grows from 10 to 11 tools; `cancelSale` reads the durable `placedSaleId`;
  `createSale` persists `placedSaleId` on success; `SALE_FLOW_INSTRUCTIONS`
  gains step 14 (cancel) and renumbers close to 15; four new `ToolErrorKind`
  literals. Spec scenarios added for the happy path, the explicit-confirm
  gate, each error branch, and the `placedSaleId` lifecycle
  (set → read → cleared).
- **`chatbot-api-client`** (`openspec/specs/chatbot-api-client/spec.md`) — port
  gains `cancelSale(saleId, dto)`; new `CancelSaleInput` DTO (5-value `reason`
  enum + `cashierUserId`); response maps to `CancelSaleResult` (NOT `BotSaleResponse`).

### Unchanged Capabilities

- **`llm-agent`** — no provider / registry-port change; only the composed
  literal's step list changes (owned by `sale-flow-tools`).
- **`conversation-store`** — no schema change; `data` remains an open bag, with
  a typed `placedSaleId?: string` convenience field.
- **`whatsapp-sender`**, **`whatsapp-webhook`**, **`app-config`** — no delta.
- **Backend** — READ-ONLY.

## Approach

**Architecture follow-through**: keep the screaming-layout NestJS modules from
`sale-flow`; new tool + persistence helpers land under
`src/sale-flow/{domain, application, infrastructure}/…`, DTO/method under
`src/chatbot-api/…`. The "chatbot is consumer-only" constraint holds (all
writes go through chatbot-api; no direct DB writes).

**Tool pattern**: `makeCancelSaleTool(deps: ToolDeps)` follows the existing
factory shape `(deps) → tool({ description, inputSchema, execute })`; it is the
most stateful of the mutating tools (reads `placedSaleId`, then mutates it on
the error-code policy) and mirrors `createSale`'s "the mapper is pure, the tool
owns the state write" rule (ADR-9): `mapChatbotError` stays pure; `cancelSale`
re-inspects `err.errorCode` for the `placedSaleId` write.

**Idempotency**: no client key. The backend derives `sale:cancel:<saleId>`; the
client must **not** send `X-Idempotency-Key` (unlike `createSale`). A same-sale
retry is safe server-side; the client-side `placedSaleId` clear after the first
success makes a second conversational attempt a no-op via the
`missingPlacedSaleId` guard.

**State lifecycle**: `placedSaleId` is set by `createSale` success, read by
`cancelSale`, cleared by `cancelSale` success / permanent failure / a new
`createSale`. It is never part of `CartState` (which is purely cart-creation
intent) — it is a sibling key in `data`.

**Prompt composition**: `composeSaleFlowSystemPrompt(base)` is unchanged; the
`SALE_FLOW_INSTRUCTIONS` literal adds step 14 (cancel) and renumbers close to
15. The `sale-flow-instructions.spec.ts` byte-identical snapshot is updated to
the new literal.

**Strict TDD**: failing test first (red), minimal impl (green), refactor.
Commands: `pnpm test`, `pnpm test:cov`, `pnpm test:e2e`. Coverage threshold 80%.

## Affected Areas

| Area | Impact |
|---|---|
| `src/sale-flow/application/tools/cancel-sale.tool.ts` | **New**: 11th tool, reads `placedSaleId`, calls `cancelSale`, owns the id-clearing policy |
| `src/sale-flow/application/tools/create-sale.tool.ts` | **Modified**: success path persists `placedSaleId` (atomic with cart clear) |
| `src/sale-flow/application/cart-persistence.ts` (or sibling `placed-sale` helper) | **Modified**: add `readPlacedSaleId`, `persistConfirmedSale`, `clearPlacedSaleId` |
| `src/sale-flow/domain/tool-result.ts` | **Modified**: add `saleNotFound`, `saleNotCancellable`, `missingPlacedSaleId` (reuses `idempotencyConflict`/`idempotencyInFlight`) |
| `src/sale-flow/application/error-mapping.ts` + `.spec.ts` | **Modified**: 3 errorCode-first cases + fallback assertions |
| `src/chatbot-api/domain/chatbot-api.client.ts` | **Modified**: add `cancelSale(saleId, dto)` |
| `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` + `.spec.ts` | **Modified**: `POST /sales/:saleId/cancel`, no idempotency header |
| `src/chatbot-api/domain/dtos/sales.dto.ts` | **Modified**: add `CancelSaleInput` + `CancelSaleInputSchema` |
| `src/sale-flow/infrastructure/real-tool-registry.ts` + `.spec.ts` | **Modified**: add `cancelSale`; docstring 10 → 11; exactly-11 assertion |
| `src/sale-flow/domain/sale-flow-instructions.ts` + `.spec.ts` | **Modified**: step 14 cancel + close renumbered to 15 |
| `src/sale-flow/application/tools/tool-contract.spec.ts` | **Modified**: `factories` covers all 11 (adds `getPaymentDetails` + `cancelSale`) |
| `src/conversation/domain/conversation-store.ts` | **Modified**: typed optional `placedSaleId?: string` on `ConversationStateData` |
| `openspec/specs/sale-flow-tools/spec.md` (delta) | **Modified**: 11 tools, cancel step, new error kinds, `placedSaleId` lifecycle |
| `openspec/specs/chatbot-api-client/spec.md` (delta) | **Modified**: new method + DTO |

## Risks

| # | Risk | Lik | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **Change budget ~400 lines.** New tool + tests + 2 client files + 2 spec deltas + prompt + contract-suite repair could exceed the 400-line review budget. | Med | Med | This is a single-tool slice (≈1/9th the `sale-flow` size), but tests dominate. Keep the tool + client additions lean — add a small `CancelSaleResult` DTO (do NOT reuse `BotSaleResponse`, it has a different shape) — and keep the spec delta to the minimum new scenarios. Split into at most two commits (state + tool; prompt + spec). |
| R-2 | **Exact cancel error codes are unconfirmed.** The backend envelope's `error` string values for "not found / already canceled / not cancellable" may differ from the candidates (`SALE_NOT_FOUND` etc.). | Med | Med | `mapChatbotError` is errorCode-first but falls back to the existing subclass/status mapping (404 → `notFound`, 4xx → `validation`), so a code mismatch degrades safely. Confirm the exact codes against `PROGRAM-CONTEXT.md` §4.4.10 during the spec/design phase; a one-line rename per case is the fix. Flagged in §Open Questions. |
| R-3 | **`placedSaleId` survives an idle timeout** and could be misread as "current session" on a later visit. | Med | Med | The explicit-confirm gate requires the model to show folio + total + status, which only exist in the current transcript. If the transcript is trimmed, the model cannot show the summary and must hand off rather than cancel (edge case 7). A follow-up can clear `placedSaleId` on idle-expiry if needed. |
| R-4 | **Model calls `cancelSale` without explicit confirmation** (skips the "Sí/No" gate). | Low | Med | The prompt step 14 mandates the summary + explicit-confirm turn; the spec snapshot asserts the gate wording. The tool itself can't enforce a conversational turn (it has no memory of the prior turn), so this is prompt-enforced — same trust model as `getPaymentDetails` gating (R-D6 in the archived slice). |
| R-5 | **Stale `tool-contract.spec.ts` hides the 11th tool** (already omits `getPaymentDetails`). | High | Low | The contract suite `factories` array is repaired to list all 11 in this slice; a missing-factory regression becomes a red test. |
| R-6 | **`deliveryStatus` is a free string** (`BotSaleResponse.deliveryStatus: string`), so "is this still cancellable?" is not client-checkable before the call. | Med | Low | The bot does not pre-gate on `deliveryStatus`; it relies on the backend precondition (which rejects SHIPPED/DELIVERED). The `saleNotCancellable` branch converts that rejection into a handoff. |
| R-7 | **`AGENTS.md` §4.4 still lacks the cancel endpoint** (and `getPaymentDetails`), so a future contract audit would miss it. | Med | Med | Carried in the existing `chatbot-api-doc-sync` follow-up; `PROGRAM-CONTEXT.md` §4.4.10 is the authoritative reference for this slice. |
| R-8 | **Hardcoding `reason: 'CUSTOMER_REQUEST'`** could be too rigid if the backend later wants a distinct reason for audit. | Low | Low | The DTO declares the full 5-value enum; only the tool hardcodes `CUSTOMER_REQUEST`. Relaxing to a model-visible reason (or a second `reason` param) is a one-line change with no contract churn. |

## Rollback

1. **Behaviour rollback** — drop `cancelSale` from `RealToolRegistry` (remove
   the key + import) and revert `createSale`'s success write to
   `persistCart(…, EMPTY_CART)`. The bot returns to the archived slice's
   behavior: cancellation requests fall through to the refusal phrase
   `esa función aún no está disponible` (or handoff). No data is lost — a
   leftover `placedSaleId` key in `data` is inert (no reader without the tool).
2. **Code rollback** — revert the merge commit. Single-developer branch + merge
   delivery keeps the revert to one commit; the archived slice's tool registry
   and `SALE_FLOW_INSTRUCTIONS` are intact in git history.

## Dependencies

### Existing (no change)

- `houndfe-backend` chatbot-api (read-only) — `POST /chatbot-api/sales/:saleId/cancel`
  already implemented (`PROGRAM-CONTEXT.md` §4.4.10).
- `ChatbotApiHttpClient.request()` transport — reused for the new POST.
- `ConversationStore.update()` UPSERT — supports the `placedSaleId` write.
- `ai` (Vercel AI SDK) + `zod` — already in the tree.
- `CHATBOT_API_CASHIER_USER_ID` — already boot-validated and injected via `ToolDeps`.

### New (package additions)

- None.

### External (blocking for live cancellation, NOT for code)

- The bot cashier `ServiceCredential` must already carry `sales:write` (it does
  — receipt attachment and delivery use the same scope). No new scope or seed
  is required for `cancel`; verify the credential's `sales:write` covers the
  cancel route in the sandbox backend.

## Success Criteria

- [ ] 11 tools registered via `RealToolRegistry`; `cancelSale` is the 11th key.
- [ ] `createSale` persists `placedSaleId` (from `sale.saleId`) and clears the
      cart in a single atomic `data` write on success.
- [ ] `cancelSale` reads `placedSaleId` from durable state, sends
      `reason: 'CUSTOMER_REQUEST'` + injected `cashierUserId`, returns
      `{ ok: true, ...canceledSale }` on 200, and clears `placedSaleId` on
      success and on permanent error codes (preserved on transient).
- [ ] `ChatbotApiHttpClient.cancelSale` issues `POST /chatbot-api/sales/:saleId/cancel`
      with the DTO body and **no** `X-Idempotency-Key` header.
- [ ] `error-mapping.ts` discriminates `saleNotFound` / `saleNotCancellable` /
      `idempotencyConflict` / `idempotencyInFlight` errorCode-first;
      `missingPlacedSaleId` is returned by the tool (not the mapper); unknown
      codes fall through to the existing status mapping.
- [ ] `tool-contract.spec.ts` `factories` lists all 11 tools (including the
      previously-missing `getPaymentDetails` and the new `cancelSale`).
- [ ] `SALE_FLOW_INSTRUCTIONS` step 14 (cancel) + close renumbered to 15; the
      explicit "¿Confirmas la cancelación? Sí/No" gate is asserted
      byte-identical in `sale-flow-instructions.spec.ts`.
- [ ] Two spec files updated with deltas: `openspec/specs/sale-flow-tools/spec.md`
      and `openspec/specs/chatbot-api-client/spec.md` (Given/When/Then + RFC 2119).
- [ ] `pnpm test` and `pnpm test:e2e` green; `pnpm build` clean.
- [ ] `pnpm lint` passes on changed files (scoped
      `pnpm exec eslint src/sale-flow src/chatbot-api src/conversation`).
- [ ] Manual smoke test against a sandbox backend: browse → build cart →
      evaluate → upsert customer → create sale → (customer) "cancela mi pedido"
      → bot shows folio + total + status → "¿Confirmas la cancelación? Sí/No" →
      "sí" → bot calls `cancelSale` → confirms cancellation; a second "cancela"
      returns "no hay una venta reciente por cancelar".

## Open Questions

1. **`CancelSaleResult` shape drift risk.** The backend `cancelBotSale` returns
   `SalesService.cancelSale`'s `buildResult` shape `{ saleId, status:
   "CANCELED", refundedCents, restockedItems, canceledAt }` verbatim (no
   adapter). The bot's `ChatbotApiClient.cancelSale` must define this as its own
   DTO (do NOT reuse `BotSaleResponse`). Confirmed against backend source:
   `src/chatbot-api/application/chatbot-api.service.ts:441` delegating to
   `src/sales/sales.service.ts:2567` `buildResult`. No other open questions —
   scope, persistence, confirmation gate, idempotency, and error codes are all
   locked.

## Follow-up Slices (out of scope, tracked here so they are not lost)

1. **`chatbot-api-doc-sync`** — reconcile `AGENTS.md` §4.4 with the backend's
   `PROGRAM-CONTEXT.md` §4.4 (add `payment-details`, `cancel`, and their scopes
   / error codes). Carry-over, now including §4.4.10.
2. **Historical / multi-order cancellation** — `getOrderHistory`-derived
   selection + "which order?" disambiguation, once the post-shipping refund
   rules are settled with the backend.
3. **Idle-expiry cleanup of `placedSaleId`** — clear the durable id when the
   agent runner detects an idle-expired session (if edge case 7 proves
   operationally noisy).
