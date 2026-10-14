# Design: durable receipt media ingestion and stable private review access

## Executive decision

Use **durable Postgres reservation plus recoverable, lease-based NestJS workers**, not bounded synchronous media transfer. The signed webhook performs only normalization, routing checks, and an atomic reservation + durable ingestion-causality transaction before returning HTTP 200. A lifecycle-managed worker resolves Meta metadata, streams at most 10 MiB to a private temporary file, validates it, and uploads it to private S3-compatible storage. Only after storage may a second atomic transaction commit the receipt state transition plus the exact deterministic prompt intent. A notification worker in the same feature module drains only committed intents at least once; it never invokes the LLM or manufactures/proactively schedules a message. No detached promise, Redis, broker, or new service is introduced.

This is the smallest mechanism supported by current repository evidence: NestJS 11, `pg`, node-pg-migrate, one shared Postgres database, shutdown hooks, and existing port/adapter patterns. It keeps slow Meta/S3/backend network I/O outside webhook acknowledgement and outside database transactions, survives process restart, and is horizontally safe through `FOR UPDATE SKIP LOCKED`, leases, and compare-and-set (CAS) transitions.

The implementation is confined to `houndfe-chatbot`. **No `houndfe-backend` source, schema, endpoint, or review frontend changes are permitted.** The chatbot continues to consume the existing non-idempotent §4.4.7 HTTP POST; “backend read-only” in this design means repository/contract read-only, not that the approved POST is removed.

## Goals and non-goals

The design realizes all 24 approved requirements and 87 scenarios across the eight change specs. It accepts only `image/jpeg` and `image/png` up to exactly `10_485_760` bytes, captures the server-owned `placedSaleId`, keeps receipt lifecycle outside conversation JSONB, requires deterministic amount confirmation, and exposes a stable capability GET/HEAD over private storage.

PDF, OCR, receipt interpretation, product-photo recognition, public objects, historical-sale selection, automatic customer-media deletion, backend idempotency, backend tenancy fixes, and reviewer UI changes remain out of scope.

## ADR decisions

| ADR                    | Decision                                                                                                                                                                                                                                                                                                            | Alternatives rejected and rationale                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-1 execution        | Postgres reservation + recoverable worker; webhook 200 follows the admission transaction.                                                                                                                                                                                                                           | Synchronous download/upload can put Meta acknowledgement behind two remote services and a 10 MiB transfer. Detached promises strand work on restart. BullMQ/SQS/Kafka add infrastructure unsupported by this repository.                                                              |
| ADR-2 queue            | The `receipt_media` table is the job/state table; a small `receipt_media_outbox` stores exact deterministic intents atomically with their receipt transitions and makes only inbound-caused customer replies restart-drainable at least once.                                                                       | An in-memory queue is not restart-safe. A separate general job framework is unnecessary for one bounded workflow. LLM-generated or scheduler-manufactured outbox intent is forbidden.                                                                                                 |
| ADR-3 storage          | Provider-neutral port with an AWS SDK v3 S3-compatible adapter; validated content uses one atomic `PutObject` from a bounded temp file.                                                                                                                                                                             | Public buckets violate policy. Presigned URLs expire. Multipart adds state for files no larger than 10 MiB. `@aws-sdk/lib-storage` is therefore unnecessary in v1.                                                                                                                    |
| ADR-4 access           | Stable chatbot capability URL whose 256-bit token is deterministically derived by a versioned HMAC and persisted only as SHA-256 hash.                                                                                                                                                                              | Persisting a random raw token violates the hash-only decision and cannot be recovered after restart; random encryption adds another persisted secret blob; expiring signatures break the backend’s immutable URL.                                                                     |
| ADR-5 validation       | Stream Meta bytes to a mode-0600 temp file, enforcing length/hash during transfer, then run strict JPEG/PNG structure validation before upload.                                                                                                                                                                     | Full in-memory buffering multiplies 10 MiB by concurrency. Direct Meta-to-S3 streaming cannot cleanly establish full structural validity before an accepted object exists. `sharp` is a large native dependency; ESM-only sniffing libraries do not match the current CommonJS build. |
| ADR-6 authority        | Receipt attachment is an application service. The registered `attachReceipt` AI tool becomes a strict empty compatibility shim: it may return safe semantic status from server-injected sender context but has no attachment side effect; prompt step 13 tells the model the deterministic service owns the action. | Letting the model trigger attachment or provide any identifier reintroduces the original authority bug. Removing the tool key would violate the canonical twelve-tool registry contract.                                                                                              |
| ADR-7 retention        | Once `STORED`, the object and capability record are never automatically deleted, including cancellation, abandonment, definite attach failure, and unknown outcome.                                                                                                                                                 | There is no backend review-completion callback. Time-based deletion would break an immutable backend URL. Only local temp files, failed pre-acceptance objects, and incomplete multipart artifacts are technical cleanup.                                                             |
| ADR-8 attach transport | §4.4.7 uses the production Axios client with a validated bounded timeout and a caller-owned `AbortSignal`; shutdown or lease loss aborts the underlying socket/request. Request-start evidence is committed before invocation, so every timeout, abort, or network failure is `ATTACH_OUTCOME_UNKNOWN`.             | `Promise.race` only abandons a waiter and can leave the request committing in the background. An unbounded shared-client POST prevents graceful shutdown and makes lease ownership meaningless.                                                                                       |

## End-to-end architecture

### Feature boundaries and wiring

`ReceiptMediaModule` is a feature module imported by `WhatsappModule`. It imports `DatabaseModule`, `ConversationModule`, `ChatbotApiModule`, `WhatsappSenderModule`, `ConfigModule`, and `HttpModule`; this preserves an acyclic graph because `WhatsappSenderModule` is already the leaf sender module.

| Boundary                       | Ownership and seam                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp/presentation`        | DTOs for image id, declared MIME, optional caption; signature guard remains unchanged.                                                              |
| `whatsapp/application`         | Dispatcher precedence and delegation only; no Meta/S3/backend details.                                                                              |
| `receipt-media/domain`         | Status/transition model, typed errors, amount grammar, and injection tokens for store, Meta media, object storage, clock/sleep, telemetry.          |
| `receipt-media/application`    | `ReceiptIngressService`, `ReceiptAmountRouter`, `ReceiptIngestionProcessor`, `ReceiptAttachmentService`, `CapabilityService`, and outbox rendering. |
| `receipt-media/infrastructure` | Postgres store, Meta Axios client, S3 adapter, managed worker loop, Prometheus adapter.                                                             |
| `receipt-media/presentation`   | Thin GET/HEAD capability controller and internal metrics controller; no business logic.                                                             |
| `conversation`                 | Optional typed `activeReceipt` pointer plus a narrow atomic pointer patch/clear operation. Lifecycle remains in `receipt_media`.                    |
| `sale-flow`                    | Empty strict compatibility tool and step-13 instruction repair. No model-visible receipt id, sale id, URL, key, or token.                           |

Ports use Symbol injection tokens and constructor injection. External adapters map failures to narrow error classes: `PermanentMediaValidationError`, `TransientMetaError`, `TransientStorageError`, `DefiniteAttachError`, and `AttachOutcomeUnknownError`. The attachment port accepts transport options containing the worker-owned `AbortSignal`; timeout and signal configuration are applied by the production Axios adapter rather than emulated in application code. Error objects carry safe category/code only; they never carry credentials, provider URLs, object keys, tokens, filenames, or response bodies.

### Concrete file map

| Change type           | Files owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add                   | `migrations/2000000000000_receipt_media.js`; `src/receipt-media/receipt-media.module.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Add domain            | `src/receipt-media/domain/{receipt-media.types,receipt-media.errors,receipt-media-store.port,meta-media.port,object-storage.port,receipt-telemetry.port,amount-parser}.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Add application       | `src/receipt-media/application/{receipt-ingress.service,receipt-amount-router.service,receipt-ingestion.processor,receipt-attachment.service,capability.service,receipt-outbox.service}.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Add infrastructure    | `src/receipt-media/infrastructure/{postgres-receipt-media.store,meta-media.client,s3-object-storage.adapter,receipt-media-worker,prometheus-receipt-telemetry}.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Add presentation/docs | `src/receipt-media/presentation/{receipt-media-access.controller,receipt-metrics.controller}.ts`; `docs/receipt-media-operations.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Modify integration    | WhatsApp inbound DTO/domain/dispatcher/module; conversation state plus pointer adapter; sale-flow attach tool/instructions/registry tests; `src/chatbot-api/domain/chatbot-api.client.ts` (caller `AbortSignal` seam), `src/chatbot-api/infrastructure/chatbot-api-http.client.ts` (Axios timeout/signal wiring and conservative response projection), `src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts`; `src/config/{configuration,env.validation}.ts` and their specs for `CHATBOT_API_ATTACH_TIMEOUT_MS`; `src/chatbot-api/chatbot-api.module.ts` only if an attach transport token is needed; `package.json` and `pnpm-lock.yaml`. |
| Tests                 | Adjacent `*.spec.ts` files and Testcontainers integration specs under the owning feature; no test owns production lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Names may be split to respect the 400-line review guard, but ownership must not migrate into controllers or the generic LLM runner.

