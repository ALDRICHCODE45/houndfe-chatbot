# HoundFe contextual warmth

## Authorization and scope

Owner explicitly approved contextual greeting, friendly emojis, warm Mexican usted and appropriate gratitude/closing based on three service screenshots. Copy the style, never private customer details, staff identity or transactional facts. No commit, push, deployment, provider calls or database operations authorized.

Base: main 9d08841617e72e853c85f5b90c2b081ef5d489ed. Tracked working tree clean; .codegraph/ untracked preserved. Previous reviewed trackers remain frozen.

## Behavior

Reciprocate an initial customer greeting (including their stated time of day) while answering the actual request. If time is unknown use a neutral greeting, never invent a clock/timezone. Use a light contextual friendly emoji in ordinary greeting/service responses rather than leaving the entire brand style optional. Avoid emoji overload, repeated greetings and forced gratitude. Thank preference at genuine closure; thank patience only when a wait is supported by context. Do not prematurely close an unresolved inquiry. Keep warm usted and service framing, not human impersonation. Preserve literal/fixed messages, factual/stock/identity/confirmation gates, accepted-consultation and ambiguous-result semantics. No changes to automatic tool sequencing or message persistence.

## Tasks and routing

- [x] W1: Replace/consolidate voice guidance and add contextual regressions. Delegated writer recovered after interruption; non-voice guards restored. Five files, 271 additions / 10 deletions.
- [ ] W2: Verify focused and full applicable checks, inspect diff and complete native review. Independent verification passed; native review pending.
- [ ] W3: Obtain separate local delivery consent and owner live style acceptance.

Allowed source surfaces: src/llm-agent/domain/system-prompt.ts and src/sale-flow/domain/sale-flow-instructions.ts. Tests: corresponding .spec.ts files and src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts. No execution changes or tool-description edits needed unless a genuine contradiction blocks this scope; return blocker instead of expanding.

## Verification and delivery

Test-first RED then GREEN for explicit instruction contracts and real SDK/mock-provider transmission where existing tests apply. Cover initial greeting vs continuation, contextual gratitude vs unresolved inquiry, known vs unknown time, normal service vs fixed/error messages. Tests prove instructions transmitted, not generated style. No live provider calls authorized.

Focused Jest: system-prompt.spec.ts, sale-flow-instructions.spec.ts, vercel-ai-llm-agent.spec.ts and unchanged request-human-assistance.tool.spec.ts. Run TypeScript noEmit for tsconfig.spec.json, scoped eslint without --fix, git diff --check and default offline Jest suite only with DB/provider gates disabled. Record observed results and skips.

Forecast 80–160 authored diff lines plus tracker; delivery strategy ask-on-risk. About 400 lines is an advisory heuristic, not a hard cap or reason to weaken tests. One coherent unit; no commit until separate authorization. Rollback only this unit's copy and tests.

## Observed progress

Initial writer cancelled after excessive runtime, preserving partial edits. Recovery verifier observed 8 failures / 143 passes. Bounded recovery and parent pre-review corrections restored original non-voice rules rather than trimming them to satisfy a sanity-only prompt length bound. Bound raised from 4000 to 5000 with rationale; no runtime cap found; current prompt length 4391. Final writer reports 151 focused tests passed, TypeScript noEmit/scoped eslint/diff check passed. Parent source diff readback confirms only intended voice changes. Independent verifier mujp8kxg-a-fklk found no regression: 227/227 focused tests passed, TypeScript noEmit and diff check passed; offline full suite 5312 passed, 755 skipped across 30 suites. Lint passed in writer checks, not rerun independently. Native assessment unavailable due untracked declaration; required independent verification now complete. No live generation or delivery performed.

## Deferred priority

After voice: verify staff-entered restock days/no-estimate -> resolution -> correlated application -> outbound WhatsApp reply. Do not lose this owner-priority follow-up or implement it inside the voice unit.
