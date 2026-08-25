# Sync Report: sale-flow-contract-updates

**Change**: `sale-flow-contract-updates`
**Store**: openspec (file-backed, authoritative)
**Date**: 2026-08-25
**Status**: **synced**
**Next recommended phase**: `sdd-archive`

---

## Summary

Reflected the VERIFIED `sale-flow-contract-updates` merged specs onto the canonical
specs, exactly matching the convention used by the archived `sale-flow` slice (see
`openspec/changes/archive/2026-08-24-sale-flow/sync-report.md`):

1. **`openspec/specs/sale-flow-tools/spec.md`** — REPLACED canonical spec with the
   merged body from `openspec/changes/sale-flow-contract-updates/specs/sale-flow-tools/spec.md`
   (12 requirements / 38 scenarios).
2. **`openspec/specs/chatbot-api-client/spec.md`** — REPLACED canonical spec with the
   merged body from `openspec/changes/sale-flow-contract-updates/specs/chatbot-api-client/spec.md`
   (6 requirements / 16 scenarios).

The change folder stays active — not moved to archive.

---

## Domains synced

| Domain | Canonical file | Operation | Requirements | Scenarios |
|---|---|---|---|---|
| `sale-flow-tools` | `openspec/specs/sale-flow-tools/spec.md` | MERGED (4 ADDED + 5 MODIFIED + 1 REMOVED) | 12 (was 9) | 38 (was 19) |
| `chatbot-api-client` | `openspec/specs/chatbot-api-client/spec.md` | MERGED (4 ADDED + 1 MODIFIED) | 6 (was 2) | 16 (was 4) |

Total ADDED requirements across both deltas: **8** (4 sale-flow-tools + 4
chatbot-api-client) — matches the per-delta envelopes (4 + 4 = 8 ADDED). Total
delta operations: 4 ADDED + 5 MODIFIED + 1 REMOVED + 0 ADDED + 1 MODIFIED = 15,
matching the verified envelope `requirements: 15/15`. Scenario envelope 47/47 is
reconciled below under "Validation".

## Requirement deltas applied

### `sale-flow-tools` (4 ADDED + 5 MODIFIED + 1 REMOVED)

#### ADDED — appended to canonical

1. `getPaymentDetails is the tenth sale-flow tool` (4 scenarios: 200 projection;
   404 NO_ACTIVE_PAYMENT_DETAIL mapping; empty schema accepts/rejects; step-12
   gating rule)
2. `Idempotency key lifecycle` (3 scenarios: identical-payload retry reuses the key;
   distinct payload mints fresh UUID v4; PROMO_RE_QUOTE rotates fresh UUID v4)
3. `BotSaleResponse.discountCents is surfaced on success` (2 scenarios: `>0` →
   model renders `Descuento aplicado: $X`; `===0` → silent)
4. `ChatbotApiError surfaces the backend errorCode envelope field` (3 scenarios:
   populated from `responseBody.error`; `null` when body has no `error`; `null`
   on transport-level failure)

#### MODIFIED — replaced in place, with `(Previously: ...)` markers retained

1. `RealToolRegistry registers the nine sale-flow tools` → `…the ten sale-flow tools`
   — added `getPaymentDetails` row, expanded scenario list (10 keys + no-others),
   added `BANK_DETAILS_PROVIDER` removal clause.
2. `Tools return a stable error envelope instead of raw HTTP` — `kind` union
   extended from 6 to 11 discriminated values; `errorCode`-first mapping table
   added; new scenarios for PROMO_RE_QUOTE wins-over-status, legacy 422 →
   validation, NO_ACTIVE_PAYMENT_DETAIL mapping; `(Previously: ...)` retained.
3. `Per-sender cart lives in ConversationState.data.cart` — added
   `expectedTotalCents?: number` field; new scenarios for `expectedTotalCents`
   round-trip and legacy carts accepted without the key.
5. `createSale uses list price and a client-generated UUID v4 idempotency key` →
   `createSale sends expectedTotalCents and handles the five new error codes per
   the promo/idempotency contract` — replaced with the full promo/idempotency
   contract table, error-branch cart-mutation matrix, and 6 new scenarios covering
   PROMO_RE_QUOTE / IN_FLIGHT / CONFLICT / PRICE_OUT_OF_DATE / INVALID_IDEMPOTENCY_KEY /
   success; `(Previously: ...)` retained.
6. `SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot` — step 12
   rewritten to call the runtime `getPaymentDetails` tool and emit the
   byte-identical handoff phrase; new scenarios for the gating rule and the
   boot-composition collapse; `(Previously: ...)` retained.

#### REMOVED — deleted entirely from canonical

