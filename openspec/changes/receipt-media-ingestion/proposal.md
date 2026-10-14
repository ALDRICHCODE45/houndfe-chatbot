# Proposal: receipt-media-ingestion

> Proposal phase only. Companion to `openspec/changes/receipt-media-ingestion/explore.md`, which holds the full current-state evidence. Specs, design, and tasks are produced in later phases.

## Intent

Make WhatsApp receipt submission an end-to-end, deterministic application workflow: a customer's JPEG/PNG receipt image is authenticated, downloaded from Meta, validated, stored privately, correlated to the sale just placed, and attached to the backend as PENDING review evidence — with the LLM never choosing the sale id, media URL, object key, or retrieval capability.

## Quick path

1. Customer sends a bank-transfer receipt photo (R11 flow) after the bot shows payment details.
2. The chatbot ingests the image (≤10 MB JPEG/PNG), stores it privately, and asks for/collects the declared amount.
3. After explicit customer confirmation, the chatbot calls `POST /chatbot-api/sales/:saleId/receipts` (§4.4.7) and the reviewer opens the stored stable URL from the backend's PENDING queue.

## Business problem

Payment confirmation is broken for the highest-stakes step of the WhatsApp sale flow. Customers pay by bank transfer and are told (step 13 of the sale flow instructions) to send a receipt image, but:

- **Images never reach the application.** Webhook normalization accepts only `type === 'text'`, so image/document events are silently dropped before dispatch. Customers believe their payment proof was received; nobody ever sees it.
- **The only attach path is unsafe.** The `attachReceipt` tool exposes `saleId` and `mediaUrl` to the model. Even if an image existed, the model cannot produce a fetchable URL (Meta media URLs are temporary and bearer-gated), and a model-chosen sale id could attach evidence to the wrong sale.
- **Operational cost today is manual reconciliation.** Staff must chase customers over WhatsApp for payment proof that was already sent, delaying paid-state transitions (R15) and creating support friction during peak ordering.

## Target users and situations

| Who                          | Situation                                                                                                                                                                                            | Need                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customers paying by transfer | Just placed a sale; bot asked for receipt (R11). Sends a photo, sometimes before/after typing the amount; occasionally sends another photo while the first is still awaiting amount or confirmation. | Image is received, amount is parsed ($1,234.50 / 1234 / cents phrasing), and they get explicit confirmation before anything is attached. An overlapping second photo is never silently consumed: the bot prompts them to finish or cancel the active receipt first. |
| Store owner / reviewers      | Work the backend tenant-scoped PENDING receipt queue to confirm payments.                                                                                                                            | A stable URL that opens in a plain browser for the whole review window, from a private store.                                                                                                                                                                       |
| Support / ops staff          | Handle "I already sent my receipt" complaints.                                                                                                                                                       | Durable per-message idempotency so webhook re-delivery never silently duplicates or loses evidence; overlapping second photos get a deterministic finish-or-cancel reply, and sequential receipts are separately trackable — no silent merges, drops, or stacking.  |

## Current-state gap (evidence summary)

| Area                      | Today                                                                                                                                                                                                                                         | Gap                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook DTO/normalization | `WebhookMessageDto` has no `image`/`document`; `normalizeInboundMessages()` drops non-text.                                                                                                                                                   | No media ingress at all. Signature verification (`SignatureGuard` over raw body) works and is preserved unchanged.                                       |
| Meta channel              | `MetaWhatsappSender` implements only `sendText`.                                                                                                                                                                                              | No media metadata/download client; no SSRF-safe streaming policy.                                                                                        |
| Sale correlation          | `data.placedSaleId` is durable after `createSale`.                                                                                                                                                                                            | `attachReceipt` tool still lets the model pass `saleId`/`mediaUrl`; step 13 is unworkable as written.                                                    |
| Persistence               | `processed_webhook_messages` dedups message ids; conversation state is an open JSONB bag with a known lost-update window.                                                                                                                     | No durable receipt-media lifecycle (status, attempts, capability hash, backend receipt id); JSONB alone cannot safely host it.                           |
| Backend contract          | `POST /chatbot-api/sales/:saleId/receipts` (§4.4.7, `sales:write`) requires an absolute `mediaUrl` and `declaredAmountCents`; backend stores the URL permanently and exposes it directly in the review queue. No idempotency key on the POST. | Whatever URL the chatbot supplies must be browser-fetchable, stable, and credential-free — incompatible with presigned expiring URLs or raw object keys. |

