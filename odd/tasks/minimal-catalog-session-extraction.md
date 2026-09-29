# Minimal catalog session store extraction (bounded local refactor)

**Authorization.** Owner-approved LOCAL behavior-preserving refactor of the
experimental read-only catalog route. SINGLE WRITER. No commits/push/deploy;
no backend repo, DB, Docker, `.env`, secrets, or dependency changes. HEAD stays
`47a0cf339aca6bfd55533b06954cd8013622902a`. No workflow engine, persistence,
or unrelated abstraction. Pre-existing untracked `.codegraph/` untouched.

## Baseline

`MinimalCatalogAgentService` held per-sender history in a private
`Map<string, HistoryTurn[]>` plus a `Set` for its busy span. Each turn stored
`{ messages: ModelMessage[], verifiedProductIds: string[] }` together. Reads
applied `turns.slice(-historyTurns)` (and `[]` when `historyTurns <= 0`);
writes stored `[...prior, current]` where `prior` was the same capped slice.
State was in-memory only (restart loss). Focused characterization suite was
GREEN before the refactor (see commands).

## Scope

Extract ONLY the history `Map` behavior into an injected
`MinimalCatalogSessionStore` contract plus an in-memory adapter:

- `src/llm-agent/domain/minimal-catalog-session.store.ts` — token
  `MINIMAL_CATALOG_SESSION_STORE`, `MinimalCatalogTurn` (keeps
  `ModelMessage[]` + `verifiedProductIds` together), and the `read`/`write`
  port.
- `src/llm-agent/infrastructure/in-memory-minimal-catalog-session.store.ts` —
  `@Injectable` Map-backed adapter (restart loss).
- `MinimalCatalogAgentService` now requires the store via Nest token injection
  (no hidden fallback constructing its own store) and keeps the exact
  `slice(-historyTurns)` / `prior + current` retention at its call sites.

Test helpers updated mechanically to pass an `InMemoryMinimalCatalogSessionStore`.
The Nest module binds the token with `useClass` to the in-memory adapter.

## Non-goals

- No change to prompts, tools, tool schemas, stock projection, model outputs,
  dispatcher routing, `onSent`, or write authority.
- Busy stays service-owned; RESTOCK pending/consent/classifier behavior
  unchanged.
- No cloning/freezing, no async, no persistence, no process-lifetime sharing
  beyond what an injected same store would give in tests.

## Evidence

- Focused baseline GREEN before edits: 97/97 (catalog + restock).
- Store contract RED (genuine missing implementation): jest failed with
  `Cannot find module './in-memory-minimal-catalog-session.store'`.
- Store contract GREEN: 5/5 after adding domain + adapter.
- Focused GREEN after refactor: 110/110 across catalog, store, restock, module.
- Full local suite: 186 suites passed, 30 skipped (Testcontainers/Docker-gated
  Postgres integration suites), 5765 tests passed, 755 skipped.
- Injected ownership pinned by one compact service test (turns land in the
  injected store) and by the module-spec binding assertion. Existing cross-turn
  identity / expiry / restart-loss / sender-isolation / busy regressions reused
  unchanged.

## Commands

```bash
./node_modules/.bin/jest src/llm-agent/application/minimal-catalog-agent.service.spec.ts \
  src/llm-agent/application/minimal-restock-request.service.spec.ts          # baseline 97
./node_modules/.bin/jest src/llm-agent/infrastructure/in-memory-minimal-catalog-session.store.spec.ts
./node_modules/.bin/jest src/llm-agent/application/minimal-catalog-agent.service.spec.ts \
  src/llm-agent/infrastructure/in-memory-minimal-catalog-session.store.spec.ts \
  src/llm-agent/application/minimal-restock-request.service.spec.ts \
  src/llm-agent/llm-agent.module.spec.ts                                      # 110
./node_modules/.bin/jest --silent                                            # full local
./node_modules/.bin/tsc --noEmit -p tsconfig.build.json                       # clean
./node_modules/.bin/eslint <changed files>                                    # clean
./node_modules/.bin/prettier --check <changed files>                          # clean
```

## Limitations

- DB-backed `.db.spec.ts` / `.integration.spec.ts` suites are skipped without
  Docker/Postgres; no network/provider/DB validation was performed or required.
- Tests use scripted SDK mocks: they pin wiring and gates, not real-model
  obedience.
- Store returns stored references (no clone), matching the prior private Map;
  callers only slice/replace and never mutate in place.

## Rollback

Revert the four tracked edits and delete the three new `minimal-catalog-session*`
source/spec files. The service then recreates the private `Map`, and the
behavior is byte-identical to the pre-refactor baseline.
