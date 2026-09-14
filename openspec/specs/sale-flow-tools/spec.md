# sale-flow-tools Spec

## Purpose

Provide the chatbot-side sale-flow tool surface: eleven AI-SDK tools (`searchCatalog`,
`checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`,
`attachReceipt`, `updateDelivery`, `getOrderHistory`, `getPaymentDetails`, `cancelSale`)
registered through a `RealToolRegistry` and bound as the production `TOOL_REGISTRY` in
`LlmAgentModule`. The capability also defines the per-sender cart held in
`ConversationState.data.cart` (with the optional `expectedTotalCents?: number` field),
the per-sender placed-sale id held in `ConversationState.data.placedSaleId` (sibling of
`cart`, populated atomically with the cart clear on `createSale` success and cleared on
`cancelSale` success / permanent error), the stable error envelope returned to the model
instead of raw HTTP (now fourteen discriminated `kind` values, including the four new
backend-envelope-driven branches `noActivePaymentDetail`, `promoReQuote`,
`idempotencyInFlight`, `idempotencyConflict`, `priceOutOfDate` plus the three new
cancel-driven branches `saleNotFound`, `saleNotCancellable`, `missingPlacedSaleId`),
the boot-composed `SALE_FLOW_INSTRUCTIONS` system-prompt extension (step 12 now calls
the runtime `getPaymentDetails` tool instead of the deleted `BankDetailsProvider`
boot-time seam; step 14 is the just-confirmed-sale cancel rule; the closing step is
renumbered 14 → 15), and the `CHATBOT_API_CASHIER_USER_ID` boot contract. All backend
writes go through the existing chatbot-api endpoints documented in
`AGENTS.md` §4.4.1–§4.4.10; the chatbot remains a consumer only.

## Requirements

### Requirement: RealToolRegistry registers the twelve sale-flow tools

A `RealToolRegistry` MUST register exactly the twelve sale-flow AI-SDK tools listed below,
replacing `InMemoryToolRegistry` in the production wiring of `LlmAgentModule`. Each
tool's parameter name MUST match the corresponding chatbot-api endpoint field name
documented in `AGENTS.md` §4.4.x verbatim. The registry docstring MUST read "twelve
sale-flow tools" (bumped from eleven).

| Tool | Backend endpoint (`AGENTS.md` § / backend `PROGRAM-CONTEXT.md`) | Scope |
| --- | --- | --- |
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
| `cancelSale` | §4.4.10 `POST /chatbot-api/sales/:saleId/cancel` (no client `X-Idempotency-Key`) | `sales:write` |
| `requestHumanAssistance` | (no backend endpoint; writes `human_handoff_requests` row + sends ops digest + sets `data.pendingHumanRequest`) | (none — local Postgres + WhatsApp sender only) |

`LlmAgentModule` MUST resolve the `TOOL_REGISTRY` provider to `RealToolRegistry`,
which MUST inject `CHATBOT_API_CLIENT`, `CONVERSATION_STORE`, AND `HUMAN_HANDOFF_SERVICE`.
`RealToolRegistry` MUST NOT be an in-memory placeholder.

