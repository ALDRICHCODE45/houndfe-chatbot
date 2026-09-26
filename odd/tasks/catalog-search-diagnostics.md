# Observe catalog execution without logging customer data

Owner explicitly requested diagnostic logs followed by owner-operated push, one hosted query, and inspection. Deployed `431dbcf6dbebfadc432ecfa06f21959489b67af6` still reports catalog absence despite successful direct catalog probes; actual model tool calls/results are not retained. Instrument the adapter, not search behavior.

## Scope and route

- Only `houndfe-chatbot-human-decisions`; protect principal and `.codegraph`. Parent owns this tracker, Git and review. One delegated writer owns adapter and adjacent spec.
- Exact source surfaces: `src/llm-agent/infrastructure/vercel-ai-llm-agent.ts` and `src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts`.
- Temporary always-on fixed metadata logs for every agent run until removal. Random per-run correlation, never derived from customer/provider identities. No new environment flags or owner configuration changes.
- No raw prompts, queries, phones, inbound/provider IDs, response text, product data, arbitrary tool names, headers, cookies, credentials or error messages/objects in new logs.
- No search rewrites, retries, tool/context changes, stock/RESTOCK changes, backend, persistence, existing dispatcher log refactor, dependencies, private environment, real providers, DB, browser or remote access. Owner alone deploys/tests hosted.
- Forecast up to 350 adapter/spec diff lines plus 35 tracker lines, bounded by 390. Stop on required scope expansion; never omit tests or compress code to meet budget.

## Tasks

- [x] D0 — Map installed SDK hooks and minimal logging boundary. Scout `muimltrh-9-fd6c` inspected ai 7.0.9 hooks and existing fake GenerateTextFn tests; no mutations or execution.
- [x] D1 — Add failing offline diagnostics/privacy tests, implement bounded observational hooks, and run focused checks. Completed by delegated writer `muimq6bt-a-i7r9`.
- [ ] D2 — Independently verify full offline candidate and native review; commit exact reviewed tree locally. IN PROGRESS.
- [ ] D3 — Owner pushes/deploys, performs one timed probe, and shares only new diagnostic records. Hosted cause remains unknown until evidence arrives.

## Acceptance

- Per-run closure with fresh random UUID, observed step/call counters and explicit incomplete-observation state; no shared mutable correlation.
- Count calls via `onStepFinish`; inspect only literal `searchCatalog` in `onToolExecutionEnd`. Installed discriminator is `event.toolOutput.type`, not the stale comment's success field.
- Result categories: success plus array length; mapped_error for ok false; execution_error for tool-error; unknown_output otherwise. Never call malformed/missing observation empty success.
- After generation resolve/reject emit run_completed/run_failed. Failed generation rethrows the identical exception, without logging it. Neither event asserts outbound delivery.
- Guard observational metadata reads and logging failures so they cannot alter agent behavior. Constant-depth field reads/array lengths only; no item traversal or complete output serialization.
- Tests cover no-tool, empty/nonempty/stock0, mapped/thrown errors, multistep, interleaved runs, unknown/malformed/hostile data, sensitive sentinels across all logger arguments, and logger failure isolation.
- Preserve system/messages/tools/context, usage, stop condition, returned reply/history and RESTOCK forwarding. Positive result count alone does not prove relevance or model interpretation.

## Verification and next step

Writer changed only adapter/spec: 312 additions / 10 deletions (322 diff lines). Initial RED exited on absent callback without summary; deterministic RED then showed 17 failures / 43 passes (2.012s). GREEN passed four suites / 60 tests with no skips (1.959s); final strengthened same-adapter interleaving test run passed 60/60 (1.945s). Exact spec/build noEmit nonincremental typechecks and scoped non-fixing lint/format/diff checks passed. Hook support is installed ai 7.0.9 source/type evidence plus fake-callback tests, not actual SDK execution or hosted proof. Every record uses prefix `catalog_diagnostic` and random runId; search events carry a fixed category and success-only count, terminal generation events carry observedSteps, nullable toolCalls and observationComplete. Logger failure cannot replace returned reply or original thrown exception. Full offline suite/current native review remain pending. Rollback removes only diagnostic hooks/helpers and their tests; no DB/config rollback.
