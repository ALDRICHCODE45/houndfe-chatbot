# Archive Report: sale-flow

**Change**: `sale-flow`
**Branch**: `main` (uncommitted working tree — no commits yet; commit + PR are the delivery next step)
**Mode**: Strict TDD (`openspec/config.yaml` `testing.strict_tdd: true`, `rules.apply.tdd: true`), OpenSpec
**Verdict**: **PASS**
**Archived**: 2026-08-24 → `openspec/changes/archive/2026-08-24-sale-flow/`
**Engram topic key**: `sdd/sale-flow/archive-report`
**Engram observation ID**: persisted on save (see "Memory Traceability" below)

---

## Summary

Replaced the placeholder `InMemoryToolRegistry` (`getCurrentTime`-only) with `RealToolRegistry`
that registers the nine AGENTS.md §4.4 chatbot-api tools (`searchCatalog`, `checkStock`,
`evaluateCart`, `getCustomerByPhone`, `upsertCustomer`, `createSale`, `attachReceipt`,
`updateDelivery`, `getOrderHistory`) as AI-SDK `tool()` + Zod objects backed by the existing
`ChatbotApiHttpClient` + `ConversationStore`. Added a new `SaleFlowModule` (`src/sale-flow/…`)
imported by `LlmAgentModule`, a per-sender cart at `ConversationState.data.cart`, a swappable
`BankDetailsProvider` seam (default `null` → human-handoff phrase), client-side UUID v4
idempotency for `createSale`, list-price enforcement (never `finalPriceCents`), and a one-shot
boot prompt composition (`SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS`) consulted via a
new `LLM_AGENT_SYSTEM_PROMPT` token. Two deltas — **`sale-flow-tools` NEW** (9 ADDED
requirements / 19 scenarios) and **`llm-agent` MODIFIED** (2 MODIFIED + 1 ADDED requirements /
6 scenarios) — sync cleanly into canonicals; envelope totals 12/12 requirements, 25/25
scenarios, all test/build/lint commands green. Single-PR delivery is the user's accepted
size-exception; bounded review is deferred to delivery per the explicit decision recorded in
`tasks.md`.

---

## Verification Evidence (authoritative envelope)

```yaml
schema: gentle-ai.verify-result/v1
verdict: pass
blockers: 0
critical_findings: 0
requirements: 12/12
scenarios: 25/25
test_command: pnpm test
test_exit_code: 0
build_command: pnpm build
build_exit_code: 0
```

Delta-file arithmetic (source of truth — see "Spec arithmetic note" below):

| Delta | ADDED | MODIFIED | REMOVED | Scenarios |
|-------|------:|---------:|--------:|----------:|
| `sale-flow-tools` | 9 | 0 | 0 | 19 |
| `llm-agent`       | 1 | 2 | 0 |  6 |
| **Totals**        | **10** | **2** | **0** | **25** |

ADDED requirements across both deltas: 10 (matches envelope `requirements: 12/12` after
accounting for the 2 MODIFIED replacements keeping their original requirement count — see
"Spec arithmetic note" below).

### Build & Tests Execution

| Command | Result |
|---------|--------|
| `pnpm test` | PASS — 40 suites passed + 2 SKIPPED (Postgres/Testcontainers); 259 passed + 16 SKIPPED = 275 |
| `pnpm test:cov` | PASS — global 89.38% stmts / 89.4% lines; `src/sale-flow/**` 100%, `src/config/**` 100%, changed `src/llm-agent/**` ≥80% (module/domain/infrastructure-provider 100%; `agent-runner.service.ts` 97.22%; `vercel-ai-llm-agent.ts` 84.61%) |
| `pnpm build` (`nest build` / tsc) | PASS — exit 0, clean |
| Scoped lint `pnpm exec eslint src/sale-flow src/llm-agent src/config` | 7 pre-existing errors in `src/llm-agent` (documented repo-wide-broken baseline); **0 new from this slice**; `src/sale-flow` + `src/config` 0 errors |
| Consumer-only + no-migration | `git diff --stat` shows zero production changes under `src/chatbot-api/**`, `src/conversation/**`, `src/app.module.ts`; `in-memory-tool-registry.ts` kept as test fixture (only trailing-newline formatting diff, semantically untouched); no new migrations |

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 46 (T1.1–T8.5 = 44 implementation + 2 parent lifecycle gates) |
| Tasks checked `[x]` | **46 / 46** |
| Tasks unchecked `[ ]` | **0** |
| `apply-progress.md` present | YES (with `TDD Cycle Evidence` table — 22 RED→GREEN TDD cycle rows + full-suite verification table) |

### Spec arithmetic note (delta files = source of truth)

