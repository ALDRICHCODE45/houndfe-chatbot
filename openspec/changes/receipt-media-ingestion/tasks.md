# Implementation Tasks: Receipt Media Ingestion

Implement in dependency order under strict TDD. Each work unit is one independently reviewable slice: start only after dependencies are green, keep its listed tests with its implementation, record the focused result, and roll back only its listed surface. No task authorizes backend changes, secret inspection, commits, pushes, PRs, or production enablement.

## Review Workload Forecast

| Field                   | Value                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated changed lines | 5,390–6,937 total across 25 bounded review units                                                                                                                                                                                                                                                                                 |
| 400-line budget risk    | High                                                                                                                                                                                                                                                                                                                             |
| Chained PRs recommended | Yes                                                                                                                                                                                                                                                                                                                              |
| Suggested split         | PR 1 WU1A → PR 2 WU1B → PR 3 WU1C1 → PR 4 WU1C2A → PR 5 WU1C2B1 → PR 6 WU1C2B2 → PR 7 WU2A1 → PR 8 WU2A2A → PR 9 WU2A2B → PR 10 WU2B → PR 11 WU3 → PR 12 WU4 → PR 13 WU5 → PR 14 WU6 → PR 15 WU7 → PR 16 WU8 → PR 17 WU9 → PR 18 WU10 → PR 19 WU11 → PR 20 WU12 → PR 21 WU13 → PR 22 WU14 → PR 23 WU15 → PR 24 WU16 → PR 25 WU17 |
| Delivery strategy       | auto-chain                                                                                                                                                                                                                                                                                                                       |
| Chain strategy          | feature-branch-chain                                                                                                                                                                                                                                                                                                             |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

**Resolved delivery decision:** use bounded chained delivery across 25 review slices, not a `size:exception`. Use a draft/no-merge tracker: child 1 targets the tracker, each later child targets its immediate predecessor, and only the tracker integrates the final feature to `main`. This decision authorizes no commit, push, PR creation, or publication.

**Incident note:** the interrupted WU1 attempt changed 1,359 lines (including a known 342-line lockfile) and was discarded under maintainer authorization after exceeding the native 400-line budget. WU1 is therefore split into WU1A–WU1C2B2; custom ambient `ipaddr` declarations, including any `src/types` file, are forbidden.

**WU1C2 replanning note:** the first WU1C2 apply attempt timed out at 733 diff lines against the 210–290 boundary and was reset under maintainer authorization. WU1C2 is split into sequential WU1C2A numeric relations, WU1C2B1 keyring validation, and WU1C2B2 validation-error redaction; the shared validation files must still be modified by only one slice at a time.

**WU1C2B replanning note:** the first WU1C2B apply attempt timed out after producing RED tests only at 238 diff lines against its 135–180 boundary, leaving no implementation, and that partial candidate was discarded under maintainer authorization. WU1C2B is split into sequential WU1C2B1 capability keyring validation (130–180 lines) and WU1C2B2 validation error redaction (110–160 lines). Each slice owns the same two validation files by exclusive sequential handoff, is reviewed as its own bounded slice and PR, and is rolled back without reverting the other.

**WU2A replanning note:** the discarded 597-line WU2A candidate exceeded its 310-line boundary and timed out without a final envelope. WU2A is split into sequential WU2A1 core schema/types (300–400 lines), WU2A2A lifecycle/evidence/lease predicates (220–340 lines), and WU2A2B partial indexes/non-empty down guards (120–230 lines). The migration and shared store spec transfer exclusively `WU2A1 → WU2A2A → WU2A2B → WU2B`; durable types remain WU2A1-owned unless a strictly necessary correction is required.

## Execution rules

- Jest unit/integration specs are only under `src/`; e2e specs are only under `test/`. Use `pnpm exec eslint <exact paths>` as a check-only lint command; never run `pnpm lint`, which applies `--fix`.
- Network I/O is outside database transactions; attach timeouts use Axios `timeout` and `AbortSignal`, never `Promise.race`.
- Each task cites the requirement/scenario area it proves. The consolidated trace ledger does not exist until WU17; do not create, edit, or rely on it earlier.

## Work units

### WU1A — Approved dependencies and lockfile

**Depends on:** none. **Finish/rollback:** approved runtime dependencies resolve and their compact smoke/type contract passes; revert only this dependency surface to remove them.

**Owned surface:** `package.json`, `pnpm-lock.yaml`, `src/config/receipt-media-dependencies.spec.ts`.

- [x] **1. RED (AC1):** add a compact failing smoke/type spec at `src/config/receipt-media-dependencies.spec.ts` proving the required runtime imports/contracts are absent before any dependency is added. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (AC1):** add only `@aws-sdk/client-s3`, `ipaddr.js`, and `prom-client` plus their actual `pnpm-lock.yaml` resolution; add `@types/ipaddr.js` as a devDependency only when installed `ipaddr.js` lacks usable bundled types and the registry package resolves. Do not create custom ambient declarations or any `src/types` file. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (AC1):** parameterize the compact spec to verify runtime and TypeScript imports/contracts for the three approved packages and that no accidental extra package is declared. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** remove any redundant dependency/type shim; retain package-native types or the resolved `@types/ipaddr.js` only when required. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/config/receipt-media-dependencies.spec.ts`, `pnpm exec eslint src/config/receipt-media-dependencies.spec.ts`, and `pnpm install --frozen-lockfile` (or repository-equivalent lockfile consistency check) without secrets; record exact results. <!-- sdd-owner: implementation -->

### WU1B — Typed disabled configuration model

**Depends on:** WU1A. **Finish/rollback:** typed receipt configuration has safe public defaults and disabled boot remains compatible; revert only this config-model surface while disabled.

**Owned surface:** `src/config/configuration.ts`, `src/config/config.module.ts`, `src/config/configuration.spec.ts`, `src/config/config.module.spec.ts`.

- [x] **1. RED (AC1):** add concise table-driven failing cases in the two owned specs for the absent typed receipt configuration/default-disabled model and safe public default projection. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (AC1):** implement the typed receipt configuration and module exposure with default-disabled, safe public values/defaults only; do not add environment validation beyond existing module behavior. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (AC1):** extend the tables for explicit disabled values, public default stability, and existing module consumers booting without receipt-specific environment values. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** consolidate local config type/default helpers without changing validation behavior or expanding the owned surface. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/config/configuration.spec.ts src/config/config.module.spec.ts` and `pnpm exec eslint src/config/configuration.ts src/config/config.module.ts src/config/configuration.spec.ts src/config/config.module.spec.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU1C1 — Conditional validation foundation

**Depends on:** WU1B. **Finish/rollback:** disabled configuration remains permissive while enabled-mode base validation is safe and conditional; revert only the changes to `src/config/env.validation.ts` and `src/config/env.validation.spec.ts` from this unit to restore the prior validation behavior and human-handoff compatibility.

**Owned surface:** `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`. **Review boundary:** 230–310 changed lines; this shared surface is exclusively sequenced before WU1C2A and must not be modified concurrently.

- [x] **1. RED (AC1, AC2):** in `src/config/env.validation.spec.ts`, construct one valid enabled environment fixture and add compact one-field mutation tables proving disabled permissiveness, enabled required private-storage fields, exact `10_485_760` bytes, HTTPS endpoint/public-base values, valid exact/suffix host labels, force-path-style and metrics booleans, and existing validation/human-handoff behavior. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (AC1, AC2):** in `src/config/env.validation.ts`, implement only the conditional enabled/disabled foundation for those fields and safe non-secret required-field error categories; include the existing one-line Joi custom callback typing correction already present in the working tree. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (AC1, AC2):** extend the same compact mutation tables with malformed/missing enabled values, exact-versus-suffix host-label acceptance/rejection, non-HTTPS URL rejection, boolean coercion boundaries, and disabled missing-storage cases without duplicating full environments. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** deduplicate local fixture/schema helpers in the two owned files while preserving existing validation and human-handoff behavior, conditional permissiveness, and safe required-field categories. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/config/env.validation.spec.ts` and `pnpm exec eslint src/config/env.validation.ts src/config/env.validation.spec.ts`; record exact results and confirm the focused diff remains within the 230–310-line boundary. <!-- sdd-owner: implementation -->

### WU1C2A — Numeric relational bounds

**Depends on:** WU1C1. **Finish/rollback:** numeric receipt-media timeouts, worker bounds, lease, poll, and attach timeout constraints are complete; revert only this slice's changes to the shared validation surface while retaining WU1C1 foundation behavior.

**Owned surface:** `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`. **Review boundary:** 110–160 changed lines; ownership overlaps WU1C1 only by explicit sequential handoff (WU1C1 → WU1C2A), never concurrent modification.