(Previously: exactly eleven tools registered, ending at `cancelSale`; docstring "eleven
sale-flow tools"; no `requestHumanAssistance`.)

#### Scenario: Registry exposes all twelve tools

- GIVEN a Nest testing module with `RealToolRegistry` and stubbed `ChatbotApiClient`,
  `ConversationStore`, and `HumanHandoffService`
- WHEN `registry.getTools()` is called
- THEN the returned AI-SDK ToolSet MUST contain every key `searchCatalog`, `checkStock`,
  `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`, `attachReceipt`,
  `updateDelivery`, `getOrderHistory`, `getPaymentDetails`, `cancelSale`,
  `requestHumanAssistance`
- AND the ToolSet MUST NOT contain any other key beyond these twelve.

#### Scenario: LlmAgentModule wires RealToolRegistry with ChatbotApiClient + ConversationStore + HumanHandoffService

- GIVEN a production `LlmAgentModule` build with all `AppModule` imports in place
- WHEN the DI container resolves the `TOOL_REGISTRY` provider
- THEN the resolved instance MUST be `RealToolRegistry`
- AND its constructor MUST have received `CHATBOT_API_CLIENT` (bound to
  `ChatbotApiHttpClient`), `CONVERSATION_STORE` (bound to the durable Postgres adapter
  per the `conversation-store` spec), AND `HUMAN_HANDOFF_SERVICE` (bound to
  `HumanHandoffService` per the human-handoff spec).

#### Scenario: Placeholder registry is no longer the production binding

- GIVEN the production wiring of `LlmAgentModule`
- WHEN the module is inspected
- THEN `InMemoryToolRegistry` MUST NOT be registered as the `TOOL_REGISTRY` provider
  (it MAY remain in the repository as a test fixture).

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
- `cancelSale.inputSchema` MUST be `z.object({}).strict()` (no model-supplied `saleId`,
  `reason`, or `cashierUserId`).
- `requestHumanAssistance.inputSchema` MUST be the discriminated union by `kind`
  described in the human-handoff spec (3 active kinds today; `shipping_approval` is
  reserved for the future R6 slice and is NOT in the union yet).

#### Requirement: `attachReceipt` is a terminal compatibility tool with no backend attachment path

The `attachReceipt` tool MUST NOT call `POST /chatbot-api/sales/:saleId/receipts` (§4.4.7). It exists solely to suppress model-direct `attachReceipt` calls that would bypass the server-owned `ReceiptAttachmentService` — the sole §4.4.7 path, which sources `capturedSaleId`/`capturedObjectKey`/`capturedAmount` from the durable `Started` successor created by `SaleConfirmedEvent`. Without this compatibility tool, the LLM would attempt to call `attachReceipt` directly with model-supplied `saleId`/`mediaUrl`/`declaredAmountCents`, creating a conflict with the server-owned durable workflow that already owns those fields.

The `ReceiptAttachmentService` is the sole owner of §4.4.7. It is not triggered by a tool call from the LLM; it is triggered by a WhatsApp webhook event that signals a new media message, correlated to an active sale session via `startedSaleId`. It captures the sale ID, object key, and amount from the `Started` successor record — not from LLM-supplied parameters. If the LLM were to call `attachReceipt` with a fabricated `saleId` and `mediaUrl`, two competing attachment records would be created for the same sale, breaking the idempotent receipt workflow. The compatibility tool prevents this by returning terminal guidance only for a valid strict-empty `{}` compatibility invocation; any input containing protected or legacy fields is rejected by schema validation before `execute` is called, and such invalid calls do not receive an execution result and make no backend call. The guidance is also deliberately un-actionable: it tells the LLM what not to do and where the real path is, without providing a tool-callable substitute.

The tool guarantees idempotency: since it never calls the backend, it can never produce a conflicting outcome. A valid strict-empty `{}` invocation returns terminal guidance that redirects the model to the server-owned workflow. Protected or legacy payloads fail schema validation before execution and receive no execution result. After receiving a terminal result, the LLM MUST NOT keep asking the customer for sale identifiers or media URLs — the guidance explicitly forbids collecting or deriving any of the nine protected fields.

The bot's posture after receiving the terminal result is reactive: if the server-owned workflow has correlated the image to an active confirmed sale, the bot acknowledges the receipt and confirms pending human review; otherwise the bot states it could not associate the receipt and offers human assistance, without claiming attachment or pending review. The bot does not poll for confirmation, does not re-call `attachReceipt`, and does not attempt any alternative path. The guidance uses the word "terminal" to signal that no further tool-call loop should be entered for this topic.

The following fields MUST NOT be collected, derived, or sent by the LLM for receipt attachment: `saleId`, `mediaUrl`, `objectKey`, `token`, `capability`, `pendingMedia`, `amount`, `date`, `reference`. Any payload containing such fields MUST be rejected by schema validation before execution and MUST NOT reach `execute` or the backend.

**Scope.** The compatibility tool is a signal-only terminal guard: it does not call the backend, does not read conversation state, and does not attempt receipt attachment through any path. The `ReceiptAttachmentService` handles the actual receipt workflow and is not modified by this change. The tool exists at the AI-SDK tool registration layer only.

**Non-Goals.** This tool does not upload receipts, does not handle WhatsApp media webhook events, does not confirm receipts, does not send proactive messages, does not modify the `ReceiptAttachmentService`, and does not provide any path for the LLM to attach a receipt directly. The guidance is intentionally un-actionable: it names what the LLM must not do and where the real path is, without offering a tool-callable substitute.

**Idempotency.** Because the tool never calls the backend, repeated valid strict-empty `{}` invocations produce no side effects and return the same terminal result. Invalid invocations are rejected before execution and produce no tool result or backend call.

**Bot posture.** After delivering terminal guidance, only explicit server-owned evidence that the image was correlated to an active confirmed sale permits the bot to confirm pending human review. Without that evidence, the bot states it could not associate the receipt and offers human assistance, without claiming attachment or pending review. The bot does not poll for confirmation, does not re-call `attachReceipt`, and does not attempt alternative paths.

- The input schema MUST be `z.object({}).strict()`: unknown fields (e.g. `saleId`, `mediaUrl`, `declaredAmountCents`) MUST be rejected, not stripped.
- If called with a `saleId` UUID, `mediaUrl`, or `declaredAmountCents`, the schema parse MUST fail with a Zod error.
- For a valid strict-empty `{}` invocation, the `execute` MUST return the canonical terminal guidance `{ ok: true, terminal: true, guidance: "Receipt images are handled by the server-owned durable receipt workflow. Do not retry this tool, and do not request or derive a sale ID, media URL, object key, token, capability, pending media, amount, date, or reference." }`.
- No code path makes a call to `chatbotApi.attachReceipt` or any `POST /chatbot-api/sales/:saleId/receipts` equivalent.
- The `makeAttachReceiptTool` factory takes zero deps (no `ChatbotApiClient`, no `ConversationStore`).

#### Scenario: valid strict-empty invocation returns the exact terminal guidance result

- GIVEN the `attachReceipt` tool is registered in the `RealToolRegistry` (the AI-SDK ToolSet registry that resolves all 12 tools including this one)
- WHEN the model invokes it with an empty object `{}`
- THEN the schema `parse({})` MUST succeed and return `{}`
- AND `execute({})` MUST return the canonical terminal guidance `{ ok: true, terminal: true, guidance: "Receipt images are handled by the server-owned durable receipt workflow. Do not retry this tool, and do not request or derive a sale ID, media URL, object key, token, capability, pending media, amount, date, or reference." }`
- AND the result MUST equal the exported `TERMINAL_RECEIPT_GUIDANCE` constant from `src/sale-flow/application/tools/attach-receipt.tool.ts`
- AND no backend call of any kind is made.

#### Scenario: protected fields and sale-B payloads are rejected at input validation

- GIVEN the `attachReceipt` tool is registered in the `RealToolRegistry`
- WHEN the model invokes it with a payload containing any of `saleId`, `mediaUrl`, `declaredAmountCents`, `declaredDate`, or `declaredReference`
- THEN the schema `safeParse(payload)` MUST return `{ success: false }` (rejected, not stripped)
- AND the schema `parse(payload)` MUST throw a Zod error listing the unexpected keys
- AND `execute` MUST NOT be called
- AND the underlying `chatbotApi.attachReceipt` MUST NOT be called.

#### Scenario: every path makes zero chatbotApi.attachReceipt calls

- GIVEN the `attachReceipt` tool registered in the `RealToolRegistry` with a DI-resolved (stubbed) `ChatbotApiClient`
- WHEN `{}` passes validation and executes, or a protected-field payload is rejected before execution
- THEN `chatbotApi.attachReceipt` MUST NOT be called on any code path
- AND `conversationStore.get` MUST NOT be called on any code path.

#### Scenario: use the server-owned receipt workflow, not direct attachReceipt

- GIVEN a customer sends a transfer receipt image during an active sale session
- WHEN the server-owned workflow either provides explicit correlation evidence or leaves correlation unavailable
- THEN the LLM MUST NOT invoke `attachReceipt` with protected fields, and a valid `{}` compatibility invocation receives only terminal guidance
- AND only explicit server-owned correlation evidence permits acknowledging pending human review
- AND without that evidence, the bot MUST state that the receipt could not be associated and offer human assistance without requesting protected identifiers.
- The `ReceiptAttachmentService` (`src/receipt-media/application/receipt-attachment.service.ts`) remains the sole §4.4.7 path: it is not modified by this change and continues operating independently of any AI direct-attachment calls.

#### Scenario: requestHumanAssistance input schema rejects shipping_approval today

- GIVEN the `requestHumanAssistance` tool
- WHEN the model invokes it with `{ kind: 'shipping_approval', digest: { ... } }`
- THEN the schema parse MUST fail (no discriminator match — `shipping_approval` is not
  in the union today)
- AND `execute` MUST NOT be called.

### Requirement: Tools return a stable error envelope instead of raw HTTP

When `ChatbotApiHttpClient` throws (any of `AuthError`, `ForbiddenError`, `NotFoundError`,
`RateLimitError`, `UpstreamError`, or a `ChatbotApiError` with a non-null `statusCode`),
the tool's `execute` MUST catch the error and return
`{ ok: false, error: { kind, retryable } }` — never the raw exception, never a raw
HTTP status, never a stack trace — so the model can phrase a user-friendly reply or
trigger a retry.

`kind` MUST be one of
`'auth' | 'forbidden' | 'notFound' | 'rateLimit' | 'upstream' | 'validation' | 'noActivePaymentDetail' | 'promoReQuote' | 'idempotencyInFlight' | 'idempotencyConflict' | 'priceOutOfDate' | 'saleNotFound' | 'saleNotCancellable' | 'missingPlacedSaleId' | 'disabled'`,
and `retryable` MUST be `true` for transient `upstream`, `rateLimit`, and
`idempotencyInFlight` cases and `false` otherwise.

The mapping layer (`src/sale-flow/application/error-mapping.ts`) MUST discriminate
on the `ChatbotApiError.errorCode` FIRST, and MUST fall back to the HTTP-status-keyed
mapping only when `errorCode` is `null`:

| Backend `errorCode` (or HTTP status when `errorCode` is absent) | `kind` | `retryable` |
| --- | --- | --- |
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

`missingPlacedSaleId` MUST be produced ONLY by the tool's client-side guard (no HTTP
call); it MUST never be emitted by `mapChatbotError` from a backend code. There is NO
distinct "already canceled" code — a `CANCELED` sale returns a replay success (`200`,
`status: 'CANCELED'`), not an error. Unknown cancel codes MUST fall through to the
existing subclass/status mapping (404 → `notFound`, 403 → `forbidden`, 4xx →
`validation`, 5xx → `upstream`) so a code mismatch degrades safely. The bot MUST
NEVER parse the `message` string for branching.

