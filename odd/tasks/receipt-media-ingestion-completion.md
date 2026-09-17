# Receipt media ingestion completion — ODD authority

## Objective

Complete the remaining receipt-media ingestion work through Organic Driven Development (ODD) only, while preserving the existing OpenSpec material as historical and normative reference evidence.

This document is the sole live execution authority for the unfinished receipt-media ingestion work. It replaces `openspec/changes/receipt-media-ingestion/tasks.md` as the source of current task status. It does not delete, rewrite, archive, or resume any SDD/OpenSpec lifecycle.

## Why

The maintainer explicitly selected an ODD-only workflow for this repository. The previous OpenSpec task ledger mixes completed, stale, and genuinely unfinished work. Existing ODD trackers and current source composition now provide more accurate implementation status, so the remaining work needs one recoverable ODD plan without losing prior evidence.

## Scope

This feature covers only the remaining receipt-media ingestion completion work:

- atomic webhook admission and durable causality;
- durable lifecycle recovery and transactional intent production;
- safe production composition of the existing ingestion worker and dispatcher;
- normalized media-caption routing and customer guidance;
- capability-access integration evidence;
- integrated fault-path E2E evidence;
- requirement-to-assertion traceability and final validation;
- owner-gated provisioning and staging work.

## Constraints and non-goals

- Use ODD only. Do not invoke SDD agents, phases, status, verification, synchronization, or archive workflows.
- Preserve `openspec/changes/receipt-media-ingestion/**` as historical and normative reference material.
- Do not copy stale OpenSpec checkboxes into this document as live status.
- Preserve the completed STORED automatic-claim hold. Do not re-enable automatic STORED claims incidentally.
- Do not activate ingestion, expand LLM or notification authority, change backend behavior, provision infrastructure, deploy, push, or contact external services without task-specific authorization.
- Keep existing closed reviews and accepted ODD evidence closed; do not reopen them merely for migration.
- About 400 authored changed lines per implementation task is a planning heuristic only, never a reason to omit tests or split behavior artificially.

## Authority and references

Historical OpenSpec reference directory:

- `openspec/changes/receipt-media-ingestion/`

Inherited ODD evidence:

| Tracker | Inherited status |
| --- | --- |
| `odd/tasks/receipt-media-state-dispatch.md` | Completed state-aware dispatch contract; intentionally unconnected when delivered. |
| `odd/tasks/receipt-media-stored-worker.md` | Completed STORED automatic-claim hold and worker-to-dispatcher conversion; integrated into local `main`. |
| `odd/tasks/receipt-media-wu14c.md` | Completed non-worker receipt-media module composition. |
| `odd/tasks/receipt-media-wu14d.md` | Completed WhatsApp host-module integration. |
| `odd/tasks/receipt-media-wu14e.md` | Completed enabled-only notification lifecycle composition. |
| `odd/tasks/receipt-media-wu15.md` | Completed authenticated telemetry foundation and operations runbook; broader historical emitter ambitions remain outside that bounded result. |

Current composition evidence:

- `ReceiptMediaIngestionWorker` delegates through `ReceiptProcessingDispatcher`.
- `ReceiptMediaModule` composes receipt access and notification lifecycle, but does not register the ingestion worker and dispatcher for production execution.
- `InboundMedia` carries a normalized caption, but current receipt admission does not yet propagate it through the full receipt flow.
- Receipt capability access is mounted through `ReceiptMediaAccessController`; integration/security evidence remains to be reconciled rather than treating the controller as absent.

## Delivery and testing policy

- Delivery strategy: `ask-on-risk`.
- No commit, push, PR, merge, deployment, or release is authorized by this document.
- Forecast: the remaining implementation will exceed one review slice and must proceed as bounded work-unit commits only after task-specific implementation authorization and ordinary delivery approval.
- Strict TDD was historically enabled for this project. Before each future implementation task, reconcile the current project/session testing configuration and exact runner; record observed RED, GREEN, and REFACTOR evidence when TDD remains enabled. Never invent historical RED evidence.
- Each task must define its exact allowed edit surfaces and focused checks before writing source.

## Actionable checklist

- [x] **ODD-0 — Adopt and reconcile execution authority**
  - Established this file as the sole live task/status authority.
  - Preserved OpenSpec artifacts as reference evidence.
  - Added a concise supersession banner to the old OpenSpec task ledger without rewriting its history.
  - Reconciled completed evidence from existing ODD trackers and current source composition.

- [x] **ODD-1 — Reconcile receipt admission causality**
  - [x] **ODD-1A — Atomic receipt-admission persistence:** verified atomic receipt-plus-marker commit, rollback, concurrent convergence, legacy replay, provider reuse, conflict, active-sender behavior, and unrelated-error propagation.
  - [x] **ODD-1B — Dispatcher adoption and acknowledgement proof:** verified conditional marker ownership, marker-only replay short-circuiting, all eight admission outcomes, and receipt-media HTTP settlement/failure behavior.
  - [x] **ODD-1C — Cross-boundary resilience evidence:** proven concurrent same-message admission, rollback of both durable artifacts, and replay after adapter recreation by `webhook-receipt-admission.integration.spec.ts` (Testcontainers PostgreSQL, 4/4).
  - Preserve raw Meta signature verification, existing message precedence, the STORED hold, and the current caption boundary.

