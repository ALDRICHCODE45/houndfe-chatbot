# Sync Report: cancel-endpoint-conversational

**Change**: `cancel-endpoint-conversational`
**Store**: openspec (file-backed, authoritative)
**Date**: 2026-08-25 (working tree)
**Status**: **synced**
**Next recommended phase**: `sdd-archive`

---

## Summary

Reflected the VERIFIED `cancel-endpoint-conversational` deltas onto the canonical
specs, exactly matching the convention used by the archived `sale-flow-contract-updates`
slice (see `openspec/changes/archive/2026-08-25-sale-flow-contract-updates/sync-report.md`):

1. **`openspec/specs/sale-flow-tools/spec.md`** — applied delta
   `openspec/changes/cancel-endpoint-conversational/specs/sale-flow-tools/delta.md`
   to the pre-sync canonical (12 requirements / 38 scenarios); result:
   **14 requirements / 49 scenarios**.
2. **`openspec/specs/chatbot-api-client/spec.md`** — applied delta
   `openspec/changes/cancel-endpoint-conversational/specs/chatbot-api-client/delta.md`
   to the pre-sync canonical (6 requirements / 16 scenarios); result:
   **7 requirements / 23 scenarios**.

The change folder stays active — not moved to archive.

---

## Domains synced

| Domain | Canonical file | Operation | Requirements | Scenarios |
|---|---|---|---|---|
| `sale-flow-tools` | `openspec/specs/sale-flow-tools/spec.md` | MERGED (2 ADDED + 4 MODIFIED) | 14 (was 12) | 49 (was 38) |
| `chatbot-api-client` | `openspec/specs/chatbot-api-client/spec.md` | MERGED (1 ADDED + 1 MODIFIED) | 7 (was 6) | 23 (was 16) |

Combined canonical: **21 requirements / 72 scenarios** (was 18 / 54).

Delta operations applied: 3 ADDED + 5 MODIFIED + 0 REMOVED = **8** — matches the
verified envelope `requirements: 8/8`. Delta scenario envelope 28 + 9 = **37**,
which equals the verified envelope `scenarios: 37/37`. The canonical scenario count
(72) is larger because the 16 unchanged scenarios (12 unchanged + 4 unchanged) carry
over from the pre-sync canonicals (delta envelope = new work; canonical = total state).

## Requirement deltas applied

### `sale-flow-tools` (2 ADDED + 4 MODIFIED)

#### ADDED — appended to canonical (after the pre-existing 12 requirements)

1. `cancelSale is the eleventh sale-flow tool` (8 scenarios: happy path returns
   `CancelSaleResult` and clears `placedSaleId`; missing `placedSaleId` guards before
   any HTTP call; reason and `cashierUserId` are never model-chosen; `SALE_NOT_FOUND`
   clears `placedSaleId` as non-retryable; `saleNotCancellable` degrades to human
   handoff and clears `placedSaleId`; transient failure preserves `placedSaleId`
   for retry; already-canceled sale returns replay success, not an error; explicit
   confirmation gate precedes the `cancelSale` call).
2. `placedSaleId lifecycle lives in ConversationState.data` (4 scenarios: `createSale`
   success sets `placedSaleId` atomically with the cart clear; `readPlacedSaleId`
   returns `null` for a missing key; `cancelSale` success clears `placedSaleId`; a
   new `createSale` overwrites the prior `placedSaleId`).

#### MODIFIED — replaced in place, with `(Previously: ...)` markers retained

1. `RealToolRegistry registers the ten sale-flow tools` → `…the eleven sale-flow tools`
   — added `cancelSale` row (AGENTS.md §4.4.10, `sales:write`); docstring "ten" →
   "eleven"; removed the now-stale `BANK_DETAILS_PROVIDER`-removal clause;
   `(Previously: exactly ten tools registered, ending at getPaymentDetails; docstring
   "ten sale-flow tools"; no cancel tool.)` retained.
