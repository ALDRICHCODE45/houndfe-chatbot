# Observe sanitized RESTOCK rejection stages

## Intent and authority

Owner approved internal stage/reason diagnostics after a hosted `requestHumanAssistance` execution returned `restock_unavailable`. The wrapper folds blocked preflight, coordinator holds/blocks and exceptions into that one public error. No actual rejection reason is known. A prior model `checkStock` call is not a runtime preflight prerequisite: the preflight itself performs a fresh stock read.

Only `houndfe-chatbot-human-decisions`, base `3c6eee3f9f5d7628613ce4f1f911d39bf7d0b4df`, branch `fix/restock-route-diagnostics`. Protect other worktrees and `.codegraph`; never use CodeGraph. Owner alone pushes, deploys and runs hosted tests. Owner explicitly authorized local commit and FF-only local-main integration for this unit after passing tests and native review. Stop on unexpected Git drift; push/deploy remain owner-only.

## Route and surfaces

One delegated writer reads the supplied tool, preflight and coordinator contracts, and edits only `src/sale-flow/application/tools/request-human-assistance.tool.ts` and its `.spec.ts`. Parent owns this tracker and review. Forecast 200–330 source/test diff lines plus tracker, maximum 390. No omitted tests or compressed code to fit; stop on expansion.

- [x] R0 — Inspect the enabled-only wrapper and its fixed preflight/coordinator outcome unions.
- [x] R1 — Add failing privacy/isolation tests and guarded server-only stage/reason logs. Writer `muiqed8a-k-tfz9` completed.
- [ ] R2 — IN PROGRESS: Independently verify full offline checks and native review, then commit the exact candidate and integrate into local main under explicit owner authority.
- [ ] R3 — Owner deploys; inspect one bounded probe only after considering existing/ambiguous intake state, without automatic retries or resets.

## Acceptance

Preserve the exact tool input/context/output schemas, public sanitized errors and all domain calls/control flow. Add temporary server-only fixed metadata for enabled RESTOCK: preflight outcome and allowlisted block reason; coordinator recorded/existing/hold/blocked outcome and allowlisted reason; unexpected exception with current stage and a fixed label. Unknown values become fixed unknown labels. No raw exceptions, stack, args, product/customer/source/poll IDs, headers, credentials, objects or arbitrary text. Use a fresh random diagnostic-only attempt ID, not an identity derived from the event; it is separate from the adapter run ID.

Logging and diagnostic-ID generation failures must not change a returned value, call count, order or side effect. No new retries, fallback, database reads, model payload fields, dependencies, flags, prompts, registry or ingress changes. Disabled/legacy paths remain behaviorally identical. Never mutate preflight/coordinator business code merely to log it; observe their returned fixed codes in the existing wrapper. A coordinator hold can follow an ambiguous POST: neither a failure log nor missing receipt proves no backend request exists. Fixed reasons locate a boundary, not necessarily the root cause.

## Checks and limits

Writer reported 27 intended RED assertions failing for absent diagnostics; initial crypto-spy/mock-typing failures were corrected before final validation. GREEN: 96 tests across all four requested tool/wire/preflight/coordinator suites. Privacy, all fixed outcome/reason labels, exceptions, UUID/logger failures, call order/results, hostile getters, concurrency and legacy isolation passed. Exact spec/build noEmit nonincremental checks, scoped non-fixing lint/format/diff passed. Two-file diff: 339 additions / 4 deletions (343 lines), below 390 including this tracker. Writer reports no CodeGraph access. Independent command-only full offline verification and native review remain pending. No provider, database, network or remote operations.

No RESTOCK runtime success or duplicate-reply fix is claimed. Rollback removes only the new wrapper diagnostics and tests; earlier adapter diagnostics and backend/prompt fixes remain intact. Do not retry an unavailable intake, clear markers/history, change feature flags or bypass reservations to make a demo pass.
