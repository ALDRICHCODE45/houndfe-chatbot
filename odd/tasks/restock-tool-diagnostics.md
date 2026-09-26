# Observe tool identity and bounded RESTOCK outcomes

## Intent and authority

Owner approved extending diagnostics after deployed `d3dfcc2e4c989f3068b032dd6b194ce4dc4aae7d` emitted only `run_completed`, two observed steps and one model tool call. Owner confirmed no other diagnostic record exists. The actual tool and result remain unknown; do not infer stock or request failure from the assistant reply.

Only `houndfe-chatbot-human-decisions`, branch `fix/restock-tool-diagnostics`, base `d3dfcc2e4c989f3068b032dd6b194ce4dc4aae7d`. Protect other worktrees and `.codegraph`; never use CodeGraph. Owner alone pushes, deploys and runs hosted probes. Owner explicitly authorized local commit and FF-only local-main integration for this unit after passing tests and native review. Stop on unexpected Git drift; push/deploy remain owner-only.

## Route, surfaces and budget

One delegated writer reads the exact adapter/tool/registry contracts needed for this change and edits only `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` and its adjacent `.spec.ts`. Parent owns this tracker and review. Forecast 200–330 source/test diff lines plus this tracker, bounded by 390. Stop on scope expansion; do not omit tests or compress code.

- [x] T0 — Confirm aggregate-only evidence and select the existing adapter diagnostic boundary.
- [x] T1 — Add failing fixed-metadata tests and extend guarded callbacks without changing agent behavior. Writer `muipi7rq-h-hlpr`, refinement `muipreo8-i-66ex` completed.
- [ ] T2 — IN PROGRESS: Independently run offline checks and native review, then commit and integrate the exact candidate into local main under explicit owner authority.
- [ ] T3 — Owner deploys, sends one availability inquiry and supplies only the new diagnostic records.

## Required behavior

Keep prefix `catalog_diagnostic` and random per-run correlation. Preserve existing search/count and terminal events. Add fixed, explicitly allowlisted tool identities and safe result categories, prioritizing `checkStock` and `requestHumanAssistance`. Unknown names/values map to fixed unknown labels, never copied strings. Inspect actual tool contracts before classifying; missing data is unknown, not success. Distinguish validated out-of-stock envelope, historical intake, legacy customer notification, disabled/unavailable/other returned error, thrown execution error and ordinary success where supported. These describe returned evidence, not delivery or later human resolution.

If SDK execution-end hooks alone miss a model call rejected before execution, provide a bounded requested-tool-name observation from step completion; label requested versus executed explicitly. Never inspect arguments or serialize calls, results, context, products, IDs, headers, keys, errors or response text. Use only fixed labels, scalar counts/booleans and random run IDs. Bound metadata inspection, retain per-run isolation and incomplete-observation semantics; logging/getter failures must not alter replies or original thrown errors.

No prompt, tools/schema/registry, stock/RESTOCK, backend, flags, persistence, retries, ingress/dedup, dependencies or existing raw-error logger changes. No runtime/provider/DB/network/remote access. Temporary metadata remains always on until removal; it is not a claim that all existing logs are PII-free.

## Checks and limits

Writer RED: 22 failed / 102 passed (2.480s); GREEN 124 (2.565s), then 125 (2.384s). Refinement RED: 20 failed / 128 passed (2.422s); final GREEN 148 passed, four suites, zero skips (2.286s). Tests cover all 13 registered tool names, requested-only calls, safe generic/core outcomes, unknown/malformed data, hostile getters, 16-name cap, all-logger-argument privacy, original reply/error, concurrency and existing search events. Exact spec/build noEmit nonincremental typechecks, scoped non-fixing lint/format and diff check passed. Two-file diff is 336 additions / 16 deletions; this tracker adds 31 lines (383 total). Writer reports no CodeGraph access. Installed SDK contracts plus fake callbacks do not prove hosted execution. Independent command-only full offline verification and native review remain pending.

Runtime RESTOCK acceptance and the repeated-reply cause remain pending. Rollback removes only the added diagnostic observations/tests; earlier catalog diagnostics and prompt/backend fixes stay intact.