- [x] **1. RED (AC1):** in `src/config/env.validation.spec.ts`, extend the WU1C1 valid enabled fixture with compact mutation tables for metadata/download timeout positive bounds and ordering, worker concurrency `1..8`, exact `60_000` lease, poll less than lease, and positive attach timeout at most `30_000` and less than lease. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (AC1):** in `src/config/env.validation.ts`, implement only the numeric timeout/lease/concurrency/poll/attach constraints; do not introduce keyring parsing or broad error-redaction refactors in this slice. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (AC1):** parameterize lower/upper/equality and ordering mutations for every numeric relation, including lease-adjacent poll and attach timeout cases. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** consolidate numeric helper constants/schemas without weakening WU1C1 behavior, disabled permissiveness, or human-handoff validation. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/config/env.validation.spec.ts` and `pnpm exec eslint src/config/env.validation.ts src/config/env.validation.spec.ts`; record exact results and confirm the focused diff remains within the 110–160-line boundary. <!-- sdd-owner: implementation -->

### WU1C2B1 — Capability keyring validation

**Depends on:** WU1C2A. **Finish/rollback:** capability keyring parsing, key-material rules, and active-version membership are complete; revert only this slice's changes to the shared validation surface while retaining WU1C1 and WU1C2A behavior.

**Owned surface:** `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`. **Review boundary:** 130–180 changed lines; ownership overlaps WU1C2A only by explicit sequential handoff (WU1C2A → WU1C2B1), never concurrent modification.

- [x] **1. RED (AC1):** in `src/config/env.validation.spec.ts`, extend the enabled receipt fixture with compact mutation tables proving `RECEIPT_CAPABILITY_KEYS` parses as comma-separated `version:base64` entries, that versions are positive unique integers, that key material is strict canonical base64 decoding to at least 32 bytes, and that `RECEIPT_CAPABILITY_ACTIVE_VERSION` is a positive version present in the parsed keyring. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (AC1):** in `src/config/env.validation.ts`, implement only comma-separated keyring parsing, the version/base64/decoded-length rules, and active-version membership; add no error-redaction refactor, no message rewriting, and no numeric-bound change in this slice. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (AC1):** parameterize duplicate, zero, negative, non-integer, and malformed version tokens; missing separators and empty entries; non-canonical, whitespace-padded, and non-base64 key material; decoded lengths at 31 and 32 bytes; and absent, zero, negative, or non-member active versions. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** consolidate keyring parsing helpers in the two owned files while preserving WU1C2A numeric behavior, disabled permissiveness, and existing human-handoff validation. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/config/env.validation.spec.ts` and `pnpm exec eslint src/config/env.validation.ts src/config/env.validation.spec.ts`; record exact results and confirm the focused diff remains within the 130–180-line boundary. <!-- sdd-owner: implementation -->

### WU1C2B2 — Validation error redaction

**Depends on:** WU1C2B1. **Finish/rollback:** enabled-mode validation errors are safe and expose no storage credential or capability key material; revert only this slice's changes to the shared validation surface while retaining WU1C1, WU1C2A, and WU1C2B1 behavior.

**Owned surface:** `src/config/env.validation.ts`, `src/config/env.validation.spec.ts`. **Review boundary:** 110–160 changed lines; ownership overlaps WU1C2B1 only by explicit sequential handoff (WU1C2B1 → WU1C2B2), never concurrent modification.

- [x] **1. RED (AC1):** in `src/config/env.validation.spec.ts`, add compact cases using one distinct storage-credential sentinel value and one distinct keyring sentinel value, proving neither value appears in the Joi validation error `message`, in its `details`/context including `JSON.stringify(details)`, or in the thrown `String(error)` text. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (AC1):** in `src/config/env.validation.ts`, implement only safe validation-error construction that reports non-secret field categories and never interpolates credential or keyring values into messages, details, context, or thrown text. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (AC1):** parameterize invalid-credential-only, invalid-keyring-only, and simultaneously invalid cases plus multi-error aggregation, asserting in every case that both sentinels are absent from `message`, `details`, `JSON.stringify(details)`, and `String(error)`. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** consolidate the safe error/label helpers without weakening WU1C2B1 keyring rules, WU1C2A numeric behavior, disabled permissiveness, or human-handoff validation. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/config/env.validation.spec.ts` and `pnpm exec eslint src/config/env.validation.ts src/config/env.validation.spec.ts`; record exact results and confirm the focused diff remains within the 110–160-line boundary. <!-- sdd-owner: implementation -->

### WU2A1 — Core schema and durable types

**Depends on:** WU1C2B2. **Finish/rollback:** both empty tables can be created and dropped, their core single-field constraints and references hold, and complete durable TypeScript projections exist; revert only this migration/type/shared-spec slice while both tables are empty. Cross-field lifecycle predicates, partial indexes, and refusal to down non-empty tables are explicitly deferred to WU2A2A and WU2A2B.

**Owned surface:** `migrations/2000000000000_receipt_media.js`, `src/receipt-media/domain/receipt-media.types.ts`, `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`. **Review boundary:** 300–400 changed lines; the migration and shared spec are exclusively owned before the sequential handoff `WU2A1 → WU2A2A → WU2A2B → WU2B`; `receipt-media.types.ts` is WU2A1-owned.

- [x] **1. RED (RM1, RM3):** in `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`, add failing Testcontainers cases for empty-table up/down, the two table/column sets, single-field status/failure-stage/template enum checks, numeric range/byte-length/nullability checks, foreign keys, and basic webhook/provider-media/object-key/outbox-dedupe uniqueness. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (RM1, RM3):** add `migrations/2000000000000_receipt_media.js` with additive `receipt_media` and `receipt_media_outbox` tables, columns, single-field checks, foreign keys, and basic unique constraints; implement empty-table `down`; fully define durable lifecycle, evidence, lease, attempt, capability, and outbox projections in `src/receipt-media/domain/receipt-media.types.ts`. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (RM1, RM3):** extend the shared spec with one-field boundary tables for every enum/range/length/nullability rule, each FK/basic unique violation, and empty `receipt_media` versus empty `receipt_media_outbox` up/down fixtures; do not add cross-field lifecycle, partial-index, or non-empty-down cases. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** consolidate core migration/type constants without adding deferred predicates or indexes; retain opaque `objectKey` and exclude captions, URLs, plaintext capability material, response bodies, and diagnostic PII from durable types. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`, validate the CommonJS migration syntax with `node --check migrations/2000000000000_receipt_media.js`, and run `pnpm exec eslint src/receipt-media/domain/receipt-media.types.ts src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` on the two TypeScript files only (the migration is outside the TypeScript project service and is not ESLint-scoped); record exact results, verify empty-table rollback, and confirm either the 300–400-line boundary or an explicit human-authorized `size:exception`. <!-- sdd-owner: implementation -->

### WU2A2A — Cross-field lifecycle, evidence, and lease predicates

**Depends on:** WU2A1. **Finish/rollback:** exact accepted-object, download, amount, request-start, attached, definite-failure, unknown-outcome, cleanup, `failure_stage iff FAILED`, and paired-lease predicates are enforced; revert only this migration/shared-spec delta to restore WU2A1 core schema behavior. Partial indexes and non-empty down guards remain WU2A2B-owned.

**Owned surface:** `migrations/2000000000000_receipt_media.js`, `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`; `src/receipt-media/domain/receipt-media.types.ts` may be corrected only when strictly required. **Review boundary:** 220–340 changed lines; migration and shared spec are the exclusive sequential handoff from WU2A1 and transfer to WU2A2B only when green. No indexes or down guards belong to this slice.

- [x] **1. RED (RM1, RM3):** after the WU2A1 handoff, add failing Docker-focused Jest cases in `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` for exact accepted-object, download, amount, request-start, attached, definite-failure, unknown-outcome, cleanup, `failure_stage iff FAILED`, and paired-lease predicates. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (RM1, RM3):** harden `migrations/2000000000000_receipt_media.js` with only the exact set-membership cross-field lifecycle/evidence/lease checks, including `failure_stage iff FAILED`; do not add indexes or down guards, and correct durable types only if strictly required. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (RM1, RM3):** exercise every accepted versus pre-storage failure boundary, all `FAILED` discriminators, request-start counter pairings, cleanup outcomes, and valid/invalid lease pairs while proving unrelated partial-index and down-guard behavior remains deferred. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** factor predicate fragments and compact shared fixtures in the migration/spec only, preserving WU2A1 single-field rules and durable projections without widening into port/store files. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run Docker-focused `RUN_DOCKER_TESTS=1 pnpm test -- src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`, `node --check migrations/2000000000000_receipt_media.js`, `pnpm exec eslint src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` plus `src/receipt-media/domain/receipt-media.types.ts` only if corrected, and Prettier/diff/type diagnostics; record results and confirm 220–340 changed lines. <!-- sdd-owner: implementation -->

### WU2A2B — Partial indexes and non-empty down guards

**Depends on:** WU2A2A. **Finish/rollback:** all required partial/lookup indexes exist and `down` independently refuses when either `receipt_media` or `receipt_media_outbox` is non-empty; revert only this migration/shared-spec delta to retain WU2A2A predicates and WU2A1 core schema.

**Owned surface:** `migrations/2000000000000_receipt_media.js`, `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`; `src/receipt-media/domain/receipt-media.types.ts` is not owned. **Review boundary:** 120–230 changed lines; migration and shared spec transfer exclusively from WU2A2A and transfer to WU2B only when green. Predicate definitions are not reopened here.

- [x] **1. RED (RM1, RM3):** after the WU2A2A handoff, add failing Docker-focused Jest cases in `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` for every required active-sender, claim, capability, unknown-outcome, and outbox partial/lookup index, including inclusion/exclusion predicates and independent non-empty `receipt_media` and `receipt_media_outbox` down refusal. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (RM1, RM3):** add only the design-required partial/lookup indexes and independent `down` guards to `migrations/2000000000000_receipt_media.js`, refusing rollback when either table has rows without altering WU2A2A predicates. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (RM1, RM3):** verify each index definition and filtered-row inclusion/exclusion, then prove refusal with only `receipt_media` populated and only `receipt_media_outbox` populated, while preserving empty-table rollback. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** consolidate index and down-guard fragments and compact shared fixtures without reopening cross-field predicates or widening ownership into port/store files. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run Docker-focused `RUN_DOCKER_TESTS=1 pnpm test -- src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`, `node --check migrations/2000000000000_receipt_media.js`, `pnpm exec eslint src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`, and Prettier/diff/type diagnostics; record results and confirm 120–230 changed lines. <!-- sdd-owner: implementation -->

### WU2B — Store port and PostgreSQL primitives

**Depends on:** WU2A2B. **Finish/rollback:** parameterized store operations provide reservation, leased `SKIP LOCKED` claims, owner/version CAS, bounded-attempt exclusion, and outbox dedupe; revert only this unit's port, store, and post-handoff shared-spec changes while retaining WU2A1 core schema and WU2A2A/WU2A2B hardening.

**Owned surface:** `src/receipt-media/domain/receipt-media-store.port.ts`, `src/receipt-media/infrastructure/postgres-receipt-media.store.ts`, `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts`. **Review boundary:** 230–305 changed lines; ownership of the shared spec transfers exclusively and sequentially from WU2A2B to WU2B, never concurrently.

