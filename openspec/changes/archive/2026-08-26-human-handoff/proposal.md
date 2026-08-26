# Proposal: human-handoff

## Intent

Build the **internal async request/response channel** between the chatbot and a
human agent so the three owner-mandated human-in-the-loop flows
(`docs/conversation-analysis.md` §"Human-in-the-loop requirements") and the
pending `needs_human_review` promotion branch have a real mechanism — not
LLM-phrased prompt text.

Today the bot's response to every unresolvable case is a literal phrase in
`SALE_FLOW_INSTRUCTIONS` ("deriva a un agente humano", "necesito que un agente te
confirme el precio final", "en un momento un agente te comparte los datos de
pago") with **no** durable request, **no** human notification, **no** reply
correlation, and **no** state change. The customer reads a sentence; nobody is
pinged; nothing is recorded. This slice replaces that illusion with a
deterministic tool/state path the model can call, a persistent request table
the bot can resolve against, and a single-channel WhatsApp reply path the
human can use without learning a new tool.

| Flow | Trigger | Owner wording today | What changes |
|---|---|---|---|
| **R7** — out-of-stock restock query | `checkStock.status === 'out_of_stock'` | "deriva a un humano" (no mechanism) | bot now sends the human a real digest with the product, asks restock-or-no, waits, then resumes |
| **`needs_human_review` (promo)** — `evaluateCart.promotionEvaluationStatus` | backend's coarse rule (`PROGRAM-CONTEXT.md` §4.4.3) | "necesito que un agente te confirme el precio final" (no mechanism) | bot now sends the human a real digest with the cart + applied/skipped promos, waits for a quote, then resumes |
| **R14** — expiration dates | no tool covers it; falls to refusal | "esa función aún no está disponible" (refusal) | bot no longer refuses: it calls `requestHumanAssistance` instead and tells the customer the case is under human review |
| **R6** — shipping-quote approval gate | not yet in code (deferred to shipping slice) | n/a | **DEFERRED** — foundation is designed so R6 drops in later without restructuring |

This is the first slice of a planned `human-handoff` capability; the shipping
slice (R2–R5 + R6) plugs into the same channel by rendering a richer digest
(Skydropx/Envíos Perros quotes + Amazon check) instead of the cart/promo/expiry
digests this slice ships.

### Relationship to existing capabilities

- **MODIFIED `conversation`** (`openspec/specs/conversation-store/spec.md`):
  `ConversationStateData` gains the typed optional field
  `pendingHumanRequest: { requestId: string; ref: string; createdAt: string;
  customerNotifiedAt: string } | null`. A sibling of `cart` and `placedSaleId`
  in the open `data` bag — same UPSERT path, no new module-owned storage.
- **MODIFIED `llm-agent`** (`openspec/specs/llm-agent/spec.md`): `AgentRunner`
  short-circuits while `pendingHumanRequest` is set on the **read** path
  (customer-facing branch — short reply, no LLM turn) and a new ops-reply
  routing seam routes agent-side inbounds to the handoff resolver **before**
  `AgentRunner` runs (so the human's reply is never fed to the customer's LLM
  turn). The pending marker MUST survive `LLM_IDLE_TIMEOUT_MS` reset (today's
  idle check wipes `messages` in memory; the marker is in `data` and is
  exempt from the wipe).
- **MODIFIED `sale-flow-tools`** (`openspec/specs/sale-flow-tools/spec.md`):
  `RealToolRegistry` grows from 11 to 12 with `requestHumanAssistance` (the
  only NEW tool in this slice; it is the one entry point that the existing
  three branches — `checkStock`, `evaluateCart`, the refusal case for R14 —
  call into). `SALE_FLOW_INSTRUCTIONS` gains one new instruction step plus
  minor edits to the three trigger steps.
- **MODIFIED `whatsapp-webhook`** (`openspec/specs/whatsapp-webhook/spec.md`):
  `WebhookDispatcherService` distinguishes customer-side from ops-side
  inbounds by the recipient phone number (compared against `OPS_CHANNEL_PHONE`)
  and routes ops-side inbounds to `HumanHandoffService.resolveReply(...)`
  before `AgentRunner`. The receiving-phone capture may require a small DTO
  extension on `value.metadata.phone_number_id` (the explore audit flagged
  this as the cleanest correlation option that survives multiple concurrent
  pending requests; see §"Correlation options").
- **NEW `human-handoff` capability** (`openspec/specs/human-handoff/spec.md`):
  port `HumanHandoffStore` + service `HumanHandoffService` + Postgres adapter
  + one `node-pg-migrate` migration for `human_handoff_requests`. The new
  capability owns the table, the digest rendering, the customer-facing
  "under review" message, and the ops-reply parser.

### Authoritative user decisions encoded in this proposal

1. **Internal channel = dedicated ops WhatsApp number.** `OPS_CHANNEL_PHONE`
   env var holds the human agent's wa_id; the bot sends digests there and the
   human replies on that same thread. Reuses the existing text-only sender;
   no groups, no dashboard, no backend endpoint. Dev/test mode: the agent's
   phone is one of the 5 verified recipients on the Meta test number (and
   passes the Mexican trunk-`1` normalization in `normalizeSandboxRecipient()`).
2. **Meta 24h service-window strategy = NO templates.** The human agent opens
   the service window by sending the bot a short ops-on message at the start
   of their shift (free service window, lasts 24h). Digests inside that
   window are free; the cost/UX is documented in
   `docs/operations-human-handoff.md` (new) and the operator's runbook.
3. **Timeout policy = wait indefinitely.** After sending the digest, the bot
   sends the customer a one-shot "tu caso está en revisión con un agente, te
   avisamos en cuanto tengamos respuesta" notice and then **waits** for the
   human's reply. No scheduler, no nudges, no expiry. The next customer
   inbound is held to a "still waiting" reply until the human replies. When
   the human replies, the bot resumes the original flow with the resolution.
4. **Slice scope = foundation + R7 + `needs_human_review` + R14.** R6 (shipping
   approval) is **DEFERRED** to the future shipping slice. The foundation is
   shaped so R6 plugs in by adding a 13th tool (or by enriching the digest
   renderer), not by restructuring the channel.

## Business Problem / Customer Value

`docs/conversation-analysis.md` documents a real conversation where the agent
("Andrea") confirmed a sale, requested a transfer receipt, and the customer
sent the receipt next day. There are also the documented edge cases where
Andrea would have paused for a human (out-of-stock, complex promotion, shipping
quote) — those pauses are the owner-mandated human-in-the-loop paths. Today
those paths are prompt text only: the customer reads "un agente te confirma" and
nothing happens, no one is paged, no record exists. The owner has explicitly
demanded (1) "the bot must *message* a human with a digest" and (2) for
out-of-stock "is a restock arriving soon, or do I tell them it's unavailable?".

This slice delivers the channel that makes those mandates operational:

- **Customer value**: a customer asking about an out-of-stock product gets a
  real answer (restock ETA or "lo siento, no hay") instead of a freeze.
- **Operational value**: the agent receives a structured digest with
  everything needed to reply (customer id, product, applied promos) instead of
  context-switching back to the chat transcript.
- **Trust value**: the "under review" notice is sent once and held until
  resolution; the customer isn't left guessing whether the bot forgot them.

## Scope

### In Scope

- **New `human-handoff` module** (`src/human-handoff/`):
  - `domain/human-handoff.types.ts` — `HumanHandoffRequest`, `HumanHandoffKind`
    union (`'out_of_stock' | 'needs_human_review' | 'expiration_date'`), and the
    `HumanHandoffDigest` payload type (per-kind).
  - `domain/human-handoff-store.port.ts` — port with `create(input): Promise<HumanHandoffRequest>`,
    `findByRef(ref): Promise<HumanHandoffRequest | null>`, `findLatestPendingForAgent(agentId): Promise<HumanHandoffRequest | null>`,
    `resolve(requestId, resolution): Promise<HumanHandoffRequest>`.
  - `application/human-handoff.service.ts` — orchestrates: `create` writes the
    row + renders the digest + sends it to `OPS_CHANNEL_PHONE` + notifies the
    customer; `resolveReply(text, from)` parses the ref token, resolves the
    row, persists the resolution, and returns a "now apply this" payload for
    the dispatcher to inject into the customer's resumed turn.
  - `infrastructure/postgres-human-handoff.store.ts` — `node-pg-migrate`
    migration `1900_human_handoff_requests.{ts,sql}` creating the table +
    `(status, created_at)` index; raw-`pg` adapter mirroring
    `PostgresConversationStore`.
- **`requestHumanAssistance` AI-SDK tool (12th)**
  (`src/sale-flow/application/tools/request-human-assistance.tool.ts`):
  - `inputSchema: z.object({ kind: z.enum(['out_of_stock', 'needs_human_review',
    'expiration_date']), digest: z.object({ ...per-kind fields... }) })`.
  - `execute` calls `humanHandoffService.create({ senderId, kind, digest })`
    and returns `{ ok: true, requestId, ref, customerNotified: true }` —
    the tool is the **only** way the model creates a request.
- **Tool integrations (the three triggers)**:
  - `check-stock.tool.ts` — when the response's `stock.status ===
    'out_of_stock'`, the tool returns
    `{ ok: true, stock, humanAssistance: { kind: 'out_of_stock', digest:
    { productId, name, variantId?, quantity } } }` instead of a bare stock
    payload, so the model has a structured signal to call
    `requestHumanAssistance`.
  - `evaluate-cart.tool.ts` — when
    `promotionEvaluationStatus === 'needs_human_review'`, the tool returns
    `{ ok: true, evaluation, humanAssistance: { kind: 'needs_human_review',
    digest: { items, originalTotalCents, recomputedTotalCents? } } }`. The
    model still renders the price quote and only escalates if the customer
    wants to proceed (matches the existing "derivar a humano" semantics).
  - R14 (expiration dates) is **prompt-only**: a new instruction in
    `SALE_FLOW_INSTRUCTIONS` tells the model to call
    `requestHumanAssistance({ kind: 'expiration_date', digest: { productId,
    name, question } })` instead of the refusal phrase when the customer asks
    about fechas de caducidad.
- **`ConversationStateData.pendingHumanRequest`**:
  - `readPendingHumanRequest(state): { requestId, ref, createdAt,
    customerNotifiedAt } | null`.
  - `setPendingHumanRequest(store, senderId, state, value)` and
    `clearPendingHumanRequest(store, senderId, state)` helpers.
  - **Exempt from idle reset**: `AgentRunner`'s existing idle-expired branch
    wipes `messages` in memory; `pendingHumanRequest` lives under `data`
    and survives because the helper reads it from the freshly-loaded state
    AFTER the idle check (or equivalently, the idle-reset pass writes the
    new `data` with the marker preserved).
- **`AgentRunner` short-circuit**:
  - When `pendingHumanRequest` is set AND the inbound's senderId matches the
    customer's pending senderId, the runner returns a canned "seguimos
    esperando respuesta del agente, te avisamos en cuanto tengamos"
    response — **no LLM turn**, no cost-guard increment, no transcript write
    (so the pending turn doesn't bloat history).
  - When `pendingHumanRequest` is set AND the inbound is from the ops number,
    the runner path is bypassed entirely (the dispatcher's pre-routing hook
    handles it — see below).
- **`WebhookDispatcherService` ops-reply routing**:
  - Pre-routing hook: if the inbound's receiving number (`metadata.phone_number_id`)
    === the configured ops number, the dispatcher calls
    `humanHandoffService.resolveReply(text, from)` and dispatches the
    resolution as a synthetic customer turn (or, if the agent has multiple
    pending requests, asks the agent to clarify with `HF-<id>`).
  - Ref-token parser: `HF-[A-Za-z0-9_-]{4,32}` (case/whitespace tolerant); the
    full ref is matched anywhere in the inbound text. Fallback (no token):
    newest pending request for the agent (one at a time per the OPS pattern)
    OR the dispatcher asks for the ref.
  - **DTO extension** (one new field): capture `metadata.phone_number_id`
    in `normalizeInboundMessages` so the dispatcher's pre-routing hook has
    the receiving-number data. (If the existing webhook DTO already exposes
    this, the change is wire-only.)
- **Customer-facing "under review" notice** (one-shot, sent on
  `create` success): `Gracias, ya contacté a un agente humano con tu caso. En
  cuanto tenga respuesta te aviso.` (literal, byte-identical). Future inbounds
  from that customer get the canned "seguimos esperando" reply until resolution.
- **Resolution injection**: when the human replies with a structured answer
  (`YES_RESTOCK_IN_X_DAYS`, `NO_RESTOCK`, `APPROVED_PROMO:<cents>`,
  `EXPIRATION:<text>`, or `GENERIC:<text>`), the dispatcher injects a
  synthetic user turn into the customer's transcript so the next LLM turn
  picks it up. The prompt guides the model on phrasing per kind.
- **Config / env**:
  - `OPS_CHANNEL_PHONE` (Joi `.string().required()`) — the human agent's
    wa_id; in dev mode pass through `normalizeSandboxRecipient()` so the
    trunk-`1` is stripped for the Meta test number.
  - `HUMAN_HANDOFF_ENABLED` (Joi `.boolean().default(true)`) — kill-switch
    for behaviour rollback without code revert.
- **Tests** (strict TDD per `openspec/config.yaml` `rules.apply.tdd: true`):
  - `request-human-assistance.tool.spec.ts` — happy path; per-kind digest
    rendering; idempotency (a second `create` for the same sender + same
    pending marker returns the existing ref instead of minting a new one).
  - `human-handoff.service.spec.ts` — `create` writes row + sends digest +
    notifies customer + sets pending marker; `resolveReply` parses ref,
    updates row, clears pending marker, returns resolution payload;
    `resolveReply` with no token falls back to latest-pending.
  - `postgres-human-handoff.store.spec.ts` — UPSERT semantics; round-trip
    resolution; `findByRef` and `findLatestPendingForAgent` queries.
  - `check-stock.tool.spec.ts` and `evaluate-cart.tool.spec.ts` — new
    `humanAssistance` envelope alongside the existing payload; tool does
    NOT itself call `requestHumanAssistance` (the model decides, per ADR-9).
  - `agent-runner.service.spec.ts` — pending marker exempt from idle reset;
    short-circuit reply when `pendingHumanRequest` is set and inbound is
    customer-side.
  - `webhook-dispatcher.service.spec.ts` — ops-side inbound routes to
    `resolveReply`; customer-side inbound with pending marker gets the
    canned reply; resolution is injected as a synthetic user turn.
  - `tool-contract.spec.ts` — `factories` covers all 12 tools.
  - `env.validation.spec.ts` — `OPS_CHANNEL_PHONE` required when
    `HUMAN_HANDOFF_ENABLED=true`; absent or empty → boot fails.
- **NEW docs**: `docs/operations-human-handoff.md` — runbook: "agent sends
  'ops on' at shift start to open the 24h service window", test-number
  recipient cap (5 + 24h token) in dev, ops-phone provisioning checklist,
  Meta 24h-window strategy and the template-cost tradeoff if the operator
  skips the ops-on step.

### Out of Scope (Non-Goals)

- **R6 shipping-quote approval gate.** Deferred to the shipping slice
  (Skydropx/Enviós Perros quotes + Amazon check + $120 credit rule). The
  foundation is shaped so R6 adds a 13th tool (`requestShippingApproval`) or
  reuses `requestHumanAssistance` with a richer digest — no restructuring.
- **WhatsApp groups as the internal channel.** `recipient_type: 'group'` is
  not implemented in `MetaWhatsappSender` today and would require
  member-identity parsing; deferred to a future slice.
- **Media forwarding to ops.** Image attachments in the ops thread are out of
  scope; digests are text-only. Receipts stay with the customer for now (the
  backend's `attachReceipt` flow is unaffected).
- **Scheduler / nudges / expiry.** No cron, no `setTimeout`, no expiry on the
  pending request. Per the owner decision: bot waits indefinitely; the next
  customer inbound gets the canned "seguimos esperando" reply; only the human's
  reply on the ops thread unblocks the customer.
- **Dashboard / HTTP admin channel.** No new backend endpoints, no admin UI.
  The WhatsApp ops thread is the only channel in this slice.
- **Image recognition** (R1), **delivery zones** (R5), **card payment / Link
  EVO** (R16), **chatbot-api changes**. All carry-over follow-ups.
- **`AgentRunner` historical transcript replay.** When a customer's transcript
  is idle-wiped, the pending marker survives but the conversation context does
  not. On resolution, the dispatcher injects a fresh user turn summarizing
  the resolution; the model proceeds with the new context (matches today's
  cart-survives-idle behavior per archived `sale-flow` archive-report R-E).
- **Echo-filter / dedup changes.** The existing `RECENT_OUTBOUND` echo filter
  and `WEBHOOK_DEDUP` Postgres dedup already cover the ops-reply wamid; no
  change needed.
- **`ChatbotApiClient` changes.** No new endpoint, no DTO change, no scope
  change. The pending marker lives entirely in the chatbot's local Postgres.

## Current-State Gap

- **No mechanism behind the prompt phrases.** `SALE_FLOW_INSTRUCTIONS` step
  11 (promo) and the R14 refusal phrase in the system prompt produce literal
  Spanish sentences with no side effects. No row is written, no message is
  sent, no human is paged.
- **`ConversationState.data` has no `pendingHumanRequest` field.** The open
  bag permits it, but nothing reads or writes it today.
- **`check-stock` and `evaluate-cart` returns have no `humanAssistance`
  envelope.** A model that wants to escalate has nothing structured to react
  to; it would have to invent the message text from the underlying payload.
- **`WebhookDispatcherService` cannot distinguish inbound recipient.** Today's
  `normalizeInboundMessages` captures `message.from` and `message.text.body`
  only; routing by "which Meta business number received this message" requires
  capturing `value.metadata.phone_number_id`.
- **No `human_handoff_requests` table.** There is no indexed lookup surface;
  the jsonb bag in `conversation_state` cannot be cheaply queried by `ref` or
  by `(status, created_at)`.
- **`AgentRunner` short-circuits only on idle.** The agent has no notion of
  "we're already escalated, don't re-run the LLM".
- **No ops-channel config.** The bot has no env var or recipient identity
  reserved for the human agent.

## Capabilities

### Modified Capabilities

- **`conversation-store`** — typed `pendingHumanRequest` field + helpers;
  idle-reset exemption (the marker is preserved by the UPSERT write that the
  idle-reset path already performs when `lastMessageAt` is touched).
- **`llm-agent`** — short-circuit reply when pending marker is set
  (customer-side inbound) + pre-routing hook for ops-side inbound. Pending
  marker survives the existing `LLM_IDLE_TIMEOUT_MS` reset.
- **`sale-flow-tools`** — `RealToolRegistry` grows from 11 to 12 tools
  (`requestHumanAssistance`); `check-stock` and `evaluate-cart` returns gain
  a `humanAssistance` envelope; `SALE_FLOW_INSTRUCTIONS` gains one new step
  + minor edits to the three trigger steps. Refusal phrase `esa función aún
  no está disponible` is preserved verbatim (still applies to features we
  never plan to tool, e.g. shipping zones). The cancel step 14 and the
  `getPaymentDetails` step 12 are unchanged.
- **`whatsapp-webhook`** — dispatcher pre-routing hook + DTO extension for
  `metadata.phone_number_id` + canned "seguimos esperando" reply path.
- **`app-config`** — two new Joi fields (`OPS_CHANNEL_PHONE`,
  `HUMAN_HANDOFF_ENABLED`).

### New Capabilities

- **`human-handoff`** — port + Postgres adapter + service + `1900_…`
  migration + the 12th tool. Owns the request lifecycle end-to-end.

### Unchanged Capabilities

- **`chatbot-api-client`** — no new method, no new DTO, no scope change.
  Backend code is read-only.
- **`whatsapp-sender`** — text-only outbound is sufficient. The existing
  `MetaWhatsappSender.sendText({ to, text })` is reused (the ops recipient is
  passed as `to`).
- **`whatsapp-webhook`** echo filter / dedup / signature guard — unchanged.

## Approach

**Architecture follow-through**: the screaming-layout NestJS modules from
`sale-flow` apply. The new `human-handoff` module lands under
`src/human-handoff/{domain, application, infrastructure}/`. The
`requestHumanAssistance` tool lives in `src/sale-flow/application/tools/`
alongside the other 11 (consistent with the registry-owned-by-sale-flow
pattern); `HumanHandoffService` is injected into `ToolDeps` and
`WebhookDispatcherService`.

**Correlation strategy = HF-<id> token + receiving-number filter.** The bot
embeds a short `HF-<id>` token in the digest. The human replies including
that token. The dispatcher pre-routing hook captures the receiving-number
(`value.metadata.phone_number_id`) so it knows the inbound is ops-side; the
resolver parses the token. Fallback (no token): newest pending request for
the agent (one at a time per the OPS pattern) OR the dispatcher replies
asking for the ref. This combines option 1 and option 3 from the explore
audit's §"Correlation options" — token-based correlation for robustness,
receiving-number routing for unambiguous "this is the agent" classification.

**State lifecycle**: the pending marker is set by `requestHumanAssistance`
success, read by `AgentRunner` (short-circuit) and `WebhookDispatcherService`
(pre-routing), and cleared by `HumanHandoffService.resolveReply` on success.
The marker survives the `LLM_IDLE_TIMEOUT_MS` reset because the idle-reset
path's existing `ConversationStore.update` carries `data` as a whole and the
helper preserves the marker in the patched `data`.

**Echo / dedup interplay**: the existing `RECENT_OUTBOUND` echo filter (exact
wamid match) already prevents the bot's own digest send from looping back
through the webhook. The agent's replies flow through the same webhook, get
signature-verified, deduped, and **then** routed by the pre-routing hook
before reaching `AgentRunner`. The agent's reply is never fed to the
customer's LLM turn — it is fed to `HumanHandoffService.resolveReply`.

**Tool pattern**: `makeRequestHumanAssistanceTool(deps)` follows the existing
factory shape. The tool is idempotent in one specific sense: a second call
for the same sender while a `pendingHumanRequest` is set returns the
existing `ref` (no duplicate digests, no duplicate customer notices).

**Strict TDD**: failing test first (red), minimal impl (green), refactor.
Commands: `pnpm test`, `pnpm test:cov`, `pnpm test:e2e`. Coverage
threshold 80%. Scoped lint:
`pnpm exec eslint src/human-handoff src/sale-flow src/llm-agent src/whatsapp`.

## Affected Areas

| Area | Impact |
|------|--------|
| `src/human-handoff/**` | **New** module: domain types + port + service + Postgres adapter + migration |
| `migrations/1900_human_handoff_requests.{ts,sql}` | **New** migration: `human_handoff_requests` table + `(status, created_at)` index |
| `src/sale-flow/application/tools/request-human-assistance.tool.ts` + `.spec.ts` | **New** 12th tool |
| `src/sale-flow/application/tools/check-stock.tool.ts` + `.spec.ts` | **Modified**: returns `humanAssistance` envelope on `out_of_stock` |
| `src/sale-flow/application/tools/evaluate-cart.tool.ts` + `.spec.ts` | **Modified**: returns `humanAssistance` envelope on `needs_human_review` |
| `src/sale-flow/application/tool-deps.ts` | **Modified**: add `HumanHandoffService` to `ToolDeps` |
| `src/sale-flow/infrastructure/real-tool-registry.ts` + `.spec.ts` | **Modified**: register the 12th tool; docstring 11 → 12 |
| `src/sale-flow/application/tools/tool-contract.spec.ts` | **Modified**: `factories` covers all 12 |
| `src/sale-flow/domain/sale-flow-instructions.ts` + `.spec.ts` | **Modified**: new step for `requestHumanAssistance` + edits to steps 5 (R7), 11 (`needs_human_review`), and a new R14 step (prompt-only) |
| `src/conversation/domain/conversation-store.ts` | **Modified**: typed optional `pendingHumanRequest` + helpers (`readPendingHumanRequest`, `setPendingHumanRequest`, `clearPendingHumanRequest`) |
| `src/conversation/infrastructure/postgres-conversation.store.ts` | **Modified**: pending marker preserved through UPSERT (covered by existing shallow-merge semantics; spec asserts the exemption) |
| `src/llm-agent/application/agent-runner.service.ts` + `.spec.ts` | **Modified**: pre-LLM short-circuit when pending marker is set; pending marker exempt from idle-reset (UPSERT preserves it) |
| `src/whatsapp/application/webhook-dispatcher.service.ts` + `.spec.ts` | **Modified**: capture receiving number; pre-routing hook for ops-side inbound; synthetic user turn on resolution |
| `src/whatsapp/infrastructure/normalize-inbound-messages.ts` | **Modified**: capture `value.metadata.phone_number_id` |
| `src/whatsapp/presentation/dto/webhook-event.dto.ts` | **Modified**: pass through `metadata.phone_number_id` if not already exposed |
| `src/config/env.validation.ts` + `.spec.ts` | **Modified**: add `OPS_CHANNEL_PHONE` (required when `HUMAN_HANDOFF_ENABLED=true`) and `HUMAN_HANDOFF_ENABLED` (default `true`) |
| `src/config/configuration.ts` | **Modified**: surface `humanHandoff` block |
| `src/app.module.ts` | **Modified**: register `HumanHandoffModule` |
| `docs/operations-human-handoff.md` | **New**: ops runbook (shift-start ops-on message, test-number 5-recipient cap, ops-phone provisioning checklist, Meta 24h strategy) |
| `openspec/specs/human-handoff/spec.md` (new) | **New**: lifecycle, correlation, resolve, idle exemption, ops-routing scenarios |
| `openspec/specs/conversation-store/spec.md` (delta) | **Modified**: `pendingHumanRequest` field + idle-exemption scenarios |
| `openspec/specs/llm-agent/spec.md` (delta) | **Modified**: short-circuit + ops-routing + idle-exemption scenarios |
| `openspec/specs/sale-flow-tools/spec.md` (delta) | **Modified**: 12 tools + new step + envelope additions |
| `openspec/specs/whatsapp-webhook/spec.md` (delta) | **Modified**: DTO + routing hook + canned reply + synthetic turn scenarios |
| `openspec/specs/app-config/spec.md` (delta) | **Modified**: new env vars + Joi scenarios |

## Requirements

Numbered, testable, RFC 2119.

1. **`OPS_CHANNEL_PHONE` is required when `HUMAN_HANDOFF_ENABLED=true`.** The
   Joi pipeline MUST reject boot when the variable is absent, empty, or not
   a string of digits (with optional `+` prefix). When
   `HUMAN_HANDOFF_ENABLED=false`, the variable is optional and the
   `HumanHandoffModule` MUST short-circuit its `create` method with a
   not-enabled error.
2. **`human_handoff_requests` table is created by migration `1900_…`** with
   columns `id text PK`, `customer_id text NOT NULL`, `agent_id text`,
   `kind text NOT NULL`, `digest jsonb NOT NULL`, `status text NOT NULL
   DEFAULT 'pending'`, `resolution jsonb`, `created_at timestamptz NOT NULL
   DEFAULT now()`, `resolved_at timestamptz`, plus index `(status,
   created_at)` for `findLatestPendingForAgent`.
3. **`requestHumanAssistance` is the 12th tool.** Its `inputSchema` accepts
   `{ kind, digest }`. The tool returns
   `{ ok: true, requestId, ref, customerNotified: true }` on success and
   `{ ok: false, error: { kind, retryable } }` from the discriminated
   mapping on failure. Idempotent for repeat calls within the same
   pending session.
4. **The customer-facing "under review" notice is sent once on `create`
   success** with the byte-identical text
   `Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.`.
5. **`pendingHumanRequest` survives `LLM_IDLE_TIMEOUT_MS`.** Spec scenario
   asserts the marker is read AFTER the idle check and is preserved by the
   UPSERT write that the runner performs on every handled inbound.
6. **AgentRunner short-circuits when pending marker is set** AND the inbound
   senderId matches the customer's pending senderId: returns the canned
   reply `seguimos esperando respuesta del agente, te avisamos en cuanto
   tengamos` (byte-identical), NO LLM turn, NO cost-guard increment, NO
   transcript append.
7. **Ops-side inbound routes to `resolveReply` BEFORE `AgentRunner`.** The
   pre-routing hook identifies ops-side via `metadata.phone_number_id` ===
   configured ops number (with the sandbox-trunk-`1` normalization caveat).
8. **`HF-<id>` token is required in the agent's reply.** The
   `resolveReply` parser matches `HF-[A-Za-z0-9_-]{4,32}` case- and
   whitespace-tolerantly anywhere in the inbound text. Fallback: newest
   pending request for the agent (`findLatestPendingForAgent`) when the
   inbound has no token; if zero pending, the dispatcher replies
   asking for the ref (no LLM turn).
9. **Resolution is injected as a synthetic user turn** in the customer's
   `ConversationState.data.messages` (with role `user`, content from the
   resolution payload formatted per kind), so the next LLM turn picks it up
   and proceeds with the new context.
10. **`check-stock` returns `humanAssistance` envelope on `out_of_stock`**
    and `evaluate-cart` returns `humanAssistance` envelope on
    `needs_human_review`. The model decides when to call
    `requestHumanAssistance` (ADR-9: the tool owns the row; the trigger
    tool just signals).
11. **R14 is prompt-only**: a new step in `SALE_FLOW_INSTRUCTIONS` tells the
    model to call `requestHumanAssistance` with `kind: 'expiration_date'`
    instead of the refusal phrase when the customer asks about fechas de
    caducidad.
12. **No scheduler / no proactive sends.** The
    `whatsapp-webhook` "No proactive sends occur" scenario MUST remain
    passing after this slice — the only outbound in the awaiting-human
    branch is the one-shot digest + the one-shot customer notice, both
    inside the inbound-driven flow.
13. **`HUMAN_HANDOFF_ENABLED=false` disables the slice.** Tool returns a
    `disabled` kind; service short-circuits; registry still binds (so a
    flipped env in dev doesn't crash DI). No migration is needed (the
    table is still created — flip-back flips the runtime).
14. **All tests use strict TDD** (red → green → refactor); `pnpm test` +
    `pnpm test:e2e` green; `pnpm build` clean; scoped `pnpm exec eslint`
    passes.

## Risks

| # | Risk | Lik | Impact | Mitigation |
|---|------|-----|--------|-----------|
| R-1 | **Meta 24h service window.** A digest to the agent is business-initiated; outside a 24h service window it fails or needs an approved template. | High | Med | Operational runbook (`docs/operations-human-handoff.md`) documents the "agent sends 'ops on' at shift start" pattern; dev-mode test-number has an additional 5-recipient + 24h-token cap that's flagged in the same doc. Owner accepted the manual step for v1; an approved template is a future slice if ops-on slips. |
| R-2 | **Idle-reset wipes the pending marker.** Today's idle check could overwrite `data` without preserving `pendingHumanRequest`. | Med | High | `AgentRunner`'s idle-reset path already performs an `update` on the idle boundary; the spec scenario asserts the patch includes `pendingHumanRequest: state.data.pendingHumanRequest ?? null`. UPSERT shallow-merges `data`; the helper reads the existing marker BEFORE the write and re-injects it. |
| R-3 | **Agent reply parsing robustness.** The human may typo the token, send "ok" alone, or reply with prose. | Med | Med | Case/whitespace-tolerant regex; fallback to newest-pending when token is absent; if no pending, dispatcher asks for the ref. Spec scenarios cover each branch. |
| R-4 | **No scheduler = passive waiting.** A customer who escalates and goes silent will not be nudged. | Med | Low | Owner-decision explicit (decision 3 in §"Authoritative user decisions"); the canned reply on every subsequent inbound keeps the customer informed. A future slice can add a scheduler if operationally needed. |
| R-5 | **LLM cost on short-circuited paths.** The runner returns a canned reply with NO LLM turn — guard against a regression that routes through the LLM anyway. | Low | Med | Spec scenario asserts `costGuard.record` is NOT called on the short-circuit path and `llm.run` is NOT called. |
| R-6 | **Test-number dev-mode recipient cap.** The Meta test number caps at 5 verified recipients + a 24h token. If the agent's phone isn't in the list, dev sends fail. | Med | Med | `docs/operations-human-handoff.md` runbook lists the cap and the steps to add the agent; the proposal does not require the operator to flip on env changes. |
| R-7 | **`AgentRunner` historical transcript replay.** When the customer's transcript is idle-wiped, the pending marker survives but the conversation context does not. On resolution, the dispatcher injects a synthetic user turn with the resolution; the model proceeds with the new context. This matches the cart-survives-idle pattern (archived `sale-flow` R-E). | Med | Low | The synthetic user turn phrasing carries the kind + resolution so the model can phrase a coherent reply without history; spec scenario documents this. |
| R-8 | **DTO extension on the webhook** (`metadata.phone_number_id`) is a wire change. If Meta sends an envelope that doesn't include `metadata` (older webhook versions), the routing hook falls back to senderId-based heuristic (senderId matches the configured ops wa_id). | Low | Med | Spec scenario asserts the primary path (metadata capture) AND the fallback (senderId match) both work. |
| R-9 | **Change budget ~400-500 lines.** New module + tool + 2 trigger edits + dispatcher hook + DTO + env + tests could exceed the budget. | Med | Med | This slice is foundation + 3 triggers; tests dominate. Split into at most two reviewable commits (Foundation: module + tool + dispatcher; Triggers: tool integrations + prompt step). The dispatcher's pre-routing hook is small enough to land in either. |
| R-10 | **`SALE_FLOW_INSTRUCTIONS` step list grows from 15 to ~16.** A new step plus edits to 3 existing steps. | Low | Low | Spec scenario asserts the byte-identical snapshot still contains the existing strings (`esa función aún no está disponible`, `en un momento un agente te comparte los datos de pago`, `¿Confirmas la cancelación? Sí/No`). |

## Rollback

Two clean paths:

1. **Behaviour rollback** — set `HUMAN_HANDOFF_ENABLED=false` in env and
   restart. `HumanHandoffService.create` short-circuits with `disabled`;
   `requestHumanAssistance` returns `{ ok: false, error: { kind: 'disabled',
   retryable: false } }`; the model falls back to the prompt-phrase text.
   `check-stock` and `evaluate-cart` keep returning the new envelope but
   the model has no tool to call (the tool is registered but inert). The
   table exists and is empty; no data loss. **One env flip, zero code.**
2. **Code rollback** — revert the merge commit. Single-developer branch +
   merge delivery keeps the revert to one commit. The migration's
   `down` removes the table and index; the dispatcher pre-routing hook
   is deleted; `pendingHumanRequest` field is unused (open bag, no
   reader without the tool).

## Dependencies

### Existing (no change)

- `ConversationStore` (`src/conversation/infrastructure/`) — UPSERT
  contract supports the new `pendingHumanRequest` field.
- `AgentRunner` (`src/llm-agent/application/agent-runner.service.ts`) —
  existing idle-reset path's UPSERT is the place where the marker is
  preserved.
- `WhatsappSenderPort` (`src/whatsapp/domain/whatsapp-sender.port.ts`) —
  text-only `sendText({ to, text })` reused for both digest and
  customer notice.
- `WebhookDispatcherService` (`src/whatsapp/application/`) — pre-routing
  hook is a new branch before the existing `AgentRunner` call.
- `node-pg-migrate` — same migration tool used by the existing
  `migrations/1700…`, `migrations/1800…`.
- `ai` (Vercel AI SDK) + `zod` — already in the tree.

### New (package additions, if any)

- None expected. All required primitives are already in the tree.

### External (operational, NOT blocking for code)

- The Meta WhatsApp **ops phone** must be provisioned (test-number or
  real). For dev mode, add it to the 5-recipient allowlist and pass
  through `normalizeSandboxRecipient()`.
- The agent's shift-start "ops on" message must be sent within the 24h
  service window before digests are dispatched. Documented in the
  runbook.
- For production with a real Meta business number: no recipient cap;
  service window still applies unless an approved template is used.

## Success Criteria

- [ ] `HUMAN_HANDOFF_ENABLED` and `OPS_CHANNEL_PHONE` validated at boot;
      missing/empty values reject startup.
- [ ] Migration `1900_human_handoff_requests` runs clean against a fresh
      DB; the table + `(status, created_at)` index exist.
- [ ] `requestHumanAssistance` is the 12th registered tool; `RealToolRegistry`
      exposes exactly 12 keys.
- [ ] `check-stock` and `evaluate-cart` return the `humanAssistance` envelope
      on the trigger conditions; `evaluate-cart`'s `promotionEvaluationStatus
      === 'needs_human_review'` path is the same.
- [ ] The customer-facing "under review" notice is byte-identical to the
      literal in the proposal and is sent exactly once per escalation.
- [ ] `pendingHumanRequest` survives an `LLM_IDLE_TIMEOUT_MS` cycle
      (UPSERT scenario asserts it; manual e2e: idle-wait then resolve).
- [ ] AgentRunner short-circuits on customer-side inbound with the canned
      "seguimos esperando" reply; `costGuard.record` is NOT called.
- [ ] WebhookDispatcherService routes ops-side inbounds to
      `HumanHandoffService.resolveReply` BEFORE `AgentRunner`; the agent's
      reply never reaches the customer's LLM turn.
- [ ] Ref-token parser handles `HF-xxxx` case- and whitespace-tolerantly;
      fallback (no token) returns the newest pending request for the agent.
- [ ] Resolution injection produces a synthetic user turn in
      `ConversationState.data.messages`; the next LLM turn reads it and
      proceeds with the new context.
- [ ] `SALE_FLOW_INSTRUCTIONS` snapshot test includes the new step + the
      three edits; the byte-identical strings (`esa función aún no está
      disponible`, `en un momento un agente te comparte los datos de pago`,
      `¿Confirmas la cancelación? Sí/No`, `Descuento aplicado: $X`,
      `PROMO_RE_QUOTE` rule, `no hay una venta reciente por cancelar`) are
      all still present.
- [ ] `pnpm test` and `pnpm test:e2e` green; `pnpm build` clean; scoped
      `pnpm exec eslint src/human-handoff src/sale-flow src/llm-agent
      src/whatsapp src/config` passes.
- [ ] `docs/operations-human-handoff.md` exists with the runbook
      (shift-start ops-on, test-number cap, ops-phone provisioning,
      Meta 24h strategy + template-cost tradeoff).
- [ ] Five spec files updated: `openspec/specs/human-handoff/spec.md` (new)
      + `conversation-store`, `llm-agent`, `sale-flow-tools`,
      `whatsapp-webhook`, `app-config` deltas. All scenarios Given/When/Then
      with RFC 2119 keywords.
- [ ] Manual smoke test on the Meta test number: customer asks about an
      out-of-stock product → bot sends customer notice + ops digest with
      `HF-xyz` → agent replies "HF-xyz: restock in 3 days" → bot resumes the
      customer's conversation with that answer.

## Open Questions

1. **Receiving-number capture shape.** Whether `value.metadata.phone_number_id`
   is always populated by Meta for the bot's business number is the only
   genuinely unresolved wire detail. If it's missing in some envelopes, the
   fallback is senderId-based (senderId of inbound === configured ops wa_id).
   Spec asserts both paths. **Resolved at design time by reading the Meta
   webhook reference + a real Meta test-number payload.**

## Follow-up Slices (out of scope, tracked here so they are not lost)

1. **R6 shipping-quote approval gate** — `requestShippingApproval` tool or a
   richer digest from `requestHumanAssistance`; plugs into the same channel
   without restructuring. Depends on the future shipping slice (Skydropx /
   Envíos Perros quotes, $120 credit rule, Amazon check, CDMX free-zone list).
2. **Scheduler-based nudge / expiry** — if the indefinite-wait proves
   operationally noisy, add a clock-driven nudge to the customer or an
   expiry on `human_handoff_requests` (no scheduler today).
3. **Group-channel support** — if the owner insists on a WhatsApp group
   instead of a dedicated number: add `recipient_type: 'group'` to the sender
   and member-identity parsing in `normalizeInboundMessages`.
4. **Media forwarding to ops** — forward the customer's product image (R1
   overlap) inside the digest for image-recognition-dependent escalations.
5. **Dashboard / HTTP admin** — a backend endpoint + minimal admin UI for the
   ops queue, replacing the WhatsApp thread. Heavy; revisit only if
   WhatsApp-window limits make the WhatsApp-channel UX too painful.
6. **Approved Meta template** — if the "agent sends ops-on" pattern becomes
   operationally fragile, submit a template so digests can be sent outside
   the 24h window. Cost + review cycle; v2 decision.