The `requestHumanAssistance` tool is NOT a chatbot-api caller; it does NOT produce any
of the HTTP-driven kinds above. Its only failure kinds are:

- `disabled` (`retryable: false`) when `HUMAN_HANDOFF_ENABLED === false`.
- `validation` (`retryable: false`) when the discriminated-union Zod parse fails or
  when the `shipping_approval` kind is presented.

(Previously: thirteen kinds (`auth` … `missingPlacedSaleId`) with no handoff vocabulary;
`requestHumanAssistance` did not exist; trigger tools had no `humanAssistance` envelope.)

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
- AND the HTTP-status-first branch (`validation`) MUST NOT have been taken.

#### Scenario: SALE_DELIVERED_CANNOT_CANCEL maps to saleNotCancellable

- GIVEN the `cancelSale` tool is invoked with a valid `placedSaleId`
- AND the stubbed `ChatbotApiHttpClient.cancelSale` throws a `ChatbotApiError` with
  `statusCode: 409` and `errorCode: 'SALE_DELIVERED_CANNOT_CANCEL'`
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'saleNotCancellable', retryable: false } }`
- AND the HTTP-status-first branch (`validation`) MUST NOT have been taken.

#### Scenario: unknown cancel errorCode falls back to the status mapping

- GIVEN the `cancelSale` tool is invoked
- AND the stubbed client throws a `ChatbotApiError` with `statusCode: 422` and an
  unrecognized `errorCode` (e.g. `'SOME_FUTURE_CODE'`)
- WHEN the tool's `execute` runs
- THEN the returned object MUST deep-equal
  `{ ok: false, error: { kind: 'validation', retryable: false } }` (safe degradation,
  no crash).

#### Scenario: requestHumanAssistance disabled kill-switch returns the disabled kind

- GIVEN `HUMAN_HANDOFF_ENABLED = false`
- WHEN the model invokes `requestHumanAssistance` with
  `{ kind: 'out_of_stock', digest: { productId: 'p-1', name: 'X' } }`
- THEN the tool MUST return
  `{ ok: false, error: { kind: 'disabled', retryable: false } }`
- AND `HumanHandoffService.create(...)` MUST NOT be called
- AND no `human_handoff_requests` row MUST be inserted.

#### Scenario: requestHumanAssistance validation failure returns the validation kind

- GIVEN the tool is invoked with
  `{ kind: 'out_of_stock', digest: { productId: 'not-a-uuid', name: 'X' } }`
- WHEN the tool's `execute` runs
- THEN the tool MUST return
  `{ ok: false, error: { kind: 'validation', retryable: false } }`
- AND `HumanHandoffService.create(...)` MUST NOT be called.

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
| --- | --- | --- | --- | --- | --- |
| `PROMO_RE_QUOTE` (409) | `promoReQuote` | `false` | preserved | cleared | yes (in error envelope) |
| `IDEMPOTENCY_KEY_IN_FLIGHT` (409) | `idempotencyInFlight` | `true` | preserved | preserved | n/a |
| `IDEMPOTENCY_KEY_CONFLICT` (409) | `idempotencyConflict` | `false` | preserved | cleared | n/a |
| `PRICE_OUT_OF_DATE` (409) | `priceOutOfDate` | `false` | preserved | preserved | n/a |
| `INVALID_IDEMPOTENCY_KEY` (400) | `validation` | `false` | preserved | preserved | n/a |

On `PROMO_RE_QUOTE`, the tool MUST include `recomputedTotalCents`, `expectedTotalCents`,
and `discountCents` (numeric cents values from the backend envelope) in the error
envelope so the model can show the new totals and re-confirm with the customer. On
success (`ok: true`), the tool MUST extract `discountCents` from `BotSaleResponse` and
surface it in the success envelope, and MUST persist `data.placedSaleId = sale.saleId`
AND clear the cart (items + idempotencyKey + expectedTotalCents) in ONE atomic
`ConversationStore.update` before the tool returns.

(Previously: on success the tool called `persistCart(…, EMPTY_CART)` and returned
`{ ok: true, ...sale }`, dropping the returned `saleId` — nothing persisted the placed
sale durably.)

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

#### Scenario: PROMO_RE_QUOTE clears the idempotency key and preserves the cart items

- GIVEN a cart with one item, a persisted `idempotencyKey`, and
  `expectedTotalCents: 1000`
- AND the backend returns `409` with `errorCode: 'PROMO_RE_QUOTE'`,
  `recomputedTotalCents: 900`, `expectedTotalCents: 1000`, `discountCents: 100`
- WHEN `createSale` runs
- THEN the result MUST deep-equal
  `{ ok: false, error: { kind: 'promoReQuote', retryable: false, recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 } }`
- AND `readCart(S).items` MUST remain unchanged
- AND `readCart(S).idempotencyKey` MUST equal `''` (cleared so the re-confirmation
  mints a fresh key).

#### Scenario: IDEMPOTENCY_KEY_IN_FLIGHT returns a retryable kind and preserves the key

- GIVEN a cart with one item and a persisted `idempotencyKey`
- AND the backend returns `409` with `errorCode: 'IDEMPOTENCY_KEY_IN_FLIGHT'`
- WHEN `createSale` runs
- THEN the result MUST deep-equal
  `{ ok: false, error: { kind: 'idempotencyInFlight', retryable: true } }`
- AND `readCart(S).idempotencyKey` MUST equal the previously persisted value.

#### Scenario: success persists placedSaleId atomically with the cart clear

- GIVEN a cart with one item, a persisted `idempotencyKey`, and
  `expectedTotalCents: 1500`
- AND the backend returns `{ ok: true, sale: { saleId: "sale-1", discountCents: 250 } }`
- WHEN `createSale` runs
- THEN the tool's success envelope MUST include `discountCents: 250`
- AND the persisted `data` MUST contain
  `cart: { items: [], idempotencyKey: '', expectedTotalCents: undefined }` AND
  `placedSaleId: 'sale-1'`
- AND exactly ONE `ConversationStore.update` write MUST have occurred for the success
  path (single atomic write).

### Requirement: SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot

`SALE_FLOW_INSTRUCTIONS` MUST be a string literal (in
`src/sale-flow/domain/sale-flow-instructions.ts`) that encodes the escrow-style
sale flow:

1. Greet.
2. Ask what product the customer wants.
3. Call `searchCatalog` and present results.
4. Confirm the chosen product.
5. Call `checkStock` for the chosen product. **NEW:** if the returned payload carries a
   `humanAssistance` envelope with `kind: 'out_of_stock'` (R7), the model MUST call
   `requestHumanAssistance({ kind: 'out_of_stock', digest: { productId, name,
   variantId?, quantity? } })` and reply that the case has been escalated to a human
   agent (the literal `UNDER_REVIEW_NOTICE` reply text is owned by the handoff service,
   not by the model — the model just confirms the customer was notified).
6. Add the item to the cart (locally persisted via `writeCart`).
7. Ask whether to add another item or proceed to review.
8. Call `evaluateCart` and surface the price quote to the customer. **NEW:** if the
   returned payload carries a `humanAssistance` envelope with
   `kind: 'needs_human_review'`, the model MUST render the existing price quote first
   and only escalate when the customer wants to proceed, by calling
   `requestHumanAssistance({ kind: 'needs_human_review', digest: { items,
   originalTotalCents?, recomputedTotalCents? } })`. The "render quote first, escalate
   on customer acceptance" rule preserves the existing "derivar a revisión humana"
   semantics.
9. Collect or confirm customer data (phone + name; reuse `getCustomerByPhone` then
   `upsertCustomer` with the address field per AGENTS.md §4.4.5).
10. Send an order summary (structured, bulleted — same format as the real human
    agent in conversation #1).
11. Call `createSale`, forwarding `expectedTotalCents` from the cart; on
    `PROMO_RE_QUOTE`, show the new totals to the customer, ask for explicit
    confirmation, and on acceptance re-emit `createSale` with a fresh UUID v4
    idempotency key (NEVER reuse the previous key after `PROMO_RE_QUOTE`).
12. After `createSale` returns `ok: true`, call `getPaymentDetails` (inputSchema:
    empty object). If the result is `{ ok: false, error: { kind: 'noActivePaymentDetail' } }`,
    reply EXACTLY with `en un momento un agente te comparte los datos de pago` and
    pause. Otherwise render the bank-details block (bankName, beneficiary, clabe,
    accountNumber) and ask for the transfer receipt. Never call `getPaymentDetails`
    before `createSale` confirms a sale.
13. When the customer sends a receipt image, receipt images are handled by the server-owned durable receipt workflow: do NOT call `attachReceipt` and do NOT collect or derive a sale ID, media URL, object key, token, capability, pending media, amount, date, or reference. Only explicit server-owned evidence that the image was correlated to an active confirmed sale permits acknowledging that it is pending human review. Without that evidence, state that the receipt could not be associated and offer human assistance — do not claim attachment or pending review. If `attachReceipt` ever returns a result from a valid empty invocation, treat it as terminal guidance — never retry it and never ask the customer for any protected identifier.
14. On a customer cancel request, cancel ONLY the sale just confirmed in this
    session. Never cancel historical or multi-order sales; never derive a `saleId`
    from `getOrderHistory`. Re-show the sale summary (folio + total + status from
    the `createSale` success result in the current transcript), then ask EXACTLY
    `¿Confirmas la cancelación? Sí/No` and call `cancelSale` ONLY after an explicit
    "sí". On `kind: 'saleNotCancellable'`, reply that cancellation is no longer
    possible by this channel and hand off to a human. On `kind: 'missingPlacedSaleId'`,
    reply `no hay una venta reciente por cancelar` — never fabricate a sale.
15. End the conversation.

**NEW STEP 16 (R14 prompt-only escalation).** When the customer asks about expiration
dates (caducidad, fechas de vencimiento, "¿vence este producto?", etc.), the model MUST
NOT reply `esa función aún no está disponible`. The model MUST instead call
`requestHumanAssistance({ kind: 'expiration_date', digest: { productId, name,
question } })` and reply that the case is under human review (the literal
`UNDER_REVIEW_NOTICE` is owned by the handoff service). The refusal phrase
`esa función aún no está disponible` is preserved verbatim for features we never
plan to tool (e.g. shipping zones), but expiration dates are now a handoff case, not a
refusal.

The composed system prompt MUST equal
`SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`, concatenated ONCE at module boot
(one-shot, never per-turn). The base `SYSTEM_PROMPT` MUST be appended unmodified.
`composeSaleFlowSystemPrompt` MUST collapse to
`(base: string) => base + '\n\n' + SALE_FLOW_INSTRUCTIONS`.

The slice MUST include in `SALE_FLOW_INSTRUCTIONS`, at minimum:

- A `getPaymentDetails`-after-`createSale` gating rule (`getPaymentDetails` MUST NOT
  be called before `createSale` confirms a sale).
- The human-handoff phrase `en un momento un agente te comparte los datos de pago`
  byte-identical when the tool returns the `noActivePaymentDetail` kind.
- A cancel rule: just-confirmed-sale-only scope, the folio + total + status summary,
  the explicit-confirmation gate `¿Confirmas la cancelación? Sí/No`, and the
  `saleNotCancellable` → human-handoff branch.
- A no-fabrication rule: never invent a price, a stock quantity, a bank detail, or a
  sale to cancel; always call the relevant tool.
- The refusal phrase `esa función aún no está disponible` preserved verbatim (still
  applies to features we never plan to tool, e.g. shipping zones).
- A `PROMO_RE_QUOTE` rule that the bot re-confirms with the customer exactly once and
  re-emits `createSale` with a fresh UUID v4 on acceptance.
- **NEW:** A `checkStock` `humanAssistance` rule (R7): on the envelope, call
  `requestHumanAssistance({ kind: 'out_of_stock', digest: { productId, name,
  variantId?, quantity? } })` and stop the sale flow until the human replies.
- **NEW:** An `evaluateCart` `humanAssistance` rule (`needs_human_review`): render the
  quote first, escalate ONLY on the customer's explicit decision to proceed.
- **NEW:** An R14 expiration-date rule: call
  `requestHumanAssistance({ kind: 'expiration_date', digest: { productId, name,
  question } })`; NEVER reply `esa función aún no está disponible` for expiration
  dates (the refusal phrase is preserved for shipping zones, not for R14).
- **NEW:** An awaiting-human posture rule: after `requestHumanAssistance` returns
  `ok: true`, the model MUST NOT keep trying to advance the sale flow; the customer
  has been notified and the bot waits indefinitely. Subsequent customer inbounds get
  the runner's canned "seguimos esperando" reply (a runner-level string, not a
  model-generated reply).

(Previously: a 15-step flow with no human-handoff step; R7 and R14 produced literal
prompt phrases with no backing mechanism; the cancel step 14 was the only "human
handoff" branch and was prompt-phrased.)

#### Scenario: composed prompt contains the contractual strings

- GIVEN the application has booted with `SaleFlowModule` imported
- WHEN the agent runner reads the system prompt from its config source
- THEN the composed prompt MUST contain (i) the literal phrase
  `esa función aún no está disponible`; (ii) the sale-flow step list above (1–16);
  (iii) the `getPaymentDetails`-after-`createSale` gating instruction; (iv) the
  cancel rule with the exact phrase `¿Confirmas la cancelación? Sí/No`; (v) the
  `PROMO_RE_QUOTE` re-confirmation rule; (vi) the R7 escalation rule mentioning
  `humanAssistance` and `kind: 'out_of_stock'`; (vii) the R14 expiration-date rule
  mentioning `kind: 'expiration_date'`; (viii) the awaiting-human posture rule.

#### Scenario: composition happens at boot, not per turn

- GIVEN `ConversationStore` has 50 turns of prior history for sender S
- WHEN the agent runner handles three consecutive inbounds
- THEN `SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS` MUST be computed exactly
  once at module boot
- AND subsequent turns MUST reuse the same composed string (byte-identical).

#### Scenario: byte-identical strings are preserved verbatim

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS` is exported from
  `src/sale-flow/domain/sale-flow-instructions.ts` (verified at
  `src/sale-flow/domain/sale-flow-instructions.ts` step 14 and step 12)