- [ ] **ODD-2 — Complete durable lifecycle recovery and intents**
  - Define terminal and retry recovery for every processor/attachment outcome.
  - Commit all required deterministic outbox intents transactionally with state changes.
  - Preserve lease/version fencing and safe unknown-outcome handling.
  - Keep STORED rows held from automatic claims until an explicitly authorized reconciliation design replaces that hold.
  - [x] **ODD-2A — Atomic unknown-outcome recovery with its deterministic intent:** reclaimed `crashed-before-post` ATTACHING rows fix forward with zero POSTs; `commitAttachUnknownOutcome` owns exactly one row-derived `RECEIPT_ATTACH_UNKNOWN` intent in the same transaction, validates it on replay, repairs an otherwise exact legacy successor missing only its intent under the live-lease fence, and fences foreign/rival evidence with full rollback. ODD-2B2/2C/2D/2E, ODD-3, and later remain deferred.
  - [x] **ODD-2B1 — Atomic success intent ownership:** `commitAttachSuccess` transitions the exact fenced ATTACHING request to ATTACHED and owns exactly one row-derived deterministic `RECEIPT_ATTACHED_PENDING` intent in the same PostgreSQL transaction (`receipt-attached-pending:<receiptId>:<successorVersion>:<storedWebhookMessageId>`, row-derived receipt/version/webhook/sender, `templateArgs` exactly `{ backendStatus: 'PENDING' }`), validates the exact persisted intent on replay, repairs an otherwise exact legacy ATTACHED successor missing only that intent under the live-lease `clock_timestamp()` + `FOR UPDATE` fence, locks the outbox row during validation, and fences foreign/rival evidence with full rollback. The `ReceiptAttachmentService` report is unchanged and does not expose intent. ODD-2C, ODD-2D, ODD-2E, ODD-3, and later remain deferred.
  - [x] **ODD-2B2 — Atomic definite-failure intent ownership:** `commitAttachDefiniteFailure` transitions the exact fenced ATTACHING request to `FAILED/ATTACH_DEFINITE` and owns exactly one row-derived deterministic `RECEIPT_ATTACH_DEFINITE_FAILURE` intent in the same PostgreSQL transaction (`receipt-attach-definite-failure:<receiptId>:<successorVersion>:<storedWebhookMessageId>`, row-derived receipt/version/webhook/sender, `templateArgs` exactly `{}`), validates every deterministic intent field on replay, repairs an otherwise exact legacy `FAILED/ATTACH_DEFINITE` successor missing only that intent under the exact original command, owner, and live-lease `clock_timestamp()` + `FOR UPDATE` fence, locks the outbox row during validation, fences foreign/rival evidence with full rollback, and fences the fresh transition with `clock_timestamp()` so a lock wait that outlives the lease rolls back state and intent. Non-fenced `failed`/`replayed` outcomes carry the persisted intent, `fenced` stays intent-free, and the `ReceiptAttachmentService` report is unchanged and does not expose intent. ODD-2C, ODD-2D, ODD-2E, ODD-3, and later remain deferred.

- [ ] **ODD-3 — Wire the ingestion worker safely**
  - Compose and register `ReceiptProcessingDispatcher` and `ReceiptMediaIngestionWorker`.
  - Prove enabled/disabled startup behavior, singleton ownership, wake-up and polling behavior, lease fences, graceful drain, and shutdown ordering.
  - Preserve existing notification lifecycle behavior and avoid expanding LLM, sender, or notification authority.

- [ ] **ODD-4 — Finish media routing integration**
  - Propagate normalized caption data into receipt handling where required.
  - Complete active/terminal guidance and receipt-flow behavior.
  - Preserve operations, pending-human, and text-routing precedence.
  - Add focused customer-visible behavior and duplicate-event tests.

- [ ] **ODD-5 — Reconcile capability access production status**
  - Treat GET/HEAD controller wiring as present rather than repeating the stale “not production-wired” narrative.
  - Verify module-level authentication, range handling, safe headers, disabled behavior, rotation/restart behavior, and indistinguishable failures through integrated evidence.
  - Do not broaden capability scope or expose private storage directly.

- [ ] **ODD-6 — Build integrated fault-path E2E evidence**
  - Migrate the useful intent of historical WU16 into ODD-owned tests.
  - Exercise fake Meta, object storage, backend, and sender boundaries plus Testcontainers PostgreSQL where applicable.
  - Cover retries, crashes, duplicate delivery, ambiguous attachment outcomes, lease loss, shutdown, and recovery without live external services.

