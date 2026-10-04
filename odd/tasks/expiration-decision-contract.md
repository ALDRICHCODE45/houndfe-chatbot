# Task: EXPIRATION human-decision contract alignment (docs + first local bot unit)

**Status:** Backend source for EXPIRATION intake/receipt is implemented (read-only reference, parent-observed HEAD `cde0f58`; parent-verified, **NOT independently verified and NOT deployment proof**). The frontend remains an independent phase, still pending. By owner authorization the bot proceeds locally in parallel instead of serializing behind a validated backend delivery. The bot's strict intake normalizer (committed `939dd10`, native-approved) and its EXPIRATION receipt normalizer (committed `8b560fc`) are implemented, the EXPIRATION HTTP transport method (`submitExpirationIntake`, committed `384dd0f`) is implemented but **not wired to runtime**, the GET current-state projection normalizer (`normalizeExpirationDecision`, committed `dfd636a`, reviewed+approved `review-0472792d690fb0d1`) is implemented, and the EXPIRATION GET HTTP transport method (`getExpirationDecision`, implemented locally but not yet committed or wired) is implemented — `partial`: **intake + receipt + POST/GET HTTP transport + GET current-state projection normalizer implemented**; runtime wiring, E2E, and activation remain deliberately deferred. No push/deploy/activation/production.
**Deliverable:** the two aligned docs (`docs/human-decisions-expiration-v1.md`, this tracker) plus the bot's local units `src/chatbot-api/domain/dtos/human-decisions-expiration.dto.ts` (+`.spec.ts`, committed `939dd10`, native-approved), `src/chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto.ts` (+`.spec.ts`, committed `8b560fc`), `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` (EXPIRATION `submitExpirationIntake`, committed `384dd0f`; EXPIRATION `getExpirationDecision` GET transport), and `src/chatbot-api/domain/dtos/human-decisions-expiration-decision.dto.ts` (+`.spec.ts`, committed `dfd636a`, reviewed+approved `review-0472792d690fb0d1`). Baseline `939dd10`; earlier baseline `47a0cf3`.

## Authorized unit (docs + intake normalizer)

- [x] Read both docs, then realign them to the agreed contract.
- [x] Preserve the four owner-approved business rules.
- [x] Record the agreed wire, freshness, text, and error contracts without prescribing backend/frontend internals.
- [x] Keep historical RESTOCK docs untouched: `docs/human-decisions-contract-v1.md`, `odd/tasks/human-decisions-restock.md`.
- [x] Implement the strict EXPIRATION intake normalizer only (exactly four keys, RFC v1-v8 UUIDs, explicit `variantId`) — `normalizeExpirationIntake`.
- [x] Test-first: 23 focused intake cases, RED observed before GREEN.
- [x] Implement the GET current-state projection normalizer only: pure, fail-closed `normalizeExpirationDecision` over the exact GET projection keys, `PENDING`/v1 or `RESOLVED`/v2, canonical lowercase UUIDs/instants, verbatim snapshot labels, and `applyBefore = resolvedAt + 24h` — committed `dfd636a`, reviewed+approved `review-0472792d690fb0d1`; HTTP GET client/wiring was out of scope for that normalizer unit, and binding to the requested id is now enforced by the `getExpirationDecision` GET transport.
- [x] Implement the EXPIRATION GET HTTP transport method only (`getExpirationDecision`, scope `human-decisions:read`): reject a non-canonical id before any request, existing Bearer/branch auth, no idempotency header, safe GET retry, and require HTTP 200 bound exactly to the requested id — implemented locally, not wired to runtime polling.
- [ ] Deferred: runtime wiring, E2E compatibility, activation verification (EXPIRATION POST/GET HTTP transport methods `submitExpirationIntake`/`getExpirationDecision` implemented locally but not wired; receipt normalizer delivered as a bounded second unit: exact receipt/snapshot keys, historical `PENDING`/v1, case-insensitive identity binding echoing the canonical lowercase backend UUID, raw server labels preserved verbatim; intake files unmodified).

## Assumptions and constraints

