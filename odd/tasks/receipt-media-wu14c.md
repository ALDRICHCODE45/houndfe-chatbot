# Receipt Media WU14C

## Objective

Compose the non-worker `ReceiptMediaModule` so the existing receipt-media adapters, services, processor, authorizer, and access controller resolve through NestJS dependency injection without starting background workers or reopening deferred outbox work.

## Problem and rationale

WU14A/B provide the production persistence adapters, but the receipt-media feature still lacks its own NestJS composition root. WU14C must add that root as one bounded work unit before WU14D integrates it into host modules.

## Scope

### Allowed source edit surfaces

- `src/receipt-media/receipt-media.module.ts` (new)
- `src/receipt-media/receipt-media.module.spec.ts` (new)

### Tracking surface

- `odd/tasks/receipt-media-wu14c.md`

### Explicitly out of scope

- Ingestion and notification worker registration
- Receipt outbox composition or `ReceiptTx2CommitPort` work
- Existing adapter, service, controller, configuration, migration, or host-module changes
- `src/whatsapp/whatsapp.module.ts`
- `src/chatbot-api/chatbot-api.module.ts`
- Commit, push, or pull request creation
- Reading or modifying the 14 protected untracked paths

## Constraints

- Preserve one `PostgresReceiptMediaStore` singleton.
- Alias `RECEIPT_CAPABILITY_LOOKUP` to that singleton with `useExisting`.
- Export at least `ReceiptIngressService` and `ReceiptAmountRouterService` for WU14D.
- Do not register either background worker.
- Decode configured capability keys only at the module composition boundary.
- Initial forecast: 340–395 authored A+D lines; the original hard review budget was 400 A+D.
- Initial disabled-boot correction authorization was 95–130 correction A+D and 495–530 final source A+D. One replaced line counts as one deletion plus one addition.
- Maintainer-approved revised exception for the disabled-boot candidate: 199 gross correction A+D and 529 final source lines.
- Maintainer-approved deterministic-test follow-up: up to 4 incremental A+D and 531 final source lines. Final measured correction is 201 gross A+D and 531 source lines. Any further source change requires a new measured budget decision before editing.
- Technical artifacts remain in English.

## TDD

- Mode: enabled.
- Source: tracked WU14C task ledger and maintainer approval of the strict TDD scout plan.
- Focused runner: `pnpm test -- src/receipt-media/receipt-media.module.spec.ts`.
- Required sequence: observe RED before production implementation, then GREEN, triangulate enabled/disabled configuration and graph failures, refactor, and rerun focused checks.

## Checklist

- [x] **WU14C-1 — RED:** Add the module specification and observe the expected failure while `ReceiptMediaModule` is absent or incomplete.
- [x] **WU14C-2 — GREEN:** Add the bounded non-worker module composition and make the focused specification pass.
- [x] **WU14C-3 — TRIANGULATE/REFACTOR:** Prove singleton aliasing, required imports/providers/controller/exports, enabled and disabled configuration behavior, missing-token graph failure, and absence of worker or outbound side effects.
- [x] **WU14C-4 — VERIFY/REVIEW:** Run focused tests, scoped ESLint, formatting/diff checks and applicable type diagnostics; record A+D size, runtime-harness status, rollback boundary, native review outcome, and all failed/skipped/pending checks.
- [x] **WU14C-R1 — RED:** Prove a valid disabled environment with all receipt-specific settings genuinely absent fails current module boot with `RECEIPT_CAPABILITY_KEYRING_INVALID`.
- [x] **WU14C-R2 — GREEN:** Add module-local conditional factories and disabled-safe seams without changing the enabled composition or registering workers/outbox paths.
- [x] **WU14C-R3 — TRIANGULATE/REFACTOR:** Prove disabled boot succeeds without configured adapters or I/O, ingress remains disabled, access fails closed as unavailable, enabled composition remains real, and enabled missing-keyring validation still fails deterministically under a contaminated outer environment.
- [x] **WU14C-R4 — VERIFY/REVIEW:** Run all focused checks, prove corrected-byte integrity, obtain fresh native review/acknowledgement, and record revised source hashes and A+D evidence.

## Acceptance criteria