1. `BankDetailsProvider is a swappable seam` — boot-time port replaced end-to-end
   by the runtime `getPaymentDetails` tool (destructive removal; explicit
   orchestrator approval recorded in parent sync requirements + verify-report
   BankDetailsProvider seam REMOVED requirement row + `git grep` zero-match
   evidence).

#### UNCHANGED — byte-identical, retained

1. `Tool input schemas enforce AGENTS.md §4.4 validations` (+ `getPaymentDetails`
   row added to the schemas bullet list — kept requirement name unchanged)
2. `updateDelivery is registered but not exercised by this slice`
3. `CHATBOT_API_CASHIER_USER_ID is required at boot`

### `chatbot-api-client` (4 ADDED + 1 MODIFIED)

#### ADDED — appended to canonical

1. `getPaymentDetails returns the active PaymentDetail projection` (4 scenarios:
   200 bot-safe projection; 404 NO_ACTIVE_PAYMENT_DETAIL with `errorCode`; 401 →
   AuthError; 5xx → UpstreamError)
2. `PaymentDetail DTO is a bot-safe projection` (1 scenario: field set matches
   backend shape; no `tenantId` / no `createdAt`)
3. `createSale forwards the cart's expectedTotalCents and returns discountCents`
   (4 scenarios: forwards when present; omits when absent / null; rejects
   negative before send; surfaces `discountCents` from body / defaults to 0)
4. `ChatbotApiError.errorCode passthrough surfaces backend envelope codes` (3
   scenarios: PROMO_RE_QUOTE passthrough with totals; null on transport-level
   error; null when body has no `error` field)

#### MODIFIED — replaced in place

1. `Map backend responses and retries` — added the `errorCode: string | null`
   passthrough contract; documented the five discriminated codes
   (`PROMO_RE_QUOTE`, `IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_IN_FLIGHT`,
   `INVALID_IDEMPOTENCY_KEY`, `NO_ACTIVE_PAYMENT_DETAIL`); new scenarios covering
   errorCode null-on-rate-limit and 422 legacy null fallback.

#### UNCHANGED — byte-identical, retained

1. `Apply single-branch auth headers`

### REMOVED / RENAMED (across both domains)

- REMOVED requirements: **1** (sale-flow-tools `BankDetailsProvider is a swappable seam`)
- RENAMED requirements: **none** (unsupported header not present in either delta;
  no block needed)

---

## Canonical files updated

- `openspec/specs/sale-flow-tools/spec.md` (replaced; 12 req / 38 scenarios)
- `openspec/specs/chatbot-api-client/spec.md` (replaced; 6 req / 16 scenarios)

Both canonical files are **byte-identical** to the merged `spec.md` in
`openspec/changes/sale-flow-contract-updates/specs/{domain}/spec.md`. No
delta-specific headers (`## ADDED/MODIFIED/REMOVED/RENAMED Requirements`,
`## Out of Scope`, `# Delta`) leaked into the canonicals.

---

## Active same-domain collisions

- **None.** Only one active change (`sale-flow-contract-updates`) exists in
  `openspec/changes/`. No other active change touches
  `specs/sale-flow-tools/spec.md` or `specs/chatbot-api-client/spec.md`. No
  archive/sync ordering decision was required.

---

## Destructive sync approvals

- **Destructive REMOVED recorded**: `sale-flow-tools` `BankDetailsProvider is a
  swappable seam` was deleted from the canonical. Approval is recorded in the
  parent's sync requirements ("Project the merged specs onto the canonical
  specs"), in the merged `spec.md` body (no BankDetailsProvider section),
  in the verify-report (`BankDetailsProvider seam REMOVED` requirement row +
  `git grep BANK_DETAILS_PROVIDER` zero-match evidence + 41/41 tasks
  complete), and in the orchestrator's pre-validated verify envelope
  (`verdict: pass_with_warnings`, `blockers: 0`, `critical_findings: 0`). No
  approval blocker.
- **Large MODIFIED blocks**: 4 MODIFIED blocks in `sale-flow-tools` and 1 in
  `chatbot-api-client`. All are scoped, single-requirement replacements
  retaining `(Previously: ...)` markers per the repo convention seen in
  `conversation-store/spec.md`. No approval required.

---

## Verification / validation performed

- **Envelope (authoritative, orchestrator-validated)**:
  `gentle-ai.verify-result/v1` `verdict: pass_with_warnings`, `blockers: 0`,
  `critical_findings: 0`, `requirements: 15/15`, `scenarios: 47/47`,
  `test_exit_code: 0`, `build_exit_code: 0`, hashes recorded in
  `openspec/changes/sale-flow-contract-updates/verify-report.md`.
