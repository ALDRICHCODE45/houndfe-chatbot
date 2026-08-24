# Proposal: sale-flow

## Intent

Wire the bot's sales-conversation capabilities end-to-end. `ChatbotApiHttpClient` already
implements all 9 chatbot-api endpoints, but the LLM agent's `ToolRegistry` only returns a
`getCurrentTime` placeholder — so today the bot cannot actually sell anything. This slice
replaces the placeholder with real, type-safe AI-SDK tools (`tool()` + Zod) backed by the
existing `ChatbotApiClient`, registers the gateway through `LlmAgentModule`, and extends the
agent's system prompt with a programmable sale flow (browse → cart → confirm data → create
order → transfer receipt) that respects the existing no-hallucination / refusal contract.

The slice is intentionally **scoped to transfer-payment sales** with a **list-price
`createSale`** path and **two blocked seams** for backend-decision items (R11 bank details,
R13 promo-discounted `createSale`); see §Scope. Shipping quotes, card payments, image
recognition, and human handoff remain future slices.

### Relationship to existing capabilities

- **MODIFIED `llm-agent`** (existing capability, `openspec/specs/llm-agent/spec.md`): the
  registry wires the `ChatbotApiModule` + `ConversationStore`, and the system prompt is
  composed of the existing base prompt (refusal phrase, neutral Mexican Spanish, no
  fabrication) **plus** the sale-flow slice instructions that this change introduces. The
  runner's "MUST NOT override the prompt at runtime" contract is preserved; the new
  composition happens at module boot.
- **NEW `sale-flow-tools`** capability: provides the real tool implementations, cart state
  schema, and the `BankDetailsProvider` seam. Owns the conversational programming that
  programs the model via the prompt extension.
- **UNCHANGED**: `chatbot-api-client`, `conversation-store`, `whatsapp-sender`,
  `whatsapp-webhook`, `app-config`. `conversation-store`'s `data` bag already accepts an
  arbitrary `[key: string]: unknown` payload (see `ConversationStateData` in
  `src/conversation/domain/conversation-store.ts`), which is where the per-sender cart
  lives. No spec or schema migration is required for that.

### Authoritative user decisions encoded in this proposal

1. **Shipping quotes (R2–R5)**: OUT of this slice. The bot's flow must not assume a
   shipping cost exists anywhere. The `updateDelivery` tool is registered but used only
   after a future shipping slice provides carrier/tracking data.
2. **Promo-discounted `createSale` (R13)**: BLOCKED on backend fix (Q2 in
   `docs/backend-questions-sale-flow.md`). This slice registers sales at **list price**
   only. `evaluateCart` is still called for the customer-facing quote; `createSale` uses
   `originalPriceCents` from the same evaluation. When `promotionEvaluationStatus ===
   'needs_human_review'`, the bot tells the customer they will be contacted by a human —
   the prompt **must not** invent a discounted price to register.
3. **Bank details source (R11)**: BLOCKED on backend answer to Q1. A `BankDetailsProvider`
   port is introduced with a no-op default implementation that returns
   `null` (the bot reaches "necesito tus datos para registrar el pedido" and pauses before
   composing the bank-details message). The source is swappable; the decision is deferred.
4. **Card payment / Link EVO (R16)**: OUT of scope for v1. Transfer-only. The
   `preferredPaymentMethod` field is recorded as `"TRANSFER"` and the receipt request asks
   for a transfer receipt.

## Scope

### In Scope

- **`LlmAgentModule` wiring**: import `ChatbotApiModule` so the tool registry can inject
  `CHATBOT_API_CLIENT`. Inject `CONVERSATION_STORE` so tools can read/write the cart state
  held in `ConversationState.data.cart`. Production wiring only; tests inject mocks via
  `Test.createTestingModule({ imports: [...] })`.
