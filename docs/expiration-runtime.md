# EXPIRATION runtime — default-off intake

Status: **E1b intake connected; E2 polling/preparation delivered; E3 send boundary wired default-off; E4 terminal outcome/ACK recovery includes controlled-writer STALE recovery; expired/no-ledger handling included; full-flow deployment rehearsal pending.** Business/wire rules remain authoritative in
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
rechecks locked context. Shutdown drains in-flight work (including an in-flight
delivery) before returning. Preparation alone never sends; only a `prepared`
result is offered to the E3 delivery boundary, which owns claim/send/acceptance.
For expired decisions the loop delegates to the guarded STALE store described
below; it never directly writes ledger rows or ACKs.
Throughput is bounded per process, not a global credential-rate guarantee.

## E3 send boundary (wired default-off)

`ExpirationDeliveryService` is the send boundary. It prepares the
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
reporting and ACK remain E4. `ExpirationPreparationRuntime` now builds the
boundary and hands it to the poller: the loop offers a candidate **only** when
preparation reports `prepared` and it has not stopped, and `deliverOnce`
re-claims before any send, so an already-accepted or `SEND_STARTED` row is not
re-sent. `readLatest` and `classifyExpirationPreSend` use the **exact same Meta
`phoneNumberId`** that authenticates inbound capture (`meta.phoneNumberId`); the
runtime reads it at the enabled gate and refuses to start an enabled poller
without a non-blank identity, while the disabled path performs no new work or
validation. Acceptance stays local evidence, not device delivery; E4 owns
backend reporting and ACK.

## E4 terminal outcome/ACK recovery (default-off)

Every sweep performs a **durable terminal read before any preparation or send**.
An existing `PROVIDER_ACCEPTED`/`PROVIDER_ACCEPTED_LATE` row is routed with the
trusted original candidate to `ExpirationApplicationOutcomeCoordinator.finishOnce`,
which revalidates the candidate/row, rereads the recorded context and durable row,
then reports the outcome, writes the ACK and closes through
`PostgresExpirationApplicationCompletionStore` under its durable locks. A
restarted process therefore finishes reporting/ACK/closure without resending.
`PENDING_DELIVERY` and `SEND_STARTED` are non-terminal and fall through to the
unchanged prepare/claim/send path; an already-started row is never re-sent.
`STALE` routes the trusted resolved decision directly to the outcome coordinator,
without constructing an in-window candidate. A shared terminal-only validator
uses the row's actual `staleObservedAt` to validate expiry and detaches the
original context before awaits; coordinator and closure still recheck exact
identity, durable context, row and ACK. Recovery trusts the controlled application
write surface: only the guarded stale-store transaction produces STALE, from
exact PENDING or an explicitly absent ledger row for trusted resolved evidence. Row shape or lock equality alone is not historical no-send proof; manual
ledger imports and out-of-band sends are not covered by this trust boundary.
`PostgresExpirationApplicationStaleStore` exposes a second explicit entry,
`expireResolvedOutcome`, beside the unchanged in-window candidate entry
`expirePending`. It accepts trusted `ExpirationExistingDecisionOutcome` resolved
evidence (for example a decision first consumed after its window closed) that the
in-window candidate factory refuses, without fabricating `checkedAt` or dressing
it as a candidate; both entries share the same reservation/ledger locks, context
revalidation, exact `PENDING_DELIVERY` CAS and fresh-clock policy, so a row is
marked `STALE` only when that fresh clock classifies `expired`. The resolved
entry can insert STALE directly when the locked read returns explicit absence;
no PENDING or send history is fabricated. A missing row cannot be row-locked:
`ON CONFLICT DO NOTHING` protects both decision and attempt identity. Any lost
insert race holds without reread, overwrite or retry. The older `expirePending`
entry still holds on absence. Non-pending and already-started rows hold unchanged.
The enabled runtime now supplies this store to the poller. After the terminal
read, an explicitly `expired` policy result routes trusted resolved evidence to
`expireResolvedOutcome`, never to preparation or delivery. The store rechecks
expiry with its own fresh clock under locks; the poller's classification is not
write authority. `recordedStale`, hold and failures never trigger reporting or
closure in the generation tick; the next sweep recovers the terminal row. This establishes
only controlled local transition history, not proof against out-of-band sends
or manual database writes.

