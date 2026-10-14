# Exploration: receipt-media-ingestion

> Exploration only. This document records current evidence, alternatives, and proposal boundaries; it is not a proposal, specification, design, or task plan.

## 1. Executive finding

The receipt path is not end-to-end today. Signed webhook delivery is correctly authenticated over the raw body, but normalization accepts only `type === 'text'`, so image/document events disappear before dispatch. The Meta adapter only sends text and has no media metadata/download client. The existing `attachReceipt` tool accepts both `saleId` and `mediaUrl` from the model, despite a durable, server-owned `placedSaleId` already being available after `createSale`.

A safe slice should make receipt media a deterministic application workflow rather than an LLM-selected URL/id workflow: authenticate the webhook, reserve/deduplicate the inbound, resolve and download the temporary Meta object immediately, validate it while streaming, store it privately through an object-storage port, persist media/correlation state, collect the declared amount when needed, and attach only to the `placedSaleId` captured for that sender. The model may phrase guidance, but it must not choose the sale id, object key, retrieval capability, or source URL.

## 2. Current webhook and Meta channel

### Signed/raw-body path

- `src/main.ts::bootstrap()` creates Nest with `{ rawBody: true }`; this is the required source for signature verification.
- `src/whatsapp/presentation/signature.guard.ts::SignatureGuard` reads `X-Hub-Signature-256`, computes HMAC-SHA256 over `request.rawBody` using `meta.appSecret`, length-checks the digests, and uses `crypto.timingSafeEqual`. Missing raw body, malformed header, and mismatches return 401.
- `src/whatsapp/presentation/webhook.controller.ts::handleEvent()` runs `SignatureGuard`, awaits the complete dispatcher, and only then returns `{ received: true }`. Any synchronous media download/upload added below the dispatcher therefore extends webhook acknowledgement latency and can trigger Meta retries if processing is slow.
- Global validation in `src/main.ts` uses `whitelist: true` and `transform: true`, but not `forbidNonWhitelisted`; the DTO surface must explicitly include any media fields that need to survive transformation.

### DTO and normalization gap

- `src/whatsapp/presentation/dto/webhook-event.dto.ts::WebhookMessageDto` has `id`, `from`, `timestamp`, `type`, and `text`; it has no `image` or `document` object (`id`, declared MIME type, hash, filename/caption as applicable).
- `src/whatsapp/application/webhook-dispatcher.service.ts::normalizeInboundMessages()` explicitly returns an empty array unless `message.type === 'text'` and `message.text.body` exists. `src/whatsapp/domain/inbound-message.ts::InboundMessage` is correspondingly text-only.
- `WebhookValueDto.metadata.phone_number_id` is already retained as `receivingPhoneNumberId`; this is useful for observability but does not solve media handling.
- Status callbacks are tolerated by the DTO but are not dispatched.

### Dispatch, echo, and dedup behavior

- `WebhookDispatcherService.dispatch()` orders handling as recent-outbound echo filter, durable webhook dedup check, ops pre-routing, pending-human marker short-circuit, LLM runner, outbound send, then `markSeen`.
- `src/whatsapp/infrastructure/postgres-webhook-dedup.store.ts` stores one permanent row per `message.id` in `processed_webhook_messages`; `markSeen` is `INSERT ... ON CONFLICT DO NOTHING`.
- A message is marked seen only after a successful outbound send. This supports text reply retries, but is insufficient as the sole media idempotency mechanism: a retry after upload but before reply could upload or attach again. Media needs its own durable reservation/status keyed by webhook message id and provider media id.
- The dispatcher processes messages serially and rethrows a processing failure, causing the webhook request to fail. A media workflow must define whether a stored-but-unreplied receipt is considered successfully ingested and how retries resume from its durable status.

### Meta client gap

- `src/whatsapp/infrastructure/meta-whatsapp.sender.ts::MetaWhatsappSender` implements only `sendText()` to `/{phoneNumberId}/messages` with bearer auth and `recipient_type: individual`.
- Existing config already provides `meta.accessToken` and `meta.graphApiBaseUrl` (`src/config/configuration.ts`), but no port/client exists for `GET /{media-id}` metadata resolution or authenticated download from Meta's returned temporary URL.
- The media client should be separate from the outbound sender port. It must use the configured Graph origin for metadata, send bearer auth on metadata and binary download requests, enforce HTTPS and an explicit Meta download-host/redirect policy, set timeouts, stream bytes, and never accept a URL supplied by the model or customer. Redirect targets must be revalidated to avoid SSRF through an otherwise trusted first URL.

