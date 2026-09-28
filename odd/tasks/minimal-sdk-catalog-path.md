# Minimal SDK catalog path (experimental, default-off)

**Authorization.** Owner-approved LOCAL, additive experiment. No commits/push/
deploy; no backend repo, DB/CAS, real API/Meta, Docker, secrets, `.env` or
dependency changes. Legacy catalog/AgentRunner/adapter/ledger/prompt untouched.
Line cap: hard 650 authored added+deleted lines, amended by the owner after the
disclosed 624-line overrun. No feature expansion.

**Scope.** Separate default-off route at the ordinary `AgentRunner` invocation in
`webhook-dispatcher.service.ts`: an exact allowlisted Meta wa_id calls the AI SDK
`generateText` loop with two inline READ-ONLY tools (`searchCatalog`, `checkStock`)
and returns `result.text` verbatim — conversation/search/confirmation/stock only,
NO writes/sales/payments. Auth/dedup/echo/ops/pending-human/receipt/media/sending
pre-routes stay intact; off or non-allowlisted senders keep the legacy path.

**In-memory tradeoff.** History is IN MEMORY ONLY per sender, isolated from
`ConversationStore`/legacy catalog; restart loses it (owner-accepted). Turns are
bounded by `LLM_HISTORY_TURNS` at a user boundary so tool-call/result pairs never
split. A single-process busy guard allows one in-flight SDK run per sender (no
queue/distributed lock); a concurrent same-sender turn gets a bounded busy reply
(`kind: 'handled'`) and NEVER falls back to the mutating legacy runner.

**Activation (manual only).** `MINIMAL_CATALOG_AGENT_ENABLED=true` (literal) plus
`MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS` (exact wa_id CSV). Empty/invalid lists
enable NOBODY; no hardcoded owner phone. Rollback = unset the flag.

**Official docs.** `ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx` (loop +
`stopWhen: isStepCount`); `08-migration-guides/23-migration-guide-7-0.mdx`
(`result.responseMessages`, aggregate `result.usage`); `55-testing.mdx`
(`MockLanguageModelV4`); `@ai-sdk/openai/docs/03-openai.mdx` (`openai(model)`).

**TDD + checks.** First RED: `Cannot find module './minimal-catalog-agent.service'`.
Concurrency-fix RED: the busy test expected `{kind:'handled', reply:'Ya estoy
atendiendo…'}` but received `{kind:'not-handled'}`. After the source fix: 4/4
service + dispatcher routing GREEN. Focused jest + tsc + scoped eslint/prettier +
`git diff --check`. Mock tests do NOT prove real-model personality.

**Limitations.** Cost guard WARNING-ONLY; no retry loop; steps bound by
`LLM_MAX_STEPS`. No real-model trial run. Independent recheck PASS:
149 focused / 5625 full tests passed, 755 skipped; scoped types/lint/format passed.
