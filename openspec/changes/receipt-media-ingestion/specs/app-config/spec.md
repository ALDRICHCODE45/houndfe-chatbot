# Delta for App Config

## ADDED Requirements

### Requirement: Receipt media configuration fails fast and is typed

The application MUST validate receipt-media configuration at boot before accepting webhook traffic. Required enabled-mode values MUST include private object-storage endpoint/bucket/region/credentials, the stable chatbot media base URL, and media limits including a 10 MB maximum. The resolved config MUST not expose secrets to logs or model context.

#### Scenario: missing storage configuration blocks boot

- GIVEN receipt ingestion is enabled and a required storage or stable-base-URL setting is missing or malformed
- WHEN the application starts
- THEN boot MUST fail with a clear configuration error and bind no HTTP port.

#### Scenario: valid private storage configuration boots

- GIVEN all required storage, access, URL, and limit settings are valid
- WHEN the application starts
- THEN typed receipt-media configuration MUST be available to the owning services and no secret value may be logged.

### Requirement: Receipt ingestion has a kill-switch

The application MUST expose a configuration kill-switch that disables receipt ingestion without disabling text sales, cancellation, or existing human-handoff routing. Disabled media MUST receive a deterministic Spanish unavailable-later outcome and MUST not reserve, download, store, or attach media.

#### Scenario: kill-switch disables media only

- GIVEN receipt ingestion is disabled
- WHEN a customer sends an image
- THEN no media side effect or backend attachment may occur
- AND the customer MUST be told in Spanish that receipts cannot be received now and to try later
- AND text behavior MUST remain available.

#### Scenario: restart re-enables media

- GIVEN the kill-switch was disabled on one boot
- WHEN an operator enables it and restarts with valid configuration
- THEN supported receipt ingestion MUST be available without code changes.

### Requirement: Chatbot delivers the receipt operations runbook

The chatbot deliverable MUST include a provisioning and operations runbook. The owner, not the chatbot runtime, MUST provision the private bucket, provider endpoint, region, credentials, stable media domain, TLS termination, and reverse-proxy capability-path log redaction before enabling receipt ingestion. The runbook MUST define incomplete multipart-upload lifecycle rules (abort/expire incomplete uploads only), storage monitoring, the no-auto-deletion consequence for accepted and abandoned customer media, and step-by-step manual reconciliation for `ATTACH_OUTCOME_UNKNOWN`. The runbook MUST include reviewable acceptance criteria for each of these duties and MUST not define automatic customer-media deletion.

#### Scenario: owner provisions required operational dependencies

- GIVEN the receipt feature is approved for an environment
- WHEN the owner follows the delivered runbook
- THEN the owner MUST provision the bucket, provider endpoint, region, credentials, domain and TLS, reverse-proxy capability-path log redaction, and environment secrets before enabling ingestion
- AND the owner MUST configure incomplete multipart uploads to be aborted/expired while retaining customer media
- AND the chatbot MUST not claim those resources are provisioned merely because its configuration validates.

#### Scenario: runbook protects operational secrets

- GIVEN the delivered runbook is reviewed by an operator
- WHEN its configuration and logging guidance is applied
- THEN provider credentials and environment secrets MUST remain outside model context and normal logs
- AND stable capability URLs, bearer tokens, and object keys MUST be redacted from proxy and application logs.

#### Scenario: runbook gives monitoring and reconciliation steps

- GIVEN a reviewer checks the delivered operations runbook
- WHEN storage grows or a receipt is `ATTACH_OUTCOME_UNKNOWN`
- THEN the runbook MUST identify storage-size/object-count alerts and explain that accepted and abandoned customer media are not auto-deleted
- AND it MUST provide ordered steps to locate the durable record, verify the captured sale and capability/object state, query the backend receipt outcome without blindly retrying, record the disposition, and escalate unresolved cases
- AND it MUST state that incomplete multipart artifacts are the only upload-lifecycle cleanup target.
