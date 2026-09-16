# Receipt Media WU14E

## Objective and rationale

Start only the notification drain when Receipt Media is enabled, with one lifecycle owner and safe shutdown. WU14C/D already compose the feature and host; this unit transitions their non-worker assertions without activating receipt ingestion or producing new outbox intents.

## Authorized scope

- `src/receipt-media/receipt-media.module.ts`
- `src/receipt-media/receipt-media.module.spec.ts`
- `src/whatsapp/whatsapp.module.spec.ts`
- Parent-owned tracking: `odd/tasks/receipt-media-wu14e.md`.
- Baseline: `744cc9f4fbd4137b1b12ec8d10050062b0c1b146`, branch `feat/receipt-media-ingestion-wu06-capability-access`.
- Maintainer explicitly approved the three-file scope amendment and strict TDD. No commit, push, or PR is authorized.

## Decisions and constraints

- Enable/disable is configuration plus graceful process restart/redeploy, not a live runtime toggle.
- Never read or modify the 14 protected untracked files. Read other repository files only after tracked-path confirmation; this new tracker is the sole intended untracked exception.
- Do not edit the notification worker, PostgreSQL adapter, database lifecycle, configuration, host production module, previous trackers, or OpenSpec files.
- Do not start ingestion or wire ReceiptOutboxService, ReceiptTx2CommitPort, or outbox intent production. Notification draining consumes already-committed intents only.
- Proposed module-local singleton coordinator privately owns the notification worker/store only in enabled mode. Disabled boot creates neither and performs no claims, polling, sends, or alerts; existing fail-closed access remains mounted.
- Use validated concurrency for batch size and max concurrency, one stable `receipt-media:${randomUUID()}` owner per process-instance coordinator, and a constant non-PII exhaustion alert. The maintainer explicitly approved a 50 ms poll floor: configured 1–49 ms runs at 50 ms; values at or above 50 ms remain unchanged. Prove the boundary directly in tests. The adapter already owns the fixed database-time 60-second lease; do not introduce a second lease implementation.
- Preserve enabled strict configuration, disabled boot without receipt settings, singleton composition and no duplicate worker on repeated module imports.
- Critical gate: prove active notification work drains before the real PostgreSQL lifecycle invokes pool.end. Do not hide ordering by overriding the lifecycle or making pool.end a no-op. If safety requires edits outside the three source paths, stop and request a scoped replan.
- No live PostgreSQL, Meta, backend, S3 or LLM calls; lifecycle tests use instrumented fake external boundaries.
- Forecast: 290–390 gross additions plus deletions across all three source paths. This and the approximate 400-line planning heuristic are advisory, not hard caps. Never omit coverage, minify or split artificially to meet an estimate; report material scope changes before expanding edits.
- Technical artifacts remain in English.

## TDD and runtime harness

- Mode: enabled by explicit maintainer approval.
- Focused runner: `pnpm test -- src/receipt-media/receipt-media.module.spec.ts src/whatsapp/whatsapp.module.spec.ts src/receipt-media/infrastructure/receipt-media-notification.worker.spec.ts`.
- Observe expected missing enabled lifecycle RED before production edits. Follow with minimal GREEN and lifecycle triangulation; retain exact command/results, including any safety gate failure.
- Use actual Nest TestingModule init/close with fake transactional PG_POOL and sender, controllable timers/deferred sends, and deterministic environment isolation. Merely compiling the graph does not prove lifecycle behavior.
- Prove enabled claims start only after initialization, configured owner/options/poll/lease invariants, single coordinator under duplicate imports, disabled no-I/O, constant exhaustion alert, sleeping shutdown, in-flight claim/send shutdown, drain-before-pool.end and no rearming. Assert forbidden ingestion and ReceiptOutboxService behavior in both modes; token absence alone is not proof that a privately owned worker did not run.
- Rollback: remove only the new coordinator/provider and revert the two spec transitions, retaining checkpointed WU14C/D composition.

## Checklist

- [x] **WU14E-1 — IMPLEMENT:** Observe RED, implement enabled-only notification lifecycle, and triangulate real initialization/shutdown safety inside the approved scope.
- [x] **WU14E-2 — VERIFY:** Review source and TDD evidence, run scoped checks and an independent spot check, record hashes and gross A+D, and separate baseline diagnostics from regressions.
- [x] **WU14E-3 — REVIEW:** Complete applicable native review, reconcile evidence and remaining checks, and leave the candidate uncommitted.

## Required checks

- Focused runner above.
- Regression: `pnpm test -- src/whatsapp/application/webhook-dispatcher.service.spec.ts`.
- `pnpm exec eslint src/receipt-media/receipt-media.module.ts src/receipt-media/receipt-media.module.spec.ts src/whatsapp/whatsapp.module.spec.ts`.
- `pnpm exec prettier --check src/receipt-media/receipt-media.module.ts src/receipt-media/receipt-media.module.spec.ts src/whatsapp/whatsapp.module.spec.ts`.
- `git diff --check -- src/receipt-media/receipt-media.module.ts src/receipt-media/receipt-media.module.spec.ts src/whatsapp/whatsapp.module.spec.ts`.
- `pnpm exec tsc --noEmit --incremental false`: prior baseline is exactly 119 pre-existing diagnostics. Require zero new/candidate diagnostics; report the actual exit and errors, not a blanket clean result.
- Hash candidate files before/after final verification; capture hashes before any read that might normalize files. Only the three authorized sources may be tracked-modified; staging empty; protected untracked contents untouched.