### Webhook admission, early acknowledgement, and prompt

```mermaid
sequenceDiagram
    participant M as Meta
    participant C as Signed webhook controller
    participant D as Dispatcher / ingress
    participant P as Postgres
    participant W as Receipt worker
    participant MM as Meta media API
    participant S as Private S3-compatible store
    participant O as Notification outbox worker
    participant U as Customer

    M->>C: POST signed image webhook
    C->>C: HMAC over raw body
    C->>D: normalized media id, MIME, caption
    D->>P: TX1: dedup + active gate + capture sale + RESERVED + durable inbound/ingestion causality
    P-->>D: reservation and causality committed atomically
    D-->>C: admitted
    C-->>M: HTTP 200 early
    Note over D,P: No future amount-prompt intent exists before validation and storage
    W->>P: claim RESERVED; atomically increment Meta attempts before call
    W->>MM: resolve metadata by provider media id
    MM-->>W: allowed HTTPS URL, MIME, size
    W->>MM: streamed authenticated download
    W->>W: size/hash/magic/structure validation; temp file
    W->>P: atomically increment storage attempts before PutObject
    W->>S: atomic private PutObject
    S-->>W: ETag/version metadata
    W->>P: TX2: receipt state transition + exact deterministic prompt intent
    P-->>W: transition and outbox committed atomically
    O->>P: claim committed prompt intent
    Note over O,U: Outbox never invokes LLM or manufactures intent
    O->>U: send recorded duplicate-safe deterministic content
    O->>P: mark sent + provider wamid; crash window may replay
```

The managed loop is owned by Nest lifecycle: `OnApplicationBootstrap` stores the loop promise and abort controller; `OnModuleDestroy` stops new claims, aborts bounded Meta, S3, and chatbot-api requests at the underlying transport, awaits all tracked work, and then permits the existing pool lifecycle to close. Lease-loss detection aborts the affected worker operation as well. This is not a detached promise, and no timeout is implemented with `Promise.race`. An in-process wake signal reduces latency after local admission; a one-second abortable Postgres poll provides cross-instance and restart recovery.

Worker concurrency defaults to 2 and is configurable from 1–8. A process claims at most its free slots. The database pool must be sized above worker concurrency plus HTTP demand. Each external operation has a timeout shorter than the renewed 60-second lease. Lease renewal is a short CAS immediately before each network stage; no transaction remains open over network I/O.

### Amount confirmation and backend attachment

```mermaid
sequenceDiagram
    participant U as Customer
    participant D as Dispatcher
    participant A as Amount router
    participant P as Postgres
    participant W as Receipt worker
    participant B as Existing chatbot-api §4.4.7
    participant O as Outbox worker

    U->>D: text amount / explicit confirmation
    D->>A: route before generic LLM
    A->>P: atomic inbound dedup + amount-state transition + exact deterministic outbox intent
    alt valid amount, not yet confirmed
        O->>P: claim committed confirmation intent
        O->>U: send recorded ¿Confirmas $1,234.50 MXN? Sí/No
    else explicit confirmation
        A->>P: AWAITING_CONFIRMATION -> ATTACHING; attach_attempts=0
        D-->>U: webhook acknowledgement occurs without waiting for backend
        W->>P: claim ATTACHING with request_started_at null
        W->>P: pre-request CAS: attempts 0->1 + request-start timestamp/UUID
        W->>B: one bounded Axios POST with captured sale/URL + AbortSignal
        alt contract-expected 2xx with valid receipt id/PENDING
            B-->>W: receiptId, PENDING
            W->>P: atomic ATTACHED transition + exact success outbox intent
            O->>U: send recorded review-status message at least once
        else allowlisted proven non-committing 4xx
            B-->>W: definite response
            W->>P: atomic FAILED/ATTACH_DEFINITE + exact failure outbox intent
            O->>U: send recorded definite-failure guidance at least once
        else any outcome not proven non-committing
            B--xW: 408/5xx/timeout/network/abort/malformed/unexpected/default
            W->>P: atomic ATTACH_OUTCOME_UNKNOWN + evidence + exact safe outbox intent
            O->>U: send recorded delayed-confirmation message at least once
        end
    end
```

The HTTP client’s existing POST non-retry behavior remains, with a receipt-specific production transport seam added so `ReceiptAttachmentService` supplies a worker-owned `AbortSignal` and the client applies validated `CHATBOT_API_ATTACH_TIMEOUT_MS` directly to Axios. Axios must receive both `timeout` and `signal`; shutdown or lease loss invokes the controller, which aborts the underlying request. `Promise.race` is forbidden. Because request-start evidence is already committed, timeout, cancellation/abort, socket/DNS/network failure, and every other transport error are conservatively unknown even if shutdown initiated the abort.

The attachment service accepts a loaded durable receipt aggregate, not free `saleId`/`mediaUrl` arguments from model context. It reconstructs and verifies the capability URL, uses `captured_sale_id`, and sends `declaredDate`/`declaredReference` as null in v1 because neither is deterministically collected. The strict-empty compatibility tool receives `senderId` only through server-injected AI SDK execution context, never its schema; it can return `missingPlacedSaleId` or a generic deterministic-flow status but cannot call §4.4.7. Actual confirmation never enters the LLM path. Every receipt notification in this sequence is an already-committed deterministic outbox intent from the matching state transition; the notification worker has no dependency on `AgentRunner`/`LlmAgentPort` and cannot formulate a new message.

### Reviewer access

```mermaid
sequenceDiagram
    participant R as Reviewer browser
    participant X as Redacting reverse proxy
    participant C as Capability controller
    participant P as Postgres
    participant S as Private S3-compatible store

    R->>X: GET /media/receipts/{opaque-token}
    X->>C: path forwarded; request URI omitted/redacted in logs
    C->>C: strict base64url parse + SHA-256
    C->>P: indexed lookup by capability_token_hash
    P-->>C: object metadata or none
    C->>C: timing-safe compare against stored/dummy hash
    alt valid and not revoked
        C->>S: GetObject private key
        S-->>C: stream
        C-->>R: 200 bytes + safe headers
    else missing/altered/revoked
        C-->>R: generic 404, identical body
    end
```