## 3. Conversation state and sale correlation

- `src/conversation/domain/conversation-store.ts::ConversationStateData` is an open JSONB bag with typed `messages`, `placedSaleId`, and `pendingHumanRequest` fields.
- `src/conversation/infrastructure/postgres-conversation.store.ts::update()` performs an application read-modify-write and replaces the whole JSONB `data` value. Every writer must spread fresh sibling fields; concurrent updates still have the documented lost-update window.
- `src/sale-flow/application/tools/create-sale.tool.ts` calls `persistConfirmedSale()` after backend success. `src/sale-flow/application/placed-sale-persistence.ts::persistConfirmedSale()` clears the cart and sets `data.placedSaleId = sale.saleId` in one store update.
- A new successful sale overwrites the prior `placedSaleId`. `cancelSale` reads this field server-side and clears it on success/permanent failure. Receipt attachment must similarly reject model-supplied ids and read/capture the durable id.
- Correlation should be snapshotted when media is accepted: persist `saleId = current placedSaleId` in the pending-media record. This prevents a later sale from silently retargeting an already uploaded receipt. If no `placedSaleId` exists, the media must not be attachable to an arbitrary or historical sale.
- A small conversation marker can identify the active amount-collection step, but queryable lifecycle/idempotency fields do not belong only in `conversation_state.data`; they require a separate table.

Current migrations are raw `node-pg-migrate`: `1700000000000_create-conversation-state.js`, `1800000000000_create-processed-webhook-messages.js`, and `1900000000000_human_handoff_requests.js`. The project already has port + Postgres-adapter patterns suitable for a pending receipt-media store.

## 4. Sale tool, LLM, and handoff boundaries

- `src/sale-flow/application/tools/attach-receipt.tool.ts::makeAttachReceiptTool()` currently exposes `saleId: z.uuid()` and `mediaUrl: z.url()` to the model and forwards them directly to `ChatbotApiClient.attachReceipt()`. It has no `contextSchema`, does not read conversation state, and has no idempotency guard.
- `src/sale-flow/domain/sale-flow-instructions.ts` step 13 tells the model to call `attachReceipt(saleId, mediaUrl, declaredAmountCents, ...)` after an image arrives. Because images never enter the LLM path and no stable URL exists, this instruction cannot work safely.
- `src/llm-agent/application/agent-runner.service.ts` re-fetches fresh state after tools run, preserving tool-written siblings, but this does not make model-selected identifiers trustworthy.
- Recommended boundary: media ingestion and the final backend call are application services. If an LLM tool remains, its schema should accept at most user-declared metadata and derive `senderId`, pending media id, stable URL, and sale id from runtime context/state. Prefer a dispatcher-owned deterministic amount state so attachment does not depend on the model calling the right tool.
- Human handoff is orthogonal. `src/human-handoff/` handles text escalation and the dispatcher reserves ops messages before customer handling. Receipt media should not be forwarded to ops through this channel; backend receipt review remains the human review mechanism. Routing precedence must explicitly preserve ops text handling and pending-human behavior.

## 5. Backend contract and stable media-access constraint (read-only evidence)

### Attachment contract

- Backend `src/chatbot-api/presentation/dto/attach-receipt.request.ts::AttachReceiptRequestDto` requires an absolute `@IsUrl()` `mediaUrl`, positive integer `declaredAmountCents`, and optional ISO date/reference.
- Backend `src/chatbot-api/application/chatbot-api.service.ts::attachReceipt()` writes `ReceiptEvidence { saleId, tenantId, mediaUrl, declaredAmountCents, ..., status: PENDING }` and returns `{ receiptId, status: 'PENDING' }`. It does not mark the sale paid.
- Chatbot `src/chatbot-api/infrastructure/chatbot-api-http.client.ts::attachReceipt()` performs a non-retried POST to `/chatbot-api/sales/${saleId}/receipts`.

### Human review consumption

