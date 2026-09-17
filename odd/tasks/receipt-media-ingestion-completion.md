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

- [ ] **ODD-1 — Reconcile receipt admission causality**
  - [x] **ODD-1A — Atomic receipt-admission persistence:** verified atomic receipt-plus-marker commit, rollback, concurrent convergence, legacy replay, provider reuse, conflict, active-sender behavior, and unrelated-error propagation.
  - [x] **ODD-1B — Dispatcher adoption and acknowledgement proof:** verified conditional marker ownership, marker-only replay short-circuiting, all eight admission outcomes, and receipt-media HTTP settlement/failure behavior.
  - [ ] **ODD-1C — Cross-boundary resilience evidence:** prove concurrent same-message admission, rollback of both durable artifacts, and replay after adapter recreation with PostgreSQL-backed tests.
  - Preserve raw Meta signature verification, existing message precedence, the STORED hold, and the current caption boundary.

- [ ] **ODD-2 — Complete durable lifecycle recovery and intents**
  - Define terminal and retry recovery for every processor/attachment outcome.
  - Commit all required deterministic outbox intents transactionally with state changes.
  - Preserve lease/version fencing and safe unknown-outcome handling.
  - Keep STORED rows held from automatic claims until an explicitly authorized reconciliation design replaces that hold.

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

The dispatcher now omits the separate marker write only for `reserved`, `webhook-replayed`, `provider-media-reused`, and `webhook-media-conflict`; it retains exactly one best-effort marker write after successful guidance for `disabled`, `unsupported-media`, `no-placed-sale`, and `sender-active`. The top-level duplicate pre-check protects marker-only replay. Controller evidence composes with ODD-1A rather than using a real persistent dispatcher graph; full signed-HTTP persistence remains deferred to ODD-1C. No worker, outbox, migration, commit, or push occurred. ODD-1B awaits explicit authorization for its local work-unit commit.
