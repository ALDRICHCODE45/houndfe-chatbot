# Human Decisions — Restock Vertical Slice

## Scope and authority

- Branch/worktree: `feat/human-decisions-restock` in the **houndfe-chatbot clone only**. Based on `main` at `ef5b5f5`; do not change the active `feat/shipping-quotes-skydropx` worktree or unrelated untracked files.
- The backend and frontend are independently owned by their assigned agents. This tracker does not authorize edits in either repository. Their objections and local authorization gates must be resolved before integration.
- First slice: a RESTOCK decision that a human records in the backend inbox and the bot safely applies to the same pending customer request. SHIPPING_APPROVAL is conditional on this slice passing equivalent checks. The shipping/receipt collision remains blocked and outside this API/UI slice.
- Offline/synthetic validation only; no live Meta, backend production DB, push, merge, deploy, or provider calls. Default shipping off. One work unit at a time, at most 390 **complete changed diff lines** per unit including tests and tracker, with strict RED→GREEN, independent verification, native review when offered, and local Conventional Commit evidence.

## Proposed cross-repository contract (not frozen)

- Backend owns a tenant-scoped, idempotent request and a versioned human decision; it does not own the chatbot conversation. FE reads a paginated PENDING projection and resolves through JWT/CASL with optimistic concurrency. Bot creates/polls through ServiceCredential, checks its own pending request identity before applying, and reports a distinct idempotent application outcome. `RESOLVED` is not `APPLIED`, and an ACK is a bot assertion, not proof of WhatsApp delivery.
- RESTOCK decisions express an **estimate**, not inventory mutation. Agreed action names: `PROVIDE_RESTOCK_ESTIMATE` with `restockDays` integer 1..365 **calendar days**, or `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` with no days. Zero/today is excluded; the negative action means **no confirmed ETA**, never "will not be restocked". The existing bot `NO_RESTOCK` cannot be reused unchanged because it means the latter. A resolution attempt has a stable `resolutionRequestId` UUID; an exact retry must replay, a conflicting attempt must fail. Neither outcome authorizes a sale.
- Owner-approved freshness for **both** actions: backend `applyBefore=resolvedAt+1 hour`; bot may start a send only before that half-open deadline, and provider acceptance must be observed before it. The positive estimate additionally remains anchored to `resolvedAt+restockDays*24 hours`, never `applyAt`; no exact date/stock guarantee. An ambiguous send is `DELIVERY_UNKNOWN` and requires audited reconciliation before retry or a replacement request. RESTOCK requests have no fixed expiry; stale conversation/product evidence must block application.
- No cross-store transaction or exactly-once outbound WhatsApp claim. An existing local ops handoff must not create a second independently actionable request for the same conversation.

## Acceptance gates

1. Request replay with the same tenant/source ID and payload is idempotent; mismatched payload conflicts. Tenant isolation and service scopes hold.
2. Two reviewers racing or a retry after transport ambiguity yield one authoritative decision; RBAC/audit and exact RESTOCK payload validation hold.
3. Bot polling applies only to its exact pending request and current subject; stale or mismatched state yields no customer promise. Replays do not duplicate the decision or notification.
4. Failed store, poll, ACK, or send cannot be reported as a completed application or customer notification. FE shows only server-verified decision state and handles conflict by refetch.
5. Tests use synthetic stores/transport and include failure-order checks; an offline passing suite is not live/provider/DB proof. If application/outcome evidence is absent, the demo is labelled 'decision recorded and controlled polling', **not** a complete handoff.

## Tasks and evidence

- [x] HD-R0 Map existing bot, backend and FE authority; propose RESTOCK-first plan with peer critique. **Read-only.** User selected one complete case, second conditional. Backend PCE-02 finishes before decision writes; FE retains local read-only until separately authorized. Tracker commit `0d8980d`.
- [ ] HD-R1 Freeze versioned cross-repo DTO/state/time-origin/HTTP/permission/idempotency/ACK contract and explicit offline scenarios with backend + FE peers. `docs/human-decisions-contract-v1.md` received **APPROVED DESIGN** votes from both assigned agents; verify/review/commit of this documentation unit pending. FE write authorization remains a separate local gate. No foreign repository writes by this session.
- [ ] HD-R2 Implement bot-only typed decision client/request seam with focused RED→GREEN and service-auth/idempotency tests. No customer send and no local pending claim until backend request is durable. Commit: pending.
- [ ] HD-R3 Implement guarded RESTOCK decision polling and local durable application ledger against the exact pending request, with stale/replay/failure tests. Commit: pending.
- [ ] HD-R4 Integrate customer notification and application outcome/ACK without false success or duplicate promise; offline failure-order matrix. Commit: pending.
- [ ] HD-R5 Wire the incoming/customer waiting and worker/dispatcher behavior, run scoped + broader offline regression, and record external blockers. Commit: pending.

## External dependencies and decisions

- Backend peer: new tenant-scoped DecisionRequest table/migration, intake uniqueness+hash, reviewer CAS/RBAC/audit, bot poll/outcome endpoints; no existing generic table, push, or delivery ACK. The backend agent is finishing authorized PCE-02 before a decision writer starts.
- Frontend peer: page/offset PENDING view under POS, RESTOCK-only typed detail/action, `HumanDecision` in both AppSubject and APP_SUBJECTS, explicit 409 UX. Its current session had a separate read-only authorization; only that owner/session may lift it.
- RESTOCK design consensus: backend authoritative `PENDING|RESOLVED`; FE discriminated projection + scoped error envelope; bot ServiceCredential create/poll/ACK, UUID intake/resolve/attempt identity, one terminal outcome and UNKNOWN/LATE reconciliation hold. Both actions use a one-hour half-open window, 1..365 natural-day positive estimate, negative no-ETA response, no fixed request expiry. `PROVIDER_ACCEPTED` is not device delivery. Backend PCE-02 has a new HIGH finding and remains ahead of decision writes; FE local read-only gate remains until owner approval.
