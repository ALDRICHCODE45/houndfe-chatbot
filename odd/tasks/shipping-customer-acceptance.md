# Shipping Customer Acceptance — Controlled Sandbox Pilot

## Goal

Complete the missing post-human-approval customer journey for the **one measured demo product**: disclose the server-derived freight and total, require a subsequent explicit customer acceptance, and enforce that acceptance before a shipping sale. This is local, default-off implementation; it is not permission to take real orders.

## Authorization and boundaries

- User selected the measured-product controlled sandbox pilot, **not** full-catalog activation.
- Keep `SHIPPING_QUOTES_ENABLED=false` by default. No live provider, backend, database, customer message, credential inspection, push, merge, migration, production config, or deployment in these local units.
- Sibling backend `feat/bot-sale-shipping-charge` (`b3c9914`) is **not** an ancestor of local backend `main` (`d46a435`). A reported MXN 2,000 owner cap means `200000` cents, but its actual environment value is unverified. The backend team owns merge and environment changes.
- Preserve unrelated untracked `.codegraph/**`, `odd/tasks/receipt-media-stored-worker.md`, and `openspec/changes/receipt-media-ingestion/**`.
- Strict offline RED→GREEN for new executable behavior; bounded single-writer units of at most 390 complete diff lines each. Independent verification, native review and acknowledgement, then local Conventional Commit per unit. Keep test/docs with behavior and record hashes below.
- Model text is **not** an acceptance authority. Only a deterministic router observing a later raw inbound customer message can record acceptance. A send failure or uncertain delivery must not authorize acceptance or sale; repeated events fail closed. No cross-store CAS claim.

## Tasks

- [x] **SCA-0 — Freeze pilot scope and tasks:** record verified backend/cap uncertainty, deterministic acceptance requirement and offline-first delivery order in this tracker. Evidence: local `599e2f6`, native `review-9b04735790b55fd2` approved/acknowledged; Prettier and diff checks clean.
- [ ] **SCA-1 — Pure offer and acceptance contracts:** exact-key, bounded, server-owned disclosure/acceptance marker shapes pinned to approval request, draft creation and disclosed merchandise/freight/total; canonical cents/expiry; deterministic Spanish price/yes-no grammar. Invalid, expired, malformed or hostile state fails closed. Units: **SCA-1a1 core contract delivered**; **SCA-1a2 adversarial/boundary tests delivered**; SCA-1b (Spanish price/yes-no grammar, parser/render) pending.
- [ ] **SCA-2 — Server-side sale gate:** without a matching durable acceptance marker, any shipping quote/approval/pending marker blocks before idempotency key, store or HTTP. Match the current approved draft, cart, address context and the _same disclosed totals_; retain address-only default-off behavior. Handle existing charged test fixtures in bounded steps; characterize no accept, wrong price and stale pin before GREEN.
- [ ] **SCA-3 — Durable disclosure lifecycle:** after an actual structured `SHIPPING_APPROVED` resolution, compute the presentable amount from the server-pinned fresh state; send a deterministic price/total message to the customer outside the LLM; only successful outbound send can enable the exact pending customer-response marker. Failure and replay remain safe; other ops handoffs unchanged.
- [ ] **SCA-4 — Deterministic inbound acceptance router:** before the LLM, require a later raw text from the same customer with a strict affirmative or rejection while the matching disclosure is active. Persist only a matching accepted marker; clear or fence the pending state idempotently, never infer approval from model prose; reject or drift requires a fresh disclosed quote. Cover dedup, malformed inputs, pending human request and store failure.
- [ ] **SCA-5 — Promotion, prompt and default-off reconciliation:** a backend `PROMO_RE_QUOTE` or any changed merchandise/freight/total invalidates acceptance and requires renewed disclosure/explicit consent; update enabled-only guidance without changing disabled prompt/tool inventory. Reconcile runbook rollback, including preexisting markers and disabling sale continuation.
- [ ] **SCA-6 — Offline integration evidence:** focused opt-in and default-off tests, full offline suite, uncached spec/build typechecks, scoped lint/format/diff, independent verification and native review by work unit. Record counts and skips. Never describe offline mocks as backend/DB/provider acceptance.

## External gates (not completed by these tasks)

1. Backend owner integrates, migrates and validates the isolated shipping-charge branch in the intended sandbox; no backend edits from this repo.
2. Owner verifies the actual environment cap equals `BOT_SHIPPING_CHARGE_MAX_CENTS=200000`, authoritative origin, measured item data, sandbox credentials/allowed host and CDMX policy without exposing secrets here.
3. Human approval, price disclosure, explicit acceptance, backend charge persistence and rollback pass a **separately authorized** synthetic sandbox journey without real customers; only then consider deployment or enabling a production flag.

## Evidence ledger

- SCA-0: `599e2f6` (35 changed lines), `review-9b04735790b55fd2` approved/acknowledged.
- SCA-1a1: pure `shippingCustomerOffer`/`shippingCustomerAcceptance` markers (fresh frozen exact-key fail-closed normalization, match helper; acceptance `inboundMessageId`) in `src/shipping/application/shipping-customer-acceptance.ts`; strict RED missing module → GREEN 28/28 core tests; uncached spec/build typecheck, scoped lint/format/diff clean. Independent PASS (deferred matrix explicitly noted), native `review-9570e8b9c1e279a7` approved/acknowledged, local `d6d914f` (386 complete changed lines). No store, router, sale gate or live behavior.
- SCA-1a2: test-only `src/shipping/application/shipping-customer-acceptance-adversarial.spec.ts` (75/75; combined core+adversarial 103/103) covering hostile/accessor/symbol/inherited/proxy inputs, requestId/ISO/amount/int32/ID-length boundaries, time windows and match drift/malformed cases. Characterization GREEN only (no RED needed for committed behavior); independent WARN solely because it did not run build typecheck (parent ran uncached build tsc successfully). Spec tsc, lint/format/diff clean; native `review-d3bc495148254e24` approved/acknowledged, local `03d04f1` (380 complete changed lines). No production/behavior change.
- SCA-1b: pending (Spanish price/yes-no grammar, parser/render).
