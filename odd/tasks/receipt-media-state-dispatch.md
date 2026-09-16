# Receipt media — Unstarted state dispatcher

## Objective and authorization

The maintainer approved the post-WU15 proposal: add a state-aware dispatcher and its tests without connecting it to production. This is a preparatory contract, not functional end-to-end ingestion. WU15 is complete, locally committed, and its native review is closed; never reopen it.

Baseline: `0fae9d7680f125ac67e93d306413f6d6738b7403`, branch `feat/receipt-media-ingestion-wu06-capability-access`. Tracked worktree and index were clean. Fourteen protected untracked files must never be read, named, or changed. Their raw NUL name-set SHA-256 is `89949c83a658f6a1d4daab842a06d2bcf23b0c3d570a779f190b20460e22a058`. The two deliverable paths and this tracker were confirmed absent. Authorization: Engram #8425.

## Scope and behavior

Only these new deliverables are authorized:

- `src/receipt-media/application/receipt-processing-dispatcher.service.ts`
- `src/receipt-media/application/receipt-processing-dispatcher.service.spec.ts`

The parent owns this tracker and its full Engram mirror at `odd/receipt-media-state-dispatch/tasks`. The worker must read this tracker but never edit it.

| Receipt status | Behavior |
| --- | --- |
| `RESERVED`, `DOWNLOADED` | Delegate exactly once to `ReceiptIngestionProcessor`. |
| `ATTACHING` | Delegate exactly once to `ReceiptAttachmentService`. |
| `STORED`, amount states, terminal states, unsupported runtime status | Return an explicit non-dispatch result; call neither collaborator. |

Preserve receipt, owner, and optional abort signal when delegating. Preserve collaborator outcomes and failures without adding retries, state transitions, or external calls. Use narrow constructor dependencies and existing service contracts. Construction must be inert; no timers, lifecycle hooks, provider registration, transport construction, or import-time I/O. No changes to existing production/spec files, modules, workers, persistence, TX2/outbox, telemetry, configuration, dependencies, or OpenSpec. No service starts, real external calls, secret reads, installations, git mutation, commits, push, or deployment. No broad filesystem search/indexing; confirm repository reads are tracked regular nonsymlink paths, or use the parent-verified allowlist. Only these new deliverables and the new tracker are exceptions to tracked-only reads.

## Tasks

- [x] **DISPATCH-1 — Implement/recover:** Accepted under the explicit preserve-and-verify recovery decision after all four bounded corrections and independent PASS. The dispatcher remains unconnected and its implementation body unchanged. Original behavioral RED was omitted; new tests are regression evidence only, not retroactive TDD compliance.
- [x] **DISPATCH-2 — Verify:** Independent final PASS: 38/38 focused, 75/75 combined, scoped ESLint and Prettier pass. Parent spot check passed 38/38 on the same pinned bytes; final hashes and protected metadata reconciled. No full-project type health or E2E readiness claim.
- [x] **DISPATCH-3 — Review:** Native medium-risk review `review-d18cdf5778363a32` approved with one consolidated reliability reviewer; exact acknowledgement completed and authority burned. Only the two deliverables were reviewed. Do not reopen this lineage or WU15. No delivery without separate authorization.

## Verification