- [x] **1. WU2B1 RED (RM1, RM3):** after the WU2A2B handoff, extend `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` with failing store cases for parameter-bound reservation conflicts (including adversarial parameter binding and unrelated-constraint rethrow), concurrent first-image/provider-media outcomes, and duplicate outbox dedupe keys with nullable receipt linkage. Claim/lease/CAS/attempt-counter cases are WU2B2 scope. <!-- sdd-owner: implementation -->
- [x] **2. WU2B1 GREEN (RM1, RM3):** define the store port in `src/receipt-media/domain/receipt-media-store.port.ts` (reservation + outbox-insert only; conflicts as values) and implement only parameterized PostgreSQL reservation and outbox-insert primitives in `src/receipt-media/infrastructure/postgres-receipt-media.store.ts`, using WU2A1/WU2A2A/WU2A2B schema rules and no interpolated external values. Claim, lease, CAS, and attempt-increment primitives arrive with WU2B2. <!-- sdd-owner: implementation -->
- [x] **3. WU2B1 TRIANGULATE (RM1, RM3):** prove concurrent reservation arbitration classifies all four rival outcomes deterministically (exactly one `created`, single durable row), active-sender uniqueness is surfaced deterministically, declared MIME persists, webhook replay returns the original row, and repeated or concurrent duplicate state intent returns the deduped outbox result with the original id/payload. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR (WU2B1 compaction):** extract `loadHit`/`classify` transaction-local helpers and the shared `rivalInput` fixture, flatten the concurrent `it.each` table, and dense the INSERT SQL constants without widening the port, weakening WU2A1/WU2A2A/WU2A2B constraints, or persisting captions, URLs, keys, tokens, response bodies, or diagnostic PII. <!-- sdd-owner: implementation -->
- [x] **5. Verify (WU2B1):** `RUN_DOCKER_TESTS=1 pnpm test -- src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` → 112/112 passed (executed, not skipped); scoped ESLint and Prettier over the three files clean; `git diff --check` clean; `tsc -p tsconfig.build.json --noEmit` 0 errors; changed lines against `36c0f39` = 304 (port 42 + store 141 + spec delta 121) ≤ 305. <!-- sdd-owner: implementation -->
- [x] **6. WU2B2A RED (RM1, RM3):** extend the shared spec with failing Docker cases for `FOR UPDATE SKIP LOCKED` claims (exact eligibility/exclusion matrix, `next_attempt_at, created_at` ordering, concurrent disjoint workers, held-lock skip and reclaim), lease expiry, and isolated fenced renewal/release with approximately 60-second lease-duration assertions from DB time. CAS/attempt-counter cases move to WU2B2B. <!-- sdd-owner: implementation -->
- [x] **7. WU2B2A GREEN (RM1, RM3):** implement only parameterized PostgreSQL claim, lease renewal, and lease release primitives in the store and port (`LeaseFenceInput`, `claimBatch`, `renewLease`, `releaseLease`), with no CAS/attempt surface and no WU2B1 reservation/outbox changes. <!-- sdd-owner: implementation -->
- [x] **8. WU2B2A TRIANGULATE/Verify (RM1, RM3):** prove competing workers return disjoint rows whose union is the eligible set, expired leases are reclaimable, wrong owner/version/expired-owner fences return false with no mutation before and after reclaim, renewal/release preserve the version, and claim/renew leases are approximately 60 seconds from DB time; re-run the focused Docker suite, scoped ESLint/Prettier, diff check, and TypeScript diagnostics, and confirm the WU2B2A budget (215–275, cap 305) with the parent. <!-- sdd-owner: implementation -->
- [x] **9. WU2B2B RED (RM1, RM3):** extend the shared spec with failing store cases for owner/version CAS zero-row losers and no fourth Meta/storage call at counter three. <!-- sdd-owner: implementation -->
- [x] **10. WU2B2B GREEN (RM1, RM3):** implement only parameterized PostgreSQL status CAS and attempt-increment primitives in the store and port (`StatusCasInput`, `transitionStatus`, `startMetaAttempt`, `startStorageAttempt`), with no other surface. <!-- sdd-owner: implementation -->
- [x] **11. WU2B2B TRIANGULATE/Verify (RM1, RM3):** prove mismatched owner/expected-status/version never transitions and attempts 1/2/3 begin but counter three excludes a fourth call; re-run the focused Docker suite, scoped ESLint/Prettier, diff check, and TypeScript diagnostics, and confirm the cumulative WU2B budget with the parent. <!-- sdd-owner: implementation -->

### WU3 — Lifecycle domain and committed outbox intent

**Depends on:** WU2B. **Finish/rollback:** transitions and TX2 intent are domain-owned; remove this surface without WhatsApp routing changes.

**Owned surface:** `src/receipt-media/domain/receipt-media.errors.ts`, `src/receipt-media/domain/receipt-telemetry.port.ts`, `src/receipt-media/application/receipt-outbox.service.ts`, `src/receipt-media/domain/receipt-media.errors.spec.ts`, `src/receipt-media/application/receipt-outbox.service.spec.ts`.

- [x] **1. RED (RM3, WA2):** add failing transition/template/dedupe/state-version and TX2 atomicity cases in the owned specs. <!-- sdd-owner: implementation -->
- [x] **2. GREEN (RM3, WA2):** implement safe errors, telemetry port, and outbox rendering/insertion restricted to receipt transitions and bounded Spanish template keys/arguments. <!-- sdd-owner: implementation -->
- [x] **3. TRIANGULATE (WA2):** test crashes before/after TX2, duplicate transition replay, unique conflict, no send before commit, and byte-identical replay after provider acceptance before `SENT`. <!-- sdd-owner: implementation -->
- [x] **4. REFACTOR:** centralize guards/template keys and preserve lifecycle separation from conversation JSONB. <!-- sdd-owner: implementation -->
- [x] **5. Verify:** run `pnpm test -- src/receipt-media/domain/receipt-media.errors.spec.ts src/receipt-media/application/receipt-outbox.service.spec.ts` and `pnpm exec eslint src/receipt-media/domain/receipt-media.errors.ts src/receipt-media/domain/receipt-telemetry.port.ts src/receipt-media/application/receipt-outbox.service.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU4 — Meta transport and structural validation

**Depends on:** WU1C2B2, WU2B. **Finish/rollback:** provider-id-only resolution yields validated bounded temporary files; remove adapter/validator before acceptance.

**Owned surface:** `src/receipt-media/domain/meta-media.port.ts`, `src/receipt-media/infrastructure/meta-media.client.ts`, `src/receipt-media/infrastructure/media-structure.validator.ts`, `src/receipt-media/infrastructure/meta-media.client.spec.ts`, `src/receipt-media/infrastructure/media-structure.validator.spec.ts`.

- [ ] **1. RED (RMA4, RM2):** add failing owned specs for metadata/download hops, `proxy:false`, `maxRedirects:0`, timeout/signal, allowlist, pinned public DNS, manual redirects, bearer suppression, JPEG/PNG structure, and temp cleanup. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (RMA4, RM2):** implement provider-id-only Meta transport and validator with HTTPS label-boundary policy, `ipaddr.js` public-address policy, per-hop pinned lookup, maximum three redirects, bounded streaming/hash/temp files. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (RMA4, RM2):** test private IPv4/IPv6, rebinding, HTTP/userinfo/wrong-port redirect, abort/timeout, MIME disagreement, malformed structures, byte `10_485_761`, and every-path mode-0600 unlink. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** factor category/code-only transport and stream helpers without URLs, bearer values, filenames, or sender data in errors. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/infrastructure/meta-media.client.spec.ts src/receipt-media/infrastructure/media-structure.validator.spec.ts` and `pnpm exec eslint src/receipt-media/domain/meta-media.port.ts src/receipt-media/infrastructure/meta-media.client.ts src/receipt-media/infrastructure/media-structure.validator.ts`; record exact results. <!-- sdd-owner: implementation -->

#### WU4 accepted four-slice recovery

The original WU4 requirements above remain the aggregate trace and stay unchecked until WU4A–WU4B3 are complete. The invalidated spike is not completion evidence. Delivery is sequential and exclusive: `WU4A → WU4B1 → WU4B2 → WU4B3`; each slice is a separate feature-branch-chain boundary.

| Slice                                                 | Depends on    | Exact owned surface                                                                                                                                                                  |                                                    Honest forecast | Original WU4 trace                                                                                                               |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -----------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------- |
| WU4A — provider-id contracts and structural validator | WU1C2B2, WU2B | `src/receipt-media/domain/meta-media.port.ts`; `src/receipt-media/infrastructure/media-structure.validator.ts`; `src/receipt-media/infrastructure/media-structure.validator.spec.ts` |                                 280–340 authored source/spec lines | Steps 1–4: provider-id-only contract, fixed category/code errors, strict JPEG/PNG structure                                      |
| WU4B1 — metadata origin and DNS pinning               | WU4A          | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (exclusive handoff to B2)                                      |                                              250–340 changed lines | Steps 1–4: metadata hop, HTTPS label-boundary allowlist, public DNS, pinned lookup, bearer-after-policy, proxy/redirect defaults |
| WU4B2 — manual redirect download transport            | WU4B1         | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (exclusive handoff from B1 to B3)                              | 250–400 changed lines (human-authorized cap revision from 250–340) | Steps 1–4: authenticated download hops, maximum three manual redirects, per-hop revalidation, timeout/signal, redirect rejection |
| WU4B3 — bounded stream and technical cleanup          | WU4B2         | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (final exclusive handoff)                                      |                                              260–350 changed lines | Steps 1–5: MIME agreement, byte/hash/temp-file pipeline, mode 0600, overflow/abort/failure unlink, final focused verification    |

