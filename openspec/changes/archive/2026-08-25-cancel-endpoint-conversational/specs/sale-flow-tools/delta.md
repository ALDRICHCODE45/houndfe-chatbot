# Delta for sale-flow-tools

## Out of Scope (non-goals)

This delta does NOT introduce:

- **Historical / multi-order cancellation.** Only the sale `createSale` just confirmed in the current session is cancellable. The model MUST NEVER derive a `saleId` from `getOrderHistory` and cancel it; there is no "which order do you mean?" disambiguation step.
- **Post-delivery states, partial refunds, and returns.** SHIPPED / DELIVERED cancellation, refund modeling, restock-verification surfacing, and returns are out. A backend precondition failure degrades to a human handoff; the bot does not model refunds.
- **The other four `reason` enum values** (`ORDER_ERROR`, `OUT_OF_STOCK`, `DUPLICATE_SALE`, `OTHER`). The `chatbot-api-client` DTO declares them for contract completeness, but the tool hardcodes `CUSTOMER_REQUEST` — the conversational cancel is always customer-initiated.
- **Backend code.** `POST /chatbot-api/sales/:saleId/cancel`, the backend-derived idempotency key `sale:cancel:<saleId>`, restock/refund behavior, and `sale.canceled` emission are already implemented server-side (backend `PROGRAM-CONTEXT.md` §4.4.10, confirmed `cancelBotSale` → `SalesService.cancelSale` `buildResult`). The bot is consumer-only; no backend file is touched.
- **`AGENTS.md` §4.4 endpoint-table sync.** The table still lists the original 9 endpoints; `getPaymentDetails` and `cancel` are documented in the backend's `PROGRAM-CONTEXT.md` §4.4 but not yet reconciled in `AGENTS.md`. Carried in the existing `chatbot-api-doc-sync` follow-up, not this slice.
- **New environment variables.** No env additions: the bot already reads `CHATBOT_API_CASHIER_USER_ID` for `createSale`, and `cancelSale` reuses the same boot-injected `deps.cashierUserId`.
- **`llm-agent` provider or `conversation-store` schema changes.** `data` remains an open bag; `placedSaleId?: string` is a typed convenience field only. No migration, no backfill.

## ADDED Requirements

### Requirement: cancelSale is the eleventh sale-flow tool

`RealToolRegistry` MUST register an AI-SDK tool `cancelSale` as the eleventh sale-flow key, backed by `POST /chatbot-api/sales/:saleId/cancel` (backend `PROGRAM-CONTEXT.md` §4.4.10, `sales:write`). Its `inputSchema` MUST be `z.object({}).strict()` — no model-supplied `saleId`, `reason`, or `cashierUserId` — and its `contextSchema` MUST carry `senderId`. `execute` MUST, in order:

1. Load state via `deps.store.get(senderId)` and read `placedSaleId` via `readPlacedSaleId(state)`.
2. When `placedSaleId` is absent, return `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }` WITHOUT any HTTP call.
3. Call `deps.chatbotApi.cancelSale(placedSaleId, { reason: 'CUSTOMER_REQUEST', cashierUserId: deps.cashierUserId })`. `reason` MUST be fixed to `CUSTOMER_REQUEST` and `cashierUserId` MUST be injected from `CHATBOT_API_CASHIER_USER_ID` — neither MUST ever be model-chosen.
4. On HTTP 200, clear `placedSaleId` (durable write) and return `{ ok: true, ...canceledSale }` where `canceledSale` is the `CancelSaleResult` projection `{ saleId, status: 'CANCELED', refundedCents, restockedItems, canceledAt }`.
5. On `ChatbotApiError`, apply the error-code-first state policy before returning `mapChatbotError(err)`: permanent kinds (`saleNotFound`, `saleNotCancellable`, `idempotencyConflict`) clear `placedSaleId`; transient kinds (`rateLimit`, `upstream`, `idempotencyInFlight`) preserve it so the model can retry.

A sale already `CANCELED` server-side (out-of-band) MUST be treated as a **replay success** (`status: 'CANCELED'`), never as an error: the bot sees a normal success envelope, the model MAY surface the "ya estaba cancelada" nuance from the returned status, and `placedSaleId` is cleared.

#### Scenario: happy path returns CancelSaleResult and clears placedSaleId

