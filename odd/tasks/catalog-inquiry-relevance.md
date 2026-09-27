# Relevant availability replies

## Intent and scope

Owner approved a narrow correction after confirming deployed `2fc0971182acf2a06722c70354f1ffe6147ab257`. Customer asked only “Buenas noches, tienen ibuprofeno?”; the reply led with shortage but added an unsolicited missing-ETA statement and generic alternatives. Prior mapping and current flow readback show the shortage example itself includes missing ETA. Exact model-generation provenance is not proven.

Work only in `houndfe-chatbot-human-decisions`, branch `fix/catalog-inquiry-relevance`, base `2fc0971182acf2a06722c70354f1ffe6147ab257`. Keep previous approved trackers and untracked `.codegraph/` intact. No backend, provider, database, Docker, network, remote, secrets, dependency, configuration or flag operations. Commit/main integration requires fresh consent; owner pushes/deploys.

Edit surfaces: `src/llm-agent/domain/system-prompt.ts`, its adjacent `.spec.ts`, `src/sale-flow/domain/sale-flow-instructions.ts`, and its adjacent `.spec.ts`. Source changes are prompt strings only. Parent owns this tracker. Reuse existing source mapping; one bounded writer handles remaining preparation and edits.

## Acceptance

- Separate a simple availability answer from a replenishment inquiry. Do not automatically disclose missing ETA for availability-only questions. Keep honest missing-date guidance when replenishment is relevant; never fabricate or promise dates.
- If a real candidate was presented and required presentation confirmation is missing, ask a concrete question such as “¿Buscaba esa presentación?”. Do not infer selection, invent other options, or repeat confirmation already established by the existing flow.
- Preserve warm Mexican usted, optional contextual emoji, contextual pricing, single/multiple-candidate distinctions, stock authority, dosage/form, step 4 confirmation, immediate step 5 assistance without new consent gates, no retries, historical-intake honesty and protected literal replies.
- No runtime, tool, SDK, model, history, storage, routing or postprocessing changes. No fixed output renderer. Offline prompt tests cannot prove actual tone or relevance.

## Tasks

- [x] R1 — DONE: Writer `mujiu716-g-qhob` and follow-up `mujj0jv5-h-rhf2` completed four-file guidance/tests (+71/−7). Parent readback removed an unintended category restriction and required an explicit missing-date AND relevance condition. Final follow-up observed RED (4 failed, 57 passed), GREEN (61 passed) and 241 focused passes; general identification constraints remain.
- [ ] R2 — IN PROGRESS: Independent verifier `mujj7eiy-i-5i5r` passed offline technical checks; native review is pending on this normalized candidate. No prompt assertions are evidence of actual model quality.
- [ ] R3 — Obtain authorization for exact local commit/main delivery.
- [ ] R4 — Owner validates actual question/reply pairs after deployment; prior voice acceptance remains pending.

## Checks and delivery

Forecast: 60–120 source/test diff lines plus tracker; `ask-on-risk`, approximately 400 lines advisory, never a reason to omit coverage or compress code. Focused Jest covers prompt, adapter, runner, module and assistance suites. Run build/spec `tsc --noEmit --incremental false`, scoped non-fixing ESLint/Prettier and whitespace checks. Full offline suite follows at closure. No emitted Nest build or live model evaluations.

Independent verification: 241 focused tests passed; full suite 5301 passed, 755 skipped, 180 suites passed and 30 skipped, zero failures. External Docker opt-in was inactive. Build/spec non-emitting typechecks, scoped lint/format and whitespace passed. Four-file diff hash stayed `e39ad0ac5d38f33d0ee5b68a63ffa53eced7d9a3ef308290da5b828a5d69e04c`; Git status and candidate contents were unchanged. Parent and independent readback confirm joint date conditions, no category restriction and preserved operational steps. Base prompt length and unchanged SDK composition tests passed.

LSP warning probe returned four inconclusive files, not confirmed clean. Initial native assessment could not classify undeclared untracked scope; independent verification satisfied its conservative plan. Actual generated tone, semantic behavior, live providers, owner acceptance and skipped integrations remain unverified.

Rollback only this prompt/test unit; preserve previous fixes, operational records and all frozen trackers. No resets/replays, emitted build, commit or delivery performed. Freeze this pre-review tracker with the candidate; record subsequent review/delivery outcomes separately without changing approved content.
