# Customer inbound runtime capture

## Current boundary

`HUMAN_DECISIONS_CUSTOMER_INBOUND_ENABLED` defaults to `false`. Only the exact
strings `true` and `false` pass environment validation; ambiguous spellings fail
startup. The configuration factory enables the flag only for the exact `true`.

A successful Meta HMAC verification retains a private, immutable copy of the raw
request and its verification time when either this flag or
`HUMAN_DECISIONS_RESTOCK_ENABLED` is enabled. Both flags off retain no snapshot.
Invalid signatures never publish evidence and revoke any previous snapshot for
that request. RESTOCK does not require the new flag.

When enabled, the controller persists authenticated customer metadata through
the existing standalone PostgreSQL pool after RESTOCK admission (if enabled)
and before dispatch/dedup. Operational senders and known outbound message IDs
use the existing handoff and recent-outbound filters. With the flag off, customer
capture performs no writes and the original dispatch path remains unchanged.
No latest-read consumer, service-window renewal or send authority is added.

## Controller failure policy

Enabled capture HOLD, missing capture dependency/snapshot or storage failure
returns generic HTTP 500 without dispatch or private error details. Meta may
redeliver; no in-process retries or rollback of an already persisted prefix occur.
RESTOCK rejection still stops admission before customer capture. Successful
capture retains the existing dispatcher and its independent send rules.

No production migration, environment activation or real-message operation is
part of this change. Applying migration `3100000000000` and enabling capture in
an environment require separate operational authorization.
