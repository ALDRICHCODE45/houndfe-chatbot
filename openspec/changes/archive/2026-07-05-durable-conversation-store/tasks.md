# Tasks: Durable Conversation Store (Postgres)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Production LoC (est.) | ~147 |
| Tests / migration / docker / lockfile (est.) | ~210 |
| Total changed lines (incl. tests + lockfile) | ~360 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single feature-branch work-unit slice |
| Delivery strategy | ask-on-risk |
| Chain strategy | single-pr |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: single-pr
400-line budget risk: Low

## Phase 1: Infrastructure (no behaviour change)

- [x] 1.1 Add to `package.json`: runtime `pg`; devDeps `@types/pg`, `node-pg-migrate`, `@testcontainers/postgresql`. Run `pnpm install`.
- [x] 1.2 Add `pnpm migrate` / `pnpm migrate:down` scripts invoking `node-pg-migrate up/down`.
- [x] 1.3 Create `docker-compose.yml` with `postgres:16-alpine` (port 5432, default creds).
- [x] 1.4 Create `migrations/<ts>_create-conversation-state.js` (up/down) for `conversation_state(sender_id text PK, last_message_at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb)`.

## Phase 2: Env Validation + Typed Config (strict TDD)

- [x] 2.1 RED: in `src/config/env.validation.spec.ts` add 3 cases — `DATABASE_URL` missing → Joi error; `DATABASE_URL` malformed → Joi error; `DB_POOL_MAX` absent defaults to 5. Update `validEnv` fixture. Verify RED.
- [x] 2.2 GREEN: in `src/config/env.validation.ts` add `DATABASE_URL: Joi.string().uri().required()` and `DB_POOL_MAX: Joi.number().integer().min(1).default(5)`. Verify cases pass.
- [x] 2.3 RED: create `src/config/configuration.spec.ts` asserting `configuration()` exposes `database.url` (== env) and `database.poolMax === 5` when unset.
- [x] 2.4 GREEN: in `src/config/configuration.ts` add `database: { url: process.env.DATABASE_URL as string, poolMax: parseInt(process.env.DB_POOL_MAX ?? '5', 10) }`.

## Phase 3: Contract Suite Factory (in-memory stays green)

- [x] 3.1 Create `src/conversation/infrastructure/conversation-store.contract.ts` exporting `runConversationStoreContract(makeStore)` with 8 shared scenarios (create+get; update patch data-preserved; update data REPLACE; UPSERT on missing; messages+extras round-trip; ms-precision ISO round-trip; get→null for missing; subsequent get reflects patch). Assertions use `toEqual` per W3. Restart-survival EXCLUDED (Postgres-only per W1).
- [x] 3.2 Modify `src/conversation/infrastructure/in-memory-conversation.store.spec.ts` to invoke the factory with `new InMemoryConversationStore()`; keep bespoke cases. Verify `pnpm test` green.

## Phase 4: Pool Provider + DatabaseModule (strict TDD)

- [x] 4.1 RED: create `src/database/postgres-pool.provider.spec.ts` asserting factory injects `ConfigService` and returns `Pool` with `connectionString === config.database.url` and `max === config.database.poolMax` (factory spy).
- [x] 4.2 GREEN: create `src/database/postgres-pool.provider.ts` exporting `PG_POOL` Symbol and `postgresPoolFactory(config)` returning `new Pool({ connectionString, max })`.
- [x] 4.3 RED: extend spec asserting `PostgresPoolLifecycle.onModuleDestroy()` calls `pool.end()` (spy on injected pool).
- [x] 4.4 GREEN: add `PostgresPoolLifecycle` implementing `OnModuleDestroy { constructor(@Inject(PG_POOL) pool); onModuleDestroy() { await this.pool.end() } }`.
- [x] 4.5 Create `src/database/database.module.ts` providing + exporting `PG_POOL` factory and `PostgresPoolLifecycle`; import `ConfigModule`.

## Phase 5: PostgresConversationStore + Postgres Spec (strict TDD, Testcontainers)

