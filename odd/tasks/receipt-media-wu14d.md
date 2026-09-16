# Receipt Media WU14D

## Objective and rationale

Integrate the checkpointed non-worker ReceiptMediaModule into WhatsappModule so its mandatory dispatcher receipt dependencies resolve in enabled and disabled modes. The scout found no ChatbotApiModule export gap, so this unit does not change that module.

## Authorized scope

- Source: `src/whatsapp/whatsapp.module.ts` and new `src/whatsapp/whatsapp.module.spec.ts`.
- Parent-owned tracking: `odd/tasks/receipt-media-wu14d.md`.
- Baseline: `b477881a67fdf918eb109cf87b19cbf91ade60b8` on `feat/receipt-media-ingestion-wu06-capability-access`.
- Explicit maintainer authorization: implement these two source paths with strict TDD; no additional commit, push, or PR.

## Constraints and non-goals

- Never read or modify the 14 protected untracked files. Confirm repository read targets with tracked-only Git metadata; new authorized tracker/spec are exceptions.
- Do not change WU14C internals, ChatbotApiModule, AppModule, configuration, migrations, existing dispatcher tests, or OpenSpec files.
- Do not register/start receipt workers or compose outbox/ReceiptTx2CommitPort paths.
- Preserve singleton lookup aliasing, strict enabled configuration and disabled-safe inert composition.
- Stub external edges; no live database, backend, Meta, S3, or LLM requests.
- Forecast: 180–250 gross authored additions plus deletions, primarily host tests. This is an estimate, not a hard budget. About 400 lines is an advisory planning heuristic; do not compress code or omit tests to fit it. Escalate genuine scope expansion before editing additional paths.
- Technical artifacts remain in English.

## TDD and runtime harness

- Mode: enabled, explicitly authorized by the maintainer for WU14D.
- Runner: `pnpm test -- src/whatsapp/whatsapp.module.spec.ts src/whatsapp/application/webhook-dispatcher.service.spec.ts`.
- Observe missing host receipt dependency RED before production edits, then GREEN and triangulation.
- Harness: Nest TestingModule using real host and receipt module composition, with external edges stubbed. Resolve dispatcher/ingress/router in enabled and genuinely receipt-setting-free disabled environments. Narrow transitive LLM/handoff fixtures may be needed; inspect tracked evidence before choosing overrides. Do not mask the receipt import defect by overriding its missing services.
- Rollback boundary: remove the new host spec and revert only the ReceiptMediaModule import/array entry; retain WU14C checkpoint.

## Checklist

- [x] **WU14D-1 — IMPLEMENT:** Observe RED, add the minimal host import, and triangulate enabled/disabled resolution with no external I/O or new receipt worker/outbox providers.
- [x] **WU14D-2 — VERIFY:** Review source and TDD evidence; run scoped checks and an independent spot check; record hashes, gross A+D, and baseline diagnostics separately.
- [x] **WU14D-3 — REVIEW:** Complete the applicable native review decision/lifecycle, reconcile evidence and remaining checks, and preserve uncommitted delivery state.

## Checks and acceptance

- Focused runner above passes; existing dispatcher precedence tests remain unchanged and green.
- `pnpm exec eslint src/whatsapp/whatsapp.module.ts src/whatsapp/whatsapp.module.spec.ts`.
- `pnpm exec prettier --check src/whatsapp/whatsapp.module.ts src/whatsapp/whatsapp.module.spec.ts`.
- `git diff --check -- src/whatsapp/whatsapp.module.ts`; check the untracked spec using `git diff --no-index --check -- /dev/null src/whatsapp/whatsapp.module.spec.ts`.
- `pnpm exec tsc --noEmit --incremental false`: known WU14C baseline is 119 pre-existing diagnostics, zero WU14D candidate diagnostics required; report actual results, not blanket PASS.
- No files outside authorized source/tracking scope change; staging stays empty and all protected contents remain untouched.

## Progress and evidence

- Baseline checked: tracked worktree and staging clean; 14 remaining untracked paths; proposed tracker/spec did not exist.
- Read-only scout returned GO. Parent supplied a tracked-only read whitelist because the scout runtime lacked Git shell access.
- Writer observed the expected missing ReceiptAmountRouterService RED before the production import, then reported GREEN: 2 suites, 57 tests. Initial source size: 196 gross A+D (2 production additions and 194 spec lines).
- Initial writer checks reported scoped ESLint/Prettier clean and exactly 119 pre-existing TypeScript diagnostics, zero candidate diagnostics. These results do not close parent verification.
- Parent found two vacuous assertions (unrelated pool and strict root-only absence lookup). The spec-only correction now observes the injected pool through shutdown and checks forbidden providers across the full graph in both modes. Writer temporarily exercised the injected pool and imported an inert forbidden token; each probe produced the expected failing assertion, then was fully removed.
- Corrected writer checks: 57/57 tests, ESLint and Prettier pass; tracked diff-check exit 0, untracked no-index check exit 1 with zero whitespace diagnostics; exact pnpm TypeScript command exit 2 with 119 pre-existing diagnostics and zero candidate diagnostics. Scoped Prettier writes affected only the authorized spec before final checks.
- Parent readback accepted the corrected assertions. Independent parent spot check passed 2 suites/57 tests with identical pre/post source hashes. Active LSP probe checked both source paths with zero diagnostics.
- Final source size: 219 gross A+D (2 production additions + 217 spec lines). SHA-256: module `0c0eae62fba967e4e84c6fc436f4d9171e13159b5ffa0438e19ee33c997b6b5f`; spec `2b22bbed52fce95864e1056e5e82ce337a55385ed42f2c608ca187267ee83c8e`.
- HEAD remains the WU14C checkpoint; only the authorized module is tracked-modified, staging is empty, 16 untracked files comprise the spec/tracker plus 14 protected paths, and dist-temp is absent.
- Initial native risk assessment returned unassessable (empty native output); the prescribed independent-verifier fallback was completed. Later native START classified the exact candidate as medium and selected one consolidated reliability review.
- First independent verification passed all functional checks but returned FAIL because its initial tracker read reported newline normalization before the starting hash was captured. Sources remained unchanged; no source defect was found.
- Fresh independent verifier `mu3md8lm-6-y4o8` returned PASS: all three candidate hashes matched before reads, immediately after reads, and after commands, with no reported normalization. Verified tracker hash at that point: `43b3c01a96bcf2aff67396de76d5dde3dbcdefc3953b000a6508c1d4d5771a6e` (before this evidence reconciliation).
- Independent checks: focused Jest 57/57; contaminated-shell host Jest 4/4; ESLint/Prettier clean; tracked/untracked diff checks had no whitespace diagnostics; TypeScript remained exactly 119 baseline diagnostics with none in candidate files. Runtime coverage is Nest compile/close, not full app.init, HTTP serving, or live external integrations.
- Native review `review-49ec86972f4eb46c` approved target `sha256:165e1da93828db4a1dfc07022c6ddcf5d7bb90a98c765783c73a7053ca1bfe25`. Acknowledgement consumed revision `sha256:9c5361f37abab7af878385f507d5db887398b76e7948d6a4987bd9f3c2c5b457` and burned authority. Review scope was exactly the two WU14D sources plus this tracker; the 14 protected untracked paths were excluded.
- WU14D-1 through WU14D-3 are complete. This final tracker-only reconciliation records the review outcome after acknowledgement; reviewed source bytes remain unchanged. WU14D is uncommitted.

## Next step

Await explicit maintainer authorization for any local WU14D checkpoint or subsequent unit. No commit, push, or PR is authorized.