## Progress and evidence

- Parent confirmed baseline HEAD, clean tracked worktree/staging, exactly 14 pre-existing untracked paths, absent tracker and dist-temp, and unchanged WU14C/D source hashes.
- Read-only scout returned conditional GO. Maintainer resolved both gates: explicit three-path scope and boot-time/redeploy flag semantics. Shutdown ordering remains a mandatory technical proof, not an assumed fact.
- Initial writer candidate reports expected enabled-lifecycle RED (8 failed / 23 passed), then GREEN (32 focused tests plus 53 dispatcher regression tests). Scoped lint/format/diff checks passed; nonincremental TypeScript retained 119 pre-existing diagnostics and zero candidate diagnostics. These writer results do not close parent verification.
- Parent measured 879 gross A+D (836 additions / 43 deletions), above the advisory 290–390 forecast, primarily from instrumented module/host lifecycle fixtures. All changes remain inside the three approved source paths; no size-only test reduction is requested.
- Writer reported real Nest init/close proofs for deferred send/claim shutdown before pool.end, no post-close query, duplicate imports, disabled no-I/O and redacted exhaustion. Fresh independent verification below confirmed the bounded lifecycle behavior.
- Parent found a repeated-bootstrap defect. Writer observed RED (2 failed / 32 passed) by directly invoking the real coordinator hooks: duplicate owners and post-shutdown polling. A latched started flag fixed it; direct timing tests at configured 1/49/50/2000 ms prove the maintainer-approved poll floor. All probes were reverted before final checks.
- Corrected writer checks: 38 focused tests plus 53 dispatcher tests passed; lint/format/diff clean; TypeScript remained at 119 baseline diagnostics, zero candidate errors. Writer candidate measured 1029 gross A+D.
- Parent removed one vacuous assertion comparing awaited void results as if they were promise handles; repeated-stop/no-rearm behavior assertions remain. Fresh parent spot check passed all 38 focused tests with stable source hashes. Active LSP found no TypeScript diagnostics; six auxiliary import/style/Spanish-spelling advisories remain non-blocking.
- Current source size is 1028 gross A+D (985 additions / 43 deletions). SHA-256: module `0576458ba3740670e70d49911f9cc22b398e4e1e4822975d76a5b36cfb7a720a`; receipt spec `9efc70e119d602b4b4d8c2e3ee58b7fe82704c41719f1917acd629dc28a118ee`; host spec `965379b1cd0892c3a20437d29743eef16c76b8562efa1d65f2f16b37366649c9`.
- Fresh independent verifier `mu3ozzey-a-kcda` returned PASS with no material source defects: focused 38/38, dispatcher 53/53, contaminated-shell receipt/host 27/27; scoped lint/format/diff passed; TypeScript remained at 119 baseline diagnostics and zero candidate diagnostics. All four hashes matched before reads, after reads and after checks. An outside-turn normalization notice produced no observed byte change. Tracker hash during verification was `b6314a1d92e36c00d4556ef6ea93a5c14b5e7b5fb2f870ed8a81739af643e603`, before this reconciliation.
- Evidence limits: lifecycle tests use real Nest receipt/WhatsApp testing graphs and instrumented fake pools, not full AppModule, OS signals, live PostgreSQL or deployment. The 60-second SQL lease is source-confirmed, not database-executed here. Batch/maxConcurrency mapping and the one-constant log call are source-confirmed; lifecycle assertions alone do not independently distinguish both concurrency options or exclude every extra log argument. Some repeated-close cleanup suppresses errors, while primary shutdown awaits/asserts ordering directly.
- Initial native risk assessment was unavailable (empty native output); its prescribed independent-verifier fallback was satisfied. Native START later classified the exact candidate as medium, selecting one consolidated reliability review over four paths (1100 original changed lines including tracker, 200 logical correction budget).
- Native review `review-84ef0f90f179088d` approved target `sha256:89da2d0be665623f915e289a57aaf623e2fb305dac7aaae43dcd59f883c13dec`. Acknowledgement consumed revision `sha256:672edd2230012a45ade2fe40a64878f3f6877f6c5df7004c89e1a00b2aefd448` and burned authority. Scope included only the three tracked WU14E sources and this intended-untracked tracker; all 14 protected untracked paths were excluded.
- WU14E-1 through WU14E-3 are complete. This final tracker-only reconciliation records review closure after acknowledgement; reviewed source bytes remain unchanged. WU14E is uncommitted. Deployment readiness and live-service operation are not claimed.

## Next step

Await explicit maintainer authorization for a local WU14E checkpoint or subsequent unit. No commit, push, or PR is authorized; ingestion and outbox intent production remain deferred.