- WHEN the test parses the string for the contractual substrings
- THEN the string MUST contain ALL of the following byte-identical substrings (no
  edits to grammar, punctuation, accents, or whitespace):
  - `esa función aún no está disponible` (refusal phrase, step 1 + recordatorio final)
  - `en un momento un agente te comparte los datos de pago` (step 12)
    (`PROMO_RE_QUOTE` and `needs_human_review` (no hyphen prefix)
  - `¿Confirmas la cancelación? Sí/No` (step 14)
  - `no hay una venta reciente por cancelar` (step 14, `missingPlacedSaleId` branch)
  - `deriva a revisión humana` (step 11, preserved verbatim as the existing literal
    even though the new `humanAssistance` envelope + `requestHumanAssistance` tool
    now back it with a real mechanism)
- AND none of these substrings MAY be edited (byte-identical snapshot test).

#### Scenario: step 12 human-handoff phrase is byte-identical

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS`
- WHEN the test parses the string for the step-12 instruction
- THEN the substring MUST contain the exact phrase
  `en un momento un agente te comparte los datos de pago`
- AND the phrase MUST be wrapped in a `getPaymentDetails` 404 branch so the model
  emits it ONLY on the `noActivePaymentDetail` kind
- AND the phrase MUST NOT be edited for grammar, punctuation, or wording when the
  bot is re-prompted (byte-identical snapshot test).

#### Scenario: cancel step 14 explicit-confirm phrase is byte-identical

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS`
- WHEN the test extracts step 14
- THEN the text MUST contain the exact phrase `¿Confirmas la cancelación? Sí/No`
- AND the text MUST state that `cancelSale` is called ONLY after an explicit "sí"
- AND the text MUST limit cancellation to the sale just confirmed in the current
  session (never `getOrderHistory`-derived ids)
- AND the text MUST contain the `saleNotCancellable` → human-handoff branch.

#### Scenario: step 16 R14 expiration-date rule is present and names the new tool

- GIVEN the literal `SALE_FLOW_INSTRUCTIONS`
- WHEN the test extracts step 16
- THEN the text MUST contain the rule that on expiration-date questions the model
  MUST call `requestHumanAssistance({ kind: 'expiration_date', digest: { productId,
  name, question } })`
- AND the text MUST contain the rule that `esa función aún no está disponible` is
  NOT used for R14 (only for features we never plan to tool, e.g. shipping zones).

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

### Requirement: cancelSale is the eleventh sale-flow tool

`RealToolRegistry` MUST register an AI-SDK tool `cancelSale` as the eleventh sale-flow
key, backed by `POST /chatbot-api/sales/:saleId/cancel` (backend `PROGRAM-CONTEXT.md`
§4.4.10, `sales:write`). Its `inputSchema` MUST be `z.object({}).strict()` — no
model-supplied `saleId`, `reason`, or `cashierUserId` — and its `contextSchema` MUST
carry `senderId`. `execute` MUST, in order:

1. Load state via `deps.store.get(senderId)` and read `placedSaleId` via
   `readPlacedSaleId(state)`.
2. When `placedSaleId` is absent, return
   `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }` WITHOUT
   any HTTP call.
3. Call `deps.chatbotApi.cancelSale(placedSaleId, { reason: 'CUSTOMER_REQUEST',
   cashierUserId: deps.cashierUserId })`. `reason` MUST be fixed to
   `CUSTOMER_REQUEST` and `cashierUserId` MUST be injected from
   `CHATBOT_API_CASHIER_USER_ID` — neither MUST ever be model-chosen.
4. On HTTP 200, clear `placedSaleId` (durable write) and return
   `{ ok: true, ...canceledSale }` where `canceledSale` is the `CancelSaleResult`
   projection `{ saleId, status: 'CANCELED', refundedCents, restockedItems, canceledAt }`.
5. On `ChatbotApiError`, apply the error-code-first state policy before returning
   `mapChatbotError(err)`: permanent kinds (`saleNotFound`, `saleNotCancellable`,
   `idempotencyConflict`) clear `placedSaleId`; transient kinds (`rateLimit`,
   `upstream`, `idempotencyInFlight`) preserve it so the model can retry.

A sale already `CANCELED` server-side (out-of-band) MUST be treated as a **replay
success** (`status: 'CANCELED'`), never as an error: the bot sees a normal success
envelope, the model MAY surface the "ya estaba cancelada" nuance from the returned
status, and `placedSaleId` is cleared.

#### Scenario: happy path returns CancelSaleResult and clears placedSaleId

- GIVEN a sender S whose `ConversationState.data.placedSaleId` is `'sale-1'`
- AND a stubbed `chatbotApi.cancelSale` that resolves to
  `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }], canceledAt: '2026-08-25T12:00:00.000Z' }`
- WHEN the model invokes `cancelSale` with `{}`
- THEN the tool MUST call
  `chatbotApi.cancelSale('sale-1', { reason: 'CUSTOMER_REQUEST', cashierUserId: '<boot-injected-id>' })`
  exactly once
- AND the returned envelope MUST deep-equal
  `{ ok: true, saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [...], canceledAt: '2026-08-25T12:00:00.000Z' }`
- AND a subsequent `readPlacedSaleId(state(S))` MUST equal `null`.

#### Scenario: missing placedSaleId guards before any HTTP call

- GIVEN a sender S whose `ConversationState.data` has no `placedSaleId` key
- WHEN the model invokes `cancelSale` with `{}`
- THEN the tool MUST return
  `{ ok: false, error: { kind: 'missingPlacedSaleId', retryable: false } }`
- AND `chatbotApi.cancelSale` MUST NOT be called.

#### Scenario: reason and cashierUserId are never model-chosen

- GIVEN `CHATBOT_API_CASHIER_USER_ID = "00000000-0000-4000-8000-000000000001"`
- WHEN the model invokes `cancelSale` with `{}` (the schema accepts no inputs)
- THEN the outgoing DTO MUST contain `reason: 'CUSTOMER_REQUEST'` (never another
  enum value, never model-supplied)
- AND the outgoing DTO MUST contain
  `cashierUserId: "00000000-0000-4000-8000-000000000001"` (injected, never
  model-supplied).

#### Scenario: SALE_NOT_FOUND clears placedSaleId as non-retryable

- GIVEN a stubbed `chatbotApi.cancelSale` that throws a `ChatbotApiError` with
  `statusCode: 404` and `errorCode: 'SALE_NOT_FOUND'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal
  `{ ok: false, error: { kind: 'saleNotFound', retryable: false } }`
- AND `readPlacedSaleId(state(S))` MUST equal `null` (the id is stale/unusable).

#### Scenario: saleNotCancellable degrades to human handoff and clears placedSaleId

- GIVEN a stubbed `chatbotApi.cancelSale` that throws a `ChatbotApiError` with
  `statusCode: 409` and `errorCode: 'SALE_DELIVERED_CANNOT_CANCEL'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal
  `{ ok: false, error: { kind: 'saleNotCancellable', retryable: false } }`
- AND the model MUST reply that cancellation is no longer possible by this channel
  and hand off to a human (never retry, never fabricate an outcome)
- AND `readPlacedSaleId(state(S))` MUST equal `null`.

#### Scenario: transient failure preserves placedSaleId for retry

- GIVEN a stubbed `chatbotApi.cancelSale` that throws a `ChatbotApiError` with
  `statusCode: 409` and `errorCode: 'IDEMPOTENCY_KEY_IN_FLIGHT'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal
  `{ ok: false, error: { kind: 'idempotencyInFlight', retryable: true } }`
- AND `readPlacedSaleId(state(S))` MUST still equal `'sale-1'` so the model can retry
  the same idempotent call later.

#### Scenario: already-canceled sale returns replay success, not an error

- GIVEN the backend already canceled `sale-1` out-of-band
- AND a stubbed `chatbotApi.cancelSale` that resolves to
  `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [], canceledAt: '2026-08-24T10:00:00.000Z' }`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST be `{ ok: true, ... }` with `status: 'CANCELED'`
  (no error kind, no retry)
- AND `readPlacedSaleId(state(S))` MUST equal `null`.

#### Scenario: explicit confirmation gate precedes the cancelSale call

- GIVEN a customer asks "cancela mi pedido" after a confirmed sale in the current
  session
- WHEN the model processes the request per `SALE_FLOW_INSTRUCTIONS` step 14
- THEN the model MUST re-show the sale summary (folio + total + status from the
  `createSale` success result in the current transcript)
- AND the model MUST ask EXACTLY `¿Confirmas la cancelación? Sí/No` and wait for an
  explicit "sí" before invoking `cancelSale`
- AND `cancelSale` MUST NOT be invoked on the first "cancela" turn or after any
  non-"sí" reply.

### Requirement: placedSaleId lifecycle lives in ConversationState.data

`ConversationStateData` MUST gain the optional typed field `placedSaleId?: string`.
The per-sender placed sale id MUST be persisted under
`ConversationState.data.placedSaleId` — a sibling of `data.cart`, never inside
`CartState` — with no new storage table and no migration.

Helpers MUST exist: `readPlacedSaleId(state)` returning `string | null` (a missing
key MUST read as `null`), `persistConfirmedSale(store, senderId, state, saleId)`, and
`clearPlacedSaleId(store, senderId, state)`.

The lifecycle MUST be:

1. **SET**: `createSale` success persists `data.cart = EMPTY_CART` AND
   `data.placedSaleId = sale.saleId` in ONE atomic `ConversationStore.update` — never
   two sequential `data`-replacing writes (the second would clobber the first's cart
   clear).
2. **READ**: `cancelSale` reads the id from durable state only — never from the
   model's input, never from `getOrderHistory`.
3. **CLEAR**: `cancelSale` success and permanent error kinds clear the id.
4. **OVERWRITE**: a new `createSale` success overwrites any prior `placedSaleId`.

#### Scenario: createSale success sets placedSaleId atomically with the cart clear

- GIVEN a sender S with a cart containing one item and a persisted `idempotencyKey`
- AND the backend `POST /chatbot-api/sales` returns `{ saleId: 'sale-1', discountCents: 0 }`
- WHEN `createSale` returns `ok: true`
- THEN the persisted `data` MUST contain
  `cart: { items: [], idempotencyKey: '', expectedTotalCents: undefined }` AND
  `placedSaleId: 'sale-1'`
- AND exactly ONE `ConversationStore.update` write MUST have occurred for that success
  (single atomic write, never two sequential writes).

#### Scenario: readPlacedSaleId returns null for a missing key

- GIVEN a stored `ConversationState` whose `data` has no `placedSaleId` key
- WHEN `readPlacedSaleId(state)` is called
- THEN the result MUST equal `null` (no validation error, no default fabrication).

#### Scenario: cancelSale success clears placedSaleId

- GIVEN `ConversationState.data.placedSaleId === 'sale-1'`
- WHEN `cancelSale` returns `ok: true`
- THEN `readPlacedSaleId(state)` MUST equal `null`
- AND a second `cancelSale` invocation MUST hit the `missingPlacedSaleId` guard
  ("no hay una venta reciente por cancelar").

#### Scenario: a new createSale overwrites the prior placedSaleId

- GIVEN `ConversationState.data.placedSaleId === 'sale-1'` from a previous confirmed sale
- WHEN the customer places a new sale and `createSale` returns `ok: true` with
  `saleId: 'sale-2'`
- THEN `readPlacedSaleId(state)` MUST equal `'sale-2'` (overwrite, never append).

### Requirement: checkStock returns a humanAssistance envelope on out_of_stock

The `checkStock` tool MUST continue to return the existing `stock` payload when stock is
available, but when `stock.status === 'out_of_stock'` the tool MUST additionally return a
`humanAssistance` envelope signalling R7 escalation. The trigger tool MUST NOT call
`HumanHandoffService.create(...)` directly (the trigger's role is the signal; the model
decides when to call `requestHumanAssistance`, which is the sole row-writing entry point
per ADR-9).

`checkStock`'s return type MUST be the discriminated union:

```text
{ ok: true, stock: { productId, variantId?, status: 'in_stock' | 'low_stock' | 'unknown' | 'out_of_stock', quantity?, lowStockThreshold?, updatedAt? } }
  // 'in_stock' / 'low_stock' / 'unknown' branches — no humanAssistance envelope

