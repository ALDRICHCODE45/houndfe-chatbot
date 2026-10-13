# Local checkout draft ownership

The optional `ConversationStore.commitMinimalCheckoutDraft` capability owns `data.minimalCheckoutDraft`. Both adapters now implement it: memory (T2B1) and PostgreSQL (T2B2). Conversational selection, grounding and confirmation remain a separate follow-up unit (T3). This does not activate checkout, register customers, edit saved addresses, place orders or call shipping providers.

## Memory contract

1. Read a detached state with `get(senderId)` and retain the raw checkout value as the expected value.
2. Submit a sender-bound v1 draft with `commitMinimalCheckoutDraft(senderId, expected, next, lastMessageAt)`.
3. On `false`, do not retry blindly: the expectation may be stale or the next draft invalid. Refresh through the application flow before a new decision.

| Boundary                                 | Behavior                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optional capability                      | Older adapters remain valid. Consumers must check capability availability; never fall back to legacy `update` for checkout writes.                                          |
| Expected `undefined`                     | Requires an absent **own** checkout key. An own key holding `undefined` is not absent.                                                                                      |
| Expected `null` or malformed legacy JSON | Compares the present raw value; it does not become absence or normalized `null`.                                                                                            |
| Next value                               | Must pass the existing v1 draft normalizer and match the trusted sender exactly. No clearing command is introduced.                                                         |
| Invalid input/conflict                   | Returns `false`, without creating a row or changing its data/timestamp.                                                                                                     |
| Success                                  | Replaces only the checkout slot, preserves live siblings and retains the newer inbound timestamp.                                                                           |
| Legacy `update`                          | Strips caller checkout values and reapplies the live own slot, including `null`/`undefined`. Cannot insert, remove or overwrite it.                                         |
| Memory snapshots                         | `get`, `create` and `update` detach state/data containers and independently copy the owned checkout value. Unrelated nested objects retain their existing identity.         |
| Raw seeds                                | `create` accepts cloneable raw checkout data for legacy seeding. An accessor or non-cloneable checkout seed rejects before inserting/replacing state (memory adapter only). |

The new draft is still **unconfirmed**. Backend address `version` is a freshness marker, not a local compare-and-set guarantee. This memory adapter does not survive process restarts; the PostgreSQL unit must prove durable CAS separately. JSONB cannot represent an own `undefined` value, so the memory-only preservation case is not a PostgreSQL persistence promise.

## PostgreSQL adapter

`PostgresConversationStore.commitMinimalCheckoutDraft` is the durable counterpart. Same public rule, one parameterized guarded statement, no application read-modify-write and no retry:

| Boundary                    | Behavior                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Expected `undefined`        | First-contact UPSERT (`INSERT ... ON CONFLICT DO UPDATE`) gated on `NOT (data ? 'minimalCheckoutDraft')`; an own key holding JSON `null` blocks it.                                                                |
| Any other expected value    | UPDATE-only, gated on `data->'minimalCheckoutDraft' = $4::jsonb`, so absence can never be satisfied by a present corrupt slot.                                                                                     |
| Raw corrupt expectations    | Compared verbatim (`null`, `{"corrupt":true}`, JSON arrays/scalars); never normalized.                                                                                                                             |
| Non-comparable expectations | A value that would not stringify back to the same JSON document (cycle, accessor, class instance, `undefined`, function, symbol, bigint, non-finite number) returns `false` before any query.                      |
| Invalid `next` / timestamp  | The existing sender-bound v1 guard plus the memory timestamp gate run before any query; `false` never creates or changes a row.                                                                                    |
| Success                     | Replaces only the checkout key, merges the live row's siblings, keeps the newer inbound timestamp via `GREATEST`.                                                                                                  |
| Generic `update`            | Strips an incoming `minimalCheckoutDraft` and re-applies the live own key inside the existing row-lock carve-out, exactly like the receipt/marker/cart/agent keys. It cannot insert, remove or overwrite the slot. |
| Other CAS writers           | `commitMinimalCart` and `commitAgentTurn` keep their live-sibling merge, so a committed draft survives them too.                                                                                                   |

`create()` stays the legacy generic writer: it serializes whatever it is handed, so the memory fail-closed guards for accessor or non-cloneable checkout seeds, and own-`undefined` preservation, are memory-only boundaries. Callers must write the draft through `commitMinimalCheckoutDraft` only.

### Durable proof status