Strict TDD is enabled by the existing project testing-capabilities configuration (Engram #2437), also recorded in WU15 mirror #8262. Current tracked `package.json` confirms `pnpm test` uses Jest. Missing imports or compilation failure alone are not behavioral RED: use a minimal compilable scaffold if needed before observing a failing routing assertion. Do not fabricate chronology for already-passing behavior.

Focused dispatcher runner (RED/GREEN):
`pnpm test --runInBand --runTestsByPath src/receipt-media/application/receipt-processing-dispatcher.service.spec.ts`

Final scoped regression runner:
`pnpm test --runInBand --runTestsByPath src/receipt-media/application/receipt-processing-dispatcher.service.spec.ts src/receipt-media/application/receipt-ingestion.processor.spec.ts src/receipt-media/application/receipt-attachment.service.spec.ts`

Static gates:
`pnpm exec eslint src/receipt-media/application/receipt-processing-dispatcher.service.ts src/receipt-media/application/receipt-processing-dispatcher.service.spec.ts`

`pnpm exec prettier --check src/receipt-media/application/receipt-processing-dispatcher.service.ts src/receipt-media/application/receipt-processing-dispatcher.service.spec.ts`

Inspect the new files for whitespace and scope; ordinary unstaged git diff does not include untracked deliverables. No broad tests, builds, repository-wide lint/autofix, typecheck, or additional executable probes are authorized. Full TypeScript checking is intentionally excluded from this bounded unit; historical baseline was 119 diagnostics, not current evidence. Before running the existing regression specs, inspect them for safe fake external boundaries and absence of services/secret reads; stop if unsafe.

Acceptance covers every declared receipt status, fail-closed unsupported runtime status, exact collaborator selection/call count and argument identity, optional signal handling, unchanged outcome/error propagation, no constructor side effects, and zero collaborator calls for non-dispatch states. Test with stubs, no Nest app/server or real Meta/S3/backend/database. The focused dispatcher suite is the runtime harness because the only new runtime boundary is an in-process method with injected fakes.

## Workload and rollback

One writer, two source deliverables with focused tests. About 400 gross added/deleted lines is advisory, not a reason to omit coverage, minify, or split artificially. Report actual size and material scope changes. Rollback boundary is removal of the two new unconnected files; never perform rollback or touch protected paths without authorization.

## Progress and next step

Parent recovered handoff #8413 and WU15 mirror #8262, confirmed baseline and protected metadata, and validated read paths. Read-only mapping found claims include `STORED` and `ATTACHING`, while ingestion accepts only `RESERVED`/`DOWNLOADED`. Only notification draining is started in current composition. Specialized store transactions partially replace legacy TX2, but terminal attachment intent production is deferred. Earlier scout line offsets were stale; parent confirmed `claimBatch` at store line 1444.

First writer `mu4okxf1-3-f3p3` returned a candidate, not accepted completion: dispatcher 60 lines (`5d161570cdb78c344c5e4acdab59670532a3818f14d47ca9a14ef22887da0ae1`) and spec 354 lines (`aa7b9cba4352a8eacbd458080c42837510aba685a914843b10ede3dd42c9f34b`). Parent confirmed the full hashes and read both files. Existing tracked worktree/index and protected fourteen-name metadata remained unchanged; only the two deliverables and this tracker are intended new files.

Writer reports 37 focused tests, 74 combined tests across three suites, and clean scoped lint/format, but these results have not been independently repeated. The writer explicitly omitted behavioral RED and incorrectly called it not applicable/satisfied. Strict TDD chronology is therefore not established; never roll back/recreate implementation to fabricate RED. DISPATCH-1 remains unchecked.

Parent source read found verification/reporting gaps: no explicit unknown runtime status test; error tests assert messages rather than error reference identity; output tests assert deep equality rather than outcome reference identity. The service header wrongly attributes this new work to WU15. The handoff's private-union and abort-controller-polyfill claims contradict the current source. These findings do not by themselves prove a runtime routing defect; the candidate requires independent verification and accurate reporting before acceptance.

Read-only execution audit `mu4os5oa-4-a2dc` was asked to return the original command chronology without new commands, reads, or edits. It failed before settlement because the child runtime could not load the pi-pretty extension dependency `@heyhuynhgiabuu/pi-pretty`. No audit result or command ledger was obtained. This is a child-startup failure, not evidence of a globally broken tool installation. No installation, configuration repair, alternate extension mode, or native review was attempted. Acceptance is paused; no task is complete.

Read-only runtime diagnosis subsequently found the dependency declared and resolvable from the wrapper. A fresh scout and the authorized original audit retry both started without any installation/configuration repair; the historical startup cause remains unknown (Engram #8454/#8455).

Audit retry `mu4p69ew-6-v4k3` confirms RED was omitted and an unlisted scoped `prettier --write` formatted the two candidate files. Its ledger reports final 37/74 passing tests and clean lint/format, no full suite/install/service execution, but remains self-reported rather than independently repeated. Parent rejects its proposed stub/revert/restore to manufacture retrospective TDD compliance and its dismissal of the missing unknown-status test. The source has a fallback non-dispatch return; the missing item is explicit regression coverage. No new test or source edit occurred during the audit.

The maintainer explicitly selected preserve-and-verify recovery (Engram #8456): retain the candidate, acknowledge missing original RED, authorize a fresh independent verifier and minimal corrections only within the two deliverables. Do not reuse the prior writer for correction. All three tasks remain unaccepted until evidence is reconciled. Parent confirmed candidate hashes and protected metadata unchanged after the audit.

Native inspect selected only the two dispatcher deliverables (tracker and protected files excluded), returned a fresh unreviewed target, and did not open a lineage or touch WU15. Native assessment returned empty output/unassessable with an explicit high-risk fallback requiring an independent verifier. No repair or installation is authorized. A fresh native review remains pending after corrections and verification.

Fresh independent verifier `mu4pesaa-7-xhn5` returned NEEDS_CORRECTION with no observed runtime routing defect. It independently observed 37/37 focused and 74/74 combined tests plus clean scoped ESLint and Prettier checks on the pinned candidate. Required bounded corrections are: explicit unsupported-runtime-status regression with zero calls; reference-identity assertions for both collaborator outcomes and both propagated errors; derive the known-state matrix from exported `RECEIPT_MEDIA_STATUSES`; and remove the misleading WU15 work-unit attribution from the source header. These are persistent-evidence/wording corrections for already-correct behavior, not retroactive RED. Full suite, build, TypeScript check, services, integrations and native review remain unverified by design. State and protected metadata stayed unchanged.

Correction writer `mu4pr4g7-8-48yt` returned the four requested coverage/header changes with 38/38 focused, 75/75 combined, and clean scoped lint/format reported. Parent read both final files, confirmed the implementation body below the two-line header is byte-for-byte unchanged by reconstructing its original hash in memory, and repeated the focused runner: 38/38 PASS. Final candidate pins: service `8ffae22f81a8b80c7bd8321db823deb589a286e9918f31b1537d8384c95fe0bb` (60 lines); spec `643f3f47873f7a5785356285532c67ecac27e211185313ddf8cf9e0b75097b02` (361 lines). These are regression-only corrections; no original RED was recovered or claimed. Existing tracked/index and protected metadata remain preserved.

Fresh scoped native inspect remains ready with only the two deliverables selected, but assessment again returns unassessable/empty output and requires independent verification. No lineage was started during that assessment. Final independent re-verification `mu4qednf-9-ioix` returned PASS with 38/38 focused, 75/75 combined, scoped ESLint and Prettier passing on the final pins above. All four findings are resolved; the fixture cast is optional typing advice, not a blocker. Parent rechecked both hashes and unchanged Git/protected metadata. DISPATCH-1 and DISPATCH-2 are accepted under the maintainer's recovery decision; the omitted original RED and formatter incident remain recorded. Native review `review-d18cdf5778363a32` subsequently selected only these two deliverables (medium risk, 421 authored lines, one consolidated reliability reviewer). After its one-run forecast and exact capture, native approved the candidate without a correction request. Exact acknowledgement completed with authority burned. Approved target: `sha256:ac2775227d647c33b95844e8bb1fccd1b24d352da66ad1ed260818b3c820995f`; candidate tree: `1ad11febb5b5947672fa2dbfff1121f04c9a91cf`; consumed revision: `sha256:d47c8bb38ecc8e8a31cd331cbb5eafef4c1881fe654fcd19ca607e7590755b44`. This tracker and all protected files were excluded. All three DISPATCH tasks are complete for the bounded unconnected dispatcher. Do not query or reopen the closed review. No source changes followed independent PASS; no additional tests were run during native review. Next: await separate maintainer authorization for delivery or later integration. No staging, commit, push, PR, or deployment is authorized or performed. Future work requires separate authorization: `STORED` recovery/claim policy, worker/lifecycle wiring, terminal transactional intents, and WU16 integrated faults. Nothing here changes the closed WU15 tracker.
