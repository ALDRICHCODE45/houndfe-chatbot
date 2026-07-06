# Proposal: durable-conversation-store

## Intent
Swap the in-memory `ConversationStore` for a Postgres adapter behind the unchanged `CONVERSATION_STORE` port so per-WhatsApp-sender state survives restarts on the chatbot's OWN VPS/Postgres. Keyed state (`sender_id → JSONB`), NOT vector/RAG. Chatbot DB is architecturally separate from the backend Postgres.

## Scope

### In Scope
- Deps `pg` + `@types/pg`; devDeps `node-pg-migrate`, `@testcontainers/postgresql`.
- New `postgres-conversation.store.ts`: `INSERT … ON CONFLICT (sender_id) DO UPDATE … RETURNING *`; app-side shallow merge mirrors in-memory.
- Singleton `pg.Pool` provider with `OnModuleDestroy → pool.end()`.
- One migration: `conversation_state(sender_id text PRIMARY KEY, last_message_at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb)`. PK only.
- Parameterized contract suite across BOTH adapters + Testcontainers real-DB run + mocked-Pool unit spec.
- Joi: `DATABASE_URL` required, `DB_POOL_MAX` int default 5.
- `docker-compose.yml` (postgres:16-alpine); `pnpm migrate` as MANUAL deploy step.
- `app.enableShutdownHooks()`; one-line `useClass` swap; spec MODIFIED delta.

### Out of Scope
Vector/RAG; Redis; backend-DB access; deferred `ci.yml`/`eslint-plugin-jest`; in-memory data migration; chatbot-api tools; multi-region.

## Capabilities
**New Capabilities**: None.

**Modified Capabilities** (`conversation-store`): relax `MUST use an in-memory implementation only` → `MUST bind one adapter through CONVERSATION_STORE honoring the contract (UPSERT, senderId-preserving reads, JSONB round-trip); MAY be in-memory or durable`. Existing scenarios preserved; new for durable binding + Postgres round-trip. Port UNCHANGED.

## Approach
`ConversationModule` registers a singleton `pg.Pool` from `ConfigService` (`db` typed block). A parameterized contract suite runs the SAME scenarios against BOTH adapters — guarantees byte-identical UPSERT. Shallow merge stays in app code (patch's `data` REPLACES prior). Testcontainers (`postgres:16-alpine`) proves `ON CONFLICT`, JSONB round-trip, `timestamptz` ↔ ISO 8601 on real SQL.

## Affected Areas

| Area | Impact |
|------|--------|
| `src/conversation/infrastructure/{postgres-conversation.store.ts,postgres-conversation.store.spec.ts,contract-conversation.store.spec.ts,pg-pool.provider.ts}` | New |
| `src/conversation/conversation.module.ts`, `src/main.ts`, `src/config/{env.validation,configuration}.ts`, `package.json` | Modified |
| `migrations/*_create-conversation-state.{ts,sql}`, `docker-compose.yml` | New |
| `openspec/specs/conversation-store/spec.md` | Modified (relax in-memory-only) |

## Risks

| Risk | Lik | Mitigation |
|------|-----|------------|
| `pnpm migrate` skipped on deploy | Med | Runbook step; boot logs DB host/db. |
| `timestamptz` ↔ ISO drift | Low | ms-precision contract test. |
| Testcontainers needs Docker / pool leak | Med / Low | Gate `RUN_DOCKER_TESTS=1`; `enableShutdownHooks()` + `OnModuleDestroy pool.end()`. |

## Rollback
Revert the one-line `useClass` to `InMemoryConversationStore`. Leave migration applied; new env vars stay required.

## Dependencies
Runtime `pg` + `@types/pg`; dev `node-pg-migrate` + `@testcontainers/postgresql`; Docker locally (`v29.6.1`); managed Postgres on VPS 2.

## Success Criteria
- [ ] `RUN_DOCKER_TESTS=1 pnpm test` green; `pnpm test` green without Docker.
- [ ] Shared contract rows green for BOTH adapters.
- [ ] `pnpm migrate` idempotent.
- [ ] Restart preserves a sender's transcript (real-DB).
- [ ] `PostgresConversationStore` bound; `AgentRunner` zero changes.
- [ ] Pool closes on SIGTERM.
- [ ] All existing `conversation-store` scenarios pass against the Postgres adapter.
