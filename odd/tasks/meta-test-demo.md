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

- [ ] **M1 — Signed local echo, restricted route surface (offline).** Route: bounded delegated writer. Build minimal test-only module with real webhook controller/guard/dispatcher and in-memory or disposable-DB seams, fake agent/sender; assert signed POST echo, invalid signature 401, verification challenge, and 404 on `/`, media, metrics. Never use production AppModule. RED→GREEN and local commit.
- [ ] **M2 — Real Meta sender bootstrap (still offline verification).** Route: bounded delegated writer. Test-only entry loads ignored `.env.local` explicitly, uses actual sender but no real call in tests, starts only restricted module with Testcontainers DB; hard fail on absent/unsafe sandbox config. No secrets printed, no `dist/`. RED→GREEN and local commit.
- [ ] **M3 — RESTOCK POS handoff integration (offline, separate feature tracker).** Human sees a bounded structured context in the POS; bot intake, current GET, application ledger, customer send and ACK need independent tested cuts. Never replace this with LEGACY_OPS or fabricate a joined demo. Scope and safety gates live in `odd/tasks/human-decisions-restock.md`.
- [ ] **M4 — Explicitly authorized sandbox rehearsal.** Only after exact test customer target, fresh outbound authorization and callback-change approval; configure ngrok/test app temporarily, rehearse signed callback and real Meta sends, stop/revert configuration after demo. Human POS path is shown live only if M3 and FE/backend integration are actually verified; otherwise label the parts separately.

## Status

Mapping done; M1 in progress, M2–M4 pending. No test-number message sent and no public webhook started. The prior offline demo passed 9 suites/88 tests and remains the fallback. Backend HD-06 offline contract is frozen, but bot GET/ACK are not wired. One verified customer test phone is enough; the proposed second operator phone is unnecessary for the POS architecture.
