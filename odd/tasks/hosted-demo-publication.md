# Publish both chatbot histories for a RESTOCK-only demonstration

Preserve shipping/receipt and RESTOCK development in one verified source tree. Only the RESTOCK journey is in scope for the meeting; unfinished shipping acceptance and receipt rollout remain disabled and explicitly pending. The owner performs push, hosted redeployment, and all browser/visual checks.

## Authority and boundaries

- Owner explicitly selected both histories, then RESTOCK-only demonstration.
- Owner granted one exception to the 390-line work-unit limit for integrating already committed histories. New functional corrections remain bounded; this is not permission for new features.
- Only this `houndfe-chatbot-human-decisions` worktree may be written. Preserve the principal shipping checkout and its untracked files.
- No force updates, stash, reset, data deletion, new worktree, push, remote deployment, or provider activation is authorized by this integration.
- Keep hosted configuration and credentials separate from local ones. Never publish local `.env` files, build artifacts, or service keys.
- Backend/FE owners prepare their corresponding complete source units. Their local database grants do not authorize hosted mutations.

## Frozen inputs

| Input | Commit |
| --- | --- |
| Local main / common ancestor | `ef5b5f557c64e77daff48cf67080707a3cbdf2e6` |
| RESTOCK | `0c5a8e282203d0a5fb3279980a13032597b49099` |
| Shipping / receipt | `116ce039062a3a198c17c05d54de1e44d8c99f21` |

Readonly Git evidence: 242 shipping-only and 192 RESTOCK-only commits; 194 and 179 changed paths respectively, with 44 overlapping paths. A legacy merge preview found 20 text-conflict files / 38 regions. This is not proof of a completed merge or a successful build. No listed worktree owns main; remote tips remain unverified.

## Tasks

- [x] P0 — Identify histories, unfinished scope, and owner decisions. Evidence: parent Git inventory and scouts `muib58sr-36-jh95` / `muibnzfr-37-skqp`; no source mutations.
- [ ] P1 — Integrate both histories, resolve shared-boundary conflicts, independently verify the combined tree, record the native-review outcome and owner exception below, and commit the history-preserving merge with both parents recorded. **IN PROGRESS**. Parent owns Git/index operations; one delegated writer owns source resolution. Preserve safeguards, tests, and first failures. Do not implement SCA-4c/5/6 now. Surface controller scope limitations rather than claiming prior branch reviews approve the merge.
- [ ] P2 — Verify the RESTOCK-only deployment posture and prepare the cross-service release manifest. Keep unfinished shipping/receipt capabilities visibly pending; identify residual-state and hosted configuration/migration gates without touching databases or secrets.
- [ ] P3 — Promote the verified source to local main after rechecking ancestry, worktree ownership, and source cleanliness. Preserve protected principal files; no force updates or remote delivery.
- [ ] P4 — Give the owner push/redeploy and manual rehearsal instructions after hosted prerequisites and required grants are established. Check CI/autodeploy before even the owner push: it may trigger deployment and database migrations. No automated browser tests or unauthorized provider calls.

## Verification and safety gates

- Preserve RESTOCK source identity, authenticated evidence, reservation/CAS, sender/channel/window checks, durable acceptance/ACK, closure, and no-repeat uncertainty behavior.
- Preserve shipping pricing/consent gates, receipt STORED hold, accepted-media retention, uncertain attachment protection, exact ops identity, and sandbox normalization opt-in.
- Check shared module composition, conversation sibling preservation, dispatcher ordering, and default-off behavior. Disabled flags alone do not prove old persisted markers are inert.
- Use no-artifact spec/build typechecks (`--noEmit --incremental false`), non-fixing scoped lint, focused boundary tests, and proportionate full offline regression.
- Database tests, if needed, use separately scoped owned disposable PostgreSQL only. No existing local/hosted database is an integration fixture.
- Bot and backend Docker entrypoints run migrations before the application. Hosted migration inventory, backups, configuration, and exact target must be established before delivery; CI/autodeploy is unverified, so a push itself may trigger database writes. Backend adds RESTOCK `20260925000100` and coordinates `20260926000100` relative to its local main.
- The backend's one authorized local credential now exists in ignored private custody. Do not provision another, read or copy its key, or build Docker from a local context containing private nested `.env` files. A clean selected Git build context is distinct from the local worktree.