- **9 real tools** registered in a new `RealToolRegistry` that replaces the placeholder
  `InMemoryToolRegistry`:
  | Tool | Endpoint (AGENTS.md §4.4) | Scope |
  |---|---|---|
  | `searchCatalog` | §4.4.1 GET `/chatbot-api/catalog/search` | `catalog:read` |
  | `checkStock` | §4.4.2 GET `/chatbot-api/catalog/:productId/stock` | `catalog:read` |
  | `evaluateCart` | §4.4.3 POST `/chatbot-api/pricing/evaluate-cart` | `pricing:evaluate` |
  | `getCustomerByPhone` | §4.4.4 GET `/chatbot-api/customers/by-phone` | `customers:read` |
  | `upsertCustomer` | §4.4.5 PUT `/chatbot-api/customers/by-phone` | `customers:write` |
  | `createSale` | §4.4.6 POST `/chatbot-api/sales` (+ `X-Idempotency-Key`) | `sales:create` |
  | `attachReceipt` | §4.4.7 POST `/chatbot-api/sales/:saleId/receipts` | `sales:write` |
  | `updateDelivery` | §4.4.8 PATCH `/chatbot-api/sales/:saleId/delivery` | `sales:write` |
  | `getOrderHistory` | §4.4.9 GET `/chatbot-api/customers/by-phone/:phone/orders` | `customers:read` |
