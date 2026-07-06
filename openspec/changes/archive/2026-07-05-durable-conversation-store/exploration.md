# Exploration: durable-conversation-store

Replace the in-memory `ConversationStore` with a durable PostgreSQL adapter so
per-sender conversation state (message history + session metadata) survives
process restarts on the chatbot's OWN VPS/Postgres. Not a RAG/vector problem —
simple keyed transactional state (`sender_id → JSONB`) in one table.

## Current State

The `ConversationStore` PORT is already defined, stable, and covered by tests.
The durable adapter must implement it EXACTLY — no contract changes.

- **Port**: `src/conversation/domain/conversation-store.ts`
  - `CONVERSATION_STORE` Symbol token.
  - `AgentMessage` union (canonical declaration lives here; llm-agent re-exports it).
  - `ConversationStateData { messages?: AgentMessage[]; [k: string]: unknown }`.
  - `ConversationState { senderId: string; lastMessageAt: string /* ISO 8601 */; data: ConversationStateData }`.
  - Methods: `get(senderId): Promise<ConversationState | null>`,
    `create(senderId, Omit<ConversationState,'senderId'>): Promise<ConversationState>`,
    `update(senderId, Partial<Omit<ConversationState,'senderId'>>): Promise<ConversationState>`
    with **UPSERT** semantics (shallow-merge patch over existing; create if missing).
- **In-memory adapter**: `src/conversation/infrastructure/in-memory-conversation.store.ts`
  - Plain `Map<string, ConversationState>`; `update` shallow-merges and re-asserts
    `lastMessageAt` is a string (throws if the caller omitted it on a fresh record).
  - `data` defaults to `{}` after merge.
- **Module wiring**: `src/conversation/conversation.module.ts`
  ```ts
  providers: [{ provide: CONVERSATION_STORE, useClass: InMemoryConversationStore }],
  exports: [CONVERSATION_STORE],
  ```
  **This is the exact one-line swap point.** The durable adapter binds to the same
  token; every consumer (AgentRunner via `CONVERSATION_STORE`) is untouched.
- **Consumers**: only `AgentRunner` (`src/llm-agent/application/agent-runner.service.ts`)
  uses the store, via the token. It does `get` → idle-check → truncate → `update`
  (UPSERT of user+assistant turns + `lastMessageAt=now`). No other coupling.
- **Config pattern**: `src/config/env.validation.ts` (Joi, `abortEarly:false`,
  `allowUnknown:true`, fail-fast at boot) + `src/config/configuration.ts` (typed
  factory) + `src/config/config.module.ts` (`AppConfigModule.forRoot()` DynamicModule).
  DB env vars MUST follow this SAME pattern.

### Dependency audit (package.json — verified, not assumed)

- **NO Postgres/ORM dependency exists.** No `pg`, no Prisma, no TypeORM, no Kysely,
  no Drizzle, no `node-pg-migrate`. This is a greenfield persistence choice.
- Present and relevant: `@nestjs/*` 11, `@nestjs/config` 4, `joi` 18, `zod` 4,
  `ai` 7 (LLM slice). Test stack: `jest` 30 + `ts-jest` 29, `testRegex: .*\.spec\.ts$`,
  `rootDir: src`. Package manager: **pnpm**.
- No `docker-compose*.yml` and no `.github/workflows/` exist yet (the LLM slice's
  `ci.yml` was pre-approved but deferred). Any CI/DB-in-CI wiring is greenfield here.

### Contract nuances the adapter MUST honor (from the existing spec + tests)

- `openspec/specs/conversation-store/spec.md` currently says "in-memory implementation
  ONLY". This slice MUST ship a **MODIFIED** delta that relaxes that clause to allow a
  durable adapter behind the same port (the port itself is unchanged).
- `update` is UPSERT and MUST NOT throw `NotFoundException` on a missing sender.
- Missing `data.messages` MUST round-trip as `[]` (via `readMessages`). JSONB must
  preserve the `AgentMessage` union incl. the `tool` variant with arbitrary `content`.
- `create` inserts a fresh record keyed by `senderId`.

## Affected Areas

