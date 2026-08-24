# sale-flow-tools Spec

## Purpose

Provide the chatbot-side sale-flow tool surface: nine AI-SDK tools
(`searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`,
`upsertCustomer`, `createSale`, `attachReceipt`, `updateDelivery`,
`getOrderHistory`) registered through a `RealToolRegistry` and bound as the
production `TOOL_REGISTRY` in `LlmAgentModule`. The capability also defines the
per-sender cart held in `ConversationState.data.cart`, the stable error
envelope returned to the model instead of raw HTTP, the swappable
`BankDetailsProvider` seam (v1 null-default), the boot-composed
`SALE_FLOW_INSTRUCTIONS` system-prompt extension, and the
`CHATBOT_API_CASHIER_USER_ID` boot contract. All backend writes go through the
existing chatbot-api endpoints documented in `AGENTS.md` §4.4.1–§4.4.9; the
chatbot remains a consumer only.

## Requirements

### Requirement: RealToolRegistry registers the nine sale-flow tools

A `RealToolRegistry` MUST register exactly the nine sale-flow AI-SDK tools listed
below, replacing `InMemoryToolRegistry` in the production wiring of
`LlmAgentModule`. Each tool's parameter name MUST match the corresponding chatbot-api
endpoint field name documented in `AGENTS.md` §4.4.x verbatim (e.g. `mediaUrl`,
`declaredAmountCents`, `phoneCountryCode`).

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

`LlmAgentModule` MUST resolve the `TOOL_REGISTRY` provider to `RealToolRegistry`,
which MUST inject `CHATBOT_API_CLIENT` and `CONVERSATION_STORE`. `RealToolRegistry`
MUST NOT be an in-memory placeholder.

#### Scenario: Registry exposes all nine tools

- GIVEN a Nest testing module with `RealToolRegistry` and a stubbed `ChatbotApiClient`
- WHEN `registry.getTools()` is called
- THEN the returned AI-SDK ToolSet MUST contain every key `searchCatalog`,
  `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`,
  `attachReceipt`, `updateDelivery`, `getOrderHistory`
- AND each entry MUST be an AI-SDK `tool({ description, inputSchema, execute })`
  whose `inputSchema` is a Zod object.

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
  provider (it MAY remain in the repository as a test fixture).

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
or trigger a retry. `kind` MUST be one of
`'auth' | 'forbidden' | 'notFound' | 'rateLimit' | 'upstream' | 'validation'`,
and `retryable` MUST be `true` for transient `upstream` and `rateLimit` cases and
`false` otherwise.

#### Scenario: upstream 5xx becomes retryable upstream envelope

