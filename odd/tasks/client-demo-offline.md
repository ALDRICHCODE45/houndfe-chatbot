# Offline client demo — HoundFe human decisions

## Outcome and constraints

Deliver a guided, reproducible offline presentation for a client meeting in ~29 hours. Show actual engineering evidence for RESTOCK and the separate shipping workstream without claiming a joined runtime. Clearly label simulations, fake backends, test-only PostgreSQL, and unimplemented steps. No Meta, production services, broad branch merges, live activation, or writes outside this bot worktree. Keep each work unit at or below 390 complete changed lines and make local conventional commits after checks.

## Provenance and presentation boundaries

- Bot human-decisions worktree `feat/human-decisions-restock`: RESTOCK coordinator/reservation/ledger are inert at runtime; Testcontainers exercises the durable path with a fake backend. `HUMAN_DECISIONS_RESTOCK_ENABLED` defaults false.
- Backend peer `1188206`: HD-06 source bytes frozen for **offline handoff only**; 20 DB-free suites/1206, 10 dedicated localhost test-DB suites/198, build clean. This is separate backend evidence, not a completed bot GET/ACK or live flow. The existing DB is not disposable; do not run it from this worktree.
- FE peer `88d0c81`: 11 component/transport/access suites (219 tests); production route is a shell, not a navigable list/detail/resolve demo.
- Shipping branch `feat/shipping-quotes-skydropx` (`116ce03`) separately implements offline quotes, server-owned SHIPPING_APPROVAL approve/reject/expired and customer consent; its inbound consent router is not dispatcher-wired. Shipping/receipt collision detection is pure, but `CANCEL_SHIPPING`/`CANCEL_RECEIPT` human resolution is not implemented. Runtime remains default-off and unintegrated with RESTOCK.

## Tasks

- [x] **D1 — Map only reproducible evidence.** Route: delegated read-only scout; evidence: bot four-command Testcontainers/unit recommendation, backend/FE peer state; shipping provenance must remain labeled. No implementation commit (investigation only).
- [x] **D2 — Write a concise offline runbook and meeting script.** Route: bounded delegated writer; 300-second script, three bot-only commands, precise fake/DB labels and fallback. Scoped Prettier and source/path readback passed. Commit `fb12d04` (134 added lines).
- [x] **D3 — Provide a standalone, client-readable visual walkthrough.** Route: bounded delegated writer; HTML and local Firefox screenshot with explicit simulation/other-branch/planned labels. Scoped Prettier, staged whitespace check and 1440×1600 visual readback passed; no external assets or product UI claims. Commit `9ff5eb7` (304 authored HTML lines; PNG binary).
- [x] **D4 — Rehearse and collect exact evidence.** Route: independent `gentle-ai-verify`, bot worktree only. Unit coordinator 2 suites/12 tests; pure ledger/reservation/preflight 5 suites/64; disposable Testcontainers PostgreSQL 2 suites/12: **9 suites/88 tests PASS**, three commands exited 0 (Jest 0.499s/0.682s/5.713s). `dist` and two existing buildinfo size/mtime unchanged pre/post. Backend/FE/shipping were not run here, and no integrated runtime, provider, Meta or device delivery was proven. Evidence-update commit `8e84482`.

## Checks and delivery

- Bot unit commands: select RESTOCK coordinator, reservation, ledger, preflight specs with `--runInBand --no-cache --runTestsByPath`.
- Disposable bot DB: select `restock-intake.service.db.spec.ts` and `postgres-restock-post-ledger.store.transitions.db.spec.ts` only with `RUN_DOCKER_TESTS=1`; no other DB target.
- Both non-emitting typechecks if code changes; docs/HTML require link/command/path checks, local browser validation if available, `git diff --check` and scoped provenance readback.
- No SDD phase/reset. No claim of native-review approval when unavailable. Last hours reserved for rehearsal and a backup recording, not new business features.

## Status

D1–D4 verified offline; commits recorded above. No live or joined-runtime claim. W2 marker CAS was explicitly authorized but is paused for the demo. Backend HD-06 offline source bytes are frozen, but RESTOCK tool runtime, bot GET/ACK, customer delivery, FE route wiring, and cross-branch SHIPPING_APPROVAL integration remain incomplete.
