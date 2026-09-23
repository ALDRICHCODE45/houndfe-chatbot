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
- [x] **SQ-1A — Implement shipping credit rules:** add a pure value type and strict tests for threshold exclusivity (`unitPriceCents > 50_000`), summed credits, non-negative customer charge, money bounds, invalid input, and explicit overflow without floating money.
- [x] **SQ-1B — Implement package-readiness rules:** add a pure value type and strict tests for missing package data, quantity-weighted totals, the 25 kg boundary, minimum split count, and the explicit >25 kg balanced-split prerequisite without inventing dimensions.
- [x] **SQ-2A — Add default-off shipping-quote configuration:** typed `shippingQuotes` factory subtree plus conditional Joi validation (credentials/origin required only when enabled) with redacted secrets.
- [x] **SQ-2A-H — Harden the SQ-2A configuration contract:** make `SHIPPING_QUOTES_ENABLED` canonical case-sensitive (reject `TRUE`/`False`/`1`/padded), reject whitespace-only required strings, and trim accepted provider values consistently in Joi and the factory.
- [x] **SQ-2B1 — Add provider-neutral shipping-quote request contracts:** immutable address/parcel/request types, exact string normalization, plain-record guards, and a readonly nonempty parcel tuple.
- [x] **SQ-2B1-H — Harden sparse parcels handling:** reject sparse parcel arrays whose holes `Array.prototype.every` skips by visiting every index in an indexed loop.
- [x] **SQ-2B2A — Add shipping-quote result normalization:** immutable rate/quoted-result contracts plus the never-throwing `normalizeShippingQuoteQuotedResult` runtime boundary (plain-record only, exact key stripping, fresh objects, canonical ISO timestamps).
- [x] **SQ-2B2A-H — Harden result-normalization boundaries:** treat the snapshotted `rawRates.length` as untrusted (safe integer in 1..`MAX_RATE_COUNT` before indexing/looping) and explicitly validate minute/second/timezone-offset components, rejecting leap-second 60. Native advisories `R3-array-length-validation` and `R3-timestamp-boundary`.
- [x] **SQ-2B2B1 — Add the shipping-quote error normalizer:** `ShippingQuoteField`, the finite `ShippingQuoteError` union, and the never-throwing `normalizeShippingQuoteError` boundary.
- [x] **SQ-2B2B2 — Add the shipping-quote envelope and port:** `ShippingQuoteProviderResult`, the envelope normalizer, the `SHIPPING_QUOTE_PROVIDER` token, and the port interface.
- [x] **SQ-3A1 — Add the Skydropx OAuth token transport:** plain Nest-agnostic client with an injectable function transport, official `POST /api/v1/oauth/token` form-urlencoded request, fail-closed token/expires parsing with runtime clock validation, strict runtime status validation, standard AbortError timeout handling, bounded retry (max 2 attempts) for 429/5xx/network only, secret-safe finite result union, mocked HTTP only; `getToken()` acquires a fresh token on every call.
- [x] **SQ-3A2 — Add the Skydropx OAuth token cache:** in-memory token cache reuse, expiry-skew refresh with an injectable clock, publish-before-transport single-flight, and epoch-guarded token-aware invalidation.
- [x] **SQ-3B1 — Add the Skydropx quotation-creation core:** plain Nest-agnostic client with a typed provider-wire V1 body, a structural `getToken` dependency, JSON bearer `POST /api/v1/quotations` over the shared injectable HTTP seam, bounded timeout, strict 201 parsing, finite status/abort mapping, RFC 6750 bearer validation, no retries, and a finite no-leak result; mocked HTTP only.
- [x] **SQ-3B2 — Add one-time 401 recovery:** on the first 401 only, await `invalidate(exactToken)`, obtain a token once more, and replay the identical POST payload exactly once; a second 401 returns `auth_failed`; finite refresh-token errors pass through; no refresh on 403 or ambiguous POST outcomes; hostile synchronous or Promise-returning seams fail closed.
- [x] **SQ-3B3a — Add the Skydropx quotation polling core:** bounded GET polling over the shared injectable HTTP seam with exported 5-attempt/1000ms cadence constants, an injectable no-real-timer sleep seam, path-safe id validation, strict 1..60,000ms runtime timeout, finite terminal status/network/timeout mapping, and a bounded shallow `providerRates` snapshot; always performs at least one GET even when create reported completion. B3b adds one-time GET 401 recovery.
- [x] **SQ-3B3b — Add one-time polling 401 recovery:** on the first definite GET 401 only, await invalidation of the exact token, obtain one refreshed token, and replay the identical captured URL/id/timeout GET exactly once in the same poll attempt; a later 401 fails auth without another refresh.
- [x] **SQ-3C1 — Rate-element mapper:** pure, never-throwing `mapSkydropxRate(raw)` maps one shallow current Skydropx `/api/v1` rate element into `ShippingQuoteRate | null` using `total`, exact MXN decimal-to-cents conversion, adjacent-cent uniqueness for numeric JSON values, strict field guards, one-read snapshots, and secret-safe fresh output.
- [x] **SQ-3C2 — Quotation filter/envelope mapper:** filter invalid provider rates and build provider-neutral quotation results/delegated envelopes from mapped rates and finite errors.
- [x] **SQ-3C3 — Request-to-wire mapper:** convert the provider-neutral shipping request into the Skydropx V1 wire payload. Sandbox UI evidence confirms dimensions in centimeters and weight in kilograms, so C3 maps `weightGrams/1000` and passes dimensions through; current official `POST /api/v1/quotations` V1 docs omit unit/package fields (`mass_unit`, `dimension_unit`, `package`/`package_type`), so the emitted wire body is addresses plus parcels only.
- [x] **SQ-3C4 — Provider adapter:** implement `ShippingQuoteProviderPort` over token/creation/poll/mapping and return `no_rates` when no rate survives filtering.
- [x] **SQ-3D — Add default-off module wiring:** register the provider/adapter only when `shippingQuotes.enabled` is true.
- [x] **SQ-4 — Build draft quote orchestration:** validate origin/destination/package inputs, call the provider, choose the best eligible rate deterministically, apply credit, persist bounded quote state/expiry, and return structured unavailable/handoff results.
  - [x] **SQ-4A — Draft selection and credit:** pure deterministic best-rate selection and credit composition over the committed quote normalizer and credit rule; no provider, persistence, or customer-facing output.
  - [x] **SQ-4B — Exact request assembly:** build a bounded provider-neutral request only from exact MX addresses, readiness-approved items, and one explicit prepared parcel whose weight matches the cart.
  - [x] **SQ-4C — Provider-to-draft orchestration**
  - [x] **SQ-4D — Bounded draft persistence:** persist one validated internal quote draft in existing conversation JSONB with a 30-minute chatbot TTL, earlier provider-expiry cap, fail-closed reads, and explicit clear semantics; no migration or customer visibility.
    - [x] **SQ-4D1 — Bounded record construction:** normalize the full safe draft, enforce financial identities, and cap a versioned record to the 30-minute or earlier provider expiry without I/O.
    - [x] **SQ-4D2 — Conversation lifecycle:** read/expire, persist, and clear the validated record through the existing ConversationStore while preserving sibling state.
