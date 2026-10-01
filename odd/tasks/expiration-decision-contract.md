# Task: EXPIRATION human-decision contract alignment (docs + first local bot unit)

**Status:** Backend source for EXPIRATION intake/receipt is implemented (read-only reference, parent-observed HEAD `cde0f58`; parent-verified, **NOT independently verified and NOT deployment proof**). The frontend remains an independent phase, still pending. By owner authorization the bot proceeds locally in parallel instead of serializing behind a validated backend delivery. The bot's FIRST local unit is scoped to the strict intake normalizer and its tests — `partial`: **only intake is implemented**; the receipt normalizer, HTTP call, runtime wiring, GET poll, E2E, and activation are deliberately deferred. No push/deploy/activation/production.
**Deliverable:** the two aligned docs (`docs/human-decisions-expiration-v1.md`, this tracker) plus the bot's first local unit `src/chatbot-api/domain/dtos/human-decisions-expiration.dto.ts` and `.spec.ts`. HEAD `7bd121462e57a4d8fcee1052b10671b35c7514a8`; baseline `47a0cf3` unchanged.

## Authorized unit (docs + intake normalizer)

- [x] Read both docs, then realign them to the agreed contract.
- [x] Preserve the four owner-approved business rules.
- [x] Record the agreed wire, freshness, text, and error contracts without prescribing backend/frontend internals.
- [x] Keep historical RESTOCK docs untouched: `docs/human-decisions-contract-v1.md`, `odd/tasks/human-decisions-restock.md`.
- [x] Implement the strict EXPIRATION intake normalizer only (exactly four keys, RFC v1-v8 UUIDs, explicit `variantId`) — `normalizeExpirationIntake`.
- [x] Test-first: 23 focused intake cases, RED observed before GREEN.
- [ ] Deferred: receipt normalizer, HTTP client call, runtime wiring, GET poll normalizer, E2E compatibility, activation verification.

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

## Next external checkpoint

- Bot receipt normalizer, HTTP call, runtime wiring, GET poll normalizer, and E2E remain open. The frontend EXPIRATION phase is independent and awaits its own validated delivery. No approved rule above is reopened.