## Locked product decisions (human-approved)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | v1 accepts **JPEG and PNG only**, max **10 MB**. PDF is a non-goal.                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **No automatic media deletion.** Attached evidence and abandoned uploads are preserved until explicit future/manual governance; storage monitoring implications are documented (see Implications).                                                                                                                                                                                                                                                                |
| 3   | **Multiple receipt submissions per sale are allowed sequentially, one at a time.** While one receipt flow is awaiting amount or confirmation, a second image **must not** be ingested, replace, or queue behind the active one; the bot asks the customer to finish or cancel the active receipt first. A new deliberate image starts a new, separately tracked receipt only after the prior active flow reaches an appropriate terminal state (human-corrected). |
| 4   | Media lives in a **private S3-compatible object store behind a provider-neutral port**. No public bucket.                                                                                                                                                                                                                                                                                                                                                         |
| 5   | Review access uses a **stable chatbot-served opaque capability URL**: bearer-by-possession, high-entropy token, stored only as a hash, redacted from logs.                                                                                                                                                                                                                                                                                                        |
| 6   | Amount comes from the image caption **or** a following message; Mexican peso forms are normalized; **explicit customer confirmation is required** before backend attachment.                                                                                                                                                                                                                                                                                      |
| 7   | Transient Meta download / object-upload failures retry up to **3 attempts**. The backend receipt POST is **never blindly retried when the outcome is ambiguous**; the record enters a durable `ATTACH_OUTCOME_UNKNOWN` state and escalates to manual reconciliation.                                                                                                                                                                                              |
| 8   | The chatbot delivers the **configuration and provisioning runbook**; the owner provisions the real bucket, domain, and credentials and supplies secrets.                                                                                                                                                                                                                                                                                                          |
| 9   | The **backend remains strictly read-only and unchanged**. The known receipt sale/tenant-isolation concern is escalation only (see Risks).                                                                                                                                                                                                                                                                                                                         |
| 10  | Non-goals per the table below.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Measurable outcomes

1. **Ingestion rate:** ≥95% of valid JPEG/PNG receipt images (≤10 MB) sent by customers with an active `placedSaleId` are stored and reach a backend PENDING receipt, without a single model-supplied sale id or media URL (verified by tests asserting the model cannot influence either).
2. **Stable review access:** 100% of attached receipts remain browser-fetchable at the same capability URL for the full review window (no expiry — a direct consequence of decision 2).
3. **Idempotency and concurrency:** zero duplicate backend receipt rows from webhook re-delivery of the same `message.id`; 100% of images arriving while a receipt flow for the same sender is in `AWAITING_AMOUNT`/`AWAITING_CONFIRMATION` are rejected with the deterministic finish-or-cancel message (never ingested, replaced, or queued); a deliberate second image after the prior flow reaches a terminal state produces a new, separately trackable record.
4. **Failure discipline:** transient download/upload failures auto-retry at most 3 times; every ambiguous attach outcome ends in `ATTACH_OUTCOME_UNKNOWN` with an escalation message — never a blind retry.
5. **Log hygiene:** zero occurrences of capability tokens, Meta bearer tokens, temporary Meta URLs, or object keys in application logs at normal levels.
6. **Acknowledgement safety:** webhook acknowledgement latency is bounded so Meta does not time out and re-deliver (mechanism selected in design, see below).

## In scope