The authorization decision itself is owned by a dedicated application-layer authorizer returning a closed discriminated result — `authorized` carrying only the opaque object key, `denied`, or `unavailable` — so no row, exception, or token detail crosses to presentation. Every well-formed token, known or unknown, is verified timing-safely against the stored or fixed dummy hash BEFORE the row-existence/revocation decision, keeping unknown-token timing uniform; database failures map to the unavailable result with no exception detail.

### Restart and lease recovery

```mermaid
sequenceDiagram
    participant W1 as Worker instance A
    participant P as Postgres
    participant W2 as Fresh/other instance
    participant E as External service

    W1->>P: claim job, lease_owner=A, lease_expires_at=T
    W1->>E: bounded operation with transport AbortSignal
    W1-xW1: shutdown or lease ownership is lost
    W1--xE: abort underlying request
    Note over P: durable status/counters/object key remain
    W2->>P: recovery marks expired request-started ATTACHING as UNKNOWN
    W2->>P: claim other expired resumable rows with SKIP LOCKED
    alt RESERVED/DOWNLOADED/STORED
        W2->>E: resume safe stage using same object key
        W2->>P: CAS transition using version + lease owner
    else ATTACHING and request_started_at is null
        W2->>P: claim and perform the one POST
    else ATTACHING and request_started_at is set
        W2->>P: ATTACH_OUTCOME_UNKNOWN; never retry POST
    end
```

## Durable lifecycle

### State transition table

| From                    | Event/guard                                                                                                                                                                      | To                       | Durable effects                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| none                    | supported image, feature on, no active row, current `placedSaleId` exists                                                                                                        | `RESERVED`               | **TX1:** insert immutable inbound/receipt ids, sender, captured sale, random object key, parsed-caption result, durable ingestion causality, and processed-webhook record atomically. No amount-prompt outbox intent is created.                                                                                                                 |
| `RESERVED`/`DOWNLOADED` | claim needs a Meta metadata/download call and `meta_attempts < 3`                                                                                                                | same processing status   | In a short CAS transaction, increment `meta_attempts` **before** the external attempt; the returned value is attempt 1, 2, or 3. No call starts if the CAS loses or the prior count is 3.                                                                                                                                                        |
| `RESERVED`/`DOWNLOADED` | metadata + streamed validation succeeds on the started attempt                                                                                                                   | `DOWNLOADED`             | Set safe MIME/size/hash metadata and `downloaded_at`; temp path is never persisted. A successful attempt remains counted.                                                                                                                                                                                                                        |
| `RESERVED`/`DOWNLOADED` | transient Meta failure on started attempt 1 or 2                                                                                                                                 | same status              | Clear lease and set exponential `next_attempt_at` with jitter; attempt 2 is the final reschedule.                                                                                                                                                                                                                                                |
| `RESERVED`/`DOWNLOADED` | permanent media/validation failure, transient failure on started attempt 3, or restart cannot reconstruct a lost temp file because `meta_attempts = 3`                           | `FAILED`                 | Set `MEDIA_VALIDATION_PRE_STORAGE` for permanent format/policy rejection or `META_EXHAUSTED_PRE_STORAGE` for exhausted/reconstruction cases; clear any superseded prior download-complete projection when revalidation failed; no fourth Meta call, capability, accepted object, or backend call. Technical cleanup evidence remains actionable. |
| `DOWNLOADED`            | before private `PutObject`, `storage_attempts < 3`                                                                                                                               | `DOWNLOADED`             | In a short CAS transaction, increment `storage_attempts` **before** the external attempt; no call starts if the CAS loses or the prior count is 3. Meta and storage counters are independent.                                                                                                                                                    |
| `DOWNLOADED`            | private `PutObject` and CAS succeed                                                                                                                                              | `STORED`                 | Object ETag/version, capability hash/key version, `stored_at`; accepted-media no-deletion begins. A successful storage attempt remains counted.                                                                                                                                                                                                  |
| `DOWNLOADED`            | transient upload failure on started attempt 1 or 2                                                                                                                               | `DOWNLOADED`             | Compensate any unaccepted object, clear lease, and schedule resume. A recovered worker re-downloads only if Meta attempt eligibility remains; there is never a fourth Meta or storage call.                                                                                                                                                      |
| `DOWNLOADED`            | upload failure on started attempt 3                                                                                                                                              | `FAILED`                 | Set `failure_stage='STORAGE_EXHAUSTED_PRE_ACCEPTANCE'`; compensate any unaccepted object and retain cleanup-pending evidence until cleanup succeeds. No fourth storage call.                                                                                                                                                                     |
| `STORED`                | caption yielded exactly one valid amount                                                                                                                                         | `AWAITING_CONFIRMATION`  | **TX2:** persist integer cents, atomic conversation pointer, state version, and exact deterministic confirmation outbox intent atomically.                                                                                                                                                                                                       |
| `STORED`                | caption absent/invalid/ambiguous                                                                                                                                                 | `AWAITING_AMOUNT`        | **TX2:** persist pointer, state version, and exact deterministic amount-prompt outbox intent atomically. This is the first point an accepted image may create a future amount prompt.                                                                                                                                                            |
| `AWAITING_AMOUNT`       | exactly one valid amount                                                                                                                                                         | `AWAITING_CONFIRMATION`  | Persist cents and exact deterministic confirmation outbox intent atomically with the transition.                                                                                                                                                                                                                                                 |
| `AWAITING_AMOUNT`       | explicit cancel                                                                                                                                                                  | `CANCELLED`              | Clear pointer, retain accepted object, and atomically record the deterministic cancellation outbox intent.                                                                                                                                                                                                                                       |
| `AWAITING_CONFIRMATION` | explicit “no”                                                                                                                                                                    | `AWAITING_AMOUNT`        | Clear proposed amount and atomically record the exact ask-again intent.                                                                                                                                                                                                                                                                          |
| `AWAITING_CONFIRMATION` | explicit cancel                                                                                                                                                                  | `CANCELLED`              | Clear pointer; no backend call; retain object; atomically record cancellation intent.                                                                                                                                                                                                                                                            |
| `AWAITING_CONFIRMATION` | explicit confirmation                                                                                                                                                            | `ATTACHING`              | Clear pointer; set `attach_attempts=0` and `attach_started_at`; backend work becomes claimable. No POST has started.                                                                                                                                                                                                                             |
| `ATTACHING`             | claim owns lease, request marker absent, attempts 0                                                                                                                              | `ATTACHING`              | Pre-request CAS sets `attach_attempts=1`, attempt UUID, and `attach_request_started_at` before invoking Axios. Exactly one call is permitted.                                                                                                                                                                                                    |
| `ATTACHING`             | contract-expected 2xx with valid `{receiptId,status:'PENDING'}`                                                                                                                  | `ATTACHED`               | Store backend receipt id/status and `attached_at`; atomically record exact deterministic success outbox intent.                                                                                                                                                                                                                                  |
| `ATTACHING`             | HTTP status in the explicit proven non-committing 4xx allowlist                                                                                                                  | `FAILED`                 | Set `failure_stage='ATTACH_DEFINITE'`, status/code, and exact deterministic failure outbox atomically; retain accepted object and never retry.                                                                                                                                                                                                   |
| `ATTACHING`             | 408, 5xx, timeout, network/DNS/socket failure, cancellation/abort, malformed expected success, unexpected status, any unclassified default, or expired lease after request start | `ATTACH_OUTCOME_UNKNOWN` | Persist structured unknown evidence and exact safe deterministic outbox intent atomically; no automatic retry.                                                                                                                                                                                                                                   |