- [ ] **ODD-7 — Complete traceability and final validation**
  - Migrate the useful intent of historical WU17 into an ODD-owned requirement-to-assertion ledger.
  - Reconcile the historical 24 requirements and 87 scenarios against current implementation and tests rather than copying old completion claims.
  - Record final functional, static, integration, privacy, and operational evidence with honest skipped/unavailable results.

- [ ] **ODD-8 — Complete owner-gated rollout work**
  - Provision required credentials, private storage, retention/lifecycle controls, and deployment configuration through separately authorized operational work.
  - Run staging drills for download, storage, attachment, notification, metrics, key rotation, restart, disable, and ambiguous-outcome recovery.
  - Escalate unresolved backend-contract risks to the backend owner before production enablement.
  - Keep rollout dependencies distinct from implementation completion.

## Acceptance criteria

The feature is complete only when:

1. ODD-1 through ODD-7 have verified implementation evidence and no unresolved blocking findings.
2. The ingestion worker is safely composed and restart-safe without violating the STORED hold.
3. Receipt admission, storage, attachment, notification, access, and failure recovery have integrated evidence.
4. Requirement-to-assertion traceability reflects current code and tests rather than stale OpenSpec checkbox state.
5. Owner-gated rollout dependencies are either completed with evidence or explicitly recorded as external blockers.
6. No SDD lifecycle is required for execution, verification, delivery, or closure.

## Conversion verification

For this conversion-only change:

- Re-read this file and the supersession banner in `openspec/changes/receipt-media-ingestion/tasks.md`.
- Confirm every inherited ODD tracker and the OpenSpec reference directory are linked.
- Confirm no source, spec, proposal, design, progress, or review-ledger content changed.
- Inspect the documentation-only diff and whitespace.
- Do not run tests, builds, installs, services, or review lifecycle operations.

## Progress and next step

ODD-0 is complete. The local document and Engram recovery copy were written and read back; the OpenSpec ledger received only its supersession banner; `git diff --check` passed; and no source, spec, proposal, design, progress, or review-ledger content changed. No tests, builds, installs, services, review lifecycle, commit, or push ran.

ODD-1 read-only causality mapping is complete. It found that receipt reservation and generic webhook deduplication currently commit in separate transactions; the controller already waits for the complete dispatcher before HTTP `200`; PostgreSQL receipt uniqueness prevents duplicate rows; and committed `RESERVED` rows can stall because the ingestion worker is not composed. No product decision is required. The technical direction is to define “early `200`” as after durable atomic admission but before worker-side external processing.

The first recommended implementation slice is ODD-1A, estimated at 300–380 authored lines across exactly:

- `src/receipt-media/domain/receipt-media-store.port.ts`
- `src/receipt-media/application/receipt-ingress.service.ts`
- `src/receipt-media/infrastructure/postgres-receipt-media.store.ts`
- `src/receipt-media/application/receipt-ingress.service.spec.ts`
- `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`

ODD-1A implementation and verification are complete on five changed source/spec paths: 202 additions and 34 deletions. Writer evidence passed 17/17 unit, 376/376 PostgreSQL, 393/393 combined, scoped ESLint, Prettier, diff check, and non-emitting TypeScript. Required independent verification repeated all seven checks and returned PASS. The parent spot check repeated the focused ingress suite at 17/17 and confirmed clean scoped whitespace.

The store itself intentionally does not classify a marker-only row: direct `admit()` can create a receipt when a durable marker exists without a receipt. Current runtime remains safe because the dispatcher checks durable deduplication before ingress. This is a recorded non-blocking ODD-1A evidence limit and a required ODD-1B adoption case, not a production-readiness claim.

No worker composition, wake-up, outbox intent, caption parsing, lifecycle transition, migration, external call, or STORED claim change occurred. The maintainer authorized the seven-path local work-unit commit `520651f` (`feat(receipt-media): make admission atomic`), which contains 363 insertions and 34 deletions and leaves local `main` 105 commits ahead of the local `origin/main` tracking ref. No push occurred.

Native review START for the explicit prior-boundary range failed closed before lineage creation with `candidate-target-projection-drift`; no native mutation or review authority was created. Native ASSESS was also unavailable/unassessable and prescribed the high-risk fallback: writer self-verification plus an independent verifier. Both passed, and the parent spot check passed. ODD-1A is therefore accepted under the documented unavailable-review fallback.

ODD-1B implementation and verification are complete across exactly `src/whatsapp/application/webhook-dispatcher.service.ts`, its spec, and `src/whatsapp/presentation/webhook.controller.spec.ts`: 75 additions and 40 deletions. Writer evidence passed 55/55 dispatcher, 9/9 controller, 81/81 combined, scoped ESLint, Prettier, diff check, and non-emitting TypeScript. Independent verification initially required one test-only correction because four guidance cases asserted only that `markSeen()` was called; the parent strengthened them to `toHaveBeenCalledTimes(1)` and repeated 55/55 plus static checks. Independent reverification repeated all seven checks and returned PASS.

