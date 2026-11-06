# Receipt Media Operations Runbook — WU15-2

Receipt ingestion is always on (receipt payment flow R3/S7): the backend stores
the files, a human validates each receipt, and the bot relays the outcome. The
metrics endpoint is an authenticated, in-memory telemetry foundation; it does
not activate TX2 or additional business emitters. Local tests are not evidence
of production deployment readiness.

## Before serving metrics

1. Provision a dedicated `RECEIPT_MEDIA_METRICS_TOKEN` through your secret manager.
   Generate it from 32 cryptographically random bytes encoded as 64 ASCII hex
   characters. Never reuse Meta or service-API secrets.
2. Inject the token at boot; the endpoint is served exactly when
   `RECEIPT_MEDIA_METRICS_TOKEN` is configured (there is no separate enable
   flag). Coordinate this with the scraper secret. Changes require a graceful
   restart; no live toggle or dual-token overlap is implemented.
3. Require HTTPS with certificate verification and restrict the endpoint to the
   scraper using firewall, VPN, or proxy policy. `/internal` is only a path name,
   not a private-network boundary. Prevent direct public access to the app port.
4. Redact Authorization in application/proxy/APM logs and traces. Do not put
   credentials in URLs, cookies, shell arguments/history, Git, or CI output.
5. Verify the Prometheus target and the response behavior below in an approved
   environment. These infrastructure and secret-handling checks have not been
   exercised against production in this slice.

## Endpoint and configuration behavior

Route: `GET /internal/receipt-media/metrics`.

| Condition                                               | Result                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `RECEIPT_MEDIA_METRICS_TOKEN` absent                    | HTTP 404; guard stops before serialization                                                              |
| Malformed `RECEIPT_MEDIA_METRICS_TOKEN` supplied        | Boot validation rejects configuration; no running endpoint is established                               |
| Running endpoint, missing/wrong request credentials     | HTTP 401; no serialization                                                                              |
| Running endpoint, valid dedicated Bearer token          | HTTP 200, Prometheus content type, `Cache-Control: no-store`                                            |
| Authenticated scrape whose registry serialization fails | HTTP 503, fixed `metrics unavailable` body, `Cache-Control: no-store`; not a successful metrics payload |

Token format permits upper- and lowercase hexadecimal characters, but
**authentication compares the exact, case-sensitive secret bytes**. Do not
normalize token case. The Bearer scheme is case-insensitive. Send exactly one
`Authorization: Bearer …` header. Query-only and cookie-only credentials cannot
authenticate; duplicate, malformed, or inconsistent Authorization metadata is
denied.

Receipt ingestion is always on (receipt payment flow R3/S7); the metrics token
only decides whether the metrics endpoint is served.

## Metric meanings: absence is not zero

The service owns an isolated Registry shared by its singleton telemetry provider.
It has no global/default process collectors. Scraping serializes in-memory state;
it does not query storage, the database, Meta, or the backend. The existing
notification drain may perform its own work independently of a scrape.

| Metric                                     | Meaning                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `receipt_media_metrics_enabled`            | Configuration gauge: metrics token configured (1 or 0), **not** receipt admission or pipeline health. A served endpoint exposes 1. |
| `receipt_outbox_tx2_committed_total`       | Counter initialized only after recording a committed TX2 event                                                                     |
| `receipt_outbox_tx2_transition_lost_total` | Counter initialized only after recording a lost TX2 transition                                                                     |
| `receipt_outbox_tx2_failed_total`          | Counter initialized only after recording a failed TX2 event                                                                        |

The three TX2 emitters remain unwired in the current production composition.
Their counters are therefore **absent**, not preinitialized healthy zeros. A
missing series is not evidence of successful processing, and the configuration
gauge does not prove end-to-end health. Counters are process-local and reset on
restart; they are not a transaction audit trail.

Only fixed event names and allowlisted `templateKey` values can become metric
dimensions. No IDs, PII, media URLs, filenames, captions, credentials, or arbitrary
error text belong in labels. Disabled recording is a no-op; recording failures
must not disrupt the business flow.

## Secure scrape example

This is a template, not deployed configuration. Replace the reserved example
hostname with the approved TLS endpoint and mount the token through your secret
manager into the Prometheus process/container.

```yaml
# @ts-check
scrape_configs:
  - job_name: 'houndfe-chatbot-receipt-media'
    scheme: https
    metrics_path: '/internal/receipt-media/metrics'
    authorization:
      type: Bearer
      credentials_file: '/run/secrets/receipt-media-metrics-token'
    static_configs:
      - targets: ['chatbot.example.invalid:443']
```

