# Sync Report: sale-flow

**Change**: `sale-flow`
**Store**: openspec (file-backed, authoritative)
**Date**: 2026-07-07
**Status**: **synced**
**Next recommended phase**: `sdd-archive`

---

## Summary

Reflected the VERIFIED `sale-flow` delta specs into the canonical specs:

1. **`openspec/specs/sale-flow-tools/spec.md`** — NEW canonical spec created from
   the ADDED-only delta (9 requirements / 19 scenarios).
2. **`openspec/specs/llm-agent/spec.md`** — MERGED canonical spec: 2 MODIFIED
   requirement blocks replaced in place (with `(Previously: ...)` markers retained,
   matching the repo convention seen in `conversation-store/spec.md`), 1 ADDED
   requirement appended, all other requirements preserved byte-identical.

The change folder stays active — not moved to archive.

---

## Domains synced

| Domain | Canonical file | Operation | Requirements | Scenarios |
|---|---|---|---|---|
| `sale-flow-tools` | `openspec/specs/sale-flow-tools/spec.md` | NEW (ADDED-only delta → canonical body) | 9 | 19 |
| `llm-agent` | `openspec/specs/llm-agent/spec.md` | MERGED (2 MODIFIED replaced + 1 ADDED appended) | 8 (was 7) | 11 (was 7) |

Total ADDED requirements across both deltas: **10** (9 sale-flow-tools + 1
llm-agent) — matches the verified envelope `requirements: 10/10`.

## Requirement deltas applied

### `sale-flow-tools` (ADDED — all 9 became canonical requirements)

1. `RealToolRegistry registers the nine sale-flow tools`
2. `Tool input schemas enforce AGENTS.md §4.4 validations`
3. `Tools return a stable error envelope instead of raw HTTP`
4. `Per-sender cart lives in ConversationState.data.cart`
5. `createSale uses list price and a client-generated UUID v4 idempotency key`
6. `BankDetailsProvider is a swappable seam`
7. `SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot`
8. `updateDelivery is registered but not exercised by this slice`
9. `CHATBOT_API_CASHIER_USER_ID is required at boot`

### `llm-agent` (MODIFIED — replaced in place)

1. `AgentRunner drives the tool-calling loop` — replaced with delta text
   (`(Previously: ...)` retained); scenarios updated:
   - `History truncates in memory and tool result round-trips` (updated)
   - `Unknown sender has no state` (new)
2. `No-hallucination contract in the system prompt` — replaced with delta text
   (`(Previously: ...)` retained); scenarios updated:
   - `Refusal phrase and language contract are asserted (base layer)` (updated)
   - `Composed prompt contains all four contract strings (base + slice)` (new)

### `llm-agent` (ADDED — appended at end)

1. `LlmAgentModule resolves the real sale-flow tool set and ChatbotApiClient`
   (2 scenarios: `Production wiring resolves RealToolRegistry with ChatbotApiClient`,
   `Tests can override the tool registry`)

### REMOVED / RENAMED

- REMOVED requirements: **none**
- RENAMED requirements: **none** (unsupported header not present; no block needed)

---

## Canonical files updated

- `openspec/specs/sale-flow-tools/spec.md` (created)
- `openspec/specs/llm-agent/spec.md` (merged)

## Active same-domain collisions

- **None.** Only one active change (`sale-flow`) exists in
  `openspec/changes/`; no other active change touches `specs/sale-flow-tools/`
  or `specs/llm-agent/`. No archive/sync ordering decision was required.

## Destructive sync approvals

- **Not applicable.** The delta contains zero REMOVED requirements and no large
  MODIFIED blocks; both MODIFIED blocks are scoped replacements of a single
  requirement each. No approval was required.

---

## Verification / validation performed

- **Envelope (authoritative, orchestrator-validated)**: `gentle-ai.verify-result/v1`
  `verdict: pass`, `blockers: 0`, `critical_findings: 0`, `requirements: 10/10`,
  `scenarios: 23/23`, `test_exit_code: 0`, `build_exit_code: 0`, hashes recorded.
  The verify-report narrative's per-delta arithmetic (8/17 + 2/6 = 10/23) under-counts
  the sale-flow-tools delta (actual: 9 requirements / 19 scenarios); the **delta files
  are the source of truth** and were synced verbatim. Total ADDED requirements remain
  exactly 10, matching the envelope.
- **Round-trip parse** (`### Requirement:` headers, `#### Scenario:` blocks):
  - `sale-flow-tools/spec.md`: 9 requirements / 19 scenarios
  - `llm-agent/spec.md`: 8 requirements / 11 scenarios
  - Delta-derived ADDED requirements: 9 + 1 = **10** ✓ (matches envelope 10/10)
- **Byte-identical check**:
  - All 9 `sale-flow-tools` ADDED blocks in canonical == delta blocks ✓
  - Both `llm-agent` MODIFIED blocks verbatim in canonical ✓
  - `llm-agent` ADDED block verbatim in canonical ✓
  - All 5 unmodified `llm-agent` requirements byte-identical to the original file ✓
    (header/Purpose unchanged; old MODIFIED bodies absent; new bodies present)
- **No delta-specific headers** leaked into canonicals (no `## ADDED/MODIFIED/REMOVED/
  RENAMED Requirements`, no `## Out of Scope`, no `# Delta`) ✓
- **Scope guard**: only the two canonical spec files written; `src/` untouched;
  `houndfe-backend` untouched (READ-ONLY honored); no commits made ✓

---

## Structured Status / actionContext Findings

- Native status: change `sale-flow`, `store: openspec` (authoritative), next: verify
  (sync executed after orchestrator validated the verify envelope pass).
- `actionContext.mode` is not `workspace-planning`; no `allowedEditRoots` required.
- Canonical spec paths are inside the authoritative workspace
  (`openspec/specs/...`); no blocker conditions triggered.

## Findings / Notes

- **Non-blocking observation**: verify-report narrative counted the sale-flow-tools
  delta as 8 requirements / 17 scenarios, but the delta itself contains 9 requirements /
  19 scenarios. The synced canonicals reflect the delta verbatim (source of truth);
  the envelope total (10 ADDED) is unchanged.
- Follow-up drift already logged upstream: `llm-agent-provider-spec-sync`
  (gateway/AI_GATEWAY_API_KEY vs. shipped openai/OPENAI_API_KEY) remains out of
  scope, as recorded in the llm-agent delta.

---

## Next Recommended Phase

`sdd-archive` — canonical specs are in sync and the verified envelope is clean;
the change is ready for archive verification and move to dated archive.