The dispatcher now omits the separate marker write only for `reserved`, `webhook-replayed`, `provider-media-reused`, and `webhook-media-conflict`; it retains exactly one best-effort marker write after successful guidance for `disabled`, `unsupported-media`, `no-placed-sale`, and `sender-active`. The top-level duplicate pre-check protects marker-only replay. Controller evidence composes with ODD-1A rather than using a real persistent dispatcher graph; full signed-HTTP persistence remains deferred to ODD-1C.

The maintainer authorized local work-unit commit `212d49a` (`feat(whatsapp): adopt atomic receipt markers`), 84 insertions and 43 deletions across the three candidate files plus this tracker; local `main` is 106 commits ahead and no push occurred. Native START again failed before lineage creation with `candidate-target-projection-drift`; no mutation or review authority was created. ASSESS prescribed the unavailable-review fallback, already satisfied by writer verification, independent verification/reverification, and parent spot checks. ODD-1B is accepted. ODD-1C needs a bounded read-only remap because its original store-only evidence is now covered by ODD-1A while the remaining gap is integrated signed-HTTP persistence evidence.

ODD-1C integrated cross-boundary evidence is complete and tests-only. The single added path is `src/whatsapp/presentation/webhook-receipt-admission.integration.spec.ts`, 394 authored lines; no production source changed. It composes the real `SignatureGuard`, `WebhookController`, `WebhookDispatcherService`, `ReceiptIngressService`, `PostgresReceiptMediaStore`, and `PostgresWebhookDedupStore` over one Testcontainers PostgreSQL 16 instance with the production migrations applied by `pnpm migrate`. Only the agent runner, sender, amount router, conversation store, human handoff, and recent-outbound echo window are stubs. The suite is gated by `RUN_DOCKER_TESTS=1` like the other Docker suites and truncates `receipt_media_cancellation_commands`, `receipt_media_outbox`, `receipt_media`, and `processed_webhook_messages` between tests.

Observed evidence: a correctly signed receipt-image POST holds its HTTP response while PostgreSQL already shows exactly one committed `receipt_media` row (`status = RESERVED`, `lease_owner IS NULL`) and one `processed_webhook_messages` row, then settles `200 {received:true}` after release; two concurrent signed deliveries of one message both settle `200 {received:true}` and converge on exactly one receipt and one marker with no sender call; a test-only DDL trigger that rejects the marker insert inside the atomic transaction yields `500` with zero receipt and zero marker rows and, once the trigger is dropped, the same signed body admits normally at 1/1; and a signed replay after closing the Nest app and rebuilding a fresh dispatcher, ingress store adapter, and dedup adapter over the same pool returns `200 {received:true}` with counts still 1/1 and no conversation lookup, sender, amount-router, agent, or handoff call.

Verification commands and results: `RUN_DOCKER_TESTS=1 pnpm exec jest --runInBand src/whatsapp/presentation/webhook-receipt-admission.integration.spec.ts` → 1 suite, 4/4 passed; the combined `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` plus the new file → 2 suites, 380/380 passed; scoped `pnpm exec eslint src/whatsapp/presentation/webhook-receipt-admission.integration.spec.ts` → exit 0; `pnpm exec prettier --check` on the new file → clean; `git diff --check` → exit 0 (it does not cover the untracked new file, which the Prettier check does cover); `pnpm exec tsc --noEmit -p tsconfig.spec.json` → exit 2 with 95 errors, all in spec files that are byte-identical to `HEAD` and none referencing the new spec, and an isolated strict `tsc` check of the new file alone → exit 0.

Independent verification repeated the functional and static evidence and initially required one test-only cleanup correction: a held HTTP request could remain blocked if an intermediate assertion failed. The parent attached an immediate rejection observer, raced admission against early HTTP settlement, and guaranteed release plus observation in `finally`. Parent rechecks passed 4/4 plus scoped ESLint, Prettier, diff check, and isolated strict TypeScript; independent reverification repeated those five checks and returned PASS.

Recorded limits: the pre-response proof point wraps the real store in a transparent instrumentation seam that only observes the post-COMMIT resolution, so it does not prove durability from an unmediated `admit()` call; the forced-failure case injects a test-only DDL trigger rather than a natural database fault; and the suite composes no ingestion worker, so the STORED hold, claims, leases, and outbox intents remain deliberately unexercised. No production source, migration, existing spec, OpenSpec artifact, worker composition, or external call occurred.

The maintainer authorized local work-unit commit `f1ea7d1` (`test(whatsapp): prove durable receipt admission`), 409 insertions and 3 deletions across the new integration spec plus this tracker; local `main` is 107 commits ahead and no push occurred. Native START again failed before lineage creation with `candidate-target-projection-drift`; no mutation or review authority was created. ASSESS prescribed the unavailable-review fallback, already satisfied by writer verification, independent verification/reverification, and parent spot checks. ODD-1C and parent ODD-1 are accepted.