- [x] 5.1 RED: create `src/conversation/infrastructure/postgres-conversation.store.spec.ts` gated by `process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip`; `beforeAll` boots Testcontainers `postgres:16-alpine`, runs `node-pg-migrate up` against container URL, builds a `Pool`, jest timeout 60s. Invoke contract factory against `new PostgresConversationStore(pool)`. Verify RED.
- [x] 5.2 GREEN: create `src/conversation/infrastructure/postgres-conversation.store.ts` implementing `ConversationStore` — `get` SELECT by PK; `create` INSERT; `update` read-modify-write mirroring in-memory + `INSERT … ON CONFLICT (sender_id) DO UPDATE SET last_message_at = EXCLUDED.last_message_at, data = EXCLUDED.data RETURNING *`. Map row→state via `last_message_at.toISOString()` and `$n::timestamptz` write cast. Add W2 JSDoc: "Knowingly-accepted lost-update window acceptable for single-bot-per-sender v1." Verify contract scenarios green.
- [x] 5.3 RED: same spec file, add SEPARATE `describe('restart survival')` OUTSIDE factory (per W1) using two `PostgresConversationStore` instances against same pool.
- [x] 5.4 GREEN: same impl already supports it. Verify restart scenario passes.

## Phase 6: Wiring + Shutdown Hook (strict TDD)

- [x] 6.1 RED: create `src/conversation/conversation.module.spec.ts` building Test `TestingModule` with `DatabaseModule` + mocked `PG_POOL`; assert `moduleRef.get(CONVERSATION_STORE)` is `PostgresConversationStore` (not `InMemoryConversationStore`).
- [x] 6.2 GREEN: in `src/conversation/conversation.module.ts`, import `DatabaseModule`; swap `useClass: InMemoryConversationStore` → `useClass: PostgresConversationStore`.
- [x] 6.3 RED: extend `database.module.spec.ts` asserting shutdown triggers `pool.end()` (spy on pool, `app.close()`, assert spy called).
- [x] 6.4 GREEN: in `src/main.ts`, add `app.enableShutdownHooks()` before `app.listen(...)`.
- [x] 6.5 Verification (no test): `AgentRunner` source untouched — `git diff --stat src/llm-agent/` returns zero lines changed (R6 satisfied by non-edit).

## Phase 7: Verification

- [x] 7.1 `pnpm test` (no Docker) — all in-memory + non-DB specs green.
- [x] 7.2 `pnpm build` — clean tsc compile.
- [x] 7.3 `RUN_DOCKER_TESTS=1 pnpm test` — Postgres contract + restart-survival specs green.
- [x] 7.4 `docker compose up -d postgres` + `pnpm migrate` — `conversation_state` table exists with expected schema.

---

## Archive-Time Reconciliation Note

> The persisted `tasks.md` above was updated at archive time from `- [ ]` to `- [x]` for all 24 tasks. This reconciliation was authorized by the orchestrator and is backed by:
> - `verify-report.md` (24/24 complete, 13/13 spec scenarios PASS, Ready to archive: YES)
> - 7 work-unit commits present on `feat/durable-conversation-store` (`ff9ef70` → `cf12a1f`), each implementing a phase from the table above
> - Repo state: `pnpm test` 136/136 (gated docker suite included), `pnpm build` clean
>
> This is the documented exceptional repair path from `sdd-archive`: "archive may only perform exceptional mechanical reconciliation with proof from apply-progress and verify-report." No production code was touched by this edit.

## Spec Scenario → Test Task Mapping

| Spec | Test task |
|---|---|
| R1: create+get round-trip | 3.1 (s1) |
| R1: update patch preserves data | 3.1 (s2) |
| R1: get→null for missing | 3.1 (s7) |
| R1: UPSERT on missing | 3.1 (s4) |
| R2: State survives adapter restart | 5.3+5.4 (Postgres-only, W1) |
| R3: update() no prior creates | 3.1 (s4) |
| R3: update() shallow-merges preserves senderId | 3.1 (s2+s3) |
| R3: get() missing returns null | 3.1 (s7) |
| R4: mixed-variant messages + extras round-trip | 3.1 (s5) |
| R5: ms-precision ISO round-trip | 3.1 (s6) |
| R6: Boot resolves durable adapter | 6.1+6.2 |
| R6: AgentRunner consumes bound adapter | 6.5 (non-edit) |
| R7: Boot fails DATABASE_URL missing | 2.1+2.2 |
| R7: Boot fails DATABASE_URL malformed | 2.1+2.2 |
| R8: Pool closes on SIGTERM | 6.3+6.4 |
| R8: OnModuleDestroy ends pool before exit | 4.3+4.4 |