- [ ] **SQ-5 — Add the disabled conversation and human-approval path (IN PROGRESS):** register the tool only when enabled, update deterministic sale-flow instructions, activate `shipping_approval`, prevent customer-facing quote claims before approval, and block sale continuation where shipping cannot be persisted honestly.
  - [x] **SQ-5A — Enabled-only application wiring:** expose one `ShippingQuoteOrchestrator` only inside the exact enabled module graph and inject it optionally into the existing tool registry without changing the tool inventory.
  - [x] **SQ-5B — Internal quote tool:** register only when the orchestrator exists, reuse fresh drafts, persist bounded new drafts, and return no customer-visible price or provider detail to the model.
    - [x] **SQ-5B1 — Measured demo profile:** normalize one exact versioned real measured item/parcel profile and match it only to the identical bounded cart; fail closed everywhere else.
    - [x] **SQ-5B2 — Price-stripped quote tool:** resolve origin, stored customer destination, cart, and measured profile server-side; reuse fresh drafts, quote once, persist internally, and expose only finite non-price outcomes to the model.
      - [x] **SQ-5B2A — Private measured-profile configuration:** parse one optional private JSON profile and exact origin into safe normalized server-owned inputs only inside the enabled module graph.
      - [x] **SQ-5B2B — Tool execution and registration:** derive strict Mexican phone identity, resolve stored cart/address, reuse or create one internal draft, and expose no monetary, carrier, address, or provider detail to the model.
        - [x] **SQ-5B2B1 — Strict Mexican sender identity:** accept only Meta digit-only `52` plus ten digits or legacy `521` plus ten digits, returning backend country code `52` and the exact ten-digit phone.
        - [x] **SQ-5B2B2 — Price-stripped tool core:** resolve state, fresh draft, measured cart, stored customer address, quote, and persistence with one server-owned clock and finite non-price results.
        - [x] **SQ-5B2B3 — Enabled-only registration:** expose the tool only when orchestrator and measured config exist, add exact AI SDK runtime context, and preserve the disabled twelve-tool inventory.
  - [x] **SQ-5C — Structured shipping approval:** activate a bounded redacted `shipping_approval` request and pin approval to an unexpired internal draft; no arbitrary approval text or address/secret exposure.
    - [x] **SQ-5C1 — Redacted approval contract:** define the exact safe digest and strict approve/reject parser from one unexpired draft; expose only net charge, total credit, carrier/service, ETA, and the draft-created pin.
    - [x] **SQ-5C2 — Draft-pinned human resolution:** render the bounded ops request, accept only exact structured decisions, revalidate the pinned draft at resolution time, and persist a machine-readable local approval/rejection without exposing the amount to the customer/model.
      - [x] **SQ-5C2a — Approval-policy port and pin verifier:** define the acyclic human-handoff policy port and a pure shipping adapter that parses C1 decisions and validates the exact current unexpired draft-created pin. Commits: `7260846`, tracker `cf51df0`. Review: `review-70b5ffc5f7898f46` (approved).
      - [x] **SQ-5C2b — Local resolution and marker contracts:** add standalone structured approve/reject/expired contracts plus the bounded conversation marker and fail-closed read/set/clear lifecycle. Commit: `0cfa08d`. Review: `review-151e0025c57fbb7c` (approved after bounded `R3-clear-data-loss` correction).
      - [x] **SQ-5C2c — Human-handoff service integration:** render the redacted ops digest, keep malformed commands pending, terminally reject stale drafts, persist valid local decisions, clear pending state, and emit amount-free synthetic continuation.
        - [x] **SQ-5C2c1 — Resolution activation and ops rendering:** activate the structured resolution union with exhaustive amount-free formatter cases and render the exact redacted shipping request/decision grammar. Commit: `7590373`; review: `review-fb32184ccc9ae44f` (approved).
        - [x] **SQ-5C2c2 — Resolution lifecycle and policy wiring:** inject the approval policy, handle malformed/stale/valid decisions in safe persistence order, and bind the pure adapter so every committed tree remains green.
          - [x] **SQ-5C2c2a — Policy composition:** bind the pure adapter and inject the domain port, retaining all current behavior and proving the full Nest module graph composes. Commit: `10a6349`; review: `review-d76c07b8203b0ec2` (approved).
          - [x] **SQ-5C2c2b — Safe reply lifecycle:** split the 796-line green candidate into independently build-green, ≤390-line work units without dropping strict TDD coverage:
            - [x] **SQ-5C2c2b1 — Authorization, identity, and grammar:** fail closed on invalid agent/status/digest/ref and malformed commands; retain a no-write fallback until later units. Commit: `6834ccf`; review: `review-f1afd4fd39d76c9d` (approved). Independent focused tests 47/47; spec typecheck retains unrelated diagnostics.
            - [x] **SQ-5C2c2b2 — Stale-draft expiry:** verify the fresh draft pin; resolve stale requests without a decision marker or customer synthetic turn. Commit: `2a95365`; review: `review-40e58445838c6722` (approved; informational `R3-001` about pending-clear failure, tracked under b4). Focused tests 57/57; spec typecheck retains 86 unrelated diagnostics.
            - [x] **SQ-5C2c2b3 — Valid decision lifecycle:** write marker before row resolution, clear pending using post-marker state, and compensate failed row resolution. Commit: `7bb2174`; review: `review-bf7dbfdd156432ae` (approved; informational `R3-001` on partial-state recovery remains b4). Focused tests 65/65; spec typecheck retains 86 unrelated diagnostics.
            - [x] **SQ-5C2c2b4 — Guarded retry recovery:** operator chose bounded, idempotent retry; never invent approval, release only against the current valid draft pin, and do not claim cross-store atomicity.
              - [x] **b4a — Row compare-and-set:** resolve only pending handoff rows so concurrent replies cannot overwrite a durable decision. Commit: `5a8542e`; review: `review-397e1db383a836ea` (approved/ack).
              - [x] **b4b — Conditional pending clear:** request-ID-matched pending clear preserves sibling conversation keys; a losing or failed shipping clear emits no synthetic turn. b4c still owns resolved-row retry recovery.
                - [x] **b4b1 — Port and adapters:** added `clearPendingHumanRequest` to the `ConversationStore` port plus the Postgres (single conditional `jsonb_set`-null `UPDATE`) and in-memory adapters, with focused specs and compile-only mock methods. Commit: `d713d8f`; review: `review-6fb79a950e7f48e2` (approved/acknowledged). Focused 38 passed/9 Docker skipped; broader 274 passed/20 skipped; build typecheck clean; historical spec diagnostics 86 unrelated.
                - [x] **b4b2 — Service rewire:** valid and stale shipping resolution call the request-ID-matched primitive; only `true` permits continuation. `false` or rejection fails closed as `ops_error`, with no synthetic turn. Generic non-shipping helper is unchanged; b4c still owns resolved-row recovery. Review: `review-762fb6324edeb9e2` (approved/acknowledged). Strict RED: 10 failed/57 passed; GREEN: 67 passed. Independent verification: 105 passed/9 Docker skipped; lint, format, build typecheck, and diff checks passed. Implementation commit: `5d9a366db00f36b7d69f1eac97eb335d7566f521`; bounded writer route (multi-file), independently verified before commit.
              - [x] **b4c — Resolved-row completion:** require exact ref/assigned agent; verify persisted decision and marker alignment plus fresh draft validity, finish pending clear once, otherwise re-quote/fail closed without replaying approval. Split to preserve independently green, reviewable work units.
                - [x] **b4c1 — Expired-row recovery:** exact ref/agent, resolved status, pinned finite reason and matching pending marker; malformed same-request approval state, failed get/clear, or losing clear fail closed. Winning clear requests re-quotation without synthetic; approved/rejected rows stay closed until b4c2. Strict RED 2/89 then GREEN 89/89; correction RED 3/92 then GREEN 92/92. Independent PASS: 130 passed/9 Docker skipped, scoped lint/format/build/diff clean. Native review `review-6517a932dbbbfbdb` approved/acknowledged (informational `R3-001`); implementation commit `e17ca88ea6a4747e344e370758dc1afb4c49ff63`. Bounded writer and independent verifier route.
                - [x] **b4c2 — Decided-row recovery:** verify the persisted approved/rejected decision against the local marker and current unexpired draft pin; only the winner of the conditional pending clear emits the durable amount-free synthetic decision. Invalid or expired draft must not replay approval. The initial combined 451-line green candidate exceeds the agreed ≤390-line unit, so split before delivery.
                  - [x] **b4c2a — Rejected-row recovery:** strict persisted rejection, aligned marker, current draft and winning pending clear permit only the amount-free rejection synthetic; expired draft re-quotes without synthetic, and approved rows remain closed. Initial combined RED 6/123 then GREEN 123; rejected-only RED 1/119, GREEN 118/118. Independent PASS: 156 passed/9 Docker skipped, lint/format/build/diff clean. Native review `review-7b5838b7ebb43d8a` approved/acknowledged; implementation commit `6f0f666c15f29c3185f780c96694441b22a44e69`. Bounded writer and independent verifier route.
                  - [x] **b4c2b — Approved-row recovery:** strict persisted approval reuses b4c2a's aligned-marker/current-pin guards; only a winning pending clear emits amount-free approval, while expired drafts re-quote and invalid/losing paths emit no synthetic. Strict RED 4 failed/139 passed then GREEN 143 passed. Independent PASS: 181 passed/9 Docker skipped; lint/format/build/diff clean. Native review `review-a1ba397a524aaf63` approved/acknowledged; implementation commit `cd8ba10463fb2cb88b73134a6bea0e977f6574af`. Bounded writer and independent verifier route.
      - [x] **SQ-5C2d — Dispatcher outcome integration:** offline dispatcher tests prove `needs_decision`, `needs_requote`, and `ops_error` route data-free replies only to ops (no customer synthetic/runner call), while existing `resolved` coverage remains green. Characterization-only GREEN 69/69; no RED because behavior pre-existed. Independent PASS: 212/212, lint/format/build/diff clean. No production dispatcher/provider change. Native review `review-aac48bd585d83e2b` (four lenses) approved/acknowledged; implementation commit `c7fdee5cfc4d09dd6b579dfe791d6dabc39fc9dd`. Bounded writer and independent verifier route.
    - [x] **SQ-5C3 — Server-owned trigger and instructions:** create/reuse the shipping approval request from the enabled quote path, keep the model-facing handoff tool unable to forge `shipping_approval`, and update deterministic sale-flow guidance; expired drafts require re-quotation. Never reuse a different pending handoff ref as shipping approval; fail closed with a price-free result instead.
      - [x] **SQ-5C3a — Guarded trigger preparation:** pure, exact redacted digest only from a fresh draft with no non-null pending/prior decision marker; pending short-circuits approval reads. Strict RED missing module then GREEN 36; correction RED 1/37 then GREEN 37. Independent PASS 83/83, lint/format/build/diff clean. Native review `review-722a9ffe5604a765` approved/acknowledged; implementation commit `38a212b13744f06dc9f8115fa9060aa681bb7f0c`.
      - [x] **SQ-5C3b — Server-owned request lifecycle:** using a current stored draft and the C3a gate, invoke the handoff service and verify the returned row kind, exact digest/pin, sender, request ID, and current pending marker. A wrong-kind or racing ref is never accepted; results remain price-free. Split the readable 682-line green candidate instead of minifying or waiving the ≤390-line limit.
        - [x] **SQ-5C3b1 — Lifecycle with core tests:** self-contained core spec, server-owned create and exact row/digest/current-marker verification. Strict RED missing module then GREEN 20; correction RED 5/25→GREEN 25 and expiry/getter RED 1/3 plus RED 1/6→GREEN 27. Independent PASS core 3/3, combined 27/27, lint/format/build/diff clean. Review `review-890ea9f41f767362` approved/acknowledged; commit `efac0354463586beabd359ebd2e1d81c3ef9d630` (390 complete changed lines).
        - [x] **SQ-5C3b2 — Adversarial verification tests:** preserve remaining marker, digest drift, hostile seam, clock, and fail-closed coverage in independent ≤390-line characterization units; no production semantics change.
          - [x] **SQ-5C3b2a — Offline marker and digest coverage:** shared test fixture outside production build plus adversarial spec for marker, digest and clock rejection; GREEN-only characterization of committed behavior, 27/27 across three suites. Independent PASS: 27/27, lint/format/build/diff clean; 351 new lines. Review `review-bc6f278a23ca5766` approved/acknowledged (informational `R3-001`); commit `8302682b26b75d6b31a17146982e6d23c4a518b2`.
          - [x] **SQ-5C3b2b — Hostile getters and same-pin drift:** adversarial spec for throwing/stateful seams and post-create financial/rate drift, using b2a fixture. GREEN-only characterization of committed code (the getter test was RED 1/6 before b1 correction). Independent PASS 6/6 focused, 27/27 combined; lint/format/build/diff clean. Review `review-07a79cbf094e58f5` approved/acknowledged; commit `59415c987d3395bb2b82185419910a6008109b27`.
      - [x] **SQ-5C3c — Enabled-only tool and registry composition:** on fresh or reused quote call the C3b lifecycle; pass the existing handoff service and exported row-store port only to the conditional tool; preserve disabled twelve-tool inventory.
        - [x] **SQ-5C3c1 — Tool integration:** invokes optional server-owned lifecycle after fresh or newly persisted draft; absent/failing/hostile seam yields finite price-free handoff, exact own-key `{ok:true}` only means request created (not approved). Strict RED 9/39→GREEN 39, corrections RED 4/43 and 3/46→GREEN 46. Independent PASS 46/46, lint/format/build/diff clean. Review `review-caab4c655281d68b` approved/acknowledged (informational `R3-001`); commit `70a899ecfd50bf9c9ef4d9ee370dbdfab8dd2107`.
        - [x] **SQ-5C3c2 — Registry wiring:** exported handoff row store and existing service compose the C3b lifecycle only for enabled shipping; missing store fails closed, disabled inventory stays twelve and model cannot forge shipping_approval. Strict RED 2/18→GREEN 64/64; independent PASS 64/64, lint/format/build/diff clean. Review `review-d50105fa959dc23e` approved/acknowledged; commit `fcc4808b387085bf160c0b976fe6dac15952272b`.
      - [x] **SQ-5C3d — Deterministic sale-flow guidance:** update disabled-safe instructions for shipping approval, amount suppression, and re-quotation on expiry; preserve the model-facing handoff tool's no-forgery schema.
        - [x] **SQ-5C3d1 — Opt-in guidance fragment:** append shipping-only instructions behind a fail-closed availability flag; disabled prompt remains byte-identical, enabled guidance distinguishes approval request from decision and blocks shipping sale pending SQ-5D. Strict RED 4/25→GREEN 25; independent PASS 25/25, lint/format/build/diff clean. Review `review-f8dc248d7307a917` approved/acknowledged; commit `be83f6ee24e909f8a3eb8ce9ea1dd2da04bdfd21`.
        - [x] **SQ-5C3d2 — Boot-time availability binding:** prompt factory injects TOOL_REGISTRY and enables shipping guidance only for own registered `getShippingQuote`; missing/hostile/inherited tool keys fail closed and full default-off DI prompt is byte-identical even with hostile host env. Strict RED 1/31→GREEN 31; GREEN-only full-DI characterization. Independent PASS 49/49 and hostile-env 6/6; lint/format/build/diff clean. Review `review-1db9b6cff69948a9` approved/acknowledged; commit `04a28e72f00db7352be44eabe6dc120c5ea852aa`.
  - [ ] **SQ-5D — Honest sale-continuation gate (IN PROGRESS):** refuse sale continuation while shipping is unresolved or its approved charge cannot be persisted by the backend contract. Current backend `CreateSaleInput` has no shipping-charge field, so any state with a server-written non-null quote draft or approval marker must be denied before idempotency key minting or HTTP, including expired/rejected/approved markers. Do not infer quote intent from `shippingAddressId`: ordinary sales may carry a delivery address. A model that skips the quote tool leaves no marker; that limitation requires backend/API design and cannot be claimed closed by this gate. Shipping stays default-off.
    - [x] **SQ-5D1 — Pure marker gate:** fail closed on hostile conversation state; block on non-null `shippingQuoteDraft` or `shippingApproval`, including stale/expired/rejected/approved; pass absent/null/undefined markers. Strict RED missing module→GREEN 44/44; independent PASS 81/81, scoped lint/format/build/diff clean. This is only a pure decision; D2 owns createSale enforcement. Review `review-18ed0648f5e11572` approved/acknowledged; commit `22344af6aaeb8060b12b49ed22c01894eb682ca1`.
    - [ ] **SQ-5D2 — Enforce in createSale (IN PROGRESS):** fail closed on non-null server-written shipping markers before key/store/backend; preserve address-only sales and price-free results. Strict RED for descriptor/Get mismatch and stateful reread; combined candidate passed 100/100, but 387 tracked + 251 untracked fixture = 638 changed lines and cannot be delivered as one ≤390-line unit. PostgreSQL JSONB returns plain data; nested hostile Proxy is not universally detectable. Split into independently build-green, reviewable units without dropping tests:
      - [x] **SQ-5D2a — Pure gate snapshot contract:** descriptor/Get divergence rejects; pass carries the validated data bag. Direct Proxy characterization GREEN-only 47/47; independent scoped PASS, 218 changed lines. Commit `47d9896d2feaae4c7af883837e2a7cbfb0dd71de`; isolated native review `review-3937be24c67b3dba` approved/acknowledged (informational `R3-001`). Review worktree diff matched commit bytes; no claim of universal nested-Proxy detection.
      - [x] **SQ-5D2b — Shared offline fixture:** test-only 251-line harness/builders outside production `src`, no production behavior change. Independent PASS 101/101 with ambient D2c, lint/format/build clean; review `review-b2e63d5d6af12bc3` approved/acknowledged in isolated worktree; commit `c3e448ffc8e2299f64f191d31e1447666b9d8d09`. Fixture alone is unused at HEAD; no claim of independent fixture typecheck.
      - [ ] **SQ-5D2c — Sale enforcement (IN PROGRESS):** createSale consumes the gate snapshot through cart and persistence, finite deny on marker/malformed state, tool result kind and RED→GREEN tool regressions (~195 changed lines). Reverify and review each bounded unit; no live provider/DB claim.