## Fresh demonstration cases

Do not delete conversations or requests to reset the demonstration. A new verified sender is the cleanest fresh case. Reusing a sender requires the prior application to reach durable ACK and `CLOSED`; a new message then has a new source identity. Conversation/cart context persists. Restarting the volatile poller is not recovery for a pending case.

## Current evidence

RESTOCK-only commit `0c5a8e2`: independent one real-PostgreSQL chain plus 78 unit tests; native four-lens approval acknowledged. This proves internal Nest/PG processing with simulated external backend/sender, not the combined tree or real Meta/LLM/POS behavior. Combined verification and a live rehearsal remain pending.

Parent prepared the merge without a commit: expected conflict exit 1, `MERGE_HEAD=116ce039062a3a198c17c05d54de1e44d8c99f21`, exactly 20 unmerged paths. HEAD and main have not advanced. The first writer dispatch was rejected before queueing due to allowed-surface heading formatting, then corrected; no duplicate writer was launched.

Writer `muicpaxv-38-znzm` stopped before edits because automatically merged `src/conversation/domain/conversation-store.ts` contained duplicate guards and incompatible clear contracts. Parent confirmed the source and authorized that exact additional path. Continuation `muicu0y9-39-exw7` was launched: preserve structural versus canonical marker validation and timestamp-updating three-argument versus timestamp-preserving two-argument clear behavior; invalid explicit arguments must still fail closed. No staging/commits are delegated. Writer `muicu0y9-39-exw7` reconciled the domain guard names and both adapter clear contracts, then stopped for one constructor fixture outside its scope. Parent authorized only that existing constructor in `src/human-handoff/application/human-handoff.reservation.db.spec.ts`, retaining both required dependencies and prohibiting DB execution. Continuation `muid2y3s-3a-j517` resolved explicit conflict markers. Production no-artifact typecheck passed; the first spec typecheck failed with six duplicate-declaration errors across four automatically merged test files. Focused tests and standalone lint/format checks remained pending. Parent authorized only duplicate fixture/helper reconciliation in those four files and launched continuation `muidj411-3b-172q` with 26 allowed paths.

The legacy nonshipping lost-CAS tests had incompatible outcomes between branches. Preserve the explicit `no_pending` outcome for a confirmed null resolve only, plus all no-clear/no-close/no-send safeguards. The worker observed 2 failures / 159 passes in the service suite, then retained both scenarios and reconciled the null outcome and an unstubbed persisted result; 161 tests passed. No-close/no-clear assertions remain, with no-update/no-send/single-resolve checks added. This is contract reconciliation, not evidence of new behavior RED→GREEN.

Continuation `muidj411-3b-172q` reported both typechecks passing, 730 focused tests passing with 23 DB tests skipped, and scoped lint/format passing. Additional overload/marker triangulation passed its unit checks. These overlapping runs must not be summed as unique coverage. A module pair then failed 1 test / passed 8: shipping-policy injection was asserted at the old constructor index. Parent authorized only `src/human-handoff/human-handoff.module.spec.ts` to assert reservations at index 4 and shipping policy at index 5. Continuation `muidqs6g-3c-st9j` was launched with 27 paths for that fix and final post-triangulation type/lint/format checks. Independent combined verification remains pending.

Native ASSESS was unassessable because its untracked declaration handling remained blocked even after INSPECT explicitly excluded untracked paths and returned READY. Treat the candidate as high risk: writer self-verification plus an independent verifier are required. No approval or lineage was created by ASSESS.

Parent staged the 27 resolutions and this tracker: tree `b7a5952784dce4bea20bda1e80e0e8f2f3df87fc`, 187 files / 39,621 additions / 749 deletions, no unmerged index entries. Native START then stopped at preflight with `lens_context_budget_exceeded`; no review authority was created. Repeating that candidate cannot succeed. The owner explicitly granted a native-review exception for this combined merge only, conditional on passing tests and independent verification. No native approval is claimed, and global RDD configuration is unchanged.