- [x] **WU4A.1 RED (RMA4, RM2):** write the absent validator spec first and reproduce failure before adding production files; cover valid minimal PNG/JPEG plus malformed structure rejection. <!-- sdd-owner: implementation -->
- [x] **WU4A.2 GREEN (RMA4, RM2):** add the provider-id-only port and fixed category/code-only errors, then implement strict PNG signature/IHDR/chunk CRC/IEND and JPEG SOI/SOF/SOS/entropy/EOI validation without transport behavior. <!-- sdd-owner: implementation -->
- [x] **WU4A.3 TRIANGULATE (RM2):** cover PNG IHDR position/length/dimensions/CRC/trailing bytes and JPEG segment bounds, stuffed bytes, restart markers, malformed entropy, missing markers, EOI, and trailing data. <!-- sdd-owner: implementation -->
- [x] **WU4A.4 REFACTOR:** retain bounded cursor/CRC helpers and safe fixed errors without URLs, bearer values, filenames, sender data, HTTP, DNS, redirects, streaming, temp files, hashing, timeouts, or adapter composition. <!-- sdd-owner: implementation -->
- [x] **WU4A.5 Verify:** run focused Jest, scoped ESLint, scoped Prettier check, `git diff --check`, and non-incremental TypeScript diagnostics; confirm 280–340 authored lines across the three WU4A files. <!-- sdd-owner: implementation -->
- [x] **WU4A remediation (RM2):** correct failed structural evidence by requiring PNG IDAT, rejecting JPEG SOS before SOF and scans without entropy, using standalone-valid fixtures, and retaining at most 380 source/spec lines with focused quality checks passing. <!-- sdd-owner: implementation -->
- [x] **WU4A second remediation (RM2):** remediate failed evidence `sha256:62e98b134d32054c65e9c52677d8ecde2cef57da923b6e18268a2db846441eb4` by requiring non-empty entropy data for every terminated JPEG scan and consecutive PNG IDAT chunks, proven by two new RED regressions (empty earlier JPEG scan before a populated final scan; nonconsecutive PNG IDAT chunks), adjacent-case triangulation, and all quality checks with the three-file total at 380 lines. <!-- sdd-owner: implementation -->

#### WU4B1 split recovery (WU4B1A → WU4B1B)

Human maintainer authorized splitting the exhausted WU4B1 objective into two sequential exclusive slices on branch `feat/receipt-media-ingestion-wu04b1-meta-origin`. The invalidated 420-line client/spec candidate is preserved only as git tree `93f463705d7cb03f047f0766ebfb28102b7024f8`; it was never settled, never completed a TDD cycle, and therefore provides **no RED/GREEN evidence** and is not completion evidence for any slice. Ownership is exclusive: WU4B1A owns only the two policy files below; the client surface transfers exclusively `WU4B1A → WU4B1B` and never concurrently.

| Slice                                       | Depends on | Exact owned surface                                                                                                                             |                    Honest forecast | WU4B1 trace                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WU4B1A — HTTPS origin and pinned DNS policy | WU4A       | `src/receipt-media/infrastructure/meta-media-origin.policy.ts`; `src/receipt-media/infrastructure/meta-media-origin.policy.spec.ts`             | 205–265 authored source/spec lines | WU4B1.1 (policy half): HTTPS only, no userinfo/query/fragment, port 443 with explicit non-production test seam, exact/label-boundary allowlist with lowercase and leading-dot normalization, every A/AAAA public via `ipaddr.js`, IPv4-mapped classification, hostname-bound pinned lookup (scalar and `options.all`), TLS naming untouched, fixed safe `MetaMediaError` mapping; no HTTP request and no bearer |
| WU4B1B — metadata request composition       | WU4B1A     | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (exclusive handoff to B2) |              250–340 changed lines | WU4B1.1 (composition half) + WU4B1.2: metadata hop, bearer-after-policy, `proxy:false`/`maxRedirects:0`, timeout/signal, focused Jest and scoped quality evidence before the B2 handoff                                                                                                                                                                                                                         |

- [x] **WU4B1A.1 RED (WU4B1 policy half):** write the absent `meta-media-origin.policy.spec.ts` first and capture the absent-module failure before adding the production policy file; cover every proof in the WU4B1A row above. <!-- sdd-owner: implementation -->
- [x] **WU4B1A.2 GREEN (WU4B1 policy half):** implement only the reusable origin/DNS policy in `meta-media-origin.policy.ts` with resolver failures and policy rejections mapped to the fixed safe `MetaMediaError`; no HTTP request, no bearer, no client file. <!-- sdd-owner: implementation -->
- [x] **WU4B1A.3 TRIANGULATE (WU4B1 policy half):** parameterize adjacent boundaries: label-boundary near-misses, seam-port versus 443, mapped-private versus mapped-public, one-private-among-public, and empty resolver results. <!-- sdd-owner: implementation -->
- [x] **WU4B1A.4 REFACTOR:** consolidate policy helpers in the two owned files without widening scope toward transport, redirects, bearer, streaming, temp, hashing, or MIME behavior. <!-- sdd-owner: implementation -->
- [x] **WU4B1A.5 Verify:** run focused Jest on the policy spec, scoped ESLint/Prettier on the two owned files, `git diff --check` (with the untracked-openspec caveat), untracked whitespace checks, and non-incremental TypeScript; record exact evidence, hashes, and the 205–265 line accounting before the B1B handoff. <!-- sdd-owner: implementation -->
- [x] **WU4B1A remediation (RM2):** remediate failed RED evidence `sha256:fcdaeb44d80384ec1622611dd6cdfc150ec98f72e9fe9b1fac64510490d52e36` (6 failed / 31 passed: delimiter-only `?`/`#` plus declared-family mismatch) by rejecting any raw `?`/`#` before WHATWG URL normalization and validating each resolver record's declared family against parsed address syntax (IPv4-mapped IPv6 requires declared family 6), with table consolidation keeping policy+spec at 288 lines and all focused Jest/ESLint/Prettier/whitespace/TypeScript checks passing. <!-- sdd-owner: implementation -->
- [x] **WU4B1.1 RED/GREEN/TRIANGULATE:** implement and prove only metadata-origin/allowlist/public-DNS/pinned-lookup/bearer-after-policy behavior on the B1 shared client surface. <!-- sdd-owner: implementation -->
- [x] **WU4B1.2 Verify:** run focused client Jest and scoped quality checks; record exact evidence and line accounting before B2 handoff. <!-- sdd-owner: implementation -->
- [x] **WU4B1B remediation (RM2, WU4B1B HTTP disposition):** remediate failed independent evidence `sha256:9c0e254c11b9162ebe3e3a168cfaeba57ee9b2ae3b1844f711cb8273216631fd` by extending the fixed safe `MetaMediaErrorCode` union with `HTTP_RETRYABLE` and `HTTP_PERMANENT` under `META_TRANSPORT` and proving via RED-first regression tables that 408/429/representative 5xx map to the fixed safe retryable code, representative other 4xx and unfollowed 3xx to the distinct fixed safe permanent code, and missing/invalid metadata bodies to permanent rather than network-retryable, with client+spec at 340 lines, focused Jest 33/33, and scoped ESLint/Prettier/whitespace/non-incremental TypeScript checks passing. <!-- sdd-owner: implementation -->
- [x] **WU4B2.1 RED/GREEN/TRIANGULATE:** implement and prove only bounded manual redirects and authenticated per-hop download transport on the B2 shared client surface. <!-- sdd-owner: implementation -->
- [x] **WU4B2.2 Verify:** run focused client Jest and scoped quality checks; record exact evidence and line accounting before B3 handoff. <!-- sdd-owner: implementation -->
- [ ] **WU4B3.1 RED/GREEN/TRIANGULATE:** implement and prove only bounded stream/hash/mode-0600 temp-file/MIME agreement and every-path technical cleanup on the B3 shared client surface. <!-- sdd-owner: implementation -->
- [ ] **WU4B3.2 Verify:** run both WU4 focused suites plus scoped quality checks; only then reconcile the original aggregate WU4 checkboxes. <!-- sdd-owner: implementation -->

#### WU4B3A→WU4B3B split (human-authorized narrow port-surface exception)

Human maintainer authorized splitting WU4B3 into two sequential exclusive slices on branch `feat/receipt-media-ingestion-wu04b3-stream-validation`. WU4B3A performs a narrow contract remediation on the port/validator-spec surface; WU4B3B owns the bounded stream/cleanup client implementation and receives the port surface unchanged.

| Slice                                         | Depends on | Exact owned surface                                                                                                                             |               Honest forecast | WU4B3 trace                                                                                                                                                                                       |
| --------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WU4B3A — validated-file contract remediation  | WU4B2      | `src/receipt-media/domain/meta-media.port.ts`; `src/receipt-media/infrastructure/media-structure.validator.spec.ts` (exclusive handoff to B3B)  | 30–80 changed code/spec lines | Contract half of WU4B3.1: `providerDeclaredBytes`, caller-owned idempotent `cleanup()` seam, fixed safe codes `INVALID_MEDIA_SIZE`/`MIME_MISMATCH`/`FILE_IO_FAILURE`, no diagnostics/cause fields |
| WU4B3B — bounded stream and technical cleanup | WU4B3A     | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (final exclusive handoff) |         260–350 changed lines | WU4B3.1 implementation half + WU4B3.2: MIME agreement, byte/hash/temp-file pipeline, mode 0600, overflow/abort/failure unlink, final focused verification                                         |

- [x] **WU4B3A.1 RED:** add a compile-enforced provider-neutral `ValidatedMediaFile` contract fixture requiring `providerDeclaredBytes` and a caller-owned idempotent-callable `cleanup()` ownership seam, plus type-safe construction coverage for `INVALID_MEDIA_SIZE`/`MIME_MISMATCH`/`FILE_IO_FAILURE`; captured 5 contract type errors via non-incremental tsc before editing the port. <!-- sdd-owner: implementation -->
- [x] **WU4B3A.2 GREEN:** in the port only, add `providerDeclaredBytes: number`, document `cleanup()` as caller-owned and idempotent after a successful return, and add exactly `INVALID_MEDIA_SIZE`, `MIME_MISMATCH`, and `FILE_IO_FAILURE` to the fixed safe code union; no arbitrary diagnostics/cause fields. <!-- sdd-owner: implementation -->
- [x] **WU4B3A.3 TRIANGULATE:** widen the existing provider-neutral adapter fixture to the new members, prove repeated `cleanup()` calls against the ownership seam without claiming filesystem-implementation evidence, and confirm all existing JPEG/PNG structural behavior is unchanged. <!-- sdd-owner: implementation -->
- [x] **WU4B3A.4 Verify:** focused validator Jest 49/49 (baseline 45/45), combined WU4 focused suites 111/111, scoped ESLint/Prettier clean, `git diff --check` clean, non-incremental production tsc 0 errors, port+spec diff 47/80 lines. <!-- sdd-owner: implementation -->

