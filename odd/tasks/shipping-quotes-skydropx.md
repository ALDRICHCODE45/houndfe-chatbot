# Skydropx shipping quotes

## Goal

Build a provider-neutral, quote-only shipping foundation with Skydropx as the first adapter. Keep it disabled by default so this work cannot reorder or silently expand the real-number pilot.

## Selected scope

- Add `SHIPPING_QUOTES_ENABLED=false` as the default posture.
- Model shipping quote requests and normalized carrier rates behind a provider port.
- Implement the deterministic credit rule: each item with `unitPriceCents > 50_000` contributes `12_000` cents; credits sum; customer pays `max(0, bestEligibleRateCents - creditCents)`.
- Integrate the current Skydropx Pro quotation API behind an adapter with token management, bounded retries, timeouts, and redacted errors.
- Produce draft quotes only; a human must approve shipping before any customer-facing shipping amount.
- Never fabricate origin, destination, package weight, dimensions, carrier service, or live-provider readiness.
- Return a structured unavailable/handoff result when required package or configuration data is missing.
- Preserve the client rule that packages above 25 kg must be split into balanced packages; do not implement an unverified packing heuristic without exact product data.
- Record quote state in the conversation only when needed for deterministic continuation and expiry.

## Non-goals

- Envíos Perros adapter in this slice.
- Purchasing labels, scheduling pickup, tracking, cancellation, or carrier assignment.
- Enabling shipping quotes in production.
- Adding shipping cost to a sale before the backend contract can persist it.
- Modifying `houndfe-backend` from this repository.
- CDMX free-zone automation before the owner supplies the canonical zone rules.
- Activating receipt-media infrastructure or changing the preserved real-number rollout order.

## Activation prerequisites

Live activation remains blocked until all are observed:

1. Branch origin postal/address data is authoritative.
2. Product and variant weights/dimensions are populated and exposed by the backend instead of `packageInfo: null`.
3. Skydropx sandbox/production credentials and allowed host are owner-provisioned.
4. The backend can persist the approved shipping charge with the sale or a separately agreed domain path.
5. CDMX free-zone rules and service-selection policy are approved.
6. The human shipping-approval workflow is proven end to end.
7. A controlled synthetic shipping journey passes before any customer sees a quote.

## Guardrails

- Organic Driven Development only; do not create or modify SDD/OpenSpec artifacts.
- Preserve `.codegraph/**`, `odd/tasks/receipt-media-stored-worker.md`, and `openspec/changes/receipt-media-ingestion/**` without inspection or mutation.
- Keep writes single-threaded.
- Keep each implementation work unit reviewable and at or below 400 complete changed lines; split before crossing the limit.
- Use strict focused TDD for executable behavior.
- No live network/provider calls during tests.
- Never log or serialize provider credentials, bearer tokens, full addresses, or customer phone numbers.
- No push, deployment, provider-account mutation, or production configuration change without separate authorization.
- Every executable candidate receives independent verification and native review before local delivery.

## Tasks

- [x] **SQ-0 — Freeze scope and isolate the branch:** branch `feat/shipping-quotes-skydropx` from local real-number delivery commit `65ecd5a`, preserve the canonical launch order, record quote-only scope, prerequisites, non-goals, and guardrails.
- [ ] **SQ-1 — Implement shipping credit and package-domain rules:** add pure value types and strict tests for threshold exclusivity, summed credits, non-negative customer charge, money bounds, missing package data, and the explicit >25 kg balanced-split prerequisite without inventing dimensions.
- [ ] **SQ-2 — Add default-off shipping configuration and provider contract:** introduce typed configuration/Joi validation, conditional credential/origin requirements only when enabled, normalized request/rate/error contracts, and dependency tokens without wiring a live tool.
- [ ] **SQ-3 — Implement the Skydropx quote adapter:** add OAuth token caching, the current quotation request/polling flow, bounded retry/timeout behavior, response normalization, rate filtering, and secret-safe errors against mocked HTTP only.
- [ ] **SQ-4 — Build draft quote orchestration:** validate origin/destination/package inputs, call the provider, choose the best eligible rate deterministically, apply credit, persist bounded quote state/expiry, and return structured unavailable/handoff results.
- [ ] **SQ-5 — Add the disabled conversation and human-approval path:** register the tool only when enabled, update deterministic sale-flow instructions, activate `shipping_approval`, prevent customer-facing quote claims before approval, and block sale continuation where shipping cannot be persisted honestly.
- [ ] **SQ-6 — Add operations evidence:** add redacted telemetry/logging, offline preflight coverage, provider/setup runbook, sandbox smoke procedure, rollback, and explicit activation blockers.
- [ ] **SQ-7 — Reconcile and deliver locally:** run focused/full non-network checks, verify default-off behavior and secret redaction, reconcile scope, obtain native review, and create authorized local work-unit commits without push or deployment.

## Delivery gate

This foundation is locally complete only when SQ-1 through SQ-7 have observed evidence. It is production-ready only after every activation prerequisite is satisfied separately; completing code does not authorize or imply live shipping quotes.