- GIVEN the `evaluateCart` tool is invoked with a valid input
- AND the stubbed `ChatbotApiHttpClient.evaluateCart` throws `UpstreamError`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'upstream', retryable: true } }`
- AND the thrown error MUST NOT propagate.

#### Scenario: 404 surfaces as a non-retryable notFound envelope

- GIVEN the `checkStock` tool
- AND the stubbed `ChatbotApiHttpClient.getStock` throws `NotFoundError`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'notFound', retryable: false } }`.

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
  idempotencyKey: string;        // UUID v4 generated client-side on first createSale attempt
}
```

Helpers `readCart(state)` and `writeCart(state, patch)` MUST exist and MUST mirror
the `readMessages`/`writeMessages` pattern: a missing `cart` MUST default to
`{ items: [], idempotencyKey: '' }`; subsequent writes MUST shallow-merge the patch
over the existing cart and persist via `ConversationStore.update(senderId, ...)`
(reusing the durable Postgres UPSERT path).

#### Scenario: cart round-trips through the durable ConversationStore

- GIVEN a sender with `ConversationState.data.cart = { items: [], idempotencyKey: '' }`
- WHEN `writeCart` is called with a patch that adds one item and a fresh
  idempotency key
- THEN a subsequent `readCart` MUST deep-equal the patched cart
- AND the underlying `ConversationStore.update` MUST replace the `data` field as a
  whole (no JSONB deep merge at the storage layer) per the `conversation-store`
  spec.

#### Scenario: missing cart defaults to empty

- GIVEN a stored `ConversationState` whose `data` has no `cart` key
- WHEN `readCart` is called
- THEN the result MUST be `{ items: [], idempotencyKey: '' }`.

### Requirement: createSale uses list price and a client-generated UUID v4 idempotency key

The `createSale` tool MUST send `unitPriceCents = originalPriceCents` (NOT
`finalPriceCents`) for every cart item, per the blocked-seam decision in Q2 of
`docs/backend-questions-sale-flow.md`. The tool MUST use the cart's persisted
`idempotencyKey` when one is already present; otherwise it MUST generate a
client-side UUID v4 (via `crypto.randomUUID()`), persist it on the cart, and
reuse it on every retry within the same sender's session. After the backend
returns a `BotSaleResponse`, the tool MUST clear the cart (including the
idempotency key) before returning.

#### Scenario: first attempt persists the idempotency key

- GIVEN an empty cart for sender S
- AND the backend `POST /chatbot-api/sales` (§4.4.6) returns `{ saleId: "sale-1" }`
- WHEN `createSale` is invoked with a valid cart
- THEN the second outgoing HTTP request MUST include an `X-Idempotency-Key`
  header whose value is a UUID v4
- AND the persisted cart MUST contain that same key
- AND the next call's outgoing request MUST include the same key.

#### Scenario: list price is sent, not final price

- GIVEN `evaluateCart` (§4.4.3) returned an item with `originalPriceCents: 1000`
  and `finalPriceCents: 800`
- WHEN `createSale` is invoked with that evaluation in scope
- THEN the outgoing `POST /chatbot-api/sales` body MUST contain
  `items[0].unitPriceCents === 1000`
- AND MUST NOT contain `800` anywhere on the request.

#### Scenario: cart is cleared on success

- GIVEN the previous scenario succeeded
- WHEN `createSale` returns `{ ok: true, saleId: "sale-1" }`
- THEN a subsequent `readCart(S)` MUST equal
  `{ items: [], idempotencyKey: '' }`.

### Requirement: BankDetailsProvider is a swappable seam

A `BankDetailsProvider` port MUST exist with the signature
`{ get(): Promise<BankDetails | null> }`, where `BankDetails` carries the
fields documented in Q1 of `docs/backend-questions-sale-flow.md`
(`bankName`, `beneficiary`, `clabe`, `accountNumber`).

The runtime default implementation MUST return `null`. When the provider returns
`null`, the system MUST instruct the model to pause the receipt-request step and
reply with the human-handoff phrase equivalent to *"en un momento un agente te
comparte los datos de pago"*. The provider MUST be swappable (env-driven or
chatbot-api-driven impl in a follow-up slice) WITHOUT any change to the LLM
agent, the prompt, or any tool.

#### Scenario: null provider triggers the human-handoff phrase

- GIVEN the `BankDetailsProvider` is the v1 null-default implementation
- AND the sale is confirmed via `createSale`
- WHEN the system composes the next assistant reply
- THEN the composed prompt MUST instruct the model to send the human-handoff
  phrase and to NOT invent bank details.

#### Scenario: provider swap does not require tool or model changes

- GIVEN a future slice replaces the null-default with an env-backed impl
- WHEN the application boots
- THEN the `RealToolRegistry`, all nine tools, the agent runner, and the
  composed prompt MUST remain unchanged
- AND a single provider swap (DI binding) MUST be sufficient to activate the
  new source.

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
9. Collect or confirm customer data (phone + name; reuse `getCustomerByPhone`
   then `upsertCustomer` with the address field per AGENTS.md §4.4.5).
10. Send an order summary (structured, bulleted — same format as the real
    human agent in conversation #1).
11. Call `createSale` at list price.
12. Send the R11 bank-details message and ask for the transfer receipt.
13. On receipt image, call `attachReceipt`.
14. End the conversation.

The composed system prompt MUST equal
`SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`, concatenated ONCE at module
boot (one-shot, never per-turn). The base `SYSTEM_PROMPT` MUST be appended
unmodified.

The slice MUST include in `SALE_FLOW_INSTRUCTIONS`, at minimum:

- A list-price-only rule: "If `evaluateCart` returns `finalPriceCents` lower
  than `originalPriceCents` AND `promotionEvaluationStatus ===
  'needs_human_review'`, do NOT register the sale at the discounted price —
  register at list price OR pause for human review."
- A no-fabrication rule: never invent a price, a stock quantity, or a bank
  detail; always call the relevant tool.
- The refusal phrase `esa función aún no está disponible` preserved verbatim.
- A human-handoff phrase for the bank-details-null case.

#### Scenario: composed prompt contains the four contractual strings

- GIVEN the application has booted with `SaleFlowModule` imported
- WHEN the agent runner reads the system prompt from its config source
- THEN the composed prompt MUST contain (i) the literal phrase
  `esa función aún no está disponible`; (ii) the forbidden slang block
  covering voseo and the regional slang examples listed in the base
  `SYSTEM_PROMPT`; (iii) the sale-flow step list above (1–14); (iv) the
  list-price-only instruction.

#### Scenario: composition happens at boot, not per turn

- GIVEN `ConversationStore` has 50 turns of prior history for sender S
- WHEN the agent runner handles three consecutive inbounds
- THEN `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` MUST be computed
  exactly once at module boot
- AND subsequent turns MUST reuse the same composed string (byte-identical).

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
team before live sales; this requirement only fixes the chatbot-side env
contract.)

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