- **WhatsApp media ingress:** discriminated text/media inbound union in the provider DTO and normalization; routing precedence that explicitly preserves echo filtering, ops pre-routing, and `pendingHumanRequest` short-circuit behavior.
- **Meta media port:** media-id metadata resolution plus authenticated, SSRF-guarded, streaming download with HTTPS/redirect revalidation, timeouts, and declared-vs-actual Content-Type + magic-byte (JPEG/PNG) agreement and byte-size enforcement.
- **Receipt-media application service:** durable reservation keyed by webhook message id and provider media id; capture of the current `placedSaleId` at acceptance (a later sale must not retarget an already-uploaded receipt); **one-active-flow invariant:** a sender with a flow in `AWAITING_AMOUNT` or `AWAITING_CONFIRMATION` gets a deterministic "finish or cancel your current receipt first" message and the incoming image is not ingested, replaced, or queued — a new receipt is created only when no flow is active or the prior one reached a terminal state; deterministic state machine (RESERVED → DOWNLOADED → STORED → AWAITING_AMOUNT → AWAITING_CONFIRMATION → ATTACHING → ATTACHED / terminal failure / `ATTACH_OUTCOME_UNKNOWN`); deterministic customer messages in Spanish.
- **Private object-store port:** S3-compatible operations behind an injection token; fail-fast typed configuration; random non-PII object keys (`receipts/<random-id>`); partial-upload abort on failure/overflow.
- **Stable retrieval controller:** opaque high-entropy capability token in the path, hash-based lookup, private-store streaming, strict response headers (`nosniff`, restrictive CSP, correct `Content-Type`, `Content-Disposition`), GET/HEAD support, log redaction.
- **Amount collection:** typed pending-receipt marker routes the next relevant customer text through deterministic parsing/confirmation before the generic LLM; peso form normalization; confirmation gate before attach.
- **Sale-flow boundary repair:** `attachReceipt` tool schema loses model-supplied `saleId`/`mediaUrl`; step 13 instructions rewritten to match the deterministic flow.
- **Durable receipt-media store:** new Postgres table (unique `webhook_message_id`, `provider_media_id`), raw `node-pg-migrate` migration consistent with existing patterns.
- **Config/runbook:** `app-config` additions (Meta media, storage, limits, retention, proxy base URL), provisioning runbook for the owner, monitoring guidance for unbounded storage growth (decision 2).
- **Tests:** DTO/guard/dispatcher ordering, Meta client, validation, storage adapter, persistence transitions, access controller headers/redaction, retry/unknown-outcome semantics, sale correlation, amount parsing.

## Non-goals

PDF support; OCR or any image understanding; automatic receipt validation or payment confirmation; attaching to arbitrary/historical sales; public buckets or public object URLs; any backend or review-frontend change; product-photo recognition (R1 stays a separate slice); forwarding receipt media to ops through the human-handoff channel.

## Affected WhatsApp flows (R1–R16)

Per `docs/conversation-analysis.md`:

| Flow                                          | Impact                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R11** (bank details + receipt request)      | Core change: the receipt image leg of R11 becomes functional end-to-end, including amount collection and confirmation, with the one-active-flow gate for overlapping photos.                                                                        |
| **R8/R10** (order data, confirmation summary) | Unchanged behavior, but the post-sale receipt handoff now has a deterministic continuation.                                                                                                                                                         |
| **R15** (sale lifecycle / paid state)         | Receipts actually reach PENDING review, enabling paid-state transitions downstream (backend-owned).                                                                                                                                                 |
| **R1** (product-photo recognition)            | Deliberately not implemented here; dispatcher image routing must define what happens to a non-receipt-context image (a polite "send it after placing your sale" / receipt-only v1 message), never silent drop. Exact precedence is a spec question. |
| **R6/R7** (human handoff)                     | Precedence preserved: ops text and `pendingHumanRequest` short-circuit outrank receipt-media routing; receipt media itself is never forwarded to ops.                                                                                               |
| R2–R5, R9, R12–R14, R16                       | No direct behavioral change beyond shared dispatcher ordering.                                                                                                                                                                                      |

## Model authority boundary (invariant)

