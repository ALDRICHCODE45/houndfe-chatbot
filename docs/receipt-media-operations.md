# Receipt Media Operations Runbook — WU15-2

This slice exposes an authenticated, in-memory telemetry foundation. It does
**not** activate ingestion, TX2, receipt attachment, or additional business
emitters. Local tests are not evidence of production deployment readiness.

## Before enabling metrics

1. Provision a dedicated `RECEIPT_MEDIA_METRICS_TOKEN` through your secret manager.
   Generate it from 32 cryptographically random bytes encoded as 64 ASCII hex
   characters. Never reuse Meta, service-API, or receipt-capability secrets.
2. Set `RECEIPT_MEDIA_METRICS_ENABLED=true` and inject the token at boot. Coordinate
   this with the scraper secret. Changes require a graceful restart; no live
   toggle or dual-token overlap is implemented.
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

| Condition                                                           | Result                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Metrics flag missing or false                                       | HTTP 404; guard stops before serialization                                                              |
| Metrics enabled, configured token missing or malformed              | Boot validation rejects configuration; no running endpoint is established                               |
| Any malformed configured token supplied, even with metrics disabled | Boot validation rejects configuration                                                                   |
| Running endpoint, missing/wrong request credentials                 | HTTP 401; no serialization                                                                              |
| Running endpoint, valid dedicated Bearer token                      | HTTP 200, Prometheus content type, `Cache-Control: no-store`                                            |
| Authenticated scrape whose registry serialization fails             | HTTP 503, fixed `metrics unavailable` body, `Cache-Control: no-store`; not a successful metrics payload |

Token format permits upper- and lowercase hexadecimal characters, but
**authentication compares the exact, case-sensitive secret bytes**. Do not
normalize token case. The Bearer scheme is case-insensitive. Send exactly one
`Authorization: Bearer …` header. Query-only and cookie-only credentials cannot
authenticate; duplicate, malformed, or inconsistent Authorization metadata is
denied.

The metrics flag is independent of `RECEIPT_MEDIA_ENABLED` (receipt admission).
Metrics can be enabled while admission is disabled, or disabled while admission
is enabled. Disabling admission also fail-closes **existing receipt capability
lookup** and leaves the notification drain inert. A mounted download route does
not mean existing downloads remain usable.

## Metric meanings: absence is not zero

The service owns an isolated Registry shared by its singleton telemetry provider.
It has no global/default process collectors. Scraping serializes in-memory state;
it does not query storage, the database, Meta, or the backend. The existing
notification drain may perform its own work independently of a scrape.

| Metric                                     | Meaning                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `receipt_media_metrics_enabled`            | Configuration gauge: metrics flag (1 or 0), **not** receipt admission or pipeline health. An enabled endpoint normally exposes 1. |
| `receipt_outbox_tx2_committed_total`       | Counter initialized only after recording a committed TX2 event                                                                    |
| `receipt_outbox_tx2_transition_lost_total` | Counter initialized only after recording a lost TX2 transition                                                                    |
| `receipt_outbox_tx2_failed_total`          | Counter initialized only after recording a failed TX2 event                                                                       |

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

This procedure does **not** rotate receipt capability keys. Capability rotation
is a separate operational change described below; neither rotation drill was
executed in this slice.

## Alerts and deferred operational drills

There is no new alert transport or TX2 alert threshold in this slice. The existing
notification drain emits this constant `Logger.error` message on exhaustion:

```text
receipt-media: notification intent exhausted after max attempts
```

It contains no row IDs, PII, or provider details. Exhaustion is not exposed as a
new business metric here. Do not infer TX2 health from scrape success or configure
healthy-zero alerts for the absent counters.

### Private bucket and capability-key rotation

- Verify private bucket access, public-access restrictions, and least-privilege
  permissions for the paths being deployed. Live storage access and policy drills
  remain unexercised; this document grants no new infrastructure permissions.
- When rotating `RECEIPT_CAPABILITY_KEYS` and `RECEIPT_CAPABILITY_ACTIVE_VERSION`,
  retain previous key versions and their original bytes for as long as existing
  receipts need reconstruction. Missing or changed keys make reconstruction fail
  closed. Changing the active version is **not** automatic revocation of old
  capabilities. Key removal requires a separately approved lifecycle/retention
  decision and validation of existing receipts.

### Storage growth and incomplete multipart uploads

Observe storage growth using separately approved infrastructure monitoring. No
new receipt/object expiry or deletion policy is introduced here. Do not interpret
`ATTACHED`, `CANCELLED`, `FAILED`, or an unknown attachment outcome as blanket
permission to delete evidence. Existing technical-delete guards are not a general
retention policy.

An incomplete-multipart abort rule is a **future, unexercised storage-policy
drill**: verify a safe window and that it affects only incomplete uploads, not
completed receipt objects. No lifecycle rule or cleanup command is applied here.

### Unknown attachment outcome: no repeat POST

`ATTACH_OUTCOME_UNKNOWN` concerns an **ambiguous backend receipt-attachment
outcome**, not an unknown WhatsApp media type. `ReceiptAttachmentService` makes
at most one POST for the durable attach attempt. A timeout or lost response can
leave the backend receipt created even though success was not recorded locally.

Do not automatically repeat the POST, reset the attempt to retryable, or delete
its evidence. After lease/fencing uncertainty, do not assume the backend did
nothing. Preserve the attempt and obtain human reconciliation against backend
receipt/audit evidence through approved access. Reconciliation tooling and the
production drill are deferred; this runbook authorizes no state repair or second
POST.

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
- `src/receipt-media/application/capability.service.ts` (`reconstruct`)
- `src/receipt-media/application/receipt-attachment.service.ts` (`attach`)
- `src/receipt-media/domain/object-storage.port.ts` (technical-delete boundary)