The credentials file contains only the dedicated token and must be readable only
by the scraper identity/necessary secret-management identities, not world-readable.
Never inline its value into configuration or a command. Preserve TLS certificate
and hostname verification; for a private CA, install the approved trust material.
Do not enable `insecure_skip_verify`. Network restrictions and proxy log redaction
are separate requirements, not properties of this YAML.

## Scrape-token rotation

1. Generate and store a new dedicated token using the approved secret-management
   workflow without logging it.
2. Coordinate replacement of the app environment secret and the scraper's
   credentials file. Gracefully restart the app and reload/restart the scraper
   as required by its deployment. A brief mismatch can produce 401 responses;
   there is no dual-token grace period.
3. Verify the target with its protected configuration (for example, target status
   in the Prometheus UI), not a secret-bearing curl command. Confirm the new token
   works and the old token no longer authenticates without exposing either value.
4. Retire the old scraper secret only after the coordinated switch is verified.

This rotation drill was not executed in this slice.

## Alerts and deferred operational drills

There is no new alert transport or TX2 alert threshold in this slice. The existing
notification drain emits this constant `Logger.error` message on exhaustion:

```text
receipt-media: notification intent exhausted after max attempts
```

It contains no row IDs, PII, or provider details. Exhaustion is not exposed as a
new business metric here. Do not infer TX2 health from scrape success or configure
healthy-zero alerts for the absent counters.

### Configuration (always on)

Receipt ingestion has no feature flag: the backend stores receipt files in
DigitalOcean (receipt-payment-flow S2), so the chatbot owns no bucket, public
base URL or capability-signed URL. The removed variables `RECEIPT_MEDIA_ENABLED`,
`RECEIPT_MEDIA_INGESTION_ENABLED`, `RECEIPT_STORAGE_*`, `RECEIPT_CAPABILITY_*`,
`RECEIPT_MEDIA_PUBLIC_BASE_URL` and `CHATBOT_API_ATTACH_TIMEOUT_MS` have no
effect. The remaining knobs all have defaults:

| Variable                           | Default                     |
| ---------------------------------- | --------------------------- |
| `META_MEDIA_ALLOWED_HOSTS`         | `lookaside.fbsbx.com`       |
| `META_MEDIA_METADATA_TIMEOUT_MS`   | 10000 (< 60000)             |
| `META_MEDIA_DOWNLOAD_TIMEOUT_MS`   | 30000 (< 60000, ≥ metadata) |
| `RECEIPT_MEDIA_WORKER_CONCURRENCY` | 2 (1–8)                     |
| `RECEIPT_MEDIA_WORKER_LEASE_MS`    | 60000 (fixed)               |
| `RECEIPT_MEDIA_WORKER_POLL_MS`     | 5000 (< 60000)              |
| `RECEIPT_MEDIA_MAX_BYTES`          | 10485760 (fixed)            |

The service credential needs `sales:write` (upload) and `sales:read`
(outcome); `sales:write` alone answers 403 on the outcome read.

### Backend upload and unknown outcome (R2)

The backend stores receipt files (receipt-payment-flow S2). The worker
downloads the WhatsApp media, reads it with the vision pre-fill, and uploads it
as multipart to `POST /chatbot-api/sales/:saleId/receipts` with
`X-Idempotency-Key` = the WhatsApp media id (contract:
`docs/contracts/transfer-receipts.md`). The upload has a 90 s HTTP timeout and
the worker renews its 60 s lease while it runs.

| Backend answer                                                                                                                                   | Durable result                                                                  | Customer message                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 201                                                                                                                                              | `ATTACHED`                                                                      | received + in review, with the folio (and the amount mismatch sentence) |
| 409 `SALE_ALREADY_PAID`                                                                                                                          | `FAILED` / `ATTACH_DEFINITE`                                                    | the order is already paid                                               |
| 409 `SALE_NOT_PAYABLE`                                                                                                                           | `FAILED` / `ATTACH_DEFINITE`                                                    | the order no longer accepts payments                                    |
| 413 / 415                                                                                                                                        | `FAILED` / `ATTACH_DEFINITE`                                                    | send a JPEG, PNG or PDF under 10 MB                                     |
| other 400/404/409/422                                                                                                                            | `FAILED` / `ATTACH_DEFINITE`                                                    | generic "write to us"                                                   |
| timeout, network, 5xx (incl. 502 `RECEIPT_STORAGE_FAILED`), invalid 201, 429 (rate limit), 401/403 (credential or scope, fixable by an operator) | stays `DOWNLOADED`, retried                                                     | "registering" message, once                                             |
| 201 whose `receiptId` is not a UUID                                                                                                              | `ATTACH_OUTCOME_UNKNOWN` (`RECEIPT_ID_INVALID`), terminal, logged by shape only | "registering" message, once                                             |

