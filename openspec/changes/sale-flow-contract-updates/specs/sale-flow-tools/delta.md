# Delta for sale-flow-tools

## Out of Scope (non-goals)

This delta does NOT introduce:

- A new `chatbot-api` endpoint on the backend. The new `GET /chatbot-api/payment-details` endpoint and the extended `POST /chatbot-api/sales` (now accepting `expectedTotalCents` and returning `discountCents` plus the four new error envelope codes) are owned by `houndfe-backend` (READ-ONLY constraint, hard). The bot is consumer-only.
- A new chatbot-api endpoint or a new database table. Bot state lives under `ConversationState.data` (see `conversation-store` spec); `CartState` gains an optional `expectedTotalCents?: number` field with no migration and no backfill (legacy carts read as `undefined`).
- A new AI-SDK provider or model, and no change to the literal `SYSTEM_PROMPT` base. Only step 12 of the `SALE_FLOW_INSTRUCTIONS` literal changes wording: the human-handoff phrase "en un momento un agente te comparte los datos de pago" stays byte-identical; the only addition is the rule that the model MUST call `getPaymentDetails` after `createSale` returns success. `composeSaleFlowSystemPrompt` collapses to `(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`.
- The boot-time `BankDetailsProvider` port + `NullBankDetailsProvider` + `BANK_DETAILS_PROVIDER` module binding + `renderBankDetailsBlock` + the `BankDetails` type + `bankDetails` on `ToolDeps`. The runtime `getPaymentDetails` tool replaces the seam entirely; nothing else injects bank data anywhere.
- Shipping quote slice (R2–R5), card payments via Link EVO (R16), image recognition (R1), the human-handoff channel rework (R6/R7/R14), `evaluate-cart` coverage beyond `PRODUCT_DISCOUNT` (Q5), partial-customer DTO (Q6), `phoneCountryCode` validation in order-history (Q7), and `POST /chatbot-api/sales/:saleId/cancel` (Q8). All deferred to follow-up slices per `docs/backend-questions-sale-flow-responses.md`.
- Any DB write path. The chatbot remains a consumer of `houndfe-backend`; the consumer-only constraint from `openspec/config.yaml` `rules.design` holds.
- Documentation sync of `AGENTS.md` §4.4 (the endpoint table is now 11 endpoints; `payment-details:read` scope is new; `expectedTotalCents` / `discountCents` fields are new; the four new error envelope codes exist). Logged as a follow-up `chatbot-api-doc-sync` (Risk R-5).
- Spec drift on the `llm-agent` provider (the canonical `openspec/specs/llm-agent/spec.md` mentions the Vercel AI Gateway + `AI_GATEWAY_API_KEY`; the shipped impl uses `@ai-sdk/openai` + `OPENAI_API_KEY`). Logged as a follow-up `llm-agent-provider-spec-sync` (Risk R-6); this slice does NOT touch the LLM provider. **No `llm-agent` delta is required for this change** because the system-prompt literal is byte-identical (`SYSTEM_PROMPT` unchanged; the only edit is the step-12 addition to `SALE_FLOW_INSTRUCTIONS`, which is the sale-flow domain), and the `composeSaleFlowSystemPrompt` signature change is an internal refactor.
- Updating the canonical `chatbot-api-foundation` or `sales` specs owned by `houndfe-backend`. The bot-side DTO extensions (`expectedTotalCents`, `discountCents`, `errorCode`) live on the bot's own `chatbot-api-client` capability spec; the corresponding backend specs are authoritative on the server side.

The five new discriminated `kind` values (`noActivePaymentDetail`, `promoReQuote`, `idempotencyInFlight`, `idempotencyConflict`, `priceOutOfDate`) accepted by the error-mapping layer are driven by the backend's `error` envelope field already merged in `chatbot-sale-flow-blockers` (2026-08-24 archive). The bot branches on those exact strings only — it never parses `message` strings.

## ADDED Requirements

