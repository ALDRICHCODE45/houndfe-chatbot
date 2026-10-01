# Task: EXPIRATION human-decision contract alignment (docs + first local bot unit)

**Status:** Backend source for EXPIRATION intake/receipt is implemented (read-only reference, parent-observed HEAD `cde0f58`; parent-verified, **NOT independently verified and NOT deployment proof**). The frontend remains an independent phase, still pending. By owner authorization the bot proceeds locally in parallel instead of serializing behind a validated backend delivery. The bot's strict intake normalizer (committed `939dd10`, native-approved) and its EXPIRATION receipt normalizer are implemented, and the EXPIRATION HTTP transport method (`submitExpirationIntake`) is implemented locally but **not wired to runtime** — `partial`: **intake + receipt + HTTP transport implemented**; runtime wiring, GET poll, E2E, and activation remain deliberately deferred. No push/deploy/activation/production.
**Deliverable:** the two aligned docs (`docs/human-decisions-expiration-v1.md`, this tracker) plus the bot's local units `src/chatbot-api/domain/dtos/human-decisions-expiration.dto.ts` (+`.spec.ts`, committed `939dd10`, native-approved) and `src/chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto.ts` (+`.spec.ts`). Baseline `939dd10`; earlier baseline `47a0cf3`.

## Authorized unit (docs + intake normalizer)

- [x] Read both docs, then realign them to the agreed contract.
- [x] Preserve the four owner-approved business rules.
- [x] Record the agreed wire, freshness, text, and error contracts without prescribing backend/frontend internals.
- [x] Keep historical RESTOCK docs untouched: `docs/human-decisions-contract-v1.md`, `odd/tasks/human-decisions-restock.md`.
- [x] Implement the strict EXPIRATION intake normalizer only (exactly four keys, RFC v1-v8 UUIDs, explicit `variantId`) — `normalizeExpirationIntake`.
- [x] Test-first: 23 focused intake cases, RED observed before GREEN.
- [ ] Deferred: runtime wiring, GET poll normalizer, E2E compatibility, activation verification (EXPIRATION HTTP transport method `submitExpirationIntake` implemented locally but not wired; receipt normalizer delivered as a bounded second unit: exact receipt/snapshot keys, historical `PENDING`/v1, case-insensitive identity binding echoing the canonical lowercase backend UUID, raw server labels preserved verbatim; intake files unmodified).

## Assumptions and constraints

- Prior scout: local contract is RESTOCK-only (`type: 'RESTOCK'`, `ReservationRoute = 'LEGACY_OPS' | 'RESTOCK'`); the legacy ops-WhatsApp `kind: 'expiration_date'` path exists unchanged, though its production activation is not verified. EXPIRATION therefore adds its own file rather than widening the RESTOCK schema.
- Historical labels in `docs/human-decisions-contract-v1.md` are not deployment proof. Docs budget was ≤280 lines; the unit budget was ≤400 ADD+DEL. Kept to wire-necessary strictness only, with no descriptor/proxy hardening.
- The prior 156-line "PASS / RDD-low" closure referred to an OLDER draft; this alignment supersedes it. The parent owns the new RDD review and memory closure; frozen docs are not edited after review.
- Finding (strict outgoing subset): the bot's normalizer rejects surrounding whitespace and preserves UUID letter case verbatim, while the backend intake trims and lowercases. This is not a wire-contract change: any future receipt/payload comparison must compare normalized forms (trim + case-fold), and getter hardening is deferred.
- Review status: this closure correction is NOT native-approved; the parent owns the native/independent review decision and memory closure, and review remains pending.

## Verification (exact commands)

- `pnpm test -- human-decisions-expiration` → 23 passed (RED: 3 failed / 20 passed against the fail-closed stub; GREEN: 23 passed).
- `pnpm exec tsc -p tsconfig.spec.json --noEmit` → exit 0.
- `pnpm exec eslint <both new files>` → exit 0 (no artifacts).
- `wc -l` → dto 62 + spec 100 = 162 ADD lines, within the 400 guardrail.
- `git diff --check` exit 0; only the two new files plus the pre-existing untracked docs and `.codegraph/`; HEAD unchanged. No backend tests, deployment, or activation are claimed.
- Independent verifier (broad-suite match): 187 suites / 5788 tests passed, 30 suites / 755 tests skipped. Bot HEAD `7bd1214` unchanged; backend HEAD `cde0f58` is parent-verified only, not independently verified.
- Receipt unit: `pnpm test -- human-decisions-expiration` → 63 passed (RED: raw-label compatibility and four variant-shape cases failed before their fixes; GREEN 63); `tsc`/`eslint`/`prettier` exit 0; whole diff vs `939dd10` = 382 ADD+DEL. Independent read-only verification confirmed 63 tests, typecheck, lint, formatting, index and budget; this line-only correction does not change diff-line count.
- Receipt raw labels are shape-validated only and preserved verbatim (blank/control/whitespace allowed); no live HTTP call, so not wire-verified.

## Next external checkpoint

- Bot HTTP transport method is implemented but not wired; runtime wiring, GET poll normalizer, and E2E remain open (intake `939dd10`, native-approved; receipt focused-verified only). The frontend EXPIRATION phase is independent and awaits its own validated delivery. No approved rule above is reopened.