- `src/conversation/infrastructure/postgres-conversation.store.ts` — NEW durable adapter (impl of the port).
- `src/conversation/conversation.module.ts` — swap `useClass` binding to the Postgres adapter; provide/close the pool.
- `src/conversation/infrastructure/*` — pool provider + (option-dependent) migration runner / SQL.
- `src/config/env.validation.ts` + `configuration.ts` — add DB connection env vars (Joi fail-fast, new `db` block).
- `package.json` — add the chosen driver (+ migration tool + test-DB tooling as dev deps).
- `openspec/specs/conversation-store/spec.md` — MODIFIED delta (allow durable adapter).
- `src/main.ts` / lifecycle — enable graceful shutdown hooks so the pool closes cleanly.
- Possibly NEW: `docker-compose.yml` (local dev Postgres) and a migrations directory.

## Approaches (Postgres access for a standalone NestJS 11 service — NOT the backend)

### 1. Raw `pg` (node-postgres) + hand-written SQL + `node-pg-migrate` — RECOMMENDED
- **Description**: Inject a `pg.Pool` as a Nest provider. The adapter runs three
  parameterized statements: `SELECT ... WHERE sender_id=$1`, `INSERT ...`, and
  `INSERT ... ON CONFLICT (sender_id) DO UPDATE`. Migrations via `node-pg-migrate` CLI.
- **Pros**: Zero abstraction over one table — the SQL *is* the contract. Native, direct
  JSONB (`data jsonb`, driver serializes JS objects automatically). Smallest footprint /
  fastest cold start on a small VPS (one thin dependency, no schema engine, no client
  generation step). UPSERT maps 1:1 to `INSERT ... ON CONFLICT`. Trivial to mock the
  `Pool` in unit tests. Fully consistent with THIS repo's "thin port + adapter" style
  (mirrors how `ai`/axios are confined to infra). No codegen coupling to the build.
- **Cons**: Hand-written SQL and manual row↔`ConversationState` mapping (small: 3 fields).
  Migration runner is a separate concern to wire. No compile-time SQL type-checking.
- **Effort**: Low.

### 2. Prisma 6 (same as backend)
- **Description**: `schema.prisma` with one `ConversationState` model + JSON field;
  `prisma migrate`; `PrismaService` provider.
- **Pros**: Team familiarity (backend uses Prisma 6). Typed client, built-in migrations,
  clean `upsert()` API. Good JSON support.