- [ ] **SQ-6 — Add operations evidence:** add redacted telemetry/logging, offline preflight coverage, provider/setup runbook, sandbox smoke procedure, rollback, and explicit activation blockers.
- [ ] **SQ-7 — Reconcile and deliver locally:** run focused/full non-network checks, verify default-off behavior and secret redaction, reconcile scope, obtain native review, and create authorized local work-unit commits without push or deployment.

## SQ-1A evidence (independent `PASS`; native-approved as `review-41c3378e455daa89`; locally delivered in this work unit)

- Work unit: `shipping-credit` only — 220 complete changed lines (impl 100 + spec 120), within the 400-line guard.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache shipping/domain/shipping-credit.spec.ts` failed with `Cannot find module './shipping-credit'` (1 suite failed, 0 tests).
- Focused TDD GREEN: same command — 1 suite passed, 24 tests passed.
- Scoped ESLint: `pnpm exec eslint src/shipping/domain/shipping-credit.ts src/shipping/domain/shipping-credit.spec.ts` — exit 0.
- Prettier: `pnpm exec prettier --check src/shipping/domain/shipping-credit.ts src/shipping/domain/shipping-credit.spec.ts` — clean.
- Production typecheck: `pnpm exec tsc --noEmit -p tsconfig.build.json` — exit 0.
- `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Coverage: strict $500 boundary, quantity multiplication, summed credits, zero/full/partial/unused credit, invalid input with offending line index, and single-line plus accumulated credit overflow.
- SQ-1B was deliberately excluded from this candidate and delivered as the next bounded work unit.