### Requirement: getPaymentDetails is the tenth sale-flow tool

`RealToolRegistry` MUST register an AI-SDK tool `getPaymentDetails` whose:

- `inputSchema` is `z.object({})` (no parameters, no body).
- `description` instructs the model to call this tool ONLY AFTER `createSale` returns success, exactly once per confirmed sale, to render the bank transfer details.
- `execute` calls `chatbotApi.getPaymentDetails()` and returns:
  - On HTTP 200: `{ ok: true, paymentDetail: PaymentDetail }` where `PaymentDetail` is the bot-safe projection `{ id, bankName, beneficiary, clabe, accountNumber, isActive, updatedAt }` (no `tenantId`, no `createdAt`).
  - On `ChatbotApiError` with `errorCode === 'NO_ACTIVE_PAYMENT_DETAIL'`: `{ ok: false, error: { kind: 'noActivePaymentDetail', retryable: false } }`.
  - On any other `ChatbotApiError`: `{ ok: false, error: { kind, retryable } }` from the discriminated mapping.

The literal `SALE_FLOW_INSTRUCTIONS` step 12 MUST instruct the model to call `getPaymentDetails` ONLY after `createSale` succeeds and MUST emit the exact human-handoff phrase `en un momento un agente te comparte los datos de pago` when the tool returns `kind: 'noActivePaymentDetail'`.

#### Scenario: successful 200 returns the PaymentDetail projection

- GIVEN a `RealToolRegistry` with `getPaymentDetails` registered
- AND a stubbed `chatbotApi.getPaymentDetails()` that resolves to `{ id: 'p-1', bankName: 'AFIRME', beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV', clabe: '012345678901234567', accountNumber: '1234567890', isActive: true, updatedAt: '2026-08-24T12:00:00.000Z' }`
- WHEN the model invokes `getPaymentDetails` with `{}`
- THEN the tool's execute MUST call `chatbotApi.getPaymentDetails()` exactly once with no arguments
- AND the returned envelope MUST deep-equal `{ ok: true, paymentDetail: { id: 'p-1', bankName: 'AFIRME', beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV', clabe: '012345678901234567', accountNumber: '1234567890', isActive: true, updatedAt: '2026-08-24T12:00:00.000Z' } }`
- AND the returned `paymentDetail` MUST NOT contain `tenantId` or `createdAt`.

#### Scenario: 404 NO_ACTIVE_PAYMENT_DETAIL maps to noActivePaymentDetail kind

- GIVEN the `getPaymentDetails` tool is invoked
- AND a stubbed `chatbotApi.getPaymentDetails()` throws a `ChatbotApiError` with `statusCode: 404` and `errorCode: 'NO_ACTIVE_PAYMENT_DETAIL'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal `{ ok: false, error: { kind: 'noActivePaymentDetail', retryable: false } }`
- AND the thrown error MUST NOT propagate.

#### Scenario: inputSchema accepts an empty payload and rejects unknown keys

- GIVEN the `getPaymentDetails` tool
- WHEN the model invokes it with an empty object `{}`
- THEN the Zod parse MUST succeed
- AND the underlying `chatbotApi.getPaymentDetails` MUST be called with no arguments
- AND when invoked with any extra key (e.g. `{ extra: 'x' }`), the Zod parse MUST fail with a clear error (the schema is `z.object({})`, not `z.object({}).passthrough()`).

#### Scenario: step 12 of the literal gates the call to "after createSale succeeds"

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS`
- WHEN the test extracts step 12
- THEN the text MUST contain the rule `Llama a \`getPaymentDetails\` después de que \`createSale\` confirme`
- AND the text MUST contain the rule that `getPaymentDetails` MUST NOT be called before `createSale` confirms a sale
- AND the text MUST contain the exact human-handoff phrase `en un momento un agente te comparte los datos de pago` for the `noActivePaymentDetail` branch.

### Requirement: Idempotency key lifecycle

The `createSale` tool MUST follow this key lifecycle, in order, per sender session:

1. On the first invocation for a sender (or when the persisted `idempotencyKey` is `''` after a prior clear), MUST mint a fresh `crypto.randomUUID()` (UUID v4, ≤ 36 chars) and persist it on the cart before the HTTP request goes out.
2. On identical-payload retries (same `items`, same `cashierUserId`, same `customerId`, same `shippingAddressId`, same `expectedTotalCents`) within the same session, MUST reuse the persisted key.
3. MUST clear the persisted `idempotencyKey` (set to `''`) on: `createSale` success, `PROMO_RE_QUOTE` outcome, and `IDEMPOTENCY_KEY_CONFLICT` outcome. The next call mints a fresh UUID v4 (different payload → different key).
4. MUST preserve the persisted `idempotencyKey` on `IDEMPOTENCY_KEY_IN_FLIGHT` outcome (same payload, same in-flight slot); the model retries later.
5. Each distinct payload (different cart contents, different `cashierUserId`, different `customerId`, different `shippingAddressId`, or different `expectedTotalCents`) MUST produce a fresh UUID v4 key on the next mint — never reuse a cleared key.

#### Scenario: identical-payload retry reuses the persisted key

- GIVEN a cart with `idempotencyKey: '<uuid-A>'` and items + `expectedTotalCents` that have not changed
- WHEN `createSale` is invoked twice in a row with the same inputs (network 503 in between)
- THEN both outgoing requests MUST carry the `X-Idempotency-Key` header value `<uuid-A>` (no fresh mint).

#### Scenario: distinct payload mints a fresh UUID v4

- GIVEN a cart with `idempotencyKey: ''` (cleared after a previous `PROMO_RE_QUOTE` or after success)
- WHEN `createSale` is invoked with a different cart (one item added, one removed, quantity changed, or `expectedTotalCents` changed)
- THEN the outgoing request MUST carry an `X-Idempotency-Key` whose value is a new UUID v4
- AND the previously cleared key MUST NOT appear on the wire.

#### Scenario: key rotation after PROMO_RE_QUOTE uses a fresh UUID v4

- GIVEN a `createSale` returned `kind: 'promoReQuote'`, which left the cart `items` and `expectedTotalCents` preserved and the cart `idempotencyKey` cleared
- WHEN the customer accepts the new total and the model invokes `createSale` again
- THEN the outgoing request MUST carry an `X-Idempotency-Key` whose value is a new UUID v4
- AND the new key MUST structurally differ from the key in effect before the `PROMO_RE_QUOTE` (regenerated UUID v4 vs. the persisted pre-clear value).

### Requirement: BotSaleResponse.discountCents is surfaced on success

When `createSale` returns the success envelope, the envelope MUST surface `discountCents` (a non-negative integer cents value) from `BotSaleResponse`. The model uses this to render the confirmation message:

- When `discountCents > 0`, the model MUST render `Descuento aplicado: $X` (where `$X` is the cents expressed in pesos with the appropriate formatting) in the confirmation message.
- When `discountCents === 0`, the model MUST NOT add a discount line to the confirmation message.

The `discountCents` value is the one the backend returned on the FINAL successful `createSale`. The bot MUST NOT compute or estimate `discountCents` from prior `evaluateCart` responses; it MUST be sourced from the response envelope.

#### Scenario: discountCents greater than zero is surfaced to the model

- GIVEN a successful `createSale` response with `discountCents: 250`
- WHEN the tool's `execute` returns
- THEN the success envelope MUST include `discountCents: 250`
- AND the test fixture that mocks the model MUST observe that the rendered confirmation message contains the line `Descuento aplicado: $250` (or its localized equivalent).

#### Scenario: discountCents equal to zero is silent

- GIVEN a successful `createSale` response with `discountCents: 0`
- WHEN the tool's `execute` returns
- THEN the success envelope MUST include `discountCents: 0`
- AND the model MUST NOT add a `Descuento aplicado` line to the confirmation message.