Terminal product states are `ATTACHED`, `FAILED`, `CANCELLED`, and `ATTACH_OUTCOME_UNKNOWN`. `FAILED` is disambiguated by mandatory `failure_stage`: `MEDIA_VALIDATION_PRE_STORAGE`, `META_EXHAUSTED_PRE_STORAGE`, `STORAGE_EXHAUSTED_PRE_ACCEPTANCE`, or `ATTACH_DEFINITE`. The first three can carry `cleanup_pending=true` and can never satisfy accepted-object/attach predicates; `ATTACH_DEFINITE` must satisfy accepted-object, amount, and request-start evidence and can never request customer-media deletion. This makes migration checks implementable without a vague “from `STORED` onward” rule. All state changes use `UPDATE ... WHERE id=$id AND status=$expected AND version=$version` and, for workers, matching `lease_owner`. A zero-row update means another actor won; the caller aborts any owned transport, reloads, and does not repeat a non-idempotent effect.

The partial unique active index covers `RESERVED`, `DOWNLOADED`, `STORED`, `AWAITING_AMOUNT`, `AWAITING_CONFIRMATION`, and `ATTACHING`. This prevents two concurrent first images as well as the explicitly specified overlap during amount/confirmation. A deliberate image after a terminal state creates a new UUID row; no prior row is changed. `ATTACH_OUTCOME_UNKNOWN` is terminal for automation, so a later deliberate image is sequentially allowed, but the customer is warned that manual reconciliation is still pending.

`ConversationState.data.activeReceipt` is only `{ receiptId, phase: 'AWAITING_AMOUNT' | 'AWAITING_CONFIRMATION' }`. Inbound routing always verifies the receipt table and can repair a missing/stale pointer. Receipt pointer writes use a narrow Postgres statement (`jsonb_set` to set, `data - 'activeReceipt'` to clear) so current sibling fields are preserved; generic `ConversationStore.update` semantics remain unchanged. `AgentRunner` continues its fresh-state spread and therefore preserves the pointer on its later transcript write. The pointer never owns retries, correlation, object identity, or outcome.

## Database design

A single additive node-pg-migrate migration creates the following tables. UUIDs and random keys are generated with Node `crypto.randomUUID()`; no extension is required. Migration rollback is development-only and refuses operational use once data exists.

### `receipt_media` columns

| Group            | Columns and constraints                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/dedup   | `id uuid PK`; `webhook_message_id text NOT NULL UNIQUE`; `provider_media_id text NOT NULL UNIQUE`; `sender_id text NOT NULL`; `captured_sale_id uuid NOT NULL`; `object_key text NOT NULL UNIQUE` matching `receipts/<uuid>`.                                                                                                                                                          |
| Lifecycle        | `status text NOT NULL CHECK` over the ten exact states; `version bigint NOT NULL DEFAULT 0`; `created_at`, `updated_at`, `reserved_at` non-null; nullable `downloaded_at`, `stored_at`, `amount_proposed_at`, `attach_started_at`, `attach_request_started_at`, `attached_at`, `terminal_at`.                                                                                          |
| Media            | `declared_mime_type`, `response_mime_type`, `detected_mime_type` constrained to JPEG/PNG when non-null; `provider_declared_bytes`, `byte_count` each 1..10_485_760 when set; `content_sha256 bytea` length 32; `object_etag text`, `object_version_id text`. No caption or filename is retained.                                                                                       |
| Capability       | `capability_token_hash bytea` length 32; `capability_key_version integer`; `capability_issued_at`, `capability_revoked_at`. Exact accepted-state predicates are listed below; no ordinal/status-depth comparison is used.                                                                                                                                                              |
| Amount/backend   | `declared_amount_cents integer CHECK > 0`; `backend_receipt_id uuid`; `backend_receipt_status text CHECK = 'PENDING'`; `attach_attempt_id uuid`; `attach_attempts smallint DEFAULT 0 CHECK 0..1`. Exact amount, request-start, success, and unknown predicates are listed below.                                                                                                       |
| Retry/lease      | `meta_attempts smallint DEFAULT 0 CHECK 0..3`; `storage_attempts smallint DEFAULT 0 CHECK 0..3`; both count **started external attempts** and are incremented atomically before the corresponding call; `next_attempt_at timestamptz NOT NULL DEFAULT now()`; `lease_owner text`, `lease_expires_at timestamptz` with paired-null check.                                               |
| Failure/evidence | `failure_stage text CHECK IN ('MEDIA_VALIDATION_PRE_STORAGE','META_EXHAUSTED_PRE_STORAGE','STORAGE_EXHAUSTED_PRE_ACCEPTANCE','ATTACH_DEFINITE')`; `last_error_category`, `last_error_code`, `attach_http_status`, `attach_transport_code`, `attach_outcome_observed_at`, `cleanup_pending boolean DEFAULT false`, `cleanup_attempts integer DEFAULT 0`; no raw error body/message/URL. |
| Reconciliation   | `reconciliation_disposition text CHECK IN ('BACKEND_CONFIRMED','BACKEND_NOT_FOUND','UNRESOLVED')`, `reconciled_backend_receipt_id uuid`, `reconciled_at timestamptz`, `reconciled_by text`; no free-text field that could collect secrets.                                                                                                                                             |

### Implementable lifecycle checks

The migration expresses explicit set-membership predicates, not lifecycle ordering:

| Predicate                | Exact database rule                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted object evidence | `stored_at`, `object_etag`, `capability_token_hash`, `capability_key_version`, and `capability_issued_at` are all non-null exactly for `STORED`, `AWAITING_AMOUNT`, `AWAITING_CONFIRMATION`, `ATTACHING`, `ATTACHED`, `CANCELLED`, `ATTACH_OUTCOME_UNKNOWN`, and `FAILED` with `failure_stage='ATTACH_DEFINITE'`; they are all null for `RESERVED`, `DOWNLOADED`, and every pre-storage/pre-acceptance `FAILED` stage. |
| Download evidence        | `DOWNLOADED` and `STORAGE_EXHAUSTED_PRE_ACCEPTANCE` require `downloaded_at`, response/detected MIME, byte count, and content hash. `RESERVED`, `MEDIA_VALIDATION_PRE_STORAGE`, and `META_EXHAUSTED_PRE_STORAGE` do not claim completed download evidence.                                                                                                                                                              |
| Amount evidence          | `AWAITING_CONFIRMATION`, `ATTACHING`, `ATTACHED`, `ATTACH_OUTCOME_UNKNOWN`, and `FAILED/ATTACH_DEFINITE` require positive `declared_amount_cents`. `AWAITING_AMOUNT` requires it null. Cancellation may preserve a formerly proposed amount but cannot carry attach evidence.                                                                                                                                          |
| Attach request evidence  | `ATTACHING` requires `attach_started_at`; within it, `attach_attempts=0` iff request-start fields are null and `attach_attempts=1` iff both attempt UUID and request-start timestamp are non-null. `ATTACHED`, `ATTACH_OUTCOME_UNKNOWN`, and `FAILED/ATTACH_DEFINITE` require attempts 1 plus both request-start fields. All pre-attach states and `CANCELLED` require attempts 0 and request-start fields null.       |
| Definite attach failure  | `FAILED/ATTACH_DEFINITE` requires accepted object evidence, amount, request-start evidence, no backend receipt id, `cleanup_pending=false`, and `attach_http_status` in the exact non-committing allowlist `400, 401, 403, 404, 409, 422, 429`. Other `FAILED` stages require attach fields/status null.                                                                                                               |
| Unknown attach           | `ATTACH_OUTCOME_UNKNOWN` requires accepted object, amount, request-start, and `attach_outcome_observed_at`; it requires either HTTP evidence outside the success/definite allowlists or a safe transport code. It cannot carry a backend receipt id.                                                                                                                                                                   |
| Attached success         | `ATTACHED` requires accepted object, amount, request-start, `backend_receipt_id`, `backend_receipt_status='PENDING'`, and `attached_at`; failure fields/stage are null.                                                                                                                                                                                                                                                |
| Failure discriminator    | `failure_stage IS NOT NULL` iff `status='FAILED'`. `cleanup_pending=true` is allowed only for the three pre-storage/pre-acceptance stages and forbidden for `ATTACH_DEFINITE`.                                                                                                                                                                                                                                         |

