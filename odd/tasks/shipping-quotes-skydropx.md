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
- [ ] **SQ-3C2 — Quotation filter/envelope mapper:** filter invalid provider rates and build provider-neutral quotation results/delegated envelopes from mapped rates and finite errors.
- [ ] **SQ-3C3 — Request-to-wire mapper:** convert the provider-neutral shipping request into the Skydropx V1 wire payload. Blocked/deferred: parcel unit conversion is blocked pending controlled provider validation, so request mapping must not guess units.
- [ ] **SQ-3C4 — Provider adapter:** implement `ShippingQuoteProviderPort` over token/creation/poll/mapping and return `no_rates` when no rate survives filtering.
- [ ] **SQ-3D — Add default-off module wiring:** register the provider/adapter only when `shippingQuotes.enabled` is true.
- [ ] **SQ-4 — Build draft quote orchestration:** validate origin/destination/package inputs, call the provider, choose the best eligible rate deterministically, apply credit, persist bounded quote state/expiry, and return structured unavailable/handoff results.
- [ ] **SQ-5 — Add the disabled conversation and human-approval path:** register the tool only when enabled, update deterministic sale-flow instructions, activate `shipping_approval`, prevent customer-facing quote claims before approval, and block sale continuation where shipping cannot be persisted honestly.
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

## Delivery gate

This foundation is locally complete only when SQ-1A, SQ-1B, SQ-2A, SQ-2B1, SQ-2B1-H, SQ-2B2A, SQ-2B2A-H, SQ-2B2B1, SQ-2B2B2, and SQ-3 through SQ-7 have observed evidence. It is production-ready only after every activation prerequisite is satisfied separately; completing code does not authorize or imply live shipping quotes.
