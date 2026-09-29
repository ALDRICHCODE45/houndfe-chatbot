# RESTOCK — expired-reservation recovery (expiry-only)

## Scope

- Local/offline only. `HEAD fc7f9ed`; production, backend repo, DB, Docker, env,
  secrets and provider state are untouched. No push/deploy/commit here.
- A new customer RESTOCK consent can be blocked by `existing_restock` when
  the same sender still holds an **expired** recorded request. Production
  inspection proved an active resolved request, not its expiry or watch loss.
  This slice adds an **on-demand, expired-only** reconciliation that
  records the old outcome (STALE), ACKs the backend and closes the old
  reservation, then lets the existing coordinator POST the **current new**
  request.
- Existing offline ports/mocks only. No new dependencies.

## What changed

- **Unit A — claim classification order** (`postgres-restock-application-claim.store.ts`):
  classify the decision BEFORE the 24h send-eligibility check. `READY` still
  requires the original provider window `< 24h`; `STALE` (past `applyBefore`)
  may record `expire_unsent` with no open window. Future provider/observation
  evidence and finite-clock checks still HOLD.
- **Unit B — coordinator** (`restock-application-coordinator.ts`):
  `reconcileExpiredOnce` reuses the existing prepare/claim/outcome/ACK/close
  primitives and the shared `finish` tail. It is **expiry-only**: it never
  sends Meta, requires a `stale` candidate, and resumes an already-persisted
  `STALE` row only when it exactly matches the derived snapshot (normalize +
  deep-equal). `SEND_STARTED` / `PROVIDER_ACCEPTED*` and claim races HOLD.
  An optional `readByDecision` port enables the resume path; without it expiry
  fails closed for an already-advanced row.
- **Runtime + wiring** (`restock-application.runtime.ts`,
  `human-decisions.module.ts`, `llm-agent.module.ts`,
  `sale-flow/application/tool-deps.ts`,
  `sale-flow/application/tools/request-human-assistance.tool.ts`):
  bounded `reconcileExpired(senderId)` reads ONLY that sender's trusted recorded
  context and forwards the recorded `requestKey`; shutdown drains in-flight
  recovery before pool close. `runRestockRoute` may invoke the optional callback
  at most once, only after the `existing_restock` preflight block, then reruns a
  fresh FULL preflight with the CURRENT digest/inbound event before the existing
  coordinator CAS. Default-off stays inert with no legacy-registry change.

## Evidence (focused, offline)

- Unit A RED: `postgres-restock-application-claim.store.spec.ts` 2 failed
  (24h-boundary + 48h STALE) → GREEN after reorder: 42/42.
- Coordinator RED: `restock-application-coordinator.spec.ts` 9 failed on
  missing `reconcileExpiredOnce` → initial GREEN: 73/73 (existing 64 unchanged).
  Three further RED regressions for pre-ACK identity binding → final 76/76.
- Route RED: `request-human-assistance.tool.spec.ts` 2 failed → initial 86/86;
  a throwing-getter containment regression failed before correction → final 87/87.
- Runtime: `restock-application.runtime.spec.ts` 16/16.
- Modules: `human-decisions.module.spec.ts` + `human-decisions.module.lifecycle.spec.ts`
  12/12; `llm-agent.module.spec.ts` 7/7.
- Independent final `env -i PATH="$PATH" HOME="$HOME" CI=1 pnpm exec jest --runInBand`:
  185 suites / 5,729 tests passed; 30 suites / 755 tests skipped.
- No real PostgreSQL/provider run (mocks only). NO actual DB or Meta proof.

## Non-goals / boundaries

- Not general recovery: no scans, no cron, no multi-active schema, no change to
  the original 24h send authority (a real SEND still needs an open window).
- No blind `CLOSED` status write; closure requires the matching durable ACK.
- The old receipt is never reported as a new success; the new POST uses only the
  current customer/product/source identity from a fresh preflight.

## Source bug vs production cause

- Source: the poller watches only fresh receipt hints and loses watches on
  restart; `claimPending` required the original 24h window even for a stale
  no-send expiry, so an expired old request could never be reconciled. That is
  the code defect fixed here.
- Production observation (parent, read-only): one old ACTIVE/RECEIPT_RECORDED
  Ibuprofeno request with a backend GET 200 RESOLVED and an empty application
  ledger; the new Paracetamol consent blocked `existing_restock`. Actual
  `resolvedAt`/`applyBefore` are unknown, so this slice does NOT claim the live
  request was already expired; it makes the expired-only path available and
  holds safely otherwise.

## Rollback

- Revert this cohesive unit: the seven source files listed under What changed,
  their accompanying specs, and this note. It restores the prior claim-window,
  coordinator, runtime and routing behavior without removing the existing intake.
  Default-off behavior remains inert.
