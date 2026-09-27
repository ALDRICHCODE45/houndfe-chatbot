# Align chatbot replies with HoundFe customer service

## Intent and authority

Owner approved warm, approachable usted, Mexican Spanish and discreet friendly emojis for greetings, product inquiries and interest registration, based on three actual HoundFe conversations and two bot examples. Implement only in `houndfe-chatbot-human-decisions`, branch `feat/houndfe-customer-voice`, base `bf9735eb07089278be93ba6cc56630a82decde72`. CodeGraph is permitted; never stage its index. No backend, database, provider, production, remote, secret, dependency or global-configuration operations. Local commit/main integration needs separate approval; no push/deploy.

## Evidence and boundaries

Human examples predominantly use usted with greetings, gratitude, useful product information and contextual emoji accents. Bot examples narrate discovery, show empty metadata, repeat generic closings and expose implementation terminology. The reported registration reply echoed internal no-contact/no-notification wording. Current sale-flow and tool instructions contain similar wording; this is a plausible leakage source, not proof of generation provenance.

The approved voice answers the customer's request rather than narrating internal processing. Keep relevant verified presentation/price/stock information, short useful bullets, and one contextual next step. Do not ask what the customer needs when the message already says it. Omit meaningless labels such as Sin Marca. Avoid repetitive bureaucratic closings, forced emojis and premature farewells.

Keep internal safety rules but distinguish them from customer copy. Confirmed registration may say: “¡Listo! 😊 Registramos su interés por [producto/presentación].” It must not promise reservation, human contact, review, notification or ETA. Verified available stock may use “Claro que sí”; catalog presence alone cannot. Unknown stock, no match, exhausted stock, absent ETA and uncertain registration remain distinct. Never substitute dosage or infer selection. Translate internal recovery instructions into a useful customer question without exposing UUIDs or backend state.

Preserve identity, stock authority, explicit confirmation, intake truth, marker/routing, idempotency and no-retry behavior. Human response/notification implementation is out of scope. Existing exact legacy/payment/waiting/unsupported-refusal contracts are not incidental wording cleanup; preserve them and existing unknown-ETA guidance. No fake human identity or unsupported commitments.

## Tasks and route

- [x] V1 — DONE: Delegated explorer `mujei9fx-a-3shf` mapped three source files and two existing prompt suites; tool and boot-composition suites remain unchanged. Scope below is confirmed. No commands or implementation were performed by the explorer.
- [x] V2 — DONE: Bounded writer `mujepgt9-b-k6en` changed exactly the five allowed files (119 additions, 3 deletions). Added conditional voice examples and internal/customer-copy separation; preserved operational sequence and protected literals. New guidance tests observed RED (7 failed, 48 passed), then GREEN (55 passed); four focused suites passed (137 tests).
- [ ] V3 — IN PROGRESS: Independent verifier `mujeyt5v-c-hkkd` passed preserved-contract checks and full offline regressions; native review is pending on this normalized candidate. Initial assessment could not classify undeclared untracked scope, so its conservative plan required independent verification. Writer model/effort unknown.
- [ ] V4 — Obtain local delivery authorization; owner later deploys and judges real responses against the approved voice, without assuming prompt tests prove model compliance.

## Verification and delivery plan

Mapped forecast: approximately 125–215 authored changed lines including tests/tracker. Delivery strategy: ask-on-risk; about 400 lines is an advisory planning heuristic, not an acceptance cap. No artificial splitting, compressed copy or omitted coverage. New coherent candidate, not a reopening of earlier reviews.

Allowed writer paths: `src/llm-agent/domain/system-prompt.ts`, `src/llm-agent/domain/system-prompt.spec.ts`, `src/sale-flow/domain/sale-flow-instructions.ts`, `src/sale-flow/domain/sale-flow-instructions.spec.ts`, and `src/sale-flow/application/tools/request-human-assistance.tool.ts` (definition description only). Keep `SYSTEM_PROMPT` under 4000 characters. Leave `CATALOG_RECOVERY`, runtime canned handoff messages, all execution logic and the parent-owned tracker unchanged.

Use test-first RED/GREEN for deterministic prompt-composition and safety-contract assertions. Add approved guidance assertions in the two prompt suites, observe missing-guidance RED, then implement and run those suites plus unchanged `request-human-assistance.tool.spec.ts` and `llm-agent.module.spec.ts` using `pnpm exec jest --runInBand --no-cache --runTestsByPath`. Writer runs both non-emitting TypeScript checks (`tsconfig.build.json` and `tsconfig.spec.json`, incremental disabled), scoped non-fixing ESLint/Prettier and `git diff --check`. Full offline suite and an independent spot check belong to V3. No installs, live provider evaluations, destructive emitted build or new test infrastructure. Static wording tests prove supplied instructions and preserved boundaries, not warmth or compliance of an actual model response. Report failures/skips honestly.

Independent verification repeated 137 focused tests and passed the full suite: 5295 passed, 755 skipped; 180 suites passed, 30 skipped, zero failures. Docker opt-in gating was inactive. Both non-emitting TypeScript checks, scoped non-fixing ESLint/Prettier and `git diff --check` passed independently. Prompt length is 2302 characters. The five-file source/test diff hash stayed `6e6d983eda2418e6964b5fa0d4b54ae4ce5282b456564661571cead9010b61f7` before/after verification; no candidate edits occurred.

Parent readback and independent inspection confirm only prompt strings and the tool description changed in source. Active LSP probe found no primary errors/warnings; three existing Zod deprecation hints and auxiliary spellcheck/style/import findings remain. No claim that every diagnostic is clean. Skipped external integrations, live-provider behavior, actual model warmth/compliance and end-to-end delivery remain unverified.

Rollback removes this five-file voice-guidance/test unit only and restores prior prompts; preserve catalog identity and SDK7 instructions fixes, state, routing and all operational records. No migrations, flags, state reset, automatic replay, emitted build, commit or delivery performed. Freeze this pre-review tracker with the candidate; record native-review and delivery outcomes separately afterward rather than modifying approved content.