These checks permit definite post-storage attach failure while preventing pre-storage failures from pretending to own an accepted capability or attach attempt.

### `receipt_media_outbox` columns

`id uuid PK`, `dedupe_key text UNIQUE`, nullable `receipt_media_id uuid REFERENCES receipt_media(id)`, `receipt_state_version bigint`, `source_webhook_message_id text NOT NULL`, `recipient_id text NOT NULL`, `template_key text NOT NULL CHECK` over fixed Spanish templates, `template_args jsonb NOT NULL DEFAULT '{}'` (integer cents/status only), `status text CHECK IN ('PENDING','SENDING','SENT','FAILED')`, `attempts smallint CHECK 0..3`, `next_attempt_at`, lease fields, `provider_message_id text`, and timestamps. `dedupe_key` is derived from source inbound id plus receipt id/state version/template, so replay of a state transaction cannot create a different intent. It never stores a capability token/URL, object key, caption, arbitrary message text, or model output.

A receipt-state transition that requires customer notification inserts the exact template and bounded arguments in the **same transaction** as that transition. The outbox worker can execute only these committed rows; it has no LLM/agent dependency, cannot choose a template or arguments, and cannot manufacture intent. Its own `FOR UPDATE SKIP LOCKED` claim changes `PENDING` (or expired `SENDING`) to leased `SENDING`; success stores the provider id and `SENT`, retryable failure reschedules through attempt 3, and exhaustion becomes `FAILED` plus an alert. Reclaiming expired `SENDING` gives at-least-once delivery. A crash after Meta accepts the send but before `SENT` may replay the byte-identical deterministic content; state and echo bookkeeping must tolerate that duplicate, and the design never claims exactly-once WhatsApp delivery.

### Indexes and claims

| Index                                                                                | Purpose                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unique partial on `receipt_media(sender_id) WHERE status IN (...)`                   | One active flow per sender, horizontally enforced.                                                                                                                                                                                                                      |
| Partial `(next_attempt_at, created_at)` over eligible resumable predicates           | Worker claim queue: `RESERVED` requires `meta_attempts < 3`; `DOWNLOADED` requires `storage_attempts < 3` and, when temp reconstruction is needed, `meta_attempts < 3`; `ATTACHING` requires attempts 0 and no request-start marker. No exhausted row remains callable. |
| Unique partial on `capability_token_hash WHERE capability_token_hash IS NOT NULL`    | O(1) capability lookup.                                                                                                                                                                                                                                                 |
| `(status, updated_at)` and partial unknown index                                     | Backlog, governance, and reconciliation queries.                                                                                                                                                                                                                        |
| Outbox partial `(next_attempt_at, created_at) WHERE status IN ('PENDING','SENDING')` | Recoverable notifications.                                                                                                                                                                                                                                              |

The claim transaction is short:

```sql
WITH candidate AS (
  SELECT id
  FROM receipt_media
  WHERE next_attempt_at <= now()
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
        AND ((status = 'RESERVED' AND meta_attempts < 3)
          OR (status = 'DOWNLOADED'
              AND storage_attempts < 3
              AND meta_attempts < 3)
          OR status = 'STORED'
          OR (status = 'ATTACHING'
              AND attach_attempts = 0
              AND attach_request_started_at IS NULL))
  ORDER BY next_attempt_at, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE receipt_media r
SET lease_owner = $2,
    lease_expires_at = now() + interval '60 seconds',
    version = version + 1,
    updated_at = now()
FROM candidate c
WHERE r.id = c.id
RETURNING r.*;
```

A separate recovery CAS changes expired `ATTACHING` rows with non-null `attach_request_started_at` to `ATTACH_OUTCOME_UNKNOWN` and atomically inserts its exact safe notification intent. Exhaustion recovery terminalizes rows that cannot safely reconstruct a lost temp file without a fourth Meta call. Counter increments are separate short CAS transactions immediately before each external Meta or storage attempt; claim eligibility and the pre-call CAS both enforce `< 3`, so failure at started count 1 or 2 can schedule resume, failure at started count 3 is terminal, and no fourth call can occur independently for either service.

**Admission boundary (TX1):** accepted images commit `processed_webhook_messages`, immutable receipt reservation, and durable inbound-to-ingestion causality atomically before early HTTP 200. Deterministic no-ingestion outcomes (kill-switch, no sale, unsupported media, or active-flow rejection) commit their processed inbound decision and exact response intent atomically; they never create ingestion work. If either admission form rolls back, the controller returns failure and no worker or post-200 notification may run. An accepted reservation creates no future amount-prompt intent: only the later post-validation/post-`PutObject` state transaction may create it.

**Notification boundary (TX2):** every later receipt transition that needs a message commits the new state/version and exact deterministic outbox row atomically before send. A crash before commit sends nothing; a crash after commit leaves only that inbound-caused intent restart-drainable at least once. Conflict outcomes remain exact: the same webhook/media pair returns the existing row; a new webhook id carrying the same provider media id marks the new inbound decision and reuses the existing outcome; the same webhook id carrying a different media id is rejected and security-alerted without a new receipt; and a partial-active-index conflict creates only the causally tied finish-or-cancel intent. Transactions never encompass Meta, S3, WhatsApp, or backend HTTP calls.

## Meta media and validation design

`MetaMediaPort.resolveAndDownload(providerMediaId, declaredMime, sink)` accepts no URL. One logical Meta attempt covers metadata resolution plus its validated binary download chain. Before attempt 1, 2, or 3, the worker atomically increments `meta_attempts`; the adapter receives that claimed attempt plus a worker-owned signal. It manually handles every response and redirect—Axios automatic redirects are never enabled.

**Every Axios metadata and download hop**, including the configured Graph metadata origin, must use `proxy: false`, `maxRedirects: 0`, the bounded timeout/signal, and the per-hop pinned HTTPS agent/lookup. An explicitly trusted controlled transport is acceptable only if it is demonstrably equivalent: ambient `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` processing must not choose the destination, bypass address pinning, or receive the bearer token. No default/global Axios transport may override these settings.

Before constructing or sending each hop, the target must be HTTPS, have no userinfo, use port 443 (or the explicitly configured test port), and match the configured exact/suffix host allowlist with label-boundary matching. DNS A/AAAA results are resolved before connection; `ipaddr.js` rejects loopback, private, link-local, multicast, documentation, unspecified, carrier-grade NAT, and other non-global ranges. The validated public address is pinned into the HTTPS agent lookup for that hop while TLS SNI/hostname verification uses the validated original hostname, preventing DNS rebinding. **Only after both host and resolved address pass policy** may that hop receive the Meta bearer header. Redirect locations are parsed as new targets, re-resolved, revalidated, and repinned before another request; at most three redirects are followed manually. A rejected target receives no bearer and no network call.