- `ReceiptMediaModule` compiles and resolves the required non-worker graph.
- `PostgresReceiptMediaStore` and `RECEIPT_CAPABILITY_LOOKUP` resolve to the same singleton instance.
- Meta media, object storage, capability service, receipt application services, processor, authorizer, and access controller are composed from existing dependencies.
- Dispatcher-facing services are exported.
- Neither receipt worker is registered or started.
- Tests require no live PostgreSQL, Meta, S3, or outbound HTTP traffic.
- No file outside the two source surfaces and this tracker is changed.
- Authored diff remains at or below 400 A+D unless the maintainer explicitly authorizes an exception.

## Verification evidence

- RED: after repairing the failed draft without creating production code, `pnpm test -- src/receipt-media/receipt-media.module.spec.ts` failed only because `./receipt-media.module` did not exist.
- GREEN/runtime harness: writer run passed 1 suite and 6 tests; parent spot-check reran the same command and passed 1 suite and 6 tests in 0.77 seconds.
- Scoped ESLint: exit 0.
- Prettier check: all matched files use Prettier style.
- `git diff --check` over both candidate files: exit 0.
- Nonincremental TypeScript: exactly 119 pre-existing diagnostics and zero candidate-file diagnostics, matching the known baseline.
- Active LSP probe: zero TypeScript diagnostics; three auxiliary AST hints/warnings only (two project-style relative-import extension warnings and the known `unknown` lookup parameter cast).
- Authored size: exactly 400 A+D (187 module + 213 spec), at the approved hard limit with no headroom.
- Runtime boundary: the focused Nest testing-module spec boots the real DI graph with only PostgreSQL, conversation-store, and chatbot-api edges stubbed; no live Meta, S3, database, or outbound HTTP is used.
- Rollback boundary: remove only the two new candidate files; WU14A/B and host modules remain untouched.
- Native review: lineage `review-d40b1447fd525050` approved target `sha256:ad63e837d53016775e7c7c569454e8ac0e8a277c9963b65aa2b535e293749980`; acknowledgement consumed revision `sha256:cd29ff77e9a965d08021d228e05700c6866a9e4f0293de0b3bbb9e37ce3da1f6` and burned authority.
- Native informational advisories: `R3-keyring-decode-assertion` and `R3-strict-absence-check`; neither opened correction or blocks WU14C.
- Independent verification: PASS. All five required command outcomes matched writer evidence, staging and tracked worktree remained empty, and pre/post SHA-256 digests stayed identical for all three scoped files. Source digests: module `862dd880ece68018157399d43f85341f30f5ed7b79bdb00047602de1c2b323ff`; spec `ab8fab0caa31da5b57c6bdaea8ffa263354d2b142e19c02334fff16189d65d44`.
- Disabled-boot correction candidate checks reported by the writer: focused Jest 8/8, scoped ESLint, Prettier check, and diff-check pass; TypeScript remains at 119 pre-existing diagnostics with zero candidate diagnostics. The maintainer accepted the revised exact 199 gross A+D exception after parent measurement.
- Exact correction diff against approved tree `14b7de3dee0d40fafd32bf603956e2afe5dc4f37`: module +85/-27 and spec +79/-8 = **199 gross A+D**. Final source size is 529 lines. Current hashes are module `7edb05df78d90f566b512597aef026b796eebe2b999530533b696a09fd55cd37` and spec `13a68c41f1cc57af58669e6545030391e18194a9dcd4128357e88df0f842c272`.
- First independent correction verification: **FAIL** despite all standard checks passing. With outer `RECEIPT_CAPABILITY_KEYS='2:QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='`, focused Jest failed 1/8 because `withModule()` overlaid `process.env` without deleting inherited receipt variables; enabled missing-keyring validation became environment-dependent. Pre/post candidate hashes remained identical.
- Deterministic helper follow-up: normal focused Jest passed 8/8 and the same contaminated-shell command passed 8/8 after clearing receipt-specific keys before overlay. Scoped ESLint, Prettier check, and diff-check passed; TypeScript remained exactly 119 pre-existing diagnostics with zero candidate diagnostics.
- Final correction diff against the original approved tree: module +85/-27 and spec +81/-8 = **201 gross A+D**. Final source size is 531 lines. Final source hashes are module `7edb05df78d90f566b512597aef026b796eebe2b999530533b696a09fd55cd37` and spec `5bd8ab65b18de93fe8432f7f766a1906fbde65b9ffd6cf9cdffe372015b8a3d8`.
- Final independent verification: **PASS** with identical pre/post hashes for tracker and both source files. Normal and contaminated-shell Jest runs passed 8/8; ESLint, Prettier check, and diff-check passed; TypeScript remained exactly 119 pre-existing diagnostics with zero candidate diagnostics; staging and tracked worktree remained empty; `dist-temp` remained absent.
- Final native review: lineage `review-002373a9286c7cde` approved target `sha256:5d18513ac2ca019e3e5a2b557f8b7bebafe6e3839e551d712e0b140c1b703682`; acknowledgement consumed revision `sha256:f8a0d9ac1ff9cd636e3ff3ae0dbf48c20edff71e4ffd259c88a1c090806c1eb8` and burned authority. Informational advisories `R3-keyring-known-answer` and `R3-worker-absence-scope` opened no correction.

