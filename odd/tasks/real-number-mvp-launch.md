# Real-number MVP launch

## Goal

Put a deliberately narrow, client-usable HoundFe sales pilot on the purchased WhatsApp number as soon as the number is registered in Meta Cloud API. Preserve the completed receipt-media implementation while deferring its owner-infrastructure rollout work to ODD-8.

## Pilot contract

The first client pilot includes:

- signed inbound WhatsApp messages and outbound replies on the real number;
- durable conversation history and webhook deduplication;
- catalog and stock search by text;
- cart, pricing evaluation, customer/address collection, order summary, sale creation, and cancellation;
- current payment details from the backend;
- human handoff for unsupported, promotional, stock, or operational cases;
- controlled observability and rollback.

The first pilot does not wait for:

- automated shipping quotes or carrier assignment;
- product-photo recognition;
- card/Link EVO payment;
- proactive/template campaigns;
- ODD-8 receipt-media production activation.

Receipt-media code remains preserved and visible in the launch plan. DigitalOcean Spaces, capability keys, proxy-log redaction, alert transport/thresholds, reconciliation drills, and the controlled G-2 real-infrastructure proof remain explicit ODD-8 gates.

## Guardrails

- Do not expose or copy secrets into repository artifacts or chat.
- Do not modify backend code from this repository.
- Do not enable receipt-media flags before ODD-8 infrastructure and smoke checks pass.
- Do not test with real customer sales, payments, addresses, or receipts before the controlled pilot gate.
- Keep the existing test-number path available until the real number is registered and verified.
- No push, deploy, Meta mutation, DNS mutation, or production configuration change without an explicit owner action at that step.
- Preserve protected untracked paths: `.codegraph/**`, `odd/tasks/receipt-media-stored-worker.md`, and `openspec/changes/receipt-media-ingestion/**`.

## Tasks

- [x] **MVP-0 — Freeze the narrow pilot and isolate launch work:** create `feat/real-number-mvp-launch` from the completed receipt-media branch, record the pilot/non-goals, and retain ODD-8 as a named rollout dependency rather than silently dropping it.
- [x] **MVP-1 — Make recipient addressing production-safe (completed as `8fd02b6`):** replace the unconditional Meta sandbox Mexican-recipient rewrite with an explicit default-off sandbox compatibility mode. Production must preserve the exact inbound `wa_id`; the test number may opt into the historical rewrite until cutover. Cover sender, ops-channel comparison, configuration, validation, and regression behavior with strict focused tests.
  - Evidence (independently verified, native-reviewed as `review-fa42219bde31f17b`, and locally delivered by `8fd02b6`): implemented `META_SANDBOX_RECIPIENT_NORMALIZATION` (Joi boolean default `false`), typed `meta.sandboxRecipientNormalizationEnabled`, explicit required-boolean `normalizeSandboxRecipient(to, enabled)`, verbatim `OPS_CHANNEL_PHONE`, and same-mode sender/ops comparison. Strict focused TDD: RED 13 failed/212 passed, GREEN 220 passed across sender/configuration/env-validation/handoff specs. Regression: 18/19 suites pass; only pre-existing `config.module.spec.ts` fails (stale `receiptMedia` fixture missing `worker.enabled`/`metricsToken`, unrelated to MVP-1). Static: Prettier clean, scoped ESLint clean, production no-emit `tsc` exit 0. Diff 220 added+deleted lines (hard-stop boundary). Checkbox intentionally open pending independent verification/native review/delivery; no stage/commit/push.
- [ ] **MVP-2 — Publish the real-number onboarding runbook:** document the owner/client steps for SIM readiness, Meta WABA registration, display-name approval, verification code, phone-number ID, permanent System User token, webhook subscription, WhatsApp Business App exclusion, rollback, and secret handling. Include a nontechnical client checklist without exposing credentials.
- [ ] **MVP-3 — Add a no-secret launch preflight:** provide a bounded, repeatable check of required configuration names, migration presence, feature flags, backend endpoint reachability expectations, cashier/credential/payment-detail/catalog data requirements, and the deliberate receipt-media-off posture. The check must never print secret values.
- [ ] **MVP-4 — Validate the pilot candidate locally:** run focused recipient/config/handoff tests, relevant sale-flow and dispatcher regressions, build, migration integrity checks, and a bounded environment audit. Record every skipped external check honestly.
- [ ] **MVP-5 — Reconcile and deliver the launch candidate locally:** independently verify the candidate, run native review when applicable, create reviewable local work-unit commits after maintainer authorization, and leave push/deploy to explicit owner decisions.
- [ ] **MVP-6 — Register and deploy the real number:** with the owner present, register the purchased number in Meta Cloud API, update Dokploy secrets, run chatbot migrations, deploy, subscribe the app/webhook, and confirm health without enabling receipt ingestion.
- [ ] **MVP-7 — Run the controlled client pilot:** execute one synthetic journey on the real number — greeting → product search → stock → cart → customer/address → quote → sale → payment details → optional cancellation/handoff — then admit a small client test group with rollback and monitoring.
- [ ] **MVP-8 — Resume ODD-8 after pilot stability:** provision DigitalOcean Spaces and capability keys, prove proxy/log redaction and alerting, run reconciliation drills and the controlled G-2 proof, enable receipt-media gates gradually, and add the receipt journey to the client pilot.

## Launch gate

The narrow pilot is ready only when MVP-1 through MVP-7 have observed evidence. MVP-8 is not required for the first text-sales pilot, but it remains required before claiming automated receipt-media production readiness.
