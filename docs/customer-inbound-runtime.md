# Customer inbound runtime capture

## Current boundary

`HUMAN_DECISIONS_CUSTOMER_INBOUND_ENABLED` defaults to `false`. Only the exact
strings `true` and `false` pass environment validation; ambiguous spellings fail
startup. The configuration factory enables the flag only for the exact `true`.

This first integration unit enables **authenticated snapshot availability only**:
a successful Meta HMAC verification retains a private, immutable copy of the raw
request and its verification time when either this flag or
`HUMAN_DECISIONS_RESTOCK_ENABLED` is enabled. Both flags off retain no snapshot.
Invalid signatures never publish evidence and revoke any previous snapshot for
that request. RESTOCK does not require the new flag.

The capture/persistence functions and PostgreSQL adapter exist, but this unit
**does not wire customer capture into the webhook controller**. Enabling the flag
alone does not persist observations, read the latest message, renew a service
window or authorize sending. Leave it unset/false until the remaining integration
and deployment prerequisites are separately approved.

## Planned controller policy

When capture wiring is delivered and explicitly enabled, capture HOLD or storage
failure will return HTTP 500 before dispatch. Meta may redeliver the webhook;
there are no in-process retries or rollback of an already persisted prefix.
Default-off behavior and RESTOCK admission must remain compatible.

No production migration, environment activation or real-message operation is
part of this change. Applying migration `3100000000000` and enabling capture in
an environment require separate operational authorization.