### Requirement: ChatbotApiError surfaces the backend errorCode envelope field

`ChatbotApiError` MUST carry an additional field `errorCode: string | null` populated from the backend envelope's `responseBody.error`. `mapError` in `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` MUST populate `errorCode` for every mapped response (4xx and 5xx) that returns a JSON body with an `error` string. When the transport itself fails (no body), when the body has no `error` field, or when the body is not JSON, `errorCode` MUST be `null`.

The error-mapping layer in `src/sale-flow/application/error-mapping.ts` MUST branch on `errorCode` BEFORE the HTTP status so a `409 PROMO_RE_QUOTE` always maps to `kind: 'promoReQuote'` regardless of HTTP semantics.

#### Scenario: errorCode is populated from responseBody.error

- GIVEN the backend returns `409` with body `{ statusCode: 409, error: 'PROMO_RE_QUOTE', message: 'Price changed' }`
- WHEN the HTTP client maps the response
- THEN `ChatbotApiError.errorCode` MUST equal `'PROMO_RE_QUOTE'`
- AND the thrown error MUST carry `statusCode: 409`.

#### Scenario: errorCode is null when the body has no error field

- GIVEN the backend returns `422` with body `{ statusCode: 422, message: 'Validation failed' }` (no `error` field)
- WHEN the HTTP client maps the response
- THEN `ChatbotApiError.errorCode` MUST equal `null`
- AND the error-mapping layer MUST fall back to the HTTP status (`422` → `validation`).

#### Scenario: errorCode is null when the transport itself fails

- GIVEN the HTTP transport rejects with a network error before any response body arrives
- WHEN the HTTP client maps the failure
- THEN `ChatbotApiError.errorCode` MUST equal `null`
- AND the thrown error MUST be `UpstreamError` (or the existing transport-level type), not a status-bearing `ChatbotApiError`.

## MODIFIED Requirements

### Requirement: RealToolRegistry registers the ten sale-flow tools

A `RealToolRegistry` MUST register exactly the ten sale-flow AI-SDK tools listed below, replacing `InMemoryToolRegistry` in the production wiring of `LlmAgentModule`. Each tool's parameter name MUST match the corresponding chatbot-api endpoint field name documented in `AGENTS.md` §4.4.x verbatim.

| Tool | Backend endpoint (`AGENTS.md` §) | Scope |
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
| `getPaymentDetails` | (new in `chatbot-sale-flow-blockers`) `GET /chatbot-api/payment-details` | `payment-details:read` |

`LlmAgentModule` MUST resolve the `TOOL_REGISTRY` provider to `RealToolRegistry`, which MUST inject `CHATBOT_API_CLIENT` and `CONVERSATION_STORE`. `RealToolRegistry` MUST inject `BANK_DETAILS_PROVIDER` no longer; its constructor MUST depend only on `chatbotApi` and `store`. `RealToolRegistry` MUST NOT be an in-memory placeholder.

(Previously: nine tools registered; `BankDetailsProvider` port was the boot-time seam for bank data.)

#### Scenario: Registry exposes all ten tools

- GIVEN a Nest testing module with `RealToolRegistry` and a stubbed `ChatbotApiClient`
- WHEN `registry.getTools()` is called
- THEN the returned AI-SDK ToolSet MUST contain every key `searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`, `attachReceipt`, `updateDelivery`, `getOrderHistory`, `getPaymentDetails`
- AND the ToolSet MUST NOT contain any other key beyond these ten.

#### Scenario: LlmAgentModule wires RealToolRegistry with ChatbotApiClient + ConversationStore

- GIVEN a production `LlmAgentModule` build with all `AppModule` imports in place
- WHEN the DI container resolves the `TOOL_REGISTRY` provider
- THEN the resolved instance MUST be `RealToolRegistry`
- AND its constructor MUST have received `CHATBOT_API_CLIENT` (bound to `ChatbotApiHttpClient`) AND `CONVERSATION_STORE` (bound to the durable Postgres adapter per the `conversation-store` spec).

