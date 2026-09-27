# Natural restock consultation voice

## Intent and authorization

Owner authorizes tone changes now, matching warm Mexican usted customer service. Replace ambiguous interest-registration wording with truthful replenishment-consultation language. Screenshots show accepted requests and a staff estimate form; they do not prove WhatsApp delivery. No provider calls, production/DB operations, backend edits, commits, push or deployment authorized.

## Evidence and boundaries

Base: main dc3e98b6c3c3a3142f5fe045c9e8f643b119f33f. Parent git status: tracked tree clean; untracked .codegraph/ must remain untouched. Existing approved trackers remain frozen.

RESTOCK submits POST /chatbot-api/human-decisions. recorded/existing map to historical_intake_recorded: evidence of accepted intake, not current resolution. Ambiguous outcomes can coexist with a backend request. SDK 7.0.9 supports current prompt forwarding; no SDK/history changes required.

Change source copy only in system-prompt.ts, sale-flow-instructions.ts and request-human-assistance.tool.ts description. Preserve execution, return types, identity/stock gating, automatic request sequencing, retries, legacy notifications, no-estimate and receipt semantics. Do not ask permission after automatic intake. Never claim current pending/review state, ETA, reservation or guaranteed notification from an acceptance receipt.

## Work plan and route

- [x] V1: Read-only mapper establishes outcome semantics and exact edit surface (delegated; multi-file mapping).
- [x] V2: Replace/consolidate voice guidance and concrete examples with tests (delegated writer; six nontrivial files). Completed, 80 additions / 24 deletions.
- [ ] V3: Check diff, SDK boundary evidence and applicable review/verification plan. Independent verifier running; native assessment unavailable due intended-untracked declaration, treated as high for verification.
- [ ] V4: Owner live voice acceptance, explicitly separate from deterministic test results. No live calls authorized yet.

One coherent work unit, forecast 100–160 authored changed lines plus this tracker. Delivery strategy ask-on-risk; no commit authorized. Rough 400-line planning heuristic is advisory, never a reason to omit tests or minify. Rollback boundary: this unit's prompt/tool-description and associated test edits only.

## Verification

Test-first: revised expectations and real SDK/MockLanguageModelV4 boundary coverage must fail before copy changes, then pass. Cover with/without catalog evidence and shipping composition where applicable. Retain existing operational tests unchanged.

Focused: pnpm exec jest --runInBand --runTestsByPath src/llm-agent/domain/system-prompt.spec.ts src/sale-flow/domain/sale-flow-instructions.spec.ts src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts src/sale-flow/application/tools/request-human-assistance.tool.spec.ts src/human-decisions/application/restock-intake.service.spec.ts

Types: pnpm exec tsc --noEmit -p tsconfig.spec.json

Scoped eslint on six allowed source/test paths, without --fix; git diff --check. Applicable offline full Jest suite at closure (no DB/provider commands). Real SDK mocked-provider tests prove transmission, not natural generated voice. Record actual outcomes, never infer live acceptance.

## Observed verification

Writer: RED 8 failures / 225 passes before source edits; GREEN 233/233 focused tests. Types and scoped eslint passed; git diff --check passed. Offline full Jest: 180 suites passed, 30 skipped; 5303 tests passed, 755 skipped. No live model calls. Parent source diff readback confirms description/prompt-only runtime changes. LSP: five paths inconclusive; four auxiliary warnings in unchanged tool imports/control flow, not proof of clean. Independent verifier task mujn4qdq-4-svop owns repeat focused checks and test-boundary review.

## Deferred priority

Next: trace staff-entered calendar days or no-estimate response through resolution, correlated application and outbound WhatsApp delivery. Owner calls this most important but explicitly defers it until tone correction. Do not implement that pipeline in this unit.