| { ok: true, stock: { ... 'out_of_stock' branch with quantity: 0 ... },
    humanAssistance: { kind: 'out_of_stock',
                        digest: { productId: string; name: string;
                                  variantId?: string; quantity?: number } } }
```

`humanAssistance.digest.name` MUST be sourced from the catalog response that
`searchCatalog` returned earlier in the same session (or, if the model already passed
the product name into `checkStock`, from that input) — NEVER fabricated. When the model
does not have a reliable `name` for the product (only `productId`), the tool MUST omit
`name` from the digest so the model re-asks or falls back to a search before calling
`requestHumanAssistance`.

#### Scenario: out_of_stock adds the humanAssistance envelope

- GIVEN `checkStock` is invoked with `{ productId: 'p-1', variantId: 'v-1' }`
- AND the stubbed `chatbotApi.getStock` returns
  `{ productId: 'p-1', variantId: 'v-1', status: 'out_of_stock', quantity: 0,
    updatedAt: '2026-09-01T00:00:00.000Z' }`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal
  `{ ok: true, stock: { productId: 'p-1', variantId: 'v-1', status: 'out_of_stock',
    quantity: 0, updatedAt: '2026-09-01T00:00:00.000Z' },
    humanAssistance: { kind: 'out_of_stock',
      digest: { productId: 'p-1', name: '<name from prior searchCatalog or input>',
                 variantId: 'v-1', quantity: 0 } } }`.

#### Scenario: in_stock / low_stock / unknown do not carry the envelope

- GIVEN `checkStock` returns a stock payload with `status` not equal to `'out_of_stock'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST NOT include a `humanAssistance` key.

