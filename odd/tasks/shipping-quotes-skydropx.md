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
- [ ] **SQ-2B2B — Add the shipping-quote error port:** normalized error union, `SHIPPING_QUOTE_PROVIDER` token, and port interface.
- [ ] **SQ-3 — Implement the Skydropx quote adapter:** add OAuth token caching, the current quotation request/polling flow, bounded retry/timeout behavior, response normalization, rate filtering, and secret-safe errors against mocked HTTP only.
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

## Delivery gate

This foundation is locally complete only when SQ-1A, SQ-1B, SQ-2A, SQ-2B1, SQ-2B1-H, SQ-2B2A, SQ-2B2A-H, SQ-2B2B, and SQ-3 through SQ-7 have observed evidence. It is production-ready only after every activation prerequisite is satisfied separately; completing code does not authorize or imply live shipping quotes.
