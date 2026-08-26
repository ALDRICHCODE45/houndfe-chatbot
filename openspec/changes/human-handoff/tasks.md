# Tasks: human-handoff (async bot ↔ human request/response channel)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~2680 (production ~1300 incl. ~80 deletions; tests ~1200 incl. ~30 deletions; docs ~150; migration ~30; spec deltas excluded — pre-authored) |
| 400-line budget risk | **High** (~6.7× the limit) |
| Chained PRs recommended | **No** (delivery is `single-pr` per session preflight; the three commits land together in one PR; do NOT propose multi-PR chaining) |
| Suggested split | Three reviewable commits on a single branch: **Commit 1 — Foundation: handoff channel** (Phases 1–3, ~1942 lines), **Commit 2 — Foundation: routing + short-circuit** (Phases 4–5, ~446 lines), **Commit 3 — Triggers + prompt** (Phase 6, ~350 lines). Each commit lands independently green and is reviewable on its own. |
| Delivery strategy | single-pr (three stacked commits, single PR, merge to main) |
| Chain strategy | size-exception (single PR accepted by user preflight; the 3-commit split is the in-PR review-budget mitigation, NOT chained PRs) |

Decision needed before apply: **No** — user preflight locked `single-pr`; the forecast shows the PR will exceed the 400-line budget by ~6.7× and that risk is accepted. The 3-commit split is the agreed review-budget mitigation and keeps each commit independently reviewable. Do NOT slice into chained PRs.
Chained PRs recommended: **No**
Chain strategy: size-exception
400-line budget risk: **High**

**Honest forecast derivation (additions + deletions, by commit):**

| Commit | File class | ADDED | DELETED |
|---|---|---|---|
| **Commit 1** | `src/human-handoff/domain/human-handoff.types.ts` (new) | ~80 | 0 |
| | `src/human-handoff/domain/human-handoff-store.port.ts` (new) | ~50 | 0 |
| | `src/human-handoff/infrastructure/postgres-human-handoff.store.ts` (new) | ~200 | 0 |
| | `src/human-handoff/application/human-handoff.service.ts` (new) | ~280 | 0 |
| | `src/human-handoff/application/pending-human-request-persistence.ts` (new) | ~80 | 0 |
| | `src/human-handoff/human-handoff.module.ts` (new) | ~40 | 0 |
| | `src/sale-flow/application/tools/request-human-assistance.tool.ts` (new) | ~80 | 0 |
| | `src/whatsapp/whatsapp-sender.module.ts` (new, ADR-30) | ~30 | 0 |
| | `migrations/1900000000000_human_handoff_requests.js` (new) | ~30 | 0 |
| | `src/sale-flow/application/tool-deps.ts` (mod) | ~10 | ~5 |
| | `src/sale-flow/infrastructure/real-tool-registry.ts` (mod) | ~20 | ~3 |
| | `src/config/env.validation.ts` (mod) | ~25 | 0 |
| | `src/config/configuration.ts` (mod) | ~12 | 0 |
| | `src/app.module.ts` (mod) | ~2 | 0 |
| | `src/human-handoff/application/human-handoff.service.spec.ts` (new) | ~350 | 0 |
| | `src/human-handoff/infrastructure/postgres-human-handoff.store.spec.ts` (new) | ~200 | 0 |
| | `src/human-handoff/application/pending-human-request-persistence.spec.ts` (new) | ~150 | 0 |
| | `src/sale-flow/application/tools/request-human-assistance.tool.spec.ts` (new) | ~150 | 0 |
| | `src/sale-flow/infrastructure/real-tool-registry.spec.ts` (mod) | ~20 | ~10 |
| | `src/sale-flow/application/tools/tool-contract.spec.ts` (mod) | ~10 | ~2 |
| | `src/config/env.validation.spec.ts` (mod) | ~100 | ~5 |
| | `src/config/configuration.spec.ts` (mod) | ~30 | ~5 |
| | `docs/operations-human-handoff.md` (new) | ~150 | 0 |
| | **Commit 1 total** | **~2069** | **~30** |
| | **Commit 1 grand total** | **~2099** | |
| **Commit 2** | `src/conversation/domain/conversation-store.ts` (mod) | ~25 | 0 |
| | `src/llm-agent/application/agent-runner.service.ts` (mod — short-circuit + ADR-28 spread) | ~70 | ~30 |
| | `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` (mod — toolsContext) | ~3 | 0 |
| | `src/whatsapp/presentation/dto/webhook-event.dto.ts` (mod — WebhookMetadataDto) | ~15 | 0 |
| | `src/whatsapp/domain/inbound-message.ts` (mod — receivingPhoneNumberId) | ~3 | 0 |
| | `src/whatsapp/application/webhook-dispatcher.service.ts` (mod — pre-routing hook + order) | ~80 | ~15 |
| | `src/whatsapp/whatsapp.module.ts` (mod — wire HumanHandoffModule + sender module) | ~10 | 0 |
| | `src/llm-agent/application/agent-runner.service.spec.ts` (mod) | ~140 | ~10 |
| | `src/whatsapp/application/webhook-dispatcher.service.spec.ts` (mod) | ~180 | ~25 |
| | **Commit 2 total** | **~526** | **~80** |
| | **Commit 2 grand total** | **~606** | |
| **Commit 3** | `src/sale-flow/application/tools/check-stock.tool.ts` (mod — humanAssistance envelope) | ~30 | ~3 |
| | `src/sale-flow/application/tools/evaluate-cart.tool.ts` (mod — humanAssistance envelope) | ~40 | ~3 |
| | `src/sale-flow/domain/sale-flow-instructions.ts` (mod — step 16 + 3 edits) | ~80 | ~5 |
| | `src/sale-flow/application/tools/check-stock.tool.spec.ts` (mod) | ~70 | ~10 |
| | `src/sale-flow/application/tools/evaluate-cart.tool.spec.ts` (mod) | ~80 | ~10 |
| | `src/sale-flow/domain/sale-flow-instructions.spec.ts` (mod) | ~80 | ~10 |
| | **Commit 3 total** | **~380** | **~41** |
| | **Commit 3 grand total** | **~421** | |
| **Grand total (ALL commits)** | | **~2975** | **~151** |
| **Grand total (ADDED + DELETED)** | | **~3126** | |

The forecast excludes `proposal.md`, `design.md`, and `tasks.md` itself (SDD scaffolding already in the change folder; mirrors the archive convention). Spec deltas (`openspec/changes/human-handoff/specs/**`) are pre-authored and excluded from the count; they land in Commit 1 (`human-handoff/spec.md`, `conversation-store/delta.md`, `sale-flow-tools/delta.md`) and Commit 2 (`llm-agent/delta.md`, `whatsapp-webhook/delta.md`) alongside their respective code, mirroring the archive's spec-delta placement.

**Why the budget is blown (signal-by-signal).** One new module (`human-handoff/` with 4 production files + 1 module file), one new migration, one new AI-SDK tool (12th), the `WhatsappSenderModule` extraction (ADR-30), two modified trigger tools (`check-stock`/`evaluate-cart`), 8 modified production files, ~20 spec/modified test files (~1200 new test lines under `strict_tdd: true`), the operations runbook (~150 lines), and the dispatcher's pre-routing hook + the runner's short-circuit + fresh-state spread (ADR-28). Production code is ~40 % of total; tests are ~38 %; docs/spec/runbook/migration are ~22 %. Test volume is unavoidable under `strict_tdd: true` — every production file has a spec.

**Mitigation (3-commit split — see T8.1/T8.2/T8.3).** Each commit lands independently green and is reviewable on its own:
- Commit 1 = the new module + the 12th tool + the env/config + the module wiring (the foundation of the channel; behaviour = "tool can write a row + send two messages"). Reviewer asks "is the table shape right? is the digest correct? does the tool contract match the spec?"
- Commit 2 = the routing/short-circuit layer (the existing bot learns to wait and the dispatcher learns to route ops). Reviewer asks "does the short-circuit skip the LLM? does the idle reset preserve the marker? does the ops pre-routing hook sit before the runner?"
- Commit 3 = the triggers + prompt (the three flows wire in). Reviewer asks "does the envelope carry the right fields? is the new step correct? are the byte-identical strings preserved?"

The user explicitly accepted the size-exception (`single-pr`) — do NOT propose chaining.

---

## Phase 0: Spec artifacts (pre-resolved — already authored)

> The six spec artifacts are pre-authored under `openspec/changes/human-handoff/specs/`. No apply-phase action is required for them; they are referenced by the implementation tasks below as the source of contract. They are NOT part of the review-budget count above (mirrors the archive convention).