## SQ-1B evidence (independent `PASS`; native-approved as `review-74dbca8698bbdad7`; locally delivered in this work unit)

- Work unit: `package-readiness` only — 316 complete changed lines (impl 148 + spec 168), within the 400-line guard.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache shipping/domain/package-readiness.spec.ts` failed with `Cannot find module './package-readiness'` (1 suite failed, 0 tests).
- Focused TDD GREEN: same command — 1 suite passed, 29 tests passed.
- Scoped ESLint: `pnpm exec eslint src/shipping/domain/package-readiness.ts src/shipping/domain/package-readiness.spec.ts` — exit 0.
- Prettier: `pnpm exec prettier --check src/shipping/domain/package-readiness.ts src/shipping/domain/package-readiness.spec.ts` — clean.
- Production typecheck: `pnpm exec tsc --noEmit -p tsconfig.build.json` — exit 0.
- `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Coverage: missing/null/absent weight and dimensions, invalid dimensions and quantity, quantity-weighted totals, exact/over 25 kg boundary, minimum split count `ceil(total/25_000)`, `manual_unresolved` with no parcel assignment, and line plus summed weight overflow; `unavailable` limited to item/variant ids and missing fields.
- Native advisory `R3-empty-cart` is non-blocking; SQ-4 orchestration must reject an empty cart before package assessment.

## SQ-2A evidence (independent `PASS`; native-approved as `review-aaa78df31906e21d`; locally delivered in this work unit)

- Work unit: `shipping-quotes-config` only — 387 complete candidate lines = 372 implementation/spec lines + 15 tracker lines, within the 400-line guard.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache config/env.validation.spec.ts config/configuration.spec.ts config/config.module.spec.ts` — 3 suites failed, 39 failed / 219 passed (missing `shippingQuotes`).
- Focused TDD GREEN: same command — 3 suites passed, 259 passed.
- TRIANGULATE: disabled absent/malformed/oversized provider values accepted; enabled valid accepted; every required field missing and empty; base URL HTTP/malformed reject, absent default applied; postal 4/6/non-digit reject and 5 accept; each origin text field empty/oversized reject and 100-char accept; credential sentinel absent from message/details/`String(error)`.
- Scoped ESLint over the five config files — exit 0; Prettier `--check` — clean; `pnpm exec tsc --noEmit -p tsconfig.build.json` — exit 0; `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Config behavior: `enabled` is exact `SHIPPING_QUOTES_ENABLED === 'true'`; `skydropx.baseUrl` defaults to exported `SKYDROPX_BASE_URL_DEFAULT` (`https://api-pro.skydropx.com`); remaining provider fields are raw optional env passthrough.
- Native advisories `R3-boolean-contract-mismatch` and `R3-whitespace-required-values` are non-blocking and tracked for a separate bounded hardening work unit before adapter wiring.

## SQ-2A-H evidence (independent `PASS_WITH_WARNINGS`; wording corrected; native-approved as `review-111bbc7c8a4f9b74`; locally delivered in this work unit)

- Work unit: `shipping-quotes-config-hardening` only — 123 complete candidate lines = 55 implementation + 57 spec + 11 tracker, within the 220-line guard.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache config/env.validation.spec.ts config/configuration.spec.ts` — 2 suites failed, 10 failed / 255 passed (case-insensitive flag; untrimmed and whitespace-only strings).
- Focused TDD GREEN: same command — 2 suites passed, 265 passed.
- TRIANGULATE: flag rejects `TRUE`, `False`, `1`, `0`, `yes`, and padded `' true '`, accepts canonical `true`/`false`, defaults false; enabled credential/origin/postal reject whitespace-only and trim accepted surrounding whitespace; factory polarity stays exact `=== 'true'` and trims provider values; disabled permissiveness unchanged.
- Joi API: `Joi.boolean().sensitive(true).truthy('true').falsy('false')` plus an `original`-value guard rejecting padded spellings; validated output stays boolean with a false default.
- Scoped ESLint over the four TypeScript config paths — exit 0; Prettier `--check` covered those paths plus this tracker; `pnpm exec tsc --noEmit -p tsconfig.build.json` — exit 0; `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Independent verification passed all behavior and checks; its tracker-wording warning was corrected before the clean native approval.

## SQ-2B — rejected and replaced by SQ-2B1 + SQ-2B2

The combined SQ-2B candidate (`shipping-quote.port.ts` + `shipping-quote.port.spec.ts`, 399 complete lines) failed independent verification as `NEEDS_CORRECTION` and was **not delivered**: quoted results allowed invalid/empty success, error secret safety and numeric bounds were not enforced at a runtime boundary, and the forced-cast `assertNever` test was weak. Both candidates were deleted from the worktree and the slice was split.

## SQ-2B1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-48aff6a5554ca6df`; locally delivered in this work unit)

- Work unit: `shipping-quote.request` only — 104 implementation + 153 spec = 257 complete source lines, plus these tracker lines, within the 300-line guard.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache shipping/domain/shipping-quote.request.spec.ts` failed with `Cannot find module './shipping-quote.request'` (1 suite failed, 0 tests).
- Focused TDD GREEN: same command — 1 suite passed, 40 tests passed.
- Scoped ESLint and Prettier `--check` over both files exit 0; `tsc --noEmit -p tsconfig.build.json` exit 0; spec typecheck `tsc -p tsconfig.spec.json` reports no `shipping-quote` diagnostics (repo-wide spec baseline has unrelated pre-existing errors); `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset; old `shipping-quote.port.*` candidates absent.
- Coverage: exact canonical strings (rejects leading/trailing whitespace plus padded/3-letter/lowercase country), postal <=12 and admin <=100 boundaries, per-field parcel matrix (0/negative/fraction/NaN/Infinity/MAX_SAFE+1/wrong type with 1 and MAX_SAFE accepted), nonempty tuple typing via `satisfies`, empty/missing/non-array/invalid parcels, invalid origin/destination, plain-record-only rejection of array/function/class/null, and frozen no-mutation.
- Boundary scope: SQ-2B1 intentionally contains no result/rate/error/port/token; SQ-2B2 owns those with required runtime boundary validation and normalization.
- Native advisory `R3-sparse-parcels` is non-blocking and assigned to a separate bounded hardening before SQ-2B2.

## SQ-2B1-H evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-fd3ace8187628253`; locally delivered in this work unit)

- Work unit: `shipping-quote.request` sparse-parcels hardening only — 1 implementation hunk + 1 spec case + these tracker lines, within the 80-line guard.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache shipping/domain/shipping-quote.request.spec.ts` — the new sparse case failed: a length-2 array with a hole and a length-1 hole-only array were both accepted because `Array.prototype.every` skips holes (1 failed / 40 passed).
- Focused TDD GREEN: same command — 1 suite passed, 41 tests passed; request validation now visits every index with a small indexed loop, so holes are validated as `undefined` and rejected.
- Scoped ESLint and Prettier `--check` over both files exit 0; `tsc --noEmit -p tsconfig.build.json` exit 0; spec diagnostic scope `tsc -p tsconfig.spec.json` reports no `shipping-quote` diagnostics; `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Nonempty tuple type, exact-string normalization, other guards, and no-mutation behavior are unchanged. Native advisory `R3-live-array-length` is non-blocking and assigned to SQ-2B2's runtime-boundary work.

## SQ-2B2A evidence (independent `PASS`; native-approved as `review-a925facd828e45c8`; locally delivered in this work unit)

- Work unit: `shipping-quote.result` only — 124 implementation + 222 spec = 346 source lines, plus this tracker block; additions+deletions churn 358, within the 360 hard stop. Scope is result normalization only; SQ-2B2B owns the error union, `SHIPPING_QUOTE_PROVIDER` token, and port.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache shipping/domain/shipping-quote.result.spec.ts` failed with `Cannot find module './shipping-quote.result'` (1 suite failed, 0 tests); GREEN: same command — 1 suite passed, 20 tests passed. Fix round 1 corrected strict timestamp validation and getter/proxy TOCTOU snapshotting.
- Scoped ESLint exit 0; Prettier `--check` clean; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc -p tsconfig.spec.json` reports no `shipping-quote` diagnostics (repo-wide spec baseline has unrelated pre-existing errors); `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Coverage: nonblank/no-padding 128-max rate strings, 100/101 rate-count boundary, nonnegative safe `priceCents`, nullable ETA (0 same-day), `MXN`, only zoned ISO date-times canonicalized (date-only, zone-less, locale, and rollover `2026-02-30` rejected), empty/sparse/oversized/non-array rates, non-plain/class/array/primitive/throwing-getter/proxy rejection, one-read field snapshots blocking stateful-getter secret injection, extra-key stripping with a sentinel secret, fresh result/rate objects, frozen no-mutation, and live-length snapshot bounding.
- Native advisories `R3-array-length-validation` and `R3-timestamp-boundary` are addressed by the delivered SQ-2B2A-H work below.

## SQ-2B2A-H evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-47538c5b7e43525c`; locally delivered in this work unit)