An unknown outcome is safe to retry because the key is the media id: the
backend returns the same receipt for the same key and file. The first attempt
stores its exact declared/extracted fields (`upload_fields`, migration 3600)
and every retry sends them again without running the vision extraction, so one
key never carries different fields. A persistent 401/403 exhausts the attempts
like any unknown outcome: fix the credential, then reconcile the
`ATTACH_OUTCOME_UNKNOWN` rows. The store schedules
up to 6 attempts (backoff 30 s, 2, 5, 10, 15 min, about 32 min in total) and
then sets `ATTACH_OUTCOME_UNKNOWN`. Such a row may still exist in the backend;
reconcile it against the backend before any manual action.

A file that must not be uploaded ends `FAILED` without any backend call:
`NOT_A_RECEIPT` (the vision says it is not a payment receipt) or
`PDF_ENCRYPTED` (asks for a screenshot).

### Human outcome (R5)

A human always confirms or rejects the receipt in the backend (S1); the bot
only relays the result. The outcome poller (boot + every 60 s, 20 receipts per
tick; a receipt attached more than 1 h ago is read every 15 min) reads
`GET /chatbot-api/receipts/:receiptId` for every `ATTACHED` row without a
recorded outcome. There is no time horizon and a restart resumes from the table.

| Backend outcome              | Customer message (Spanish, usted)                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PENDING` (or a failed read) | none; read again later                                                                                 |
| `CONFIRMED`, `debtCents = 0` | "¡Listo! Confirmamos su pago del pedido {folio}. Gracias por su compra."                               |
| `CONFIRMED`, `debtCents > 0` | "Confirmamos un pago de su pedido {folio}. Queda un saldo pendiente de $1,500.00 MXN; …"               |
| `REJECTED`                   | "No pudimos confirmar su comprobante del pedido {folio}: {reason}. ¿Me puede enviar otro comprobante?" |

The outcome, reason, remaining debt and notification are recorded once, in the
same transaction that queues the message on the receipt outbox (sent by the
notification drain). Outside the 24 h WhatsApp customer window a free-text
message cannot be sent: the outcome is recorded as `OUTSIDE_WINDOW`, nothing
is sent and nothing loops (a Meta template for this case is a leftover).

A queued outcome message can wait in the outbox (retries, a busy drain), so
the notification drain checks the window again right before sending, using the
same inbound-observation evidence. If the window is confirmed closed, nothing
is sent: the outbox row becomes `FAILED` (terminal, no retry, no exhaustion
alert) and the receipt's `outcome_delivery` flips from `QUEUED` to
`OUTSIDE_WINDOW`, in one transaction. If the window read itself fails, the
intent is rescheduled like a failed send, within the same three-attempt cap.

### Claim eligibility

| Status                                   | claimBatch eligible | Notes                                                 |
| ---------------------------------------- | ------------------- | ----------------------------------------------------- |
| RESERVED                                 | ✅                  | Download, extraction and backend upload               |
| DOWNLOADED                               | ✅                  | Same-key backend upload retry                         |
| ATTACHED, FAILED, ATTACH_OUTCOME_UNKNOWN | ❌                  | Terminal; ATTACHED is read by the outcome poller only |

## Evidence boundary and references

Local tests cover dedicated authentication, HTTP 404/401/200/503, registry
isolation, lazy counters, and preserved notification lifecycle with fake external
boundaries. They do not validate production TLS/network controls, secret rotation,
storage policy, incident response, or full historical WU15 telemetry coverage.
Ingestion/TX2 composition and extra business emitters remain deferred.

Relevant implementation references:

- `src/receipt-media/infrastructure/prometheus-receipt-telemetry.ts`
- `src/receipt-media/presentation/receipt-metrics-auth.guard.ts`
- `src/receipt-media/presentation/receipt-metrics.controller.ts`
- `src/receipt-media/application/receipt-attachment.service.ts` (`upload`)
- `src/receipt-media/application/receipt-outcome.poller.ts` (R5 outcome)