#### Scenario: checkStock does not call HumanHandoffService directly

- GIVEN the `checkStock` tool
- WHEN the registry is constructed
- THEN `checkStock.execute` MUST NOT inject or call `HumanHandoffService`
- AND `checkStock.execute` MUST only return the `humanAssistance` envelope as a
  signal — the model is the entity that calls `requestHumanAssistance`.

### Requirement: evaluateCart returns a humanAssistance envelope on needs_human_review

The `evaluateCart` tool MUST continue to return the existing `evaluation` payload, but
when `promotionEvaluationStatus === 'needs_human_review'` (per the backend's coarse
rule, AGENTS.md §4.4.3 / backend `PROGRAM-CONTEXT.md` §4.4.3), the tool MUST additionally
return a `humanAssistance` envelope signalling the `needs_human_review` branch. The model
MUST still render the price quote (per existing semantics) and MUST only escalate when
the customer wants to proceed.

`evaluateCart`'s return type MUST be the discriminated union:

```text
{ ok: true, evaluation: { items, originalTotalCents, finalTotalCents, discountCents?, promotions? },
    promotionEvaluationStatus: 'ok' | 'rejected' | 'needs_human_review' }
  // 'ok' / 'rejected' branches — no humanAssistance envelope

| { ok: true, evaluation: { items, originalTotalCents, finalTotalCents, ... },
    promotionEvaluationStatus: 'needs_human_review',
    humanAssistance: { kind: 'needs_human_review',
                        digest: { items: Array<{ productId, name?, variantId?,
                                                 quantity, unitPriceCents? }>;
                                  originalTotalCents?: number;
                                  recomputedTotalCents?: number } } }
```