#### WU4B3B final split recovery (WU4B3B1a → WU4B3B1b → WU4B3B2; human-authorized)

Human maintainer authorized the final sequential split on the metadata-contract boundary after the first B3B1 split attempt (WU4B3B1 → WU4B3B2) timed out at 542 implemented lines against its 350 cap. That failed attempt is preserved only as failed evidence `sha256:6d2e72c778ae1e3f12ef0a35877e6bb1ddfdf0d1df7c703b61cfaddedc9e35a9`, with its oversized green candidate readable only as read-only reference at commit `7eefdd56492ff41bbc198d0e96355bd7f7154ed1` / tree `64f24cfe6c40d16ece7c15ae94ec342d9ccce9b9`; neither supplies TDD evidence. WU4B3B1a owns the metadata contract/projection only; WU4B3B1b owns the successful bounded stream pipeline; WU4B3B2 owns the failure matrix and cleanup; the client surface transfers exclusively and never concurrently.

| Slice                                          | Depends on | Exact owned surface                                                                                                                                | Honest forecast              | WU4B3B trace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WU4B3B1a — metadata contract and projection    | WU4B3A     | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (exclusive handoff to B3B1b) | ≤250 changed lines           | Contract foundation of WU4B3.1: infrastructure-local metadata projection (download URL, canonical `image/jpeg`/`image/png`, `providerDeclaredBytes`); runtime-invalid declared MIME rejected before bearer/request; missing/unsupported metadata `mime_type` rejected; declared-vs-provider mismatch → `MEDIA_VALIDATION/MIME_MISMATCH`; `file_size` missing/wrong type/non-safe/non-integer/zero/negative/10_485_761 → `INVALID_MEDIA_SIZE`; missing/empty/non-string URL remains `HTTP_PERMANENT`; invalid metadata makes exactly the metadata call and no download request; `resolveDownloadUrl()` return and every B1/B2 assertion preserved                           |
| WU4B3B1b — bounded stream pipeline             | WU4B3B1a   | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (exclusive handoff to B3B2)  | remaining B3B1 success cases | Success half of WU4B3.1: `resolveAndDownload()` exactly one metadata call then verified download chain; minimal JPEG/PNG Readable streams; full-write `FileHandle` progress loop honoring `bytesWritten` (remediation-corrected); present-matching and absent content-length; providerDeclaredBytes/byteCount/SHA-256/agreed MIME; random mode-0600 exclusive temp under tmpdir with idempotent cleanup; final release once after settlement. Response Content-Type handling is explicitly WU4B3B2 scope; the earlier "content-type parameter stripping" claim was vacuous (no B3B1b Content-Type decision exists to prove) and is superseded by the remediation row below |
| WU4B3B2 — failure matrix and technical cleanup | WU4B3B1b   | `src/receipt-media/infrastructure/meta-media.client.ts`; `src/receipt-media/infrastructure/meta-media.client.spec.ts` (final exclusive handoff)    | remaining WU4B3.1 cases      | Failure half of WU4B3.1 + WU4B3.2: full MIME/size/structure/content-length matrices, mid-stream error/abort, deterministic temp open/write/read-back failures via the injectable factory seam, final focused verification and aggregate WU4 reconciliation                                                                                                                                                                                                                                                                                                                                                                                                                 |

- [x] **WU4B3B1a.1 RED/GREEN/TRIANGULATE:** implement and prove only the infrastructure-local metadata projection on the B3B1a client surface: RED 18 failed / 62 passed (every new case `resolveMetadata is not a function`, all 62 B1/B2 assertions green); GREEN internal `fetchMetadata` hop refactor plus `projectMetadata`/`resolveMetadata` with `resolveDownloadUrl()` return preserved; TRIANGULATE size 1 and 10_485_760 accepted against 0/−1/1.5/non-safe/10_485_761, canonical versus unsupported versus mismatched MIME, URL missing/empty/non-string; no `resolveAndDownload`, streams, temp files, hashing, or response headers implemented. <!-- sdd-owner: implementation -->
- [x] **WU4B3B1a.2 Verify:** combined WU4 focused Jest 130/130 (client 81 + validator 49; 62 B1/B2 preserved); scoped ESLint/Prettier clean; `git diff --check` clean; trailing-whitespace/tab scans clean; non-incremental production tsc 0 errors; final client/spec diff exactly 250 changed lines (client 105+/11−, spec 132+/2−) against the delegated ≤250 cap. <!-- sdd-owner: implementation -->
- [x] **WU4B3B1b.1 RED/GREEN/TRIANGULATE:** implement and prove the successful bounded stream pipeline on the B3B1b client surface per the WU4B3B1b row above. <!-- sdd-owner: implementation -->
- [x] **WU4B3B1b.2 Verify:** run both WU4 focused suites plus scoped quality checks and reconcile line accounting before the B3B2 handoff. <!-- sdd-owner: implementation -->
- [x] **WU4B3B1b remediation (RM2):** remediate failed independent evidence `sha256:2c106c41995b1bdbc328d1812eed2cdd7ebcb207ca51c90f4fc604076a660743`, which invalidated the prior passing evidence `sha256:4359ec2b04d5a38331ee88918f7c4f89793756071e15369abaa04882ebc899fe` (failure history preserved, not erased): (1) ignored `FileHandle` short writes — `resolveAndDownload` now persists every chunk byte through a full-write loop that honors `bytesWritten`, advances by actual progress, retries the unwritten suffix, and rejects void/zero/negative/fractional/non-safe/over-length progress fail-closed as `META_TRANSPORT/FILE_IO_FAILURE` with technical cleanup, RED-proven by reverting the loop (partial-write success case and all four zero/invalid-progress regressions failed with `MIME_MISMATCH`: 5 failed / 93 passed) then GREEN 140/140; (2) the claimed Content-Type parameter-stripping evidence was vacuous — the B3B1b client makes no response-Content-Type decision and the fake transport seam cannot prove header normalization, so the assertion and its claims are removed and response-header guards are explicitly WU4B3B2 scope; (3) successful `resolveAndDownload()` tests leaked temp files — every success result (repeated, concurrent, and partial-write cases) now invokes caller-owned idempotent `cleanup()` inside `finally` with a suite-level residue guard, and two clean focused runs each proved zero current-user regular `/tmp/receipt-media-*` files afterwards. Final client+spec diff exactly 400 changed lines (client 146+/3−, spec 247+/4−) against HEAD `6384b1a`. Evidence revision `sha256:121bee1df5c532885f584c93bf08edafbe10ef99cf9e5f91f52fd942551a7fd2`. <!-- sdd-owner: implementation -->
- [ ] **WU4B3B2.1 RED/GREEN/TRIANGULATE:** implement and prove the failure matrix and every-path technical cleanup on the B3B2 client surface. <!-- sdd-owner: implementation -->
- [ ] **WU4B3B2.2 Verify:** run both WU4 focused suites plus scoped quality checks; only then reconcile the original aggregate WU4 checkboxes. <!-- sdd-owner: implementation -->

#### WU4B3B2 remediation split (WU4B3B2-R1 → WU4B3B2-R2; human-authorized)

Human maintainer authorized a sequential split of the WU4B3B2 remediation after one honest compaction still left the combined candidate at 452 changed lines (client `sha256:1131b58a…` 83+/14−, spec `sha256:f4ad1fb5…` 351+/4−). **R1** owns the safe cleanup/unlink error projection and visibility, the genuine void `bytesWritten` proof, explicit descriptor lifetime (no GC-close), and the two mandated correctness fixes (Prettier line shape at `failedStep`; structural removal of the unsafe `throw` from `finally`). **R2 (deferred)** owns only the new real mid-stream `AbortController.abort()` production observation and its specific new test/triangulation, requiring a later child boundary after separate commit/branch authorization. Failure history is preserved, not erased: the invalidated 299-line apply and its failed independent evidence `sha256:96a57da5b4d2326b42cc1dd7ee99d95e2b2cf277feba4c17c21f26afee28d1b6`, and the 452-line combined remediation candidate, are candidate/failed history only — no completion evidence.

| Slice                                             | Depends on              | Exact owned surface                                                                  | Honest scope                                                                                              | Status                                                                                                                                                              |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WU4B3B2-R1 — cleanup projection, void progress, descriptor lifetime | WU4B3B1b | `meta-media.client.ts`; `meta-media.client.spec.ts` (R1 partition of the combined candidate) | R1 partition + correctness fixes only; R2 real-signal additions removed; no second compaction pass authorized | **BLOCKED on budget: 422 changed lines vs `418829f` (client 76+/16−, spec 326+/4−) exceeds the ≤400 cap; functionally green (168/168 combined ×2, temp 0 ×2, no warnings, ESLint/Prettier/diff-check/whitespace/tsc clean) — human decision required: size:exception, further boundary split, or reset** |
| WU4B3B2-R2 — real mid-stream AbortSignal observation (deferred) | WU4B3B2-R1 acceptance | `meta-media.client.ts`; `meta-media.client.spec.ts` (later child)                    | real mid-stream `AbortController.abort()` production observation + its new RED-first test/triangulation   | pending later child boundary after separate commit/branch authorization                                                                                             |

- [ ] **WU4B3B2-R1.1:** R1 partition applied and verified green (full evidence in `apply-progress.md`, revision `sha256:4b36bf5452f8fcbca06154c9d6e7356a27692d217e0772ead9845aea9ebcc76c`); acceptance withheld solely on the ≤400-line budget (422/400) — human decision required. <!-- sdd-owner: implementation -->
- [ ] **WU4B3B2-R2.1:** implement the real mid-stream `AbortController.abort()` production observation with RED-first test/triangulation in a later authorized child slice. <!-- sdd-owner: implementation -->