- Prior scout: local contract is RESTOCK-only (`type: 'RESTOCK'`, `ReservationRoute = 'LEGACY_OPS' | 'RESTOCK'`); the legacy ops-WhatsApp `kind: 'expiration_date'` path exists unchanged, though its production activation is not verified. EXPIRATION therefore adds its own file rather than widening the RESTOCK schema.
- Historical labels in `docs/human-decisions-contract-v1.md` are not deployment proof. Docs budget was ≤280 lines; the unit budget was ≤400 ADD+DEL. Kept to wire-necessary strictness only, with no descriptor/proxy hardening.
- The prior 156-line "PASS / RDD-low" closure referred to an OLDER draft; this alignment supersedes it. The parent owns the new RDD review and memory closure; frozen docs are not edited after review.
- Finding (strict outgoing subset): the bot's normalizer rejects surrounding whitespace and preserves UUID letter case verbatim, while the backend intake trims and lowercases. This is not a wire-contract change: any future receipt/payload comparison must compare normalized forms (trim + case-fold), and getter hardening is deferred.
- Review status (historical, superseded — not current): the earlier note that "this closure correction is NOT native-approved" is stale and must not obscure current approvals. Intake is native-approved (`939dd10`); the GET current-state projection normalizer was reviewed and approved (`review-0472792d690fb0d1`, committed `dfd636a`). The parent still owns each remaining unit's native/independent review decision and memory closure.

## Verification (exact commands; per-unit records below are historical, not a current re-run)