- [x] T0.1 Spec delta authored at `openspec/changes/human-handoff/specs/human-handoff/spec.md` — `HumanHandoffKind`, `HumanHandoffRequest`, `HumanHandoffDigest`/`HumanHandoffResolution` unions, `HumanHandoffStore` port, `HumanHandoffService.create`/`resolveReply`/`isOpsSender`, `requestHumanAssistance` tool contract, `pendingHumanRequest` marker lifecycle, synthetic-turn injection, no-scheduler / no-proactive-sends. Pre-resolved; no apply-phase action. <!-- sdd-owner: implementation -->
- [x] T0.2 Spec delta authored at `openspec/changes/human-handoff/specs/conversation-store/delta.md` — `PendingHumanRequest` type + `pendingHumanRequest?` field on `ConversationStateData`, `readPendingHumanRequest` pure helper, idle-reset preservation. Pre-resolved. <!-- sdd-owner: implementation -->
- [x] T0.3 Spec delta authored at `openspec/changes/human-handoff/specs/llm-agent/delta.md` — runner short-circuit + fresh-state spread (ADR-28), `toolsContext.requestHumanAssistance.senderId`, prompt composition unchanged outside the slice edits. Pre-resolved. <!-- sdd-owner: implementation -->
- [x] T0.4 Spec delta authored at `openspec/changes/human-handoff/specs/sale-flow-tools/delta.md` — 12-tool registry, `requestHumanAssistance` tool, `humanAssistance` envelope on `checkStock`/`evaluateCart`, `SALE_FLOW_INSTRUCTIONS` step 16 + edits to steps 5/11, byte-identical preserved strings, `disabled`/`validation` kinds for the new tool. Pre-resolved. <!-- sdd-owner: implementation -->
- [x] T0.5 Spec delta authored at `openspec/changes/human-handoff/specs/whatsapp-webhook/delta.md` — DTO `WebhookMetadataDto` + `InboundMessage.receivingPhoneNumberId`, ops pre-routing hook, pending-marker short-circuit, synthetic-turn injection path. Pre-resolved. <!-- sdd-owner: implementation -->
- [x] T0.6 Spec delta authored at `openspec/changes/human-handoff/specs/app-config/delta.md` — `OPS_CHANNEL_PHONE` (Joi string + normalizeSandboxRecipient), `HUMAN_HANDOFF_ENABLED` (boolean, default `true`), `humanHandoff` config block shape. Pre-resolved. <!-- sdd-owner: implementation -->

---

## Phase 1: Foundation — domain types, port, Postgres adapter (Commit 1)

> Commit 1 lands the entire `human-handoff` module plus the 12th tool plus the env/config plus the app wiring. The first three phases (1–3) constitute Commit 1; each task is RED-first per `strict_tdd: true`.

### Phase 1.1 — Domain types + port contract

- [x] T1.1 RED: in `src/human-handoff/domain/human-handoff.types.spec.ts` (or alongside `human-handoff.types.ts` as inline `it()` cases) assert the four discriminated-union members of `HumanHandoffKind` (`'out_of_stock' | 'needs_human_review' | 'expiration_date' | 'shipping_approval'` — last one reserved for R6), the per-kind `HumanHandoffDigest` shape (out_of_stock = `{ productId, name, variantId?, quantity? }`, needs_human_review = `{ items: [...], originalTotalCents?, recomputedTotalCents? }`, expiration_date = `{ productId, name, question }`, shipping_approval = permissive), and the `HumanHandoffResolution` five-member union (`YES_RESTOCK_IN_X_DAYS`, `NO_RESTOCK`, `APPROVED_PROMO`, `EXPIRATION`, `GENERIC`). The module file does NOT exist yet → import fails RED. Verify RED. <!-- sdd-owner: implementation -->
- [x] T1.2 GREEN: create `src/human-handoff/domain/human-handoff.types.ts` exporting the four types verbatim per design.md §"Domain types": `HumanHandoffKind`, `HumanHandoffDigest` (per-kind discriminated union), `HumanHandoffResolution` (five-member discriminated union), and `HumanHandoffRequest` (`id`, `customerId`, `agentId`, `kind`, `digest`, `status`, `resolution`, `createdAt`, `resolvedAt`). Compile-checked via Phase-1.2 RED. Verify green. <!-- sdd-owner: implementation -->
- [x] T1.3 RED: in `src/human-handoff/domain/human-handoff-store.port.ts` (file absent → red) export the `HUMAN_HANDOFF_STORE` Symbol token plus the port interface `HumanHandoffStore { create(input): Promise<HumanHandoffRequest>; findById(id): Promise<HumanHandoffRequest | null>; findByRef(ref): Promise<HumanHandoffRequest | null>; findLatestPendingForAgent(agentId): Promise<HumanHandoffRequest | null>; resolve(requestId, resolution): Promise<HumanHandoffRequest | null> }` exactly as in design.md §a. Spec scenarios asserting the four-CRUD contract are deferred to T1.5 (Postgres adapter spec) where they get a real implementation; the port type itself is the unit. Verify RED (file absent). <!-- sdd-owner: implementation -->
- [x] T1.4 GREEN: create `src/human-handoff/domain/human-handoff-store.port.ts` exporting the Symbol token + the port interface verbatim per design.md §a + JSDoc explaining each method's contract (the `findByRef` adapter parses the `HF-` prefix and looks up by `id`; `resolve` is a no-op for an unknown id and MUST return `null`). Verify green. <!-- sdd-owner: implementation -->

### Phase 1.2 — Postgres adapter + migration