Recovery uses the accepted row's historical in-window `attemptedAt` instead of
the current clock, so a restart after the 24h window still reaches the
coordinator; the send boundary still samples its own fresh clock, so this is not
send authority. A freshly `accepted` row with no prior terminal is handed to the
same coordinator. An uncertain report/ACK/closure only returns `hold` and the
durable row stays, so later sweeps re-invoke `finishOnce` without resending. The
runtime composes the real coordinator with bound ports sharing the same pool,
branch and `meta.phoneNumberId`.

### Limits / remaining readiness

- **STALE recovery is conditional on controlled writer provenance.** Unknown or
  manually imported history is not certified by snapshot checks. Invalid binding,
  changed durable context/row/ACK or uncertain I/O holds without a send.
  Existing valid ACK skips reporting; closure still requires confirmed COMMIT.
  `PROVIDER_ACCEPTED_LATE` never auto-closes.
- **First observed expired without a ledger row inserts STALE conditionally.**
  The reservation/context must remain exact and the transaction must commit.
  The next sweep reports/ACKs/closes through the existing terminal path.
  This assumes controlled writers never delete ledger history; manual deletion
  or out-of-band sends are not certified by absence. Conflicts remain held.
- **Local composed persistence is covered with disposable PostgreSQL.** The
  coordinator DB suite runs real discovery, polling, preparation, claim,
  acceptance, ACK persistence and locked closure. It covers one simulated send,
  recovery after report failure or a held closure using fresh poller/pool
  instances without resend, and STALE recovery with/without prior preparation.
  Closed reservations disappear from discovery. GET, latest inbound observation,
  provider send and backend report/ACK responses are simulated; the recorded
  inquiry is seeded. This is not ingress/HTTP, live Meta, OS-restart, hard-crash
  or ambiguous-COMMIT proof.

## Intake diagnostics

A rejected intake emits `expiration_intake stage=<stage> reason=<reason>` from
`MinimalExpirationRequestService`. Stages are `validation`, `stock`, `grounding`,
`reservation`, and `post`. Reasons are fixed codes: `disabled`,
`invalid_product_id`, `invalid_variant_id`,
`unknown_product`, `invalid_stock`, `subject_blocked`, `reservation_not_claimed`,
`receipt_not_recorded`, or `exception`. No input, identifiers, adapter error
messages, credentials, or human text are included. `exception` identifies the
stage only, not the underlying cause. Customer replies and admission rules are
unchanged; these warnings do not prove a backend request occurred.
The EXPIRATION tool UUID schema also applies the intake version/variant pattern:
Zod's special nil/max UUIDs are rejected before service execution. The model is
instructed to omit `variantId` for products without variants, never to supply a
placeholder. RESTOCK schemas and the service's grounding rules are unchanged.
This closes a reproduced schema mismatch; it does not prove which argument was
sent in the production incident.

Invalid-ID warnings additionally include a fixed `shape` code: `absent`, `null`,
`wrong_type`, or `invalid_format`. The argument value is never logged. An omitted
variant remains accepted; this diagnostic does not relax UUID validation.

Run the isolated proof (Docker and `postgres:16-alpine` required):

```sh
RUN_DOCKER_TESTS=1 pnpm test --runTestsByPath src/human-decisions/infrastructure/postgres-expiration-application-outcome-coordinator.db.spec.ts --runInBand
```

- **Owner-run manual rehearsal is still required before activation.** On a
  disposable branch confirm discovery → preparation → send → acceptance →
  report/ACK → closure, then restart mid-outcome and confirm the next sweep
  resumes reporting without resend; deployment/activation/commits stay manual.