## Progress

- Baseline validated at branch `feat/receipt-media-ingestion-wu06-capability-access`, HEAD `b3b1cdf585ff9bb549bc4be9f192b24bd957ae0d`.
- Tracked worktree and staging were clean before this tracker was created.
- Exactly 14 protected untracked paths were present and `dist-temp` was absent.
- One read-only scout returned GO; maintainer explicitly approved implementation.
- The first bounded writer attempt failed before returning RED evidence. It left only `src/receipt-media/receipt-media.module.spec.ts` as an untracked, incomplete 270-line draft; the production module remains absent, staging remains empty, and no protected path changed.
- Parent incident diagnosis found the draft had expected missing-module RED plus local draft defects (duplicate environment key and invalid placeholder builder calls). No implementation result was accepted from that attempt.
- The resumed bounded writer repaired the draft, produced valid RED/GREEN evidence, completed the exact two-file composition, and passed all required focused checks.
- Parent read both candidate files, reran the focused runtime harness successfully, and confirmed staging remains empty, `dist-temp` remains absent, and the 14 protected paths remain untouched.
- Native review approved and was acknowledged. A first independent verifier passed every functional check but failed closed on an unproven host-autoformat mutation; native identity remained unchanged. A fresh verifier then proved byte immutability with matching digest checkpoints and returned PASS with no blockers.
- The initial WU14C candidate was complete at its approved snapshot. A WU14D scout then found that valid disabled configuration omits the keyring while WU14C eagerly constructs `CapabilityService`, which would block host boot.
- A bounded correction scout recommended conditional provider factories with disabled-safe seams while preserving the mounted access controller and strict enabled-mode validation.
- The maintainer explicitly authorized the correction implementation and a size exception of 95–130 correction A+D / 495–530 final source A+D. WU14C is reopened until WU14C-R1 through WU14C-R4 close on corrected source.
- The correction writer returned a functionally green 529-line candidate but incorrectly counted correction size as net growth. Parent measured the required gross A+D against the approved native tree at 199, exceeding the initial 130 ceiling by 69. The worker also disclosed an intermediate 540-line state despite the stop-before-exceeding instruction.
- The maintainer explicitly accepted the revised exact exception of 199 gross correction A+D / 529 final source lines. WU14C-R1 and WU14C-R2 remain accepted.
- Parent spot-check passed 8/8 and native review lineage `review-7b665b4d43144881` was started for target `sha256:a78ce2853f20f6bb9c2abc38baafefb47bd6a2ca562de9b110015935e57ee742`, but no reviewer model run was acknowledged or captured after independent verification found the deterministic environment-isolation defect.
- The maintainer authorized the exact spec-only clear-then-overlay fix. Normal and contaminated-shell runtime harnesses now pass 8/8; final measured source is 201 gross correction A+D / 531 lines.
- Fresh hash-stable independent verification passed and final native review `review-002373a9286c7cde` approved/acknowledged the corrected target. WU14C-R1 through WU14C-R4 are complete. The earlier pre-fix lineage `review-7b665b4d43144881` captured no reviewer artifact and is superseded by the approved corrected target.

## Next step

Obtain explicit maintainer authorization for the local WU14C checkpoint required before WU14D. The checkpoint should contain only the two WU14C source files, this ODD tracker, and any separately authorized tracked OpenSpec task reconciliation. Do not push or open a PR.