- Backend `openspec/specs/receipt-review/spec.md` requires the tenant-scoped pending queue to expose the stored `mediaUrl` directly.
- `src/sales/review/receipt-review.service.ts::mapQueueItem()` copies `receipt.mediaUrl` unchanged to the queue DTO.
- `src/sales/review/receipt-review.controller.ts` protects queue/review endpoints with JWT, tenant context, and ReceiptEvidence permissions, but there is no authenticated backend media proxy.
- Archived backend design `openspec/changes/archive/2026-06-13-receipt-payment-confirmation/design.md` resolved media viewing as a direct DigitalOcean Spaces URL with no signed proxy. No receipt-review media renderer was found in the checked `frontend-houndfe` source, so exact CSP, `<img>`/PDF behavior, and cross-origin policy remain unverified.

Consequently, the URL placed in the backend must be browser-fetchable by itself and stable for the review window. The backend will not add chatbot credentials or exchange an object key for a fresh signed URL. A chatbot-hosted capability URL is compatible only if a plain browser GET can use it without custom headers/cookies and if the route returns safe media headers. This is bearer-by-possession access, not reviewer identity authentication.

### Tenant-isolation escalation (backend-owned; do not fix in this change)

Backend `ChatbotApiService.attachReceipt()` creates by supplied `saleId` plus current `tenantId` without first querying a sale constrained by both id and tenant. Prisma `ReceiptEvidence` has independent foreign keys to `Sale` and `Tenant` (`prisma/schema.prisma::ReceiptEvidence`) rather than a composite tenant/sale relation. A credential that learns another branch's sale UUID may therefore be able to create a current-tenant receipt linked to that foreign sale. The chatbot's fixed branch header and durable `placedSaleId` materially reduce exposure but do not prove backend isolation. Escalate this to the backend team; it is strictly out of scope for this chatbot-only change.

## 6. Recommended architecture direction

### Capability boundaries

1. **WhatsApp media ingress**: extend provider DTO/normalization with a discriminated inbound union for text and supported receipt media. Preserve signature verification unchanged.
2. **Meta media port**: resolve metadata by media id and stream authenticated bytes from the temporary URL. Provider URLs never cross into prompts or persistence as the final receipt URL.
3. **Receipt-media application service**: reserve idempotently, capture `placedSaleId`, enforce state transitions, validate, upload, prompt for/accept amount, invoke the existing chatbot API, and produce deterministic customer messages/errors.
4. **Private object-store port**: S3-compatible operations behind an injection token. Configuration should cover endpoint, region, bucket, access credentials, path-style/TLS compatibility, public base URL for the chatbot proxy, and optional provider-specific settings without exposing secrets.
5. **Durable receipt-media store**: separate Postgres table with unique `webhook_message_id` and `provider_media_id`; suggested fields include internal id, sender id, captured sale id, object key, detected MIME, byte count/hash, declared amount, capability-token hash, lifecycle status, backend receipt id, error category/attempt timestamps, created/updated/attached/abandoned timestamps. Do not store raw capability tokens or PII in keys.
6. **Stable retrieval controller**: opaque high-entropy capability in the path, lookup by hash, private S3 streaming, GET/HEAD support as needed, strict response headers (`Content-Type` from detected type, `nosniff`, restrictive CSP, `Content-Disposition`), and no object-store credential exposure. Reverse-proxy/application access logs must redact the capability path.
7. **Amount collection**: a typed pending-receipt marker routes the next relevant customer text through deterministic parsing/confirmation before the generic LLM. The final attach uses persisted media + captured sale correlation only.
8. **Lifecycle/cleanup**: clean incomplete uploads and abandoned pre-attachment records separately from attached evidence. Attached deletion cannot safely depend on backend review status because the chatbot has no review-status callback/read endpoint.

### Validation and storage rules

- Allowlisted declared Meta type, downloaded `Content-Type`, and detected magic bytes must agree under an explicit policy.
- Enforce maximum bytes while streaming; reject missing/oversized declared size and abort partial/multipart uploads on overflow or validation failure.
- Use random non-PII object keys such as `receipts/<random-id>`; never include phone, sale id, filename, reference, or amount.
- For JPEG/PNG, verify signatures and reject malformed/unsupported content. If PDF is accepted, verify `%PDF-` and serve it as attachment unless the product explicitly requires inline preview; magic bytes alone do not make active PDF content safe.
- Compute a digest while streaming for diagnostics/content dedup, but provider/webhook ids should remain the primary idempotency keys; content-hash dedup can incorrectly merge two legitimate submissions of the same file.
- Do not log Meta bearer tokens, temporary URLs, S3 credentials, capability tokens, full sender ids, filenames, or object keys at normal levels.