- GIVEN a sender S whose `ConversationState.data.placedSaleId` is `'sale-1'`
- AND a stubbed `chatbotApi.cancelSale` that resolves to `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }], canceledAt: '2026-08-25T12:00:00.000Z' }`
- WHEN the model invokes `cancelSale` with `{}`
- THEN the tool MUST call `chatbotApi.cancelSale('sale-1', { reason: 'CUSTOMER_REQUEST', cashierUserId: '<boot-injected-id>' })` exactly once
- AND the returned envelope MUST deep-equal `{ ok: true, saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [...], canceledAt: '2026-08-25T12:00:00.000Z' }`
- AND a subsequent `readPlacedSaleId(state(S))` MUST equal `null`.

#### Scenario: missing placedSaleId guards before any HTTP call

- GIVEN a sender S whose `ConversationState.data` has no `placedSaleId` key
- WHEN the model invokes `cancelSale` with `{}`
- THEN the tool MUST return `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }`
- AND `chatbotApi.cancelSale` MUST NOT be called.

#### Scenario: reason and cashierUserId are never model-chosen

- GIVEN `CHATBOT_API_CASHIER_USER_ID = "00000000-0000-4000-8000-000000000001"`
- WHEN the model invokes `cancelSale` with `{}` (the schema accepts no inputs)
- THEN the outgoing DTO MUST contain `reason: 'CUSTOMER_REQUEST'` (never another enum value, never model-supplied)
- AND the outgoing DTO MUST contain `cashierUserId: "00000000-0000-4000-8000-000000000001"` (injected, never model-supplied).

#### Scenario: SALE_NOT_FOUND clears placedSaleId as non-retryable

- GIVEN a stubbed `chatbotApi.cancelSale` that throws a `ChatbotApiError` with `statusCode: 404` and `errorCode: 'SALE_NOT_FOUND'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal `{ ok: false, error: { kind: 'saleNotFound', retryable: false } }`
- AND `readPlacedSaleId(state(S))` MUST equal `null` (the id is stale/unusable).

#### Scenario: saleNotCancellable degrades to human handoff and clears placedSaleId

- GIVEN a stubbed `chatbotApi.cancelSale` that throws a `ChatbotApiError` with `statusCode: 409` and `errorCode: 'SALE_DELIVERED_CANNOT_CANCEL'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal `{ ok: false, error: { kind: 'saleNotCancellable', retryable: false } }`
- AND the model MUST reply that cancellation is no longer possible by this channel and hand off to a human (never retry, never fabricate an outcome)
- AND `readPlacedSaleId(state(S))` MUST equal `null`.

#### Scenario: transient failure preserves placedSaleId for retry