The verify-report narrative originally undercounted the `sale-flow-tools` delta at 8/17; the
delta file actually contains 9 requirements / 19 scenarios. The corrected envelope totals are
**12 requirements / 25 scenarios** (measured from `openspec/changes/sale-flow/specs/*/spec.md`).
The verify envelope above was re-validated by the orchestrator and is authoritative.

---

## Specs Synced → `openspec/specs/`

Per `sync-report.md` (file-backed sync executed before archive; archived alongside this
report for audit):

| Domain | Canonical file | Action | Final Req / Scen |
|--------|----------------|--------|------------------|
| `sale-flow-tools` | `openspec/specs/sale-flow-tools/spec.md` | **NEW** (ADDED-only delta → full canonical body) | 9 / 19 |
| `llm-agent` | `openspec/specs/llm-agent/spec.md` | **MERGED** (2 MODIFIED replaced + 1 ADDED appended; 5 unchanged requirements preserved byte-identical) | 8 / 11 (was 7 / 7) |

### ADDED requirement names

**`sale-flow-tools` (9 ADDED — all became canonical requirements):**

1. `RealToolRegistry registers the nine sale-flow tools`
2. `Tool input schemas enforce AGENTS.md §4.4 validations`
3. `Tools return a stable error envelope instead of raw HTTP`
4. `Per-sender cart lives in ConversationState.data.cart`
5. `createSale uses list price and a client-generated UUID v4 idempotency key`
6. `BankDetailsProvider is a swappable seam`
7. `SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot`
8. `updateDelivery is registered but not exercised by this slice`
9. `CHATBOT_API_CASHIER_USER_ID is required at boot`

**`llm-agent` (1 ADDED — appended):**

1. `LlmAgentModule resolves the real sale-flow tool set and ChatbotApiClient`
   (with 2 scenarios: `Production wiring resolves RealToolRegistry with ChatbotApiClient`,
   `Tests can override the tool registry`)

### MODIFIED requirement names

**`llm-agent` (2 MODIFIED — replaced in place, `(Previously: ...)` markers retained per the
repo convention seen in `conversation-store/spec.md`):**

1. `AgentRunner drives the tool-calling loop` — relaxed from "MUST supply at least one
   placeholder (`getCurrentTime`)" to "MUST supply the real sale-flow tool set bound from
   `RealToolRegistry`, MUST inject `CHATBOT_API_CLIENT` and `CONVERSATION_STORE`,
   placeholder MAY remain as a test fixture but MUST NOT be the production binding".
2. `No-hallucination contract in the system prompt` — extended to assert the four composed-
   prompt contract strings (refusal phrase, forbidden-slang block, 14-step escrow flow,
   list-price-only rule) and the composition-once contract at boot (not per-turn override).

### REMOVED / RENAMED requirement names

- **REMOVED**: 0 (the `## REMOVED Requirements` header in `llm-agent/delta.md` is the literal
  text `None.`; nothing was deleted from the canonical `llm-agent` spec).
- **RENAMED**: 0 (`## RENAMED Requirements` is unsupported in `openspec-deltas` until
  executable rename semantics land; no header present in either delta).

### Active same-domain collisions

- **None.** `sale-flow` is the only active change under `openspec/changes/` at archive time.
  No other change touches `specs/sale-flow-tools/` or `specs/llm-agent/`. No archive/sync
  ordering decision was required.

### Destructive sync approvals

- **Not applicable.** The delta contains zero REMOVED requirements and no large MODIFIED
  blocks; both MODIFIED blocks are scoped replacements of a single requirement each (relaxed
  text + `(Previously: ...)` retained). No approval required.

---

## What Was Delivered (code, by phase)

Per `tasks.md` + `apply-progress.md` (strict TDD, RED → GREEN → refactor where applicable):

