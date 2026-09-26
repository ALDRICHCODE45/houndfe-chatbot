# Ground catalog search and RESTOCK clarification in real products

Owner-approved chatbot-only correction after hosted queries proved `ibuprofeno` returns the real `Ibuprofeno de 400mg` with out-of-stock status, while `ibuprofeno de 400 mg` returns no results. The historical model query remains unknown. Improve query guidance and clarification without changing backend matching or inventing product identity.

## Scope and route

- Base: `2a69999cd4940cbeba3cd26659b3313cbd5ed3e8`; only `houndfe-chatbot-human-decisions` may be written. Protected principal and `.codegraph` remain untouched.
- One delegated writer for four exact tool/prompt/spec paths; parent owns tracker, staging, commits, and review. No backend, registry, SDK, stock/RESTOCK implementation, transcript persistence, retry/dedup, or logging changes.
- No private env, real provider, DB, browser, remote, installation, deployment, or product mutations. Owner runs hosted rehearsal and push.
- Keep current result envelope and query forwarding. Description/instructions steer model behavior; do not claim deterministic hosted compliance from prompt-contract tests.
- Forecast 150–250 source/spec diff lines plus at most 40 tracker lines, within the 390-line work-unit boundary. Delivery: one independently coherent fix; prior merge review exception does not apply.

## Tasks

- [x] C0 — Map current search/stock/RESTOCK contracts. Read-only scout `muily3ct-5-6a1a` confirmed empty/error distinction and trusted stock identity fences.
- [x] C1 — Add failing prompt-contract tests, then narrowly improve query and clarification guidance. Completed by `muim3pai-7-d74y`. Edit only `src/sale-flow/application/tools/search-catalog.tool.ts`, adjacent `.spec.ts`, `src/sale-flow/domain/sale-flow-instructions.ts`, adjacent `.spec.ts`.
- [ ] C2 — Verify the full offline candidate, record native review outcome, and prepare local commit/owner handoff. IN PROGRESS.
- [ ] C3 — Owner rehearses natural-language search, confirms presentation, and observes RESTOCK; no automatic hosted execution.

## Acceptance

- Search the main product name before generic clarification when a name is already supplied; retain dose/form as selection constraints, with no automatic substitutions.
- Present actual candidates including out-of-stock products; confirm actual presentation before checking stock.
- Empty success means no matches, not stock shortage. At most one distinct broader-name refinement after an over-specific query; otherwise ask a targeted clarification. No repeated identical search.
- Error means inability to check, not empty results or shortage; no additional model-driven automatic error retry. Existing HTTP-client policy is unchanged.
- Use only real product/variant identity. If identity is unavailable on a later turn, re-search; never reconstruct IDs from text. Invoke existing RESTOCK only from validated checkStock shortage evidence, preserving historical-intake/no-notification truth.
- Preserve the global unsupported-function rule but do not use it merely for catalog misses or supported stock/replenishment inquiries. No promised date/contact or invented successful intake.

## Verification and rollback

Observe RED on new missing-guidance assertions before edits; existing forwarding/empty/error tests may already pass and are not RED evidence. Run focused search/instructions/base-prompt plus existing stock/handoff regressions; exact spec/build noEmit nonincremental typechecks; scoped non-fixing lint/format/diff checks. Full offline suite at closure; no Docker tests. Parent owns native assessment/review. Rollback is limited to search guidance and its tests; no migrations/configuration involved.

## Evidence and next step

Initial worker `muim2bkh-6-hnb9` failed without a useful report; parent confirmed no source/staging changes before continuation. Writer `muim3pai-7-d74y` changed only the four allowed files (115 additions / 8 deletions, 123 diff lines). Six-spec RED observed seven missing-guidance failures and 97 passes; GREEN passed 104 tests across six suites with no skips. Existing empty-result/query forwarding regressions already passed before implementation and are not RED evidence. Both exact spec/build no-artifact typechecks, scoped non-fixing ESLint/Prettier and diff check passed. Runtime query forwarding, result envelopes, HTTP retry policy and RESTOCK fences are unchanged. Next: full offline verification and native review of the frozen candidate. Offline tests prove prompt/tool contracts only; a controlled owner rehearsal is required to observe actual model selection and response behavior.