The model may phrase guidance, ask for the amount, and confirm with the customer. It **must never** choose or see: the sale id (only the captured `placedSaleId` is used), the Meta media URL, the object key, the capability token, or the final stable URL. All of these are server-owned. The amount is the only customer/model-influenced value, and it is parsed deterministically and confirmed explicitly before attachment.

## Backend contract reference (unchanged, read-only)

- Endpoint: `POST /chatbot-api/sales/:saleId/receipts` — chatbot-api **§4.4.7**, scope `sales:write` (canonical: `openspec/specs/sale-flow-tools/spec.md`; client: `src/chatbot-api/infrastructure/chatbot-api-http.client.ts::attachReceipt`).
- Request: absolute `mediaUrl` (`@IsUrl()`), positive integer `declaredAmountCents`, optional ISO date/reference. Response: `{ receiptId, status: 'PENDING' }`. The backend stores the URL permanently and exposes it directly in the tenant review queue (`openspec/specs/receipt-review/spec.md`); there is no authenticated backend media proxy and no review-completion callback to the chatbot.
- **Known limitation acknowledged:** the POST carries no idempotency key. A timeout after backend commit leaves the outcome ambiguous; per decision 7 the chatbot records `ATTACH_OUTCOME_UNKNOWN` and escalates for manual reconciliation rather than risking duplicate PENDING evidence rows. Requesting backend idempotency is recorded as a future cross-repo dependency, not done here.

## Storage, retention, and no-auto-deletion implications

- Nothing is deleted automatically. Attached evidence must outlive review (no completion signal exists), and abandoned uploads are retained too (decision 2). Consequences: (a) bucket growth is unbounded and must be monitored — the runbook defines storage metrics/alerts; (b) cleanup exists only for technical orphans (aborted partial multipart uploads, failed-validation buffers), never for customer content; (c) any future retention policy is explicit governance work outside this change.
- Abandoned pre-attachment records remain queryable in the receipt-media table so the eventual governance pass can act on them.

## Architecture/delivery decision (deferred to design)

**Synchronous bounded ingestion inside the webhook request vs. durable reservation + recoverable worker** is a design-phase decision, not settled here. Evidence: the controller awaits the full dispatcher and slow media transfer can exceed Meta's webhook timeout and trigger re-deliveries; a durable-reservation design needs a real recoverable mechanism (DB-backed job/state machine with immediate wake-up and restart recovery), not detached promises. Either path must resume from the durable status idempotently. If evidence gathered during design shows a synchronous bound can always fit within Meta's timeout for ≤10 MB objects, synchronous may be chosen; otherwise the worker design is required.

## Implications

- **Support/ops:** deterministic customer messages ("recibimos tu comprobante", "confirma el monto", escalation text on unknown outcome) reduce "did you get my receipt?" tickets; manual reconciliation is still needed for the rare ambiguous-attach window.
- **Owner/infra:** new provisioning duties (bucket, credentials, media base URL/domain, TLS, lifecycle rules for partial uploads only) delivered as a runbook; boot fails fast on missing/malformed media config.
- **Storage cost:** unbounded growth until governance is introduced (decision 2); monitoring is part of the runbook.
- **Security posture:** receipts move from "never received" to "stored privately, bearer-by-possession URL access." Capability URLs can leak via browser history or intermediaries; redaction and strict headers are mandatory but reviewer identity authentication is explicitly out of reach without backend work.

## Dependencies and provisioning

- Owner-provided: bucket/endpoint/region/credentials, public chatbot media base URL, TLS/reverse-proxy config with capability-path log redaction.
- Chatbot-provided: typed config schema, fail-fast validation, runbook document.
- Future cross-repo (escalation only): backend idempotency key for the receipts POST; backend receipt sale/tenant isolation fix (see Risks).

## Risks