- Hardening scope: treat the snapshotted `rawRates.length` as untrusted (require a safe integer in 1..`MAX_RATE_COUNT` before indexing/looping) and explicitly validate minute 0..59, second 0..59, offset hour 0..23, and offset minute 0..59 alongside month/day/hour.
- Focused TDD RED: array-length Proxy traps returning `NaN`/negative previously produced a normalized result (1 failed / 20 passed); GREEN after the fix: 1 suite passed, 21 tests passed. The timestamp-component cases are GREEN-only defense-in-depth because V8 already returns `Invalid Date` for them, so no independent RED was observable; leap-second `60` is rejected deliberately.
- Scoped ESLint exit 0; Prettier `--check` clean; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc -p tsconfig.spec.json` reports no `shipping-quote` diagnostics; `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Incremental churn `git diff --numstat`: impl +27/-5, spec +31/-0, tracker +9/-1 = 67 additions / 6 deletions (73 total), within the 120-line hard stop. Valid `Z`, positive, and negative offsets still canonicalize; date-only, zone-less, locale, and rollover inputs remain rejected.

## SQ-2B2B split — combined attempt over budget and not delivered

- The combined SQ-2B2B candidate (`shipping-quote.port.ts` 117 + `shipping-quote.port.spec.ts` 348 = 465 source lines; 473 complete changed lines with the tracker) passed focused Jest 40/40, scoped ESLint/Prettier, build `tsc`, and spec diagnostics but exceeded the 400-line hard stop, so both files were deleted and the slice was split into SQ-2B2B1 (error normalizer) and SQ-2B2B2 (envelope/token/port).
- **SQ-2B2B1 evidence** (independent `PASS`; native-approved as `review-bbd9aa13826db118`; locally delivered in this work unit): `shipping-quote.error` only — 92 implementation + 251 spec = 343 source lines and 14 tracker lines = 357 complete changed lines, within the 360-line guard; no quoted-result/provider-result/envelope/token/port/request surface. RED: `pnpm exec jest --runInBand --no-cache shipping/domain/shipping-quote.error.spec.ts` failed with `Cannot find module './shipping-quote.error'` (1 suite failed, 0 tests); GREEN: same command — 1 suite passed, 48 tests passed.
- Scoped ESLint exit 0; Prettier `--check` clean; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc -p tsconfig.spec.json` reports no `shipping-quote.error` diagnostics; `git diff --check` clean; nothing staged; `DATABASE_URL`/`RUN_DOCKER_TESTS`/`RECEIPT_MEDIA_INGESTION_ENABLED` unset; old `shipping-quote.port.*` absent.
- Coverage: every kind with exact fresh reconstruction and key sets; sentinel `token`/`body`/`payload`/`address`/`message`/`providerCode` stripping; field matrix (four explicit fields kept, anything else fails closed); retry/status matrices (explicit null/bounds kept, negative/fraction/NaN/Infinity/unsafe/wrong type/missing fail closed); primitives/array/class/throwing-getter/getPrototypeOf-proxy/one-read stateful getters; frozen no-mutation; compile-time exhaustiveness (`assertNever`) with normal fixtures.
- Correction after independent verification: invalid/missing/wrong-type `invalid_request.field`, `rate_limited.retryAfterSeconds`, and `upstream_unavailable.httpStatus` now return `{kind:'malformed_response'}`; explicit `'unknown'` and explicit null stay valid.
- Status: `SQ-2B2B1` is delivered; `SQ-2B2B2` remains pending.

## SQ-2B2B2 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-33da16501e43a0c9`; locally delivered in this work unit)

- Work unit: `shipping-quote.port` only — 63 implementation + 250 spec = 313 source lines plus this tracker block, within the 330-line hard stop. Scope is envelope/token/port only; SQ-4 unavailable/handoff stays out.
- Focused TDD RED: `pnpm exec jest --runInBand --no-cache shipping/domain/shipping-quote.port.spec.ts` failed with `Cannot find module './shipping-quote.port'` (1 suite failed, 0 tests); GREEN: same command — 1 suite passed, 17 tests passed. An earlier longer draft of the spec passed 27 tests; it was compressed for the line budget without dropping any case.
- Scoped ESLint exit 0; Prettier `--check` clean; `tsc --noEmit -p tsconfig.build.json` exit 0; `tsc -p tsconfig.spec.json` reports no `shipping-quote.port` diagnostics (repo-wide spec baseline has unrelated pre-existing errors); `git diff --check` clean; nothing staged; `DATABASE_URL`, `RUN_DOCKER_TESTS`, `RECEIPT_MEDIA_INGESTION_ENABLED` unset.
- Coverage: valid quoted delegation (timestamp canonicalization, fresh objects, extra/sentinel stripping), malformed quoted closed, every nested error kind reconstructed exactly including structured `invalid_request.field` and numeric `rate_limited`/`upstream_unavailable`, malformed nested errors to `malformed_response`, envelope extras and sentinel keys stripped at both levels with no sentinel in serialized output, primitives/array/class/wrong kind/throwing `get`+`getPrototypeOf`/stateful kind/error getters never throw or leak, one-read top-level kind plus nested error/envelope snapshot, quoted re-read fail-closed, frozen no-mutation and fresh envelopes, `assertNever` exhaustiveness over the union, unique non-registered token, and an offline fake `ShippingQuoteProviderPort` driven by a valid `ShippingQuoteRequest` with no network.
- Status: `SQ-2B2B2` is delivered. Native suggestion `R3-nested-error-detachment` is non-blocking test hardening for later maintenance.

## SQ-3A1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-6294f31cf53ec101`; locally delivered in commit `a4cdaf2`)

- Work unit: OAuth transport/parsing/retry only — 176 implementation + 218 spec + 6 tracker churn = 400 complete changed lines. Cache reuse, expiry skew, single-flight, and token-aware invalidation remain explicitly deferred to SQ-3A2.
- Focused RED: missing implementation; correction REDs then exposed unsafe runtime status coercion, AbortError retry, throwing/malformed clocks, and Axios default non-2xx rejection. Final GREEN: 1 suite passed, 8 tests passed with injected/mocked HTTP only.
- Behavior: official form-urlencoded client-credentials request; bounded timeout and two attempts; 400/401/403 no retry; 429/Retry-After, 5xx, network, timeout, abort, malformed payload/status, overflow, and secret-safe failures mapped into the finite provider-neutral union.
- Hardening: runtime status requires a safe integer in 100..599; runtime clock values are guarded; hostile status/error getters cannot escape; default Axios transport forces `validateStatus: () => true` so the mapper receives non-2xx responses.
- Scoped ESLint, Prettier, production typecheck, focused Jest, scoped spec diagnostics, and `git diff --check` passed; repository-wide spec typecheck retains unrelated pre-existing diagnostics.
- Independent warnings (`ETIMEDOUT`, exact 599/600, sequential fresh acquisition, and combined clock-plus-expiry overflow tests) and native advisory `R3-token-control-characters` are non-blocking future hardening; no correction is open.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3A2 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-1d89f6fb49b1e9be`; locally delivered in commit `eea9f73`)

- Work unit: cache/single-flight/invalidation only — 337 complete changed lines after race corrections, within the 400-line guard.
- Focused TDD: initial A2 RED had 7 failures / 11 passes; correction RED had 2 failures / 18 passes for synchronous transport reentrancy and invalidation during refresh. Final GREEN: 20/20 focused tests and 200/200 shipping tests.
- Behavior: successful tokens cache only validated token/expiry metadata; a 30-second skew refreshes at the exact boundary; lifetimes at or below the skew are never reused; errors are never cached; cache hits perform no HTTP or sleep.
- Concurrency: the in-flight promise is published before injectable transport execution, so synchronous reentrancy shares one acquisition/retry sequence; guarded clearing prevents an older flight from clearing a newer one.
- Invalidation: only the exact cached token clears; a generation epoch prevents an active refresh from repopulating cache after matching invalidation; an older token cannot clear a newer cache.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped spec diagnostics, and `git diff --check` passed. Clock rollback remains a non-blocking warning; repository-wide spec typecheck retains unrelated diagnostics.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3B1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-0c21145eb5e46ebc`; locally delivered in commit `03a36b6`)

