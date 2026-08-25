# sale-flow-tools Spec

## Purpose

Provide the chatbot-side sale-flow tool surface: ten AI-SDK tools (`searchCatalog`,
`checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`,
`attachReceipt`, `updateDelivery`, `getOrderHistory`, `getPaymentDetails`) registered
through a `RealToolRegistry` and bound as the production `TOOL_REGISTRY` in
`LlmAgentModule`. The capability also defines the per-sender cart held in
`ConversationState.data.cart` (with the optional `expectedTotalCents?: number` field),
the stable error envelope returned to the model instead of raw HTTP (now eleven
discriminated `kind` values, including the four new backend-envelope-driven branches
`noActivePaymentDetail`, `promoReQuote`, `idempotencyInFlight`, `idempotencyConflict`,
`priceOutOfDate`), the boot-composed `SALE_FLOW_INSTRUCTIONS` system-prompt extension
(step 12 now calls the runtime `getPaymentDetails` tool instead of the deleted
`BankDetailsProvider` boot-time seam), and the `CHATBOT_API_CASHIER_USER_ID` boot
contract. All backend writes go through the existing chatbot-api endpoints documented
in `AGENTS.md` §4.4.1–§4.4.10; the chatbot remains a consumer only.

## Requirements

### Requirement: RealToolRegistry registers the ten sale-flow tools

A `RealToolRegistry` MUST register exactly the ten sale-flow AI-SDK tools listed below,
replacing `InMemoryToolRegistry` in the production wiring of `LlmAgentModule`. Each
tool's parameter name MUST match the corresponding chatbot-api endpoint field name
documented in `AGENTS.md` §4.4.x verbatim.

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

`LlmAgentModule` MUST resolve the `TOOL_REGISTRY` provider to `RealToolRegistry`,
which MUST inject `CHATBOT_API_CLIENT` and `CONVERSATION_STORE`. `RealToolRegistry`
MUST inject `BANK_DETAILS_PROVIDER` no longer; its constructor MUST depend only on
`chatbotApi` and `store`. `RealToolRegistry` MUST NOT be an in-memory placeholder.

#### Scenario: Registry exposes all ten tools

- GIVEN a Nest testing module with `RealToolRegistry` and a stubbed `ChatbotApiClient`
- WHEN `registry.getTools()` is called
- THEN the returned AI-SDK ToolSet MUST contain every key `searchCatalog`,
  `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`,
  `attachReceipt`, `updateDelivery`, `getOrderHistory`, `getPaymentDetails`
- AND the ToolSet MUST NOT contain any other key beyond these ten.

#### Scenario: LlmAgentModule wires RealToolRegistry with ChatbotApiClient + ConversationStore

- GIVEN a production `LlmAgentModule` build with all `AppModule` imports in place
- WHEN the DI container resolves the `TOOL_REGISTRY` provider
- THEN the resolved instance MUST be `RealToolRegistry`
- AND its constructor MUST have received `CHATBOT_API_CLIENT` (bound to
  `ChatbotApiHttpClient`) AND `CONVERSATION_STORE` (bound to the durable Postgres
  adapter per the `conversation-store` spec).

#### Scenario: Placeholder registry is no longer the production binding

- GIVEN the production wiring of `LlmAgentModule`
- WHEN the module is inspected
- THEN `InMemoryToolRegistry` MUST NOT be registered as the `TOOL_REGISTRY`
  provider (it MAY remain in the repository as a test fixture)
- AND `BANK_DETAILS_PROVIDER` MUST NOT appear in the DI bindings of `SaleFlowModule`
  or `LlmAgentModule`.

### Requirement: Tool input schemas enforce AGENTS.md §4.4 validations

Each tool's `inputSchema` (Zod object) MUST enforce the validations declared in
`AGENTS.md` §4.4.x for the corresponding endpoint, including at minimum:

- UUID parameters (`productId`, `variantId`, `customerId`, `saleId`,
  `shippingAddressId`) MUST be `z.string().uuid()`.