| Phase | Surface | Files (representative) |
|-------|---------|------------------------|
| 1 — Config | `CHATBOT_API_CASHIER_USER_ID` (Joi `uuid` required) + `chatbotApi.cashierUserId` surface | `src/config/env.validation.ts`, `src/config/configuration.ts`, corresponding `*.spec.ts` |
| 2 — Domain | cart-state (`CartItem` / `CartState` / `EMPTY_CART` / `readCart` / `writeCart`); bank-details port + null impl; `SALE_FLOW_INSTRUCTIONS` literal + `composeSaleFlowSystemPrompt`; tool-result types | `src/sale-flow/domain/{cart-state,sale-flow-instructions,bank-details.provider,tool-result}.ts` + `infrastructure/null-bank-details.provider.ts` |
| 3 — Application | error envelope (`mapChatbotError`), cart persistence (`persistCart`), tool deps type | `src/sale-flow/application/{error-mapping,cart-persistence,tool-deps}.ts` |
| 4 — The nine tools | one AI-SDK `tool()` factory per AGENTS.md §4.4 endpoint; `createSale` enforces list price + UUID v4 idempotency persist/reuse/clear; `evaluateCart` persists `originalPriceCents` | `src/sale-flow/application/tools/*.tool.ts` (9 files) |
| 5 — RealToolRegistry | `@Injectable() RealToolRegistry implements ToolRegistry` injecting `CHATBOT_API_CLIENT`, `CONVERSATION_STORE`, `BANK_DETAILS_PROVIDER`, `ConfigService`; builds the 9-tool ToolSet once in ctor | `src/sale-flow/infrastructure/real-tool-registry.ts` |
| 6 — SaleFlowModule | imports `ChatbotApiModule` + `ConversationModule`; provides `RealToolRegistry` + `BANK_DETAILS_PROVIDER` (null default); exports both | `src/sale-flow/sale-flow.module.ts` |
| 7 — llm-agent integration | `LLM_AGENT_SYSTEM_PROMPT` symbol + async factory in `LlmAgentModule`; `useExisting: RealToolRegistry` rebind; `VercelAiLlmAgent` forwards `toolsContext: { senderId }`; `AgentRunner` injects `@Inject(LLM_AGENT_SYSTEM_PROMPT) systemPrompt` (cached at ctor, never overridden at runtime) | `src/llm-agent/{llm-agent.module.ts, domain/system-prompt.ts, infrastructure/vercel-ai-llm-agent.ts, application/agent-runner.service.ts}` |
| 8 — Verification | full suite green, coverage ≥80%, build clean, scoped lint clean | (no code) |

Spec → test trace is recorded in `verify-report.md` (R1–R9 `sale-flow-tools` × multiple
scenarios + `llm-agent` × multiple scenarios), reproduced in the archived `verify-report.md`
for audit.

---

## Risks Carried Forward

From the proposal (`openspec/changes/sale-flow/proposal.md` §Risks) and `verify-report.md`:

| # | Risk | Status / Mitigation |
|---|------|---------------------|
| R-A | **Backend Q2 unresolved** — only list-price `createSale` ships. | Prompt + `create-sale.tool.ts` enforce `unitPriceCents = originalPriceCents`; tests pin this. Follow-up backlog: `promo-discounted-createSale` (Engram obs 3927). |
| R-B | **Backend Q1 unresolved** — bank-details null keeps the bot on a human-handoff phrase. | `BankDetailsProvider` seam ≤ 40 LoC; swap is a single DI binding change. Follow-up backlog: `bank-details-source-impl` (Engram obs 3928). |
| R-C | **400-line budget overrun** (~1500–1700 LoC total). | **Accepted size-exception** by the user in delivery context (single-PR + two reviewable commits: `Wiring+Seams`, `Tools+Cart`). Bounded review deferred to delivery per the parent lifecycle gate. |
| R-D | **Spec drift** — `llm-agent` spec mentions gateway + `AI_GATEWAY_API_KEY`; impl uses openai + `OPENAI_API_KEY`. | Out of scope for this slice. Follow-up backlog: `llm-agent-provider-spec-sync` (Engram obs 3929). |
| R-E | **Cart survives across idle sessions.** | Intentional + safe: `AgentRunner` wipes `messages` in memory after `LLM_IDLE_TIMEOUT_MS`; cart in store means re-`evaluateCart` re-quotes fresh prices; `createSale` on empty cart → `validation` envelope. Spec scenario documents. |
| R-F | **`upsertCustomer.address.street` required by backend** — first-time customers may not have an address. | Bot collects address as part of order data confirmation step. Follow-up when backend relaxes address requirement. |
| R-G | **`evaluateCart` returns `needs_human_review` broadly.** | Prompt rule instructs the bot to surface *"necesito que un agente te confirme el precio final"*; chatbot does not work around backend's coarse rule. |
| R-H | **Extra backend endpoint** — `POST /chatbot-api/sales/:saleId/cancel` exists in backend controller but not in AGENTS.md §4.5 / `ChatbotApiClient`. | Out of scope; explicitly not wired. Awareness only. |

### Minor non-blocking findings (from `verify-report.md`, reproduced for archival)

- `src/config/config.module.ts` added `forRoot({ ignoreEnvFile })` beyond the design's
  modified-file map (test-support only; benign).
- `create-sale.tool.ts` line 148 `void EMPTY_CART;` is a dead-code compile-guard leaving one
  uncovered line; harmless and could be removed in a future tidy-up.