#### Scenario: Placeholder registry is no longer the production binding

- GIVEN the production wiring of `LlmAgentModule`
- WHEN the module is inspected
- THEN `InMemoryToolRegistry` MUST NOT be registered as the `TOOL_REGISTRY` provider (it MAY remain in the repository as a test fixture)
- AND `BANK_DETAILS_PROVIDER` MUST NOT appear in the DI bindings of `SaleFlowModule` or `LlmAgentModule`.

### Requirement: Tools return a stable error envelope instead of raw HTTP

When `ChatbotApiHttpClient` throws (any of `AuthError`, `ForbiddenError`, `NotFoundError`, `RateLimitError`, `UpstreamError`, or a `ChatbotApiError` with a non-null `statusCode`), the tool's `execute` MUST catch the error and return `{ ok: false, error: { kind, retryable } }` — never the raw exception, never a raw HTTP status, never a stack trace — so the model can phrase a user-friendly reply or trigger a retry.

`kind` MUST be one of
`'auth' | 'forbidden' | 'notFound' | 'rateLimit' | 'upstream' | 'validation' | 'noActivePaymentDetail' | 'promoReQuote' | 'idempotencyInFlight' | 'idempotencyConflict' | 'priceOutOfDate'`.

The mapping layer (`src/sale-flow/application/error-mapping.ts`) MUST discriminate on the `ChatbotApiError.errorCode` carried by `ChatbotApiError` FIRST, and MUST fall back to the HTTP-status-keyed mapping only when `errorCode` is `null`:

| Backend `errorCode` (or HTTP status when `errorCode` is absent) | `kind` | `retryable` |
|---|---|---|
| `NO_ACTIVE_PAYMENT_DETAIL` (404) | `noActivePaymentDetail` | `false` |
| `PROMO_RE_QUOTE` (409) | `promoReQuote` | `false` |
| `IDEMPOTENCY_KEY_IN_FLIGHT` (409) | `idempotencyInFlight` | `true` |
| `IDEMPOTENCY_KEY_CONFLICT` (409) | `idempotencyConflict` | `false` |
| `PRICE_OUT_OF_DATE` (409) | `priceOutOfDate` | `false` |
| `INVALID_IDEMPOTENCY_KEY` (400) | `validation` | `false` |
| 401 (no `errorCode`) | `auth` | `false` |
| 403 (no `errorCode`) | `forbidden` | `false` |
| 404 (no `errorCode`) | `notFound` | `false` |
| 429 | `rateLimit` | `true` |
| 5xx | `upstream` | `true` |
| any other 4xx | `validation` | `false` |

`errorCode`-first means: when the error body carries an `error` field, that field picks the `kind` BEFORE the HTTP status. When `errorCode` is `null` (legacy backend or transport-level failure), the HTTP status mapping above applies. The bot MUST NEVER parse the `message` string for branching.

(Previously: six kinds (`auth`, `forbidden`, `notFound`, `rateLimit`, `upstream`, `validation`); the mapping did not carry or discriminate on `errorCode`.)

#### Scenario: upstream 5xx becomes retryable upstream envelope

- GIVEN the `evaluateCart` tool is invoked with a valid input
- AND the stubbed `ChatbotApiHttpClient.evaluateCart` throws `UpstreamError` (no `errorCode`)
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

#### Scenario: legacy backend without errorCode falls back to validation

- GIVEN a tool is invoked
- AND the stubbed `ChatbotApiHttpClient` throws a `ChatbotApiError` with `statusCode: 422` and `errorCode: null`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal `{ ok: false, error: { kind: 'validation', retryable: false } }`.

### Requirement: Per-sender cart lives in ConversationState.data.cart

The per-sender cart MUST be persisted under `ConversationState.data.cart`, with no new storage table and no schema migration. The slice MUST NOT introduce a new module-owned storage layer.

`CartState` MUST be a typed object:

```text
CartState {
  items: Array<{
    productId: string;
    variantId?: string;
    quantity: number;            // >= 1
    unitPriceCents: number;      // >= 0, list price recorded at add-to-cart time
  }>;
  idempotencyKey: string;        // UUID v4 generated client-side on first createSale attempt; '' when no active attempt
  expectedTotalCents?: number;   // optional; persisted by evaluateCart on success, read by createSale; absent on legacy carts
}
```

Helpers `readCart(state)` and `writeCart(state, patch)` MUST exist and MUST mirror the `readMessages`/`writeMessages` pattern: a missing `cart` MUST default to `{ items: [], idempotencyKey: '', expectedTotalCents: undefined }`; subsequent writes MUST shallow-merge the patch over the existing cart and persist via `ConversationStore.update(senderId, ...)` (reusing the durable Postgres UPSERT path). The `isCartState` type guard MUST treat a missing `expectedTotalCents` as a valid legacy cart (no validation error).

(Previously: `CartState` carried `items` + `idempotencyKey` only; `expectedTotalCents` is added as an optional field for backwards compatibility.)

#### Scenario: cart round-trips through the durable ConversationStore

- GIVEN a sender with `ConversationState.data.cart = { items: [], idempotencyKey: '' }`
- WHEN `writeCart` is called with a patch that adds one item, a fresh idempotency key, and `expectedTotalCents: 1500`
- THEN a subsequent `readCart` MUST deep-equal `{ items: [...], idempotencyKey: '<uuid>', expectedTotalCents: 1500 }`
- AND the underlying `ConversationStore.update` MUST replace the `data` field as a whole (no JSONB deep merge at the storage layer) per the `conversation-store` spec.

#### Scenario: missing cart defaults to empty

- GIVEN a stored `ConversationState` whose `data` has no `cart` key
- WHEN `readCart` is called
- THEN the result MUST be `{ items: [], idempotencyKey: '' }`
- AND `expectedTotalCents` MUST be `undefined`.

#### Scenario: expectedTotalCents round-trips from evaluateCart to createSale

- GIVEN a cart with one item and `expectedTotalCents` unset
- AND `evaluateCart` (§4.4.3) returned `totalCents: 1500`
- WHEN `evaluateCart`'s tool `execute` returns
- THEN the persisted `CartState.expectedTotalCents` MUST equal `1500`
- AND the next `createSale` invocation MUST read it from the cart and forward `expectedTotalCents: 1500` on the wire
- AND the value MUST NOT be sourced from the model's input.

#### Scenario: legacy carts without expectedTotalCents are accepted

- GIVEN a stored cart `{ items: [...], idempotencyKey: '<uuid>' }` (no `expectedTotalCents`)
- WHEN `isCartState` is applied to the parsed JSON
- THEN the guard MUST accept the shape (no Zod error)
- AND the next `createSale` invocation MUST omit `expectedTotalCents` on the wire
- AND the outgoing DTO MUST NOT contain the key `expectedTotalCents` at all (never `0` and never `null`).

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

On `PROMO_RE_QUOTE`, the tool MUST include `recomputedTotalCents`, `expectedTotalCents`, and `discountCents` (numeric cents values from the backend envelope) in the error envelope so the model can show the new totals and re-confirm with the customer. On success (`ok: true`), the tool MUST extract `discountCents` from `BotSaleResponse` and surface it in the success envelope; the cart (items + idempotencyKey + expectedTotalCents) MUST be cleared before the tool returns.

(Previously: list-price-only `createSale` with single success/clear-cart semantics; no `errorCode` discrimination; no `expectedTotalCents`; no `discountCents`; the cart sent `originalPriceCents` per item and ignored `finalPriceCents`.)

#### Scenario: first attempt persists the idempotency key

