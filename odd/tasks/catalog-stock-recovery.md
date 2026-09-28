# Catalog stock recovery

## Authorization and scope
Owner authorized local correction of failed catalog identity recovery and explicitly chose automatic read-only stock lookup when the requested product is unambiguous; ask clarification otherwise. No automatic request, sale or other mutation. No .env reads, live provider calls, production/DB/network operations, dependency changes, commits, push or deployment without separate consent. Preserve .codegraph and previously frozen trackers.

Base: 80146fd042aafbdeadcf85ce93b36d8907149103.
Branch: fix/catalog-stock-recovery.
Delivery: owner delegated the recommended split and requested final integration into local main for owner push/deployment. Two local work units: (1) selector/controller with its tests, (2) adapter integration with its tests. Local commit sequence and final main integration are authorized after verification/review; no push, PR creation or deployment. Original forecast 300-500 lines; writer reported about 1184 additions plus 16 deletions. Keep required coverage; no size-only trimming. Confirm actual boundaries and counts before commits.

## Evidence and design
Production: availability greeting with zero tool calls; affirmative continuation; checkStock returns catalog_identity_unverified before any stock GET; successful search returns one result; run ends without retry. The default budget is three steps, but production configuration is not known. Raising the cap or changing the prompt alone does not guarantee recovery.

CatalogSession validates backend identity, not customer transactional selection. A model-supplied failed subject or a single search result alone is not customer intent. Recover only a conservative subset of read-only availability intent from authenticated current/retained user messages, with fresh validated catalog identities and unambiguous product/variant matching. Include the actual short affirmative continuation, not only full product names. Ambiguous or unsupported intent requires clarification, never guessed identity. Assistant content may constrain continuity, never authorize IDs.

One recovery stock execution at most, using trusted selected input with matching evidence accounting. Require it through SDK choreography rather than advisory prompts. At most two recovery-only steps beyond normal budget (stock and final response); ordinary runs keep their budget. Block mutations throughout recovery, including model attempts despite tool visibility. Preserve R2 prior-effect reporting. Search alone never clears stock failure; only authoritative same-subject stock results can do so. Wrong failed IDs must not contaminate trusted recovery or be silently cleared without evidence.

## Tasks
- [x] C1 Map persistence, identity validation and recovery loop. Route: read-only explorer mukhaa9e-r-6n1q; four-file mapping trigger. User approved automatic unambiguous read-only recovery.
- [x] C2 Implement bounded recovery and realistic SDK regressions. Three independent findings corrected; final targeted verification passed 214/214 focused tests.
- [ ] C3 Independently verify, split into two local work units, perform native review and integrate into local main. Push/deployment remain owner-controlled.

## Allowed implementation surfaces
- src/llm-agent/domain/catalog-stock-recovery.ts
- src/llm-agent/domain/catalog-stock-recovery.spec.ts
- src/llm-agent/infrastructure/vercel-ai-llm-agent.ts
- src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts

Return a blocker if a necessary change falls outside these surfaces. Do not edit inventory guard or checkStock identity validation to make the test pass.

## Acceptance and verification
Real SDK mock regression using prior user 'Buenas tardes, tienen ibuprofeno?', assistant offering availability check for Ibuprofeno de 400 mg, current 'Si por favor': failed check, successful search, exactly one subsequent stock GET with validated identity, useful response, no mutation. RED before implementation, GREEN afterward.

Reject ambiguous product/variant, missing or expired snapshots, mismatched name/identity, negative continuation and subject changes. Test adversarial model arguments, bypassed activeTools, repeated recovery attempts, low step budget, provider scheduling violations, stock failure, and earlier possible mutation. If correctness cannot be established for a case, fail closed with a targeted clarification or truthful unavailable response.

Focused new selector and adapter specs plus existing catalog-identity integration and inventory guard specs; TypeScript noEmit; scoped ESLint without fix; diff check. Run full offline suite once at closure with external gates disabled. No hosted model experiments. Parent owns this tracker.