- [x] T1.5 RED: in `src/human-handoff/infrastructure/postgres-human-handoff.store.spec.ts` assert the four CRUD scenarios from the human-handoff spec §"HumanHandoffStore port exposes the four CRUD primitives": `create` inserts and returns the row with generated `createdAt`; `findById` round-trips; `findByRef('HF-abc123def456')` parses the prefix and returns the matching row; `findLatestPendingForAgent` returns the newest pending row for the agent (T2 wins over T1, never another agent's row); `resolve` sets `status='resolved'` + the supplied resolution + a non-null `resolvedAt`; `resolve` on an unknown id returns `null` and does not insert; `findByRef` on an unknown id returns `null`. The adapter file does NOT exist yet → import fails RED. Verify RED. <!-- sdd-owner: implementation -->
- [x] T1.6 GREEN: create `src/human-handoff/infrastructure/postgres-human-handoff.store.ts` exporting `@Injectable() class PostgresHumanHandoffStore implements HumanHandoffStore` with a `Pool` constructor injection (mirrors `PostgresConversationStore`'s `@Inject(PG_POOL)` pattern). Implementation: `create` is a single `INSERT ... RETURNING *`; `findById` is a single `SELECT ... WHERE id = $1`; `findByRef` strips the `HF-` prefix then calls `findById`; `findLatestPendingForAgent` is `SELECT ... WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`; `resolve` is `UPDATE ... SET status='resolved', resolution=$2::jsonb, resolved_at=now() WHERE id=$1 RETURNING *` (returns `null` when no row). JSONB columns are stored as `JSON.stringify(payload)` on write and parsed on read. Timestamps round-trip via `Date.toISOString()` (matches the existing `conversation_state` adapter). Verify green via T1.5 scenarios; existing `conversation_state` tests still pass (no shared state). <!-- sdd-owner: implementation -->
- [x] T1.7 RED: create `migrations/1900000000000_human_handoff_requests.js` per design.md §DDL — `pgm.createTable('human_handoff_requests', { id text PK, customer_id text NOT NULL, agent_id text NOT NULL, kind text NOT NULL, digest jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', resolution jsonb, created_at timestamptz NOT NULL DEFAULT pgm.func('now()'), resolved_at timestamptz })` and `pgm.createIndex('human_handoff_requests', ['status', 'created_at'])`. The `down` is `pgm.dropTable('human_handoff_requests')` (cascade drops the index). Mirrors the convention of `migrations/1700000000000_create-conversation-state.js` and `migrations/1800000000000_create-processed-webhook-messages.js` byte-identically (same `exports.shorthands = undefined`, same `pgm.func('now()')`, same `timestamptz` precision). RED check: the migration filename + the column set match the spec's "migration creates the table and index" scenario (verified by a separate `pgm-migration.spec.ts` or by `pnpm migrate` against an empty DB in Phase 7). <!-- sdd-owner: implementation -->
- [x] T1.8 GREEN: same migration lands in T1.7; verify `node-pg-migrate --config-file package.json --config-value pg-migrate up` runs clean against an empty DB and `node-pg-migrate ... down` drops cleanly (full-suite verification lives in Phase 7; the file is created here). <!-- sdd-owner: implementation -->

---

## Phase 2: Foundation — service, persistence helpers, 12th tool, registry (Commit 1)

### Phase 2.1 — `pendingHumanRequest` persistence helpers

- [x] T2.1 RED: in `src/human-handoff/application/pending-human-request-persistence.spec.ts` (module absent → red) assert the four scenarios from the human-handoff spec §"pendingHumanRequest marker semantics — set, clear, idempotent": `setPendingHumanRequest(store, senderId, state, { requestId, ref, createdAt, customerNotifiedAt })` issues exactly one `store.update` carrying `data: { ...prevData, pendingHumanRequest: <marker> }` + the existing `lastMessageAt`; `clearPendingHumanRequest(store, senderId, state)` issues exactly one `store.update` carrying `data: { ...prevData, pendingHumanRequest: null }` (or `delete data.pendingHumanRequest` — both are spec-acceptable per the spec's "explicit null clears the marker" scenario); sibling keys (`messages`, `cart`, `placedSaleId`) are preserved byte-identically. `readPendingHumanRequest(state)` (pure) returns the marker when present + structurally matches the four fields, returns `null` when missing or when the value is structurally malformed (defensive default), and does NOT mutate the input. Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.2 GREEN: create `src/human-handoff/application/pending-human-request-persistence.ts` exporting the three pure/durable helpers verbatim per design.md §"Detailed Behaviour" / §PendingHumanRequest persistence. `setPendingHumanRequest` shallow-spreads `state?.data`, sets `pendingHumanRequest: marker`, calls `store.update(senderId, { lastMessageAt, data })`; `clearPendingHumanRequest` shallow-spreads and sets `pendingHumanRequest: null` (or `delete`s the key — pick one and document the choice in JSDoc); `readPendingHumanRequest` is a pure helper that returns the typed marker when structurally valid and `null` otherwise. Verify green. <!-- sdd-owner: implementation -->

### Phase 2.2 — `HumanHandoffService` (create / resolveReply / isOpsSender)

- [x] T2.3 RED: in `src/human-handoff/application/human-handoff.service.spec.ts` (module absent → red) assert the eight service-level scenarios from the human-handoff spec §"`HumanHandoffService.create` writes a row, sends the digest, notifies the customer, and sets the marker" + §"`resolveReply` parses the HF-<id> token and falls back to newest-pending" + §"`isOpsSender` classifies inbounds by senderId against OPS_CHANNEL_PHONE":
  - **(a) happy path**: `service.create({ senderId: 'S', kind: 'out_of_stock', digest: { productId, name, quantity } })` with `HUMAN_HANDOFF_ENABLED=true`, `OPS_CHANNEL_PHONE='OPS'`, and a stubbed `store` + `whatsappSender` → `store.create` is called once with `id` (12 lowercase hex chars), `customerId: 'S'`, `agentId: 'OPS'`, `kind: 'out_of_stock'`, `digest`; `whatsappSender.sendText` is called twice: once with `{ to: 'OPS', text: <digest containing HF-<id>> }` and once with `{ to: 'S', text: 'Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.' }` byte-identical; `setPendingHumanRequest` is called with the marker; the returned envelope is `{ ok: true, requestId, ref, customerNotified: true }`.
  - **(b) idempotent re-call**: a second `service.create(...)` for the same sender with `pendingHumanRequest` already set returns the existing `{ ok: true, requestId, ref, customerNotified: true }` without a new `store.create` or new `sendText`.
  - **(c) disabled kill-switch**: `HUMAN_HANDOFF_ENABLED=false` → `service.create(...)` returns `{ ok: false, error: { kind: 'disabled', retryable: false } }` without calling `store.create` or `whatsappSender.sendText`.
  - **(d) explicit ref token resolves**: `resolveReply({ text: 'HF-abc123def456 YES_RESTOCK_IN_X_DAYS:3', from: 'OPS' })` for a pending row → `store.resolve('abc123def456', { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 })` is called; `clearPendingHumanRequest` is called for the customer; returned envelope equals `{ kind: 'resolved', customerId, ref: 'HF-abc123def456', resolution: { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 }, syntheticUserText: <includes ref + 'restock in 3 days' phrasing> }`.
  - **(e) no token falls back to newest pending**: two pending rows for agent A (T1, T2 with T2 > T1), `text: 'NO_RESTOCK'` → T2 is the resolution target.
  - **(f) no token and no pending**: returns `{ kind: 'no_pending', reply: <ASK_FOR_REF> }` and no row is modified.
  - **(g) bare prose is GENERIC**: `kind: 'expiration_date'`, `text: 'HF-abc123def456 vence el 30 de noviembre'` → `store.resolve` is called with `{ decision: 'EXPIRATION', text: 'vence el 30 de noviembre' }`.
  - **(h) case/whitespace tolerant parser**: `text: 'hf-abc123def456   yes_restock_in_x_days :  5'` → resolved decision is `{ decision: 'YES_RESTOCK_IN_X_DAYS', days: 5 }`.
  - **(i) `isOpsSender`**: `isOpsSender('15219999888777')` with `opsChannelPhone='5219999888777'` returns `true` (sandbox trunk-1 stripped on both sides via `normalizeSandboxRecipient`); `isOpsSender('S')` returns `false`.

  The module file does NOT exist yet → import fails RED. Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.4 GREEN: create `src/human-handoff/application/human-handoff.service.ts` exporting `@Injectable() class HumanHandoffService` with constructor injections of `@Inject(HUMAN_HANDOFF_STORE)` + `@Inject(WHATSAPP_SENDER)` + `ConfigService` (reads `humanHandoff.enabled` + `humanHandoff.opsChannelPhone`) + `@Inject(WINSTON_MODULE_NEST_PROVIDER)` is NOT used (keep Logger plain). Implementation per design.md §"`HumanHandoffService`":
  - `create({ senderId, kind, digest })`: (1) if `!enabled` return disabled envelope; (2) load state, if `readPendingHumanRequest(state)` is non-null return the existing marker; (3) `id = crypto.randomUUID().replace(/-/g,'').slice(0,12)`; `ref = 'HF-' + id`; (4) `await store.create({ id, customerId: senderId, agentId: opsChannelPhone, kind, digest })`; (5) `await whatsappSender.sendText({ to: opsChannelPhone, text: renderDigest(request) })` (the renderer embeds `HF-<id>` and per-kind reply grammar); (6) `await whatsappSender.sendText({ to: senderId, text: UNDER_REVIEW_NOTICE })` (the literal); (7) `await setPendingHumanRequest(store, senderId, state, { requestId: id, ref, createdAt, customerNotifiedAt })`; (8) return success envelope. The literal `UNDER_REVIEW_NOTICE` constant is exported as `export const UNDER_REVIEW_NOTICE = 'Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.';`.
  - `resolveReply({ text, from })`: (1) regex `/\bHF-([A-Za-z0-9_-]{4,32})\b/i`; if matched, target = `await store.findByRef('HF-<match>')`; else target = `await store.findLatestPendingForAgent(from)`; (2) if no target, return `{ kind: 'no_pending', reply: ASK_FOR_REF }`; (3) parse the remainder (decision keywords case/whitespace tolerant; bare prose → GENERIC); (4) `await store.resolve(target.id, resolution)`; (5) `await clearPendingHumanRequest(store, target.customerId)`; (6) return `{ kind: 'resolved', customerId, ref, resolution, syntheticUserText: formatResolutionAsUserTurn(target, resolution) }` (the formatter includes the ref + kind + resolved value in Mexican Spanish).
  - `isOpsSender(senderId)` = `normalizeSandboxRecipient(senderId) === normalizeSandboxRecipient(opsChannelPhone)`.
  Verify green via T2.3 scenarios; existing scenarios in the repository still pass. <!-- sdd-owner: implementation -->

### Phase 2.3 — 12th AI-SDK tool + ToolDeps + registry

- [x] T2.5 RED: in `src/sale-flow/application/tools/request-human-assistance.tool.spec.ts` (module absent → red) assert the four tool-contract scenarios from the sale-flow-tools spec §"`requestHumanAssistance` is the twelfth sale-flow tool":
  - **(a) happy path**: `makeRequestHumanAssistanceTool(deps).execute({ kind: 'out_of_stock', digest: { productId, name } }, { context: { senderId: 'S' } })` with stubbed `deps.humanHandoffService.create(...)` returning `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }` → tool calls `humanHandoffService.create({ senderId: 'S', kind: 'out_of_stock', digest: { productId, name } })` exactly once; returned envelope deep-equals `{ ok: true, requestId: 'abc123def456', ref: 'HF-abc123def456', customerNotified: true }`.
  - **(b) idempotent re-call**: a second `execute(...)` while the customer's `pendingHumanRequest` is set returns the existing envelope (the service's idempotency guard owns this — the tool just delegates).
  - **(c) inputSchema rejects malformed digests**: `{ kind: 'out_of_stock', digest: { productId: 'not-a-uuid', name: '' } }` → `inputSchema.safeParse(...)` fails; `execute` is not called.
  - **(d) inputSchema rejects `shipping_approval`**: `{ kind: 'shipping_approval', digest: {...} }` → `inputSchema.safeParse(...)` fails (no discriminator match — reserved for R6).
  Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.6 GREEN: create `src/sale-flow/application/tools/request-human-assistance.tool.ts` exporting `makeRequestHumanAssistanceTool(deps: ToolDeps)` with the `inputSchema` discriminated union + `contextSchema` + `execute` delegation per design.md §"`requestHumanAssistance` tool (12th)" verbatim (the `inputSchema` uses `z.discriminatedUnion('kind', [...])` with the three active kinds today; `shipping_approval` is NOT in the union — it returns a Zod parse error so the schema layer rejects it before `execute`). `description` text gates the call to "ONLY when `checkStock`/`evaluateCart`/the conversation indicate escalation". `execute(input, options)` reads `options.context.senderId` (NOT `options.context.requestHumanAssistance.senderId` — the context envelope key matches the tool name but the inner schema is uniform per the llm-agent spec §"`toolsContext` gains `requestHumanAssistance.senderId`"). Verify green via T2.5 scenarios. <!-- sdd-owner: implementation -->
- [x] T2.7 RED: in `src/sale-flow/application/tool-deps.ts` add the `humanHandoffService: HumanHandoffService` field to the `ToolDeps` interface (currently missing → compile red in the new tool + in the registry spec). The type-only change is compile-checked via T2.6 (the tool imports `HumanHandoffService` for its dep) + the Phase-2.3 registry spec (T2.9/T2.10) + `pnpm build`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T2.8 GREEN: in `src/sale-flow/application/tool-deps.ts` add the import `import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';` (or `from '../../human-handoff/domain/human-handoff-store.port'`-style — pick the lightest import that compiles under strict TS) and the `humanHandoffService: HumanHandoffService` field on `ToolDeps`. Verify green via T2.6 + the existing tool specs (which now must stub `humanHandoffService` in their `deps`). <!-- sdd-owner: implementation -->
- [x] T2.9 RED: in `src/sale-flow/infrastructure/real-tool-registry.spec.ts` add (a) `humanHandoffService: { create: jest.fn() }` to the test stub (the registry now needs to inject `HUMAN_HANDOFF_SERVICE`); (b) the `HUMAN_HANDOFF_SERVICE` token provider in the testing module's `providers`; (c) change the exact-keys assertion from the current 11 keys (ending `..., getPaymentDetails, cancelSale`) to the 12 keys ending `..., getPaymentDetails, cancelSale, requestHumanAssistance`. Update the class JSDoc assertion from "eleven sale-flow tools" to "twelve sale-flow tools". Verify RED (today: `requestHumanAssistance` is not in `RealToolRegistry`'s `this.tools`, so `Object.keys(tools).sort()` includes only 11). <!-- sdd-owner: implementation -->
- [x] T2.10 GREEN: in `src/sale-flow/infrastructure/real-tool-registry.ts` (a) add the `HUMAN_HANDOFF_SERVICE` token import + `@Inject(HUMAN_HANDOFF_SERVICE_TOKEN) humanHandoffService: HumanHandoffService` constructor parameter; (b) add `humanHandoffService` to the `deps: ToolDeps` literal passed to each tool factory; (c) register `requestHumanAssistance: makeRequestHumanAssistanceTool(deps),` as the 12th key (after `cancelSale`); (d) update the class JSDoc from "eleven sale-flow tools" → "twelve sale-flow tools" with a one-line note "12th: `requestHumanAssistance`". Verify green via T2.9 assertions; the existing 11-tool contract still passes. <!-- sdd-owner: implementation -->
- [x] T2.11 RED: in `src/sale-flow/application/tools/tool-contract.spec.ts` (a) add `import { makeRequestHumanAssistanceTool } from './request-human-assistance.tool';`; (b) add `humanHandoffService: { create: jest.fn() }` to the stub `deps` object; (c) append `['requestHumanAssistance', makeRequestHumanAssistanceTool as Factory]` to the `factories` array (11 → 12). The `Factory` deps type stays the existing one (the contract suite only needs `description`/`inputSchema`/`execute` — the `humanHandoffService` stub satisfies `ToolDeps` typewise). Verify RED (today: 11 factories; the 12th is not exercised by the contract suite). <!-- sdd-owner: implementation -->
- [x] T2.12 GREEN: same edit lands with T2.11. Verify green — `factories.length === 12`, both `it.each(factories)` loops cover all 12 keys including `requestHumanAssistance`. <!-- sdd-owner: implementation -->

---

## Phase 3: Foundation — env validation, config block, module wiring (Commit 1)

- [x] T3.1 RED: in `src/config/env.validation.spec.ts` add a new `describe('OPS_CHANNEL_PHONE / HUMAN_HANDOFF_ENABLED', ...)` block asserting the five scenarios from the app-config spec §"Fail fast on invalid environment":
  - **(a)** `HUMAN_HANDOFF_ENABLED=true` + missing `OPS_CHANNEL_PHONE` → Joi error includes `OPS_CHANNEL_PHONE`.
  - **(b)** `HUMAN_HANDOFF_ENABLED=true` + empty `OPS_CHANNEL_PHONE=''` → Joi error includes `OPS_CHANNEL_PHONE`.
  - **(c)** `HUMAN_HANDOFF_ENABLED=true` + `OPS_CHANNEL_PHONE` not a string (number) → Joi error.
  - **(d)** `HUMAN_HANDOFF_ENABLED=true` + valid `OPS_CHANNEL_PHONE='5219999888777'` → no error.
  - **(e)** `HUMAN_HANDOFF_ENABLED=false` + missing `OPS_CHANNEL_PHONE` → no error (the variable is optional when disabled).
  - **(f)** Both vars absent → Joi error (the default-`true` chain requires `OPS_CHANNEL_PHONE`).
  - **(g)** `OPS_CHANNEL_PHONE='+5219999888777'` → no error (Joi accepts the optional `+` prefix per the spec).
  Verify RED (today: no `OPS_CHANNEL_PHONE`/`HUMAN_HANDOFF_ENABLED` in the schema → `a`–`c` scenarios don't even reach a Joi error; the test must fail). <!-- sdd-owner: implementation -->
- [x] T3.2 GREEN: in `src/config/env.validation.ts` add to the Joi object:
  ```ts
  HUMAN_HANDOFF_ENABLED: Joi.boolean().default(true),
  OPS_CHANNEL_PHONE: Joi.string().pattern(/^\+?\d+$/).optional(),
  ```
  + a `.when(...)` conditional that makes `OPS_CHANNEL_PHONE` REQUIRED when `HUMAN_HANDOFF_ENABLED` is true (the cleanest expression is `Joi.alternatives().conditional(...)` or two schema variants). Mirror the existing pattern of conditional-required Joi fields; document the chain in JSDoc. Verify green via T3.1 scenarios; all existing scenarios still pass (the existing `validEnv` fixture doesn't include the new vars and doesn't change behaviour). <!-- sdd-owner: implementation -->
- [x] T3.3 RED: in `src/config/configuration.spec.ts` (the file may not exist yet — create it as `src/config/configuration.spec.ts` if needed; mirror the existing config spec style if present) add the four scenarios from the app-config spec §"`humanHandoff` config block exposes enabled and opsChannelPhone":
  - **(a)** `HUMAN_HANDOFF_ENABLED=true`, `OPS_CHANNEL_PHONE='5219999888777'` → `humanHandoff: { enabled: true, opsChannelPhone: '5219999888777' }` (normalized via `normalizeSandboxRecipient` at boot).
  - **(b)** `HUMAN_HANDOFF_ENABLED=false`, `OPS_CHANNEL_PHONE` unset → `humanHandoff: { enabled: false, opsChannelPhone: undefined }`.
  - **(c)** `OPS_CHANNEL_PHONE='15219999888777'` (trunk-1 form) → `humanHandoff.opsChannelPhone === normalizeSandboxRecipient(...)` (trunk-1 stripped).
  Verify RED (the `humanHandoff` key does not exist in the config factory yet). <!-- sdd-owner: implementation -->
- [x] T3.4 GREEN: in `src/config/configuration.ts` add a new top-level `humanHandoff` block to the factory return value:
  ```ts
  humanHandoff: {
    enabled: process.env.HUMAN_HANDOFF_ENABLED !== 'false',  // default true
    opsChannelPhone: process.env.OPS_CHANNEL_PHONE
      ? normalizeSandboxRecipient(process.env.OPS_CHANNEL_PHONE)
      : undefined,
  },
  ```
  + import `normalizeSandboxRecipient` from `'../whatsapp/infrastructure/meta-whatsapp.sender'` (the existing helper). Verify green via T3.3 scenarios; the existing config assertions still pass (the existing factory return is extended, not replaced). <!-- sdd-owner: implementation -->
- [x] T3.5 RED: in `src/human-handoff/human-handoff.module.ts` (file absent → red) wire the providers + exports: bind `HUMAN_HANDOFF_STORE` to `PostgresHumanHandoffStore`; provide `HumanHandoffService`; export both. The service's constructor MUST receive `HUMAN_HANDOFF_STORE`, `WHATSAPP_SENDER`, `ConfigService`. Verify RED. <!-- sdd-owner: implementation -->
- [x] T3.6 GREEN: create `src/human-handoff/human-handoff.module.ts` with:
  ```ts
  @Module({
    imports: [DatabaseModule, WhatsappSenderModule, ConfigModule],
    providers: [
      { provide: HUMAN_HANDOFF_STORE, useClass: PostgresHumanHandoffStore },
      HumanHandoffService,
    ],
    exports: [HUMAN_HANDOFF_STORE, HumanHandoffService],
  })
  export class HumanHandoffModule {}
  ```
  + create `src/whatsapp/whatsapp-sender.module.ts` per ADR-30:
  ```ts
  @Module({
    imports: [ConfigModule, HttpModule],
    providers: [MetaWhatsappSender, { provide: WHATSAPP_SENDER, useExisting: MetaWhatsappSender }],
    exports: [WHATSAPP_SENDER],
  })
  export class WhatsappSenderModule {}
  ```
  + modify `src/whatsapp/whatsapp.module.ts` to import `WhatsappSenderModule` (so `MetaWhatsappSender` is no longer re-provided there) and import `HumanHandoffModule` (so `WebhookDispatcherService` can inject `HumanHandoffService` — but that wiring lands in Commit 2; for Commit 1, just import the module without injecting yet). Update `src/app.module.ts` to add `HumanHandoffModule` to the `imports` array. Verify green via `pnpm build` + `pnpm test` (no behavioural change yet). <!-- sdd-owner: implementation -->
- [x] T3.7 RED: in `src/human-handoff/application/human-handoff.service.spec.ts` add a new scenario asserting that `service.create(...)` reads `configService.get('humanHandoff')` (NOT `process.env.OPS_CHANNEL_PHONE`) per the app-config spec §"`HumanHandoffService` reads the config block (not `process.env`)". Verify RED (the service currently uses `ConfigService` correctly; the test simply locks the behaviour so a future regression to `process.env` reads fails). <!-- sdd-owner: implementation -->
- [x] T3.8 GREEN: the assertion lands with T3.7 — the service already uses `ConfigService.get(...)`; the spec ensures it stays that way. Verify green. <!-- sdd-owner: implementation -->
- [x] T3.9 Create `docs/operations-human-handoff.md` (new file, ~150 lines) with the runbook per the proposal §"Out of Scope" / §"Dependencies" / design.md §"Risk R-1": shift-start "ops on" pattern (agent sends a short ops-on message to open the 24h service window), dev/test-number 5-recipient allowlist + 24h token cap + provisioning steps, the Meta 24h service-window strategy and the template-cost tradeoff if the operator skips ops-on, the `OPS_CHANNEL_PHONE` provisioning checklist, the `HUMAN_HANDOFF_ENABLED=false` behavior-rollback path (one env flip, zero code). The doc is prose-only; no spec or test coverage beyond an existence check (`docs/operations-human-handoff.md` MUST exist after this slice per the proposal's success-criteria checklist). <!-- sdd-owner: implementation -->

---

## Phase 4: Routing — `pendingHumanRequest` field + `AgentRunner` short-circuit (Commit 2)

### Phase 4.1 — `ConversationStateData.pendingHumanRequest` typed field

- [x] T4.1 RED: in `src/conversation/domain/conversation-store.ts` add the typed optional field `pendingHumanRequest?: PendingHumanRequest | null` to `ConversationStateData` (sibling of `cart` and `placedSaleId`), plus the new exported `PendingHumanRequest` interface and the pure helper `readPendingHumanRequest(state): PendingHumanRequest | null`. The change is compile-checked via T4.2 + T4.4 (runner spec). Verify RED (today: the type lacks the field; the helper does not exist). <!-- sdd-owner: implementation -->
- [x] T4.2 GREEN: in `src/conversation/domain/conversation-store.ts`:
  ```ts
  export interface PendingHumanRequest {
    requestId: string;
    ref: string;
    createdAt: string;
    customerNotifiedAt: string;
  }
  export interface ConversationStateData {
    messages?: AgentMessage[];
    placedSaleId?: string;
    pendingHumanRequest?: PendingHumanRequest | null;
    [key: string]: unknown;
  }
  export function readPendingHumanRequest(state: ConversationState | null): PendingHumanRequest | null {
    const raw = state?.data?.pendingHumanRequest;
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') return null;
    const candidate = raw as Record<string, unknown>;
    if (
      typeof candidate.requestId !== 'string' || candidate.requestId.length === 0 ||
      typeof candidate.ref !== 'string' || candidate.ref.length === 0 ||
      typeof candidate.createdAt !== 'string' ||
      typeof candidate.customerNotifiedAt !== 'string'
    ) return null;
    return candidate as PendingHumanRequest;
  }
  ```
  Verify green via T4.3 + the existing conversation-store spec. <!-- sdd-owner: implementation -->
- [x] T4.3 RED: create `src/conversation/domain/conversation-store.spec.ts` (file may not exist; if not, mirror the existing test style) assert the five `readPendingHumanRequest` scenarios from the conversation-store spec §"readPendingHumanRequest is a pure helper": returns the typed object when structurally valid; returns `null` when missing; returns `null` for an unrelated shape (`{ requestId: 'x' }`); returns `null` when the value is explicitly `null`; does NOT mutate the input state. Verify RED. <!-- sdd-owner: implementation -->
- [x] T4.4 GREEN: the assertions from T4.3 pass against the T4.2 helper; verify green. <!-- sdd-owner: implementation -->

### Phase 4.2 — `AgentRunner` short-circuit + fresh-state spread (ADR-28 + ADR-29)

- [x] T4.5 RED: in `src/llm-agent/application/agent-runner.service.spec.ts` add the four new scenarios from the llm-agent spec §"`AgentRunner` drives the tool-calling loop" + §"Enforce idle-timeout session window" + §"AgentRunner final write spreads fresh state (ADR-28)":
  - **(a) short-circuit when pendingHumanRequest is set**: a customer-side inbound for sender S with `data.pendingHumanRequest` set → `llm.run(...)` is NOT called; `costGuard.record(...)` is NOT called; `store.update(...)` is NOT called; returned `reply` equals the literal canned string `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos` byte-identical.
  - **(b) short-circuit does not depend on `LLM_IDLE_TIMEOUT_MS`**: short-circuit fires whether or not `lastMessageAt` is fresh (the marker is the discriminator, not the idle boundary).
  - **(c) fresh-state spread (ADR-28)**: a tool invoked during the LLM turn persists `data: { ..., cart: <new cart>, pendingHumanRequest: <marker> }`; the runner's post-`run` `get(S)` returns that state; the runner's final `update(S, { data: { ...freshState.data, messages: nextTurns } })` carries the tool's cart AND the marker (NOT `messages: nextTurns` alone, which would clobber the tool's writes).
  - **(d) post-`run` get returning null logs and skips**: when the post-`run` `get(S)` returns `null` (race: state deleted during the turn), the runner MUST emit a structured `error` log tagged `state-deleted-during-run` with `senderId`, and MUST NOT perform a `null`-spread `update`.
  - **(e) idle reset preserves the marker**: a sender with `pendingHumanRequest` set + `LLM_IDLE_TIMEOUT_MS` elapsed → the idle-reset UPSERT carries `pendingHumanRequest` equal to the pre-reset value (the freshly loaded `state.data.pendingHumanRequest` is spread into the patch).
  Verify RED (today: the runner writes `data: { messages: nextTurns }` and clobbers any tool-persisted sibling; no short-circuit branch exists). <!-- sdd-owner: implementation -->
- [x] T4.6 GREEN: in `src/llm-agent/application/agent-runner.service.ts`:
  - **Short-circuit (ADR-29)**: BEFORE step 1 (load state), read the freshly loaded state and call `readPendingHumanRequest(state)` — if non-null, return `{ reply: CANNED_REPLY }` immediately (no `llm.run`, no `costGuard.record`, no `store.update`). The literal `export const PENDING_HUMAN_REQUEST_REPLY = 'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos';` is co-located for byte-identical testing.
  - **Fresh-state spread (ADR-28)**: AFTER `llm.run` returns, re-fetch via `const freshState = await this.store.get(input.senderId);` (handle `null` with the structured error log per T4.5(d)); persist `data: { ...freshState.data, messages: nextTurns }` (NOT `data: { messages: nextTurns }` which clobbers).
  - **Idle reset preserves marker**: the idle-expired branch already calls `store.update(...)` with `data: { messages: [] }` (or empty turns); change it to use the spread pattern above so the freshly loaded `data.pendingHumanRequest` is preserved. The marker's value lives in `state.data.pendingHumanRequest` (the pre-idle state was just loaded in step 1), so the spread carries it forward.
  Verify green via T4.5 scenarios; the existing runner scenarios still pass (the spread-write change is backward-safe: when no tool touched `data`, the spread equals the pre-LLM `state.data`). <!-- sdd-owner: implementation -->

### Phase 4.3 — `toolsContext.requestHumanAssistance.senderId`

- [x] T4.7 RED: in `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` add `requestHumanAssistance: { senderId: input.senderId }` to the `toolsContext` object (today: only `evaluateCart` and `createSale` carry a `senderId`). Verify RED (today: the new tool's `contextSchema` would receive `undefined` for `options.context.senderId` because the context envelope is missing the key). <!-- sdd-owner: implementation -->
- [x] T4.8 GREEN: add the new field to `toolsContext`; verify green (no behavioural change to existing tools; the new tool receives its `senderId` per the llm-agent spec §"`toolsContext` gains `requestHumanAssistance.senderId`"). The runner-level spec in T2.6 already validates that the tool reads `options.context.senderId` (NOT `options.context.requestHumanAssistance.senderId`), so this GREEN pass only needs to confirm the wiring. <!-- sdd-owner: implementation -->

---

## Phase 5: Routing — DTO + dispatcher hook + module wiring (Commit 2)

### Phase 5.1 — DTO `WebhookMetadataDto` + `InboundMessage.receivingPhoneNumberId`

- [x] T5.1 RED: in `src/whatsapp/presentation/dto/webhook-event.dto.ts` add a new `WebhookMetadataDto` class with optional `display_phone_number?: string` + `phone_number_id?: string`, and add `metadata?: WebhookMetadataDto` as an optional field on `WebhookValueDto` (alongside the existing `messages` + `contacts` + `statuses` fields). Add `@ValidateNested()` + `@Type(() => WebhookMetadataDto)` so the nested DTO is instantiated by `class-transformer`. In `src/whatsapp/domain/inbound-message.ts` add the optional field `receivingPhoneNumberId?: string` to the `InboundMessage` interface. Both changes are compile-checked via T5.2 (dispatcher spec) + `pnpm build`. Verify RED (today: no `metadata` on `WebhookValueDto`; no `receivingPhoneNumberId` on `InboundMessage`). <!-- sdd-owner: implementation -->
- [x] T5.2 GREEN: the changes from T5.1 land; the DTO parses a payload that carries `metadata` (asserted in the dispatcher spec) and a payload that doesn't (asserted in the dispatcher spec); the `InboundMessage` interface carries the new optional field without breaking existing producers. Verify green via T5.3. <!-- sdd-owner: implementation -->

### Phase 5.2 — `WebhookDispatcherService` ops pre-routing hook + pending-marker short-circuit

- [x] T5.3 RED: in `src/whatsapp/application/webhook-dispatcher.service.spec.ts` add the six new scenarios from the whatsapp-webhook spec §"Ops pre-routing hook classifies and dispatches ops inbounds" + §"pendingHumanRequest short-circuit sends a canned literal reply" + §"Synthetic user turn injection via the runner preserves the resolved-context":
  - **(a) ops-side inbound routes to `resolveReply` before the runner**: a normalized inbound with `from = <OPS_CHANNEL_PHONE>` (after `normalizeSandboxRecipient`) + a stubbed `humanHandoffService.resolveReply` returning `{ kind: 'resolved', customerId: 'S', syntheticUserText: '...' }` → `resolveReply` is called once with the right `{ text, from }`; `agentRunner.handle(...)` is called once with `{ senderId: 'S', text: <syntheticUserText> }` (NOT with the ops `from`); the assistant reply is sent to `'S'` via `whatsappSender.sendText`.
  - **(b) ops `no_pending` returns `ASK_FOR_REF` to the agent**: `resolveReply` returns `{ kind: 'no_pending', reply: <ASK_FOR_REF> }` → `agentRunner.handle(...)` is NOT called; `whatsappSender.sendText({ to: <ops from>, text: <ASK_FOR_REF> })` is called once.
  - **(c) customer inbound with `pendingHumanRequest` set short-circuits**: the customer S's `data.pendingHumanRequest` is set; an inbound from S with `text: '¿siguen?'` → `humanHandoffService.resolveReply(...)` is NOT called; `agentRunner.handle(...)` is NOT called; `whatsappSender.sendText({ to: 'S', text: 'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos' })` is called once byte-identical; `store.update(...)` is NOT called.
  - **(d) customer inbound with no `pendingHumanRequest` follows the normal path**: `humanHandoffService.resolveReply(...)` is NOT called; `agentRunner.handle(...)` IS called; the assistant reply is sent to S.
  - **(e) ops inbound is deduplicated like any other inbound**: two webhook deliveries with the same `wamid` for an ops inbound → first reaches `resolveReply`; second is filtered by `WEBHOOK_DEDUP` (no `resolveReply` for the dup).
  - **(f) ops inbound whose wamid is in `RECENT_OUTBOUND` is filtered**: echo filter rejects the inbound before `resolveReply` runs.
  - **(g) dispatcher order is asserted**: a unit test that records every collaborator invocation in dispatch order → recorded order is `[echoFilter, webhookDedup, isOpsSender?, resolveReply?, pendingMarkerShortCircuit?, idleCheck, agentRunnerHandle, sendText]` with the conditional steps appearing only when their condition holds.
  - **(h) synthetic turn appends user + assistant and the marker does NOT re-short-circuit**: the synthetic turn flows through `AgentRunner.handle` (the marker is cleared by `resolveReply` first); the persisted `data.messages` ends with the synthetic user turn + the assistant reply; the dispatcher's pending-marker short-circuit sees `null` for S and does NOT suppress the synthetic turn.
  Verify RED (today: the dispatcher has no `humanHandoffService` injection, no pre-routing hook, no pending-marker short-circuit; every customer inbound reaches the runner). <!-- sdd-owner: implementation -->
- [x] T5.4 GREEN: in `src/whatsapp/application/webhook-dispatcher.service.ts`:
  - **Inject `HumanHandoffService`**: add `@Inject(HUMAN_HANDOFF_SERVICE) private readonly humanHandoff: HumanHandoffService` to the constructor.
  - **Update `normalizeInboundMessages`** (the inline private function in the same file): when `value?.metadata?.phone_number_id` is a string, set `receivingPhoneNumberId` on every produced `InboundMessage`; when absent, leave it `undefined`. The metadata capture is observable + loggable only; the discriminator remains `isOpsSender(from)` per ADR-22.
  - **Pre-routing hook**: BEFORE the existing `agentRunner.handle(...)` call (and AFTER the echo + dedup checks), call `this.humanHandoff.isOpsSender(message.senderId)`. When `true`, call `const result = await this.humanHandoff.resolveReply({ text: message.text, from: message.senderId });` and branch:
    - `{ kind: 'resolved', customerId, syntheticUserText, ... }` → call `const { reply } = await this.agentRunner.handle({ senderId: customerId, text: syntheticUserText });` + `await this.whatsappSender.sendText({ to: customerId, text: reply });`.
    - `{ kind: 'no_pending', reply }` → `await this.whatsappSender.sendText({ to: message.senderId, text: reply });`.
    - **continue past the hook** (skip the pending-marker short-circuit + the runner + the customer reply path).
  - **Pending-marker short-circuit**: AFTER the ops hook, load `const state = await this.store.get(message.senderId);` (inject `CONVERSATION_STORE` token into the dispatcher) and call `readPendingHumanRequest(state)`. When non-null, `await this.whatsappSender.sendText({ to: message.senderId, text: PENDING_HUMAN_REQUEST_REPLY });` (the canned literal imported from the runner) and `continue` (skip idle + runner + store update).
  - The order matches the spec's asserted sequence: `[echoFilter, webhookDedup, isOpsSender?, resolveReply?, pendingMarkerShortCircuit?, idleCheck, agentRunnerHandle, sendText]`.
  - **Update the existing `WebhookDispatcherService` JSDoc** to document the new branches + the inbound-driven outbound contract.
  Verify green via T5.3 scenarios; the existing dispatcher scenarios still pass (the new branches are guarded by `isOpsSender` and `readPendingHumanRequest`, so non-ops inbounds without markers follow the existing path byte-identically). <!-- sdd-owner: implementation -->
- [x] T5.5 RED: in `src/whatsapp/whatsapp.module.ts` add `HumanHandoffModule` to the `imports` array (so `HUMAN_HANDOFF_SERVICE` is in scope for the dispatcher's injection). The provider list stays unchanged; the export list stays unchanged. Verify RED (today: `WebhookDispatcherService` constructor signature includes `humanHandoff` but the module doesn't import `HumanHandoffModule` → DI graph incomplete → module build fails). <!-- sdd-owner: implementation -->
- [x] T5.6 GREEN: the change from T5.5 lands; `pnpm build` succeeds; the `WebhookDispatcherService` resolves with `HUMAN_HANDOFF_SERVICE` injected. Verify green via `pnpm test` (the existing dispatcher spec stubs `humanHandoff` already, so the DI graph compiles). <!-- sdd-owner: implementation -->

---

## Phase 6: Triggers — `check-stock` / `evaluate-cart` envelopes + `SALE_FLOW_INSTRUCTIONS` (Commit 3)

### Phase 6.1 — `checkStock` humanAssistance envelope

- [x] T6.1 RED: in `src/sale-flow/application/tools/check-stock.tool.spec.ts` add the three new scenarios from the sale-flow-tools spec §"`checkStock` returns a `humanAssistance` envelope on `out_of_stock`":
  - **(a) out_of_stock adds the envelope**: stubbed `chatbotApi.getStock` returns `{ productId, variantId, status: 'out_of_stock', quantity: 0, updatedAt }` → returned envelope deep-equals `{ ok: true, stock: {...out_of_stock...}, humanAssistance: { kind: 'out_of_stock', digest: { productId, name: '<from input or prior search>', variantId, quantity: 0 } } }`. (The `name` field MUST come from the input or from a stubbed catalog lookup — NEVER fabricated.)
  - **(b) in_stock / low_stock / unknown do NOT carry the envelope**: any other `stock.status` → returned envelope MUST NOT include a `humanAssistance` key.
  - **(c) checkStock does NOT inject or call `HumanHandoffService`**: the `ToolDeps` type signature for `checkStock`'s factory uses the EXISTING `ToolDeps` (no `humanHandoffService`); the tool only returns the envelope as a signal — the model decides when to call `requestHumanAssistance`.
  Verify RED (today: `checkStock` returns `{ ok: true, ...stock }` with no `humanAssistance` envelope; the spec scenarios cannot deep-equal the new shape). <!-- sdd-owner: implementation -->
- [x] T6.2 GREEN: in `src/sale-flow/application/tools/check-stock.tool.ts` (a) add the `humanAssistance` envelope build in the `try` block of `execute` (the `mapChatbotError(err)` path is unchanged — only the success path gains the envelope); (b) the envelope is added only when `stock.status === 'out_of_stock'`; (c) the `name` field is sourced from `input.name` if the caller passed one (optional input extension — `inputSchema` gains `name: z.string().min(1).optional()`), otherwise from a stubbed catalog lookup, otherwise omitted (per the spec: "When the model does not have a reliable `name` for the product, the tool MUST omit `name` from the digest"). Verify green via T6.1 scenarios; the existing `checkStock` scenarios still pass. <!-- sdd-owner: implementation -->

### Phase 6.2 — `evaluateCart` humanAssistance envelope

- [x] T6.3 RED: in `src/sale-flow/application/tools/evaluate-cart.tool.spec.ts` add the three new scenarios from the sale-flow-tools spec §"`evaluateCart` returns a `humanAssistance` envelope on `needs_human_review`":
  - **(a) `needs_human_review` adds the envelope**: stubbed `chatbotApi.evaluateCart` returns `{ items, originalTotalCents, finalTotalCents, promotionEvaluationStatus: 'needs_human_review' }` → returned envelope deep-equals `{ ok: true, evaluation: {...}, promotionEvaluationStatus: 'needs_human_review', humanAssistance: { kind: 'needs_human_review', digest: { items: <cart items at list price>, originalTotalCents } } }`.
  - **(b) `ok` / `rejected` do NOT carry the envelope**: any other `promotionEvaluationStatus` → returned envelope MUST NOT include a `humanAssistance` key.
  - **(c) evaluateCart does NOT inject or call `HumanHandoffService`**: same contract as `checkStock` (the tool is signal-only).
  Verify RED (today: `evaluateCart` returns `{ ok: true, ...evaluation }` with no `humanAssistance` envelope). <!-- sdd-owner: implementation -->
- [x] T6.4 GREEN: in `src/sale-flow/application/tools/evaluate-cart.tool.ts` (a) add the `humanAssistance` envelope build in the success path of `execute` (only when `promotionEvaluationStatus === 'needs_human_review'`); (b) the `digest.items` mirrors the persisted cart's items at LIST price (`unitPriceCents` = the persisted list price, NEVER the discounted `finalPriceCents` — the list price is what gets reviewed per the spec). The existing `evaluation` payload is preserved byte-identically; the envelope is additive. Verify green via T6.3 scenarios; the existing `evaluateCart` scenarios still pass. <!-- sdd-owner: implementation -->

### Phase 6.3 — `SALE_FLOW_INSTRUCTIONS` step 16 + edits to steps 5/11

- [x] T6.5 RED: in `src/sale-flow/domain/sale-flow-instructions.spec.ts` add the four new scenarios from the sale-flow-tools spec §"`SALE_FLOW_INSTRUCTIONS` encodes the escrow flow and is composed at boot":
  - **(a) step 5 mentions `humanAssistance` and `out_of_stock`**: the prompt mentions `humanAssistance` and `kind: 'out_of_stock'` in the `checkStock` R7 rule.
  - **(b) step 8 mentions `humanAssistance` and `needs_human_review`**: the prompt mentions `humanAssistance` and `kind: 'needs_human_review'` in the `evaluateCart` promo rule; the "render quote first, escalate on customer acceptance" semantics are present.
  - **(c) step 16 R14 expiration-date rule is present**: the prompt contains the rule that on expiration-date questions the model MUST call `requestHumanAssistance({ kind: 'expiration_date', digest: { productId, name, question } })`; the prompt explicitly forbids using `esa función aún no está disponible` for R14 (only for shipping zones).
  - **(d) awaiting-human posture rule is present**: the prompt contains the rule that after `requestHumanAssistance` returns `ok: true`, the model MUST NOT keep trying to advance the sale flow; the customer has been notified and the bot waits indefinitely; subsequent customer inbounds get the runner's canned "seguimos esperando" reply.
  - **(e) byte-identical preserved strings**: the prompt STILL contains `esa función aún no está disponible`, `en un momento un agente te comparte los datos de pago`, `PROMO_RE_QUOTE` (and `needs_human_review` without a hyphen prefix), `¿Confirmas la cancelación? Sí/No`, `no hay una venta reciente por cancelar`, `deriva a revisión humana` — all byte-identical, no edits to grammar, punctuation, accents, or whitespace.
  - **(f) step order covers 12 tools**: the marker-order test covers `searchCatalog`, `checkStock`, `evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`, `getPaymentDetails`, `attachReceipt`, `cancelSale`, `requestHumanAssistance` in the right order (the new step 16 mentions `requestHumanAssistance` after `cancelSale`).
  Verify RED (today: the prompt has 15 steps; no R7/R14/`humanAssistance` mentions; no awaiting-human posture rule). <!-- sdd-owner: implementation -->
- [x] T6.6 GREEN: in `src/sale-flow/domain/sale-flow-instructions.ts`:
  - **Step 5 edit (R7)**: append the R7 escalation rule — "If `checkStock` returns a `humanAssistance` envelope with `kind: 'out_of_stock'`, call `requestHumanAssistance({ kind: 'out_of_stock', digest: { productId, name, variantId?, quantity? } })` and stop the sale flow until the human replies."
  - **Step 8 edit (`needs_human_review`)**: append the rule — "If `evaluateCart` returns a `humanAssistance` envelope with `kind: 'needs_human_review'`, render the existing price quote first and only escalate when the customer wants to proceed, by calling `requestHumanAssistance({ kind: 'needs_human_review', digest: { items, originalTotalCents?, recomputedTotalCents? } })`."
  - **Step 11 minor edit**: keep the existing `deriva a revisión humana` phrase byte-identical (the new envelope + tool now back it with a real mechanism, but the literal stays).
  - **Step 16 NEW (R14 + awaiting-human posture)**: add the R14 expiration-date rule + the awaiting-human posture rule (after the close step 15).
  - Update the file-header comment from "15-step" to "16-step".
  Verify green via T6.5 scenarios; the existing prompt contract still passes (the byte-identical preserved strings are untouched). <!-- sdd-owner: implementation -->

---

## Phase 7: Full-suite verification (no new tests)

- [x] T7.1 Run `pnpm test` — full unit + integration suite green (human-handoff, sale-flow, llm-agent, conversation, whatsapp, config). <!-- sdd-owner: implementation -->
- [x] T7.2 Run `pnpm test:cov` — coverage ≥ 80% on changed files (`src/human-handoff/**`, `src/sale-flow/**`, `src/llm-agent/**`, `src/whatsapp/**`, `src/config/**`, `src/conversation/**`). <!-- sdd-owner: implementation -->
- [x] T7.3 Run `pnpm build` — clean `tsc` compile (proves the types-only files `conversation-store.ts`, `tool-deps.ts`, `webhook-event.dto.ts`, `inbound-message.ts`, `vercel-ai-llm-agent.ts` compile, and the port/HTTP/ToolDeps wiring is in sync across the DI graph including the `WhatsappSenderModule` extraction). <!-- sdd-owner: implementation -->
- [ ] T7.4 Run `pnpm migrate` (the `node-pg-migrate up` invocation per `package.json` `scripts.migrate`) against a fresh empty DB — the `1900000000000_human_handoff_requests` migration runs clean, the table + the `(status, created_at)` index exist. Then run `pnpm migrate:down` — the table drops cleanly. <!-- sdd-owner: implementation --> **NOT RUN in the apply environment** (no live Postgres / Docker; the migration file is structurally verified by T1.7/T1.8 and mirrors the two prior migrations byte-identically). Flagged in the apply-phase risks.
- [x] T7.5 Run scoped lint `pnpm exec eslint src/human-handoff src/sale-flow src/llm-agent src/whatsapp src/conversation src/config` — clean (repo-wide `pnpm lint` is known-broken pre-existing; do not attempt to fix it in this slice). <!-- sdd-owner: implementation -->
- [x] T7.6 Run `pnpm test:e2e` — green. <!-- sdd-owner: implementation -->
- [x] T7.7 Sanity: `git grep -n 'requestHumanAssistance\|pendingHumanRequest\|HumanHandoffService\|HumanHandoffStore\|HUMAN_HANDOFF_SERVICE\|OPS_CHANNEL_PHONE\|HUMAN_HANDOFF_ENABLED\|isOpsSender\|hf-abc123def456\|seguimos esperando respuesta del agente\|Gracias, ya contacté a un agente humano\|HF-\|humanAssistance' src/ openspec/specs/` returns the expected set (no orphans in unrelated features, no missing references in tool/registry/spec wiring); `git diff --stat` shows the touched set matches the design file map exactly (no backend files, no `AGENTS.md`, no chat-bot-api client changes). <!-- sdd-owner: implementation -->

---

## Phase 8: Delivery — 3-commit split on a single branch, single PR, merge to main

> The user preflight chose `single-pr` (NO chained PRs). The 3-commit split is the agreed review-budget mitigation (see Review Workload Forecast at the top). The orchestrator does NOT need to re-confirm size-exception; the user's preflight already accepted it. Do NOT propose chained PRs.

- [x] T8.1 **Commit 1 — Foundation: handoff channel (Phases 1–3).** Single commit with the entire `src/human-handoff/**` module + the migration + the 12th tool + `ToolDeps` + the registry (11 → 12) + `WhatsappSenderModule` extraction + the env/config + the `humanHandoff` module wired into `AppModule` + the operations runbook + their tests. After this commit: `pnpm test`, `pnpm build`, `pnpm migrate` are green; the tool is the only write path; the dispatcher's ops pre-routing hook is NOT yet wired (Commit 2); the trigger tools have NOT yet gained their envelopes (Commit 3); end-to-end `requestHumanAssistance` → `human_handoff_requests` row + ops digest + customer notice works when invoked directly. Conventional-commit message e.g. `feat(human-handoff): channel + 12th tool + OPS_CHANNEL_PHONE env`. <!-- sdd-owner: implementation -->
- [x] T8.2 **Commit 2 — Foundation: routing + short-circuit (Phases 4–5).** Single commit with the `ConversationStateData.pendingHumanRequest` field + the `readPendingHumanRequest` helper + the runner's short-circuit + fresh-state spread (ADR-28 + ADR-29) + the `toolsContext.requestHumanAssistance.senderId` + the DTO `WebhookMetadataDto` + `InboundMessage.receivingPhoneNumberId` + the dispatcher pre-routing hook + the pending-marker short-circuit + `WhatsappModule` wiring + their tests. After this commit: `pnpm test`, `pnpm build`, `pnpm test:e2e` are green; customer-side inbounds with a marker get the canned reply (no LLM turn); ops-side inbounds route to `resolveReply` before the runner; the synthetic-turn path resumes the customer's flow. Conventional-commit message e.g. `feat(human-handoff): dispatcher ops hook + runner short-circuit`. <!-- sdd-owner: implementation -->
- [x] T8.3 **Commit 3 — Triggers + prompt (Phase 6).** Single commit with the `checkStock` + `evaluateCart` `humanAssistance` envelopes + the `SALE_FLOW_INSTRUCTIONS` step 16 + edits to steps 5/8/11 + the byte-identical prompt contract + their tests. After this commit: `pnpm test`, `pnpm build` clean; the model sees the new envelopes + the new prompt step + the awaiting-human posture rule; end-to-end R7 + `needs_human_review` + R14 paths work as designed. Conventional-commit message e.g. `feat(sale-flow): trigger envelopes + R14 prompt step`. <!-- sdd-owner: implementation -->
- [ ] T8.4 **Merge to main.** Fast-forward or merge commit per repo policy; user handles the actual `git push` per the delivery contract. No remote-side chained PRs are created — `Chained PRs recommended: No`. <!-- sdd-owner: implementation -->

---

## Parent (post-apply lifecycle gates)

- [ ] ~~Start or reuse bounded review~~ **NOT APPLICABLE**: receipt-driven development is OFF (decided global; `gentle-ai review mode status` = off). Delivery follows ordinary repository policy; the quality gate for this slice is the `sdd-verify` phase. Both rollback paths were reviewed at design level (design.md §Rollback):
  1. **Behaviour rollback** — set `HUMAN_HANDOFF_ENABLED=false` in env and restart. `HumanHandoffService.create` returns `{ ok: false, error: { kind: 'disabled', retryable: false } }` before any write/send; the model falls back to the prompt-phrase text; `check-stock`/`evaluate-cart` keep returning the new envelope but the model has no live tool (registered but inert); the dispatcher's ops hook remains wired but is inert (`resolveReply` with no rows → "no pending" ask-for-ref). **One env flip, zero code.**
  2. **Code rollback** — revert the three merge commits; the migration's `down` removes the table and index; the dispatcher hook, `pendingHumanRequest` field, 12th tool, and `humanHandoff` module are removed; the open `data` bag tolerates a leftover `pendingHumanRequest` key (no reader without the tool). <!-- sdd-owner: parent -->
- [ ] Lifecycle gate: follow-up backlog confirmed in Engram (project `houndfe-chatbot`). This slice closes `human-handoff` (#pending in the previous gate). The non-blocking follow-ups tracked at proposal §Follow-up Slices remain open:
  - `R6 shipping-quote approval gate` (Skydropx / Envíos Perros / Amazon check / $120 credit / CDMX free-zone list) — depends on the future shipping slice.
  - `Scheduler-based nudge / expiry` — if the indefinite-wait proves operationally noisy.
  - `Group-channel support` (recipient_type: 'group' + member-identity parsing) — only if the owner insists on a WhatsApp group.
  - `Media forwarding to ops` (forward the customer's product image inside the digest).
  - `Dashboard / HTTP admin` (backend endpoint + minimal admin UI for the ops queue) — heavy; revisit only if WhatsApp-window limits make the WhatsApp-channel UX too painful.
  - `Approved Meta template` (so digests can be sent outside the 24h service window without the ops-on shift-start step) — cost + review cycle; v2 decision.
  Proceeding to `sdd-verify` / archive. <!-- sdd-owner: parent -->

---

## Spec Scenario → Test Task Mapping

| Spec delta | Test task(s) |
|---|---|
| human-handoff: `HumanHandoffKind` union (4 members incl. reserved `shipping_approval`) | T1.1 + T1.2 |
| human-handoff: `human_handoff_requests` migration (table + `(status, created_at)` index) | T1.7 + T1.8 + T7.4 |
| human-handoff: `HumanHandoffDigest` / `HumanHandoffResolution` discriminated unions | T1.1 + T1.2 |
| human-handoff: `HumanHandoffStore` port (4 CRUD primitives) | T1.3 + T1.4 + T1.5 + T1.6 |
| human-handoff: `HumanHandoffService.create` (row + digest + notice + marker) | T2.3 + T2.4 |
| human-handoff: idempotent re-call returns existing ref | T2.3(b) + T2.4 + T2.5(b) |
| human-handoff: disabled kill-switch returns `disabled` | T2.3(c) + T2.4 + T3.7 + T3.8 |
| human-handoff: byte-identical `UNDER_REVIEW_NOTICE` literal | T2.3(a) + T2.4 |
| human-handoff: `resolveReply` parses ref + falls back to newest-pending | T2.3(d–h) + T2.4 |
| human-handoff: `isOpsSender` (sandbox trunk-1 normalization) | T2.3(i) + T2.4 |
| human-handoff: synthetic-turn injection through runner | T5.3(a,h) + T5.4 + T4.5(c) |
| human-handoff: no scheduler / no proactive sends | T5.3(a–g) + T5.4 |
| human-handoff: 12th tool `requestHumanAssistance` (discriminated union + idempotency) | T2.5 + T2.6 + T2.11 + T2.12 |
| human-handoff: trigger tools don't call handoff service directly | T6.1(c) + T6.3(c) |
| conversation-store: `PendingHumanRequest` type + `pendingHumanRequest?` field | T4.1 + T4.2 + T4.3 + T4.4 |
| conversation-store: `readPendingHumanRequest` pure helper | T4.3 + T4.4 |
| conversation-store: marker preserved through data-replacing update | T4.5(c,e) + T4.6 |
| conversation-store: idle reset preserves the marker | T4.5(e) + T4.6 |
| llm-agent: runner short-circuit (no llm / costGuard / store write) | T4.5(a,b) + T4.6 |
| llm-agent: fresh-state spread write (ADR-28) | T4.5(c,d) + T4.6 |
| llm-agent: `toolsContext.requestHumanAssistance.senderId` | T4.7 + T4.8 |
| sale-flow-tools: 12-tool registry | T2.9 + T2.10 + T2.11 + T2.12 |
| sale-flow-tools: `requestHumanAssistance` inputSchema rejects malformed / `shipping_approval` | T2.5(c,d) + T2.6 |
| sale-flow-tools: `disabled` / `validation` kinds for the new tool | T2.3(c) + T2.4 + T3.7 + T3.8 |
| sale-flow-tools: `checkStock` `humanAssistance` envelope on `out_of_stock` | T6.1 + T6.2 |
| sale-flow-tools: `evaluateCart` `humanAssistance` envelope on `needs_human_review` | T6.3 + T6.4 |
| sale-flow-tools: `SALE_FLOW_INSTRUCTIONS` step 16 (R14) + edits to steps 5/8/11 + awaiting-human posture | T6.5 + T6.6 |
| sale-flow-tools: byte-identical preserved strings | T6.5(e) + T6.6 |
| whatsapp-webhook: `WebhookMetadataDto` + `InboundMessage.receivingPhoneNumberId` | T5.1 + T5.2 |
| whatsapp-webhook: ops pre-routing hook (routes to `resolveReply` before runner) | T5.3(a,b,e,f,g) + T5.4 |
| whatsapp-webhook: pending-marker short-circuit sends canned reply | T5.3(c) + T5.4 |
| whatsapp-webhook: synthetic-turn injection through runner | T5.3(a,h) + T5.4 + T4.5(c) |
| whatsapp-webhook: ops inbound deduped + echo-filtered unchanged | T5.3(e,f) + T5.4 |
| whatsapp-webhook: dispatcher order asserted | T5.3(g) + T5.4 |
| app-config: `OPS_CHANNEL_PHONE` (required when enabled, optional when disabled) | T3.1 + T3.2 |
| app-config: `HUMAN_HANDOFF_ENABLED` (boolean, default true) | T3.1 + T3.2 |
| app-config: `humanHandoff` config block shape | T3.3 + T3.4 |
| app-config: service reads typed config (not `process.env`) | T3.7 + T3.8 |

---

## Review Workload Forecast (recap)

Estimated changed lines: **~2680** (production ~1300 incl. ~80 deletions; tests ~1200 incl. ~30 deletions; docs ~150; migration ~30; spec deltas pre-authored and excluded). Chained PRs recommended: **No** (single-developer branch + 3 commits + single PR to main — NOT chained PRs). 400-line budget risk: **High** (~6.7× the limit). Decision needed before apply: **No** (user preflight locked `single-pr`; size-exception is the agreed mitigation; do NOT propose chained PRs).

## Tasks summary

Total tasks: **63** (61 implementation, 2 parent lifecycle gates). Pre-resolved `[x]`: 6 (Phase 0 — spec artifacts). Closed during apply: 28 (T4.1–T4.8, T5.1–T5.6, T6.1–T6.6, T7.1/T7.2/T7.3/T7.5/T7.6/T7.7, T8.2, T8.3). Open `[ ]`: 29 — T7.4 (migration run, needs a live DB), T8.4 (merge to main, user-owned push), 2 parent lifecycle gates.
