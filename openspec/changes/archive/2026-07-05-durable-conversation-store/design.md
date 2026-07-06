# Design: Durable Conversation Store (Postgres)

## Technical Approach

Bind `CONVERSATION_STORE` to a Postgres-backed adapter that satisfies the UNCHANGED
port (`src/conversation/domain/conversation-store.ts`) byte-identically to the in-memory
adapter. Raw `pg` (no ORM), one `conversation_state` table (PK on `sender_id`, `data jsonb`),
a singleton `pg.Pool` provider that closes on shutdown, Joi-validated `DATABASE_URL` +
`DB_POOL_MAX`, manual `pnpm migrate` (node-pg-migrate). `AgentRunner` — the only consumer —
requires zero changes. A single parameterized contract suite runs the SAME scenarios against
both adapters; the Postgres pass is Testcontainers-backed and gated by `RUN_DOCKER_TESTS=1`.
Realizes all 8 requirements / 13 scenarios of the `conversation-store` delta.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Driver | Raw `pg` + `@types/pg` | Prisma / TypeORM | LOCKED. One table, PK lookups only; ORM is dead weight. Confines SQL to one adapter file. |
| Merge strategy | Read-modify-write in APP code: `get` current row, spread `{ ...existing, ...patch }` (top-level), then whole-object `data` REPLACE | JSONB `data \|\| EXCLUDED.data` concat | LOCKED. Mirrors in-memory `{ ...existing, ...patch }` EXACTLY. In-memory replaces `data` wholesale when the patch carries it, preserves it when the patch omits it. JSONB deep-merge would diverge → contract-suite failure. |
| Timestamp column | `timestamptz`, read via `Date.toISOString()` | `text` column | `timestamptz` is correct typing; `pg` default-coerces to JS `Date`; `.toISOString()` returns the canonical ISO string. ms precision survives (PG µs ⊇ JS ms). |
| Index | PK on `sender_id` only | GIN on `data` | No in-JSONB queries; every access is `WHERE sender_id = $1`. GIN would cost writes for zero read benefit. |
| Migration timing | Manual `pnpm migrate` deploy step | On-boot auto-migrate | LOCKED. Avoids multi-instance migration races; boot stays a pure read/write path. |
| Contract suite | One `describe` factory `(makeStore) => {...}` invoked twice | Duplicate specs per adapter | Single source of truth for the port contract; guarantees both adapters are byte-identical. |
| Testcontainers gate | `RUN_DOCKER_TESTS=1` env flag; Postgres describe wrapped in `describe.skip` when unset | Always run / never run | LOCKED. Keeps `pnpm test` green with no Docker; runs full parity locally (Docker v29.6.1 present) and in future CI. |
| Pool lifecycle | Factory provider → singleton `pg.Pool`; `OnModuleDestroy → pool.end()` + `enableShutdownHooks()` | Per-request client / no close | LOCKED. One pool per process; clean SIGTERM shutdown, no leaked connections. |

## Data Flow

    AgentRunner ──► CONVERSATION_STORE (PostgresConversationStore)
                        │  get / create / update
                        ▼
                   pg.Pool (singleton, DATABASE_URL, max=DB_POOL_MAX)
                        │  parameterized SQL
                        ▼
                 Postgres  conversation_state(sender_id PK, last_message_at, data jsonb)

    shutdown (SIGTERM) ─► enableShutdownHooks ─► OnModuleDestroy ─► pool.end()

## File Changes

| File | Action | Description |
|---|---|---|
| `src/database/postgres-pool.provider.ts` | Create | Factory provider `PG_POOL` → singleton `pg.Pool({ connectionString, max })`; a `@Injectable() PostgresPoolLifecycle` implementing `OnModuleDestroy → pool.end()`. |
| `src/database/database.module.ts` | Create | Provides + exports `PG_POOL` and lifecycle; imports `ConfigModule`. |
| `src/conversation/infrastructure/postgres-conversation.store.ts` | Create | `PostgresConversationStore implements ConversationStore`; injects `PG_POOL`. |
| `src/conversation/conversation.module.ts` | Modify | Import `DatabaseModule`; swap `useClass: InMemoryConversationStore` → `useClass: PostgresConversationStore` (one-line binding). |
| `src/config/env.validation.ts` | Modify | Add `DATABASE_URL` (uri, required) + `DB_POOL_MAX` (int, default 5). |
| `src/config/configuration.ts` | Modify | Add typed `database` block. |
| `src/main.ts` | Modify | Add `app.enableShutdownHooks()` before `listen`. |
| `migrations/<ts>_create-conversation-state.js` | Create | node-pg-migrate up/down for `conversation_state`. |
| `.node-pg-migrate.json` (or package.json config) | Create | Migration dir + `DATABASE_URL` binding. |
| `docker-compose.yml` | Create | `postgres:16-alpine` for local dev. |
| `package.json` | Modify | Deps `pg`; dev `@types/pg`, `node-pg-migrate`, `@testcontainers/postgresql`; scripts `migrate`, `migrate:down`. |
| `src/conversation/infrastructure/conversation-store.contract.ts` | Create (test helper) | `describe` factory: shared scenarios `(makeStore) => void`. |
| `src/conversation/infrastructure/in-memory-conversation.store.spec.ts` | Modify | Invoke the contract factory with an in-memory `makeStore` (keep existing bespoke cases). |
| `src/conversation/infrastructure/postgres-conversation.store.spec.ts` | Create | Testcontainers harness (gated); applies the migration; invokes the contract factory with a Postgres `makeStore`. |
| `src/config/env.validation.spec.ts` | Modify | Add `DATABASE_URL` present/malformed + `DB_POOL_MAX` default cases. |