ODD-2 read-only lifecycle mapping is complete. Current accepted-media amount transitions already commit their conversation pointer and deterministic intent atomically, but the generic `ReceiptOutboxService` has no concrete `commitTransitionWithIntent` adapter and is intentionally not wired. Three material gaps remain: (1) an `ATTACHING` row reclaimed after request-start evidence returns `crashed-before-post`, performs no second POST, but remains `ATTACHING` and is reclaimed forever instead of fixing forward to `ATTACH_OUTCOME_UNKNOWN`; (2) ATTACHED, definite-failure, and unknown-outcome terminal commits persist state without their required deterministic outbox intents; and (3) permanent/exhausted Meta or storage failures and transient retry timing are returned only as in-memory processor outcomes, so attempt-3 rows become unclaimable in nonterminal `RESERVED`/`DOWNLOADED` states, continue blocking the sender, and create no unavailable-later intent. Cleanup-pending evidence is also not consumed by the processor.

No product decision is required: the preserved design already specifies maximum three attempts, durable retry scheduling, terminal pre-acceptance failure stages, no blind attachment retry, fixed notification templates, and accepted-media retention. ODD-2 is split into bounded technical slices: ODD-2A fixes crashed/request-ambiguous ATTACHING rows forward through an atomic unknown-outcome-plus-`RECEIPT_ATTACH_UNKNOWN` intent; ODD-2B adds atomic success and definite-failure intents; ODD-2C adds durable Meta retry/finalization; ODD-2D adds durable storage retry/finalization and technical cleanup evidence; ODD-2E adds cross-outcome PostgreSQL recovery/replay evidence. ODD-3 keeps production worker composition and wake-up deferred; ODD-4 keeps caption routing deferred.

The recommended first implementation slice is ODD-2A, estimated at 300–390 authored lines across exactly `src/receipt-media/domain/receipt-media-store.port.ts`, `src/receipt-media/application/receipt-attachment.service.ts`, `src/receipt-media/infrastructure/postgres-receipt-media.store.ts`, and their two existing specs. Acceptance requires zero second POST after `crashed-before-post`, durable fix-forward to `ATTACH_OUTCOME_UNKNOWN`, one row-owned deterministic `RECEIPT_ATTACH_UNKNOWN` intent in the same PostgreSQL transaction, exact replay (including recoverable legacy missing-intent evidence), fenced rivals, forced rollback of both state and intent, and preserved abort/timeout behavior. No module wiring, worker activation, STORED claim, migration, backend change, or external call belongs in ODD-2A.

ODD-2A is implemented and locally verified; ODD-2B/2C/2D/2E and later slices remain deferred. The change touched exactly the five authorized source/spec paths plus this tracker; no other repository path changed. `ReceiptAttachmentService.attach` now fixes a reclaimed `crashed-before-post` request-start outcome forward with zero backend POSTs through one `commitAttachUnknownOutcome` call that uses the durable returned attempt identity and successor version with the single safe `TRANSPORT_FAILURE` channel, resolving to the existing `outcome-unknown` report (or `terminal-fenced` when that fix-forward fences). `PostgresReceiptMediaStore.commitAttachUnknownOutcome` atomically persists the terminal `ATTACH_OUTCOME_UNKNOWN` transition together with exactly one row-derived deterministic `RECEIPT_ATTACH_UNKNOWN` intent in one transaction: dedupe key `receipt-attach-unknown:<receiptId>:<successorVersion>:<storedWebhookMessageId>`, `receipt_media_id`/`source_webhook_message_id`/`recipient_id` derived from the locked row, empty bounded args, and no caller-supplied recipient, webhook id, template, object key, URL, capability, or free text. The outcome type now carries the persisted intent for `unknown`/`replayed`; `fenced` stays intent-free and `AttachReport` does not expose it. Exact replay proves the terminal evidence and the exact persisted intent; an otherwise exact legacy terminal successor missing only that intent is repaired under the same exact command/live-lease replay fence, while a mismatched/foreign intent or rival terminal evidence fences without replacement and rolls back any terminal write.