- GIVEN an empty cart for sender S (no prior `idempotencyKey`, no prior `expectedTotalCents`)
- AND the backend `POST /chatbot-api/sales` (§4.4.6) returns `{ saleId: "sale-1", discountCents: 0 }`
- WHEN `createSale` is invoked with a valid cart
- THEN the first outgoing HTTP request MUST include an `X-Idempotency-Key` header whose value is a UUID v4
- AND the persisted cart MUST contain that same key
- AND the next call's outgoing request (identical payload) MUST include the same key.

#### Scenario: cart's item unitPriceCents are forwarded as the item-level price

- GIVEN `evaluateCart` (§4.4.3) returned an item with `originalPriceCents: 1000` and that value was stored on the cart as `unitPriceCents: 1000`
- WHEN `createSale` is invoked with that cart in scope
- THEN the outgoing `POST /chatbot-api/sales` body MUST contain `items[0].unitPriceCents === 1000` (the cart's recorded add-time price)
- AND the outgoing DTO MUST also contain the top-level `expectedTotalCents` sourced from `CartState.expectedTotalCents` (NEVER from the model's input).

#### Scenario: PROMO_RE_QUOTE clears the idempotency key and preserves the cart items

- GIVEN a cart with one item, a persisted `idempotencyKey`, and `expectedTotalCents: 1000`
- AND the backend returns `409` with `errorCode: 'PROMO_RE_QUOTE'`, `recomputedTotalCents: 900`, `expectedTotalCents: 1000`, `discountCents: 100`
- WHEN `createSale` runs
- THEN the result MUST deep-equal `{ ok: false, error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 } }`
- AND `readCart(S).items` MUST remain unchanged
- AND `readCart(S).expectedTotalCents` MUST remain `1000`
- AND `readCart(S).idempotencyKey` MUST equal `''` (cleared so the re-confirmation mints a fresh key).

#### Scenario: IDEMPOTENCY_KEY_IN_FLIGHT returns a retryable kind and preserves the key

- GIVEN a cart with one item and a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'IDEMPOTENCY_KEY_IN_FLIGHT'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal `{ ok: false, error: { kind: 'idempotencyInFlight', retryable: true } }`
- AND `readCart(S).idempotencyKey` MUST equal the previously persisted value (the model retries the same call later).

#### Scenario: IDEMPOTENCY_KEY_CONFLICT clears the idempotency key

- GIVEN a cart with a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'IDEMPOTENCY_KEY_CONFLICT'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal `{ ok: false, error: { kind: 'idempotencyConflict', retryable: false } }`
- AND `readCart(S).idempotencyKey` MUST equal `''` so the next attempt mints a fresh UUID v4.

#### Scenario: PRICE_OUT_OF_DATE returns the priceOutOfDate kind

- GIVEN a cart with a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'PRICE_OUT_OF_DATE'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal `{ ok: false, error: { kind: 'priceOutOfDate', retryable: false } }`.

#### Scenario: cart is cleared on success

- GIVEN a cart with one item, a persisted `idempotencyKey`, and `expectedTotalCents: 1500`
- AND the backend returns `{ ok: true, sale: { saleId: "sale-1", discountCents: 0 } }`
- WHEN `createSale` runs
- THEN the tool's success envelope MUST include `discountCents: 0`
- AND a subsequent `readCart(S)` MUST equal `{ items: [], idempotencyKey: '', expectedTotalCents: undefined }`.

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
14. End the conversation.

The composed system prompt MUST equal
`SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`, concatenated ONCE at module boot (one-shot, never per-turn). The base `SYSTEM_PROMPT` MUST be appended unmodified. `composeSaleFlowSystemPrompt` MUST collapse to `(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`; the `bankDetails` parameter and the `renderBankDetailsBlock` export are deleted. The `BankDetails` type is deleted.

The slice MUST include in `SALE_FLOW_INSTRUCTIONS`, at minimum:

- A `getPaymentDetails`-after-`createSale` gating rule (`getPaymentDetails` MUST NOT be called before `createSale` confirms a sale).
- The human-handoff phrase `en un momento un agente te comparte los datos de pago` byte-identical when the tool returns the `noActivePaymentDetail` kind.
- A no-fabrication rule: never invent a price, a stock quantity, or a bank detail; always call the relevant tool.
- The refusal phrase `esa función aún no está disponible` preserved verbatim.
- A `PROMO_RE_QUOTE` rule that the bot re-confirms with the customer exactly once and re-emits `createSale` with a fresh UUID v4 on acceptance.

(Previously: step 12 read `Send the R11 bank-details message and ask for the transfer receipt` with no `getPaymentDetails` tool call; no `bankDetails` parameter collapse documented here; `BankDetailsProvider` was the boot-time seam.)

#### Scenario: composed prompt contains the contractual strings

- GIVEN the application has booted with `SaleFlowModule` imported
- WHEN the agent runner reads the system prompt from its config source
- THEN the composed prompt MUST contain (i) the literal phrase `esa función aún no está disponible`; (ii) the forbidden slang block covering voseo and the regional slang examples listed in the base `SYSTEM_PROMPT`; (iii) the sale-flow step list above (1–14); (iv) the `getPaymentDetails`-after-`createSale` gating instruction; (v) the `PROMO_RE_QUOTE` re-confirmation rule.

#### Scenario: composition happens at boot, not per turn

- GIVEN `ConversationStore` has 50 turns of prior history for sender S
- WHEN the agent runner handles three consecutive inbounds
- THEN `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` MUST be computed exactly once at module boot
- AND subsequent turns MUST reuse the same composed string (byte-identical)
- AND no `await bankDetails.get()` call MUST appear in the prompt factory (the function MUST collapse to `(base) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`).

#### Scenario: step 12 human-handoff phrase is byte-identical

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS` is exported from `src/sale-flow/domain/sale-flow-instructions.ts`
- WHEN the test parses the string for the step-12 instruction
- THEN the substring MUST contain the exact phrase `en un momento un agente te comparte los datos de pago`
- AND the phrase MUST be wrapped in a `getPaymentDetails` 404 branch so the model emits it ONLY on the `noActivePaymentDetail` kind
- AND the phrase MUST NOT be edited for grammar, punctuation, or wording when the bot is re-prompted (byte-identical snapshot test).

## REMOVED Requirements

### Requirement: BankDetailsProvider is a swappable seam

(Reason: The boot-time port captured bank data at process start; admin updates to the active `PaymentDetail` between boot and the customer's transfer message produced silently stale CLABEs. The runtime `getPaymentDetails` tool makes the per-turn HTTP call the source of truth, so the boot-time seam and every reference to `BankDetailsProvider` / `BANK_DETAILS_PROVIDER` / `bankDetails` is deleted entirely.)
(Migration: All `BankDetailsProvider` / `BANK_DETAILS_PROVIDER` / `bankDetails` / `BankDetails` / `renderBankDetailsBlock` / `composeSaleFlowSystemPrompt(…, bankDetails)` references are removed. The prompt factory loses its `bankDetails` parameter and `composeSaleFlowSystemPrompt` collapses to `(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`. `ToolDeps` loses `bankDetails`. `RealToolRegistry` loses the `@Inject(BANK_DETAILS_PROVIDER)` constructor parameter. `SaleFlowModule` removes the `BANK_DETAILS_PROVIDER` provider binding and the `NullBankDetailsProvider` import. `LlmAgentModule`'s `LLM_AGENT_SYSTEM_PROMPT` factory resolves to `composeSaleFlowSystemPrompt(SYSTEM_PROMPT)` with no `await bankDetails.get()` call. The 10th tool `getPaymentDetails` carries the seam's intent end-to-end. The literal step 12 phrase "en un momento un agente te comparte los datos de pago" stays byte-identical — only the gating rule ("call `getPaymentDetails` after `createSale` confirms") is added. Test fixtures referencing `BankDetailsProvider` / `NullBankDetailsProvider` are removed; `git grep BANK_DETAILS_PROVIDER` MUST return no matches in `src/`.)
