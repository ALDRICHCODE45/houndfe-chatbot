# Verification Report

**Change**: `durable-conversation-store`
**Version**: 1 delta spec (conversation-store) — 8 requirements / 13 scenarios
**Mode**: Strict TDD (test runner `pnpm test`)
**Branch**: `feat/durable-conversation-store`
**Date**: 2026-07-05

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 24 (across 7 phases) |
| Tasks complete | 24 / 24 |
| Tasks incomplete / deferred | 0 |

All 24 tasks were verified as actually implemented (not merely checked off) by
reading each produced production file and cross-checking it against the design
File Changes table:

- Phase 1 (infra): `pg` + devDeps in `package.json`, `migrate`/`migrate:down` scripts, `docker-compose.yml` (postgres:16-alpine), `migrations/1700000000000_create-conversation-state.js`.
- Phase 2 (env/config): `DATABASE_URL` (uri, required) + `DB_POOL_MAX` (int, default 5) in `env.validation.ts`; typed `database` block in `configuration.ts`.
- Phase 3 (contract): `conversation-store.contract.ts` factory with 8 shared scenarios; in-memory spec invokes it.
- Phase 4 (pool): `PG_POOL` factory provider + `PostgresPoolLifecycle.onModuleDestroy → pool.end()` + `DatabaseModule`.
- Phase 5 (adapter): `PostgresConversationStore` + Testcontainers spec + separate restart-survival describe.
- Phase 6 (wiring): binding swap to `PostgresConversationStore`; `enableShutdownHooks()` in `main.ts`; AgentRunner non-edit.
- Phase 7 (verification): the four verification commands (see below).

---

## Build & Tests Execution

| Command | Result | Suites | Tests |
|---------|--------|--------|-------|
| `pnpm test` (gate OFF) | PASS | 21 passed + **1 SKIPPED** = 22 | 126 passed + **10 SKIPPED** = 136 |
| `RUN_DOCKER_TESTS=1 pnpm test` | PASS | **22 passed**, 0 skipped | **136 passed**, 0 skipped |
| `pnpm build` (`nest build` / tsc) | PASS (exit 0) | — | — |

- The `RUN_DOCKER_TESTS=1` gate genuinely toggles the Postgres suite: 10 tests /
  1 suite are skipped when off and run against a real `postgres:16-alpine`
  container (Testcontainers) when on. Migration applied via
  `execSync('pnpm migrate')` — same migration the production binary runs (no
  hand-rolled DDL, zero schema drift).
- No `.only` / `fit` / `fdescribe` / `describe.only` leftovers found.

---

## Spec-Scenario Coverage: 13 / 13

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

All 13 delta scenarios are covered by a test that passed at runtime. The
Postgres-backed scenarios (R2, R4, R5, and full R1/R3 parity) were proven
against a real container, not just static inspection.

---

## Correctness & Contract Fidelity

| Check | Verdict | Evidence |
|-------|---------|----------|
| Merge parity (in-memory vs Postgres byte-identical) | PASS | Both use `existing ? {...existing, ...patch} : {senderId, ...patch}`, same `typeof lastMessageAt !== 'string'` guard, same `data ?? {}`. Contract factory runs identical scenarios against both. |
| timestamptz ↔ ISO ms fidelity | PASS | WRITE `$n::timestamptz` cast; READ `row.last_message_at.toISOString()`. s6 proves `2026-06-30T15:24:13.456Z` round-trips exact on real container. |
| Port UNCHANGED | PASS | `git diff main...HEAD -- src/conversation/domain/conversation-store.ts` = empty. |
| AgentRunner UNCHANGED | PASS | Only `src/llm-agent/llm-agent.module.spec.ts` touched (+1 line test fixture); 0 production lines in `src/llm-agent/`. |
| SQL parameterized | PASS | All queries `$1 / $2::timestamptz / $3::jsonb`; `JSON.stringify` for jsonb bind. No injection surface. |
| OWN Postgres only (no backend DB) | PASS | Only `DATABASE_URL` consumed; `CHATBOT_API_BASE_URL` is HTTP-only. Architectural separation preserved. |

---

## Gate-Review Warnings Honored

| # | Warning | Status | Evidence |
|---|---------|--------|----------|
| W1 | Restart-survival must be Postgres-only | HONORED | Separate `describe('restart survival (Postgres-only, R2)')` OUTSIDE the shared factory in `postgres-conversation.store.spec.ts`. |
| W2 | Lost-update window documented | HONORED | JSDoc block in `postgres-conversation.store.ts` (lines 35–39): "knowingly-accepted lost-update window … acceptable for v1 single-bot-per-sender". |
| W3 | Deep-equal, not reference identity | HONORED | Contract factory asserts via `toEqual`; JSDoc notes JSONB round-trip drops key order. |

---

## Production LoC vs 400 Ceiling

| Scope | LoC |
|-------|-----|
| Runtime production (excludes test-only contract factory) | ~207 gross / ~201 net |
| Test-only `conversation-store.contract.ts` factory | 216 (reported separately) |
| Ceiling | 400 |

Under ceiling. Note: a naive `git diff --stat` over `src/**/*.ts` (excluding
`*.spec.ts`) reports 423 lines because the test-only contract factory carries no
`.spec.ts` suffix; the true runtime production delta is ~207.

---

## Findings

- **CRITICAL**: none.
- **WARNING**: none blocking.
- **SUGGESTION** — `docker-compose.yml` (line 10): host port mapping is
  `5432:5432`. Apply-progress note (#2600) recorded a transient `5432→5433`
  remap when the host port was taken. This is a dev-only convenience file
  (non-spec, non-production, not touched by any test — Testcontainers assigns
  its own ephemeral port). Developers on a machine with 5432 already in use will
  need to override the mapping. Action: optionally document this or make the host
  port env-driven. Non-blocking.

---

## Verdict

**PASS**

**Ready to archive: YES**