#### WU4B3B2 remediation three-way split (WU4B3B2R1A → WU4B3B2R1B → WU4B3B2R2; human-authorized)

Human maintainer authorized a reset of the R1 remediation candidate and a further sequential three-way split after R1 landed functionally green but at 422 changed lines (22 over the ≤400 cap). **R1A** preserves the already verified base WU4B3B2 failure matrix plus only two verifier-remediation deltas: (1) the genuine undefined/void `FileHandle.write` progress proof — exercised and safely rejected with fixed `META_TRANSPORT/FILE_IO_FAILURE` without looping forever or leaking detail; (2) the close-failure fixture (`closedFdFactory`) that explicitly owns and releases its descriptor so no fd-GC/deprecation warning can occur. **R1B (pending)** owns the R1-only safe cleanup projection removed from R1A: the raw successful-cleanup unlink rejection projection and the surfaced failure-path close/unlink failures (client `failedStep`/catch-flow restructure/projection `cleanup`, plus the `OVERFLOW`/`dirSwapFactory`-based tests and the `{ created, err }` harness returns). **R2 (pending)** keeps only the real mid-stream `AbortController.abort()` production observation; its listener/test remain absent from this tree. Aggregate WU4/WU4B3B2 stays pending until R1A, R1B, and R2 are all independently accepted.

| Slice | Depends on | Exact owned surface | Honest scope | Status |
| --- | --- | --- | --- | --- |
| WU4B3B2R1A — void progress proof + descriptor-safe close fixture on the base failure matrix | WU4B3B1b | `meta-media.client.ts`; `meta-media.client.spec.ts` (R1A partition of the R1 candidate) | base WU4B3B2 failure matrix preserved; R1A deltas only; R1B cleanup projection and R2 real-signal additions removed/restored to settled WU4B3B2 behavior | applied and verified green at 299 changed lines vs `418829f` (client 48+/5−, spec 244+/2−) — within the ≤400 cap |
| WU4B3B2R1B — safe cleanup projection (deferred) | WU4B3B2R1A acceptance | `meta-media.client.ts`; `meta-media.client.spec.ts` (later child) | raw successful-cleanup unlink projection + surfaced failure-path close/unlink failures and their tests | pending later child boundary |
| WU4B3B2R2 — real mid-stream AbortSignal observation (deferred) | WU4B3B2R1B acceptance | `meta-media.client.ts`; `meta-media.client.spec.ts` (later child) | real mid-stream `AbortController.abort()` production observation + its new RED-first test/triangulation | pending later child boundary |

- [x] **WU4B3B2R1A.1:** R1A partition applied and verified green (full evidence in `apply-progress.md`; 299/400 changed lines, 115/115 focused + 164/164 combined ×2, temp 0 ×2, no fd/deprecation warnings, ESLint/Prettier/diff-check/whitespace/tsc clean). <!-- sdd-owner: implementation -->
- [ ] **WU4B3B2R1B.1:** restore/implement the safe cleanup projection (successful-cleanup unlink projection and surfaced failure-path close/unlink failures) with RED-first tests in a later authorized child slice. <!-- sdd-owner: implementation -->
- [ ] **WU4B3B2R2.1:** implement the real mid-stream `AbortController.abort()` production observation with RED-first test/triangulation in a later authorized child slice. <!-- sdd-owner: implementation -->

### WU5 — Private S3 adapter

**Depends on:** WU1C2B2, WU2B. **Finish/rollback:** validated media has private put/get/head and technical cleanup only; accepted objects are never deleted.

**Owned surface:** `src/receipt-media/domain/object-storage.port.ts`, `src/receipt-media/infrastructure/s3-object-storage.adapter.ts`, `src/receipt-media/infrastructure/s3-object-storage.adapter.spec.ts`.

- [ ] **1. RED (RMA1, RM2):** add failing owned adapter contract cases for private put/get/head, abort, compensating delete, and no public ACL/key leakage. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (RMA1):** implement the neutral port and SDK v3 adapter with `PutObjectCommand`, `GetObjectCommand`, `HeadObjectCommand`, `DeleteObjectCommand`, configured endpoint/region/bucket/path style, and `receipts/<uuid-v4>` keys. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (RM2, RM6):** prove random non-PII keys, abort/overflow/upload-failure compensation, retryable cleanup-pending, and no delete on every `STORED` or terminal accepted-media path. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** keep AWS types within infrastructure and normalize stream/abort/error mapping at the port. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/infrastructure/s3-object-storage.adapter.spec.ts` and `pnpm exec eslint src/receipt-media/domain/object-storage.port.ts src/receipt-media/infrastructure/s3-object-storage.adapter.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU6 — Capability access

**Depends on:** WU2B, WU5. **Finish/rollback:** stable hash-only GET/HEAD access is private and rotation-safe; do not remove deployed route/keyring after attachment.

**Owned surface:** `src/receipt-media/application/capability.service.ts`, `src/receipt-media/presentation/receipt-media-access.controller.ts`, `src/receipt-media/application/capability.service.spec.ts`, `src/receipt-media/presentation/receipt-media-access.controller.spec.ts`.

- [ ] **1. RED (RMA2, RMA3):** add failing token parsing, HMAC rotation/restart, hash lookup/dummy comparison, generic 404, GET/HEAD, 416, and header cases. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (RMA2, RMA3):** implement derivation, old-key retention/active issuance, revocation, private stream/head, and fixed JPEG/PNG safe headers. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (RMA2):** assert indistinguishable malformed/altered/revoked/missing-object/storage-failure responses and redacted log output. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** keep controller thin and object storage behind the port. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/application/capability.service.spec.ts src/receipt-media/presentation/receipt-media-access.controller.spec.ts` and `pnpm exec eslint src/receipt-media/application/capability.service.ts src/receipt-media/presentation/receipt-media-access.controller.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU7 — Receipt ingress admission service

**Depends on:** WU2B, WU3. **Finish/rollback:** TX1 reservation/causality is explicit before HTTP 200; remove ingress service without worker changes.

**Owned surface:** `src/receipt-media/application/receipt-ingress.service.ts`, `src/receipt-media/application/receipt-ingress.service.spec.ts`.

- [ ] **1. RED (RM1, WA2):** add failing TX1 cases for dedup, captured placed sale, active-flow gate, kill-switch/no-sale/unsupported decisions, durable causality, and rollback/no worker or outbox action. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (RM1, WA2):** implement atomic ingress reservation and deterministic decision service with no amount-prompt intent before storage. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (RM1, RM4):** prove same webhook/different media rejection, provider-media redelivery reuse, simultaneous first-image conflict, overlapping rejection, and a sequential terminal receipt. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** normalize admission result types and preserve immutable inbound/receipt identities. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/application/receipt-ingress.service.spec.ts` and `pnpm exec eslint src/receipt-media/application/receipt-ingress.service.ts src/receipt-media/application/receipt-ingress.service.spec.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU8 — Ingestion processor and ingestion worker

**Depends on:** WU2B, WU4, WU5, WU7. **Finish/rollback:** claimed rows process with external calls outside transactions; stop this worker to drain safely.

**Owned surface:** `src/receipt-media/application/receipt-ingestion.processor.ts`, `src/receipt-media/infrastructure/receipt-media-ingestion.worker.ts`, `src/receipt-media/application/receipt-ingestion.processor.spec.ts`, `src/receipt-media/infrastructure/receipt-media-ingestion.worker.spec.ts`.

- [ ] **1. RED (RM2, RM3):** add failing owned cases for pre-call CAS counters 1/2/3, no fourth Meta/storage call, no network transaction, lease ownership, `SKIP LOCKED`, and restart recovery. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (RM2, RM3):** implement processor progression Meta-to-temp-to-S3, retries/terminal stages/TX2 insertion, plus lifecycle-managed claim/poll/wake worker. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (RM2, RM3):** fault-inject competing workers, lease loss abort, shutdown drain, crash at durable/external boundaries, lost-temp reconstruction, independent exhaustion, and committed-only restart outbox drain. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** ensure bootstrap tracks the loop and destroy stops claims, aborts transports, awaits work, and introduces no broker/detached promise. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/application/receipt-ingestion.processor.spec.ts src/receipt-media/infrastructure/receipt-media-ingestion.worker.spec.ts` and `pnpm exec eslint src/receipt-media/application/receipt-ingestion.processor.ts src/receipt-media/infrastructure/receipt-media-ingestion.worker.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU9 — Notification worker

**Depends on:** WU3, WU8. **Finish/rollback:** only committed inbound-caused intents send at least once; stop claims without inventing intent.

**Owned surface:** `src/receipt-media/infrastructure/receipt-media-notification.worker.ts`, `src/receipt-media/infrastructure/receipt-media-notification.worker.spec.ts`.

- [ ] **1. RED (WA2):** add failing committed-row-only claim, no LLM, exact sender text, retry-through-three, and send-before-mark-`SENT` crash cases. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (WA2):** implement leased pending/expired-sending drain through `WhatsappSenderPort`, provider wamid bookkeeping, reschedule/exhaustion alerting, and no proactive path. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (WA2):** prove concurrent/restart drain, byte-identical at-least-once replay, CAS loser handling, failed-send exhaustion, and rejected `AgentRunner`/`LlmAgentPort` invocation. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** normalize shutdown/lease helpers locally without extending sender or LLM authority. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/infrastructure/receipt-media-notification.worker.spec.ts` and `pnpm exec eslint src/receipt-media/infrastructure/receipt-media-notification.worker.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU10 — Amount router and conversation pointer

**Depends on:** WU2B, WU3, WU8. **Finish/rollback:** deterministic MXN routing owns pointer state; remove this integration while retaining receipts.

**Owned surface:** `src/receipt-media/domain/amount-parser.ts`, `src/receipt-media/application/receipt-amount-router.service.ts`, `src/conversation/domain/conversation-store.ts`, `src/conversation/infrastructure/postgres-conversation.store.ts`, `src/receipt-media/domain/amount-parser.spec.ts`, `src/receipt-media/application/receipt-amount-router.service.spec.ts`, `src/conversation/infrastructure/postgres-conversation.store.spec.ts`.