- Work unit: quotation creation core only — 391 complete changed lines after the bearer-boundary correction, within the 400-line guard. One-time 401 recovery and GET polling remain SQ-3B2/SQ-3B3.
- Focused TDD RED: missing module. Bearer hardening RED then proved padded/header-injection tokens reached HTTP before correction. Final GREEN: 5/5 focused tests and 205/205 shipping tests.
- Behavior: typed V1 wire body, JSON bearer POST, bounded timeout, exact 201, bounded plain `id`, boolean `is_completed`, strict runtime status mapping, no retries or raw response/error retention.
- Security: the consumption boundary accepts only bounded RFC 6750 `b64token` characters with trailing padding; whitespace, controls, CRLF, non-ASCII, and misplaced padding fail before HTTP. Results never serialize token, payload/address, provider body, or thrown text.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped spec diagnostics, and `git diff --check` passed. Native advisory `R3-timeout-bounds` and independent boundary-test suggestions are non-blocking future hardening.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3B2 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-040a2fc8b2ce9db2`; locally delivered in commit `c98fce8`)

- Work unit: one-time 401 recovery only — 223 complete changed lines after the async-invalidation correction, within the 400-line guard. GET polling remains SQ-3B3.
- Focused TDD RED: 6 failures / 5 passes against B1. Correction RED then proved a rejected/deferred Promise invalidation escaped or allowed replay before settling. Final GREEN: 14/14 focused tests and 214/214 shipping tests.
- Recovery: only a definite first 401 invalidates the exact token, obtains one refreshed token, and replays the identical payload reference once. A second 401 or either-stage 403 returns `auth_failed` without further attempts.
- Safety: invalidation is assimilated and awaited before refresh; synchronous throws, rejected Promises, hostile getters, malformed refreshed tokens, and refresh failures produce finite no-leak results without unsafe replay. Network, timeout, abort, rate limit, 5xx, malformed, 400, and 422 outcomes are never replayed.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped spec diagnostics, and `git diff --check` passed. Repository-wide spec typecheck retains unrelated diagnostics; a never-settling hostile invalidation can wait indefinitely but cannot replay.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3B3a evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-18a1b639fbd47ce8`; locally delivered in commit `da8057e`)

- Work unit: bounded GET polling core only — 399 complete changed lines after timeout-bound correction, within the 400-line guard. GET 401 recovery remains SQ-3B3b.
- Focused TDD RED: 10 failures / 14 passes against B2. Correction RED proved `timeoutMs: 0` disabled Axios timeout and returned success. Final GREEN: 25/25 focused tests and 225/225 shipping tests.
- Polling: strict path-safe IDs, at least one and at most five GETs, fixed 1000ms cadence only after valid incomplete responses, no final sleep, and deterministic timeout on exhaustion. Sleep failures stop requests instead of creating an unpaced burst.
- Boundary: runtime timeout is read once and must be a primitive safe integer in 1..60,000ms before token/HTTP/sleep. Terminal responses map to finite errors; successful completion exports only the ID and a frozen dense 0..100 shallow rates snapshot for immediate SQ-3C normalization.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped spec diagnostics, and `git diff --check` passed. Raw rate elements remain an intentional internal trust boundary and must not be logged, serialized, or persisted before SQ-3C; a never-settling injected sleeper remains a non-blocking seam warning.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3B3b evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-f75ccfb4fc472aff`; locally delivered in commit `bde7a41`)

- Work unit: one-time GET 401 recovery only — 253 complete changed lines, within the 400-line guard.
- Focused TDD RED: 8 failures / 27 passes against B3a. Final GREEN: 35/35 focused tests and 235/235 shipping tests.
- Recovery: one definite 401 invalidates the exact token, obtains one replacement, and replays the exact captured URL, quotation ID, validated timeout, and refreshed bearer header once in the same poll attempt. Total GETs remain bounded at normal attempts plus one.
- Safety: shared awaited invalidation preserves POST B2 behavior; synchronous throws, rejected/deferred Promises, hostile token seams, and refresh failures produce finite no-leak results without unsafe replay. A second/later 401 or either-stage 403 returns `auth_failed`; non-401 outcomes never recover.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped spec diagnostics, `git diff --check`, and a separate emitted-artifact incident check passed. A never-settling invalidation may wait indefinitely but cannot replay or leak; repository-wide spec typecheck retains unrelated diagnostics.
- No generated `.js`/`.js.map` files remain under `src`; diagnostic spec checks must use `tsc --noEmit -p tsconfig.spec.json`.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3C1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-c899037f588b96d7`; locally delivered in commit `37e0a1c`)

- Work unit: one-rate trust-boundary mapper only — exactly 400 complete changed lines after monetary precision corrections, within the review guard.
- Focused TDD RED: missing mapper module. Correction RED then proved numeric negative zero and adjacent-cent-collapsing large doubles were accepted. Final GREEN: 23/23 focused tests and 258/258 shipping tests.
- Current API mapping: require `success === true`, exact `currency_code: MXN`, bounded `id`, `provider_display_name`, `provider_service_name`, and nonnegative safe-integer `days`; use documented `total`, ignore `amount`/fees/protection, and leave validity null because no expiry timestamp exists.
- Money safety: canonical decimal strings support the full safe-cent boundary through BigInt; numeric examples are accepted only when the exact cent and adjacent cents map uniquely, with no float multiplication, coercion, exponent strings, arbitrary price cap, or negative zero.
- Boundary safety: plain records only, every provider field read once, hostile getters/proxies fail closed, and successful output is fresh, frozen, exact-key, and strips every arbitrary/sensitive provider field. Missing/null `days` remains a deliberate fail-closed warning despite nullable provider-neutral ETA.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped `tsc --noEmit` diagnostics, and `git diff --check` passed; repository-wide spec diagnostics remain unrelated.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3C2 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-2881b8c133a5889f`; locally delivered in commit `dbad71d`)

- Work unit: quotation trust-boundary mapper plus a provider-neutral quote-ID normalizer export — 395 complete changed lines, within the review guard.
- Focused TDD RED: missing mapper module. Correction RED then proved invalid quotation IDs were masked as `no_rates` when no rate survived. Final GREEN: 23/23 mapper tests, 21/21 quote-result tests, and 281/281 shipping tests.
- Boundary safety: validate the quote ID independently through the shared provider-neutral rule; accept only dense plain arrays with a snapshotted safe length of 0–100; read every provider element once; hostile containers fail as `malformed_response`.
- Filtering semantics: malformed, failed, and non-MXN elements are discarded through SQ-3C1 while valid elements retain order and duplicates; empty or all-invalid valid envelopes return exact `no_rates`.
- Output safety: successful quotations are rebuilt through the provider-neutral normalizer with exact keys, fresh deep snapshots, and `expiresAt: null`; no raw provider element, arbitrary key, sensitive sentinel, or fabricated 24-hour timestamp escapes.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped `tsc --noEmit` diagnostics, emitted-artifact checks, and `git diff --check` passed; repository-wide spec diagnostics remain unrelated.
- No provider/network call, credential access, push, deployment, or production configuration change occurred.

## SQ-3C3 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-2338a5bff679b639`; locally delivered in commit `273c0b6`)

- Work unit: provider-neutral request trust-boundary snapshot and Skydropx V1 wire mapping — 397 complete changed lines, within the review guard.
- Focused TDD RED: missing mapper module. Final GREEN: 7/7 mapper tests and 288/288 shipping tests.
- Unit evidence: the official sandbox UI explicitly labels parcel dimensions as centimeters and weight as kilograms; C3 passes integer centimeter dimensions unchanged and divides integer grams by 1000 without rounding, stringification, or clamping.
- Wire evidence: current official V1 quotation docs require address `country_code`, `postal_code`, `area_level1/2/3` plus parcel `length`, `width`, `height`, and `weight`; package presets, package type, explicit unit fields, protection, declared value, carriers, template/tax/contact fields, and arbitrary input keys are not emitted.
- Boundary safety: raw request/address/parcel fields, array length, and every parcel index are snapshotted once; invalid, sparse, class, hostile, or stateful inputs fail closed; valid output is exact-key, fresh, ordered, and deeply frozen.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped `tsc --noEmit`, and `git diff --check` passed; repository-wide spec diagnostics remain unrelated. Native advisory `R3-unbounded-parcel-snapshot` is informational and belongs to later readiness/adapter bounds rather than this deterministic mapper.
- No provider/network call, credential access, push, deployment, or production configuration change occurred during implementation or verification; earlier separately authorized sandbox observations remain operational evidence only.

## SQ-3C4 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-f656da960b012172`; locally delivered in commit `02d4613`)

- Work unit: stateless provider-port orchestration over the committed request mapper, quotation create/poll client, and quotation mapper — 398 complete changed lines, within the review guard.
- Focused TDD RED: missing provider module. Final GREEN: 9/9 adapter tests and 297/297 shipping tests.
- Control flow: invalid neutral input fails before I/O; create runs once; only a validated path-safe created ID reaches one bounded poll call; completed poll IDs must match exactly; rates are delegated once to C2.
- Boundary safety: runtime create/poll outcomes are snapshotted once; finite errors are normalized; malformed or hostile structures fail closed; synchronous throws and rejected calls return secret-safe `upstream_unavailable`; raw rates and arbitrary fields never escape or remain referenced.
- Determinism: empty/all-invalid rates return `no_rates`, valid survivors preserve provider order, dependency ordering is exact, and concurrent requests cannot cross IDs, payloads, or results.
- Scoped ESLint, Prettier, production typecheck, focused/shipping Jest, scoped `tsc --noEmit`, and `git diff --check` passed; repository-wide spec diagnostics remain unrelated. Native advisory `R3-revoked-proxy` is informational and does not reopen the approved candidate.
- No provider/network call, credential access, push, deployment, or production configuration change occurred during C4 implementation or verification; the earlier corrected sandbox component flow remains the live evidence.