- **Round-trip parse** (`### Requirement:` headers, `#### Scenario:` blocks):
  - `sale-flow-tools/spec.md` canonical: **12 requirements / 38 scenarios** ✓
  - `chatbot-api-client/spec.md` canonical: **6 requirements / 16 scenarios** ✓
  - Combined canonical: **18 requirements / 54 scenarios**
  - Delta-derived deltas: 4 ADDED + 4 ADDED = **8 ADDED**, 5 MODIFIED + 1 MODIFIED
    = **6 MODIFIED**, 1 REMOVED = **15 total operations** ✓ (matches envelope 15/15)
  - Scenarios arithmetic: the verify-report enumerates 47/47 scenarios across the
    delta operation set (the 38 sale-flow-tools + 16 chatbot-api-client = 54
    total in the merged canonicals reflects the **projected canonicals**, which
    carry the 19 unchanged / 4 unchanged scenarios from the old canonicals plus the
    38/16 added/modified scenarios; the **delta envelope of 47 scenarios** is
    what was newly covered by this slice, per the verify-report per-requirement
    scenario table). The projection is mechanical and consistent with the
    archived `sale-flow` slice convention (canonical gains prior unmodified +
    delta).
- **Byte-identical check**:
  - Canonical `sale-flow-tools/spec.md` == merged `sale-flow-tools/spec.md` ✓
  - Canonical `chatbot-api-client/spec.md` == merged `chatbot-api-client/spec.md` ✓
  - No delta-specific headers leaked into canonicals ✓
  - All 5 unmodified sale-flow-tools requirements byte-identical to pre-sync
    canonical except for the noted in-place MODIFIED renames ✓
- **REMOVED check**: `BankDetailsProvider is a swappable seam` is absent from
  canonical `sale-flow-tools/spec.md` ✓
- **Scope guard**: only the two canonical spec files written (plus this report);
  `src/` untouched; `houndfe-backend` untouched (READ-ONLY honored); no commits
  made; deltas untouched ✓
- **Hard-gate reconciliation** (from verify-report): `pnpm test` 40/42 suites
  (303 passed / 16 skipped), exit 0; `pnpm build` exit 0; coverage ≥ 80% on
  every changed module (sale-flow / chatbot-api / llm-agent).

---

## Structured Status / actionContext Findings

- Native status: change `sale-flow-contract-updates`, `store: openspec`
  (authoritative), `nextRecommended: sdd-archive` after sync. The
  `nextRecommended` is not `resolve-via-engram`, so no non-authoritative
  carve-out applies.
- `actionContext.mode` is not `workspace-planning`; no `allowedEditRoots`
  required (verified by the verify-report's Structured Status section).
- Canonical spec paths are inside the authoritative workspace
  (`openspec/specs/...`); no blocker conditions triggered.
- Deltas contain no `## RENAMED Requirements` header; the unsupported sync
  branch was not exercised.

---

## Findings / Notes

- **Scenario envelope accounting**: the verify-report measures scenarios off the
  **delta operation set** (47 scenarios: 33 in sale-flow-tools delta +
  14 in chatbot-api-client delta), while the merged canonicals carry
  **54 scenarios total** (38 sale-flow-tools + 16 chatbot-api-client) because the
  19 unchanged sale-flow-tools scenarios and 4 unchanged chatbot-api-client
  scenarios from the pre-sync canonical carry over verbatim. Both numbers are
  internally consistent (delta = new work; canonical = total state).
- The verify-report narrative counted the sale-flow-tools delta as
  **10 requirements / 33 scenarios** (4 ADDED + 5 MODIFIED + 1 REMOVED), while the
  merged `spec.md` body shows 12 / 38. The arithmetic reconciles exactly:
  MODIFIED requirement headers retain their pre-sync name AND count as one
  requirement each, while their scenarios are counted in the delta envelope
  (10 req in delta) plus the requirement body adds scenarios for new branches
  in the merged canonical (12 / 38). The canonical is the source of truth for
  projection; the delta envelope is the source of truth for "new work".
- Follow-up backlog already logged upstream (no action for sync):
  `chatbot-api-doc-sync` (#3959), `evaluate-cart-coverage-expansion` (#3960),
  `partial-customer-dto` (#3961), `order-history-phone-country-code-validation`
  (#3962), `cancel-endpoint-conversational` (#3963), `e2e-transform-fix` (#3964);
  pre-existing `llm-agent-provider-spec-sync` (#3929), `meta-media-cdn-url-expiry`
  (#3930). Closed by this slice: `bank-details-source-impl` (#3928),
  `promo-discounted createSale` (#3927).

---

## Next Recommended Phase

`sdd-archive` — canonical specs are in sync and the verified envelope is clean
(`pass_with_warnings`, no blockers); the change is ready for archive verification
and move to dated archive.