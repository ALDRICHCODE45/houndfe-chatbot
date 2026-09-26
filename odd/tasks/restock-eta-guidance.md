# Clarify replenishment-date support without inventing an ETA

## Intent and authority

Owner explicitly approved this prompt-only correction after a real ETA inquiry received the generic unsupported-function response with one completed step and zero tool calls. Catalog retrieval now returns one candidate after the separately deployed backend spacing fix. No deterministic feature-flag conflict was found; semantic ambiguity is a hypothesis, not proven model causation.

Work only in `houndfe-chatbot-human-decisions`, base `f7f78d2db75e0ffb15808ba9e5e395fedc487744`. Protect other worktrees and `.codegraph`; never use CodeGraph, including structural discovery. No backend, flags, registry/tools, ingress/dedup, runtime fallback, persistence, logging, network/provider/DB or deployment changes. Owner alone pushes, deploys and tests hosted behavior. Owner subsequently explicitly authorized the local commit and FF-only local-main integration after passing tests and native review. Push and deployment remain owner-only; stop on unexpected Git drift.

## Route and budget

One delegated writer for four prompt/source-test files; parent owns this tracker and review. Forecast 100–220 changed lines including tests and this tracker; stop above the owner's 390-line bound or on required scope expansion. Do not omit tests or compress code to fit.

- `src/llm-agent/domain/system-prompt.ts`
- `src/llm-agent/domain/system-prompt.spec.ts`
- `src/sale-flow/domain/sale-flow-instructions.ts`
- `src/sale-flow/domain/sale-flow-instructions.spec.ts`

## Tasks

- [x] E0 — Inspect refusal rule, prompt composition and actual RESTOCK prerequisites. Quantity is optional; no confirmed ETA does not make the availability inquiry unsupported. Repeated reply remains separately unexplained.
- [x] E1 — Add failing instruction-contract tests, clarify base and sale-flow refusal boundaries, then verify focused contracts with one writer. Completed by `muios0ik-e-gb31`.
- [ ] E2 — IN PROGRESS: Independently verify offline candidate and run current native review, then commit the exact candidate and integrate into local main under explicit owner authority.
- [ ] E3 — Owner deploys and performs one natural ETA inquiry; observe the response and actual tool evidence before claiming runtime improvement.

## Acceptance and boundaries

The exact unsupported-function phrase remains available for genuinely unsupported requests. Classify replenishment-date questions as supported availability inquiries even before a purchase commitment. When no confirmed replenishment date exists, acknowledge that limitation without claiming an unsupported function, a date, a submitted request, contacted staff or promised notification. Follow existing product/presentation/variant confirmation and real-ID recovery rules, then `checkStock`; only its validated shortage envelope permits the existing assistance route. A missing quantity is not a technical RESTOCK prerequisite; never invent quantity or assume product choice. Preserve historical-intake versus human notification/error outcomes, all stock/error/idempotency safeguards and other sales/shipping/receipt contracts.

No simulated test proves LLM compliance. Instruction tests establish only supplied contract text and composition. The repeated-message observation is not fixed by this change.

## Checks and rollback

Writer changed only four prompt/test files, 107 additions / 10 deletions. RED: 5 failures / 93 passes across four suites (2.051s), on the new ETA, refusal-boundary, confirmation and quantity contracts. GREEN: 98 passed with no skips (2.146s), including shipping on/off composition and existing safeguards. Exact spec/build noEmit nonincremental checks, scoped non-fixing ESLint/Prettier and diff check passed. Writer reports no CodeGraph calls. Independent full offline suite and current native review remain pending. Real model, PostgreSQL and delivery checks remain owner-operated and pending; prompt tests do not establish model compliance. Rollback affects only the four prompt/test files; diagnostics and backend matching remain intact.
