# Catalog clarification continuation

## Scope
Owner authorized fixing the repeated product/presentation clarification seen in the full screenshot conversation. Local code and tests only. No .env reads, live model/provider calls, production/DB/network operations, dependencies, push or deployment. New commits and main integration require delivery consent. Final delivery must reach main locally, not remain only on a feature branch, because owner deploys on push to main. Preserve .codegraph and frozen earlier trackers.

Base: 17cb55a0ecff7330cb3615462e53cc467993da8d.
Branch: fix/catalog-clarification-continuation.
Forecast: 250-350 authored diff lines plus this task record; ask-on-risk delivery. One bounded behavior with tests; do not trim necessary coverage for a line count.

## Observed defect
The selector accepts availability cues or short affirmatives, but not the customer's answer to its own clarification: 'busco ibuprofeno de 400mg'. Tokenization also distinguishes 400mg from 400 mg. Production repeats identity-unverified check -> successful search -> clarification without another stock check. The initial affirmative rejection reason and actual backend variants remain unknown; do not fabricate them.

## Design
Use the exact fixed clarification text passed by the adapter as a delimiter only; domain cannot import adapter. A bounded retained-history suffix (at most eight messages) must contain an authentic user availability anchor. Permit only recognized continuation pairs, including repeated exact clarifications; every named answer must identify the same unambiguous fresh catalog target. Assistant prose never authorizes identity. Missing/truncated anchor, subject switches and arbitrary text fail closed.

A contextual clarification-answer branch strips only an exact optional 'busco' prefix and normalizes number/unit adjacency for a closed whitelist (minimum mg). Use strict matching, not the existing permissive bidirectional matcher: wrong dose, added unsupported product, negative/cancel/compound intent, and unresolved variants must not force a GET. Never infer a variant from one product result. Preserve the existing failure-then-fresh-search gate, one-shot execution lock, bounded steps and prior-effect reporting.

## Tasks
- [x] Q1 Map selector/history seams. Read-only explorer mapped four paths and the confirmed missing continuation branch; no backend assumptions.
- [x] Q2 Implement bounded clarification continuation with meaningful RED/GREEN tests. Independent targeted re-verification passed all four counterexamples and actual SDK returned-message handoff.
- [ ] Q3 Independently verify, native review, and request local commit/main-integration consent. Push/deployment remain owner-controlled.

## Allowed source surfaces
- src/llm-agent/domain/catalog-stock-recovery.ts
- src/llm-agent/domain/catalog-stock-recovery.spec.ts
- src/llm-agent/infrastructure/vercel-ai-llm-agent.ts
- src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts

## Acceptance and checks
Real SDK multi-turn regression including authentic availability request, affirmative, fixed clarification, 'busco ibuprofeno de 400mg', and repeated clarification history. Use actual returned messages where supported. Test fixtures represent supported backend cases, not proof of the unknown production variant shape. A valid unambiguous answer must produce one authoritative GET and a useful reply, while ambiguous cases ask clarification and no GET. Test 400mg/400 mg, wrong dose, added/changed product, missing anchor, negatives, variants and the history bound. Keep all prior recovery/mutation-denial tests green.

Run new domain+adapter plus existing catalog identity/inventory guard focused suites; TypeScript spec noEmit; scoped ESLint without fix; diff check. Full offline suite once at closure with external gates disabled. No live provider tests. Parent owns this task document.

## Evidence
Screenshot: Screenshot_2026-09-27-19-41-42_5360x2520.png; no private identifiers copied.

Writer muklme55-11-gdpm reports 230 focused tests, TypeScript, scoped lint and diff checks passed; offline full suite 5526 passed / 755 skipped tests, 183 passed / 30 skipped suites. RED was observed by temporarily neutralizing an already-written branch, not before the first implementation edit. SDK coverage uses synthetic retained history, not actual returned-message handoff; do not claim complete multi-turn runtime coverage.

Parent measured 549 additions / 13 deletions across four source/test paths (562 authored lines, above the initial forecast). No commits or source acceptance yet. Native assessment was unassessable because intended untracked scope was undeclared. Independent verifier mukm2tg7-12-t07q returned BLOCKED, with 230 focused tests, TypeScript and diff checks passing but four executed counterexamples: unsupported paracetamol anchor inherited by an ibuprofen answer; cancellation ignored; shared product/variant dose tokens rejecting a valid presentation; extra 800mg from an unselected variant accepted for a 400mg variant. It also confirmed that actual result.messages contains the overridden clarification and can be threaded into the next SDK run, unlike the synthetic-history test.

Correction writer mukm6riv-13-pd0l completed replacement of the faulty helpers. RED was observed before production edits: 6 failed / 189 passed across domain and adapter tests, including the four executed counterexamples, repeated product change, and real returned-message handoff. GREEN: 238 focused tests; TypeScript, scoped lint and diff checks; offline full suite 5534 passed / 755 skipped, 183 passed / 30 skipped suites.

Independent follow-up mukmo4y8-14-jooy returned targeted PASS: four original selector counterexamples now return none, none, the correct variant, and none. The real SDK test passes actual first.messages to a second run, observes one trusted stock GET and a useful reply. Independent checks: 238/238 focused tests, TypeScript and diff check passed. Full-suite and lint results remain writer-reported. Native review and delivery consent pending at this document's freeze; completion is recorded in session memory to preserve reviewed bytes. Source/test scope is 940 additions / 13 deletions; retain required coverage, not size-only trimming.

Known limitation: unresolved stock evidence is keyed by exact productId and variantId. A product-only failed subject cannot be cleared by a later variant-specific success. The real multi-turn test therefore uses representative ambiguous-first and unambiguous-product-second search fixtures with fresh per-turn CatalogSession instances; it proves actual returned-message handoff, not production catalog parity or all variant flows. Initial production identity-rejection cause and actual variant shape remain unknown.