- Quantity / `unitPriceCents` / `declaredAmountCents` MUST be `z.number().int()`
  with `.min(1)` (or `.min(0)` where the contract specifies `@Min(0)`).
- `mediaUrl` MUST be `z.string().url()` (matching `@IsUrl()`).
- Search `q` MUST be `z.string().min(1)`; optional `limit` MUST be
  `z.number().int().min(1).max(20)` with `.default(10)` when absent.
- `phoneCountryCode` MUST be `z.string().min(1).max(10)`;
  `phone` MUST be `z.string().min(1).max(20)`.
- `getPaymentDetails.inputSchema` MUST be `z.object({})` (no parameters allowed).

#### Scenario: A representative schema rejects malformed inputs

- GIVEN the `attachReceipt` tool
- WHEN the model invokes it with `{ saleId: "not-a-uuid", mediaUrl: "not-a-url",
  declaredAmountCents: 0 }`
- THEN the schema parse MUST fail with a Zod error
- AND the underlying `chatbotApi.attachReceipt` MUST NOT be called.

### Requirement: Tools return a stable error envelope instead of raw HTTP

When `ChatbotApiHttpClient` throws (any of `AuthError`, `ForbiddenError`,
`NotFoundError`, `RateLimitError`, `UpstreamError`, or a `ChatbotApiError` with a
non-null `statusCode`), the tool's `execute` MUST catch the error and return
`{ ok: false, error: { kind, retryable } }` — never the raw exception, never a raw
HTTP status, never a stack trace — so the model can phrase a user-friendly reply
or trigger a retry.

`kind` MUST be one of
`'auth' | 'forbidden' | 'notFound' | 'rateLimit' | 'upstream' | 'validation' | 'noActivePaymentDetail' | 'promoReQuote' | 'idempotencyInFlight' | 'idempotencyConflict' | 'priceOutOfDate'`,
and `retryable` MUST be `true` for transient `upstream` and `rateLimit` cases and
`false` otherwise.

The mapping layer (`src/sale-flow/application/error-mapping.ts`) MUST discriminate
on the `ChatbotApiError.errorCode` FIRST, and MUST fall back to the HTTP-status-keyed
mapping only when `errorCode` is `null`:

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

`errorCode`-first means: when the error body carries an `error` field, that field
picks the `kind` BEFORE the HTTP status. When `errorCode` is `null` (legacy backend
or transport-level failure), the HTTP status mapping above applies. The bot MUST
NEVER parse the `message` string for branching.

#### Scenario: upstream 5xx becomes retryable upstream envelope

- GIVEN the `evaluateCart` tool is invoked with a valid input
- AND the stubbed `ChatbotApiHttpClient.evaluateCart` throws `UpstreamError`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'upstream', retryable: true } }`
- AND the thrown error MUST NOT propagate.

#### Scenario: 404 without errorCode surfaces as a non-retryable notFound envelope

- GIVEN the `checkStock` tool
- AND the stubbed `ChatbotApiHttpClient.getStock` throws a `ChatbotApiError` with
  `statusCode: 404` and `errorCode: null`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'notFound', retryable: false } }`.

#### Scenario: errorCode wins over HTTP status for createSale

- GIVEN the `createSale` tool is invoked with a valid cart
- AND the stubbed `ChatbotApiHttpClient.createSale` throws a `ChatbotApiError` with
  `statusCode: 409` and `errorCode: 'PROMO_RE_QUOTE'`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 } }`
  (totals surfaced from the error envelope)
- AND the HTTP-status-first branch (`validation`) MUST NOT have been taken.

#### Scenario: legacy backend without errorCode falls back to validation

- GIVEN a tool is invoked
- AND the stubbed `ChatbotApiHttpClient` throws a `ChatbotApiError` with
  `statusCode: 422` and `errorCode: null`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'validation', retryable: false } }`.

### Requirement: Per-sender cart lives in ConversationState.data.cart

The per-sender cart MUST be persisted under `ConversationState.data.cart`, with no
new storage table and no schema migration. The slice MUST NOT introduce a new
module-owned storage layer.

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