- GIVEN a stubbed `chatbotApi.cancelSale` that throws a `ChatbotApiError` with `statusCode: 409` and `errorCode: 'IDEMPOTENCY_KEY_IN_FLIGHT'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal `{ ok: false, error: { kind: 'idempotencyInFlight', retryable: true } }`
- AND `readPlacedSaleId(state(S))` MUST still equal `'sale-1'` so the model can retry the same idempotent call later.

#### Scenario: already-canceled sale returns replay success, not an error

- GIVEN the backend already canceled `sale-1` out-of-band
- AND a stubbed `chatbotApi.cancelSale` that resolves to `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [], canceledAt: '2026-08-24T10:00:00.000Z' }`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST be `{ ok: true, ... }` with `status: 'CANCELED'` (no error kind, no retry)
- AND `readPlacedSaleId(state(S))` MUST equal `null`.

#### Scenario: explicit confirmation gate precedes the cancelSale call

- GIVEN a customer asks "cancela mi pedido" after a confirmed sale in the current session
- WHEN the model processes the request per `SALE_FLOW_INSTRUCTIONS` step 14
- THEN the model MUST re-show the sale summary (folio + total + status from the `createSale` success result in the current transcript)
- AND the model MUST ask EXACTLY `¿Confirmas la cancelación? Sí/No` and wait for an explicit "sí" before invoking `cancelSale`
- AND `cancelSale` MUST NOT be invoked on the first "cancela" turn or after any non-"sí" reply.

### Requirement: placedSaleId lifecycle lives in ConversationState.data

`ConversationStateData` MUST gain the optional typed field `placedSaleId?: string`. The per-sender placed sale id MUST be persisted under `ConversationState.data.placedSaleId` — a sibling of `data.cart`, never inside `CartState` — with no new storage table and no migration.

Helpers MUST exist: `readPlacedSaleId(state)` returning `string | null` (a missing key MUST read as `null`), `persistConfirmedSale(store, senderId, state, saleId)`, and `clearPlacedSaleId(store, senderId, state)`.

The lifecycle MUST be:

1. **SET**: `createSale` success persists `data.cart = EMPTY_CART` AND `data.placedSaleId = sale.saleId` in ONE atomic `ConversationStore.update` — never two sequential `data`-replacing writes (the second would clobber the first's cart clear).
2. **READ**: `cancelSale` reads the id from durable state only — never from the model's input, never from `getOrderHistory`.
3. **CLEAR**: `cancelSale` success and permanent error kinds clear the id.
4. **OVERWRITE**: a new `createSale` success overwrites any prior `placedSaleId`.

#### Scenario: createSale success sets placedSaleId atomically with the cart clear

- GIVEN a sender S with a cart containing one item and a persisted `idempotencyKey`
- AND the backend `POST /chatbot-api/sales` returns `{ saleId: 'sale-1', discountCents: 0 }`
- WHEN `createSale` returns `ok: true`
- THEN the persisted `data` MUST contain `cart: { items: [], idempotencyKey: '', expectedTotalCents: undefined }` AND `placedSaleId: 'sale-1'`
- AND exactly ONE `ConversationStore.update` write MUST have occurred for that success (single atomic write, never two sequential writes).

#### Scenario: readPlacedSaleId returns null for a missing key

- GIVEN a stored `ConversationState` whose `data` has no `placedSaleId` key
- WHEN `readPlacedSaleId(state)` is called
- THEN the result MUST equal `null` (no validation error, no default fabrication).

#### Scenario: cancelSale success clears placedSaleId

- GIVEN `ConversationState.data.placedSaleId === 'sale-1'`
- WHEN `cancelSale` returns `ok: true`
- THEN `readPlacedSaleId(state)` MUST equal `null`
- AND a second `cancelSale` invocation MUST hit the `missingPlacedSaleId` guard ("no hay una venta reciente por cancelar").

#### Scenario: a new createSale overwrites the prior placedSaleId

- GIVEN `ConversationState.data.placedSaleId === 'sale-1'` from a previous confirmed sale
- WHEN the customer places a new sale and `createSale` returns `ok: true` with `saleId: 'sale-2'`
- THEN `readPlacedSaleId(state)` MUST equal `'sale-2'` (overwrite, never append).

## MODIFIED Requirements

### Requirement: RealToolRegistry registers the eleven sale-flow tools

A `RealToolRegistry` MUST register exactly the eleven sale-flow AI-SDK tools listed below, replacing `InMemoryToolRegistry` in the production wiring of `LlmAgentModule`. Each tool's parameter name MUST match the corresponding chatbot-api endpoint field name documented in `AGENTS.md` §4.4.x verbatim. The registry docstring MUST read "eleven sale-flow tools" (bumped from ten).

| Tool | Backend endpoint (`AGENTS.md` § / backend `PROGRAM-CONTEXT.md`) | Scope |
|---|---|---|
| `searchCatalog` | §4.4.1 `GET /chatbot-api/catalog/search` | `catalog:read` |
| `checkStock` | §4.4.2 `GET /chatbot-api/catalog/:productId/stock` | `catalog:read` |
| `evaluateCart` | §4.4.3 `POST /chatbot-api/pricing/evaluate-cart` | `pricing:evaluate` |
| `getCustomerByPhone` | §4.4.4 `GET /chatbot-api/customers/by-phone` | `customers:read` |
| `upsertCustomer` | §4.4.5 `PUT /chatbot-api/customers/by-phone` | `customers:write` |
| `createSale` | §4.4.6 `POST /chatbot-api/sales` (+ `X-Idempotency-Key`) | `sales:create` |
| `attachReceipt` | §4.4.7 `POST /chatbot-api/sales/:saleId/receipts` | `sales:write` |
| `updateDelivery` | §4.4.8 `PATCH /chatbot-api/sales/:saleId/delivery` | `sales:write` |
| `getOrderHistory` | §4.4.9 `GET /chatbot-api/customers/by-phone/:phone/orders` | `customers:read` |
| `getPaymentDetails` | `GET /chatbot-api/payment-details` | `payment-details:read` |
| `cancelSale` | (new) §4.4.10 `POST /chatbot-api/sales/:saleId/cancel` (no client `X-Idempotency-Key`) | `sales:write` |

`LlmAgentModule` MUST resolve the `TOOL_REGISTRY` provider to `RealToolRegistry`, which MUST inject `CHATBOT_API_CLIENT` and `CONVERSATION_STORE`. `RealToolRegistry` MUST NOT be an in-memory placeholder.

(Previously: exactly ten tools registered, ending at `getPaymentDetails`; docstring "ten sale-flow tools"; no cancel tool.)

#### Scenario: Registry exposes all eleven tools

- GIVEN a Nest testing module with `RealToolRegistry` and a stubbed `ChatbotApiClient`
- WHEN `registry.getTools()` is called
- THEN the returned AI-SDK ToolSet MUST contain every key `searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`, `attachReceipt`, `updateDelivery`, `getOrderHistory`, `getPaymentDetails`, `cancelSale`
- AND the ToolSet MUST NOT contain any other key beyond these eleven.

#### Scenario: LlmAgentModule wires RealToolRegistry with ChatbotApiClient + ConversationStore

- GIVEN a production `LlmAgentModule` build with all `AppModule` imports in place
- WHEN the DI container resolves the `TOOL_REGISTRY` provider
- THEN the resolved instance MUST be `RealToolRegistry`
- AND its constructor MUST have received `CHATBOT_API_CLIENT` (bound to `ChatbotApiHttpClient`) AND `CONVERSATION_STORE` (bound to the durable Postgres adapter per the `conversation-store` spec).

#### Scenario: Placeholder registry is no longer the production binding

- GIVEN the production wiring of `LlmAgentModule`
- WHEN the module is inspected
- THEN `InMemoryToolRegistry` MUST NOT be registered as the `TOOL_REGISTRY` provider (it MAY remain in the repository as a test fixture).

### Requirement: Tools return a stable error envelope instead of raw HTTP

When `ChatbotApiHttpClient` throws (any of `AuthError`, `ForbiddenError`, `NotFoundError`, `RateLimitError`, `UpstreamError`, or a `ChatbotApiError` with a non-null `statusCode`), the tool's `execute` MUST catch the error and return `{ ok: false, error: { kind, retryable } }` — never the raw exception, never a raw HTTP status, never a stack trace — so the model can phrase a user-friendly reply or trigger a retry.

`kind` MUST be one of
`'auth' | 'forbidden' | 'notFound' | 'rateLimit' | 'upstream' | 'validation' | 'noActivePaymentDetail' | 'promoReQuote' | 'idempotencyInFlight' | 'idempotencyConflict' | 'priceOutOfDate' | 'saleNotFound' | 'saleNotCancellable' | 'missingPlacedSaleId'`,
and `retryable` MUST be `true` for transient `upstream`, `rateLimit`, and `idempotencyInFlight` cases and `false` otherwise.

The mapping layer (`src/sale-flow/application/error-mapping.ts`) MUST discriminate on the `ChatbotApiError.errorCode` FIRST, and MUST fall back to the HTTP-status-keyed mapping only when `errorCode` is `null`:

| Backend `errorCode` (or HTTP status when `errorCode` is absent) | `kind` | `retryable` |
|---|---|---|
| `NO_ACTIVE_PAYMENT_DETAIL` (404) | `noActivePaymentDetail` | `false` |
| `PROMO_RE_QUOTE` (409) | `promoReQuote` | `false` |
| `IDEMPOTENCY_KEY_IN_FLIGHT` (409) | `idempotencyInFlight` | `true` |
| `IDEMPOTENCY_KEY_CONFLICT` (409) | `idempotencyConflict` | `false` |
| `PRICE_OUT_OF_DATE` (409) | `priceOutOfDate` | `false` |
| `INVALID_IDEMPOTENCY_KEY` (400) | `validation` | `false` |
| `SALE_NOT_FOUND` (404) | `saleNotFound` | `false` |
| `SALE_NOT_CANCELLABLE` (409) | `saleNotCancellable` | `false` |
| `SALE_DELIVERED_CANNOT_CANCEL` (409) | `saleNotCancellable` | `false` |
| 401 (no `errorCode`) | `auth` | `false` |
| 403 (no `errorCode`) | `forbidden` | `false` |
| 404 (no `errorCode`) | `notFound` | `false` |
| 429 | `rateLimit` | `true` |
| 5xx | `upstream` | `true` |
| any other 4xx | `validation` | `false` |

`missingPlacedSaleId` MUST be produced ONLY by the tool's client-side guard (no HTTP call); it MUST never be emitted by `mapChatbotError` from a backend code. There is NO distinct "already canceled" code — a `CANCELED` sale returns a replay success (`200`, `status: 'CANCELED'`), not an error. Unknown cancel codes MUST fall through to the existing subclass/status mapping (404 → `notFound`, 403 → `forbidden`, 4xx → `validation`, 5xx → `upstream`) so a code mismatch degrades safely. The bot MUST NEVER parse the `message` string for branching.

(Previously: eleven kinds (`auth` … `priceOutOfDate`) with no cancel vocabulary; every cancel failure would collapse to `notFound` / `validation` / `upstream`.)

#### Scenario: upstream 5xx becomes retryable upstream envelope

- GIVEN the `evaluateCart` tool is invoked with a valid input
- AND the stubbed `ChatbotApiHttpClient.evaluateCart` throws `UpstreamError`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal `{ ok: false, error: { kind: 'upstream', retryable: true } }`
- AND the thrown error MUST NOT propagate.

#### Scenario: 404 without errorCode surfaces as a non-retryable notFound envelope

- GIVEN the `checkStock` tool
- AND the stubbed `ChatbotApiHttpClient.getStock` throws a `ChatbotApiError` with `statusCode: 404` and `errorCode: null`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal `{ ok: false, error: { kind: 'notFound', retryable: false } }`.

#### Scenario: errorCode wins over HTTP status for createSale

- GIVEN the `createSale` tool is invoked with a valid cart
- AND the stubbed `ChatbotApiHttpClient.createSale` throws a `ChatbotApiError` with `statusCode: 409` and `errorCode: 'PROMO_RE_QUOTE'`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal `{ ok: false, error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 } }`
- AND the HTTP-status-first branch (`validation`) MUST NOT have been taken.

#### Scenario: SALE_DELIVERED_CANNOT_CANCEL maps to saleNotCancellable

- GIVEN the `cancelSale` tool is invoked with a valid `placedSaleId`
- AND the stubbed `ChatbotApiHttpClient.cancelSale` throws a `ChatbotApiError` with `statusCode: 409` and `errorCode: 'SALE_DELIVERED_CANNOT_CANCEL'`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal `{ ok: false, error: { kind: 'saleNotCancellable', retryable: false } }`
- AND the HTTP-status-first branch (`validation`) MUST NOT have been taken.

#### Scenario: unknown cancel errorCode falls back to the status mapping

- GIVEN the `cancelSale` tool is invoked
- AND the stubbed client throws a `ChatbotApiError` with `statusCode: 422` and an unrecognized `errorCode` (e.g. `'SOME_FUTURE_CODE'`)
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal `{ ok: false, error: { kind: 'validation', retryable: false } }` (safe degradation, no crash).

### Requirement: createSale sends expectedTotalCents and handles the five new error codes per the promo/idempotency contract

The `createSale` tool MUST forward each cart item's `unitPriceCents` from the cart as the item-level price (the value recorded at add-to-cart time). The tool MUST forward the cart's persisted `expectedTotalCents` (when present) on the wire as the top-level `expectedTotalCents` field of the DTO — NEVER from the model's input. The tool MUST mint a fresh client-side UUID v4 (`crypto.randomUUID()`) for the first attempt and persist it on the cart, and MUST reuse the same key only for identical-payload retries within the sender's session.

The tool MUST branch on `ChatbotApiError.errorCode` for the four new codes plus `PRICE_OUT_OF_DATE`. On each branch the tool MUST clear or preserve the persisted `idempotencyKey` per the contract:

| Backend `errorCode` (`statusCode`) | Returned `kind` | `retryable` | Cart `items` | Cart `idempotencyKey` | Surface `discountCents`? |
|---|---|---|---|---|---|
| `PROMO_RE_QUOTE` (409) | `promoReQuote` | `false` | preserved | cleared | yes (in error envelope) |
| `IDEMPOTENCY_KEY_IN_FLIGHT` (409) | `idempotencyInFlight` | `true` | preserved | preserved | n/a |
| `IDEMPOTENCY_KEY_CONFLICT` (409) | `idempotencyConflict` | `false` | preserved | cleared | n/a |
| `PRICE_OUT_OF_DATE` (409) | `priceOutOfDate` | `false` | preserved | preserved | n/a |
| `INVALID_IDEMPOTENCY_KEY` (400) | `validation` | `false` | preserved | preserved | n/a |

On `PROMO_RE_QUOTE`, the tool MUST include `recomputedTotalCents`, `expectedTotalCents`, and `discountCents` (numeric cents values from the backend envelope) in the error envelope so the model can show the new totals and re-confirm with the customer. On success (`ok: true`), the tool MUST extract `discountCents` from `BotSaleResponse` and surface it in the success envelope, and MUST persist `data.placedSaleId = sale.saleId` AND clear the cart (items + idempotencyKey + expectedTotalCents) in ONE atomic `ConversationStore.update` before the tool returns.

(Previously: on success the tool called `persistCart(…, EMPTY_CART)` and returned `{ ok: true, ...sale }`, dropping the returned `saleId` — nothing persisted the placed sale durably.)

#### Scenario: first attempt persists the idempotency key

- GIVEN an empty cart for sender S (no prior `idempotencyKey`, no prior `expectedTotalCents`)
- AND the backend `POST /chatbot-api/sales` (§4.4.6) returns `{ saleId: "sale-1", discountCents: 0 }`
- WHEN `createSale` is invoked with a valid cart
- THEN the first outgoing HTTP request MUST include an `X-Idempotency-Key` header whose value is a UUID v4
- AND the persisted cart MUST contain that same key
- AND the next call's outgoing request (identical payload) MUST include the same key.

#### Scenario: PROMO_RE_QUOTE clears the idempotency key and preserves the cart items

- GIVEN a cart with one item, a persisted `idempotencyKey`, and `expectedTotalCents: 1000`
- AND the backend returns `409` with `errorCode: 'PROMO_RE_QUOTE'`, `recomputedTotalCents: 900`, `expectedTotalCents: 1000`, `discountCents: 100`
- WHEN `createSale` runs
- THEN the result MUST deep-equal `{ ok: false, error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 } }`
- AND `readCart(S).items` MUST remain unchanged
- AND `readCart(S).idempotencyKey` MUST equal `''` (cleared so the re-confirmation mints a fresh key).

#### Scenario: IDEMPOTENCY_KEY_IN_FLIGHT returns a retryable kind and preserves the key

- GIVEN a cart with one item and a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'IDEMPOTENCY_KEY_IN_FLIGHT'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal `{ ok: false, error: { kind: 'idempotencyInFlight', retryable: true } }`
- AND `readCart(S).idempotencyKey` MUST equal the previously persisted value.

#### Scenario: success persists placedSaleId atomically with the cart clear

- GIVEN a cart with one item, a persisted `idempotencyKey`, and `expectedTotalCents: 1500`
- AND the backend returns `{ ok: true, sale: { saleId: "sale-1", discountCents: 250 } }`
- WHEN `createSale` runs
- THEN the tool's success envelope MUST include `discountCents: 250`
- AND the persisted `data` MUST contain `cart: { items: [], idempotencyKey: '', expectedTotalCents: undefined }` AND `placedSaleId: 'sale-1'`
- AND exactly ONE `ConversationStore.update` write MUST have occurred for the success path (single atomic write).

### Requirement: SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot

`SALE_FLOW_INSTRUCTIONS` MUST be a string literal (in `src/sale-flow/domain/sale-flow-instructions.ts`) that encodes the escrow-style sale flow:

1. Greet.
2. Ask what product the customer wants.
3. Call `searchCatalog` and present results.
4. Confirm the chosen product.
5. Call `checkStock` for the chosen product.
6. Add the item to the cart (locally persisted via `writeCart`).
7. Ask whether to add another item or proceed to review.
8. Call `evaluateCart` and surface the price quote to the customer.
9. Collect or confirm customer data (phone + name; reuse `getCustomerByPhone` then `upsertCustomer` with the address field per AGENTS.md §4.4.5).
10. Send an order summary (structured, bulleted — same format as the real human agent in conversation #1).
11. Call `createSale`, forwarding `expectedTotalCents` from the cart; on `PROMO_RE_QUOTE`, show the new totals to the customer, ask for explicit confirmation, and on acceptance re-emit `createSale` with a fresh UUID v4 idempotency key (NEVER reuse the previous key after `PROMO_RE_QUOTE`).
12. **After `createSale` returns `ok: true`, call `getPaymentDetails` (inputSchema: empty object). If the result is `{ ok: false, error: { kind: 'noActivePaymentDetail' } }`, reply EXACTLY with `en un momento un agente te comparte los datos de pago` and pause. Otherwise render the bank-details block (bankName, beneficiary, clabe, accountNumber) and ask for the transfer receipt.** Never call `getPaymentDetails` before `createSale` confirms a sale.
13. On receipt image, call `attachReceipt`.
14. **On a customer cancel request, cancel ONLY the sale just confirmed in this session. Never cancel historical or multi-order sales; never derive a `saleId` from `getOrderHistory`. Re-show the sale summary (folio + total + status from the `createSale` success result in the current transcript), then ask EXACTLY `¿Confirmas la cancelación? Sí/No` and call `cancelSale` ONLY after an explicit "sí". On `kind: 'saleNotCancellable'`, reply that cancellation is no longer possible by this channel and hand off to a human. On `kind: 'missingPlacedSaleId'`, reply `no hay una venta reciente por cancelar` — never fabricate a sale.** (New step.)
15. End the conversation.

The composed system prompt MUST equal `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`, concatenated ONCE at module boot (one-shot, never per-turn). The base `SYSTEM_PROMPT` MUST be appended unmodified. `composeSaleFlowSystemPrompt` MUST collapse to `(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`.

The slice MUST include in `SALE_FLOW_INSTRUCTIONS`, at minimum:

- A `getPaymentDetails`-after-`createSale` gating rule (`getPaymentDetails` MUST NOT be called before `createSale` confirms a sale).
- The human-handoff phrase `en un momento un agente te comparte los datos de pago` byte-identical when the tool returns the `noActivePaymentDetail` kind.
- A cancel rule: just-confirmed-sale-only scope, the folio + total + status summary, the explicit-confirmation gate `¿Confirmas la cancelación? Sí/No`, and the `saleNotCancellable` → human-handoff branch.
- A no-fabrication rule: never invent a price, a stock quantity, a bank detail, or a sale to cancel; always call the relevant tool.
- The refusal phrase `esa función aún no está disponible` preserved verbatim.
- A `PROMO_RE_QUOTE` rule that the bot re-confirms with the customer exactly once and re-emits `createSale` with a fresh UUID v4 on acceptance.

(Previously: a 14-step flow whose step 14 read "End the conversation" with no cancel step; the closing step is now renumbered 14 → 15.)

#### Scenario: composed prompt contains the contractual strings

- GIVEN the application has booted with `SaleFlowModule` imported
- WHEN the agent runner reads the system prompt from its config source
- THEN the composed prompt MUST contain (i) the literal phrase `esa función aún no está disponible`; (ii) the sale-flow step list above (1–15); (iii) the `getPaymentDetails`-after-`createSale` gating instruction; (iv) the cancel rule with the exact phrase `¿Confirmas la cancelación? Sí/No`; (v) the `PROMO_RE_QUOTE` re-confirmation rule.

#### Scenario: composition happens at boot, not per turn

- GIVEN `ConversationStore` has 50 turns of prior history for sender S
- WHEN the agent runner handles three consecutive inbounds
- THEN `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` MUST be computed exactly once at module boot
- AND subsequent turns MUST reuse the same composed string (byte-identical).

#### Scenario: step 12 human-handoff phrase is byte-identical

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS` is exported from `src/sale-flow/domain/sale-flow-instructions.ts`
- WHEN the test parses the string for the step-12 instruction
- THEN the substring MUST contain the exact phrase `en un momento un agente te comparte los datos de pago`
- AND the phrase MUST be wrapped in a `getPaymentDetails` 404 branch so the model emits it ONLY on the `noActivePaymentDetail` kind
- AND the phrase MUST NOT be edited for grammar, punctuation, or wording when the bot is re-prompted (byte-identical snapshot test).

#### Scenario: cancel step 14 explicit-confirm phrase is byte-identical

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS`
- WHEN the test extracts step 14
- THEN the text MUST contain the exact phrase `¿Confirmas la cancelación? Sí/No`
- AND the text MUST state that `cancelSale` is called ONLY after an explicit "sí"
- AND the text MUST limit cancellation to the sale just confirmed in the current session (never `getOrderHistory`-derived ids)
- AND the text MUST contain the `saleNotCancellable` → human-handoff branch.