| Risk                                                                                          | Mitigation / stance                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability URL leakage (logs, history, referrers)                                             | Hash-only persistence, path redaction in app and proxy logs, `nosniff` + restrictive CSP + `Content-Disposition`; residual bearer-by-possession risk accepted by decision 5. |
| Webhook timeout from in-request media transfer                                                | Explicit design-phase decision (above); no detached promises either way.                                                                                                     |
| Ambiguous backend attach → duplicate evidence                                                 | `ATTACH_OUTCOME_UNKNOWN` terminal state + escalation; no blind retries; backend idempotency requested as future dependency.                                                  |
| Unbounded storage growth                                                                      | Documented monitoring implication; technical-orphan cleanup only; governance deferred by decision.                                                                           |
| Conversation JSONB lost-update window                                                         | All lifecycle/idempotency state lives in the new constrained table; JSONB holds only a small typed pointer, written with fresh-sibling spread.                               |
| Backend may not verify sale belongs to current tenant (receipt evidence foreign-sale linkage) | Escalated to the backend team (decision 9); chatbot's fixed branch header and captured `placedSaleId` reduce exposure but do not fix it.                                     |
| Image misclassification (receipt vs. product photo vs. ops text)                              | Explicit routing precedence specified in spec phase; never silently dropped.                                                                                                 |

## Rollout and rollback

- **Rollout:** fail-fast config on boot → staging verification against a real S3-compatible bucket and signed Meta webhook → runbook handoff to owner for production secrets → enable per environment. Migration is additive (new table); no existing table is altered.
- **Rollback:** a config kill-switch disables media ingestion; images then receive the deterministic "receipt ingestion unavailable, please send later" message and the rest of the flow (text, sale creation, cancellation) is untouched. Rollback drops nothing: the migration can remain, and already-attached evidence stays reachable. No backend change ever needs coordinated rollback.

## Success criteria checklist

- [ ] Signed JPEG/PNG ≤10 MB message → private object → backend PENDING receipt on the captured `placedSaleId`, confirmed by tests.
- [ ] Model tooling and prompts contain no path to sale id, media URL, object key, or capability.
- [ ] Re-delivered webhook message id resumes state; zero duplicate backend receipts from re-delivery in tests.
- [ ] Ambiguous attach ends in `ATTACH_OUTCOME_UNKNOWN` + escalation message, never auto-retry.
- [ ] Capability URL opens in a plain browser; logs contain no capability tokens/keys at normal levels.
- [ ] One active ingestion/amount flow per sender: an overlapping second image gets the finish-or-cancel reply and is never ingested/replaced/queued; a new image after a terminal state starts a separate sequential receipt (verified by tests).
- [ ] Config missing/malformed → boot fails fast; kill-switch disables ingestion gracefully.
- [ ] Runbook covers provisioning, monitoring of unbounded storage, and manual reconciliation of unknown outcomes.

## Proposal question round

The ten exploration questions were answered by the human-approved decisions above; no blocking product question remains. Working assumptions derived from those decisions — flag anything wrong, or request a second round:

1. **Overlapping and sequential second images (human-corrected):** while a receipt flow awaits amount or confirmation, a second image is **not** ingested, replaced, or queued — the bot replies "ya tenemos tu comprobante en proceso; termínalo o cancela antes de enviar otro". Only after the prior flow reaches a terminal state does a deliberate new image start a new, separately tracked receipt (decision 3).
2. **Amount source precedence:** caption amount is offered first ("¿Confirmas $X?"); if absent or unparseable, the bot asks. Confirmation is always required (decision 6).
3. **Kill-switch UX:** with ingestion disabled, the bot says receipts cannot be received right now and to try again later — not a silent drop.
4. **`ATTACH_OUTCOME_UNKNOWN` customer message:** informs the customer their receipt was received but payment confirmation is delayed, and that staff will follow up — no false success.
5. **Non-receipt images (R1 boundary):** outside an active amount flow, a v1 image gets a short "solo puedo recibir comprobantes de pago" reply rather than product-photo recognition (non-goal 10).

If these read correctly, the next phase is **specification** (deltas for `whatsapp-webhook`, `conversation-store`, `sale-flow-tools`, `chatbot-api-client`, `app-config`, `llm-agent`, plus new `receipt-media` and `receipt-media-access`/`object-storage` capabilities).