Observed evidence: RED before production edits — `receipt-attachment.service.spec.ts` 2 failed / 18 passed (both `crashed-before-post` cases returned `{kind:'skipped',reason:'crashed-before-post'}`); `postgres-receipt-media.store.spec.ts -t WU11A3B` 4 failed / 14 passed (missing intent on `unknown`, undefined intent on replay, zero outbox rows on concurrent duplicates, and no insert attempt so no rollback). GREEN after the minimum production change — unit 20/20; `-t WU11A3B` 18/18; full store 379/379; attachment+store combined 399/399; dispatcher+worker+module regression 76/76. Triangulation covers exact replay intent validation, legacy missing-intent repair, foreign-intent fence, rival terminal-evidence fence, dead-lease no-repair, concurrent duplicate convergence to one state and one intent, altered-rival fence, forced outbox-insert rollback of both terminal state and intent (test-only BEFORE-INSERT trigger), and fresh-transition foreign-intent-conflict rollback. Static checks: scoped ESLint exit 0; scoped Prettier clean; `git diff --check` exit 0; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc --noEmit -p tsconfig.spec.json` exit 2 with 95 pre-existing errors in unrelated spec files and zero in the two changed specs.

Recorded limits: no migration, module wiring, worker composition, STORED claim, ODD-2B success/definite intent, or external call occurred. Pi-lens flagged five SQL-interpolation advisory sites in the Postgres spec (test-only trigger/table DDL with test-controlled constant names); all five are byte-identical to `HEAD` and outside the ODD-2A diff, so no unrelated churn was applied, and the only added template interpolation is a dedupe-key JavaScript string bound as a query parameter rather than SQL text. Authored change exceeds the 300–390-line planning heuristic because the parent-mandated triangulation list requires the added assertions; no assertion was deleted to reach the target.

ODD-2A correction after independent verification (NEEDS_CORRECTION). The verifier found two real defects in `commitAttachUnknownOutcome`: the legacy replay/repair path read the terminal receipt through the transaction-stable `ATTACH_SUCCESS_LOOK_SQL` `now()` predicate with an unlocked SELECT, so a lease that expired or was released while the transaction waited on a concurrent writer could still authorize a repair; and the existing-intent validation selected the deterministic outbox row without `FOR UPDATE`, so a concurrent post-validation alteration could be accepted. The correction adds an unknown-replay-specific locked read `ATTACH_UNKNOWN_REPLAY_LOOK_SQL` (`SELECT ... WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > clock_timestamp() FOR UPDATE`) used only by the unknown replay path, and locks the deterministic outbox row with `FOR UPDATE` during existing-intent validation; the legacy repair insert therefore occurs only after the locked live-lease proof and cannot race a concurrent writer. The fresh-transition transaction (`ATTACH_UNKNOWN_OUTCOME_SQL`) and every prior behavior are unchanged. Only `postgres-receipt-media.store.ts` and its spec changed in this correction; the port, the attachment service, and its spec were untouched.

Correction evidence: RED before the fix — `postgres-receipt-media.store.spec.ts -t "lock wait outlives the lease|existing-intent validation against a concurrent foreign"` 2 failed / 3 passed: the legacy missing-intent repair resolved `{kind:'replayed',...}` (and inserted an intent) after the lock wait outlived the lease, and the existing-intent validation did not serialize (`settled` was `true` while a concurrent locker held the outbox row). GREEN after the fix — the two focused tests pass (5 passed / 0 failed on that filter); `-t WU11A3B` 20/20; full store 381/381; attachment+store combined 401/401; dispatcher+worker+module regression 76/76. Static: scoped ESLint exit 0; scoped Prettier clean for the five TS candidates; `git diff --check` exit 0; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc --noEmit -p tsconfig.spec.json` exit 2 with 95 pre-existing errors in unrelated spec files and zero in the two changed specs. Tracker Prettier is a pre-existing baseline: `prettier --check` fails on `HEAD`'s tracker piped through stdin as well as on the worktree file, so the historical tracker was not reformatted and no unrelated documentation churn was introduced.

Independent reverification returned PASS after repeating the correction race filter (2/2), WU11A3B (20/20), combined attachment/store (401/401), dispatcher/worker/module regressions (76/76), ESLint, TypeScript-file Prettier, diff check, and build TypeScript. It independently confirmed the tracker formatting failure is byte-identical to the `HEAD` baseline and that the six-path candidate introduces no new formatting delta. The parent spot check repeated attachment unit 20/20, the two correction races 2/2, scoped ESLint, build TypeScript, and diff check successfully. Native ASSESS remained unavailable (`native-assess-unavailable`) and prescribed the high-risk fallback already satisfied by writer self-verification plus the independent verifier. ODD-2A is verified; the maintainer authorized the bounded local commit `feat(receipt-media): recover unknown attachment outcomes`. No push is authorized.

ODD-2B1 is implemented and locally verified under strict TDD; ODD-2B2, ODD-2C, ODD-2D, ODD-2E, ODD-3, and later slices remain deferred. The change touched exactly the five authorized paths (the port, `postgres-receipt-media.store.ts`, both of their specs, and this tracker); no other repository path changed. `commitAttachSuccess` now transitions the exact fenced ATTACHING request to ATTACHED and owns exactly one row-derived deterministic `RECEIPT_ATTACHED_PENDING` intent in the same PostgreSQL transaction: dedupe key `receipt-attached-pending:<receiptId>:<successorVersion>:<storedWebhookMessageId>`, `receipt_media_id`/`receipt_state_version`/`source_webhook_message_id`/`recipient_id` derived from the locked row, and `template_args` exactly `{ backendStatus: 'PENDING' }`; the caller supplies only existing success command evidence (`attachAttemptId`, `backendReceiptId`, and the lease/version fences) and never recipient, template, source, URL, object, capability, or free text. Non-fenced `committed`/`replayed` outcomes carry the persisted intent; `fenced` stays intent-free and `AttachReport` does not expose it. Exact replay validates every deterministic intent field; an otherwise exact legacy ATTACHED successor missing only that intent is repaired under the exact original command, owner, and a live lease proven with `clock_timestamp()` plus `FOR UPDATE`; a lease expiring or released while waiting fences without insertion. A mismatched/foreign existing intent or rival terminal evidence fences without replacement, and existing-intent validation locks its outbox row with `FOR UPDATE`. The fresh success transition now fences under `clock_timestamp()` so a lock wait that outlives the lease rolls back both state and intent. ODD-2A unknown semantics, definite-failure behavior, the STORED hold, the no-POST-retry rule, and all worker/wiring/migration behavior are preserved byte-for-behavior.