- [ ] **1. RED (RM5, CS1, CS2):** add failing caption/follow-up, cents, confirmation/cancel, pointer patch/clear, stale repair, and sibling preservation cases. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (RM5, CS1):** implement bounded numeric/Spanish MXN parsing, exactly-one policy, router transitions/templates, and narrow JSONB set/clear pointer operations. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (RM5, CS2):** test `$1,234.50`, `1234`, Spanish cents, malformed grouping/decimal comma/zero/overflow/multiple candidates, affirmative/no/cancel variants, agent fresh writes, and sale-B never retargeting sale-A. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** centralize typed pointer/template helpers and keep caption/protected identifiers out of persistence/model context. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/domain/amount-parser.spec.ts src/receipt-media/application/receipt-amount-router.service.spec.ts src/conversation/infrastructure/postgres-conversation.store.spec.ts` and `pnpm exec eslint src/receipt-media/domain/amount-parser.ts src/receipt-media/application/receipt-amount-router.service.ts src/conversation/domain/conversation-store.ts src/conversation/infrastructure/postgres-conversation.store.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU11 — Backend attachment transport

**Depends on:** WU1C2B2, WU2B, WU6, WU8. **Finish/rollback:** one abortable §4.4.7 POST follows confirmation; request-start evidence prevents replay.

**Owned surface:** `src/chatbot-api/domain/chatbot-api.client.ts`, `src/chatbot-api/infrastructure/chatbot-api-http.client.ts`, `src/receipt-media/application/receipt-attachment.service.ts`, `src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts`, `src/receipt-media/application/receipt-attachment.service.spec.ts`.

- [ ] **1. RED (API1, API2):** add failing durable-wire-value, Axios timeout-plus-signal, one-POST, and complete success/definite/unknown taxonomy cases. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (API1, RM3):** add caller transport options to the exact client seam and implement attachment pre-request CAS/request UUID plus captured-sale/stable-URL service. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (API1):** assert 201 valid `PENDING`; 400/401/403/404/409/422/429 definite; 408, 5xx, timeout, abort, DNS/socket/network, malformed/unexpected response, process/lease loss, and default unknown/no retry; prove stub observes abort and source has no `Promise.race`. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** centralize classifier/safe evidence mapping without response bodies, auth, URLs, or protected identifiers in logs/context. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts src/receipt-media/application/receipt-attachment.service.spec.ts` and `pnpm exec eslint src/chatbot-api/domain/chatbot-api.client.ts src/chatbot-api/infrastructure/chatbot-api-http.client.ts src/receipt-media/application/receipt-attachment.service.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU12 — Sale-flow authority repair

**Depends on:** WU10, WU11. **Finish/rollback:** receipt action is server-owned and the 12-tool registry/literals remain compatible.

**Owned surface:** `src/sale-flow/application/tools/attach-receipt.tool.ts`, `src/sale-flow/application/tools/tool-deps.ts`, `src/sale-flow/infrastructure/real-tool-registry.ts`, `src/sale-flow/domain/sale-flow-instructions.ts`, `src/sale-flow/application/tools/attach-receipt.tool.spec.ts`, `src/sale-flow/application/tools/tool-contract.spec.ts`, `src/sale-flow/infrastructure/real-tool-registry.spec.ts`, `src/sale-flow/domain/sale-flow-instructions.spec.ts`.

- [ ] **1. RED (SFT1, SFT2, LLM2):** add failing strict-empty input, no side effect/protected context, exact instruction literal, registry count, and terminal guidance cases in the named specs. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (SFT1, SFT2):** implement compatibility-only tool, exact registry dependencies, and step-13 authority repair while preserving unrelated payment/handoff/cancel/ops literals. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (SFT1, SFT2):** prove model saleId/URL/key/token/capability/pending-media cannot reach §4.4.7; sale-A wins over sale-B; missing sale makes no call; R7/R14/steps 12/14 composed-once strings remain byte-identical. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** keep semantic status narrow and do not couple workers to `AgentRunner`. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/sale-flow/application/tools/attach-receipt.tool.spec.ts src/sale-flow/application/tools/tool-contract.spec.ts src/sale-flow/infrastructure/real-tool-registry.spec.ts src/sale-flow/domain/sale-flow-instructions.spec.ts` and `pnpm exec eslint src/sale-flow/application/tools/attach-receipt.tool.ts src/sale-flow/application/tools/tool-deps.ts src/sale-flow/infrastructure/real-tool-registry.ts src/sale-flow/domain/sale-flow-instructions.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU13 — WhatsApp normalization and routing

**Depends on:** WU7, WU9, WU10, WU12. **Finish/rollback:** signed media admission is delegated before early 200 and precedence remains intact.

**Owned surface:** `src/whatsapp/presentation/dto/webhook-event.dto.ts`, `src/whatsapp/domain/inbound-message.ts`, `src/whatsapp/application/webhook-dispatcher.service.ts`, `src/whatsapp/presentation/webhook.controller.ts`, `src/whatsapp/presentation/dto/webhook-event.dto.spec.ts`, `src/whatsapp/application/webhook-dispatcher.service.spec.ts`, `src/whatsapp/presentation/webhook.controller.spec.ts`.

- [ ] **1. RED (WA1, WA2, WA3):** add failing image/document normalization, raw-signature preservation, early-200 admission, atomic rollback, and full collaborator-order cases. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (WA1, WA3):** implement DTO/domain normalization and dispatcher/controller delegation to ingress without Meta/S3/backend details. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (WA1–WA3):** assert echo → durable dedup → ops → pending-human → kill-switch → active receipt → supported admission → text, including ops media, PDF, no sale, overlap, sequential terminal, caption/follow-up, and non-receipt image guidance. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** preserve canonical text/handoff/ops behavior and ensure failed admission starts neither worker nor notification. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/whatsapp/presentation/dto/webhook-event.dto.spec.ts src/whatsapp/application/webhook-dispatcher.service.spec.ts src/whatsapp/presentation/webhook.controller.spec.ts` and `pnpm exec eslint src/whatsapp/presentation/dto/webhook-event.dto.ts src/whatsapp/domain/inbound-message.ts src/whatsapp/application/webhook-dispatcher.service.ts src/whatsapp/presentation/webhook.controller.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU14 — Final feature-module wiring

**Depends on:** WU1A, WU1B, WU1C2B2, WU2B–WU13. **Finish/rollback:** only this unit composes providers/controllers/modules; disable admission rather than removing deployed access.

**Owned surface:** `src/receipt-media/receipt-media.module.ts`, `src/whatsapp/whatsapp.module.ts`, `src/chatbot-api/chatbot-api.module.ts`, `src/receipt-media/receipt-media.module.spec.ts`, `src/whatsapp/whatsapp.module.spec.ts`, `src/chatbot-api/chatbot-api.module.spec.ts`.

- [ ] **1. RED (AC1, WA2):** add failing module graph cases for required providers/controllers and disabled-admission preservation of text/cancel/handoff/access. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (AC1, WA2):** create the feature module and wire exact dependencies into WhatsApp and chatbot-api modules without cycles. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (WA2):** test enabled/disabled module boot, missing provider failure, and two module instances without duplicate worker loops or unsolicited sends. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** normalize injection tokens/provider exports while preserving the feature boundary. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/receipt-media.module.spec.ts src/whatsapp/whatsapp.module.spec.ts src/chatbot-api/chatbot-api.module.spec.ts` and `pnpm exec eslint src/receipt-media/receipt-media.module.ts src/whatsapp/whatsapp.module.ts src/chatbot-api/chatbot-api.module.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU15 — Telemetry and operations runbook

**Depends on:** WU14. **Finish/rollback:** safe telemetry and operator instructions are reviewable; disable admission while retaining access/keyring.

**Owned surface:** `src/receipt-media/infrastructure/prometheus-receipt-telemetry.ts`, `src/receipt-media/presentation/receipt-metrics.controller.ts`, `src/receipt-media/infrastructure/prometheus-receipt-telemetry.spec.ts`, `src/receipt-media/presentation/receipt-metrics.controller.spec.ts`, `docs/receipt-media-operations.md`.

- [ ] **1. RED (AC3, RM6):** add failing feature metrics/no-identifier-label and disabled-admission cases in the named specs. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (AC3):** implement only required safe admission/jobs/leases/attempts/exhaustion/storage/cleanup/outbox/attach-unknown/capability telemetry and internal metrics endpoint. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE (AC3, RM6):** write owned runbook drills for private bucket policy, TLS/domain, proxy/APM redaction, key rotation, incomplete-multipart-only lifecycle, alerts, drain, storage growth, kill-switch, and no-POST unknown reconciliation. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** remove unnecessary metrics and ensure categories/correlation/internal IDs only; never expose secrets, PII, URLs, tokens, keys, captions, or filenames. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/infrastructure/prometheus-receipt-telemetry.spec.ts src/receipt-media/presentation/receipt-metrics.controller.spec.ts` and `pnpm exec eslint src/receipt-media/infrastructure/prometheus-receipt-telemetry.ts src/receipt-media/presentation/receipt-metrics.controller.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU16 — E2E fault evidence

**Depends on:** WU14, WU15. **Finish/rollback:** fake-service/Testcontainers evidence is isolated to e2e support.

**Owned surface:** `test/receipt-media.e2e-spec.ts`, `test/receipt-media.e2e-fixtures.ts`.

- [ ] **1. RED (RM1–RM5, RMA2–RMA4, WA1–WA3):** add failing signed-image, early-200, worker, private access, amount-confirmation, and one-attach e2e cases. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN:** implement only fake Meta/S3/chatbot API/sender and Testcontainers harness support; never call real services or secrets. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE:** exercise TX1/TX2 crashes, restart/outbox replay, admission rollback, active conflict, lease restart, three-attempt exhaustion, MIME/10-MiB cleanup, SSRF redirect/proxy, attach timeout/shutdown/lease-loss unknown, and GET/HEAD redaction. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** consolidate fakes/fault helpers so assertions stay behavior-facing. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test:e2e -- receipt-media.e2e-spec.ts (scoped e2e selector) and`pnpm exec eslint test/receipt-media.e2e-spec.ts test/receipt-media.e2e-fixtures.ts`; record exact results. <!-- sdd-owner: implementation -->

