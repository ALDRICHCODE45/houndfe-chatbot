# Ground catalog identity across conversation turns

## Authority and scope

Owner approved durable catalog identity, pre-GET stock/RESTOCK guards and concurrent turn persistence, superseding the former 390-line ceiling. CodeGraph is authorized; never stage its index. One cohesive local candidate with size exception. No global config, backend edits, provider/DB/remote/secret operations, push or deployment. Local commit/main integration still requires separate owner approval.

Worktree: `houndfe-chatbot-human-decisions`; branch: `fix/catalog-identity-grounding`; base: `71aa42ad437f421a4953b1caaebd6987d543121e`. Latest measured source/test scope: 26 files, 1,482 additions + 340 deletions = 1,822 lines, including four new files, excluding tracker/index. This exceeds the advisory 1,078–1,543 forecast; no tests were omitted or compressed to fit. Earlier time estimate is not validated.

## Evidence and implemented design

Backend audit proves three failed stock GETs used wrong product IDs; the actual catalog product returns matching HTTP 200 stock. Normal history persisted text, not catalog evidence; UUID origin remains unproven. Two delegated explorers mapped code, five typed store mocks and installed SDK 7.0.9 before implementation.

Detached, runtime-branded CatalogSession per sender/run stores only exact product UUID/name and variant UUID/name/option/value plus observedAt and transcript provenance. Bounds: 20 products (API maximum), 100 variants total, names 256 characters, option/value 128 characters, 64 KiB serialized projection. Reject malformed/conflicting/oversized identities, never truncate. Search start invalidates old evidence; only latest-started search installs results.

Evidence requires matching sender, valid non-future original observation time within idleTimeoutMs, and originating user message still in retained prompt history. Unrelated turns do not renew it; idle reset clears it. Rehydrate labeled UNSELECTED evidence with stock unknown, not fabricated SDK tool history. Fixed recovery requires actual search and explicit choice, not UUID repair or automatic selection.

SDK toolsContext forwards runtime-validated server sessions separately from model input and existing inbound identity. checkStock and enabled RESTOCK validate product/variant/name before fresh GET. Preserve default-off legacy escalation, customer confirmation, fresh stock, inbound binding, markers, coordinator reservations/idempotency and historical intake truth. No identity payload logging.

Required commitAgentTurn compares detached original full history and optional revision atomically, assigns fresh revision and merges only messages/catalog/revision into live state. Generic updates preserve owned keys plus existing human/receipt protections. Keep later live timestamp. Existing-row completion cannot recreate deletion; first contact can insert or conditionally merge an empty-history/revision sibling-created row. Idle reset compares original state. Failed CAS does not retry or rerun tools.

Final CAS prevents stale persistence, NOT already-executed GET/intake/reply effects. No execution lease, delete/recreate revocation guarantee, new confirmation workflow or generic cart/shipping repair. Recorded intake surviving lost CAS is explicitly tested.

## Tasks and route

- [x] I0 — Wrong-ID evidence and history gap established.
- [x] I1 — Delegated mapping and bounded design accepted, including expanded scope and offline commands.
- [x] I2 — Single writer completed source/tests and all authorized offline checks. First partial draft had 39 failures; follow-up resolved current suite without waivers.
- [ ] I3 — IN PROGRESS: Independent verification and active diagnostics completed; native candidate review and local delivery approval pending. No source writer active.
- [ ] I4 — Owner deployment and fresh search/confirmation/stock/RESTOCK rehearsal, no resets or blind retries.

## Observed verification

Writer `mujal647-4-sprt`: checkStock meaningful RED (forbidden GET) then GREEN; additional prototype-forgery/hostile-proxy RED then unchanged-selection GREEN. Focused eight suites: 178 passed; twelve regression suites: 464 passed; existing Postgres offline-only selection: 23 passed/26 skipped. Full `RUN_DOCKER_TESTS=0 pnpm exec jest --runInBand`: 180 suites passed/30 skipped, 5,287 tests passed/755 skipped, zero failures. `pnpm exec tsc --noEmit -p tsconfig.spec.json`, `pnpm build`, explicit 26-file eslint/prettier and `git diff --check` passed. Writer reports gpt-6-astra, effort unavailable.

Coverage includes real-tools two-turn grounding, real-SDK offline fake-model context isolation, wrong UUID/variant/name zero unrelated GET/intake, recovery, ambiguity, sender isolation, hostile state/bounds, non-sliding expiry, history/idle reset, concurrent searches, stale completion, siblings/timestamps, first-contact/deletion, changed stock and recorded intake after CAS loss. Fake-Pool tests prove SQL shape/bindings, NOT PostgreSQL locking. No database/provider/hosted tests ran; fake generation does not prove model compliance.

Parent active LSP probe: 26 files, five confirmed clean, twelve with 59 auxiliary ast-grep warnings, nine inconclusive (push-only silent-on-clean). No compiler errors reported; do not claim all paths clean. Generic extensionless-import/style/delete/non-null findings are not a reason for unrelated refactoring; independent tsc is required.

Independent verifier `mujbjga9-5-7hdr` observed 178 focused passes, 23 offline SQL passes/26 skips, full 5,287 passes/755 skips (180 suites passed/30 skipped), types/build/scoped lint/format/diff checks passing. No blocker found or source/test drift across its captures; separate 464-test selection was not rerun, but full suite was. SQL locking and hosted behavior remain unverified.

Native INSPECT selected tracker plus four authored new files, excluding .codegraph. ASSESS remained unassessable due untracked declaration; high-risk independent verification requirement is now satisfied. This document records the pre-review candidate and remains frozen during native review; later review/delivery outcomes live in session memory until a new documentation candidate is appropriate. No review approval, staging, commit or deployment claimed here.

## Rollback and remaining limits

Revert this cohesive catalog/session, tool gates, store/port, runner/adapter and tests together, preserving preceding diagnostics and unrelated state. No migrations/dependencies/flags or data cleanup/replay. New JSON keys are additive; rollback cannot reverse recorded intake effects. Duplicate-looking replies remain separate. Owner runtime rehearsal and local delivery consent remain pending.