Observed evidence: RED before production edits — `postgres-receipt-media.store.spec.ts -t "ODD-2B1"` 8 failed / 1 passed (missing intent on fresh commit, undefined intent on replay, no legacy repair, mismatched-intent acceptance, lock-wait freshness, existing-intent serialization, concurrent-intent convergence, and no outbox insert so no rollback; the malformed-input fence case already passed). GREEN after the minimum production change — `-t "ODD-2B1"` 9/9; attachment service unit 20/20; full Postgres store 390/390; attachment+store combined 410/410; dispatcher+worker+module regression 76/76. Triangulation covers fresh intent shape, exact replay intent validation, legacy missing-intent repair, dead/expired/released lease and both legacy-repair and fresh-transition lock-wait expiry, foreign/rival intent, existing-intent serialization, concurrent duplicates/rivals, forced outbox-insert rollback of both terminal state and intent (test-only BEFORE-INSERT trigger), fresh-transition foreign same-key conflict rollback preserving the foreign row, and malformed inputs/fences with no mutation and no intent. Static: scoped ESLint exit 0 for the four candidate TS paths; scoped `prettier --check` clean; `git diff --check` exit 0; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc --noEmit -p tsconfig.spec.json` exit 2 with the same 95 pre-existing errors as the recorded baseline and zero in the changed files.

Recorded limits and attribution: the four-file source/spec diff is 602 insertions and 30 deletions across exactly the four TS paths (the tracker is documentation-only), and the final tracked diff is exactly five paths. Pi-lens again reported five SQL-interpolation advisory sites in the store spec (current lines ~1999/2002/2013/2014/2781); `git blame` attributes them to HEAD commits `41731fa1` (2026-09-12) and `d86b8f32` (2026-09-11), the regions are byte-identical to `HEAD`, and the only spec diff hunk is a pure insertion beginning at line 4677, so those pre-existing test-only DDL interpolations are outside this diff and were not altered. No new SQL-text interpolation was introduced: the added trigger/function DDL uses static template literals and every new outbox read/write binds values as query parameters. Active pi-lens LSP diagnostics could not be invoked as a standalone CLI in this environment (the `pi-lens` bin fails with a missing `@earendil-wilms/pi-tui` peer and `pi-lens-analyze` returns no output), so the inline pi-lens edit-time diagnostics plus scoped ESLint, Prettier, and both TypeScript projects served as the scoped diagnostics. No migration, module wiring, worker composition, STORED claim, ODD-2B2 definite-failure intent, or external call occurred. No commit, push, PR, merge, deploy, or provisioning is performed by this task.

Parent review corrected two comment typos and hardened all three new held-lock tests with immediate rejection observers that are awaited in `finally` after releasing the lock, preventing assertion failures from leaving a rejected or blocked promise behind. The focused ODD-2B1 suite remained 9/9 and scoped ESLint, Prettier, build TypeScript, and diff check remained clean. Independent verification then returned PASS after repeating attachment unit 20/20, ODD-2B1 9/9, full store 390/390, combined attachment/store 410/410, dispatcher/worker/module 76/76, all scoped static checks, and exact candidate attribution of the unchanged 95-error spec-TypeScript baseline. It found no write-skew, lock-order, replay, rollback, or cleanup defect. Native ASSESS remained unavailable (`native-assess-unavailable`) and prescribed the high-risk fallback already satisfied by writer verification plus the independent verifier. The final tracked diff is 621 additions and 31 deletions across exactly the five authorized paths (the two post-verification additions are this assessment/status note). The maintainer authorized the bounded local commit `feat(receipt-media): persist attachment success intent`; no push is authorized.

ODD-2B2 is implemented and locally verified under strict TDD; ODD-2C, ODD-2D, ODD-2E, ODD-3, and later slices remain deferred. The change touched exactly the five authorized paths (the port, `postgres-receipt-media.store.ts`, both of their specs, and this tracker); no other repository path changed. `commitAttachDefiniteFailure` now transitions the exact fenced ATTACHING request to `FAILED/ATTACH_DEFINITE` and owns exactly one row-derived deterministic `RECEIPT_ATTACH_DEFINITE_FAILURE` intent in the same PostgreSQL transaction: dedupe key `receipt-attach-definite-failure:<receiptId>:<successorVersion>:<storedWebhookMessageId>`, `receipt_media_id`/`receipt_state_version`/`source_webhook_message_id`/`recipient_id` derived from the locked row, and `template_args` exactly `{}`; the caller supplies only existing failure command evidence (`attachAttemptId`, allowlisted `httpStatus`, and the lease/version fences) and never recipient, template, source, URL, object, capability, or free text. Non-fenced `failed`/`replayed` outcomes carry the persisted intent; `fenced` stays intent-free and `AttachReport` does not expose it. Exact replay validates every deterministic intent field; an otherwise exact legacy `FAILED/ATTACH_DEFINITE` successor missing only that intent is repaired under the exact original command, owner, and a live lease proven with `clock_timestamp()` plus `FOR UPDATE`; a lease expiring or released while waiting fences without insertion. A mismatched/foreign existing intent or rival terminal evidence fences without replacement, and existing-intent validation locks its outbox row with `FOR UPDATE`. The fresh failure transition now fences with `clock_timestamp()` so a row-lock wait that outlives the lease rolls back both state and intent. ODD-2A unknown semantics, ODD-2B1 success semantics, the STORED hold, the no-POST-retry rule, and all worker/wiring/migration behavior are preserved byte-for-behavior.

Observed evidence: RED before production edits — `postgres-receipt-media.store.spec.ts -t "ODD-2B2"` 11 failed / 1 passed (missing intent on fresh commit, undefined intent on replay, missing legacy repair, every mismatched-intent field accepted, both lock-wait fencings committed, existing-intent serialization not held, zero intents on concurrent duplicates, no outbox insert so no rollback, and the fresh foreign same-key conflict not rolled back; the dead/released/expired-lease fence case already passed). GREEN after the minimum production change — `-t "ODD-2B2"` 12/12; attachment service unit 20/20; full Postgres store 402/402; attachment+store combined 422/422; dispatcher+worker+module regression 76/76. Triangulation covers fresh intent shape, caller-supplied routing values ignored, the same identity and empty args for every allowlisted status, exact replay intent validation, legacy missing-intent repair, every mismatched intent field, rival terminal evidence, dead/released/expired lease, both legacy-repair and fresh-transition lock-wait expiry, existing-intent serialization, duplicate/rival concurrency, forced outbox-insert rollback of both terminal state and intent (test-only BEFORE-INSERT trigger), fresh-transition foreign same-key conflict rollback preserving the foreign row, and malformed inputs/fences with no mutation and no intent. Static: scoped ESLint exit 0 with `--max-warnings=0` for the four candidate TS paths; scoped `prettier --check` clean; `git diff --check` exit 0; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc --noEmit -p tsconfig.spec.json` exit 2 with the same 95 pre-existing errors as the recorded baseline and zero in the changed files.

