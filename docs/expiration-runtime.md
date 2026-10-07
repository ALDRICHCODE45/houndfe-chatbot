# EXPIRATION runtime — default-off intake

Status: **E1b intake connected, not activated; E2–E4 pending.** Business/wire rules remain authoritative in
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