### WU17 — Traceability and final validation

**Depends on:** WU1A, WU1B, WU1C2B2, WU2B–WU16. **Finish/rollback:** all 24 requirements/87 scenarios have post-implementation evidence; documentation/test-only changes are removable.

**Owned surface:** `docs/receipt-media-spec-trace.md`, `src/receipt-media/receipt-media.trace.spec.ts`.

- [ ] **1. RED (all 24 requirements / 87 scenarios):** create the owned trace ledger with one initially unverified row per exact scenario heading, requirement ID, owning test/assertion, result, and evidence date; add a failing inventory assertion for 24/87. <!-- sdd-owner: implementation -->
- [ ] **2. GREEN (all 24 requirements / 87 scenarios):** link every ledger row to its completed named test/integration/e2e assertion and mark passing only after that command ran; reserve `N/A` for owner staging checks only. <!-- sdd-owner: implementation -->
- [ ] **3. TRIANGULATE:** independently compare all eight `openspec/changes/receipt-media-ingestion/specs/*/spec.md` files to the ledger and resolve missing, duplicate, or broad links. <!-- sdd-owner: implementation -->
- [ ] **4. REFACTOR:** normalize durable-state/template terminology and redact identifiers, URLs, and secrets from evidence. <!-- sdd-owner: implementation -->
- [ ] **5. Verify:** run `pnpm test -- src/receipt-media/receipt-media.trace.spec.ts (scoped), then unscoped`pnpm test`,`pnpm test:cov`(confirm >=80%),`pnpm build`, and`pnpm test:e2e`; run`pnpm exec eslint src/receipt-media/receipt-media.trace.spec.ts`; record scope and exact results. <!-- sdd-owner: implementation -->

## Detailed review workload forecast

| Work unit                                  |      Production |           Tests |        Docs |   Migration | Lockfile | Estimated changed lines | Review boundary               |
| ------------------------------------------ | --------------: | --------------: | ----------: | ----------: | -------: | ----------------------: | ----------------------------- |
| WU1A approved deps/lockfile                |             3–5 |           15–25 |           0 |           0 |      342 |                 360–372 | WU1A only                     |
| WU1B disabled config model                 |         115–140 |           45–65 |           0 |           0 |        0 |                 160–205 | WU1B only                     |
| WU1C1 conditional validation foundation    |         110–140 |         120–170 |           0 |           0 |        0 |                 230–310 | WU1C1 only; precedes WU1C2A   |
| WU1C2A numeric relational bounds           |           55–75 |           55–85 |           0 |           0 |        0 |                 110–160 | WU1C2A only; follows WU1C1    |
| WU1C2B1 capability keyring validation      |           45–65 |          85–115 |           0 |           0 |        0 |                 130–180 | WU1C2B1 only; follows WU1C2A  |
| WU1C2B2 validation error redaction         |           35–55 |          75–105 |           0 |           0 |        0 |                 110–160 | WU1C2B2 only; follows WU1C2B1 |
| WU2A1 core schema/types                    |         100–140 |         110–150 |           0 |      90–110 |        0 |                 300–400 | WU2A1 only; precedes WU2A2A   |
| WU2A2A lifecycle/evidence/lease predicates |             0–5 |         100–145 |           0 |     120–190 |        0 |                 220–340 | WU2A2A only; follows WU2A1    |
| WU2A2B partial indexes/down guards         |             0–5 |           45–85 |           0 |      75–140 |        0 |                 120–230 | WU2A2B only; follows WU2A2A   |
| WU2B store port/primitives                 |         120–155 |         110–150 |           0 |           0 |        0 |                 230–305 | WU2B only; follows WU2A2B     |
| WU3 lifecycle/outbox                       |          85–110 |          80–125 |           0 |           0 |        0 |                 165–235 | WU3 only                      |
| WU4 Meta/validation                        |         150–180 |         165–190 |           0 |           0 |        0 |                 315–370 | WU4 only                      |
| WU5 S3 adapter                             |          90–110 |          95–115 |           0 |           0 |        0 |                 185–225 | WU5 only                      |
| WU6 capability access                      |         125–150 |         130–160 |           0 |           0 |        0 |                 255–310 | WU6 only                      |
| WU7 ingress                                |         100–125 |         115–140 |           0 |           0 |        0 |                 215–265 | WU7 only                      |
| WU8 ingestion worker                       |         145–175 |         165–195 |           0 |           0 |        0 |                 310–370 | WU8 only                      |
| WU9 notification worker                    |          95–120 |         105–125 |           0 |           0 |        0 |                 200–245 | WU9 only                      |
| WU10 amount/pointer                        |         125–150 |         140–165 |           0 |           0 |        0 |                 265–315 | WU10 only                     |
| WU11 attach transport                      |         125–150 |         150–180 |           0 |           0 |        0 |                 275–330 | WU11 only                     |
| WU12 sale/LLM repair                       |          80–100 |         110–135 |           0 |           0 |        0 |                 190–235 | WU12 only                     |
| WU13 WhatsApp routing                      |         130–155 |         155–180 |           0 |           0 |        0 |                 285–335 | WU13 only                     |
| WU14 module wiring                         |         100–165 |          70–100 |           0 |           0 |        0 |                 170–265 | WU14 only                     |
| WU15 telemetry/runbook                     |           70–90 |           45–80 |     110–145 |           0 |        0 |                 225–315 | WU15 only                     |
| WU16 E2E                                   |           25–40 |         160–200 |           0 |           0 |        0 |                 185–240 | WU16 only                     |
| WU17 trace/final                           |               0 |           20–40 |     160–210 |           0 |        0 |                 180–250 | WU17 only                     |
| **Total**                                  | **2,028–2,575** | **2,465–3,225** | **270–355** | **285–440** |  **342** |         **5,390–6,937** | **25 boundaries, each <=400** |

**Mechanical forecast check:** each row total equals its five categories; category totals sum to `2,028–2,575 + 2,465–3,225 + 270–355 + 285–440 + 342 = 5,390–6,937`. WU1A retains the known 342-line lockfile and remains 360–372 with its compact package/spec delta. WU1C1 is 230–310, WU1C2A is 110–160, WU1C2B1 is 130–180, and WU1C2B2 is 110–160, with their shared-file ownership explicitly sequential (`WU1C1 → WU1C2A → WU1C2B1 → WU1C2B2`). WU2A1 is 300–400, WU2A2A is 220–340, and WU2A2B is 120–230, with migration/shared-spec ownership exclusively sequenced (`WU2A1 → WU2A2A → WU2A2B → WU2B`) and durable types owned by WU2A1 unless a strictly necessary correction is required. WU2B is 230–305. Every work unit and proposed review boundary has an upper estimate of 400 or less. The total delivery burden remains high and will use the resolved bounded feature-branch chain before apply.

## Deferred parent/owner actions (not implementation completion)

- [x] 1. Record the human-approved bounded `feature-branch-chain` delivery: draft/no-merge tracker, child 1 targets tracker, each later child targets its immediate predecessor, and only the tracker integrates the final feature to `main`; this records no authorization to commit, push, create PRs, or publish. <!-- sdd-owner: parent -->
- [ ] 2. Provision and attest bucket policy, endpoint/region, credential delivery, stable domain/TLS, proxy/APM capability-path redaction, rate limits, key backup, and incomplete-multipart-only lifecycle using `docs/receipt-media-operations.md`. <!-- sdd-owner: parent -->
- [ ] 3. Run owner-provisioned staging drills for signed Meta webhook, browser capability access, TX1/TX2 recovery, worker drain/shutdown, proxy redaction, storage monitoring, and kill-switch before enabling admission. <!-- sdd-owner: parent -->
- [ ] 4. Escalate backend tenant-isolation and §4.4.7 idempotency concerns to the backend owner as read-only cross-repository risks. <!-- sdd-owner: parent -->
- [ ] 5. Start or reuse bounded review after apply using the selected strategy and one <=400-line boundary at a time; obtain user authorization before commit, push, or PR action. <!-- sdd-owner: parent -->

## Planning validation

- Revised work units: **25** (WU1A → WU1B → WU1C1 → WU1C2A → WU1C2B1 → WU1C2B2 → WU2A1 → WU2A2A → WU2A2B → WU2B → WU3 … WU17); the dependency graph is acyclic.
- Implementation checkboxes: **125** (five per work unit); parent checkboxes: **5**; total checkboxes: **130**.
- Completed checkboxes are **36/130**: WU1A **5**, WU1B **5**, WU1C1 **5**, WU1C2A **5**, WU1C2B1 **5**, WU1C2B2 **5**, WU2A1 **5**, and delivery strategy **1**; **94** remain unchecked.
- Each mutable implementation/test/doc target is owned by exactly one work-unit surface, except `src/config/env.validation.ts` and `src/config/env.validation.spec.ts` (explicitly sequential WU1C1 → WU1C2A → WU1C2B1 → WU1C2B2), `migrations/2000000000000_receipt_media.js` (explicitly sequential WU2A1 → WU2A2A → WU2A2B), and `src/receipt-media/infrastructure/postgres-receipt-media.store.spec.ts` (explicitly sequential WU2A1 → WU2A2A → WU2A2B → WU2B); `receipt-media.types.ts` is WU2A1-owned except a strictly required WU2A2A correction. Commands and read-only specification references are excluded.
- `receipt-media-store.port.ts` and `postgres-receipt-media.store.ts` are exclusively WU2B after WU2A2B; `receipt-outbox.service.ts` is exclusively WU3; ingress and its focused spec are exclusively WU7; ingestion and notification workers are distinct WU8/WU9 files; `receipt-media.module.ts` is exclusively WU14; the trace ledger is created only in WU17.