- **Each tool** is an AI-SDK `tool({ description, inputSchema: z.object({...}), execute })`,
  parameter names match `AGENTS.md` §4.4 verbatim, and the input Zod schemas enforce the
  documented validations (UUIDs, `@IsInt() @Min(1)` for quantities, `@IsUrl()` for the
  receipt's `mediaUrl`). Errors are caught from `ChatbotApiClient` and returned to the
  agent as `{ ok: false, error: { kind: 'auth'|'forbidden'|'notFound'|'rateLimit'|'upstream'|'validation', retryable: boolean } }` so the model can phrase a user-friendly reply or retry.
- **Cart state**: typed `CartState` (`items: Array<{ productId, variantId?, quantity, unitPriceCents }>` + `idempotencyKey: string`) stored under
  `ConversationState.data.cart`. Helper `readCart`/`writeCart` mirroring
  `readMessages`/`writeMessages` style. Tools call `writeCart` after `searchCatalog`
  add/remove and read it on `evaluateCart` / `createSale`. Per explore guidance:
  same in-memory-within-session pattern as `messages`; do **not** over-engineer (no
  separate Postgres table; no expiry cron).
- **System prompt composition**: introduce `SALE_FLOW_INSTRUCTIONS` text (escrow-style
  flow: greet → ask product → search → confirm → ask stock → add to cart → repeat or
  review → evaluate pricing → ask for/confirm customer data → confirm order summary →
  register sale → send R11 bank-details + ask for transfer receipt → on receipt image
  call `attachReceipt` → end). Concatenated with the existing `SYSTEM_PROMPT` at module
  boot (`base + '\n\n' + slice`). The "MUST NOT override at runtime" contract stays —
  composition happens once at startup, not per-turn.
- **Config additions**: `CHATBOT_API_CASHIER_USER_ID` (Joi `string().uuid().required()`).
  This MUST be set for `createSale` to succeed (FK constraint, AGENTS.md §5.3). Boot
  fails-fast when missing — same pattern as the existing LLM env. Bank-details env
  vars are **NOT** added (the seam is a port, not an env var).
- **`BankDetailsProvider` seam**: `interface BankDetailsProvider { get(): Promise<BankDetails | null> }` injected into the prompt or into a thin
  orchestrator helper. v1 default impl returns `null`. The prompt instructs the model
  that when `BankDetailsProvider.get()` returns `null`, the bot tells the customer
  *"en un momento un agente te comparte los datos de pago"* and halts the receipt-request
  step. When the backend answer to Q1 arrives, the impl is swapped (env-based read, or
  thin chatbot-api caller via `ChatbotApiClient`); neither the model nor any tool changes.
- **Tests** (strict TDD per `openspec/config.yaml` `rules.apply.tdd: true`):
  - Unit per tool (mock `ChatbotApiClient`, assert endpoint mapping, Zod validation
    errors, error-shape output).
  - Unit per tool against a contract test that exercises the input Zod schema with both
    valid and invalid samples.
  - `RealToolRegistry` integration test that verifies all 9 tools are registered, the
    `ToolRegistry.getTools()` shape matches what `VercelAiLlmAgent` consumes, and the
    registry DI-binding pulls `CHATBOT_API_CLIENT` + `CONVERSATION_STORE` correctly.
  - Prompt-contract test: assert the composed prompt contains (i) the literal refusal
    phrase `esa función aún no está disponible`; (ii) the forbidden slang block; (iii) the
    sale-flow step list; (iv) the explicit instruction that `createSale` may only be
    called at list price and that promo discounts trigger human handoff.
  - `LlmAgentModule` wiring spec: assert `ChatbotApiModule` is imported and that
    `RealToolRegistry` resolves with `CHATBOT_API_CLIENT`.

### Out of Scope

- **Shipping quotes** (R2–R5) and Skydropx — future slice. `updateDelivery` is registered
  as a tool but is not exercised in this slice's conversational flow; the prompt does not
  promise a shipping cost.
- **Card payment / Link EVO** (R16) — future slice. The recorded `preferredPaymentMethod`
  is `TRANSFER` in v1.
- **Promo-discounted `createSale`** — blocked on backend Q2. Seam expressed in the prompt
  (tool receives both `originalPriceCents` and `finalPriceCents` from `evaluateCart`; the
  tool **must** send `originalPriceCents` to the backend this slice); the converse path
  is a follow-up once Q2 is answered.
- **Bank-details source decision** — blocked on backend Q1. A port is added; the
  decision is deferred.
- **Image-recognition** (R1), **human-handoff channel** (R6/R7/R14), **WhatsApp media
  hosting** (AGENTS.md §11 item 12), **delivery zones** (R5), **persona name / "Andrea"
  bot identity** (conversation-analysis.md tone notes), **deployment / VPS work**.
- **Any houndfe-backend code change** (READ-ONLY constraint, hard; backend team owns
  replies to `docs/backend-questions-sale-flow.md`).

## Capabilities

### New Capabilities

**`sale-flow-tools`** — provides the real tool implementations, the per-sender cart state
schema, the `BankDetailsProvider` port, and the slice-specific instructions that are
concatenated with the agent's base system prompt at boot. Owned by this slice.

### Modified Capabilities

**`llm-agent`** — registry wires `ChatbotApiModule` and `ConversationStore`; the system
prompt becomes `base + slice` (composition at startup, not per-turn override). The
existing requirement that the refusal phrase, neutral Spanish mandate, and no-fabrication
contract remain in the final prompt **is preserved and asserted by a new scenario in the
spec**. Requirements in `openspec/specs/llm-agent/spec.md` that reference
`getCurrentTime`-only tooling are relaxed: a `ToolRegistry` provider "MUST register a
non-empty set of sale-flow tools" and "MUST bind `CHATBOT_API_CLIENT` from `ChatbotApiModule`".

## Approach

**Architecture follow-through**: the existing screaming-layout NestJS module per
`openspec/config.yaml` `rules.apply` and the NestJS-patterns skill. Files land under
`src/sale-flow/{domain, application, infrastructure, presentation}/…` and the module is
imported by `LlmAgentModule`. The "chatbot is consumer-only" constraint is preserved end
to end (no direct DB writes; all writes go through chatbot-api).

**Tool pattern**: each tool is a pure function `(deps: { chatbotApi, store, bankDetails })
→ tool({ description, inputSchema, execute })`. Zod schemas declare input shape; the
`execute` function awaits `chatbotApi.<method>` and returns a discriminated-union-shaped
result. Errors from `ChatbotApiClient` map to a stable envelope so the model never sees
"HTTP 500" — only an actionable description.

**Cart state**: stored at `ConversationState.data.cart`; helper functions
(`readCart(state)`, `writeCart(state, patch)`) live in
`src/sale-flow/domain/cart-state.ts` and mirror the `readMessages` pattern. Tools call
`store.get(senderId)` / `store.update(senderId, …)` exactly like the agent runner
already does.

**Prompt composition**: at module boot, `SALE_FLOW_INSTRUCTIONS` (string literal in
`src/sale-flow/domain/sale-flow-instructions.ts`) is concatenated with `SYSTEM_PROMPT`
and injected via a `LLM_AGENT_SYSTEM_PROMPT` provider token the `AgentRunner` reads
through `ConfigService` (same pattern as `llm.historyTurns`). The "MUST NOT override at
runtime" rule stays intact — composition is one-shot at boot.

**Idempotency**: `createSale` generates a UUID v4 with `crypto.randomUUID()` on the first
call attempt and persists it to the cart. Subsequent retries (within the same
`ConversationStore`-keyed session) reuse the same key, which protects against double-charge
when the backend's `SaleIdempotency` table returns the cached success on retry
(AGENTS.md §4.3). When the cart is cleared (`createSale` success), the key is dropped.

**Strict TDD**: failing test first (red), minimal impl to green, refactor when green.
Test commands: `pnpm test`, `pnpm test:cov`, `pnpm test:e2e`. Coverage threshold 80%.

**Spec drift callout (NOT a fix in this slice)**: the existing `llm-agent` spec
references the Vercel AI Gateway (`AI_GATEWAY_API_KEY` + `gateway()` provider), but the
shipped implementation uses `@ai-sdk/openai`'s `openai(model)` + `OPENAI_API_KEY`. This
slice does **not** modify the LLM provider — adding new tools and a new prompt is
orthogonal. Fixing the spec drift is logged as a follow-up backlog item
(see Risks table).

## Affected Areas

| Area | Impact |
|---|---|
| `src/sale-flow/` (new: `domain/`, `application/`, `infrastructure/`, `tools/`) | **New feature module**: cart state, `BankDetailsProvider` port + null-impl, `RealToolRegistry`, 9 tool files, prompt-instructions string |
| `src/sale-flow/sale-flow.module.ts`, `src/llm-agent/llm-agent.module.ts` | **Modified**: `LlmAgentModule` imports `SaleFlowModule` (and transitively `ChatbotApiModule`, `ConversationModule` already transitively reachable) |
| `src/llm-agent/domain/system-prompt.ts` | **Modified**: composes base + slice at module boot via a new `LLM_AGENT_SYSTEM_PROMPT` provider. Base text byte-identical. |
| `src/llm-agent/infrastructure/in-memory-tool-registry.ts` | **Renamed/replaced** by `RealToolRegistry` in `src/sale-flow/infrastructure/` (placeholder kept in repo for downstream test fixtures that still need a no-op registry) |
| `src/config/env.validation.ts`, `src/config/configuration.ts`, `src/config/env.validation.spec.ts`, `src/config/configuration.spec.ts` | **Modified**: add `CHATBOT_API_CASHIER_USER_ID` (Joi `string().uuid().required()`); expose `llm.systemPrompt` resolved through a factory that concatenates base + `SALE_FLOW_INSTRUCTIONS` |
| `openspec/specs/llm-agent/spec.md` | **Modified**: relax the `ToolRegistry MUST register at least one placeholder` requirement; add scenarios for composed-prompt contract and real-tools wiring |
| `openspec/specs/sale-flow-tools/spec.md` | **New**: capability spec for tools, cart state, `BankDetailsProvider`, and the slice instruction set |
| `src/sale-flow/**/*.spec.ts`, integration tests in `test/jest-e2e.json` | **New**: per-tool units, contract tests, registry wiring, prompt-contract integration |
| `docs/backend-questions-sale-flow.md` | **UNCHANGED** (referenced by Risks table) |
| `AGENTS.md` | **UNCHANGED** (referenced for §4.4 endpoint contracts) |

## Risks

| # | Risk | Lik | Impact | Mitigation |
|---|------|-----|--------|-----------|
| R-A | **Backend Q2 unresolved** — only list-price `createSale` ships; if the team invalidates the assumption, all `createSale` calls in this slice must be reworked. | Med | High | The prompt explicitly instructs the model to use `originalPriceCents`; tools pass `originalPriceCents` (not `finalPriceCents`) to `createSale`. Tests pin this contract. When Q2 is answered, a follow-up slice adds the discounted path. |
| R-B | **Backend Q1 unresolved** — bank-details message is replaced by a "wait for human" reply; customers can never complete the transfer flow in v1. | Med | High | The `BankDetailsProvider` seam is small (≤ 40 LoC) and swappable; once the team answers with an endpoint or a config strategy, the swap is a single-provider change + new impl + spec scenario. |
| R-C | **Size forecast exceeds 400-line review budget** — 9 tools × ~60 LoC + 9 tools × ~60 LoC tests + registry (~120 LoC + tests) + prompt composition (~80 LoC + tests) + cart state (~60 LoC + tests) + BankDetailsProvider (~40 LoC + tests) + new spec + module wiring + config + integration test (~1500–1700 LoC). The review budget per delivery context is 400 lines. | High | Med | User accepted single-PR delivery in delivery context. Pre-merge: split into at most two reviewable commits (Wiring+Seams, Tools+Cart) so a reviewer can land the prompt/spec split independently. Post-merge if review feedback requires line-by-line history, cherry-pick by file. |
| R-D | **Spec drift already present** — `llm-agent` spec mentions gateway + `AI_GATEWAY_API_KEY`, impl uses openai + `OPENAI_API_KEY`. Following this slice without fixing the drift leaves the spec misaligned with shipped code. | Med | Med | Logged as a follow-up backlog item; this slice only modifies the tool-registry and prompt-composition requirements in `llm-agent`, deliberately not the provider. A separate small slice (`llm-agent-provider-spec-sync`) reconciles. |
| R-E | **Cart survives across idle sessions** — if a customer returns hours later, their cart is still in the store. They may expect a fresh conversation; the bot may re-quote stale prices. | Med | Low | The existing `AgentRunner` idle-timeout semantics already wipe `messages` history in memory after `LLM_IDLE_TIMEOUT_MS`; the slice mirrors that behavior for cart by reading/writing through the agent runner's idle-expired branch (cart persists in storage but the in-memory prompt history is fresh, so the model cannot enumerate it without a tool call — and even then, re-`evaluateCart` would surface new prices). Document this in the spec scenario. |
| R-F | **`createSale` customerId comes from `upsertCustomer`** — partial upsert today requires `address.street` (AGENTS.md §4.4.5). First-time customers may not have an address yet (only name + phone) but the DTO rejects that. | Med | Med | The flow treats `upsertCustomer` as the confirm-data step and asks the customer for the address as part of the order data collection (R8); on `address` re-relaxation (Q6 in docs/backend-questions-sale-flow.md), a follow-up can split into two `upsertCustomer` calls. |
| R-G | **`evaluateCart` returns `needs_human_review` for carts where a non-supported promo is active globally** — bot may tell many customers to wait for a human even when no promo applies to their cart (explore audit). | Med | Med | Spec scenario documents the behavior; the prompt instructs the bot to surface *"necesito que un agente te confirme el precio final"* exactly when the backend says so; we do NOT work around the backend's coarse rule from the chatbot side. |
| R-H | **Extra backend endpoint** — `POST /chatbot-api/sales/:saleId/cancel` exists in the backend controller but is not in AGENTS.md §4.5 and not in `ChatbotApiClient`. | Low | Low | Out of scope; explicitly not wired in this slice. Listed here for awareness. |

## Rollback

Two clean rollback paths, used depending on what goes wrong:

1. **Behaviour rollback** — the registry swap is a one-line `useClass` change in
   `LlmAgentModule`. Revert `RealToolRegistry` → the existing `InMemoryToolRegistry`.
   `SYSTEM_PROMPT` falls back to the unchanged base prompt. The bot immediately returns
   `esa función aún no está disponible` for everything sale-flow-related (safe
   degradation: no fabricated behaviour, refusal contract still holds). No data is lost
   (conversation store is unchanged; chatbot-api is unchanged).
2. **Code rollback** — revert the merge commit. Conventional single-PR delivery keeps the
   revert to one commit. The placeholder registry and base prompt are still in git
   history; no destructive deletes occur.

## Dependencies

### Existing (no change)

- `houndfe-backend` chatbot-api (read-only) — 9 endpoints documented in AGENTS.md §4.4.
- `ChatbotApiHttpClient` (`src/chatbot-api/infrastructure/chatbot-api-http.client.ts`) —
  already exposes all 9 typed methods.
- `ConversationStore` (`src/conversation/infrastructure/`) — UPSERT contract supports the
  cart state bag.
- `ai` (Vercel AI SDK) + `zod` — already added by the `llm-agent-conversation-persistence`
  slice (see Engram #2541).

### New (package additions, if any)

- None expected. `crypto.randomUUID()` is a Node built-in for the idempotency key.

### External (blocking for live sales, NOT for code)

- Seeded bot cashier `User` record (AGENTS.md §5.3) — backend team seed.
- ServiceCredential with the documented scopes (AGENTS.md §5.3) — backend team seed.
- Backend answers to Q1 (bank details) and Q2 (promo-discounted sale) to close the two
  blocked seams.

## Success Criteria

- [ ] All 9 tools registered via `RealToolRegistry`; placeholder registry no longer used
      in the production wiring.
- [ ] `LlmAgentModule` imports `ChatbotApiModule` (DI graph still resolves in tests).
- [ ] Each tool has a unit + contract spec; integration test pins the composed-prompt
      contract (refusal phrase intact, forbidden slang absent, sale-flow step list
      present, list-price-only instruction present).
- [ ] Cart persists per-sender under `ConversationState.data.cart`; `RealToolRegistry`
      round-trips add/remove/evaluate/create-sale correctly.
- [ ] `pnpm test` and `pnpm test:e2e` are green; `pnpm build` is clean.
- [ ] `pnpm lint` passes on changed files (repo-wide lint is broken pre-existing; use
      scoped `pnpm exec eslint src/sale-flow src/llm-agent`).
- [ ] `CHATBOT_API_CASHIER_USER_ID` added to `env.validation.ts`; missing-env test
      passes; boot fails fast with a clear error.
- [ ] `BankDetailsProvider` port + null-default binding wired; spec scenario asserts the
      bot pauses when the provider returns `null`.
- [ ] `createSale` end-to-end spec passes against a mocked `ChatbotApiClient`: idempotency
      key is a UUID v4, reused across retries, and cleared on success.
- [ ] Two spec files exist: modified `openspec/specs/llm-agent/spec.md` and new
      `openspec/specs/sale-flow-tools/spec.md`. All scenarios are Given/When/Then with
      RFC 2119 keywords.
- [ ] Manual smoke test against a sandbox backend: bot browses, builds a 2-item cart,
      evaluates pricing, upserts customer, creates a sale at list price, and attaches a
      receipt from a Meta `mediaUrl`.
- [ ] Follow-up backlog items created (Engram, project `houndfe-chatbot`):
      `promo-discounted-createSale`, `bank-details-source-impl`,
      `llm-agent-provider-spec-sync`, `meta-media-cdn-url-expiry`.

## Follow-up Slices (out of scope, tracked here so they are not lost)

1. **Shipping quote slice** (R2–R5, R15 carrier/tracking) — depends on backend Skydropx
   integration; unlocks `updateDelivery` end-to-end in the flow.
2. **Promo-discounted `createSale`** — depends on backend Q2; replaces the list-price
   guard in the prompt and the `createSale` tool.
3. **Bank-details `BankDetailsProvider` impl** — depends on backend Q1; swaps the
   null-default for an env-read or a chatbot-api caller.
4. **Image-recognition** (R1) — depends on a multimodal model + product-image index;
   pre-req for the most common entry point observed in conversation #1.
5. **Human-handoff channel** (R6, R7, R14) — separate WhatsApp conversation (or group)
   with async request/response; needs new ports + a small in-memory state machine.
6. **Link EVO card payment** (R16) — depends on Link EVO partner integration.
7. **`llm-agent-provider-spec-sync`** — small drive-by slice to bring
   `openspec/specs/llm-agent/spec.md` into alignment with the shipped
   `@ai-sdk/openai` + `OPENAI_API_KEY` implementation. Risk R-D.
