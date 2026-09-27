# Fix catalog evidence prompt compatibility with AI SDK 7

## Intent and authority

Owner authorized a narrow adapter correction and exact real-SDK regression test after deployed commit `2bde205936537b1594e41e9d8e4f54f19d667d61` failed on a subsequent catalog turn. Work only in `houndfe-chatbot-human-decisions`, branch `fix/catalog-evidence-sdk7-prompt`. CodeGraph is permitted; its index stays excluded. No production, provider, database, backend, remote, global configuration, dependency or flag changes. Local commit/main integration requires new owner approval; no push/deploy.

## Confirmed cause and scope

`VercelAiLlmAgent.run` inserts catalogEvidence as role:system inside messages. Installed SDK 7.0.9 `standardizePrompt` rejects that by default; instructions is the supported channel. Search succeeds, then restored evidence causes InvalidPromptError before any tool step. Repeated log entries belong to one retried inbound; do not persist identifiers or personal data. The existing real-SDK test supplied catalogSession but omitted catalogEvidence, missing this branch.

Edit `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` and its `.spec.ts`. Owner additionally authorized assertion-only compatibility changes in `src/llm-agent/application/catalog-identity.integration.spec.ts`, whose old assertions required the rejected prompt shape. Parent owns this tracker. Preserve boot instructions, evidence labeling/content, transcript order, server-only tool context and identity/RESTOCK gates. Use documented instructions handling; do not set allowSystemInMessages to bypass validation. Preserve the no-evidence path unless a necessary narrow adjustment is documented. Do not weaken existing tests or modify prior approved identity storage.

Forecast: approximately 100–220 authored changed lines including tests/tracker, advisory rather than a cap. Delivery strategy: ask-on-risk if scope materially grows. One cohesive correction candidate; previous review is closed and cannot authorize this candidate.

## Tasks

- [x] C1 — Source and authorized integration assertions implemented. Exact SDK RED (1 failed/78 passed), then 79 adapter passes; independent final-snapshot verification passed after the type-only Pick correction.
- [ ] C2 — IN PROGRESS: Independent verification and changed-path probe completed; native review pending on this normalized candidate. No source writer active.
- [ ] C3 — Request local delivery approval, commit exact reviewed tree and integrate locally if authorized; owner then repeats real rehearsal under I4 of the original feature.

## Acceptance and checks

Real installed generateText plus MockLanguageModelV4, with no external calls, must accept history plus catalogEvidence and preserve the boot prompt and current user text. Assert SDK input messages contain no system role, provider receives boot/evidence through supported instructions, evidence is not duplicated/persisted as transcript, and server session internals remain absent from provider data. Include no-evidence control and retain all existing context-isolation tests. Actual provider behavior and downstream RESTOCK remain owner-validation tasks.

Commands: `RUN_DOCKER_TESTS=0 pnpm exec jest --runInBand --runTestsByPath src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts` for RED/GREEN; focused selection adds `src/llm-agent/application/catalog-identity.integration.spec.ts` and `src/llm-agent/application/agent-runner.service.spec.ts`. Final verifier runs `pnpm exec tsc --noEmit --incremental false -p tsconfig.spec.json`, `pnpm exec tsc --noEmit --incremental false -p tsconfig.build.json`, full `RUN_DOCKER_TESTS=0 pnpm exec jest --runInBand`, explicit three-file eslint/prettier (plus tracker formatting) and `git diff --check`. No DB tests, broad write-mode lint/format or installs.

Parent inspected configuration and substituted no-emit build-config checking for `pnpm build`: Nest deleteOutDir would delete/regenerate dist outside writer scope, and incremental false avoids build-info writes. This is not emitted Nest-build validation. Writer stopped before build/full suite/lint/format; parent took ownership through independent verifier `mujcsmhb-8-qll1`. Final snapshot passed 106 focused tests, full 5,288 tests (755 skipped; 180 suites passed/30 skipped), both non-emitting typechecks, explicit lint/format and diff checks. No source/test drift; bounded inspection found no defect. Source/test scope: adapter +9/-7, adapter spec +122, integration spec +19/-4. Native ASSESS unassessable due untracked scope required independent verification, now satisfied.

Active LSP probe: adapter has three auxiliary extensionless-import warnings; two test paths inconclusive, no compiler error reported. Independent tsc passed; do not claim all LSP paths clean. This tracker is frozen at pre-review state; subsequent native review and delivery outcomes are recorded in session memory, not by modifying the approved candidate.

## Rollback

Revert this adapter/spec/integration-assertion correction together; retain prior catalog identity and persistence work. No schema/data reset or migration. Rollback restores the known second-turn failure, so it is not a runtime remedy. Never replay a pending inbound automatically. Exact local delivery and hosted evidence remain pending.