### Webhook acknowledgement tradeoff

- **Synchronous bounded ingestion** is simplest and guarantees the temporary Meta media is fetched immediately, but the current controller waits for all work and may exceed Meta's webhook timeout for large/slow objects.
- **Durable reservation plus worker** allows an early 200 and retryable state transitions, but needs a real recoverable worker/polling mechanism; detached promises are not acceptable because a process crash strands the reservation.
- Recommended design investigation for proposal/design: use a durable DB-backed job/state machine with immediate wake-up and restart recovery if operational complexity is accepted. Otherwise explicitly cap size/time and make synchronous processing resumable/idempotent. This is an architecture choice, not a product question, but the delivery risk should be visible.

## 7. Alternative access and persistence designs

| Option                                                    | Fit                                     | Tradeoff                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chatbot capability/proxy URL over private S3              | Recommended candidate                   | Stable and provider-neutral; works with backend's direct URL contract. Capability can leak through logs/referrers and is not reviewer identity auth; requires chatbot availability, token-hash persistence, streaming/range decisions, and retention discipline. |
| Persist a short-lived S3 presigned URL                    | Poor fit                                | Private and simple, but backend stores it unchanged; it can expire before human review and cannot be refreshed without a backend update endpoint. Provider signing differences also weaken portability.                                                          |
| Public object URL/bucket                                  | Rejected by stated non-goal             | Simplest direct rendering but exposes receipts and makes revocation/control weak.                                                                                                                                                                                |
| Backend-authenticated proxy                               | Strongest identity control, unavailable | Would require backend and likely frontend changes to authorize/stream media; explicitly outside this chatbot-only change.                                                                                                                                        |
| Store pending media only in conversation JSONB            | Rejected                                | Cannot safely query lifecycle/cleanup/status and is vulnerable to whole-bag replacement/lost updates.                                                                                                                                                            |
| Separate receipt-media table + small conversation pointer | Recommended                             | Supports unique constraints, retries, cleanup, and audit while keeping conversational routing cheap.                                                                                                                                                             |

## 8. Idempotency, failure, and cleanup semantics to specify

- Reserve before external side effects with unique webhook/provider identifiers.
- Re-delivery resumes the existing state rather than creating another object or backend receipt.
- Upload success followed by DB failure requires object deletion/compensation; DB success followed by response failure must be safely replayable.
- Backend receipt POST has no idempotency key. The chatbot must persist `ATTACHING/ATTACHED` and avoid blind repeats, but a network timeout after backend commit remains ambiguous and can duplicate receipt evidence on retry. This is a material backend-contract limitation; either accept/manual-reconcile, request backend idempotency as a future dependency, or use a conservative terminal `ATTACH_OUTCOME_UNKNOWN` state that does not auto-retry.
- Customer duplicate handling should distinguish exact webhook re-delivery from a deliberate second receipt image. A new message id should normally create a new pending item; product must decide whether one active pending receipt per sale/sender is enforced.
- Abandoned pre-attachment objects can be deleted after a chosen timeout. Partial multipart uploads should be aborted immediately and covered by bucket lifecycle rules. Attached evidence retention must be long enough for review/history because no review completion signal exists.

## 9. OpenSpec impact

Canonical chatbot capabilities likely modified:

- `whatsapp-webhook`: accept/normalize media, routing precedence, acknowledgement/dedup semantics.
- `conversation-store`: typed pending receipt pointer/amount state, preserving sibling fields.
- `sale-flow-tools`: remove model control over `saleId` and `mediaUrl`; update step 13 and tool/runtime context boundary.
- `chatbot-api-client`: contract remains the same endpoint, but attachment orchestration/error ambiguity needs scenarios.
- `app-config`: Meta media/storage/proxy/limits/retention validation.
- `llm-agent`: ensure media events do not become fabricated text and amount routing does not bypass pending-human/ops rules.
- New canonical capabilities are justified for `receipt-media` (ingestion/persistence/lifecycle) and `object-storage` or `receipt-media-access` (private storage + retrieval).