**Observed: 65 tests passed with zero skips** against a parent-owned disposable PostgreSQL 16 instance: 43 offline cases and all 22 gated cases. The live JSONB proof covers the shared B1 contract, a fresh adapter with a separate client, competing CAS, rejected writes leaving data/timestamps unchanged, and a forced stale-read update preserving the newer checkout draft. It does not establish process/server restart survival or production deployment.

The stale-read case executes and captures revision 0 before allowing the rival public CAS to commit revision 1. Its shared barrier also has offline probes for SELECT failure, a missed barrier and assertion failure: rejected or completed operations settle the wait, held work is released and settled before pool cleanup. Offline results alone are not durable evidence.

The container used only a RAM tmpfs at `/var/lib/postgresql/data`, a dynamically assigned loopback port, the cached immutable image and no host/persistent mounts. The suite closed its pool and the parent removed its exact newly created container. Docker's legacy `--tmpfs` configuration appears in `HostConfig.Tmpfs` even when `.Mounts` is empty; check both metadata and the actual filesystem type, rather than requiring a tmpfs entry in `.Mounts`.

The gated runner contract, in the same spec file:

1. Parent-owned lifecycle only. The spec never imports Testcontainers, starts, inspects, prunes or removes a container. It only dials loopback.
2. Gate `RUN_CHECKOUT_DRAFT_DB_TESTS=1` is required and re-checked before the `Pool` constructor; with the gate off the suite registers as skipped and constructs no `Pool`.
3. Port `CHECKOUT_TEST_PG_PORT` must be numeric `1..65535`; anything else throws before any connection attempt. There is no default and no `DATABASE_URL` or configured-connection-string fallback.
4. Fixed test-only target: host `127.0.0.1`, database `checkout_test`, user `postgres`, password `checkout_test`, `ssl: false`, `max: 4`, `connectionTimeoutMillis: 5000`, `statement_timeout: 5000`.
5. Readiness is one acquired-and-released client; DDL is the inline `CREATE TABLE conversation_state (sender_id text PRIMARY KEY, last_message_at timestamptz NOT NULL, data jsonb NOT NULL)` in that disposable database only.
6. Per-case cleanup deletes rows from that table only; `afterAll` drops the table and closes every pool the suite opened.

```sh
# PORT must come from the parent's exclusively owned disposable container.
RUN_DOCKER_TESTS=0 RUN_CHECKOUT_DRAFT_DB_TESTS=1 CHECKOUT_TEST_PG_PORT="$PORT" \
  node node_modules/jest/bin/jest.js --runTestsByPath \
  src/conversation/infrastructure/minimal-checkout-draft-postgres.spec.ts --runInBand
```

## Offline proof

No backend, Meta, database connection or production environment is needed:

```sh
RUN_DOCKER_TESTS=0 RUN_CHECKOUT_DRAFT_DB_TESTS=0 node node_modules/jest/bin/jest.js --runTestsByPath src/conversation/infrastructure/minimal-checkout-draft-postgres.spec.ts --runInBand
node node_modules/jest/bin/jest.js --runTestsByPath src/conversation/infrastructure/minimal-checkout-draft-persistence.spec.ts --runInBand
```

The reusable public contract covers first creation, raw legacy slots, detached reads and exact saved snapshots, competing writers, unchanged rejected writes, sibling/timestamp preservation, stale/omitted legacy patches, and cart/agent-turn compatibility. Memory-only cases check own `undefined`, sibling identity, and unrelated getters. The same runner is reused unchanged for the gated PostgreSQL suite.

## Rollback boundary

PostgreSQL unit: remove `commitMinimalCheckoutDraft` plus its module-local JSON comparability helpers, the `minimalCheckoutDraft` entries from `update()` (the strip and the live-key re-apply list), `src/conversation/infrastructure/minimal-checkout-draft-postgres.spec.ts` and this document's PostgreSQL sections. No schema migration, runtime environment variable, dependency, backend, CLI or existing cart/RESTOCK/EXPIRATION behavior is intentionally changed; the memory/port/normalizer contract from T2B1 is untouched.

Runtime boundary: no new tool, channel or deployed capability is enabled by this unit. Nothing activates the draft; the store method stays unused until the T3 integration unit wires it. Public offline adapter calls are its functional harness; the durable race proof requires the gated disposable database, and live WhatsApp behavior remains unverified until the later integration and separately authorized rehearsal.