## SQ-3D evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-0b8720f4d1ccfa3e`; locally delivered in commits `30ca0ea` and `a5a677a`)

- `ShippingModule.forRoot()` is inert unless `SHIPPING_QUOTES_ENABLED` is exactly `true`; the disabled module registers, instantiates, and exports nothing.
- Enabled wiring creates one singleton `SkydropxTokenClient` → `SkydropxQuotationClient` → `SkydropxShippingQuoteProvider` graph and exports only `SHIPPING_QUOTE_PROVIDER`.
- Module-local bounded timeouts are 10 seconds for OAuth and 15 seconds per quotation request; no new configuration keys or HTTP modules were introduced.
- Focused module tests passed 10/10, the shipping suite passed 307/307, and the config suite passed 274/274 during independent verification. Scoped lint, format, production typecheck, spec diagnostics, and diff checks passed; unrelated repository-wide spec diagnostics remain.
- Current `@nestjs/config` behavior was independently probed: dotenv assignment completes synchronously before the next AppModule imports-array entry evaluates, so `AppConfigModule.forRoot()` precedes the shipping gate without an observed bootstrap race.
- Native advisory `R3-http-spy-callthrough` was removed in a separate approved follow-up: every axios spy now rejects safely before the test asserts zero calls (`review-ec4920f8b5e8c833`).
- No provider/network call, credential access, push, deployment, or production configuration change occurred; shipping remains disabled by default.

## SQ-4A evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-2dc5a1d31ecfec9f`; locally delivered in commit `ed87978`)

- Added a pure internal draft boundary that selects one normalized rate deterministically by price, delivery days with null last, then code-unit carrier, service, and rate identifiers; it never applies an unapproved carrier policy.
- The draft composes the committed shipping-credit calculator and copies its exact totals, applied/unused credit, qualifying-unit count, and customer-payable cents. Invalid quotes/carts and arithmetic overflow remain finite `unavailable`/`handoff` outcomes.
- Public selector inputs are normalized once through the committed quote boundary before comparison. Stateful fields are read once; arbitrary, nested, malformed, secret-bearing, throwing, and revoked inputs cannot escape or remain referenced.
- Outputs are exact-key, fresh, deeply frozen, and contain no customer-facing copy, approval signal, persistence mutation, provider call, or I/O.
- Final verification: 33/33 focused tests and 340/340 shipping tests; scoped lint, format, production typecheck, shipping spec diagnostics, diff, index, artifact, and 396-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- Native advisory `R3-incomplete-rate-order` is informational: provider expiry is intentionally excluded from the approved business tie-break; otherwise-equal normalized rates preserve the first.
- No provider/network call, credential access, push, deployment, or production configuration change occurred; shipping remains disabled by default.

## SQ-4B evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-bfd0433472a71f79`; locally delivered in commit `b903d00`)

- Added a pure request assembler that maps exact origin/destination fields to MX addresses, maps destination postal code only from `zipCode`, and never substitutes city or other customer fields.
- Product measurements are readiness evidence only: the assembler never infers packing dimensions or treats a single-package candidate as packed. A quote requires one explicit prepared parcel whose exact weight matches the readiness total.
- Empty, sparse, inherited-index, malformed, hostile, or over-bound item/parcel collections fail closed. More than 25 kg returns manual packing with the minimum package count before parcels are read; automatic splitting remains forbidden.
- Validation is stage-lazy and deterministic: invalid origin does not read destination/items/parcels; invalid destination does not read items/parcels; readiness failures do not read parcels. Runtime fields and own array indexes are read once and never retained.
- Ready outputs are exact-key, fresh, deeply frozen, bounded to 20 technical parcel entries, stripped of arbitrary/customer/secret fields, and contain no copy, state, provider call, or I/O.
- Final verification: 54/54 focused tests and 394/394 shipping tests; scoped lint, format, production typecheck, shipping spec diagnostics, diff, index, artifact, and 386-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- No provider/network call, credential access, push, deployment, or production configuration change occurred; real shipping remains unavailable until an explicit prepared-parcel source exists and the feature is separately activated.

## SQ-4C evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-b993db4b8e6ee277`; locally delivered in commit `abc0417`)

- Added the provider-to-draft orchestrator: it delegates exact input validation to SQ-4B, calls `ShippingQuoteProviderPort.quote()` exactly once only for a ready request, and composes the result through SQ-4A without persistence or customer-facing copy.
- Credit quantity and price now come from the same one-read item snapshots used for shipment readiness. Legacy independent credit fields are ignored and unread, closing the native critical finding that could otherwise inflate credit relative to the shipped quantity.
- Provider responses cross a one-read runtime membrane before committed normalization; malformed, throwing, rejected, stateful, and secret-bearing responses become finite unavailable or handoff outcomes without leaking raw provider data.
- Final verification: 71/71 focused tests and 465/465 shipping tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 395-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- Native advisory `R3-frozen-input-proxy-invariant` is informational and did not open a correction; the approved receipt stands.
- No provider/network call, credential access, persistence mutation, customer message, push, deployment, or production configuration change occurred; shipping remains disabled by default.

## SQ-4D1 evidence (independent `PASS_WITH_WARNINGS`; native review unavailable; locally delivered in commit `618e80b`)

- Added a pure version-1 internal draft record with a fixed 30-minute chatbot TTL capped by either earlier provider expiry. Provider boundaries at or before creation, invalid clocks, malformed drafts, and inconsistent financial identities fail closed.
- The record preserves the full normalized provider-neutral draft, enforces qualifying-unit credit, applied/unused/customer-payment identities, strips arbitrary data, and returns fresh exact-key deeply frozen copies without source references.
- Structural normalization validates schema version, canonical timestamps, creation-before-expiry, maximum TTL, provider caps, and the embedded draft without reading the current clock or performing I/O.
- Final verification: 24/24 focused tests and 489/489 shipping tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 398-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- Native lineage `review-2ccdaaacf909c608` could not admit its materialized reviewer after the model change: exact fresh provider bindings were repeatedly rejected as belonging to another session route. The read-only assessment therefore reported native review unavailable and required the independent verifier, which passed; no native approval is claimed.
- No conversation write, migration, provider/network call, credential access, customer message, push, deployment, or production configuration change occurred; shipping remains disabled by default and SQ-4D2 still owns persistence.

## SQ-4D2 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-13204c0ac1e60657`; locally delivered in commit `192ffd3`)

- Added pure fail-closed draft reads with runtime clock validation, structural normalization through SQ-4D1, pre-creation rejection, and expiry at the exact boundary. Reads never mutate state or perform store I/O.
- Added one-update persistence and clear operations through the existing `ConversationStore`. Both preserve sibling JSONB state and existing `lastMessageAt`; null-state fallbacks use the canonical injected clock, and clear deletes the owned key rather than storing `null` or `undefined`.
- Invalid drafts, clocks, states, hostile getters, and proxies fail before I/O. Store rejections propagate, the exact sender ID argument is preserved, and whole-bag read/modify/write remains intentionally bounded to the accepted single-writer-per-sender model.
- Final verification: 25/25 focused tests and 514/514 shipping tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and exact 400-line complete review guard passed. Repository-wide spec diagnostics remain unrelated.
- No migration, store-port change, provider/network call, credential access, customer message, push, deployment, or production configuration change occurred. Persistence remains internal and does not authorize customer visibility; shipping remains disabled by default.

## SQ-5A evidence (independent `PASS`; native-approved as `review-405982314812c360`; locally delivered in commit `882ab41`)

- Extended the exact enabled `ShippingModule.forRoot()` graph with one singleton `ShippingQuoteOrchestrator` built from the provider-neutral port. The disabled branch still exposes empty imports, providers, and exports and instantiates no shipping component.
- Moved the single dynamic shipping import from `AppModule` into `SaleFlowModule`, avoiding duplicate provider graphs while making the optional orchestrator available to `RealToolRegistry` through the existing module boundary.
- Added optional registry injection with a safe `null` default. SQ-5A intentionally keeps the tool inventory and model behavior unchanged at exactly 12 tools; customer-visible shipping remains impossible.
- Final verification: 21/21 focused tests and 525/525 shipping-plus-focused-sale-flow tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 236-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- An accidental plain `stash@{0}` created by a baseline diagnostic contains a byte-equivalent safety copy of the committed candidate and no protected untracked inventory. It remains untouched because dropping it is destructive and was not authorized.
- No provider/network call, database access, credential access, customer message, push, deployment, or production configuration change occurred; the exact default-off gate remains authoritative.

