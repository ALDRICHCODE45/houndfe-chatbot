# Delta for sale-flow-tools

## Out of Scope (non-goals)

This delta does NOT introduce:

- **R6 shipping-quote approval gate.** `requestShippingApproval` and the Skydropx /
  Envíos Perros / Amazon check / $120 credit / CDMX free-zone list are deferred to the
  future shipping slice. The `HumanHandoffKind` union reserves `shipping_approval` so R6
  plugs in by enabling that discriminator; the `requestHumanAssistance` tool today
  rejects it as `kind: 'validation'` (see the human-handoff spec).
- **New backend chatbot-api endpoints.** The handoff flow does NOT call the backend.
  `ChatbotApiClient` is unchanged; `CHATBOT_API_CASHIER_USER_ID` continues to be the
  only cashier injection; no `AGENTS.md` §4.4.x entry is added.
- **Changes to the existing eleven tools' schemas, error envelopes, or persistence
  contracts.** `checkStock` and `evaluateCart` GAIN a `humanAssistance` envelope but the
  existing return shapes (`stock`, `evaluation`) are preserved byte-identically for
  non-trigger branches.
- **A new conversation-state field on the JSONB bag shape beyond
  `data.pendingHumanRequest`.** That field lives in the `conversation-store` delta.
- **A scheduler, cron job, or `setTimeout`** that drives the awaiting-human branch.
  The dispatcher pre-routing hook (in the `whatsapp-webhook` delta) is the only place
  the bot acts during the await; the model is told to wait indefinitely (see the new
  step in `SALE_FLOW_INSTRUCTIONS`).
- **A scheduler-based nudge to the customer or expiry on the pending request.**
  Owner-decision: bot waits; subsequent customer inbounds get the canned "seguimos
  esperando" reply (see the `llm-agent` delta); only the human's reply on the ops thread
  unblocks the customer.
- **A separate human-handoff branch inside `ToolDeps`.** The new
  `HumanHandoffService` is added to `ToolDeps` (so the `requestHumanAssistance` tool
  factory can inject it); no other tool is refactored to use it directly.

## MODIFIED Requirements

### Requirement: RealToolRegistry registers the twelve sale-flow tools

A `RealToolRegistry` MUST register exactly the twelve sale-flow AI-SDK tools listed below,
replacing `InMemoryToolRegistry` in the production wiring of `LlmAgentModule`. Each
tool's parameter name MUST match the corresponding chatbot-api endpoint field name
documented in `AGENTS.md` §4.4.x verbatim. The registry docstring MUST read "twelve
sale-flow tools" (bumped from eleven).

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

#### Scenario: A representative schema rejects malformed inputs

- GIVEN the `attachReceipt` tool
- WHEN the model invokes it with `{ saleId: "not-a-uuid", mediaUrl: "not-a-url",
  declaredAmountCents: 0 }`
- THEN the schema parse MUST fail with a Zod error
- AND the underlying `chatbotApi.attachReceipt` MUST NOT be called.

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
`'auth' | 'forbidden' | 'notFound' | 'upstream' | 'validation' | 'noActivePaymentDetail' | 'promoReQuote' | 'idempotencyInFlight' | 'idempotencyConflict' | 'priceOutOfDate' | 'saleNotFound' | 'saleNotCancellable' | 'missingPlacedSaleId' | 'disabled'`,
and `retryable` MUST be `true` for transient `upstream`, `rateLimit`, and
`idempotencyInFlight` cases and `false` otherwise.

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
13. On receipt image, call `attachReceipt`.
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

### Requirement: CHATBOT_API_CASHIER_USER_ID is required at boot

The environment MUST provide `CHATBOT_API_CASHIER_USER_ID` as a UUID v4.
The Joi validation pipeline in `src/config/env.validation.ts` MUST reject boot
when the variable is absent or not a valid UUID, before any webhook traffic is
accepted. The resolved value MUST be sent as `cashierUserId` in every
`POST /chatbot-api/sales` (§4.4.6) request issued by `createSale`. (Per
`AGENTS.md` §5.3, the corresponding `User` record must be seeded by the backend
team before live sales; this requirement only fixes the chatbot-side env contract.)

The handoff slice does NOT change this contract. `requestHumanAssistance` does NOT
forward `cashierUserId`; the row in `human_handoff_requests` carries no cashier
information.

(Previously: the cashier id was the only cashier injection; unchanged.)

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

### Requirement: updateDelivery is registered but not exercised by this slice

The `updateDelivery` tool MUST be registered in `RealToolRegistry` (so the model
knows it exists for future slices), but the conversational flow encoded in
`SALE_FLOW_INSTRUCTIONS` MUST NOT promise a shipping cost and MUST NOT call this
tool. Tests MUST assert that no scenario path triggers `updateDelivery` end-to-end
through this slice. The handoff slice does NOT change this contract; the new
`requestHumanAssistance` tool MUST NOT call `updateDelivery` either (the R6
shipping slice owns `updateDelivery` integration when it ships).

#### Scenario: updateDelivery is in the registry but not invoked in the slice

- GIVEN the `RealToolRegistry` binding
- WHEN `registry.getTools()` is called
- THEN `updateDelivery` MUST be present in the returned ToolSet
- AND any integration test that exercises the slice's conversational program
  MUST NOT observe a `PATCH /chatbot-api/sales/:saleId/delivery` request.

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