Metadata timeout is 5 seconds and the logical metadata/download attempt has a 30-second total transport abort plus socket timeout. Retryable categories are network failure, 408, 429 (honor `Retry-After` only within the lease), and 5xx; permanent categories include origin policy, missing/invalid/oversized metadata, 4xx other than 408/429, and content validation. Started attempt failure at count 1 or 2 schedules backoff (1s, 4s with bounded jitter); failure at count 3 terminalizes the row. Storage applies the same timing independently around `PutObject`: atomic pre-call increment, reschedule only after failures 1/2, terminal on failure 3, and never a fourth call.

The stream pipeline writes a random file under the OS temp directory with mode 0600, counts bytes, computes SHA-256, and aborts immediately at byte 10_485_761. Metadata size must be present and 1..10_485_760; response `Content-Length`, when present, must also be valid and equal the final count. Declared webhook MIME, metadata MIME, response `Content-Type` after stripping parameters, and detected type must all be exactly the same `image/jpeg` or `image/png`.

A small internal structural validator avoids another format dependency: PNG requires signature, first IHDR of length 13 with non-zero dimensions, bounded chunk traversal/CRC validation, and a final IEND with no trailing bytes; JPEG requires SOI, valid marker/segment lengths, at least one SOF and SOS, correctly escaped entropy data, and terminal EOI with no trailing bytes. The temp file is unlinked in `finally` on every path. Before `STORED`, an abort controller cancels S3 work and any possibly completed object at the reserved key is compensating-deleted; failed cleanup remains `cleanup_pending` and is retried/alerted. Once `STORED`, no code path calls delete.

## Object storage and capability URL

`ObjectStoragePort` exposes `putValidated`, `getStream`, `head`, and `deleteTechnicalObject`. Domain inputs are key, stream, byte length, detected MIME, and checksum; no AWS types cross the port. `S3ObjectStorageAdapter` uses `@aws-sdk/client-s3` `PutObjectCommand`, `GetObjectCommand`, `HeadObjectCommand`, and `DeleteObjectCommand`, a configured HTTPS endpoint/region/bucket/path-style mode, and no public ACL. The known content length makes one PUT atomic and bounded. Application multipart is not used; the owner still configures a bucket lifecycle rule that aborts incomplete multipart uploads only, protecting against provider tooling/future adapter changes.

The object key is generated at reservation as `receipts/<uuid-v4>` and is reused on safe retry. It contains no sender, sale, amount, filename, provider id, MIME extension, or token. Bucket policy denies anonymous reads/listing and allows the chatbot credential only the required object verbs on `receipts/*`.

For receipt UUID `R` and key version `v`, the capability token is:

```text
token = base64url(HMAC-SHA256(K[v], "receipt-media-capability:v1:" + R))
hash  = SHA256(ASCII(token))
url   = RECEIPT_MEDIA_PUBLIC_BASE_URL + "/media/receipts/" + token
```

`K[v]` is a 32-byte-or-longer secret from a versioned keyring; only `hash` and `v` are stored. After restart, `CapabilityService` derives the same token from `R` and `v`, timing-safely verifies its hash against the row, and recreates the same URL. Rotation is additive: deploy old+new keys, make the new version active for new rows, and retain every old key while its immutable backend URL must work. Removing/changing an old key irreversibly breaks those URLs because the hash cannot recover the token. Emergency per-record revocation sets `capability_revoked_at`; it intentionally makes the backend URL return 404.

The route accepts only a 43-character base64url token, hashes it, and performs the unique lookup. It executes `timingSafeEqual` against the stored hash or a fixed dummy hash and returns the same status/body for malformed, unknown, revoked, and missing-object cases. Database lookup failures and storage failures other than a missing object instead return one empty 503 with a fixed `Retry-After: 5` (seconds, provider-agnostic) and no detail; they are never retried server-side and never conflated with the denial 404. A client disconnect aborts the exact storage abort signal, and a disconnect during the uncancellable database lookup suppresses the later storage call and response; a future GET stream failure after headers terminates the connection and is recorded separately, never as a false 5xx. GET streams; HEAD performs private `HeadObject` and returns no body. Headers are:

- detected `Content-Type` and exact `Content-Length`;
- `Content-Disposition: inline; filename="receipt.jpg"` or `receipt.png` (fixed, non-PII);
- `X-Content-Type-Options: nosniff`;
- `Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox`;
- `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, and `Cross-Origin-Resource-Policy: cross-origin`.

Range requests are not supported in v1 and receive 416; JPEG/PNG browser viewing does not require range. Application logging records only route template, outcome category, correlation id, and latency. The reverse proxy must omit the request URI for this location (or replace the last path segment with `[REDACTED]`), exclude query strings, preserve streaming without response buffering limits, allow GET/HEAD only, enforce TLS, and apply rate limiting. Plain-browser access needs no cookie/header; JavaScript CORS is not promised.

## Amount workflow and routing precedence

Caption parsing is CPU-only during admission; only a parsed integer amount or an invalid/absent marker is persisted, never caption text. Later text is parsed before the LLM. Exactly one candidate is required:

1. Numeric pesos: optional `$` or `MXN`, correctly grouped comma thousands or ungrouped digits, optional **two** decimal digits, and optional `MXN`/`peso(s)` suffix; examples `$1,234.50 -> 123450`, `1234 -> 123400`. Signs, decimal comma, malformed grouping, more/fewer than two decimals, zero, overflow, or two distinct candidates are rejected.
2. Spanish words: a bounded grammar for units/tens/hundreds/thousands/millions followed by `peso(s)` and optional `con <0..99 words> centavo(s)`; `mil doscientos treinta y cuatro pesos con cincuenta centavos -> 123450`. Unknown tokens or invalid number composition are rejected.

At confirmation, normalized affirmative forms are `sí`, `si`, `confirmo`, `correcto`, and `es correcto`; explicit receipt cancellation is `cancelar`, `cancela`, or `cancelo`. `no` returns to amount entry rather than attaching. Unrecognized confirmation repeats the yes/no question. Cancellation transitions to `CANCELLED`, clears the pointer, sends a Spanish outcome, and never deletes the stored image.

The dispatcher preserves this order for each normalized inbound:

1. HMAC guard over raw body (controller boundary).
2. Normalize text/image/unsupported-media; no temporary URL or token exists in the envelope.
3. Recent outbound echo filter.
4. Durable webhook dedup by provider wamid.
5. Ops pre-routing. Ops text keeps existing `resolveReply`; ops media is not ingested and receives deterministic text-only/ref guidance.
6. Customer `pendingHumanRequest` byte-identical short-circuit; no receipt action, transcript write, or LLM call.
7. Media ingestion kill-switch. Disabled images create no receipt/download/storage/backend action and enqueue the fixed unavailable-later reply.
8. Active receipt routing from the durable table: text goes to amount/confirmation/cancel; any second image is not reserved or queued and receives `ya tenemos tu comprobante en proceso; termínalo o cancela antes de enviar otro` (an `ATTACHING` row receives equivalent “still processing” guidance).
9. Supported image with no active row: capture current `placedSaleId` and reserve; if absent, no receipt row is created and the customer is told to place a sale first. PDF/other media gets unsupported-format guidance. A JPEG/PNG without a placed-sale receipt context gets receipt-only guidance semantically containing `solo puedo recibir comprobantes de pago`; no product-photo recognition occurs.
10. Ordinary text reaches idle check, `AgentRunner`, persisted transcript, and sender exactly as today.

Every durable receipt outbox row carries the immutable source inbound wamid and, when a receipt exists, its state version; post-200 worker sends are therefore causally tied to admitted inbound receipt work. Accepted media creates no amount-prompt intent until validation and private storage have succeeded. The notification worker executes only committed fixed-template rows and never invokes the LLM, chooses a new conversational action, or sends marketing/scheduled/unrelated content; an idle scheduler has nothing it is permitted to send. After `sendText` succeeds, the provider wamid is remembered for echo filtering and the outbox row becomes `SENT`. A crash after provider acceptance but before `SENT` can cause a duplicate byte-identical customer message because Meta exposes no outbound idempotency key; deterministic content, dedupe keys, state-version handling, and echo bookkeeping make replay duplicate-safe while delivery remains explicitly at least once. Generic text retains existing send-then-`markSeen` behavior.

## Backend attach semantics and manual reconciliation

Before the POST, the service verifies status, amount, captured sale, stored metadata, capability hash, and key version. A short CAS then changes `attach_attempts` from 0 to 1 and commits `attach_request_started_at` plus an attempt UUID. Only that CAS winner may invoke the client, and exactly one call is made. The call uses the receipt-specific Axios path with both bounded `CHATBOT_API_ATTACH_TIMEOUT_MS` and the lease worker's `AbortSignal`; lease loss and shutdown abort the underlying request. `Promise.race` is not an implementation option.

Classification is closed-world and conservative:

| Outcome                                                                                                                                           | Classification                                                  | Transition                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Contract-expected 2xx (currently HTTP 201) with a fully valid `{receiptId,status:'PENDING'}` projection                                           | Proven success                                                  | `ATTACHED` with backend receipt id.                                                  |
| HTTP `400`, `401`, `403`, `404`, `409`, `422`, or `429`, where the existing endpoint contract guarantees no receipt commit                        | Explicit known non-ambiguous allowlist; never retried           | `FAILED/ATTACH_DEFINITE`; auth/forbidden and rate-limit conditions alert operations. |
| HTTP `408`                                                                                                                                        | Commit cannot be excluded                                       | `ATTACH_OUTCOME_UNKNOWN`.                                                            |
| Any `5xx`                                                                                                                                         | Backend may have failed after commit                            | `ATTACH_OUTCOME_UNKNOWN`.                                                            |
| Axios timeout, caller abort/cancellation, DNS failure, socket reset, connection loss, or any network/transport error after request-start evidence | Commit cannot be excluded, including shutdown/lease-loss aborts | `ATTACH_OUTCOME_UNKNOWN`.                                                            |
| Expected 2xx with missing/malformed receipt id, wrong status, invalid body, or body parse failure                                                 | A commit may have occurred but success evidence is unusable     | `ATTACH_OUTCOME_UNKNOWN`.                                                            |
| Unexpected 1xx/2xx/3xx/4xx status outside the success set and definite allowlist                                                                  | Not proven non-committing                                       | `ATTACH_OUTCOME_UNKNOWN`.                                                            |
| Process/lease loss after request-start marker and before durable success                                                                          | Commit cannot be excluded                                       | Recovery changes to `ATTACH_OUTCOME_UNKNOWN`.                                        |
| Any classifier default not explicitly proven successful or non-committing                                                                         | Conservative default                                            | `ATTACH_OUTCOME_UNKNOWN`.                                                            |

There is no blind retry for any attach result. Adding a status to the definite allowlist requires contract evidence that the endpoint cannot have committed for that response; otherwise it remains unknown.

The unknown customer template says the receipt was received, payment confirmation is delayed, and staff will follow up; it never says payment succeeded. The runbook directs an authorized operator to: (1) locate the durable row by internal id/time without logging sender/token; (2) verify captured sale, amount, object metadata, capability hash/version, and attempt evidence; (3) use the existing backend tenant review queue/authorized operational query to search sale + amount + time and, if needed, open the deterministically reconstructed URL; (4) if one matching receipt exists, record `BACKEND_CONFIRMED`, backend receipt id, operator, and time and change the local row to `ATTACHED` by an audited reconciliation command; (5) if no receipt is found, record `BACKEND_NOT_FOUND` but do **not** replay the old POST—ask for a new deliberate sequential submission under policy; (6) leave uncertain cases `UNRESOLVED` and escalate. No backend database write or contract change is part of this repository.

## Configuration and dependencies

Enabled admission requires fail-fast typed validation of storage, Meta media allowlist/timeouts, public HTTPS base URL, exact 10 MiB limit, worker bounds, capability keyring, and `CHATBOT_API_ATTACH_TIMEOUT_MS`. The attach timeout must be positive, bounded by an operational maximum, and shorter than the worker lease-renewal safety window. Recommended variables are `RECEIPT_MEDIA_ENABLED` (default false), `RECEIPT_MEDIA_MAX_BYTES=10485760`, `META_MEDIA_ALLOWED_HOSTS`, metadata/download timeouts, `RECEIPT_STORAGE_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE`, `RECEIPT_MEDIA_PUBLIC_BASE_URL`, `RECEIPT_CAPABILITY_KEYS` (`version:base64` keyring), `RECEIPT_CAPABILITY_ACTIVE_VERSION`, `CHATBOT_API_ATTACH_TIMEOUT_MS`, worker concurrency/lease/poll settings, and metrics enablement. Secret values are never interpolated into validation errors. If disabled and no prior capability access is deployed, storage values may be absent; once URLs exist, rollback keeps storage/keyring/access configured and disables admission only.

The production seam is explicit: `ChatbotApiClient.attachReceipt` accepts caller transport options containing `signal`; `ChatbotApiHttpClient.attachReceipt` reads the typed timeout and forwards both `timeout` and `signal` in the same Axios request config. Tests may inject an adapter/transport, but production must not substitute a waiter-only timeout or omit the signal.

| New package                                                                      | Reason                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@aws-sdk/client-s3` (AWS SDK v3, lockfile-resolved CommonJS-compatible release) | Modular S3-compatible private put/get/head/delete with stream and abort support. |
| `ipaddr.js` plus its TypeScript types if required by the resolved release        | Correct IPv4/IPv6 global-address classification for SSRF defense.                |
| `prom-client`                                                                    | Counters, histograms, and gauges without putting identifiers into labels.        |

Existing Axios handles Meta and §4.4.7 HTTP and already supports `timeout`, `signal`, `proxy: false`, `maxRedirects: 0`, and custom agents; no timeout/abort package is added. Node `crypto`, `dns`, `fs`, `https`, and `stream` handle HMAC, pinning, temp files, and pipelines. Rejected additions are BullMQ/Redis, AWS SQS, `@aws-sdk/lib-storage`, `sharp`, `file-type`, Multer, a `Promise.race` timeout helper, and a second ORM.

## Observability and operations

Metrics contain no ids, sender, sale, object key, host URL, or token labels. Required signals are webhook admission latency/outcome, reservation conflicts, active-flow rejections, jobs by status and oldest age, claims/lease recoveries, Meta/storage **started** attempts by number and safe outcome category, exhausted-at-three counts, bytes accepted, validation failures, cleanup pending age, outbox backlog/replays/failures, attach outcomes including timeout/abort/lease-loss unknowns, unknown count/age, capability 2xx/404/5xx, and stream latency. Provider bucket metrics supply object count, stored bytes, growth rate, and incomplete multipart bytes.

Alerts: any new unknown outcome; attach 401/403; cleanup pending over 15 minutes; oldest job/outbox over 2 minutes; repeated lease recovery; webhook admission p95 over 1 second; elevated three-attempt failures; capability 5xx; and configured bucket growth/capacity thresholds. Storage alerts never trigger deletion.

