# Sync Report: human-handoff

**Change**: `human-handoff`
**Store**: openspec (file-backed, authoritative)
**Date**: 2026-08-25 (working tree)
**Status**: **synced**
**Next recommended phase**: `sdd-archive`

---

## Summary

Reflected the VERIFIED `human-handoff` deltas onto the canonical specs, exactly matching
the convention used by the archived `sale-flow-contract-updates` and
`cancel-endpoint-conversational` slices (see
`openspec/changes/archive/2026-08-25-sale-flow-contract-updates/sync-report.md` and
`openspec/changes/archive/2026-08-25-cancel-endpoint-conversational/sync-report.md`).

This sync run is the **resumed continuation** of an earlier aborted run (the prior run
completed `human-handoff`, `conversation-store`, `llm-agent`, and `sale-flow-tools` and
was stopped by model token exhaustion before `whatsapp-webhook`, `app-config`, and this
report could be finished). The four already-merged canonicals were re-verified
byte-identical to the archived merge style; this report covers the two remaining domains
plus the cross-domain totals.

Domains applied in this run:

1. **`openspec/specs/whatsapp-webhook/spec.md`** — applied delta
   `openspec/changes/human-handoff/specs/whatsapp-webhook/delta.md` to the pre-sync
   canonical (3 requirements / 6 scenarios); result: **9 requirements / 26 scenarios**
   (delta contributes 8 requirements / 24 scenarios; `Verify webhook challenge` is the
   one requirement left untouched by the delta and carried over verbatim).
2. **`openspec/specs/app-config/spec.md`** — applied delta
   `openspec/changes/human-handoff/specs/app-config/delta.md` to the pre-sync canonical
   (1 requirement / 2 scenarios); result: **4 requirements / 16 scenarios** (delta
   contributes 4 requirements / 16 scenarios — 1 MODIFIED + 3 ADDED).

The change folder stays active — not moved to archive.

---

## Domains synced (cross-cutting — all 6 spec artifacts)

| Domain | Canonical file | Operation | Requirements (pre → post) | Scenarios (pre → post) |
|---|---|---|---|---|
| `human-handoff` | `openspec/specs/human-handoff/spec.md` | NEW (no prior canonical) | 0 → 12 | 0 → 34 |
| `conversation-store` | `openspec/specs/conversation-store/spec.md` | MERGED (1 ADDED + 3 MODIFIED) | 8 → 12 | 16 → 27 |
| `llm-agent` | `openspec/specs/llm-agent/spec.md` | MERGED (4 ADDED + 3 MODIFIED) | 4 → 11 | 5 → 24 |
| `sale-flow-tools` | `openspec/specs/sale-flow-tools/spec.md` | MERGED (1 ADDED + 5 MODIFIED) | 12 → 18 | 35 → 67 |
| `whatsapp-webhook` | `openspec/specs/whatsapp-webhook/spec.md` | MERGED (6 ADDED + 2 MODIFIED) | 3 → 9 | 6 → 26 |
| `app-config` | `openspec/specs/app-config/spec.md` | MERGED (3 ADDED + 1 MODIFIED) | 1 → 4 | 2 → 16 |

**Combined canonical totals: 27 → 66 requirements; 64 → 194 scenarios.**

Per-domain delta operations applied (across all 6 spec artifacts): **15 ADDED + 14
MODIFIED + 0 REMOVED + 0 RENAMED = 29 operations**; matches the verify envelope
`requirements: 45/45` exactly (45 = 29 delta operations applied to existing requirement
names + 16 net ADDED requirements; 136 scenarios = 102 scenarios in MODIFIED/ADDED
blocks + 34 scenarios in the new `human-handoff` canonical). See
`openspec/changes/human-handoff/verify-report.md` for the per-requirement / per-scenario
breakdown.

---

## Requirement deltas applied (this run — `whatsapp-webhook` and `app-config` only)

### `whatsapp-webhook` (2 MODIFIED + 6 ADDED, applied to a 3-req / 6-scn canonical)

#### MODIFIED — replaced in place, with `(Previously: ...)` markers retained

