# Delta for Sale Flow Tools

## MODIFIED Requirements

### Requirement: Tool input schemas enforce AGENTS.md §4.4 validations

Each tool's `inputSchema` (Zod object) MUST enforce the validations declared in
`AGENTS.md` §4.4.x for the corresponding endpoint, including at minimum:

- UUID parameters (`productId`, `variantId`, `customerId`, `saleId`,
  `shippingAddressId`) MUST be `z.string().uuid()` wherever those parameters remain
  model-supplied for their corresponding endpoint.
- Quantity / `unitPriceCents` / `declaredAmountCents` MUST be `z.number().int()`
  with `.min(1)` (or `.min(0)` where the contract specifies `@Min(0)`).
- URL fields on tools that retain model-supplied media references MUST be
  `z.string().url()` (matching `@IsUrl()`). The model-facing `attachReceipt` schema
  MUST NOT expose or accept `saleId` or `mediaUrl`; its receipt attachment context and
  identifiers MUST be server-owned.
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

#### Scenario: A representative schema rejects malformed or model-owned receipt identifiers

- GIVEN the `attachReceipt` tool
- WHEN the model invokes it with `{ saleId: "not-a-uuid", mediaUrl: "not-a-url",
declaredAmountCents: 0 }`
- THEN the schema parse MUST fail with a Zod error
- AND the underlying `chatbotApi.attachReceipt` MUST NOT be called.
- AND the model MUST NOT be given any schema field for `saleId`, `mediaUrl`, object key,
  capability token, stable media URL, or pending-media identifier.

#### Scenario: requestHumanAssistance input schema rejects shipping_approval today

- GIVEN the `requestHumanAssistance` tool
- WHEN the model invokes it with `{ kind: 'shipping_approval', digest: { ... } }`
- THEN the schema parse MUST fail (no discriminator match — `shipping_approval` is not
  in the union today)
- AND `execute` MUST NOT be called.

The receipt-specific attachment boundary MUST derive receipt attachment inputs and identifiers
from deterministic receipt-media state and the captured `placedSaleId`. The model MUST NOT
supply or observe `saleId`, Meta URL, object key, capability token, stable `mediaUrl`, or
pending-media identifier. Deterministic amount parsing, normalization, confirmation, and
cancellation remain owned solely by `receipt-media`.

#### Scenario: captured sale and server-owned receipt context are used

- GIVEN receipt media was accepted with durable `placedSaleId = sale-A` and deterministic
  receipt-media state containing the server-owned attachment context
- AND later conversation state mentions sale-B or model input supplies a URL or identifier
- WHEN attachment executes after explicit confirmation
- THEN §4.4.7 MUST target sale-A and the server-owned receipt context only
- AND no model-supplied sale id, Meta URL, object key, capability token, stable media URL,
  or pending-media identifier may affect the request.

#### Scenario: missing placed sale blocks the tool

- GIVEN receipt media has no durable `placedSaleId`
- WHEN attachment is requested
- THEN the tool MUST make no HTTP call and MUST return the stable missing-sale outcome.

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
13. Receipt images MUST enter deterministic `receipt-media` handling outside model
    authority. The bot MAY guide the customer, but backend §4.4.7 attachment occurs only
    after server-owned media correlation, deterministic amount parsing, and explicit
    confirmation. The model MUST NOT call attachment with `saleId`/`mediaUrl` or supply
    any receipt attachment identifier.
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
prompt phrases with no backing mechanism; the cancel step 14 was the only "human handoff"
branch and was prompt-phrased.)

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
