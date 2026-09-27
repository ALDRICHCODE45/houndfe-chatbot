# RESTOCK recovery and stock evidence

## Authorization and evidence

Owner authorizes correcting existing-request generic failure and unsupported inventory claims. Work only in current chatbot worktree; no backend changes, production/DB/provider/Meta operations, dependency/config changes, .env reads, commits or deployment. Base main 4f470acb3f19b18fea17cf14523d117c86b3f0fc; tracked tree clean before this document, .codegraph untracked preserved. Previous reviewed trackers remain frozen.

Production logs show preflight blocked reason existing_restock, mapped to generic restock_unavailable before coordinator invocation. Earlier checkStock returned_error followed by a successful search does not prove exhausted stock. Mapping found existing trusted recorded context + backend GET + classification seams. Active marker alone proves neither acceptance nor current pending state.

## Unit R1: existing accepted request recovery

- [x] R1.1 Map marker, receipt, subject identity and current-state seams (delegated read-only mapper mujret8p-e-zbd8).
- [x] R1.2 Implement and test bounded read-only recovery (delegated writer; multiple nontrivial files). Initial independent findings corrected with regression tests.
- [ ] R1.3 Verify and review this unit; request separate commit consent before delivery. Independent follow-up closed all three findings; native review pending.

Return a distinct existing_restock_recorded outcome ONLY for a sender/product/variant-bound recorded acceptance. Current status pending requires validated backend GET. A validated current resolution may be response_recorded or stale; these do not imply WhatsApp notification or expose resolution payload. A proven local receipt without safely established current status permits current_status_unknown. Missing/ambiguous intake, subject mismatch, malformed context, forged/expired session and identity mismatch remain unavailable. Do not infer acceptance from boolean markers.

Recovery validates current inbound event and genuine catalog identity independently of the original accepted event. Use the original recorded source identity for backend classification, never replace it with the new customer message. No duplicate POST, coordinator intake call, legacy fallback, marker clearing or reservation release. A race never becomes a new intake; degrade safely. Already-closed or lost mappings are not recoverable by existing endpoint and remain unsupported.

Customer copy retains warm usted. A proven pending request can be acknowledged as an existing consultation awaiting a response; response-recorded only acknowledges recorded answer, never delivery; unknown states explicitly distinguish accepted consultation from unknown current state. No ETA or follow-up promise introduced.

## R1 verification evidence

Writer baseline 171 tests; RED new service import failed before implementation. Final focused seven suites: 230 tests passed; types, scoped eslint and diff check passed. Offline full suite: 5371 tests passed, 181 suites passed and 30 skipped. No live DB/provider validation. Parent readback checked service trust gates. Independent verification reproduced 230 passing tests/types/diff but found: bare context-store provider lacks pool injection; thrown GET response validation errors become unknown instead of unavailable; new tool outcome is unrecognized by adapter diagnostics. All three were corrected and independently closed: explicit PG_POOL factory plus real-store read, typed rejected-response versus outage distinction, and bounded existing_receipt diagnostic. Follow-up passed 332 focused tests, types and diff check; full offline suite passed 5391 tests with 755 skipped (181 suites passed, 30 skipped). No live DB/provider validation. Missing branch configuration remains safely unavailable. Native assessment unavailable due undeclared untracked paths, so independent verification required. Actual size exceeds original forecast due source/DI wiring and adversarial tests; retain tests and select delivery slicing before commit. Recovery requires configured branch ID; missing configuration remains unavailable. Diagnostic reports only recorded/unavailable recovery category.

## Unit R2: inventory evidence boundary

- [ ] R2.1 Project catalog tool output to omit product/variant stock while preserving identity, prices and other necessary fields; retain trusted identity installation.
- [ ] R2.2 Add bounded deterministic protection for failed checkStock followed by non-authoritative search; only later authoritative stock success can clear that failure. Define safe interaction with side effects before implementation.
- [ ] R2.3 Verify and review separately, then obtain delivery consent.

R2 not delegated yet. Removing raw stock does not universally prevent zero-tool hallucination; do not claim a universal guarantee or silently add a new agent architecture. Preserve warmer voice and all operational guards.

## Priority follow-up: estimate delivery after restart

- [ ] D1 Verify/recover durable ACTIVE + RECEIPT_RECORDED admission into existing poll/claim/send/ACK pipeline after restart, as a separately scoped unit.

Existing runtime sends staff-estimate/no-estimate messages; poller admission is process-local and no restart scan exists. Provider acceptance is not device delivery. Preserve branch/sender/application-ledger fencing and uncertain-send semantics. No new delivery implementation in R1.

## Tests and delivery boundaries

Use meaningful RED before source implementation, GREEN after, focused verification per unit and applicable offline full suite at closure. No live providers/DB; use synthetic fixtures. R1 regressions: same-subject accepted/pending; existing/resolved/stale; receipt plus GET failure; wrong subject/sender/session; ambiguous/unrecorded intake; zero intake POST and zero legacy effects on recovery; unchanged new intake. Include DI/registry integration.

One writer at a time. R1 source/tests/DI may exceed 400 authored lines; heuristic is advisory, never omit tests/minify. Estimate R1 400–700 and R2 200–350 lines including tests, subject to actual evidence. Delivery strategy ask-on-risk; agree chain strategy before any oversized delivery commit, not before implementation. No commit currently authorized. Rollback boundaries are separate R1 recovery and R2 inventory-evidence changes, each with tests. Parent owns this tracker and mirrors; workers cannot alter prior trackers.