Independent verifier `muie1yxo-3d-86cg` passed both typechecks and the owned PostgreSQL RESTOCK chain (1 test, 13.629s), with observed container cleanup and no source/ref drift. Full offline tests were NOT RUN because a database-module fixture could read private `.env`; conversation PG tests were NOT RUN because their migration subprocess inherited environment and lacked a pin. No new production defect was demonstrated. Writer `muieegr4-3e-9aou` corrected only those two test harnesses: 109 additions / 18 deletions (127 lines, within the 390-line limit). Both config factories explicitly ignore env files; migration uses the installed CLI through `process.execPath`, pin `2600000000000`, and exactly the owned `DATABASE_URL` environment, with finally-protected cleanup. First safe executions passed: database-module unit 1 passed / 1 skipped; conversation suite 49 passed (3.503s), including both real-PG clear paths and fail-closed cases; both typechecks and scoped lint/format passed. Owned container cleanup was observed. No production code changed. Final independent full offline verification remains pending.

Independent continuation `muieng4m-3f-pobn` passed all 49 conversation cases (23 offline / 26 real PG, 3.297s) on `bddac4920adeb73815fc922cd467748a185e479d`, with observed cleanup and read-only integrity checks. It stopped the full suite before execution on one additional ungated conversation-module config fixture. Writer `muif8qui-3g-b0nk` audited this configuration-entrypoint class across configured test roots: only that fixture remained unsafe; the actual AppModule test import is config-stubbed. The 7-line fixture correction explicitly ignores env files and restores its synthetic cashier variable. Targeted test, both typechecks, lint/format passed; production code stayed unchanged. Final full offline verification still must execute.

The verifier disclosed an initial prohibited `git write-tree --missing-ok` command. It returned the existing expected tree; source/index-entry/ref comparisons showed no changes, but physical object/cache writes were not ruled out. Do not repeat it in verifier tasks; no rollback or destructive cleanup is warranted by the observed evidence.

The first independently executed full offline suite on staged tree `eecff4016c71786fc74199966a1a4a6cb79715ae` failed: `RUN_DOCKER_TESTS=0 pnpm exec jest --no-cache --runInBand`, exit 1 in 20.723s, 175 suites passed / 1 failed / 30 skipped and 5,103 tests passed / 1 failed / 755 skipped. The enabled RESTOCK composition fixture in `src/whatsapp/whatsapp.module.spec.ts` supplied only `attachReceipt`, leaving the runtime's required `recordRestockApplicationOutcome` undefined. Both exact no-artifact typechecks passed. No production defect was established; do not relabel this run as passing.

A subsequent test-only correction in that one fixture supplies rejecting backend and sender collaborators, retains the real enabled runtime and `WHATSAPP_SENDER` alias, and asserts no external calls. Writer's focused `RUN_DOCKER_TESTS=0 pnpm exec jest --no-cache --runInBand --runTestsByPath src/whatsapp/whatsapp.module.spec.ts` passed 10 tests in 3.057s; exact spec/build typechecks, non-fixing scoped lint/format, and diff check passed.

Independent verifier `muigc8vv-1-17i9` executed the complete offline suite once on staged tree `96fc6c6b9a5ba2f4718613ded2b0be943e0736c5`: exit 0, 20.082s wall time, **176 suites passed / 30 skipped; 5,104 tests passed / 755 skipped**. Exact spec/build no-artifact typechecks, non-fixing ESLint/Prettier on the corrected fixture, and cached diff check all exited 0. Before/after tree comparison, staged-diff and index-entry hashes, HEAD/MERGE_HEAD/main, and tracked working tree were stable. The verifier made no Git writes and did not claim native approval. The present evidence authorizes only the local merge under the owner's one-merge native-review exception. Real-PG chain and conversation evidence belongs to earlier byte-compatible inputs; PG was not rerun on this final tree. Hosted behavior and live providers remain unverified.
