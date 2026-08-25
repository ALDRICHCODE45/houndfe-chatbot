# Q4 — Provisioning checklist for the bot cashier (`ServiceCredential`)

> Coordination doc — no code, no env additions, no DB writes. The
> `CHATBOT_API_CASHIER_USER_ID` env var stays exactly as the archived
> `sale-flow` slice left it; the only operational delta for Q4 is the
> `payment-details:read` scope on the existing `ServiceCredential`.

This document is the coordination checklist the backend team needs to
provision the bot cashier for the new `GET /chatbot-api/payment-details`
endpoint (Q1 / R11). It does NOT contain provisioning scripts — those
live on the backend. The bot's only contract here is the
`CHATBOT_API_CASHIER_USER_ID` env var, which is unchanged.

---

## What the bot needs

The bot issues `POST /chatbot-api/sales`, `GET /chatbot-api/payment-details`,
and the other nine endpoints under a service credential. The
`ServiceCredential` issued to the bot cashier must carry **7 scopes**:

| # | Scope | Used by |
|---|-------|---------|
| 1 | `catalog:read` | `searchCatalog`, `checkStock` |
| 2 | `pricing:evaluate` | `evaluateCart` |
| 3 | `customers:read` | `getCustomerByPhone`, `getOrderHistory` |
| 4 | `customers:write` | `upsertCustomer` |
| 5 | `sales:create` | `createSale` |
| 6 | `sales:write` | `attachReceipt`, `updateDelivery` |
| 7 | `payment-details:read` | `getPaymentDetails` (new in this slice) |

The seventh scope (`payment-details:read`) is the **delta** vs. the
archived `sale-flow` slice, which carried only six scopes. Without it,
every `GET /chatbot-api/payment-details` request returns `403 Forbidden`
and the bot enters the `forbidden` error envelope on the new 10th tool.

## What the backend team must seed

Per branch:

1. **Bot cashier `User` record.** One per branch (or one shared, scoped
   by branch via `CHATBOT_API_BRANCH_ID`); the bot reads `cashierUserId`
   from `CHATBOT_API_CASHIER_USER_ID` and forwards it on every write
   request as `cashierUserId` in the request DTO.
2. **`ServiceCredential`** tied to that `User`, carrying the 7 scopes
   above. **One credential per branch** — the bot is single-branch.
   Secret exposed to the bot as `SERVICE_KEY` (env var, unchanged).
3. **At least one active `PaymentDetail`** per branch/tenant. This is
   the data the new `GET /chatbot-api/payment-details` endpoint
   returns. Without an active `PaymentDetail`, every call returns
   `404 NO_ACTIVE_PAYMENT_DETAIL` and the bot enters the human-handoff
   branch (operational, not a crash):

   > "en un momento un agente te comparte los datos de pago"

   Operators see this in conversations as a non-error pause — the bot
   handles it correctly per the step-12 spec scenario.

## What the bot does NOT need from the provisioning slice

- **No new env vars.** `CHATBOT_API_CASHIER_USER_ID`, `SERVICE_KEY`,
  `CHATBOT_API_BASE_URL`, `CHATBOT_API_BRANCH_ID` are unchanged.
- **No DB writes.** The bot is consumer-only; the bot cashier `User`
  and `ServiceCredential` live on the backend.
- **No migration.** The `ServiceCredential` scopes are additive (the
  `payment-details:read` scope is new — see delta vs. the archived 6-scope
  list). Existing credentials for the other six scopes stay valid; only
  the new scope needs to be granted.
- **No `AGENTS.md` §4.4 update yet.** That sync is a follow-up
  `chatbot-api-doc-sync` slice (Risk R-5 in the proposal). Until that
  slice lands, this doc is the source of truth for the new endpoint +
  scope.

## Operational notes

- A missing `PaymentDetail` is **operational, not a crash** — the bot
  emits the human-handoff phrase and pauses. Operators can rotate the
  account mid-day without a code change.
- The 10th AI-SDK tool `getPaymentDetails` is gated by step 12 of the
  prompt literal to be called ONLY after `createSale` returns `ok: true`.
  Operators do not need to worry about the bot leaking bank details
  before a sale is confirmed.
- The `payment-details:read` scope is a **per-credential grant** — it
  does not require the bot to expose any additional user-facing API.
  Existing rate-limit, retry, and audit-trail policies on the
  chatbot-api client apply unchanged.

## Verification

The slice is live only when:

1. `pnpm test` is green (303 passing tests).
2. `pnpm test:e2e` is green.
3. `pnpm build` is clean.
4. `git grep BANK_DETAILS_PROVIDER` returns no matches in `src/`
   (seam removed).
5. `RealToolRegistry.getTools()` exposes exactly 10 keys including
   `getPaymentDetails`.

## Follow-up slices (out of scope for Q4)

- `chatbot-api-doc-sync` — reconcile `AGENTS.md` §4.4 with the backend's
  `PROGRAM-CONTEXT.md` §4.4 (now 11 endpoints; the `payment-details:read`
  scope; the `expectedTotalCents` / `discountCents` fields; the four new
  error envelope codes).
- `llm-agent-provider-spec-sync` — small drive-by to align the
  canonical `openspec/specs/llm-agent/spec.md` with the shipped
  `@ai-sdk/openai` + `OPENAI_API_KEY` implementation (carry-over from
  the archived `sale-flow` slice).
- `evaluate-cart-coverage-expansion` (Q5), `partial-customer-dto` (Q6),
  `order-history-phone-country-code-validation` (Q7),
  `cancel-endpoint-conversational` (Q8) — deferred per the
  `docs/backend-questions-sale-flow-responses.md` answers.