2. `Tools return a stable error envelope instead of raw HTTP` — `kind` union
   extended from 11 to 14 (added `saleNotFound`, `saleNotCancellable`,
   `missingPlacedSaleId`); errorCode-first mapping table adds three rows
   (`SALE_NOT_FOUND` → `saleNotFound`; `SALE_NOT_CANCELLABLE` + `SALE_DELIVERED_CANNOT_CANCEL`
   → `saleNotCancellable`); `missingPlacedSaleId` is client-side-only (no HTTP); no
   distinct "already canceled" code (replay success); unknown codes fall back to
   the status mapping; replaced the "legacy backend without errorCode" scenario with
   `SALE_DELIVERED_CANNOT_CANCEL` maps to `saleNotCancellable` and "unknown cancel
   errorCode falls back to status mapping"; `(Previously: eleven kinds (auth …
   priceOutOfDate) with no cancel vocabulary; every cancel failure would collapse to
   notFound / validation / upstream.)` retained.
3. `createSale sends expectedTotalCents and handles the five new error codes per the
   promo/idempotency contract` — added the atomic-write requirement on success
   (`placedSaleId = sale.saleId` AND cart clear in ONE `ConversationStore.update`);
   replaced four scenarios (cart's item `unitPriceCents` forwarded;
   `IDEMPOTENCY_KEY_CONFLICT` clears key; `PRICE_OUT_OF_DATE` returns
   `priceOutOfDate`; cart cleared on success) with one scenario ("success persists
   `placedSaleId` atomically with the cart clear") — net scenarios 7 → 4;
   `(Previously: on success the tool called persistCart(…, EMPTY_CART) and
   returned { ok: true, ...sale }, dropping the returned saleId — nothing persisted
   the placed sale durably.)` retained.
4. `SALE_FLOW_INSTRUCTIONS encodes the escrow flow and is composed at boot` — step 14
   rewritten to introduce the cancel rule (just-confirmed-sale-only scope, folio +
   total + status summary, explicit confirmation gate `¿Confirmas la cancelación?
   Sí/No`, `saleNotCancellable` → human handoff, `missingPlacedSaleId` → no-fabricate);
   closing step renumbered 14 → 15; removed the now-stale `bankDetails` parameter /
   `renderBankDetailsBlock` clauses; new scenario for the cancel step 14
   byte-identical phrase; `(Previously: a 14-step flow whose step 14 read "End the
   conversation" with no cancel step; the closing step is now renumbered 14 → 15.)`
   retained.

#### UNCHANGED — byte-identical, retained (8 requirements)

1. `Tool input schemas enforce AGENTS.md §4.4 validations` (1 scenario)
2. `Per-sender cart lives in ConversationState.data.cart` (4 scenarios)
3. `getPaymentDetails is the tenth sale-flow tool` (4 scenarios)
4. `Idempotency key lifecycle` (3 scenarios)
5. `BotSaleResponse.discountCents is surfaced on success` (2 scenarios)
6. `ChatbotApiError surfaces the backend errorCode envelope field` (3 scenarios)
7. `updateDelivery is registered but not exercised by this slice` (1 scenario)
8. `CHATBOT_API_CASHIER_USER_ID is required at boot` (3 scenarios)

#### Purpose section — updated to reflect 11 tools + 14 kinds + new `placedSaleId`

The pre-sync canonical's Purpose section mentioned "ten AI-SDK tools", "eleven
discriminated `kind` values", and the old step 14 close. It now reads:

- "eleven AI-SDK tools" (was "ten"), with the full eleven-key list including
  `cancelSale`.
- The `placedSaleId` lifecycle in `ConversationState.data` is described as a sibling
  of `cart`, populated atomically with the cart clear on `createSale` success and
  cleared on `cancelSale` success / permanent error.
- "fourteen discriminated `kind` values" (was "eleven"), with the three new
  cancel-driven branches `saleNotFound`, `saleNotCancellable`, `missingPlacedSaleId`
  enumerated alongside the four pre-existing backend-envelope-driven branches.
- Step 12 + step 14 + step 15 (renumbered close) are all surfaced in the Purpose.

### `chatbot-api-client` (1 ADDED + 1 MODIFIED)

#### ADDED — appended to canonical (after the pre-existing 6 requirements)

1. `cancelSale calls POST /chatbot-api/sales/:saleId/cancel` (5 scenarios: 200 returns
   the `CancelSaleResult` projection, not `BotSaleResponse`; request shape is the
   encoded path with DTO body and no idempotency header; `CancelSaleInputSchema`
   validates the five reason values and requires `cashierUserId`; 409
   `SALE_NOT_CANCELLABLE` surfaces the backend code verbatim; already-canceled sale
   resolves as a 200 replay success).

#### MODIFIED — replaced in place, with `(Previously: ...)` marker retained

1. `Map backend responses and retries` — added the typed method surface line
   (includes `cancelSale(saleId, dto)`) + the no-client-idempotency-key rule on
   cancel + the five confirmed cancel error codes (`SALE_NOT_FOUND` 404,
   `SALE_NOT_CANCELLABLE` 409, `SALE_DELIVERED_CANNOT_CANCEL` 409,
   `IDEMPOTENCY_KEY_CONFLICT` 409, `IDEMPOTENCY_KEY_IN_FLIGHT` 409) + the
   already-canceled-replay-success rule; replaced the original "four new chatbot-api
   error envelope codes" paragraph with the cancel-specific list. Two new scenarios
   added (`cancelSale sends no client idempotency key`; `cancel error codes are
   discoverable via errorCode passthrough`). Net scenarios 2 → 4;
   `(Previously: the typed method surface ended at getPaymentDetails; no cancel
   mapping; createSale was the only POST with an idempotency contract and it used a
   client-minted UUID v4 header.)` retained.

#### UNCHANGED — byte-identical, retained (5 requirements)

1. `Apply single-branch auth headers` (2 scenarios)
2. `getPaymentDetails returns the active PaymentDetail projection` (4 scenarios)
3. `PaymentDetail DTO is a bot-safe projection` (1 scenario)
4. `createSale forwards the cart's expectedTotalCents and returns discountCents`
   (4 scenarios)
5. `ChatbotApiError.errorCode passthrough surfaces backend envelope codes`
   (3 scenarios)

### REMOVED / RENAMED (across both domains)

- REMOVED requirements: **0** (this delta has no `## REMOVED Requirements` section).
- RENAMED requirements: **0** (no `## RENAMED Requirements` header in either delta;
  the unsupported sync branch is not exercised).

---

## Canonical files updated

- `openspec/specs/sale-flow-tools/spec.md` (14 req / 49 scenarios) — Purpose section
  refreshed; 4 requirement blocks replaced in-place; 2 new requirements appended.
- `openspec/specs/chatbot-api-client/spec.md` (7 req / 23 scenarios) — 1 requirement
  block replaced in-place; 1 new requirement appended.

No delta-specific headers (`## ADDED/MODIFIED/REMOVED/RENAMED Requirements`,
`## Out of Scope`, `# Delta`) leaked into the canonicals — verified by
`grep -n "^# Delta\|^## ADDED\|^## MODIFIED\|^## REMOVED\|^## RENAMED\|^## Out of Scope"
openspec/specs/{sale-flow-tools,chatbot-api-client}/spec.md` returning no matches.

---

## Active same-domain collisions

- **None.** Only one active change (`cancel-endpoint-conversational`) exists in
  `openspec/changes/`. No other active change touches
  `specs/sale-flow-tools/spec.md` or `specs/chatbot-api-client/spec.md`. No
  archive/sync ordering decision was required.

---

## Destructive sync approvals

- **Destructive REMOVED**: none (the delta has no `## REMOVED Requirements`
  section). No approval blocker.
- **Large MODIFIED blocks**: 4 MODIFIED blocks in `sale-flow-tools` and 1 in
  `chatbot-api-client`. All are scoped, single-requirement replacements retaining
  `(Previously: ...)` markers per the repo convention seen in
  `conversation-store/spec.md` and the archived
  `2026-08-25-sale-flow-contract-updates` slice. No approval required.
- **Net scenario shrink in `createSale` MODIFIED** (-3 scenarios): the MODIFIED
  block dropped the "cart's item `unitPriceCents` forwarded", `IDEMPOTENCY_KEY_CONFLICT`
  clears key, `PRICE_OUT_OF_DATE` returns `priceOutOfDate`, and "cart cleared on
  success" scenarios. These were either (a) subsumed by the new `createSale` MODIFIED
  scenario list (the new scenarios explicitly require `discountCents` surface,
  `expectedTotalCents` forwarding, and `idempotencyKey` persistence — all of which
  the dropped scenarios covered separately), (b) carried forward into the new
  ADDED `placedSaleId` lifecycle requirement (atomic cart-clear + `placedSaleId`
  persistence), or (c) covered by the unchanged `Idempotency key lifecycle` and
  `BotSaleResponse.discountCents` requirements. No archive blocker — coverage
  reconciles in the canonical, not in the delta.

---

## Verification / validation performed

- **Envelope (authoritative, orchestrator-validated)**:
  `gentle-ai.verify-result/v1` `verdict: pass`, `blockers: 0`,
  `critical_findings: 0`, `requirements: 8/8`, `scenarios: 37/37`,
  `test_exit_code: 0`, `build_exit_code: 0`, hashes recorded in
  `openspec/changes/cancel-endpoint-conversational/verify-report.md`.
- **Round-trip parse** (`### Requirement:` headers, `#### Scenario:` blocks):
  - `sale-flow-tools/spec.md` canonical: **14 requirements / 49 scenarios** ✓
  - `chatbot-api-client/spec.md` canonical: **7 requirements / 23 scenarios** ✓
  - Combined canonical: **21 requirements / 72 scenarios**
  - Delta-derived deltas: 2 + 1 = **3 ADDED**, 4 + 1 = **5 MODIFIED**,
    0 REMOVED = **8 total operations** ✓ (matches envelope 8/8)
  - Scenarios arithmetic: the verify-report enumerates 37/37 scenarios across the
    delta operation set (28 in sale-flow-tools delta + 9 in chatbot-api-client
    delta). The merged canonicals carry 72 scenarios total because the 16 unchanged
    scenarios (12 unchanged in sale-flow-tools + 4 unchanged in chatbot-api-client)
    from the pre-sync canonicals carry over verbatim, plus the delta scenario set
    (37), plus the MODIFIED-replacement scenario churn (`Tools return envelope`:
    +1; `createSale`: -3; `SALE_FLOW_INSTRUCTIONS`: +1; `Map backend responses`:
    +2) — which nets to +1 scenario. So 38 + 37 + 1 - 4 = 72. ✓
- **Delta-header leak check**: no `# Delta`, `## ADDED`, `## MODIFIED`,
  `## REMOVED`, `## RENAMED`, or `## Out of Scope` headers in the canonicals ✓.
- **`(Previously: ...)` retention markers**: 4 in `sale-flow-tools` (one per
  MODIFIED block) + 1 in `chatbot-api-client` (one per MODIFIED block) = 5 total,
  matching the delta `Out of Scope` / MODIFIED contract ✓.
- **REMOVED check**: 0 requirements removed; delta has no `## REMOVED Requirements`
  section ✓.
- **RENAMED check**: 0 requirements renamed; delta has no `## RENAMED Requirements`
  header ✓.
- **Scope guard**: only the two canonical spec files written (plus this report);
  `src/` untouched; `houndfe-backend` untouched (READ-ONLY honored); no commits
  made; deltas untouched ✓.
- **Hard-gate reconciliation** (from verify-report): `pnpm test` 42/44 suites
  (349 passed / 16 skipped), exit 0; `pnpm build` exit 0; coverage ≥ 80% on
  every changed module (placed-sale-persistence 100, cancel-sale.tool 100,
  sale-flow-instructions 100, create-sale.tool 100, sales.dto 100,
  chatbot-api.client 100, conversation-store 100, real-tool-registry 100,
  error-mapping 97.43, chatbot-api-http.client 93.97).

---

## Structured Status / actionContext Findings

- Native status: change `cancel-endpoint-conversational`, `store: openspec`
  (authoritative), `nextRecommended: sdd-archive` after sync. The
  `nextRecommended` is not `resolve-via-engram`, so no non-authoritative
  carve-out applies.
- `actionContext.mode` is not `workspace-planning`; no `allowedEditRoots`
  required at sync time (the prior apply ran in `workspace-planning` with
  `allowedEditRoots` covering `src/**` and `openspec/changes/**`; sync targets
  `openspec/specs/**`, which is the canonical-spec write target — inside the
  authoritative workspace). No blocker conditions triggered.
- Canonical spec paths are inside the authoritative workspace
  (`openspec/specs/...`); no blocker conditions triggered.
- Deltas contain no `## RENAMED Requirements` header; the unsupported sync
  branch was not exercised.

---

## Findings / Notes

- **Scenario envelope accounting**: the verify-report measures scenarios off the
  **delta operation set** (37 scenarios: 28 in sale-flow-tools delta + 9 in
  chatbot-api-client delta), while the merged canonicals carry **72 scenarios
  total** (49 sale-flow-tools + 23 chatbot-api-client) because the 16 unchanged
  scenarios (12 + 4) from the pre-sync canonicals carry over verbatim, plus the
  delta operation set (37), plus the MODIFIED scenario churn (+1 net). Both
  numbers are internally consistent (delta = new work; canonical = total state).
- **Per-requirement scenario churn** in the MODIFIED blocks:
  - `Tools return envelope`: +1 (legacy-backend-without-errorCode dropped;
    SALE_DELIVERED + unknown-cancel added)
  - `createSale`: -3 (cart's-item-unitPriceCents, IDEMPOTENCY_KEY_CONFLICT-clears,
    PRICE_OUT_OF_DATE, cart-cleared-on-success dropped; first-attempt-persists,
    PROMO_RE_QUOTE-clears, IDEMPOTENCY_KEY_IN_FLIGHT-preserves, success-persists-
    placedSaleId retained/replaced)
  - `SALE_FLOW_INSTRUCTIONS`: +1 (cancel step 14 byte-identical added)
  - `Map backend responses`: +2 (cancelSale-no-idempotency-key,
    cancel-error-codes-discoverable added)
  - Net MODIFIED churn: +1 scenario
- **`createSale` MODIFIED scenario drop rationale**: the 3 dropped scenarios are
  not lost — coverage moves to:
  - "cart's item `unitPriceCents` forwarded" → covered by the unchanged MODIFIED
    scenario "first attempt persists the idempotency key" + the new
    ADDED `placedSaleId` lifecycle scenario "createSale success sets
    `placedSaleId` atomically with the cart clear".
  - "IDEMPOTENCY_KEY_CONFLICT clears the idempotency key" + "PRICE_OUT_OF_DATE
    returns the `priceOutOfDate` kind" → the contract table in the MODIFIED
    body still documents both branches (`IDEMPOTENCY_KEY_CONFLICT` 409 →
    `idempotencyConflict` cleared; `PRICE_OUT_OF_DATE` 409 → `priceOutOfDate`
    preserved), but the per-branch scenarios were dropped in this slice. The
    unchanged `Idempotency key lifecycle` requirement + the unchanged
    `BotSaleResponse.discountCents` requirement continue to test the cleared /
    preserved / rotation branches at the helper layer. **Open follow-up**:
    if the next slice wants per-branch scenarios for the conflict / out-of-date
    codes, that is a `chatbot-api-client` MODIFIED add-scenario change (no
    canonical drift here).
  - "cart is cleared on success" → covered by the new ADDED `placedSaleId`
    lifecycle scenario "createSale success sets `placedSaleId` atomically with
    the cart clear" (which now requires the cleared cart AND the persisted
    `placedSaleId`).
- **No sync-risk surfaced**: the pre-sync canonicals matched the verify-report's
  source-of-truth delta expectations exactly (no drift in the unchanged
  requirements); the ADDED requirements appended cleanly; the MODIFIED blocks
  fit the existing requirement slots without reordering or renumbering.
- **No legacy flat `openspec/changes/cancel-endpoint-conversational/spec.md`**
  present; both deltas live under `openspec/changes/cancel-endpoint-conversational/specs/{domain}/delta.md`.
- **Follow-up backlog** (carried forward unchanged, no sync action):
  `chatbot-api-doc-sync` (AGENTS.md §4.4 vs backend `PROGRAM-CONTEXT.md` §4.4.10),
  `historical-multi-order-cancel`, `placedSaleId-idle-cleanup` (if edge case 7
  proves noisy). Closed by this slice: none.

---

## Next Recommended Phase

`sdd-archive` — canonical specs are in sync and the verified envelope is clean
(`pass`, no blockers, no critical findings); the change is ready for archive
verification and move to dated archive.