## Interfaces / Contracts

```ts
// src/database/postgres-pool.provider.ts
import { Pool } from 'pg';
export const PG_POOL = Symbol('PG_POOL');
// factory: (config: ConfigService) => new Pool({
//   connectionString: config.get('database.url'),
//   max: config.get('database.poolMax'),
// })
// PostgresPoolLifecycle: @Injectable() implements OnModuleDestroy {
//   constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
//   async onModuleDestroy() { await this.pool.end(); }
// }
```

```ts
// PostgresConversationStore — SQL contract
// get(senderId): SELECT sender_id, last_message_at, data
//                FROM conversation_state WHERE sender_id = $1  → row | null → toState()
//
// create(senderId, { lastMessageAt, data }):
//   INSERT INTO conversation_state (sender_id, last_message_at, data)
//   VALUES ($1, $2::timestamptz, $3::jsonb) RETURNING *  → toState()
//
// update(senderId, patch):  // read-modify-write to mirror in-memory {...existing,...patch}
//   const existing = await this.get(senderId);
//   const merged = existing
//     ? { ...existing, ...patch }              // top-level shallow; data REPLACES if present
//     : { senderId, ...patch };
//   if (typeof merged.lastMessageAt !== 'string') throw new Error(...);  // same guard as in-memory
//   const data = merged.data ?? {};
//   INSERT ... VALUES ($1,$2::timestamptz,$3::jsonb)
//   ON CONFLICT (sender_id) DO UPDATE
//     SET last_message_at = EXCLUDED.last_message_at, data = EXCLUDED.data
//   RETURNING *  → toState()
//
// toState(row): {
//   senderId: row.sender_id,
//   lastMessageAt: row.last_message_at.toISOString(),  // Date → canonical ISO, ms-exact
//   data: row.data,                                    // pg parses jsonb → JS object
// }
```

**Merge parity (RESOLVED, mirrors in-memory precisely):** in-memory `update` is
`existing ? { ...existing, ...patch } : { senderId, ...patch }`. The Postgres adapter reproduces
this in APP code, THEN issues one UPSERT whose `data` is a whole-object REPLACE. Consequences,
identical to in-memory: a patch WITHOUT `data` preserves the stored `data`; a patch WITH `data`
replaces it wholesale (no key-level deep merge). The same missing-`lastMessageAt` guard is kept.
The two DB round-trips (read then upsert) are acceptable — single-bot-per-branch v1, PK lookups.

**timestamptz ↔ ISO 8601 (RESOLVED):** WRITE binds the ISO string with an explicit
`$n::timestamptz` cast (Postgres parses `2026-06-30T15:24:13.456Z`). READ: `pg` coerces
`timestamptz` to a JS `Date`; the adapter calls `.toISOString()` to return the canonical ISO
string. JS `Date` ms precision is a subset of PG µs precision, so `"2026-06-30T15:24:13.456Z"`
round-trips exactly. No custom `pg` type parser is needed; the `.toISOString()` normalization at
the read boundary defeats any driver `Date`-formatting drift.

## Migration Strategy

- `node-pg-migrate` reads `DATABASE_URL`; migrations live in `migrations/`.
- `pnpm migrate` = `node-pg-migrate up`; `pnpm migrate:down` = `node-pg-migrate down`.
- Up/down (JS migration, English identifiers):

```js
exports.up = (pgm) => {
  pgm.createTable('conversation_state', {
    sender_id: { type: 'text', primaryKey: true },
    last_message_at: { type: 'timestamptz', notNull: true },
    data: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
  });
};
exports.down = (pgm) => { pgm.dropTable('conversation_state'); };
```

