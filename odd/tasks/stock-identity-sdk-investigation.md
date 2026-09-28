# Recover catalog selection without weakening stock authority

**Current:** Both local units passed independent technical verification, including
the catalog-invalidation correction. The first production identity rejection
remains unidentified. The owner now authorizes native delivery review and local
work-unit commits only; push and deployment remain unauthorized.

## Authorization and scope

- Base: `23c0146`. Owner approved two local, independently verified units.
  Initial ceiling was 900 authored lines. The 1,028-line overrun was disclosed;
  work stopped and the owner explicitly amended the ceiling to **1,100**.
  Count additions + deletions and this untracked document; no automatic expansion.
- One writer. No secrets/`.env`, real provider/backend/DB/Meta/Docker operations,
  dependency changes, push, deployment or unrelated fixes. Local commits are
  authorized; their review evidence does not authorize remote delivery.
- Preserve `.codegraph/` and the separate frozen stock-conversation-boundary tracker.
- Never infer stock from search, substitute IDs, choose a variant implicitly,
  relax mutation guards, trust model prose as evidence or raise the step cap.

## Local commit boundaries

- Recovery: `e9e9e87f2a190a95e53a2e0c2d1657114748bb35` (437 authored lines).
  Native review `review-f73d45daeb22e3d4` was approved and acknowledged.
- Diagnostics and this combined record: the commit introducing this document.
  Its exact identity is available with `git log --diff-filter=A --format=%H -- odd/tasks/stock-identity-sdk-investigation.md`.
- Review is per committed range against the preceding boundary. Approval does
  not authorize push/deployment; results are recorded by the native controller.

## Established diagnosis

Installed `ai@7.0.9` / `@ai-sdk/openai@4.0.20` were checked against bundled
source/docs/runtime: supported deprecated aliases work, context/results propagate,
and plaintext naturally ends the loop before the four-step ceiling. No SDK defect
was found in this inspected path; this is not a universal SDK correctness claim.

Real SDK/runner/store/tool tests with a scripted `MockLanguageModelV4` reproduced
application suppression: unbound stock rejection → search → named model question
→ generic retry reply. Same UUID plus a reformatted optional name is sufficient in
the synthetic fixture, NOT proven to be the production cause. Exact/omitted-name
controls work without re-searching. Search success does not prove identity installation.
Initial characterization independently passed 14 integration and 51 identity/tool tests.

## Unit 1 — deterministic selection, not stock authority

Review `CatalogSession.selectionPrompt()`, `StockReadEvidence.hasOnlyUnboundFailures()`
and adapter `selectReply()`, then the actual-SDK integration regression.

- Only-unbound failures ask an explicit product/presentation question using the
  validated current catalog, or a generic explicit-selection request if unavailable.
- At most six distinct options and 2048 UTF-8 bytes. No truncated labels; expired,
  foreign, ambiguous, excessive or display-breaking Cc/Cf/Zl/Zp labels fail closed.
  Variants require explicit choice. No identity selection or stock/write authority
  is created; no ID, price or stock fields are rendered.
- Possible/executed mutations retain model text verbatim, including empty text.
  Bound stock projections and unresolved write protection remain unchanged.
- Scope: catalog references/spec, stock-read-evidence/spec, SDK adapter/spec,
  `src/llm-agent/application/catalog-identity.integration.spec.ts` and this tracker.

**Test-first:** named-selection expectation failed against old generic text
(1 failed / 13 passed). Model text differs from the canonical expected reply.
Independent review then found control-character option spoofing: eight focused
cases failed before the renderer-only guard. Unit 1 independently passed 299 tests
across five suites, plus scoped types. No assertions were removed to reduce size.

## Unit 2 — private categorical diagnostics

An optional seventh `CatalogSession` argument observes direct `{phase,reason}`
validation outcomes. `AgentRunner` logs fixed fields with a generated per-turn ID:

```text
catalog_identity <generated-turn-id> phase=resolve reason=name_mismatch
```

- Session phases: `restore`, `install_search`, `resolve`, `history`.
- Session reasons: `accepted`, `missing_snapshot`, `invalid_snapshot`,
  `sender_mismatch`, `invalid_clock`, `future_observation`, `expired`, `oversized`,
  `duplicate_id`, `variant_limit`, `origin_removed`, `stale_ticket`,
  `unknown_product`, `name_mismatch`, `unknown_variant`, `malformed_projection`.
- Runner also emits `history/idle_discarded`, `commit/committed`, `commit/conflict`
  with the same per-turn ID. A commit conflict concerns history persistence, NOT
  proof that no transaction occurred; it must not trigger automatic mutation retries.
- `accepted` is identity validation, not stock confirmation. `missing_snapshot`
  can be normal on first contact. Read the phases within each generated turn ID.
- No customer/product/variant IDs, names, message text, DTOs, snapshots or raw
  errors in diagnostic payloads. IDs/observers are not added to prompts or persistence.
  Snapshot/render reads stay silent. Synchronous callback/new-log exceptions are caught.
- Scope: catalog references/spec, agent runner/spec and this tracker. Revert Unit 2
  diagnostic hunks together, retaining Unit 1 renderer/predicate/adapter changes.

**Test-first:** missing callback/log assertions failed at runtime (8 failed / 60
passed), then seven suites passed 340 tests. Review caught omitted invalidation in
`evidence()`: an expired snapshot could revive after a synthetic clock rewind.
The focused regression failed with a non-null revived snapshot before the original
one-line clear was restored. Corrected writer result: 341 tests across seven suites,
catalog spec 46/46 and scoped types/lint/format pass. This is not a production-cause claim.

## Verification and reproducible commands

Commands use `env -i PATH="$PATH" HOME="$HOME" CI=1`:

```sh
pnpm exec jest --runInBand
pnpm exec tsc --noEmit --incremental false -p tsconfig.spec.json
```

Final corrected candidate: **183 suites / 5,618 tests passed**, with 30 suites /
755 tests skipped. Independent recheck passed the catalog spec (46/46), scoped
TypeScript and both review blockers. Nine-path lint/format and `git diff --check`
passed. LSP's silent-on-clean checks remained inconclusive on eight paths; scoped
TypeScript is the executed typecheck evidence, not a claim of LSP confirmation.
Default `tsc --noEmit --incremental false` has nine pre-existing untouched errors:
TS2554 in `test/demo/meta-sandbox-bootstrap.ts:125`, `meta-sandbox-config.ts:113,149`,
`meta-sandbox.module.ts:235`; TS2339 in `test/echo.e2e-spec.ts:55,58,61,64,67`.
They remain out of scope; global typecheck is not claimed clean.

## Limits and next step

Final scope is 935 tracked changed lines plus this document, below the 1,100 ceiling.
Mocks establish SDK scheduling, persistence and application decisions—not real-model
or backend/production parity. Native review/delivery approval is not claimed.
After a separately authorized deployment, use the new categorical logs to identify
the first rejection. Do not guess its cause or ask for the already-supplied old logs.
