# Archive Report: durable-conversation-store

**Change**: `durable-conversation-store`
**Branch**: `feat/durable-conversation-store`
**Mode**: Strict TDD, OpenSpec
**Verdict**: PASS
**Archived**: 2026-07-05 → `openspec/changes/archive/2026-07-05-durable-conversation-store/`
**Engram topic key**: `sdd/durable-conversation-store/archive-report`

---

## Summary

Swapped the in-memory `ConversationStore` for a Postgres adapter behind the unchanged
`CONVERSATION_STORE` port. Per-WhatsApp-sender state (message history + session metadata)
now survives process restarts on the chatbot's own Postgres; `AgentRunner` — the only
consumer — required zero production-code changes. The slice ships a single MODIFIED delta
on the `conversation-store` capability that relaxes the in-memory-only restriction and
asserts the durable-binding invariants. 8 requirements / 13 distinct behavioral scenarios
COMPLIANT, 136 / 136 tests green (Testcontainers suite included), `pnpm build` clean.
Production LoC ~207 (well under the 400 budget); the shared contract suite (216 lines)
is reported separately because it carries no `.spec.ts` suffix.

## What Was Delivered (7 work-unit commits on `feat/durable-conversation-store`)

| Commit | WU | Deliverable |
|--------|----|-------------|
| `ff9ef70` | — | `chore(deps)`: `pg` + `@types/pg`, `node-pg-migrate`, `@testcontainers/postgresql` |
| `8a50c88` | Phase 1 + Phase 7.4 stepping stone | `feat(db)`: one migration for `conversation_state(sender_id text PK, last_message_at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb)`; `docker-compose.yml` (`postgres:16-alpine`); `pnpm migrate` / `pnpm migrate:down` scripts |
| `5578f6e` | Phase 2 (4 RED+GREEN tasks) | `feat(config)`: `DATABASE_URL` (uri, required) + `DB_POOL_MAX` (int, default 5) Joi validation; typed `database` block in `configuration.ts`; corresponding `configuration.spec.ts` + `env.validation.spec.ts` cases (missing/malformed/default) |
| `38231ea` | Phase 3 (Tasks 3.1 + 3.2) | `test(conversation)`: extracted `runConversationStoreContract(makeStore)` factory with 8 shared scenarios; in-memory spec invokes it; bespoke cases preserved |
| `5205752` | Phase 4 (5 RED+GREEN tasks) | `feat(db)`: `PG_POOL` factory + `PostgresPoolLifecycle.onModuleDestroy → pool.end()` + `DatabaseModule` (provides + exports `PG_POOL`, imports `ConfigModule`) |
| `ae63650` | Phase 5 (4 RED+GREEN tasks, Testcontainers) | `feat(conversation)`: `PostgresConversationStore implements ConversationStore` — `get` SELECT by PK, `create` INSERT, `update` read-modify-write mirroring in-memory + `INSERT … ON CONFLICT (sender_id) DO UPDATE … RETURNING *`; row→state via `last_message_at.toISOString()` and `$n::timestamptz` write cast. JSDoc documents the knowingly-accepted single-process lost-update window (acceptable for v1 single-bot-per-sender). Gated Testcontainers spec + separate `restart survival` describe (W1) |
| `cf12a1f` | Phase 6 (5 RED+GREEN tasks) | `feat(conversation)`: one-line `useClass` swap to `PostgresConversationStore`; `DatabaseModule` imported by `ConversationModule`; `app.enableShutdownHooks()` in `main.ts`. `AgentRunner` source UNCHANGED (verified `git diff --stat src/llm-agent/`) |

## Test & Build Results

```
$ pnpm build                                            → nest build / tsc → exit 0  (clean, no TS errors)
$ pnpm test             (gate OFF)                     → 21 passed + 1 SKIPPED = 22 suites; 126 + 10 skipped = 136 tests
$ RUN_DOCKER_TESTS=1 pnpm test  (gate ON, full parity) → 22 passed;    136 / 136 tests GREEN
```

The `RUN_DOCKER_TESTS=1` gate genuinely toggles the Postgres suite: 10 tests / 1 suite
are skipped when the flag is unset and run against a real `postgres:16-alpine` Testcontainers
container when on. The Testcontainers harness reuses `pnpm migrate` (no hand-rolled DDL →
schema drift is impossible). No `.only` / `fit` / `fdescribe` / `describe.only` leftovers.