- **Cons**: Heavyweight for ONE table — pulls the Prisma engine + client generation
  (`prisma generate`) into build/CI, larger install and cold-start footprint on a small
  VPS. The `data` JSON column is typed as `Prisma.JsonValue` — the `AgentMessage` union
  must still be asserted/validated at the boundary (Prisma won't enforce our union), so
  the "typed" win is thin here. Adds a build step and a binary that must match the VPS
  platform. Risks cargo-culting the backend's stack into a service that deliberately
  stays lean. **NOTE**: backend familiarity is about the *other* repo — the standard for
  THIS repo is thin ports, not Prisma.
- **Effort**: Medium.

### 3. TypeORM / Kysely / Drizzle
- **TypeORM**: entity+decorator+DataSource ceremony, migration system; heaviest, most
  magic, worst fit for one JSONB table. Reject.
- **Kysely**: excellent typed query builder, light. Real option, but adds a query-builder
  dependency + a separate migration story for value that raw SQL already covers at this
  size. It shines with many tables/joins — we have one table, point lookups only.
- **Drizzle**: light, typed, good DX. Same reasoning as Kysely — the typing benefit is
  marginal for a single-table point-lookup adapter and adds schema-in-TS + migration tooling.
- **Effort**: Medium (Kysely/Drizzle), High (TypeORM).

## Schema Sketch

Single table, one migration:

```sql
CREATE TABLE conversation_state (
  sender_id       text        PRIMARY KEY,
  last_message_at timestamptz NOT NULL,
  data            jsonb       NOT NULL DEFAULT '{}'::jsonb
);
```

- **Indexing**: the PK on `sender_id` is the ONLY index needed — every access is a point
  lookup by sender (`get`) or an UPSERT keyed by sender. No JSONB GIN index required (we
  never query *inside* `data`; it is an opaque bag read/written whole). Adding a GIN index
  would be pure write-amplification with zero read benefit. Keep it out until a real
  in-JSONB query requirement appears.
- **`last_message_at` as `timestamptz`**: the port stores an ISO 8601 string. Map on
  write (`$2::timestamptz`) and format back to ISO 8601 on read (`.toISOString()`), OR
  store as `text` to avoid tz round-trip drift. **Open question below** — recommend
  `timestamptz` (semantically correct, idle-timeout math benefits) with an explicit
  ISO-round-trip contract test.
- **UPSERT mapping** (the crux — matches the port's UPSERT contract):
  ```sql
  INSERT INTO conversation_state (sender_id, last_message_at, data)
  VALUES ($1, $2, $3)
  ON CONFLICT (sender_id) DO UPDATE
    SET last_message_at = EXCLUDED.last_message_at,
        data            = EXCLUDED.data;
  ```
  Because the port's `update` is a SHALLOW MERGE at the object level (not a deep JSONB
  merge), the adapter reads-merges-writes the whole `data` object in application code
  (mirroring the in-memory adapter), then writes the merged bag. `data = EXCLUDED.data`
  (whole-value replace) is correct; do NOT use `data || EXCLUDED.data` (JSONB concat)
  unless we decide to push the shallow-merge into SQL — either works, but application-side
  merge keeps behavior identical to the in-memory adapter and is easier to test. Use
  `RETURNING sender_id, last_message_at, data` to return the merged row in one round-trip.

## Testing Strategy under strict TDD (`pnpm test`)

TDD is active: write failing spec first, then minimal impl. The hard part is proving REAL
SQL behavior (UPSERT, JSONB round-trip, `timestamptz` ISO round-trip) without a fragile setup.

**Recommended (lowest-friction that still proves real SQL): a shared contract test suite
run against BOTH adapters + Testcontainers-Postgres for the real DB.**

- **Contract suite**: extract the behavioral scenarios (create/get/update-UPSERT/messages
  default/round-trip) into ONE reusable describe-block parameterized by a store factory.
  Run it against the in-memory adapter (fast, already green) AND the Postgres adapter
  (real DB). This guarantees the durable adapter is a behavioral drop-in and catches drift
  for free. The existing `in-memory-conversation.store.spec.ts` scenarios are the seed.
- **Real DB layer**: `@testcontainers/postgresql` spins an ephemeral Postgres in Docker,
  runs the migration, and tears down. This proves ACTUAL `ON CONFLICT` and JSONB behavior —
  a hand-mocked `Pool` cannot. Gate it so it is skippable where Docker is absent
  (e.g. `describe.skip` when `DOCKER`/CI flag unset) so `pnpm test` stays green locally
  without Docker, while CI runs the real thing.
- **Pure-unit fallback for logic**: a mocked-`Pool` unit test covers the row↔state mapping,
  the ISO/`timestamptz` conversion, and that the correct SQL text/params are issued — fast,
  no Docker. Use it for the mapping/merge logic; use Testcontainers for the SQL semantics.
- **Rejected**: relying on a developer's locally-installed Postgres (non-hermetic, flaky
  across machines/CI). Testcontainers is hermetic and reproducible.

This yields three test files: the shared contract suite, a Postgres+Testcontainers spec,
and a mocked-Pool unit spec — all under strict TDD (write the failing Postgres contract run
first, then implement the adapter minimally to pass).

## Migration + Deployment Concerns

- **Running migrations on the VPS**: prefer an explicit, idempotent **`pnpm migrate` command
  run as a deploy step** (before starting the new process), NOT an on-boot auto-migrate
  hook. Auto-migrate-on-boot risks race conditions if more than one instance starts and
  couples schema changes to request-serving startup. For a single small service a manual/CI
  deploy step is safest and most observable. (`node-pg-migrate up` fits this cleanly.)
- **Connection pooling**: one small service → a small `pg.Pool` (e.g. `max` ~5–10, tunable
  via env). No pgbouncer needed at this scale. Pool is a singleton Nest provider.
- **Graceful shutdown**: enable `app.enableShutdownHooks()` in `main.ts` (currently absent)
  and implement `OnModuleDestroy` on the pool provider to `await pool.end()` so connections
  drain cleanly on redeploy/SIGTERM. This is a required addition — the current bootstrap
  has no lifecycle hook.