Recorded limits and attribution: the four-file source/spec diff is 727 insertions and 29 deletions across exactly the four TS paths (the tracker is documentation-only), and the final tracked diff is exactly five paths. Pi-lens again reported five SQL-interpolation advisory sites in the store spec (test-only trigger/table DDL with test-controlled constant names); the regions are byte-identical to `HEAD` and outside this diff, so no unrelated churn was applied. No new SQL-text interpolation was introduced: the added trigger/function DDL uses static template literals and every new outbox read/write binds values as query parameters. Two transient pre-existing suite flakes were observed on first heavy-Docker runs (one canonical-version insert case and the WU11A3B `serializes duplicate unknown commits` concurrency case) and both suites passed cleanly on rerun (full store 402/402, combined 422/422); the ODD-2B2 block itself passed 12/12 in every run. No migration, module wiring, worker composition, STORED claim, or external call occurred. No commit, push, PR, merge, deploy, or provisioning is performed by this task.

Independent verification returned PASS with zero candidate findings after repeating attachment unit 20/20, ODD-2B2 12/12, full store 402/402, combined attachment/store 422/422, dispatcher/worker/module 76/76, scoped ESLint with zero warnings, TypeScript-file Prettier, diff check, build TypeScript, and exact attribution of the unchanged 95-error spec-TypeScript baseline. It independently confirmed exact intent identity/routing, seven-status coverage, receipt→outbox lock order, post-conflict validation, live-lease repair fences, rollback, cleanup safety, exact five-path scope, and unchanged hashes for all unrelated untracked artifacts; neither transient noncandidate Docker flake recurred. The parent spot check repeated ODD-2B2 12/12 plus scoped ESLint, Prettier, build TypeScript, and diff check successfully. Native ASSESS remained unavailable (`native-assess-unavailable`) and prescribed the high-risk fallback already satisfied by writer verification plus the independent verifier. The maintainer authorized the bounded local commit `feat(receipt-media): persist attachment failure intent`; no push is authorized.