Helpers `readCart(state)` and `writeCart(state, patch)` MUST exist and MUST mirror
the `readMessages`/`writeMessages` pattern: a missing `cart` MUST default to
`{ items: [], idempotencyKey: '', expectedTotalCents: undefined }`; subsequent writes
MUST shallow-merge the patch over the existing cart and persist via
`ConversationStore.update(senderId, ...)` (reusing the durable Postgres UPSERT path).
The `isCartState` type guard MUST treat a missing `expectedTotalCents` as a valid
legacy cart (no validation error).

#### Scenario: cart round-trips through the durable ConversationStore

- GIVEN a sender with `ConversationState.data.cart = { items: [], idempotencyKey: '' }`
- WHEN `writeCart` is called with a patch that adds one item, a fresh idempotency
  key, and `expectedTotalCents: 1500`
- THEN a subsequent `readCart` MUST deep-equal
  `{ items: [...], idempotencyKey: '<uuid>', expectedTotalCents: 1500 }`
- AND the underlying `ConversationStore.update` MUST replace the `data` field as a
  whole (no JSONB deep merge at the storage layer) per the `conversation-store`
  spec.

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
- AND the next `createSale` invocation MUST read it from the cart and forward
  `expectedTotalCents: 1500` on the wire
- AND the value MUST NOT be sourced from the model's input.

#### Scenario: legacy carts without expectedTotalCents are accepted

- GIVEN a stored cart `{ items: [...], idempotencyKey: '<uuid>' }` (no
  `expectedTotalCents`)
- WHEN `isCartState` is applied to the parsed JSON
- THEN the guard MUST accept the shape (no Zod error)
- AND the next `createSale` invocation MUST omit `expectedTotalCents` on the wire
- AND the outgoing DTO MUST NOT contain the key `expectedTotalCents` at all (never
  `0` and never `null`).

### Requirement: createSale sends expectedTotalCents and handles the five new error codes per the promo/idempotency contract

The `createSale` tool MUST forward each cart item's `unitPriceCents` from the cart as
the item-level price (the value recorded at add-to-cart time). The tool MUST forward
the cart's persisted `expectedTotalCents` (when present) on the wire as the top-level
`expectedTotalCents` field of the DTO — NEVER from the model's input. The tool MUST
mint a fresh client-side UUID v4 (`crypto.randomUUID()`) for the first attempt and
persist it on the cart, and MUST reuse the same key only for identical-payload
retries within the sender's session.

The tool MUST branch on `ChatbotApiError.errorCode` for the four new codes plus
`PRICE_OUT_OF_DATE`. On each branch the tool MUST clear or preserve the persisted
`idempotencyKey` per the contract:

| Backend `errorCode` (`statusCode`) | Returned `kind` | `retryable` | Cart `items` | Cart `idempotencyKey` | Surface `discountCents`? |
|---|---|---|---|---|---|
| `PROMO_RE_QUOTE` (409) | `promoReQuote` | `false` | preserved | cleared | yes (in error envelope) |
| `IDEMPOTENCY_KEY_IN_FLIGHT` (409) | `idempotencyInFlight` | `true` | preserved | preserved | n/a |
| `IDEMPOTENCY_KEY_CONFLICT` (409) | `idempotencyConflict` | `false` | preserved | cleared | n/a |
| `PRICE_OUT_OF_DATE` (409) | `priceOutOfDate` | `false` | preserved | preserved | n/a |
| `INVALID_IDEMPOTENCY_KEY` (400) | `validation` | `false` | preserved | preserved | n/a |

On `PROMO_RE_QUOTE`, the tool MUST include `recomputedTotalCents`, `expectedTotalCents`,
and `discountCents` (numeric cents values from the backend envelope) in the error
envelope so the model can show the new totals and re-confirm with the customer. On
success (`ok: true`), the tool MUST extract `discountCents` from `BotSaleResponse` and
surface it in the success envelope; the cart (items + idempotencyKey +
expectedTotalCents) MUST be cleared before the tool returns.

#### Scenario: first attempt persists the idempotency key

- GIVEN an empty cart for sender S (no prior `idempotencyKey`, no prior
  `expectedTotalCents`)
