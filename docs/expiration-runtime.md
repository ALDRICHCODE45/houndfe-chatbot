# EXPIRATION runtime — default-off intake

Status: **E1b intake connected; E2 polling/preparation delivered; E3 send boundary dormant, not wired; E4 pending.** Business/wire rules remain authoritative in
`docs/human-decisions-expiration-v1.md`. E1 is split into two units:

- **E1a (this unit):** the default-off callee — one cohesive service plus the
  config gate and the POST-orchestrator DI prerequisite, with direct service and
  config tests; committed separately.
- **E1b:** `prepareExpiration` requires enabled configuration and bound inbound identity.
  Its prompt requires an explicit expiry question. Only one attempt per run is allowed.
  Its server reply wins over model text and RESTOCK offers; unsent offers are not armed.
  RESTOCK-only behavior is unchanged; there is no automatic deferred-offer schedule.

`MinimalExpirationRequestService.prepare` fences the candidate with the caller
allowlist, grounds a sender-bound inbound event and an explicit owned subject from
a fresh trusted `getStock` via `preflightExpirationSubject`, reserves through
`SharedReservationPort.reserve` (same sender; `post_state` stays NULL), then runs
the unchanged `ExpirationPostOrchestrator` (`preparePost` CAS NULL → RESERVED plus
the single POST and receipt recording). Simple products use `variantId: null`; a
variant product needs an explicit owned variant or the result is `clarify` with
nothing reserved. No out-of-stock requirement and no RESTOCK consent gate.
`registered`/`existing` need a confirmed receipt plus the durable local
association; every other path is the retryable `unavailable` reply, so a caller
can never render a failed intake as success. `HumanDecisionsModule` provides the
store and orchestrator inertly; the agent module now injects the gated service. Intake acknowledgements are neutral; only the eventual human answer names
the original product/presentation, never a fresh catalog label on replay.

Activation is owner-gated by the exact `HUMAN_DECISIONS_EXPIRATION_ENABLED=true`
(projected at `minimalCatalogAgent.expirationEnabled`); any other value stays off.
Intake is not a complete handoff (no polling/copy/send/ACK; E2–E4).

## E2 recovery discovery (read-only)

E2 starts with `PostgresExpirationRecoveryDiscoveryStore.discoverRecordedHints`:
a read-only adapter that pages `ACTIVE` `EXPIRATION` `RECEIPT_RECORDED`
reservations by their unique `request_key`, with an exclusive restartable
`afterRequestKey` cursor, a bounded `limit` (1–200, default 50) and a `limit + 1`
lookahead. No in-process seen-key set or cumulative ceiling; a fresh adapter can
resume from a supplied cursor. The runtime below restarts from the beginning. It selects only
`sender_id`/`request_key` and never reads `expiration_application_ledger`, so
mixed or ambiguous delivery states are neither interpreted nor turned into
permission. Identities are **hints only**: the existing context reader must
revalidate the full context before any GET, preparation, claim or send. Corrupt
rows hold the page; SQL failures propagate. No schema, timer, registration,
mutation, POST or ACK.

## E2 recurring preparation (default-off)

`ExpirationPreparationRuntime` starts only when the EXPIRATION gate is strictly true.
It processes one recorded inquiry every five seconds, sequentially, and wraps after
an exhausted page. A restart begins a fresh database sweep; no persisted cursor or
volatile receipt queue is required. Pending decisions and new keys are revisited.
The original request key must still match before validated preparation; the store
rechecks locked context. Shutdown drains in-flight work before returning.
This loop never sends, marks stale, or ACKs; E3/E4 remain required before activation.
Throughput is bounded per process, not a global credential-rate guarantee.

## E3 send boundary (dormant, not complete)

`ExpirationDeliveryService` is the unwired send boundary. It prepares the
historical copy **before** claiming (an unusable copy consumes no claim), then
claims via the existing ledger store: `SEND_STARTED` is a local claim, not send
authority. At the boundary it re-reads the latest authenticated inbound
(`readLatest`) and samples a fresh caller clock after every await, and
`classifyExpirationPreSend` gates the send: a stale WhatsApp or human window,
missing inbound or mismatch holds without sending. Exactly one send is
attempted; only a definite provider acceptance is recorded immediately, using
the started row's exact attempt/token bytes and a fresh observation time
(`recordAcceptance`). Acceptance is local evidence, not device delivery. A
thrown or ambiguous send/acceptance holds and is never retried. Backend outcome
reporting and ACK remain E4. The runtime and poller stay preparation-only and
default-off, so E3 is **not** complete: wiring and E4 are still required.