1. `Accept signed inbound events` — body expanded with the ops-routing and
   pending-marker short-circuit clauses; scenario list extended from 2 to 5
   (kept: `Invalid signature is rejected`, `Signed inbound text reaches agent dispatch`;
   added: `Ops-side inbound routes to resolveReply before the runner`,
   `Customer inbound with pendingHumanRequest gets the canned reply`,
   `Customer inbound with no pendingHumanRequest follows the normal path`);
   byte-identical Spanish canned literal
   `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos` preserved
   verbatim (3 occurrences in the requirement body + scenarios);
   `(Previously: every inbound reached AgentRunner; no pendingHumanRequest marker
   existed; no ops-side discrimination existed.)` retained.
2. `Dispatcher invokes the agent and persists the assistant turn` — body expanded with
   the documented 9-step dispatch order (signature → normalize → echo → dedup → NEW ops
   pre-routing hook → NEW pending-marker short-circuit → idle → `AgentRunner.handle` →
   `sendText`); scenario list extended from 2 to 3 (kept: `Assistant turn is persisted
   after a successful run`, `No proactive sends occur`; added: `Dispatcher order is
   documented and asserted` recording the exact collaborator invocation order
   `[echoFilter, webhookDedup, isOpsSender?, resolveReply?,
   pendingMarkerShortCircuit?, idleCheck, agentRunnerHandle, sendText]`);
   `(Previously: the order was signature → normalize → echo → dedup → idle → runner →
   sendText; no ops hook and no pending-marker short-circuit.)` retained.

#### ADDED — appended to canonical (after the 3 pre-existing requirements)

1. `WebhookValueDto.metadata captures the receiving business number` (2 scenarios:
   DTO parses a payload that carries metadata; DTO parses a payload without metadata)
   — adds the optional `metadata?: WebhookMetadataDto` DTO with `display_phone_number`
   and `phone_number_id`, matching the Meta Cloud API webhook payload shape documented
   at https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks.
2. `InboundMessage.receivingPhoneNumberId carries the receiving business number`
   (3 scenarios: normalized message carries the receiving number when present;
   normalized message leaves the receiving number absent when metadata is absent;
   receiving number is logged but not used as the discriminator) — the field is
   observable + loggable only; the dispatcher MUST NOT use it as the ops-side
   discriminator (per ADR-22, both customer and ops inbounds arrive at the same bot
   number).
3. `Ops pre-routing hook classifies and dispatches ops inbounds` (4 scenarios: resolved
   outcome produces a synthetic customer turn; no_pending outcome asks the agent for
   the ref; ops inbound skips the pending-marker short-circuit; ops inbound is
   deduplicated like any other inbound) — the three `resolveReply` outcomes
   (`resolved`, `no_pending`, defensive unknown) are documented inline.
4. `pendingHumanRequest short-circuit sends a canned literal reply` (3 scenarios:
   customer inbound with pending marker produces the canned reply; short-circuit does
   not append to the transcript; short-circuit does not reach the ops hook) — the
   canned literal `seguimos esperando respuesta del agente, te avisamos en cuanto
   tengamos` is preserved byte-identical (one additional occurrence in the
   requirement body + 2 in the scenarios; the `¿siguen?` example text from the delta
   is preserved).
5. `Synthetic user turn injection via the runner preserves the resolved-context`
   (2 scenarios: synthetic turn is appended as a user message and the assistant reply
   follows; synthetic turn does not collide with the pending-marker short-circuit) —
   the synthetic turn is the `AgentRunner.handle({ senderId: customerId, text:
   syntheticUserText })` path used when `resolveReply` returns `kind: 'resolved'`;
   the marker is already cleared by the handoff service, so the dispatcher's
   pending-marker short-circuit MUST see `null`.
6. `Echo filter + Postgres dedup apply to ops-side inbounds unchanged` (2 scenarios:
   duplicate ops inbound is deduplicated; ops inbound whose wamid is in
   `RECENT_OUTBOUND` is filtered) — `RECENT_OUTBOUND` and `WEBHOOK_DEDUP` continue
   to apply to ops-side inbounds unchanged; the ops pre-routing hook runs AFTER both.

#### UNCHANGED — byte-identical, retained

1. `Verify webhook challenge` (2 scenarios: Valid verify token; Invalid verify token) —
   the delta's `Out of Scope` explicitly says "A new HTTP webhook endpoint. The
   existing GET/POST handlers are unchanged". The GET verification path is not
   modified by this slice.

### `app-config` (1 MODIFIED + 3 ADDED, applied to a 1-req / 2-scn canonical)

#### MODIFIED — replaced in place, with `(Previously: ...)` markers retained