## SQ-5B1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-538b9b82f6ef705e`; locally delivered in commit `4ddb89a`)

- Added a pure version-1 runtime membrane for one real measured demo-cart profile with one to twenty exact item lines and one explicit parcel. It validates generic UUIDs, positive safe measurements and quantities, unique item identities, overflow-safe total weight, exact parcel-weight identity, and the committed 25 kg one-parcel cap.
- Added exact cart matching by product, normalized variant, and quantity multiset. Reordered carts are accepted; subsets, supersets, duplicates, sparse/inherited arrays, hostile values, and weight-only matches fail closed. Current cart prices are copied only after identity matches.
- Outputs are fresh exact-key deeply frozen objects in SQ-4B-compatible shape. Arbitrary extras, secrets, and source references are removed; missing or invalid profiles never inspect the cart and never quote.
- Final verification: 102/102 focused tests and 616/616 shipping tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 359-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- No environment/config wiring, provider/network call, database access, customer message, push, deployment, or production configuration change occurred. Actual physical measurements remain separately required before the demo profile can be configured.

## SQ-5B2A evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-9ea2b669f4b72edd`; locally delivered in commit `734cfa9`)

- Added optional private `SHIPPING_DEMO_PARCEL_PROFILE_JSON` passthrough to the configuration factory. Blank input becomes absent; JSON parsing is intentionally deferred so a missing or malformed demo profile never makes application boot fatal.
- Added a never-throwing application membrane that reads the raw profile and four configured origin fields once each, bounds raw JSON to 16,384 code units, normalizes only through SQ-5B1, and returns a fresh exact-key deeply frozen `{ profile, origin }` or `null` without logging or retaining the raw source.
- Registered and exported one `MEASURED_DEMO_SHIPPING_CONFIG` provider only inside the exact enabled `ShippingModule` graph. The disabled graph remains empty, and enabled startup can safely resolve the token to `null` when the profile is unavailable.
- Final verification: 87/87 focused tests and 693/693 shipping-plus-configuration tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 398-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- Native advisory `R3-profile-size-cap-bypass` is informational: the factory can momentarily retain a larger raw environment string, but the only consumer rejects anything beyond the bounded membrane before parsing or use; the approved receipt stands.
- No actual measurements, tool registration, provider/network call, database access, customer message, push, deployment, or production configuration change occurred. Shipping remains disabled by default.

## SQ-5B2B1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-e920e874266cebed`; locally delivered in commit `71b13ae`)

- Added a pure server-identity boundary for Meta sender IDs. It accepts only primitive ASCII digit strings in modern `52` plus ten digits or legacy `521` plus ten digits, normalizing both to backend country code `52` and the exact ten-digit national phone.
- Every other country, prefix, length, encoding, whitespace/punctuation form, coercible value, and non-string fails closed without property access, logging, or I/O. Outputs are fresh exact-key frozen values; internal zeros are preserved and an ambiguous leading zero is rejected for the approved Mexico-only demo scope.
- Final verification: 40/40 focused tests and 247/247 sale-flow tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 170-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- Native advisory `R3-leading-zero-contract` is informational and matches the explicitly selected strict Mexico-only rule; the approved receipt stands.
- No backend lookup, tool registration, network call, database access, customer message, push, deployment, or production configuration change occurred.

## SQ-5B2B2 evidence (independent `PASS_WITH_WARNINGS`; native review unavailable; locally delivered in commit `7742d94`)

- Added an isolated AI SDK tool core with strict empty model input and server-owned sender context. It captures one clock value, reads one conversation snapshot, reuses a fresh internal draft first, and otherwise derives the strict Mexican phone, exact measured cart, stored backend address, one quote, and one persistence update in that order.
- The backend destination is reduced to zip code, state, municipality, and neighborhood before orchestration. Street, names, phone, references, carrier phone, arbitrary fields, and source references never cross into the request.
- Model-visible results are frozen finite status-only unions. They expose no money, credit, rate, carrier, service, quote/provider ID, expiry, address, phone, product, measurement, parcel, raw error, or secret. The tool remains unregistered until SQ-5B2B3.
- Final verification: 29/29 focused tests and 929/929 combined sale-flow-plus-shipping tests; scoped lint, format, production typecheck, candidate spec diagnostics, diff, index, artifact, and 367-line review guard passed. Repository-wide spec diagnostics remain unrelated.
- Strict TDD process warning: the spec was authored first and a missing-module TypeScript RED was observed, but the exact focused Jest command was not captured until after implementation. No retroactive RED is claimed; candidate behavior received independent verification.
- Native review could not complete because the package-local Gentle AI v3.4.0 binary disappeared before capture. The risk assessment therefore treated the candidate as unassessable/high-risk and required writer self-verification plus an independent verifier, both completed; no native approval is claimed and no package repair was authorized.
- No registry/runtime-context change, real network/provider call, database access, customer message, push, deployment, or production configuration change occurred.

## SQ-5B2B3 evidence (independent `PASS_WITH_WARNINGS`; native review unavailable; locally delivered in commit `f587b9c`)

- Added the enabled-only registry boundary: `RealToolRegistry` optionally injects the exact measured-demo config token and registers `getShippingQuote` only when both that config and `ShippingQuoteOrchestrator` exist. Neither, orchestrator-only, and config-only graphs remain at exactly twelve tools; both dependencies produce exactly thirteen.
- Added the exact AI SDK runtime context for the conditional tool. `getShippingQuote` receives only server-owned `{ senderId }` under its exact tool key when registered; the existing four context-bearing tools remain unchanged, and the disabled run omits the shipping context.
- Strict TDD RED was observed before production edits: the focused two-spec run failed 4 tests with 17 passing. GREEN and post-GREEN refactor runs passed 21/21; the independent offline Nest DI/adapter harness passed 65/65 across five focused suites.
- Scoped ESLint, Prettier, production typecheck, candidate diagnostics, `git diff --check`, hash stability, exact four-path scope, and the 185-line review guard passed. Repository-wide spec typecheck retains unrelated pre-existing diagnostics and reported none in the four candidate files.
- Native review was unavailable for this candidate: intended-untracked exclusion reached native START but failed `schema-incompatible` with `lineage_created: false`; explicit unavailable assessment therefore required writer self-verification plus the independent verifier, both completed. No native approval is claimed.
- Runtime harness: offline Nest DI and AI adapter Jest only. Rollback boundary: the four registry/adapter implementation and spec files in commit `f587b9c`; reverting them removes conditional registration without touching the committed tool core or shipping module.
- No live provider/network call, database access, credential access, customer message, push, deployment, production configuration change, protected-path inspection, or stash mutation occurred. Shipping remains disabled by default, and human approval remains SQ-5C.

## SQ-5C1 evidence (independent `PASS_WITH_WARNINGS`; native-approved as `review-f4e6ad85098af58c`; locally delivered in commit `9904557`)

- Added the exact redacted `shipping_approval` digest to the handoff domain while preserving four known kinds, the original three model-active kinds, and the unchanged human-resolution union. The current model-facing handoff tool still cannot create this server-owned request.
- Added a pure builder that crosses only the committed draft-record normalizer, accepts exactly `createdAt <= now < expiresAt`, and emits a fresh frozen seven-field ops digest: draft-created pin, net customer charge, total credit, carrier/service, and ETA. IDs, address/phone/product/measurements, raw provider/error data, expiry/validity, gross/best/applied/unused amounts, and qualifying count do not escape.
- Added a strict parser for case-insensitive, outer-whitespace-tolerant `APPROVE_SHIPPING` and `REJECT_SHIPPING`. Prefixes, suffixes, reasons, prose, combined commands, coercible values, and hostile inputs fail closed; structured service resolution remains SQ-5C2.
- Strict TDD RED failed on the missing module with one suite failed, one passed, and five tests executed. GREEN passed 51/51; independent verification passed 106/106 across five suites. Scoped ESLint, Prettier, production typecheck, candidate diagnostics, diff/hash integrity, and the 365-line complete implementation review guard passed; repository-wide spec typecheck retains unrelated baseline diagnostics.
- Native reliability review approved and was acknowledged/burned with target `sha256:6605dbc9ed04a5779d5f9249b0de5b3f48a64330ec731a1ef05e5639cbcffbcd`. Runtime harness: pure offline Jest only. Rollback boundary: the five paths in commit `9904557`; no migration or external runtime dependency was added.
- No service/module/tool/instruction activation, persistence mutation, customer/model price surface, live provider/network/DB access, credential access, push, deployment, protected-path inspection, or stash mutation occurred.

## Delivery gate

This foundation is locally complete only when SQ-1A, SQ-1B, SQ-2A, SQ-2B1, SQ-2B1-H, SQ-2B2A, SQ-2B2A-H, SQ-2B2B1, SQ-2B2B2, and SQ-3 through SQ-7 have observed evidence. It is production-ready only after every activation prerequisite is satisfied separately; completing code does not authorize or imply live shipping quotes.