Archived designs informing this change:

- `openspec/changes/archive/2026-06-30-whatsapp-channel-foundation/` established signature, sender, config, and text-only boundaries.
- `openspec/changes/archive/2026-07-05-durable-conversation-store/` established raw Postgres/JSONB semantics.
- `openspec/changes/archive/2026-08-24-sale-flow/` and `2026-08-25-sale-flow-contract-updates/` established `attachReceipt`, tool prompts, API error mapping, and `placedSaleId`.
- `openspec/changes/archive/2026-08-26-human-handoff/` established dispatcher precedence, durable side-workflow tables, and fresh-state preservation.
- Backend archived `2026-06-13-receipt-payment-confirmation` established direct `mediaUrl` consumption and PENDING human review; its public/direct Spaces assumption must be reconciled with the selected private-store policy through a stable capability URL.

## 10. Proposal/spec/design boundary recommendation

### Include

- Signed WhatsApp image/document receipt ingestion and provider DTO changes.
- Authenticated immediate Meta metadata/download behind a port.
- Explicit MIME/size/magic-byte/SSRF/streaming controls.
- Private S3-compatible object storage behind a port and fail-fast typed configuration.
- Durable pending media lifecycle, idempotency, retry/unknown-outcome semantics, and orphan cleanup policy.
- Stable chatbot-hosted capability retrieval compatible with the backend's direct `mediaUrl` queue.
- Deterministic correlation to captured `placedSaleId`; no model-selected sale ids or URLs.
- Declared amount collection and backend `PENDING` attachment.
- Tests for DTO/guard/dispatcher ordering, Meta client, validation, storage adapters, persistence transitions, access controller, retries/dedup, and sale correlation.
- Deployment/runbook updates for bucket provisioning, CORS/CSP/reverse-proxy log redaction, lifecycle, and recovery.

### Exclude

- OCR or image understanding.
- Automatic receipt/payment validation or payment confirmation.
- Backend or human-review frontend modifications.
- Arbitrary/historical sale selection.
- Public bucket/object URLs.
- Product-photo recognition and outbound media forwarding to ops.

## 11. Questions requiring the interactive proposal round

1. Which v1 formats are accepted: JPEG and PNG only, or PDF as well? If PDF is accepted, is download-only review acceptable?
2. What is the maximum accepted receipt size in bytes/MB?
3. What retention applies to (a) abandoned/unattached media and (b) attached receipt evidence? Is historical media expected to remain viewable indefinitely?
4. Is bearer-by-possession capability access acceptable for reviewers, provided tokens are high entropy, stored hashed, redacted from logs, and objects remain private?
5. Should a sender/sale have only one active pending receipt upload, or may multiple distinct receipt images be submitted before review?
6. How should duplicate deliberate submissions be communicated: silently reuse the prior result, report "already received," or allow another backend PENDING evidence row?
7. Amount UX: should the bot ask for amount after receiving the image, accept amount+image in either order, and require a confirmation before attachment? Which Mexican peso input forms must parse (`$1,234.50`, `1234`, cents wording)?
8. On validation/download/upload failure, how many automatic retries are allowed and what customer-facing retry instruction is desired?
9. For a backend POST timeout with unknown commit outcome, should the bot stop and escalate/manual-reconcile rather than risk duplicate evidence?
10. Who provisions the bucket, credentials, public chatbot media base URL, and provider lifecycle/CORS rules for each environment?

## 12. Principal risks

- A stable capability URL can leak via request logs, browser history, monitoring, or referrers; redaction and restrictive response policy are mandatory, but it remains bearer access.
- The current synchronous webhook acknowledgement path can time out during media transfer and induce retries.
- The backend attachment POST is non-idempotent, leaving an unavoidable ambiguous-outcome window without backend support.
- Retention deletion can break backend review/history because the backend stores the URL permanently and exposes no review callback to the chatbot.
- Conversation JSONB read-modify-write has a known lost-update window; media lifecycle must live in a separately constrained table.
- Backend receipt creation appears not to verify that `saleId` belongs to the current tenant; escalate to backend ownership without changing backend here.
- PDF support materially expands content-safety and reviewer-rendering concerns.