- **Testcontainers reuses the SAME migration** — the harness runs `node-pg-migrate up`
  (programmatic `runner()` or `execSync('pnpm migrate')` with the container's `DATABASE_URL`)
  against the ephemeral container. No hand-rolled DDL in tests → schema drift is impossible.

## Contract-Suite Harness

```ts
// conversation-store.contract.ts
export function runConversationStoreContract(
  makeStore: () => Promise<{ store: ConversationStore; cleanup?: () => Promise<void> }>,
) {
  // all 13 shared scenarios: create+get, get→null, update patch (data untouched),
  // update data patch (replace), UPSERT-on-missing, mixed-variant messages round-trip,
  // extra-keys round-trip, ms-precision timestamp round-trip, restart survival (Postgres:
  // makeStore twice against same DB; in-memory: N/A / same instance).
}
```

- In-memory spec (always runs): `runConversationStoreContract(async () => ({ store: new InMemoryConversationStore() }))`.
- Postgres spec (gated): `const D = process.env.RUN_DOCKER_TESTS === '1' ? describe : describe.skip;`
  - `beforeAll`: `new PostgreSqlContainer('postgres:16-alpine').start()`; run migration; build a `Pool`.
  - `makeStore`: returns a `PostgresConversationStore` over that pool (fresh instances for restart-survival scenario).
  - `afterAll`: `pool.end()`; `container.stop()`.
  - **Jest timeout**: bump `beforeAll` timeout (~60s) for container pull/start; fits existing `package.json` jest config (testRegex `.*\.spec\.ts$`, rootDir `src`, useESM:false) with no config change since the file matches `*.spec.ts` and `@testcontainers/postgresql` is CJS.

## Env & Config Wiring

| Env | Joi | Default | Surfaces as |
|---|---|---|---|
| `DATABASE_URL` | `Joi.string().uri().required()` | — (fail-fast) | `database.url` |
| `DB_POOL_MAX` | `Joi.number().integer().min(1).default(5)` | 5 | `database.poolMax` |

```ts
// configuration.ts addition
database: {
  url: process.env.DATABASE_URL as string,
  poolMax: parseInt(process.env.DB_POOL_MAX ?? '5', 10),
},
```

Boot fail-fast is FREE: the existing Joi pipeline aborts on missing/malformed `DATABASE_URL`
before any port bind — satisfies "refuses to start without valid DATABASE_URL".

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Contract | 13 shared scenarios × 2 adapters | `runConversationStoreContract(makeStore)` |
| Unit | timestamptz→ISO ms precision | Postgres contract scenario (gated) |
| Unit | merge parity (data replace vs preserve) | contract scenario, both adapters |
| Unit | Joi `DATABASE_URL` required/malformed, `DB_POOL_MAX` default | `env.validation.spec.ts` additions |
| Integration | `CONVERSATION_STORE` resolves to Postgres adapter | Nest TestingModule (mock pool) |
| Lifecycle | `OnModuleDestroy` calls `pool.end()` | spy on injected pool |

## Migration / Rollout

No data migration — durable adapter starts empty; process-local in-memory state is discarded on
restart (per spec non-goals). Rollback = revert the one-line binding to `InMemoryConversationStore`;
the port is unchanged, so it is fully revert-safe.

## Production-Line Budget

Excluded from the 400 ceiling (reported separately): tests, `docker-compose.yml`, migration SQL/JS,
lockfile.

| Production file | Est. LoC |
|---|---|
| `postgres-conversation.store.ts` | ~70 |
| `postgres-pool.provider.ts` + lifecycle | ~40 |
| `database.module.ts` | ~20 |
| `conversation.module.ts` (binding swap + import) | ~4 |
| `env.validation.ts` (2 vars) | ~6 |
| `configuration.ts` (block) | ~6 |
| `main.ts` (shutdown hook) | ~1 |
| **Total production** | **~147** |

Well under 400 and under the proposal's ~250 forecast (confirmed conservative). **No chained cut
required.** Non-production (separate): contract helper + Postgres spec + spec edits ~180, migration
~15, docker-compose ~15.

## Open Questions

- [ ] Confirm `@testcontainers/postgresql` version is CJS-compatible with the pinned Jest/ts-jest
      at apply (import shape may need `PostgreSqlContainer` named vs default) — verify against
      `node_modules` after install; does NOT block design.
- [ ] Decide whether the Postgres restart-survival scenario builds two `Pool`s or reuses one pool
      with two adapter instances — either satisfies the spec; adapter-instance reuse is simpler.