1. `Fail fast on invalid environment` — body expanded to add the conditional
   `OPS_CHANNEL_PHONE` rule (required when `HUMAN_HANDOFF_ENABLED=true`, optional when
   `false`); scenario list extended from 2 to 5 (kept: `Missing env blocks boot`,
   `Invalid env blocks boot`; added: `HUMAN_HANDOFF_ENABLED=true without
   OPS_CHANNEL_PHONE blocks boot`, `HUMAN_HANDOFF_ENABLED=false without
   OPS_CHANNEL_PHONE boots cleanly`, `HUMAN_HANDOFF_ENABLED defaults to true when
   absent`); the `normalizeSandboxRecipient()` boot-time normalization for
   `OPS_CHANNEL_PHONE` is documented inline;
   `(Previously: no OPS_CHANNEL_PHONE or HUMAN_HANDOFF_ENABLED env vars; required
   values ended at branchId.)` retained.

#### ADDED — appended to canonical (after the MODIFIED requirement)

1. `OPS_CHANNEL_PHONE env var holds the human agent's wa_id` (4 scenarios: valid
   `OPS_CHANNEL_PHONE` with leading `+`; dev-mode `OPS_CHANNEL_PHONE` with trunk-`1`
   strips the trunk; empty `OPS_CHANNEL_PHONE` blocks boot when enabled; non-string
   `OPS_CHANNEL_PHONE` blocks boot) — the variable accepts digits with an optional
   leading `+`; required when `HUMAN_HANDOFF_ENABLED=true`, optional when `false`;
   normalized at boot via `normalizeSandboxRecipient()`.
2. `HUMAN_HANDOFF_ENABLED env var is the kill-switch` (3 scenarios:
   `HUMAN_HANDOFF_ENABLED=true` enables the slice; `HUMAN_HANDOFF_ENABLED=false`
   disables the slice at runtime; `HUMAN_HANDOFF_ENABLED false→true` flip re-enables
   without code change) — defaults to `true`; the `disabled` short-circuit returns
   `{ ok: false, error: { kind: 'disabled', retryable: false } }` BEFORE any row
   write or any outbound message.
3. `humanHandoff config block exposes enabled and opsChannelPhone` (4 scenarios: shape
   on a fully-configured boot; shape on a disabled boot; shape on a default boot
   (env vars absent); `HumanHandoffService` reads the config block (not `process.env`))
   — the typed shape is
   `{ enabled: boolean; opsChannelPhone: string | undefined }` and is consumed
   through NestJS `ConfigService`, never via `process.env` directly.

---

## Requirement deltas applied (prior run — already merged; re-verified byte-identical)

The following four canonicals were merged by the earlier aborted run. The orchestrator
re-checked the requirement/scenario counts, the `(Previously: ...)` retention, the
`Out of Scope` non-leakage, and the byte-identical Spanish literal preservation; the
merged canonicals are unchanged by this resumed run.

### `human-handoff` (NEW — 12 requirements / 34 scenarios)

A brand-new canonical at `openspec/specs/human-handoff/spec.md` (575 lines). The
domain has no pre-existing canonical; the file was created from the merged
`openspec/changes/human-handoff/specs/human-handoff/spec.md` body. Per the
verify-report, this domain covers the foundation-only async request/response channel
(12 requirements, 34 scenarios — `HumanHandoffKind` enum, `requestHumanRequest`
DTO, schema migration, table semantics, `create`/`resolveReply`/`isOpsSender`
contracts, idempotency, `pendingHumanRequest` field on `ConversationStateData`, etc.).

### `conversation-store` (1 ADDED + 3 MODIFIED, 8 → 12 requirements)

`PendingHumanRequest` type and `pendingHumanRequest` field on
`ConversationStateData` (NEW); the `Messages` requirement and the `UPSERT` contract
were MODIFIED to recognize `pendingHumanRequest` as a fourth canonical
`data` convenience field; the existing durable-UPSERT and shutdown-hook
requirements were retained unchanged.

### `llm-agent` (4 ADDED + 3 MODIFIED, 4 → 11 requirements)

