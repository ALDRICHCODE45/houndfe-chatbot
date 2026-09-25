# Meta test-number demo — isolated webhook profile

## Outcome

Demonstrate a real Meta **test-number** customer conversation using the bot's existing signed webhook and sender without starting the production `AppModule`. Human decisions belong in the POS/backend, **not** an operator WhatsApp chat; the previously proposed LEGACY_OPS two-phone demo is explicitly rejected as the target. The client meeting is imminent; preserve the committed offline fallback in `docs/demo-client-offline.*`.

## Authority and limits

- Owner approved **feasibility and preparation** for Meta sandbox plus a temporary ngrok HTTPS tunnel, not sending messages. Exact test number and one verified customer recipient must be confirmed and outbound explicitly authorized later. A second operator phone is NOT needed for POS human decisions.
- Write only in this bot human-decisions worktree; no Meta requests, ngrok tunnel startup, real LLM/backend/Skydropx, production DB, deploy, branch merge, or push during offline implementation. No credentials in commits, logs, or chat. `.env.local` is gitignored and must be owner-supplied for any later sandbox trial.
- Keep `HUMAN_DECISIONS_RESTOCK_ENABLED=false` and `SHIPPING_QUOTES_ENABLED=false`. This demo may exercise **LEGACY_OPS**, not pretend RESTOCK/SHIPPING_APPROVAL is live.
- Each work-unit commit changes at most 390 complete lines (additions + deletions). Use observed RED→GREEN for behavioral work and independent verification. Typecheck with `--noEmit --incremental false` only; no build or deliberate `dist/` writes.

## Proven prerequisites

- `WebhookController` GET/POST and `SignatureGuard` HMAC are wired; `MetaWhatsappSender` sends through Graph API.
- Full `AppModule` includes extra routes (`/`, receipt media/metrics) and eager backend/LLM config, so it is **not** acceptable behind ngrok. Only a test-only Nest module with `WebhookController` may be exposed.
- Shell/worktree lack Meta/OpenAI/backend credentials and `.env*`; ngrok config valid, Docker available. Full Joi requires placeholders for unreachable backend/LLM fields even in the isolated profile.
- One verified Meta test customer is sufficient for the customer-facing demonstration. Exposed local routes must be limited to `GET/POST /webhook`; all others 404.

## Work units

- [x] **M1 — Signed local echo, restricted route surface (offline).** Test-only module uses real webhook controller/guard/dispatcher with fake agent/sender/receipt/handoff, in-memory stores. Behavioral RED was missing module; GREEN and independent review **1 suite/8 tests**, 401 signature negatives, 403 bad verify token, 404 on `/`, media and metrics. Both no-artifact typechecks passed (configs exclude `test/`); Jest/ESLint checked the test files, formatting clean, dist/buildinfo unchanged. Native assessment unassessable on untracked files; **no native approval**. Commit `6260b12` (279 additions/3 deletions, within budget).
- [x] **M2a1 — Sandbox configuration and recipient fence (offline).** Pure explicit-env parser rejects malformed/missing values and non-Meta Graph origins; wrapper sends only to the canonical approved customer, never operator/wrong number or empty text. Behavioral RED 18 failed/1 passed → GREEN **19/19**. Independent FAIL found TS2542 readonly mutation in the test, corrected and independently rechecked PASS. Required spec/build no-output typechecks, lint/format clean; extra root typecheck still has five pre-existing TS2339 in unchanged `test/echo.e2e-spec.ts`, with no new TS2542. Commit `6cd7d0a` (**388/390** source+test lines). No Meta request.
- [ ] **M2a2 — Real Meta sender bootstrap (still offline verification, in progress).** Route: bounded delegated writer. Test-only entry loads ignored `.env.local` explicitly, uses the actual sender behind M2a1 fence but no real call in tests, starts only restricted module on loopback; no `dist/`, no ngrok automatic startup. RED→GREEN and local commit.
- [ ] **M2b — Bounded real LLM sandbox (offline tests first).** Owner has an API key/budget but has not supplied the key. Generate replies without sale/handoff tools or backend calls, cap steps/output and explicitly label unverified product facts; no real provider request before fresh bounded authorization. Separate from M2a, never embed credentials.
- [ ] **M3 — RESTOCK POS handoff integration (offline, separate feature tracker).** Human sees a bounded structured context in the POS; bot intake, current GET, application ledger, customer send and ACK need independent tested cuts. Never replace this with LEGACY_OPS or fabricate a joined demo. Scope and safety gates live in `odd/tasks/human-decisions-restock.md`.
- [ ] **M4 — Explicitly authorized sandbox rehearsal.** Only after exact test customer target, fresh outbound authorization and callback-change approval; configure ngrok/test app temporarily, rehearse signed callback and real Meta sends, stop/revert configuration after demo. Human POS path is shown live only if M3 and FE/backend integration are actually verified; otherwise label the parts separately.

## Status

Mapping done; M1 `6260b12` and M2a1 `6cd7d0a` verified; M2a2 in progress, M2b–M4 pending. No test-number message sent and no public webhook started. The prior offline demo passed 9 suites/88 tests and remains the fallback. Backend HD-06 offline contract is frozen, but bot GET/ACK are not wired. One verified customer test phone is enough; the proposed second operator phone is unnecessary for the POS architecture.
