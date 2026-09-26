# Restore provider-compatible handoff tool requests

The deployed bot at `ced52095078aabfa8e5c9a5d4e3662d2261b7265` fails ordinary product inquiries before tools execute: OpenAI rejects `requestHumanAssistance` parameters lacking root `type: object`. Source mapping confirms a root discriminated union and unchanged forwarding by the installed adapter; actual serialization must be reproduced offline.

## Scope and route

- Only `houndfe-chatbot-human-decisions`; no backend edits, private environment/index access, real provider calls, database access, remote operations, deployment or dependency changes.
- Parent owns this tracker and Git operations. One delegated writer owns the three exact tool/test surfaces below; multi-file implementation and SDK serialization require that bounded route.
- Preserve argument shape, all per-kind validations, trusted context, and failure-before-side-effects. Do not treat provider schema acceptance as actual hosted acceptance.
- Forecast: up to 350 tool/test diff lines plus 40 tracker lines for this work unit. Preserve tests and readability; escalate before exceeding the existing 390-line correction boundary.
- The previous native exception applies only to the combined merge, not this fix. Ordinary current-candidate assessment/review applies. No commit or push before checks and review outcome.
- Repeated webhook cause remains unknown. No retry/dedup policy changes. Logging exposure is a separate follow-up, not part of this tool-schema patch.

## Tasks

- [x] S0 — Map schema and logging boundaries read-only. Scout `muikiah6-1-76yu` located root union at tool lines 119–156, SDK conversion/forwarding, and raw dispatcher error propagation; no tests executed.
- [x] S1 — Reproduce actual SDK wire failure offline, then fix object-root transport while preserving authoritative runtime validation. Completed by delegated writer `muikmvba-2-qzrz`. Surfaces: `src/sale-flow/application/tools/request-human-assistance.tool.ts`, adjacent `.tool.spec.ts`, and new `request-human-assistance.wire.spec.ts`.
- [ ] S2 — Verify changed candidate, record native assessment/review, and prepare owner handoff. IN PROGRESS. Native assessment failed on untracked declaration; treat as high risk and run an independent verifier. No hosted success claim.
- [ ] S3 — Scope separate log redaction correction preserving failure status and success-only dedup behavior. Do not attach raw error causes to propagated HTTP errors.

## Acceptance and verification

- Actual installed `generateText`/`createOpenAI` with dummy credentials and exclusively fake fetch captures a provider-compatible root-object request; assert effective strict behavior and absence of unsupported root combinators.
- Valid stock, promotion and expiration inputs remain valid; unsupported kinds, mismatched digests, invalid identifiers/quantities/prices fail before side effects.
- Preserve the first deterministic RED; GREEN only after the minimum fix. No mocked schema converter or live request.
- Run focused Jest with `RUN_DOCKER_TESTS=0`, both exact `pnpm exec tsc --noEmit --incremental false -p tsconfig.spec.json` / `tsconfig.build.json`, scoped non-fixing ESLint/Prettier, and diff check. Full offline suite at closure.
- Rollback boundary: only tool schema adapter/runtime guard and its regression tests; no migration or credential rollback involved.

## Evidence and next step

Installed versions: ai 7.0.9, OpenAI 4.0.20, Zod 4.4.3. Writer reproduced missing root type through real SDK serialization: RED 1 failed / 18 passed (1.749s), then GREEN 43 passed (1.781s), final repeat 43 passed (1.746s), no skips. Injected fake fetch never delegates to network; dummy credential, maxRetries 0, exactly one invocation. New transport emits object root, required kind/digest, nested digest anyOf, no root combinators, explicit strict false. Original union remains authoritative through a pipe and direct-execute parse; trusted context unchanged. Tests cover three valid kinds and 21 invalid inputs with RESTOCK on/off. Both exact typechecks and non-fixing lint/format/diff checks passed after fixing two formatting findings. Tool/test delta is 186 lines including the new 56-line wire test. Full offline and native review pending; source/serialization proof is not hosted provider acceptance. Next: freeze candidate and independently execute full offline suite.