The `items` in the digest MUST mirror the cart's persisted items (one entry per
product/variant) with `unitPriceCents` from the cart (NEVER the discounted
`finalPriceCents` — the list price is what gets reviewed).

#### Scenario: needs_human_review adds the humanAssistance envelope

- GIVEN `evaluateCart` is invoked with a valid cart
- AND the stubbed `chatbotApi.evaluateCart` returns
  `{ items: [...], originalTotalCents: 1000, finalTotalCents: 1000,
     promotionEvaluationStatus: 'needs_human_review' }`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST deep-equal
  `{ ok: true, evaluation: { items: [...], originalTotalCents: 1000,
                              finalTotalCents: 1000 },
    promotionEvaluationStatus: 'needs_human_review',
    humanAssistance: { kind: 'needs_human_review',
      digest: { items: <cart items at list price>, originalTotalCents: 1000 } } }`.

#### Scenario: ok / rejected do not carry the envelope

- GIVEN `evaluateCart` returns `promotionEvaluationStatus: 'ok'` or `'rejected'`
- WHEN the tool's `execute` runs
- THEN the returned envelope MUST NOT include a `humanAssistance` key.

#### Scenario: evaluateCart does not call HumanHandoffService directly

- GIVEN the `evaluateCart` tool
- WHEN the registry is constructed
- THEN `evaluateCart.execute` MUST NOT inject or call `HumanHandoffService`
- AND `evaluateCart.execute` MUST only return the `humanAssistance` envelope as a
  signal — the model is the entity that calls `requestHumanAssistance`.