- `pnpm test -- human-decisions-expiration` → 23 passed (RED: 3 failed / 20 passed against the fail-closed stub; GREEN: 23 passed).
- `pnpm exec tsc -p tsconfig.spec.json --noEmit` → exit 0.
- `pnpm exec eslint <both new files>` → exit 0 (no artifacts).
- `wc -l` → dto 62 + spec 100 = 162 ADD lines, within the 400 guardrail.
- `git diff --check` exit 0; only the two new files plus the pre-existing untracked docs and `.codegraph/`; HEAD unchanged. No backend tests, deployment, or activation are claimed.
- Independent verifier (broad-suite match): 187 suites / 5788 tests passed, 30 suites / 755 tests skipped. Bot HEAD `7bd1214` unchanged; backend HEAD `cde0f58` is parent-verified only, not independently verified.
- Receipt unit: `pnpm test -- human-decisions-expiration` → 63 passed (RED: raw-label compatibility and four variant-shape cases failed before their fixes; GREEN 63); `tsc`/`eslint`/`prettier` exit 0; whole diff vs `939dd10` = 382 ADD+DEL. Independent read-only verification confirmed 63 tests, typecheck, lint, formatting, index and budget; this line-only correction does not change diff-line count.
- Receipt raw labels are shape-validated only and preserved verbatim (blank/control/whitespace allowed); no live HTTP call, so not wire-verified.
- GET current-state projection normalizer: 109 focused tests; `tsc`/`eslint`/`prettier` and `git diff --check` pass; the unit is 393 ADD lines across two new files (`human-decisions-expiration-decision.dto.ts` + `.spec.ts`), reviewed+approved (`review-0472792d690fb0d1`) and committed `dfd636a`. The EXPIRATION intake HTTP transport is committed separately at `384dd0f` (receipt `8b560fc`), so the GET unit is not the transport.
- EXPIRATION GET HTTP transport method: `pnpm test -- chatbot-api-http.client` → 122 passed (RED: 9 failed of the 10 new tests against a fail-closed stub; GREEN 122); `pnpm test -- human-decisions-expiration` → 109 passed; `tsc -p tsconfig.spec.json --noEmit`, scoped `eslint`, and `prettier --check` exit 0; whole diff vs `7a05b3a` = 346 ADD+DEL across the five paths. A valid RESOLVED past-deadline body still parses (freshness is runtime's job), and the method is not wired to runtime, so no live GET is claimed.

## Inactive POST preparation unit (after schema `df3316f`)

- `PostgresExpirationPostClaimStore.preparePost` prepares only an exact ACTIVE EXPIRATION reservation (`NULL → RESERVED`); it never authorizes HTTP or initializes unrelated rows. Inbound binding, subject preflight and reservation are caller prerequisites.
- Source UUID casing is preserved byte-for-byte. Unit tests cover input/projection rejection, exact intake fences and zero-row rereads; uppercase regression: worker observed 1 failed / 24 passed before correction, then 25 passed.
- Owner-approved split: preparation committed `d02fdc6`, PostgreSQL preparation proof committed `82e6288`; inactive `beginPost` now claims `RESERVED → POST_IN_FLIGHT` through one identity/intake-fenced CAS with validated RETURNING. Concurrent claims yield exactly one authorization; zero-row reads never authorize. Verification: 49 mock cases and 23 disposable-PostgreSQL cases; HTTP/runtime wiring remains pending. Rollback this unit by reverting the beginPost additions and their tests, preserving preparation and schema 280.
- Preparation DB proof: two observably blocked UPDATEs yield exactly one `prepared` and one `already_prepared`; includes fresh-adapter/pool replay, exact-case identity, variant/JSONB projection and nonmutation checks. No production/runtime activation or POST authorization. Cleanup paths were reviewed, not fault-injected. Run: `RUN_DOCKER_TESTS=1 pnpm exec jest --runInBand src/human-decisions/infrastructure/postgres-expiration-post-claim.store.db.spec.ts`. Rollback this test unit by removing that spec and reverting these two tracker lines; preserve the adapter and schema.

## Inactive receipt persistence unit

- `recordReceipt` records only the exact ACTIVE EXPIRATION `POST_IN_FLIGHT` reservation; the caller must first validate the receipt against its request. It preserves the attempt timestamp, replays the same backend ID and conflicts on a different one, with no resend/release. Tests cover concurrent identical/different IDs and fresh-adapter replay (not an OS-process restart). Verification: 80 mock and 34 isolated PostgreSQL cases. Rollback: revert recordReceipt additions and their tests; preserve preparation, beginPost and schema 280. HTTP/runtime and UNKNOWN persistence remain pending.

## UNKNOWN persistence unit

### Specs
- S1: "persistir `UNKNOWN`"; "Mantener la reserva activa y bloquear reenvíos."; "Conservar la fecha del intento, si existe."; "No sobrescribir un recibo ya registrado."; "Probar concurrencia entre registrar el recibo y marcar `UNKNOWN`."
- S2: "manteniendo el límite de 400 líneas". No HTTP/runtime activation; local commit requires separate owner authorization.
### Tasks
- T1 [done] S1-S2: inactive markUnknown implementation and all mocks committed `983c60a` after explicit authorization; 152 related tests, independent verification and native review approved.
- T2 [in progress] S1-S2: all 11 preserved PostgreSQL cases restored; independent verification passed 197 related tests (45 PostgreSQL), including guarded overlapping receipt/UNKNOWN and UNKNOWN/UNKNOWN races. Native review and separate commit authorization pending.
### Log
- L1: Owner authorized the proposed unit: "Si por faavor. Adelante". Baseline receipt persistence committed `9343f60`; existing pure policy permits RESERVED and POST_IN_FLIGHT to UNKNOWN, holds UNKNOWN, and blocks RECEIPT_RECORDED.
- L2: "Si, autorizada" approves splitting implementation + all mocks from all PostgreSQL/concurrency tests without dropping coverage. T2's patch is preserved locally outside the T1 candidate; the 400 ADD+DEL limit applies to each unit. No runtime activation or commit authorized.

- T2 evidence: generated disposable PostgreSQL URI and minimal migration environment; worker typecheck/lint/format passed. Existing-behavior proof, not a new RED cycle; fresh pools are not OS restarts, cleanup failures were not injected, and no HTTP/runtime activation is claimed. Rollback T2 by reverting only its DB test additions and tracker update, retaining implementation `983c60a`.

## Next external checkpoint

- Bot HTTP transport methods are implemented but not wired, the GET current-state projection normalizer is implemented (committed `dfd636a`, reviewed+approved `review-0472792d690fb0d1`), and the EXPIRATION GET HTTP transport method (`getExpirationDecision`) is implemented but not wired to runtime polling; runtime wiring and E2E remain open (intake `939dd10`, receipt `8b560fc`, transport `384dd0f`, and GET projection `dfd636a` each reviewed/approved locally). The frontend EXPIRATION phase is independent and awaits its own validated delivery. No approved rule above is reopened.