## Evidence
Writer reports 194 focused tests passed; TypeScript, scoped ESLint and diff checks passed; offline full suite 5490 passed / 755 skipped tests, 183 passed / 30 skipped suites. Reported RED was a missing-module failure before implementation, not demonstrated SDK behavioral RED; do not conflate them.

Independent verifier mukixw66-v-djnu returned BLOCKED despite 194/194 focused tests, TypeScript and tracked diff checks passing. Confirmed defects: assistant-only product reference can arm recovery on the first step using an older snapshot, without the authorized failed-check then fresh-search sequence; successful recovery clears the ordinary unresolved gate, allowing final-step mutations to execute before post-step violation detection. Ambiguous intent also lacks the promised targeted clarification response. Divergent failed IDs intentionally remain unresolved; the incident test assumes identity equivalence, not proven by production logs.

Correction writer mukj0std-w-w7w8 returned completion in the same four surfaces. Reported behavioral RED: domain 9 failed / 18 passed; adapter 4 failed / 7 passed, including real final-step mutations executing before the fix. The adapter-specific first-step negative was added after the fix; its root behavior was RED in domain tests, not that adapter test. GREEN: 210 focused tests, TypeScript, scoped lint and tracked/untracked whitespace checks; full offline suite 5506 passed / 755 skipped, 183 passed / 30 skipped suites.

Independent follow-up mukjmag3-x-1koy confirmed closure of proactive/chronology and final-step pre-execution defects; 210 focused tests, TypeScript, tracked diff and new-file whitespace checks passed. One related subject-switch blocker remains: the assistant constraint ignores an unresolvable proposed product and compares only productId, not variantId. Thus a customer's affirmative can force the prior product/variant despite an assistant-proposed different subject. Correction writer mukjojui-y-2non is adding two minimal behavioral RED regressions and requiring an unambiguous exact product-and-variant match. No source acceptance, native review, commits or main integration yet. Parent measured actual source scope: new domain 634 lines + spec 393 lines; tracked adapter changes 682 additions / 22 deletions. Thus source scope is 1731 authored diff lines, larger than the writer's approximate 1200-line report; keep the selected two natural local units with their required tests rather than trim for size.

Known residuals: wrong failed IDs remain unresolved; ambiguity clarification requires gate evaluation before the budget ends, otherwise truthful unconfirmed fallback; fixed clarification asks product/presentation without asserting availability. New diagnostics and production logs still do not prove the precise cause of the original identity rejection.

## Final verification and work units
Final subject-switch correction requires named assistant proposals to resolve to the same productId and variantId as the real user subject. Behavioral RED: two selector negatives and one SDK clarification assertion failed before correction. Final GREEN: 214/214 focused tests; TypeScript, scoped lint and whitespace checks; offline full suite 5510 passed / 755 skipped tests, 183 passed / 30 skipped suites. Independent final verification reran the 214 focused tests and whitespace checks and confirmed the exact remaining finding closed. No live provider behavior was tested.

Unit 1: af262bb1b4dd036b99c5726ef6c3ec9dd575b389, domain selector/controller plus tests, 1140 additions. Native committed-range review review-ccb69ea4c54a68b7 approved and acknowledged. Non-blocking advisories R3-compound-reference and R3-unbound-search-gate are later work, not reopened corrections. This unit has no wired runtime behavior; domain tests cover the policy. Rollback removes the two new domain files only, provided the dependent adapter unit is removed first.

Unit 2: adapter wiring/tests plus this evidence document; depends on unit 1. Runtime evidence is the real SDK with MockLanguageModelV4, including observed pre-execution mutation denials and no-GET clarification cases. Adapter source/spec scope is 719 additions / 22 deletions. Rollback restores the adapter source/spec to 80146fd while leaving the unused policy module harmless. Native review and final local main integration are pending at document freeze; completion is recorded in session memory to preserve the reviewed bytes. Owner controls push and automatic deployment.