- `vercel-ai-llm-agent.ts` lines 83–86 (`tool`-role `assembleModelMessages` branch) remain
  uncovered (pre-existing, not part of this slice).

---

## Deferred Parent Actions (recorded explicitly)

Per `tasks.md` parent lifecycle rows + `verify-report.md`:

1. **Bounded review** — deferred to **delivery** (single-PR with `size-exception`, two
   reviewable commits: `Wiring+Seams`, `Tools+Cart`). The behaviour-rollback path is
   verified: reverting `TOOL_REGISTRY` from `useExisting: RealToolRegistry` to
   `useClass: InMemoryToolRegistry` in `LlmAgentModule` returns the bot to
   `esa función aún no está disponible` for all sale-flow requests (safe degradation;
   refusal contract holds; no data loss because `ConversationStore` and `chatbot-api` are
   untouched).
2. **Follow-up backlog** — **confirmed** in Engram observations 3927–3930 (project
   `houndfe-chatbot`):
   - `backlog/promo-discounted-createsale` (obs 3927) — R-A
   - `backlog/bank-details-source-impl` (obs 3928) — R-B
   - `backlog/llm-agent-provider-spec-sync` (obs 3929) — R-D
   - `backlog/meta-media-cdn-url-expiry` (obs 3930) — Meta CDN URL expiry when
     `attachReceipt` stores inbound WhatsApp image URL (AGENTS.md §11 item 12)

---

## Delivery Next Step (explicit)

The work is **uncommitted** in the working tree (verified `git status --short` — only
modified/untracked files, no commits). The user has **NOT** asked to commit or open a PR
yet. Per the user's delivery preference:

- Commit on `main` (or the chosen feature branch) with the agreed two-commit split
  (`Wiring+Seams`, `Tools+Cart`) and open the single PR.
- Run a single bounded review pass (deferred from this SDD cycle).
- Merge to ship.

This is the **next step after archive**, not part of this phase. Archive does not commit.

---

## Archive Contents

After the move (`openspec/changes/sale-flow/` → `openspec/changes/archive/2026-08-24-sale-flow/`),
the archive directory contains:

- `proposal.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (46/46 tasks checked; no `- [ ]` implementation lines)
- `apply-progress.md` ✅ (TDD Cycle Evidence table — 22 RED→GREEN cycles)
- `verify-report.md` ✅ (PASS, `gentle-ai.verify-result/v1` envelope valid)
- `sync-report.md` ✅ (canonical specs synced — see "Specs Synced" above)
- `archive-report.md` ✅ (this report)
- `specs/sale-flow-tools/delta.md` ✅ (9 ADDED requirements — preserved as audit trail)
- `specs/sale-flow-tools/spec.md` ✅
- `specs/llm-agent/delta.md` ✅ (2 MODIFIED + 1 ADDED, 0 REMOVED — preserved as audit trail)
- `specs/llm-agent/spec.md` ✅

The change folder has been **moved** (not copied) — the canonical spec sync is complete, the
active path is empty, and the archive is the immutable audit trail per
`openspec/changes/archive/.gitkeep` convention.

---

## Source-of-Truth Updated

- `openspec/specs/sale-flow-tools/spec.md` — NEW canonical (9 requirements / 19 scenarios).
- `openspec/specs/llm-agent/spec.md` — MERGED canonical (8 requirements / 11 scenarios;
  2 MODIFIED replaced + 1 ADDED appended; 5 unchanged requirements preserved byte-identical).

Both canonicals reflect the verified delta files verbatim.

---

## SDD Cycle Complete

The change has been fully **planned** (proposal + design + tasks), **applied** (8 phases,
strict TDD, 22 RED→GREEN cycles; `apply-progress.md` present), **verified** (`verdict: pass`,
envelope `12/12` reqs / `25/25` scenarios, `pnpm test` 259/275 green, `pnpm build` clean,
coverage 89.38% global, all changed files ≥80%, no new lint errors), **synced**
(`openspec/specs/{sale-flow-tools,llm-agent}/spec.md` updated; sync-report.md present and
successful), and **archived** (this report + change moved to
`openspec/changes/archive/2026-08-24-sale-flow/`). The single-PR commit + PR is the user's
delivery next step; bounded review is explicitly deferred to delivery with the accepted
size-exception. Ready for the orchestrator to surface the cycle-complete state to the user.

---

## Memory Traceability

- Archive report saved to Engram with `topic_key: sdd/sale-flow/archive-report`,
  `type: architecture`, `project: houndfe-chatbot`. Observation ID recorded on save.
- Follow-up backlog observations confirmed: 3927, 3928, 3929, 3930 (all
  `project: houndfe-chatbot`, `scope: project`).
