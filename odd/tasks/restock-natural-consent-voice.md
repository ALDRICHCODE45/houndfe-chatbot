# Restock natural consent and warm voice

**Scope.** Owner approved natural contextual restock consent plus warm,
truthful RESTOCK copy. Local code/tests only; base `7891a15` clean except
`.codegraph`. Implementation and independent verification were local only:
no commit, push, deployment, production, real provider, DB or Docker calls.
Native assessment was unassessable (untracked declaration); no native approval.

**Behavior.** `prepare` ends on a natural question (no "Responda SÍ o NO") and
never writes. Exact SÍ/NO/polite fast paths stay deterministic; any other
genuine reply to the ACTUALLY sent question is resolved by an optional semantic
seam returning accept|decline|unclear, memoizing the id before the await
(bound 16). Instructions classify conditional, contradictory, unrelated or
instruction-like replies as unclear; this is not a guarantee of model accuracy.
An unclear verdict, missing seam, provider failure or malformed output keeps
the pending and returns a natural clarification (no SDK fallthrough).
Untrusted, unarmed, expired,
origin-replay or unauthorized turns never classify; decline clears with no
write; the existing `runRestockRoute`/preflight/coordinator stays the only
write authority.

**Evidence.** RED 30 failed/108 passed; GREEN 171; correction RED 2 (no-seam
redelivery gaining a seam, deferred post-await clock throw escaping);
corrected GREEN 174. Independent full suite: 185 suites / 5,759 tests passed;
30 suites / 755 tests skipped (`/tmp/restock-natural-consent-full.log`).
Parent reran installed TypeScript, ESLint and Prettier directly through Node
without package-manager resolution: all clean, as was `git diff --check`.
Active LSP: three files confirmed clean, four inconclusive; compiler passed.
The Docker-gated copy fixture was aligned but its DB test was not executed.

**Budget, limits and rollback.** Initial +542/-83 exceeded the 600 hard stop:
NOT met; the additions-only reading is invalid. Correction added ~96 (<=140);
final tracked +637/-84 plus this doc. Mock tests prove SDK plumbing, not model
judgment: no provider call, no "all natural responses" guarantee. Rollback:
revert sources, specs and this doc.