- AND the backend `POST /chatbot-api/sales` (§4.4.6) returns `{ saleId: "sale-1",
  discountCents: 0 }`
- WHEN `createSale` is invoked with a valid cart
- THEN the first outgoing HTTP request MUST include an `X-Idempotency-Key` header
  whose value is a UUID v4
- AND the persisted cart MUST contain that same key
- AND the next call's outgoing request (identical payload) MUST include the same key.

#### Scenario: cart's item unitPriceCents are forwarded as the item-level price

- GIVEN `evaluateCart` (§4.4.3) returned an item with `originalPriceCents: 1000` and
  that value was stored on the cart as `unitPriceCents: 1000`
- WHEN `createSale` is invoked with that cart in scope
- THEN the outgoing `POST /chatbot-api/sales` body MUST contain
  `items[0].unitPriceCents === 1000` (the cart's recorded add-time price)
- AND the outgoing DTO MUST also contain the top-level `expectedTotalCents` sourced
  from `CartState.expectedTotalCents` (NEVER from the model's input).

#### Scenario: PROMO_RE_QUOTE clears the idempotency key and preserves the cart items

- GIVEN a cart with one item, a persisted `idempotencyKey`, and
  `expectedTotalCents: 1000`
- AND the backend returns `409` with `errorCode: 'PROMO_RE_QUOTE'`,
  `recomputedTotalCents: 900`, `expectedTotalCents: 1000`, `discountCents: 100`
- WHEN `createSale` runs
- THEN the result MUST deep-equal
  `{ ok: false, error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 } }`
- AND `readCart(S).items` MUST remain unchanged
- AND `readCart(S).expectedTotalCents` MUST remain `1000`
- AND `readCart(S).idempotencyKey` MUST equal `''` (cleared so the re-confirmation
  mints a fresh key).

#### Scenario: IDEMPOTENCY_KEY_IN_FLIGHT returns a retryable kind and preserves the key

- GIVEN a cart with one item and a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'IDEMPOTENCY_KEY_IN_FLIGHT'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal
  `{ ok: false, error: { kind: 'idempotencyInFlight', retryable: true } }`
- AND `readCart(S).idempotencyKey` MUST equal the previously persisted value (the
  model retries the same call later).

#### Scenario: IDEMPOTENCY_KEY_CONFLICT clears the idempotency key

- GIVEN a cart with a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'IDEMPOTENCY_KEY_CONFLICT'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal
  `{ ok: false, error: { kind: 'idempotencyConflict', retryable: false } }`
- AND `readCart(S).idempotencyKey` MUST equal `''` so the next attempt mints a
  fresh UUID v4.

#### Scenario: PRICE_OUT_OF_DATE returns the priceOutOfDate kind

- GIVEN a cart with a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'PRICE_OUT_OF_DATE'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal
  `{ ok: false, error: { kind: 'priceOutOfDate', retryable: false } }`.

#### Scenario: cart is cleared on success

- GIVEN a cart with one item, a persisted `idempotencyKey`, and
  `expectedTotalCents: 1500`
- AND the backend returns `{ ok: true, sale: { saleId: "sale-1", discountCents: 0 } }`
- WHEN `createSale` runs
- THEN the tool's success envelope MUST include `discountCents: 0`
- AND a subsequent `readCart(S)` MUST equal
  `{ items: [], idempotencyKey: '', expectedTotalCents: undefined }`.

### Requirement: SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot

`SALE_FLOW_INSTRUCTIONS` MUST be a string literal (in
`src/sale-flow/domain/sale-flow-instructions.ts`) that encodes the escrow-style
sale flow:

1. Greet.
2. Ask what product the customer wants.
3. Call `searchCatalog` and present results.
4. Confirm the chosen product.
5. Call `checkStock` for the chosen product.
6. Add the item to the cart (locally persisted via `writeCart`).
7. Ask whether to add another item or proceed to review.
8. Call `evaluateCart` and surface the price quote to the customer.
9. Collect or confirm customer data (phone + name; reuse `getCustomerByPhone` then
   `upsertCustomer` with the address field per AGENTS.md §4.4.5).
10. Send an order summary (structured, bulleted — same format as the real human
    agent in conversation #1).
11. Call `createSale`, forwarding `expectedTotalCents` from the cart; on
    `PROMO_RE_QUOTE`, show the new totals to the customer, ask for explicit
    confirmation, and on acceptance re-emit `createSale` with a fresh UUID v4
    idempotency key (NEVER reuse the previous key after `PROMO_RE_QUOTE`).
12. **After `createSale` returns `ok: true`, call `getPaymentDetails` (inputSchema:
    empty object). If the result is `{ ok: false, error: { kind: 'noActivePaymentDetail' } }`,
    reply EXACTLY with `en un momento un agente te comparte los datos de pago` and
    pause. Otherwise render the bank-details block (bankName, beneficiary, clabe,
    accountNumber) and ask for the transfer receipt.** Never call
    `getPaymentDetails` before `createSale` confirms a sale.
13. On receipt image, call `attachReceipt`.
14. End the conversation.

The composed system prompt MUST equal
`SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`, concatenated ONCE at module boot
(one-shot, never per-turn). The base `SYSTEM_PROMPT` MUST be appended unmodified.
`composeSaleFlowSystemPrompt` MUST collapse to
`(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`; the `bankDetails`
parameter and the `renderBankDetailsBlock` export are deleted. The `BankDetails` type
is deleted.

The slice MUST include in `SALE_FLOW_INSTRUCTIONS`, at minimum:

- A `getPaymentDetails`-after-`createSale` gating rule (`getPaymentDetails` MUST NOT
  be called before `createSale` confirms a sale).
- The human-handoff phrase `en un momento un agente te comparte los datos de pago`
  byte-identical when the tool returns the `noActivePaymentDetail` kind.
- A no-fabrication rule: never invent a price, a stock quantity, or a bank detail;
  always call the relevant tool.
- The refusal phrase `esa función aún no está disponible` preserved verbatim.
- A `PROMO_RE_QUOTE` rule that the bot re-confirms with the customer exactly once and
  re-emits `createSale` with a fresh UUID v4 on acceptance.

#### Scenario: composed prompt contains the contractual strings

- GIVEN the application has booted with `SaleFlowModule` imported
- WHEN the agent runner reads the system prompt from its config source
- THEN the composed prompt MUST contain (i) the literal phrase
  `esa función aún no está disponible`; (ii) the forbidden slang block covering
  voseo and the regional slang examples listed in the base `SYSTEM_PROMPT`; (iii)
  the sale-flow step list above (1–14); (iv) the `getPaymentDetails`-after-`createSale`
  gating instruction; (v) the `PROMO_RE_QUOTE` re-confirmation rule.

#### Scenario: composition happens at boot, not per turn

- GIVEN `ConversationStore` has 50 turns of prior history for sender S
- WHEN the agent runner handles three consecutive inbounds
- THEN `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` MUST be computed exactly
  once at module boot
- AND subsequent turns MUST reuse the same composed string (byte-identical)
- AND no `await bankDetails.get()` call MUST appear in the prompt factory (the
  function MUST collapse to `(base) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`).

#### Scenario: step 12 human-handoff phrase is byte-identical

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS` is exported from
  `src/sale-flow/domain/sale-flow-instructions.ts`
- WHEN the test parses the string for the step-12 instruction
- THEN the substring MUST contain the exact phrase
  `en un momento un agente te comparte los datos de pago`
- AND the phrase MUST be wrapped in a `getPaymentDetails` 404 branch so the model
  emits it ONLY on the `noActivePaymentDetail` kind
- AND the phrase MUST NOT be edited for grammar, punctuation, or wording when the
  bot is re-prompted (byte-identical snapshot test).

### Requirement: getPaymentDetails is the tenth sale-flow tool

`RealToolRegistry` MUST register an AI-SDK tool `getPaymentDetails` whose:

- `inputSchema` is `z.object({})` (no parameters, no body).
- `description` instructs the model to call this tool ONLY AFTER `createSale` returns
  success, exactly once per confirmed sale, to render the bank transfer details.
- `execute` calls `chatbotApi.getPaymentDetails()` and returns:
  - On HTTP 200: `{ ok: true, paymentDetail: PaymentDetail }` where `PaymentDetail`
    is the bot-safe projection `{ id, bankName, beneficiary, clabe, accountNumber,
    isActive, updatedAt }` (no `tenantId`, no `createdAt`).
  - On `ChatbotApiError` with `errorCode === 'NO_ACTIVE_PAYMENT_DETAIL'`:
    `{ ok: false, error: { kind: 'noActivePaymentDetail', retryable: false } }`.
  - On any other `ChatbotApiError`: `{ ok: false, error: { kind, retryable } }` from
    the discriminated mapping.

The literal `SALE_FLOW_INSTRUCTIONS` step 12 MUST instruct the model to call
`getPaymentDetails` ONLY after `createSale` succeeds and MUST emit the exact
human-handoff phrase `en un momento un agente te comparte los datos de pago` when
the tool returns `kind: 'noActivePaymentDetail'`.

#### Scenario: successful 200 returns the PaymentDetail projection

- GIVEN a `RealToolRegistry` with `getPaymentDetails` registered
- AND a stubbed `chatbotApi.getPaymentDetails()` that resolves to
  `{ id: 'p-1', bankName: 'AFIRME', beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV', clabe: '012345678901234567', accountNumber: '1234567890', isActive: true, updatedAt: '2026-08-24T12:00:00.000Z' }`
- WHEN the model invokes `getPaymentDetails` with `{}`
- THEN the tool's execute MUST call `chatbotApi.getPaymentDetails()` exactly once
  with no arguments
- AND the returned envelope MUST deep-equal
  `{ ok: true, paymentDetail: { id: 'p-1', bankName: 'AFIRME', beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV', clabe: '012345678901234567', accountNumber: '1234567890', isActive: true, updatedAt: '2026-08-24T12:00:00.000Z' } }`
- AND the returned `paymentDetail` MUST NOT contain `tenantId` or `createdAt`.

#### Scenario: 404 NO_ACTIVE_PAYMENT_DETAIL maps to noActivePaymentDetail kind

- GIVEN the `getPaymentDetails` tool is invoked
- AND a stubbed `chatbotApi.getPaymentDetails()` throws a `ChatbotApiError` with
  `statusCode: 404` and `errorCode: 'NO_ACTIVE_PAYMENT_DETAIL'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal
  `{ ok: false, error: { kind: 'noActivePaymentDetail', retryable: false } }`
- AND the thrown error MUST NOT propagate.

#### Scenario: inputSchema accepts an empty payload and rejects unknown keys

- GIVEN the `getPaymentDetails` tool
- WHEN the model invokes it with an empty object `{}`
- THEN the Zod parse MUST succeed
- AND the underlying `chatbotApi.getPaymentDetails` MUST be called with no arguments
- AND when invoked with any extra key (e.g. `{ extra: 'x' }`), the Zod parse MUST
  fail with a clear error (the schema is `z.object({})`, not
  `z.object({}).passthrough()`).

#### Scenario: step 12 of the literal gates the call to "after createSale succeeds"

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS`
- WHEN the test extracts step 12
- THEN the text MUST contain the rule
  `Llama a \`getPaymentDetails\` después de que \`createSale\` confirme`
- AND the text MUST contain the rule that `getPaymentDetails` MUST NOT be called
  before `createSale` confirms a sale
- AND the text MUST contain the exact human-handoff phrase
  `en un momento un agente te comparte los datos de pago` for the
  `noActivePaymentDetail` branch.

### Requirement: Idempotency key lifecycle

The `createSale` tool MUST follow this key lifecycle, in order, per sender session:

1. On the first invocation for a sender (or when the persisted `idempotencyKey` is
   `''` after a prior clear), MUST mint a fresh `crypto.randomUUID()` (UUID v4, ≤ 36
   chars) and persist it on the cart before the HTTP request goes out.
2. On identical-payload retries (same `items`, same `cashierUserId`, same
   `customerId`, same `shippingAddressId`, same `expectedTotalCents`) within the same
   session, MUST reuse the persisted key.
3. MUST clear the persisted `idempotencyKey` (set to `''`) on: `createSale` success,
   `PROMO_RE_QUOTE` outcome, and `IDEMPOTENCY_KEY_CONFLICT` outcome. The next call
   mints a fresh UUID v4 (different payload → different key).
4. MUST preserve the persisted `idempotencyKey` on `IDEMPOTENCY_KEY_IN_FLIGHT`
   outcome (same payload, same in-flight slot); the model retries later.
5. Each distinct payload (different cart contents, different `cashierUserId`,
   different `customerId`, different `shippingAddressId`, or different
   `expectedTotalCents`) MUST produce a fresh UUID v4 key on the next mint — never
   reuse a cleared key.

#### Scenario: identical-payload retry reuses the persisted key

- GIVEN a cart with `idempotencyKey: '<uuid-A>'` and items +
  `expectedTotalCents` that have not changed
- WHEN `createSale` is invoked twice in a row with the same inputs (network 503 in
  between)
- THEN both outgoing requests MUST carry the `X-Idempotency-Key` header value
  `<uuid-A>` (no fresh mint).

#### Scenario: distinct payload mints a fresh UUID v4

- GIVEN a cart with `idempotencyKey: ''` (cleared after a previous `PROMO_RE_QUOTE`
  or after success)
- WHEN `createSale` is invoked with a different cart (one item added, one removed,
  quantity changed, or `expectedTotalCents` changed)
- THEN the outgoing request MUST carry an `X-Idempotency-Key` whose value is a new
  UUID v4
- AND the previously cleared key MUST NOT appear on the wire.

#### Scenario: key rotation after PROMO_RE_QUOTE uses a fresh UUID v4

- GIVEN a `createSale` returned `kind: 'promoReQuote'`, which left the cart `items`
  and `expectedTotalCents` preserved and the cart `idempotencyKey` cleared
- WHEN the customer accepts the new total and the model invokes `createSale` again
- THEN the outgoing request MUST carry an `X-Idempotency-Key` whose value is a new
  UUID v4
- AND the new key MUST structurally differ from the key in effect before the
  `PROMO_RE_QUOTE` (regenerated UUID v4 vs. the persisted pre-clear value).

### Requirement: BotSaleResponse.discountCents is surfaced on success

When `createSale` returns the success envelope, the envelope MUST surface
`discountCents` (a non-negative integer cents value) from `BotSaleResponse`. The
model uses this to render the confirmation message:

- When `discountCents > 0`, the model MUST render `Descuento aplicado: $X` (where
  `$X` is the cents expressed in pesos with the appropriate formatting) in the
  confirmation message.
- When `discountCents === 0`, the model MUST NOT add a discount line to the
  confirmation message.

The `discountCents` value is the one the backend returned on the FINAL successful
`createSale`. The bot MUST NOT compute or estimate `discountCents` from prior
`evaluateCart` responses; it MUST be sourced from the response envelope.

#### Scenario: discountCents greater than zero is surfaced to the model

- GIVEN a successful `createSale` response with `discountCents: 250`
- WHEN the tool's `execute` returns
- THEN the success envelope MUST include `discountCents: 250`
- AND the test fixture that mocks the model MUST observe that the rendered
  confirmation message contains the line `Descuento aplicado: $250` (or its
  localized equivalent).

#### Scenario: discountCents equal to zero is silent

- GIVEN a successful `createSale` response with `discountCents: 0`
- WHEN the tool's `execute` returns
- THEN the success envelope MUST include `discountCents: 0`
- AND the model MUST NOT add a `Descuento aplicado` line to the confirmation
  message.

### Requirement: ChatbotApiError surfaces the backend errorCode envelope field

`ChatbotApiError` MUST carry an additional field `errorCode: string | null` populated
from the backend envelope's `responseBody.error`. `mapError` in
`src/chatbot-api/infrastructure/chatbot-api-http.client.ts` MUST populate `errorCode`
for every mapped response (4xx and 5xx) that returns a JSON body with an `error`
string. When the transport itself fails (no body), when the body has no `error`
field, or when the body is not JSON, `errorCode` MUST be `null`.

The error-mapping layer in `src/sale-flow/application/error-mapping.ts` MUST branch
on `errorCode` BEFORE the HTTP status so a `409 PROMO_RE_QUOTE` always maps to
`kind: 'promoReQuote'` regardless of HTTP semantics.

#### Scenario: errorCode is populated from responseBody.error

- GIVEN the backend returns `409` with body
  `{ statusCode: 409, error: 'PROMO_RE_QUOTE', message: 'Price changed' }`
- WHEN the HTTP client maps the response
- THEN `ChatbotApiError.errorCode` MUST equal `'PROMO_RE_QUOTE'`
- AND the thrown error MUST carry `statusCode: 409`.

#### Scenario: errorCode is null when the body has no error field

- GIVEN the backend returns `422` with body
  `{ statusCode: 422, message: 'Validation failed' }` (no `error` field)
- WHEN the HTTP client maps the response
- THEN `ChatbotApiError.errorCode` MUST equal `null`
- AND the error-mapping layer MUST fall back to the HTTP status (`422` →
  `validation`).

#### Scenario: errorCode is null when the transport itself fails

- GIVEN the HTTP transport rejects with a network error before any response body
  arrives
- WHEN the HTTP client maps the failure
- THEN `ChatbotApiError.errorCode` MUST equal `null`
- AND the thrown error MUST be `UpstreamError` (or the existing transport-level
  type), not a status-bearing `ChatbotApiError`.

### Requirement: updateDelivery is registered but not exercised by this slice

The `updateDelivery` tool MUST be registered in `RealToolRegistry` (so the model
knows it exists for future slices), but the conversational flow encoded in
`SALE_FLOW_INSTRUCTIONS` MUST NOT promise a shipping cost and MUST NOT call this
tool. Tests MUST assert that no scenario path triggers `updateDelivery` end-to-end
through this slice.

#### Scenario: updateDelivery is in the registry but not invoked in the slice

- GIVEN the `RealToolRegistry` binding
- WHEN `registry.getTools()` is called
- THEN `updateDelivery` MUST be present in the returned ToolSet
- AND any integration test that exercises the slice's conversational program
  MUST NOT observe a `PATCH /chatbot-api/sales/:saleId/delivery` request.

### Requirement: CHATBOT_API_CASHIER_USER_ID is required at boot

The environment MUST provide `CHATBOT_API_CASHIER_USER_ID` as a UUID v4.
The Joi validation pipeline in `src/config/env.validation.ts` MUST reject boot
when the variable is absent or not a valid UUID, before any webhook traffic is
accepted. The resolved value MUST be sent as `cashierUserId` in every
`POST /chatbot-api/sales` (§4.4.6) request issued by `createSale`. (Per
`AGENTS.md` §5.3, the corresponding `User` record must be seeded by the backend
team before live sales; this requirement only fixes the chatbot-side env contract.)

#### Scenario: missing CHATBOT_API_CASHIER_USER_ID blocks boot

- GIVEN no `CHATBOT_API_CASHIER_USER_ID` is present in the environment
- WHEN the application starts
- THEN startup MUST abort with a Joi validation error mentioning the missing
  variable
- AND the service MUST NOT bind to any port.

#### Scenario: malformed CHATBOT_API_CASHIER_USER_ID blocks boot

- GIVEN `CHATBOT_API_CASHIER_USER_ID` is set to a non-UUID string (e.g.
  `"cashier-1"`)
- WHEN the application starts
- THEN startup MUST abort with a Joi validation error.

#### Scenario: createSale forwards the env-resolved cashier id

- GIVEN `CHATBOT_API_CASHIER_USER_ID = "00000000-0000-4000-8000-000000000001"`
- WHEN the model invokes `createSale` with any valid cart
- THEN the outgoing `POST /chatbot-api/sales` body MUST contain
  `cashierUserId === "00000000-0000-4000-8000-000000000001"`.