- **Local dev**: a `docker-compose.yml` with a Postgres service is the low-friction way to
  give every dev + Testcontainers-parity a matching DB. Recommend including it (small,
  high value) — but flag as an explicit scope decision for the proposal.
- **Hard architectural rule (forward)**: the chatbot connects ONLY to its OWN Postgres.
  DB connection env vars are distinct from anything backend-related; there is NO backend-DB
  access anywhere in this service. The proposal/spec MUST restate this invariant.

## Recommendation

**Approach 1 — raw `pg` + hand-written parameterized SQL + `node-pg-migrate`**, with a
**Testcontainers-backed contract test suite** shared across both adapters.

Rationale: this is ONE table with point lookups and a single UPSERT — the domain is so
small that any ORM/query-builder is net overhead (build steps, engines, cold-start weight)
on a deliberately-lean VPS service. Raw `pg` maps the UPSERT contract 1:1 to
`INSERT ... ON CONFLICT`, gives native JSONB with zero ceremony, and matches this repo's
established "thin port + confined-infra-adapter" style (the backend's Prisma is the OTHER
repo's standard, not this one's). Testcontainers proves the real SQL semantics that a mock
cannot, and the shared contract suite guarantees the durable adapter is a true drop-in for
the in-memory one behind the unchanged `CONVERSATION_STORE` token.

## Risks

- **Spec says "in-memory ONLY"** — the delta must be a clean MODIFIED requirement, not an
  ADDED one, or the archive/spec-sync will conflict. Flag for sdd-spec.
- **`timestamptz` ↔ ISO 8601 string round-trip drift** — the port uses a string;
  mismatched precision/tz handling could break idle-timeout math. Mitigate with an explicit
  round-trip contract test; decide `timestamptz` vs `text` in the proposal.
- **Shallow-merge semantics** — the port merges at the object level; naive `data ||
  EXCLUDED.data` JSONB concat would deep-behave differently. Keep the merge in application
  code to stay byte-identical to the in-memory adapter; assert via the shared contract suite.
- **Testcontainers/Docker availability in CI** — no `.github/workflows/` exists yet; running
  a real Postgres in CI needs a Docker-capable runner. If CI is deferred (as the LLM slice's
  was), the real-DB test must still be runnable locally and not silently skipped everywhere.
- **Graceful shutdown currently absent** — forgetting `enableShutdownHooks()` + `pool.end()`
  leaks connections across redeploys on the VPS.
- **Migration execution discipline on the VPS** — no migration runner exists today; the
  deploy runbook must include the migrate step or schema drift will surface at runtime.

## Open Questions / Blockers for the Proposal

1. **Postgres version target** on VPS 2 (affects `ON CONFLICT` — fine ≥9.5, and JSONB — fine
   ≥9.4; any modern PG is safe, but pin a version for Testcontainers image parity).
2. **`docker-compose.yml` for local dev** — in scope for this slice or a follow-up? (Recommend
   in-scope: small, unlocks Testcontainers parity and dev onboarding.)
3. **Pool size defaults** and env var names (e.g. `DATABASE_URL` single-DSN vs discrete
   `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`; pool `max`, idle/connection timeouts).
   Recommend a single `DATABASE_URL` (Joi `.uri().required()`) + optional `DB_POOL_MAX`.
4. **`last_message_at` storage type** — `timestamptz` (recommended, correct semantics) vs
   `text` (zero round-trip risk). Decide before spec.
5. **Migration execution model** — confirm deploy-step `pnpm migrate` (recommended) vs
   on-boot auto-migrate.
6. **CI Docker capability** — is the CI runner Docker-enabled for Testcontainers, or does the
   real-DB test run only locally for this slice (mirroring the deferred `ci.yml`)?

## Ready for Proposal

**Yes.** The port is stable and the swap point is a single `useClass` binding. The
recommended path (raw `pg` + `node-pg-migrate` + Testcontainers contract suite) is
low-risk and idiomatic to this repo. The proposal should resolve the 6 open questions
above (esp. env var shape, `timestamptz` vs `text`, docker-compose scope, and CI Docker
capability) and note the `conversation-store` spec must ship a MODIFIED delta relaxing the
"in-memory only" clause.