Structured logs use receipt internal id only where operationally necessary and never log full sender/sale, caption, filename, capability path, key, Meta URL/token, storage credentials, or backend auth. Error codes are allowlisted before logging. The runbook must include owner acceptance checks for private policy, TLS/domain routing, capability-path redaction at proxy and APM, key backup/rotation, incomplete-multipart-only lifecycle, metrics/alerts, storage growth, worker recovery, graceful shutdown, and the reconciliation procedure above.

## Test strategy and requirement/capability mapping (24/87)

This is an honest requirement/capability-to-suite map, not scenario-level completion evidence. Implementation tasks and verification must maintain scenario-level evidence for all 87 approved scenarios (scenario identifier, owning test/assertion, and result); no individual scenario is considered linked merely because its capability appears in this table.

| Spec inventory       |                              Count | Planned owning suites / capability evidence                                                                                                                                                                                                     |
| -------------------- | ---------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app-config           |       3 requirements / 7 scenarios | `config` Joi/factory/boot suites plus runbook acceptance assertions; includes bounded attach-timeout validation and secret-safe failures.                                                                                                       |
| chatbot-api-client   |                              2 / 6 | `chatbot-api-http.client` unit/stub suites proving server-derived wire values, one non-retried POST, Axios timeout + `AbortSignal` propagation, underlying abort, and response projection.                                                      |
| conversation-store   |                              2 / 4 | Pointer helper/atomic JSONB patch suites, sibling-preservation interleavings, and Postgres restart recovery.                                                                                                                                    |
| llm-agent            |                              2 / 6 | Runner/registry suites proving active receipt bypass, protected-context absence, safe post-terminal guidance, and no notification-worker LLM dependency.                                                                                        |
| receipt-media        |                             6 / 26 | State-machine/migration-constraint suites, amount property tests, worker lease/CAS/fault matrices, independent pre-call Meta/storage counters, no-fourth-call assertions, cleanup injection, and Postgres concurrency.                          |
| receipt-media-access |                             4 / 12 | S3 port contracts; Meta transport fixtures asserting `proxy:false`, `maxRedirects:0`, manual redirect policy, DNS pinning, bearer-after-policy, and ambient-proxy isolation; GET/HEAD/header/hash/restart/rotation suites.                      |
| sale-flow-tools      |                             2 / 10 | Zod schema and prompt snapshots; compatibility tool cannot invoke the client or expose protected fields.                                                                                                                                        |
| whatsapp-webhook     |                             3 / 16 | Signed-request E2E, discriminated normalization, precedence call trace, TX1 early-200 atomicity, TX2 state+exact-intent atomicity, failed-commit no-send, restart drain, duplicate-safe at-least-once notification, and no proactive/LLM sends. |
| **Total**            | **24 requirements / 87 scenarios** | Scenario-level trace evidence is a tasks/verify deliverable, not claimed by this design table.                                                                                                                                                  |

Unit seams inject clock, sleep, DNS resolver, pinned HTTPS agent/transport, temp-file factory, S3 port, sender, API client, attach abort controller, and worker owner id. Testcontainers Postgres verifies partial uniqueness, exact failure-stage checks, accepted/pre-storage evidence predicates, `SKIP LOCKED`, expired lease recovery, CAS loser abort behavior, provider/webhook conflicts, TX1 reservation+causality atomicity, and TX2 receipt-transition+exact-outbox atomicity. Fault matrices cut the process before/after each durable transition and external call. They assert pre-call counter values 1/2/3, reschedule only after failures 1/2, terminalization after failure 3, and no fourth Meta or storage call.

Meta tests cover metadata as well as download hops, ambient proxy variables, redirect chains, private IPv4/IPv6, DNS rebinding pinning, bearer suppression before host/address validation, timeout, declared/response/magic disagreement, malformed JPEG/PNG, byte 10_485_761, and universal cleanup. Attachment tests cover the closed outcome matrix: valid expected 2xx success; each definite 4xx allowlist member; 408; every 5xx class; Axios timeout; network/DNS/socket error; worker shutdown abort; lease-loss abort; malformed expected success; unexpected 1xx/2xx/3xx/4xx; and classifier default. Each post-request-start non-definite outcome must persist `ATTACH_OUTCOME_UNKNOWN` with zero retry. Tests reject any `Promise.race`/waiter-only timeout implementation by asserting the stub transport's abort signal fires.

Outbox crash tests prove no send before TX2 commit, restart drain only of committed deterministic intents, no `AgentRunner`/LLM invocation, and byte-identical duplicate-safe replay after provider-acceptance/pre-`SENT` failure. Capability tests assert raw tokens/paths never reach captured logs. No real Meta, storage, backend, or secrets are required in unit tests. Staging acceptance uses a real private bucket and signed Meta webhook after owner provisioning.

## File-change forecast and review-sized work units

This is a forecast, not a task list. Each implementation review should remain below the 400 changed-line guard by splitting production code and its focused tests when needed.

| Work unit boundary                                   | Expected ownership                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additive migration and Postgres store primitives     | `migrations/`, receipt store adapter/contract only.                                                                                                   |
| Domain states, transitions, errors, ports            | `src/receipt-media/domain/**`.                                                                                                                        |
| Meta resolve/download, SSRF policy, stream validator | Meta adapter plus focused fixtures; JPEG and PNG validator reviews may be separate.                                                                   |
| S3 adapter and technical cleanup                     | Object-storage port/adapter tests.                                                                                                                    |
| Capability derivation and GET/HEAD                   | Capability service/controller and header/redaction tests.                                                                                             |
| Worker lease loop and outbox                         | Lifecycle provider, processor, notification dispatcher; attachment processing reviewed separately from ingestion if needed.                           |
| Webhook DTO and dispatcher precedence                | WhatsApp normalization/routing and admission tests only.                                                                                              |
| Amount grammar and active text routing               | Parser/router, pointer patch, deterministic templates.                                                                                                |
| Backend boundary and model authority repair          | Attachment service, empty tool schema, registry/prompt snapshots, production Axios timeout/AbortSignal seam, exhaustive classifier, and client tests. |
| Typed config, metrics, and operations runbook        | Config factory/Joi including attach-timeout bounds, telemetry, deployment documentation.                                                              |

## Rollout, rollback, and residual risks

Rollout order is: (1) merge with admission default off; (2) apply additive migration and validate exact failure/evidence checks; (3) owner provisions private bucket/credential, stable TLS domain, reverse-proxy redaction, keyring backup, multipart-abort rule, and monitoring; (4) deploy with access route and workers healthy but admission off; (5) staging drills cover signed-webhook TX1/TX2 crash boundaries, browser access, restart/outbox replay, ambient-proxy SSRF resistance, three-attempt exhaustion, and attach timeout/shutdown/lease-loss unknown outcomes; (6) enable production admission and watch acknowledgement, backlog, unknown, abort, outbox replay, cleanup, and storage metrics.

The kill-switch gates **new admission only**. Already reserved work drains and existing capability URLs remain served. Operational rollback sets admission false and restarts; text sales, cancellation, human handoff, and media access remain available. The migration is retained. A binary rollback to code without the capability route is unsafe after any URL is attached in the backend and must not be used; route/keyring compatibility is now a long-lived contract.

Residual accepted risks are bearer-by-possession URL leakage outside controlled logs/browser history, at-least-once outbound duplicate text in the provider-ack crash window, unbounded private storage growth, and the unavoidable ambiguous §4.4.7 commit window. The previously identified backend sale/tenant-isolation concern remains a backend-team escalation only. None is hidden by automatic retries or deletion.