### Requirement: requestHumanAssistance is the twelfth sale-flow tool

`RealToolRegistry` MUST register an AI-SDK tool `requestHumanAssistance` as the twelfth
sale-flow key. Its `inputSchema` MUST be the discriminated union by `kind` declared in
the human-handoff spec (`out_of_stock`, `needs_human_review`, `expiration_date` — three
active kinds; `shipping_approval` is reserved for the future R6 slice and is NOT in
the union today). Its `contextSchema` MUST be `z.object({ senderId: z.string().min(1) })`
and MUST carry the customer's senderId. `execute` MUST delegate to
`deps.humanHandoffService.create({ senderId: options.context.senderId, kind: input.kind,
digest: input.digest })` and return the service's result envelope verbatim.

The tool MUST NOT call `chatbotApi.*` (it has no backend endpoint to call). The tool
MUST inject `HUMAN_HANDOFF_SERVICE` from `ToolDeps`. The tool MUST be idempotent for
repeat calls within the same pending session (a second `execute` returns the existing
`{ requestId, ref, customerNotified: true }` without a new row or new notice — see
the human-handoff spec).

#### Scenario: happy path returns the create envelope

- GIVEN `requestHumanAssistance` is invoked with
  `{ kind: 'out_of_stock', digest: { productId: 'p-1', name: 'X' } }`
- AND `context.senderId = '521...'`
- AND a stubbed `humanHandoffService.create(...)` returning
  `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`
- WHEN the tool's `execute` runs
- THEN the tool MUST call
  `humanHandoffService.create({ senderId: '521...', kind: 'out_of_stock',
    digest: { productId: 'p-1', name: 'X' } })` exactly once
- AND the returned envelope MUST deep-equal
  `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`.

#### Scenario: idempotent re-call returns the existing ref

- GIVEN `requestHumanAssistance` is invoked twice in a row with the same input
- AND the customer's `pendingHumanRequest` is already set from the first call
- WHEN the second invocation's `execute` runs
- THEN the tool MUST return the existing
  `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`
  envelope (no second `create` call beyond the idempotency guard).

#### Scenario: inputSchema rejects a malformed digest

- GIVEN `requestHumanAssistance` is invoked with
  `{ kind: 'out_of_stock', digest: { productId: 'not-a-uuid', name: '' } }`
- WHEN the schema parses
- THEN the parse MUST fail (Zod error)
- AND `execute` MUST NOT be called
- AND `humanHandoffService.create(...)` MUST NOT be called.

#### Scenario: inputSchema rejects shipping_approval today

- GIVEN `requestHumanAssistance` is invoked with `{ kind: 'shipping_approval', digest: {...} }`
- WHEN the schema parses
- THEN the parse MUST fail (no discriminator match — `shipping_approval` is reserved
  for the future R6 slice)
- AND the tool MUST NOT call `humanHandoffService.create(...)`.

### Requirement: Tool input schemas enforce AGENTS.md §4.4 validations (extended)

`requestHumanAssistance.inputSchema` MUST enforce, at minimum:

- `kind` MUST be one of `'out_of_stock' | 'needs_human_review' | 'expiration_date'`
  (today's three active kinds; `shipping_approval` is reserved and MUST NOT be in the
  union — the future R6 slice adds it).
- For `kind: 'out_of_stock'`:
  - `digest.productId` MUST be `z.string().uuid()`.
  - `digest.name` MUST be `z.string().min(1)`.
  - `digest.variantId` MUST be `z.string().uuid().optional()`.
  - `digest.quantity` MUST be `z.number().int().min(1).optional()`.
- For `kind: 'needs_human_review'`:
  - `digest.items` MUST be a non-empty array; each item MUST have
    `productId: z.string().uuid()`, `quantity: z.number().int().min(1)`,
    `name?: z.string().optional()`,
    `variantId?: z.string().uuid().optional()`,
    `unitPriceCents?: z.number().int().min(0).optional()`.
  - `digest.originalTotalCents` MUST be `z.number().int().min(0).optional()`.
  - `digest.recomputedTotalCents` MUST be `z.number().int().min(0).optional()`.
- For `kind: 'expiration_date'`:
  - `digest.productId` MUST be `z.string().uuid()`.
  - `digest.name` MUST be `z.string().min(1)`.
  - `digest.question` MUST be `z.string().min(1)`.

The `contextSchema` MUST be `z.object({ senderId: z.string().min(1) })`.

#### Scenario: out_of_stock schema rejects malformed productId

- GIVEN `requestHumanAssistance` is invoked with
  `{ kind: 'out_of_stock', digest: { productId: 'p-1', name: 'X' } }`
- WHEN the schema parses
- THEN the parse MUST fail (`productId` is not a UUID).

#### Scenario: needs_human_review schema rejects empty items

- GIVEN `requestHumanAssistance` is invoked with
  `{ kind: 'needs_human_review', digest: { items: [] } }`
- WHEN the schema parses
- THEN the parse MUST fail (`items` is non-empty).

#### Scenario: expiration_date schema rejects empty question

- GIVEN `requestHumanAssistance` is invoked with
  `{ kind: 'expiration_date', digest: { productId: 'p-1', name: 'X', question: '' } }`
- WHEN the schema parses
- THEN the parse MUST fail (`question` is min(1)).
