# Local checkout draft ownership

The optional `ConversationStore.commitMinimalCheckoutDraft` capability owns `data.minimalCheckoutDraft`. The memory adapter implements it; PostgreSQL support and conversational selection/confirmation are separate follow-up units. This does not activate checkout, register customers, edit saved addresses, place orders or call shipping providers.

## Memory contract

1. Read a detached state with `get(senderId)` and retain the raw checkout value as the expected value.
2. Submit a sender-bound v1 draft with `commitMinimalCheckoutDraft(senderId, expected, next, lastMessageAt)`.
3. On `false`, do not retry blindly: the expectation may be stale or the next draft invalid. Refresh through the application flow before a new decision.

| Boundary                                 | Behavior                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optional capability                      | Older adapters remain valid. Consumers must check capability availability; never fall back to legacy `update` for checkout writes.                                  |
| Expected `undefined`                     | Requires an absent **own** checkout key. An own key holding `undefined` is not absent.                                                                              |
| Expected `null` or malformed legacy JSON | Compares the present raw value; it does not become absence or normalized `null`.                                                                                    |
| Next value                               | Must pass the existing v1 draft normalizer and match the trusted sender exactly. No clearing command is introduced.                                                 |
| Invalid input/conflict                   | Returns `false`, without creating a row or changing its data/timestamp.                                                                                             |
| Success                                  | Replaces only the checkout slot, preserves live siblings and retains the newer inbound timestamp.                                                                   |
| Legacy `update`                          | Strips caller checkout values and reapplies the live own slot, including `null`/`undefined`. Cannot insert, remove or overwrite it.                                 |
| Memory snapshots                         | `get`, `create` and `update` detach state/data containers and independently copy the owned checkout value. Unrelated nested objects retain their existing identity. |
| Raw seeds                                | `create` accepts cloneable raw checkout data for legacy seeding. An accessor or non-cloneable checkout seed rejects before inserting/replacing state.               |

The new draft is still **unconfirmed**. Backend address `version` is a freshness marker, not a local compare-and-set guarantee. This memory adapter does not survive process restarts; the PostgreSQL unit must prove durable CAS separately. JSONB cannot represent an own `undefined` value, so the memory-only preservation case is not a PostgreSQL persistence promise.

## Offline proof

No backend, Meta, database connection or production environment is needed:

```sh
node node_modules/jest/bin/jest.js --runTestsByPath src/conversation/infrastructure/minimal-checkout-draft-persistence.spec.ts --runInBand
```

The reusable public contract covers first creation, raw legacy slots, detached reads and exact saved snapshots, competing writers, unchanged rejected writes, sibling/timestamp preservation, stale/omitted legacy patches, and cart/agent-turn compatibility. Memory-only cases check own `undefined`, sibling identity, and unrelated getters.

## Rollback boundary

Remove the optional port method, the memory checkout CAS/snapshot helper and checkout-specific update carve-out, plus this unit's contract/runner and documentation. No schema, environment, dependency, backend or existing cart/RESTOCK/EXPIRATION behavior is intentionally changed.

Runtime boundary: no new tool, channel or deployed capability is enabled by this unit. Public offline adapter calls are its functional harness; live WhatsApp behavior remains unverified until the later integration and separately authorized rehearsal.