**Spec compliance**: 13 / 13 distinct scenarios COMPLIANT (every requirement has a
behavior-asserting, passing test; Postgres-backed assertions proven on a real container,
not just static inspection).
**Design conformance**: 7 / 7 architecture decisions honored (raw `pg`, app-side shallow
merge, `timestamptz` + ISO, PK-only indexing, manual `pnpm migrate`, single contract
factory, gated Testcontainers + lifecycle pool close).
**Scope adherence**: NO backend DB access, NO in-memory data migration, port UNCHANGED,
`AgentRunner` production code UNCHANGED (verified via `git diff`).

## Production LoC vs 400 Ceiling

| Scope | LoC |
|-------|-----|
| Runtime production (excludes test-only contract factory) | ~207 gross / ~201 net |
| Test-only `conversation-store.contract.ts` factory (reported separately; carries no `.spec.ts` suffix) | 216 |
| Ceiling | 400 |

Under ceiling. A naive `git diff --stat` over `src/**/*.ts` (excluding `*.spec.ts`)
reports 423 lines because the test-only contract factory carries no `.spec.ts` suffix;
the true runtime production delta is ~207.

## Specs Synced → `openspec/specs/`

| Domain | Action | Details |
|--------|--------|---------|
| `conversation-store` | **Modified** | R1 `Manage conversation state by sender id` body relaxed (in-memory-only → MAY be in-memory OR durable Postgres is runtime default); UPSERT semantics preserved; 4 scenarios preserved. Existing `Persist typed agent message history` (from prior slice) preserved unchanged. **7 ADDED requirements** (`Conversation state survives process restart`, `Adapter honors UPSERT semantics on update`, `data payload round-trips unchanged through the durable adapter`, `lastMessageAt round-trips at millisecond precision`, `CONVERSATION_STORE token resolves to the durable adapter at runtime`, `Service refuses to start without a valid DATABASE_URL`, `Database pool closes on shutdown`) merged in with their scenarios. Final canonical: 9 requirements / 18 textual scenarios (13 distinct behavioral assertions). |

The archived delta under `openspec/changes/archive/2026-07-05-durable-conversation-store/specs/conversation-store/`
is preserved as the AUDIT TRAIL for what changed in this slice.

## Archive Contents

- `proposal.md` ✅
- `exploration.md` ✅
- `design.md` ✅
- `specs/conversation-store/spec.md` ✅ (delta preserved)
- `tasks.md` ✅ (24/24 tasks complete; WU-level work units split into 7 commits and merged atomically per the apply log)
- `verify-report.md` ✅ (PASS, 13/13 scenarios, Ready to archive: YES)

## Spec → Test Trace (verify-report table, reproduced for archival)

| # | Requirement / Scenario | Proving test | Result |
|---|------------------------|--------------|--------|
| 1 | R1 create+get round-trip | contract s1 (both adapters) | PASS |
| 2 | R1 update patch preserves data | contract s2 | PASS |
| 3 | R1 get→null for missing | contract s7 | PASS |
| 4 | R1 UPSERT on missing | contract s4 | PASS |
| 5 | R2 state survives adapter restart | postgres spec `restart survival (Postgres-only, R2)` | PASS (Docker) |
| 6 | R3 update() no prior creates | contract s4 | PASS |
| 7 | R3 shallow-merge preserves senderId | contract s2 + s3 | PASS |
| 8 | R3 get() missing returns null | contract s7 | PASS |
| 9 | R4 mixed-variant messages + extras round-trip | contract s5 | PASS (Docker) |
| 10 | R5 ms-precision ISO round-trip | contract s6 | PASS (Docker) |
| 11 | R6 boot resolves durable adapter | `conversation.module.spec.ts` | PASS |
| 12 | R6 AgentRunner consumes bound adapter (no code change) | non-edit (git diff) | PASS |
| 13 | R7 boot fails DATABASE_URL missing + malformed | `env.validation.spec.ts` | PASS |
| 13b | R8 pool closes on SIGTERM + OnModuleDestroy | `database.module.spec.ts` + `postgres-pool.provider.spec.ts` | PASS |

## Source-of-Truth Updated

- `openspec/specs/conversation-store/spec.md` reflects the durable-binding reality end-to-end.

## Archive-Time Reconciliation (`tasks.md` → all `[x]`)

The persisted `tasks.md` was updated at archive time from `- [ ]` to `- [x]` for all 24
tasks. This reconciliation was explicitly authorized by the orchestrator and backed by:

- `verify-report.md` reporting 24/24 complete, 13/13 spec scenarios PASS, Ready to archive: YES
- 7 work-unit commits present on `feat/durable-conversation-store` (`ff9ef70` → `cf12a1f`), each implementing a phase from the table above
- Repo state at archive: `pnpm test` 136/136 (Testcontainers suite included), `pnpm build` clean

This is the documented exceptional-repair path from `sdd-archive`: archive may only
perform mechanical reconciliation of stale checkboxes with proof from `apply-progress`
and `verify-report`. No production code was changed by this edit; a Reconciliation Note
appended to `tasks.md` records the source of authority.

## Risks

| Risk | Status |
|------|--------|
| Lost-update window in concurrent updates | Accepted for v1 (single-bot-per-sender); documented in `postgres-conversation.store.ts` JSDoc (W2 honored). Re-evaluate when multi-bot-per-branch arrives. |
| `pnpm migrate` skipped on deploy | Mitigated: runbook step; boot logs DB host/db; idempotent migration. |
| Testcontainers Docker availability | Mitigated: `RUN_DOCKER_TESTS=1` gate keeps `pnpm test` green without Docker; future CI runner must be Docker-enabled. |
| Graceful shutdown leak | Mitigated: `enableShutdownHooks()` + `PostgresPoolLifecycle.onModuleDestroy → pool.end()` (R8 asserted). |
| Host port collision on dev machines | SUGGESTION only — `docker-compose.yml` line 10 hard-codes `5432:5432`. Optional: make the host port env-driven. Non-blocking, non-spec. |

## Carried-Forward Follow-Ups (for the next session / slice)

### 1. Deferred from the PRIOR slice (`llm-agent-conversation-persistence`, still open)
- `.github/workflows/ci.yml` (`pnpm install` → `pnpm test --ci` → `pnpm lint`)
- `eslint-plugin-jest` `no-focused-tests` wired into `eslint.config.mjs` for `*.spec.ts`
- These two halves are **coupled per design** (`forbidOnly` decision) — ship together
- PII redaction in chatbot-api client logging
- Distinct 4xx-other error class (400/409/422 currently collapse into `UpstreamError`)
- `multer` transitive advisory bump

### 2. From THIS slice's `verify-report.md` (non-blocking SUGGESTION)
- `docker-compose.yml` line 10 — host port mapping `5432:5432` may collide on dev machines
  with port 5432 in use (apply-progress #2600 recorded a one-time `5432→5433` remap).
  Optional: env-driven override. Non-blocking, dev-only file (Testcontainers assigns its
  own ephemeral port, so no test depends on this).

### 3. Pre-Go-Live Prerequisites (program-level, do NOT block this slice)
- Seed a dedicated bot cashier `User` record (FK target of `Sale.userId`).
- Provision `ServiceCredential` with scopes (`catalog:read`, `pricing:evaluate`,
  `customers:read`, `customers:write`, `sales:create`, `sales:write`).
- README update for new env vars: `DATABASE_URL`, `DB_POOL_MAX` + deploy runbook
  step (`pnpm migrate` before `pnpm start`).
- Program-level prerequisites from the seed: Meta WhatsApp test-number registration,
  VPS 2 provisioning, LLM provider selection within $200/mo cap.

### 4. Ops Note (intentional behavior change)

With the durable store wired, the chatbot now **FAILS FAST** if Postgres / `DATABASE_URL`
is unavailable — there is no silent in-memory fallback. This is per spec R7 and is the
correct, intended behavior; Ops must provision a managed Postgres before going live.

### 5. Optional hardening (next-chance-cleanup)
- The shared contract factory (`conversation-store.contract.ts`, 216 lines) carries no
  `.spec.ts` suffix; a future test-lint tightening could rename it to `*.contract.ts` and
  exclude it from the production LoC budget gate explicitly. NOT a defect today — the
  verify report already excludes it and reports `~207` true production LoC.

## SDD Cycle Complete

The change has been fully **planned (proposal + design + exploration)**, **implemented
(7 work-unit commits on `feat/durable-conversation-store`, ~207 production LoC)**,
**verified (136/136 green, build clean, PASS)**, and **archived (canonical spec synced,
change folder moved, report persisted)**. Ready for the orchestrator to fast-forward
merge `feat/durable-conversation-store` into `main` and start the next change.
