# Stock error diagnostics

## Scope and authorization
Owner authorized safe checkStock error-kind diagnostics only. No behavior, prompt, stock guard, RESTOCK flow, backend or dependency changes. No .env reads, live model calls, database operations, push, deployment, or commit without separate consent. Preserve .codegraph and earlier frozen trackers.

Base: a9f9fbefdefc250b5474b0d5e7cf3146b821e339.
Branch: fix/stock-error-diagnostics.
Delivery: ask-on-risk; forecast below 200 authored lines including tests. No commit authorized.

## Acceptance
- Preserve returned_error category; add only a closed allowlisted errorKind for checkStock error results.
- Distinguish catalog_identity_unverified from auth, forbidden, notFound, rateLimit, validation and upstream.
- Unknown/malformed kinds must never leak arbitrary text, IDs, payloads or exception messages.
- Success, thrown errors, requestHumanAssistance and all operational behavior remain unchanged.
- Cover both installed SDK callback/result observation paths where applicable.

## Tasks
- [x] D1 Implement bounded diagnostics and privacy regression tests. Route: gentle-ai-worker; two nontrivial file writes require delegation; preparation bundled with writer. RED then GREEN observed.
- [ ] D2 Verify exact diff and complete native review. Independent read-only verification passed; native review pending. Native assessment was unassessable because untracked scope was undeclared, so independent verification was required.
- [ ] D3 Obtain local commit consent; report deployment remains owner-controlled.

## Allowed source surfaces
- src/llm-agent/infrastructure/vercel-ai-llm-agent.ts
- src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts

## Verification
Focused adapter Jest suite; TypeScript spec noEmit; scoped ESLint without fix; git diff --check. Offline full suite at closure with no external gates enabled. Native review before delivery. No provider experiments.

## Evidence
Writer: RED 10 failed / 118 passed before production edit; GREEN 128/128 adapter tests. TypeScript spec noEmit, scoped ESLint without fix and diff check passed. Offline full suite: 5467 passed / 755 skipped tests, 182 passed / 30 skipped suites; external gates disabled. Independent verifier read actual diff and tests, reran focused suite (128/128) and diff check successfully. Source/test diff: 153 additions / 2 deletions.

Only execution-end observes result envelopes. Step completion observes requested names, not results; its unchanged behavior is regression-tested. Mock callbacks validate classification, not a live provider. The production cause remains unproven until new diagnostics are deployed and observed. Malformed kinds retain unknown_output without errorKind; non-allowlisted strings emit fixed unknown. No sensitive payloads or arbitrary error text are logged.