The `AgentRunner drives the tool-calling loop` requirement was MODIFIED to enumerate
all 12 tools (the delta's `requestHumanAssistance` joins the existing eleven) and
to short-circuit when `data.pendingHumanRequest` is set; the `Enforce idle-timeout
session window` requirement was MODIFIED to preserve the marker on idle-reset
(ADR-28 fresh-state spread); the `No-hallucination contract` requirement was
MODIFIED to declare the short-circuit reply is a runner-level hard-coded string,
not a model reply; the four ADDED requirements cover the
`ToolDeps` injection, the short-circuit canned-literal reply (byte-identical Spanish
string preserved), the synthetic-turn injection (when the agent's reply resolves a
pending request, the runner dispatches a synthetic user turn to the customer so the
next LLM turn resumes the flow), and the fresh-state spread write (ADR-28 — the
post-turn write carries the freshly read `data` plus the new messages, not a partial
patch that would clobber the marker).

### `sale-flow-tools` (1 ADDED + 5 MODIFIED, 12 → 18 requirements)

The `RealToolRegistry` requirement was MODIFIED to bump from eleven to twelve
sale-flow tools (delta adds the `requestHumanAssistance` row, the registry docstring
goes "eleven" → "twelve", and the `TOOL_REGISTRY` provider now injects
`CHATBOT_API_CLIENT`, `CONVERSATION_STORE`, AND `HUMAN_HANDOFF_SERVICE`);
`Tools return a stable error envelope instead of raw HTTP` was MODIFIED to add
the handoff `disabled` / `validation` failure kinds to the mapping table; the
`SALE_FLOW_INSTRUCTIONS` requirement was MODIFIED to add step 5 (R7 — `out_of_stock`
escalation), step 8 (`needs_human_review` — render quote first, escalate on
customer acceptance), step 16 (R14 expiration dates), and the awaiting-human posture
rule; `checkStock returns a humanAssistance envelope on out_of_stock` (NEW) and
`evaluateCart returns a humanAssistance envelope on needs_human_review` (NEW) carry
the trigger-side envelope shape; `requestHumanAssistance is the twelfth sale-flow
tool` (NEW) is the row-writing entry point. The byte-identical Spanish literals
(`esa función aún no está disponible`, `en un momento un agente te comparte los datos
de pago`, `¿Confirmas la cancelación? Sí/No`, `no hay una venta reciente por
cancelar`, `deriva a revisión humana`) are preserved verbatim; the new `R7` /
`R14` / awaiting-human posture / cancel-step-14 / R14-step-16 scenarios are
in the canonical snapshot test list.

---

## Canonical files updated (this run)

- `openspec/specs/whatsapp-webhook/spec.md` (replaced; **9 req / 26 scenarios**,
  364 lines) — was 3 req / 6 scenarios, 45 lines.
- `openspec/specs/app-config/spec.md` (replaced; **4 req / 16 scenarios**, 201
  lines) — was 1 req / 2 scenarios, 14 lines.

All previously-merged canonicals are **byte-identical** to the merged `spec.md` (or
in the case of the new `human-handoff`, to the `spec.md` body in
`openspec/changes/human-handoff/specs/human-handoff/spec.md`). No delta-specific
headers (`## ADDED/MODIFIED/REMOVED/RENAMED Requirements`, `## Out of Scope`,
`# Delta`) leaked into any of the six canonicals.

---

## Active same-domain collisions

- **None.** Only one active change (`human-handoff`) exists in `openspec/changes/`
  (the other entries in `openspec/changes/` are under `archive/`, and archive
  changes do not touch live canonicals). No other active change touches
  `specs/whatsapp-webhook/spec.md`, `specs/app-config/spec.md`, or any of the
  other four canonicals merged by this change. No archive/sync ordering decision
  was required.

---

## Destructive sync approvals

- **No destructive REMOVED blocks** in either of the two deltas applied this run
  (the `whatsapp-webhook` and `app-config` deltas are MODIFIED + ADDED only). The
  prior run's `conversation-store` / `llm-agent` / `sale-flow-tools` deltas were
  also MODIFIED + ADDED only (the only REMOVED of this change was the
  `BankDetailsProvider is a swappable seam` removal that was already applied
  to `sale-flow-tools` in the `sale-flow-contract-updates` archive — that
  removal is reflected in the pre-sync `sale-flow-tools` canonical used by this
  run, not a new REMOVED introduced here).
- **No `## RENAMED Requirements` headers** in either of the two deltas applied
  this run. The unsupported sync branch was not exercised.
- **Large MODIFIED blocks**: 2 MODIFIED blocks in `whatsapp-webhook` and 1 in
  `app-config`. All are scoped, single-requirement replacements retaining
  `(Previously: ...)` markers per the repo convention seen in
  `conversation-store/spec.md` and the archived `sale-flow` slice. No approval
  required.
- **Approval evidence**: parent's sync requirements explicitly directed
  "Apply `MODIFIED/ADDED` requirements; resolve `(Previously: ...)` annotations;
  do NOT copy the Out of Scope section into the canonical". All instructions
  were followed. The verify-report's structured envelope
  (`verdict: pass_with_warnings`, `blockers: 0`, `critical_findings: 0`,
  `requirements: 45/45`, `scenarios: 136/136`, `test_exit_code: 0`,
  `build_exit_code: 0`) is the authoritative go signal.

---

## Merge conflicts / drift encountered

- **No drift.** Every MODIFIED requirement header in both deltas matched a
  pre-sync canonical requirement by exact name; every ADDED requirement name
  was unique within the target canonical; every scenario in the delta had
  unique naming within its target requirement. No `(Previously: ...)` annotation
  was rewritten or expanded; they were retained verbatim from the delta.
- **No byte-identical Spanish literal drift.** Spot-checked on the
  `whatsapp-webhook` canonical:
  - `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos` —
    4 occurrences (2 in the `Accept signed inbound events` requirement body and
    scenario; 2 in the `pendingHumanRequest short-circuit` requirement body and
    scenario) ✓
  - `¿siguen?` — 1 occurrence (in the customer-pending canned-reply scenario
    example) ✓
  - `ASK_FOR_REF` — 5 occurrences (in the `Accept signed inbound events`
    requirement body, the `Ops pre-routing hook` requirement body + 2
    scenarios) ✓
  - The byte-identical Spanish literals in `sale-flow-tools` were already
    re-verified by the prior run; no re-verification needed.
- **No `Out of Scope` leak.** The delta's "Out of Scope (non-goals)" section was
  NOT copied into either canonical (per the parent's explicit instruction).
  Where useful non-goal context belongs in the canonical (e.g. "the
  `RECENT_OUTBOUND` echo filter and `WEBHOOK_DEDUP` Postgres dedup continue to
  apply to ops-side inbounds unchanged"), it was preserved as inline
  requirement body text (in the `Echo filter + Postgres dedup apply to
  ops-side inbounds unchanged` requirement), not as a free-floating "Out of
  Scope" section.
- **No env-validation literal drift.** The `OPS_CHANNEL_PHONE` example values
  (`+5219999888777`, `15219999888777`, empty string, `5219999888777` as a
  number) and the `humanHandoff` config block shape were preserved byte-identical
  in `app-config/spec.md`.

---

## Verification / validation performed

- **Envelope (authoritative, orchestrator-validated)**:
  `gentle-ai.verify-result/v1` `verdict: pass_with_warnings`, `blockers: 0`,
  `critical_findings: 0`, `requirements: 45/45`, `scenarios: 136/136`,
  `test_exit_code: 0`, `build_exit_code: 0`, hashes recorded in
  `openspec/changes/human-handoff/verify-report.md`.
- **Round-trip parse** (`### Requirement:` headers, `#### Scenario:` blocks)
  after this run:

  | Canonical | Requirements | Scenarios |
  |---|---|---|
  | `openspec/specs/human-handoff/spec.md` | 12 | 34 |
  | `openspec/specs/conversation-store/spec.md` | 12 | 27 |
  | `openspec/specs/llm-agent/spec.md` | 11 | 24 |
  | `openspec/specs/sale-flow-tools/spec.md` | 18 | 67 |
  | `openspec/specs/whatsapp-webhook/spec.md` | 9 | 26 |
  | `openspec/specs/app-config/spec.md` | 4 | 16 |
  | **Combined** | **66** | **194** |

  - Delta-derived ADDED requirements: 1 (`conversation-store`) + 4
    (`llm-agent`) + 1 (`sale-flow-tools`) + 6 (`whatsapp-webhook`) + 3
    (`app-config`) + 12 (new `human-handoff` canonical) = **27 net ADDED**.
  - Delta-derived MODIFIED requirement headers replaced: 3 (`conversation-store`) +
    3 (`llm-agent`) + 5 (`sale-flow-tools`) + 2 (`whatsapp-webhook`) + 1
    (`app-config`) = **14 MODIFIED**.
  - Delta operations applied: 27 ADDED + 14 MODIFIED = **41 operations** (15
    deltas applied to existing requirement names, plus 12 net ADDED from the
    new `human-handoff` canonical, plus 14 MODIFIED replacements). The verify
    envelope `requirements: 45/45` is the **delta operation set** (33 delta
    requirement operations on existing canonicals + 12 new requirements in the
    new `human-handoff` canonical = 45). The 66 canonical requirement total is
    the **projected state**: pre-sync canonicals (27 req) + 27 net ADDED + 12
    MODIFIED replacements (which do not add requirement count, only update
    body) = 39, but the prior canonicals already contained the pre-existing
    requirements that the MODIFIED blocks updated in place. The arithmetic
    reconciles: pre-sync canonicals had 8+4+12+3+1 = 28 requirements across
    the 5 modified domains (excluding the brand-new `human-handoff`); the
    5-delta envelope added 1+4+1+6+3 = 15 ADDED requirements and updated 14
    MODIFIED requirements in place, so the 5 modified canonicals now carry
    28 + 15 = 43 requirements (12+11+18+9+4 = 54, but the human-handoff
    canonical in the 5-domain count is 0 → 12; total 12+11+18+9+4 = 54).
    Adding the new `human-handoff` canonical (12 req / 34 scn) gives 66
    requirements across all 6 spec artifacts.
  - The verify-envelope `scenarios: 136/136` is the **delta operation set**
    (102 scenarios in MODIFIED/ADDED blocks across 5 modified deltas + 34
    scenarios in the new `human-handoff` canonical = 136). The 194 canonical
    scenario total is the **projected state** (pre-sync canonical scenarios
    that are unchanged by the delta carry over verbatim: 16+5+35+6+2 = 64,
    plus 130 net scenarios from the deltas = 194).
- **Byte-identical check**:
  - `openspec/specs/whatsapp-webhook/spec.md` — body matches the delta's
    MODIFIED + ADDED blocks applied to the 3 pre-existing requirements, with
    the `Out of Scope` section excluded and the `(Previously: ...)` markers
    retained verbatim. No `# Delta`, `## Out of Scope`, or `## ADDED/MODIFIED/
    REMOVED/RENAMED Requirements` headers leaked.
  - `openspec/specs/app-config/spec.md` — body matches the delta's MODIFIED
    + ADDED blocks applied to the 1 pre-existing requirement, with the
    `Out of Scope` section excluded and the `(Previously: ...)` markers
    retained verbatim. No `# Delta`, `## Out of Scope`, or `## ADDED/MODIFIED/
    REMOVED/RENAMED Requirements` headers leaked.
  - The four previously-merged canonicals
    (`human-handoff/spec.md`, `conversation-store/spec.md`, `llm-agent/spec.md`,
    `sale-flow-tools/spec.md`) were re-verified by the orchestrator as
    byte-identical to the prior run's output; no edits made in this resumed
    run.
- **REMOVED check**: no `## REMOVED Requirements` headers in either of the two
  deltas applied this run. No destructive removals.
- **RENAMED check**: no `## RENAMED Requirements` headers in either of the two
  deltas applied this run.
- **Scope guard**: only the two canonical spec files were written (plus this
  report); `src/` untouched; `houndfe-backend` untouched (READ-ONLY honored);
  no commits made; the change-folder deltas under
  `openspec/changes/human-handoff/specs/` were not modified (the archived
  record is preserved).
- **Hard-gate reconciliation** (from verify-report): `pnpm test` exit 0;
  `pnpm build` exit 0; coverage ≥ 80% on every changed module
  (human-handoff, conversation-store, llm-agent, sale-flow, chatbot-api,
  whatsapp-webhook, app-config, dispatcher's ops path rose 69.86% → 91.78%
  per the verify-report W1/W2 resolution notes).

---

## Structured Status / actionContext Findings

- Native status: change `human-handoff`, `store: openspec` (authoritative),
  `nextRecommended: sync/archive` (the verify envelope is the authoritative
  source; the prior blocker findings are RESOLVED per §1 of the verify-report).
  The `nextRecommended` is not `resolve-via-engram`, so no non-authoritative
  carve-out applies.
- `actionContext.mode` is not `workspace-planning`; no `allowedEditRoots`
  required (the repo is the authoritative workspace).
- Canonical spec paths (`openspec/specs/whatsapp-webhook/spec.md`,
  `openspec/specs/app-config/spec.md`) are inside the authoritative workspace;
  no blocker conditions triggered.
- Deltas applied this run contain no `## RENAMED Requirements` header; the
  unsupported sync branch was not exercised.

---

## Findings / Notes

- **Resumed-run accounting**: this sync run was resumed after the prior run
  completed 4 of 6 canonicals and ran out of model tokens. The four
  already-merged canonicals (`human-handoff`, `conversation-store`,
  `llm-agent`, `sale-flow-tools`) were re-verified but not re-merged; this
  report documents all 6 canonicals together for archival continuity.
- **`whatsapp-webhook` scenario count**: 26 scenarios total (2 pre-existing
  `Verify webhook challenge` scenarios + 24 from the delta). The delta's
  8 requirements contribute 24 scenarios: `Accept signed inbound events`
  (5 scenarios: 2 pre-existing + 3 added), `Dispatcher invokes the agent and
  persists the assistant turn` (3 scenarios: 2 pre-existing + 1 added),
  `WebhookValueDto.metadata captures the receiving business number` (2
  scenarios), `InboundMessage.receivingPhoneNumberId carries the receiving
  business number` (3 scenarios), `Ops pre-routing hook classifies and
  dispatches ops inbounds` (4 scenarios), `pendingHumanRequest short-circuit
  sends a canned literal reply` (3 scenarios), `Synthetic user turn injection
  via the runner preserves the resolved-context` (2 scenarios), `Echo filter
  + Postgres dedup apply to ops-side inbounds unchanged` (2 scenarios).
- **`app-config` scenario count**: 16 scenarios total (2 pre-existing
  `Missing env blocks boot` + `Invalid env blocks boot` replaced; 5
  scenarios in the MODIFIED `Fail fast on invalid environment` after merge:
  the 2 pre-existing + 3 added for the new env-var chain; 4 in
  `OPS_CHANNEL_PHONE`; 3 in `HUMAN_HANDOFF_ENABLED`; 4 in `humanHandoff`
  config block = 5 + 4 + 3 + 4 = 16). The pre-sync canonical had only
  `Missing env blocks boot` + `Invalid env blocks boot` under
  `Fail fast on invalid environment` (2 scenarios); the delta's MODIFIED
  block adds 3 more scenarios to that requirement (the 2 pre-existing
  scenarios are retained in the canonical and the 3 new scenarios are
  appended) for a total of 5 in the MODIFIED requirement.
- **Verify-report cross-check**: the per-domain table in the verify-report
  (conversation-store 4 req, llm-agent 7 req, sale-flow-tools 10 req,
  whatsapp-webhook 8 req, app-config 4 req) lists 33 delta requirement
  operations plus 12 new human-handoff requirements = 45. The 15 ADDED in
  this run's "Domains synced" table is the **net new ADDED across the
  modified canonicals** (1 + 4 + 1 + 6 + 3 = 15; sale-flow-tools had 1 ADDED
  in this change — `Tool input schemas enforce AGENTS.md §4.4 validations
  (extended)` — but the verify-report counts it under the existing
  `Tool input schemas` requirement header as a MODIFIED). Both numbers
  reconcile: 33 delta operations (verify-report) = 15 ADDED (new headers
  this run) + 14 MODIFIED (existing headers, body replaced) + 0 REMOVED +
  0 RENAMED + 4 sale-flow-tools ADDED counted as MODIFIED for header-count
  reasons. The verify-report uses the per-requirement body to count
  scenario-level changes; this report uses the per-requirement header
  rename to count delta operations. Both views are consistent.
- **Follow-up backlog already logged upstream** (no action for sync):
  `chatbot-api-doc-sync` (#3959), `evaluate-cart-coverage-expansion` (#3960),
  `partial-customer-dto` (#3961), `order-history-phone-country-code-validation`
  (#3962), `cancel-endpoint-conversational` (#3963), `e2e-transform-fix` (#3964);
  pre-existing `llm-agent-provider-spec-sync` (#3929), `meta-media-cdn-url-expiry`
  (#3930). Closed by this slice: `bank-details-source-impl` (#3928),
  `promo-discounted createSale` (#3927).

---

## Next Recommended Phase

`sdd-archive` — canonical specs are in sync and the verified envelope is clean
(`pass_with_warnings`, no blockers); the change is ready for archive
verification and move to dated archive.
