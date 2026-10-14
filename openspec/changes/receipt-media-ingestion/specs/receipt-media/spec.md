# Receipt Media Specification

## Purpose

Provide deterministic, durable receipt ingestion from signed WhatsApp JPEG/PNG messages through validation, private storage, amount confirmation, and backend PENDING attachment.

## Requirements

### Requirement: Reserve and correlate supported receipt media

The system MUST create a durable receipt record keyed uniquely by webhook message id and provider media id, capture the sender and current durable `placedSaleId` at acceptance, and never retarget that record when later conversation or sale state changes. A missing `placedSaleId` MUST make the media non-attachable and MUST not trigger arbitrary or historical sale selection.

#### Scenario: valid media is reserved against the current sale

- GIVEN sender S has durable `placedSaleId = sale-A` and sends a supported image
- WHEN the image is accepted
- THEN the record MUST snapshot sale-A before later processing.

#### Scenario: no placed sale is handled safely

- GIVEN sender S has no `placedSaleId`
- WHEN S sends a receipt image
- THEN it MUST not be attachable and the customer MUST receive a Spanish instruction to place a sale first.

#### Scenario: provider redelivery is idempotent

- GIVEN the same webhook message id and provider media id arrive twice
- WHEN both are processed
- THEN exactly one durable receipt reservation may exist and the second delivery MUST resume or return the existing outcome.

### Requirement: Validate JPEG and PNG media within limits

The system MUST accept only JPEG and PNG, enforce a maximum of 10 MB while streaming, and require declared MIME, downloaded Content-Type, and magic-byte detection to agree under the validation policy. It MUST reject missing or invalid declarations, unsupported types, malformed JPEG/PNG content, MIME mismatch, magic mismatch, oversized declarations or streams, stream failure, and object-upload failure. Every rejection category MUST abort or remove any incomplete in-memory buffer, object, or multipart artifact, MUST issue no retrieval capability, MUST not mark media stored, and MUST not call the backend attachment. This technical cleanup MUST NOT delete accepted customer media.

#### Scenario: valid JPEG and PNG pass

- GIVEN a well-formed JPEG or PNG no larger than 10 MB with agreeing metadata
- WHEN validation completes
- THEN the media MAY proceed to private storage.

#### Scenario: invalid MIME is rejected

- GIVEN declared MIME is `application/pdf`, `image/gif`, or another unsupported type
- WHEN validation runs
- THEN the media MUST be rejected before attachment and the customer MUST receive a Spanish explanation
- AND any incomplete buffer, object, or multipart artifact MUST be aborted or removed
- AND no capability may be issued and the media MUST NOT be marked stored.

#### Scenario: magic mismatch is rejected

- GIVEN declared MIME says JPEG but magic bytes identify PNG, PDF, or malformed data
- WHEN validation runs
- THEN the media MUST be rejected, incomplete technical upload artifacts MUST be aborted or removed, no capability may be exposed, and no backend attachment may occur.

#### Scenario: every declaration and format rejection cleans all partial state

- GIVEN the declaration is missing or invalid, the type is unsupported, the JPEG/PNG is malformed, or declared MIME, downloaded MIME, and magic bytes disagree
- WHEN validation rejects the media
- THEN any in-memory buffer, object, or multipart upload MUST be aborted or removed
- AND no capability MUST be issued, media MUST NOT be marked stored, and no capability MUST be granted.

#### Scenario: oversized stream rejection cleans all partial state

- GIVEN a stream exceeds 10 MB after ingestion has begun
- WHEN the size limit rejects it
- THEN reading MUST stop and every incomplete buffer, object, or multipart artifact MUST be aborted or removed
- AND no capability may be issued and the media MUST NOT be marked stored.

#### Scenario: stream or upload failure has no stored outcome

- GIVEN the download stream fails or object upload fails before completion
- WHEN ingestion handles the failure
- THEN every incomplete buffer, object, or multipart artifact MUST be aborted or removed
- AND no capability may be issued, no capability may be granted, the media MUST NOT be marked stored, and no backend attachment may occur.

#### Scenario: stream failure cleans technical artifacts

- GIVEN a supported receipt stream fails before the object is complete
- WHEN ingestion handles the failure
- THEN incomplete technical upload artifacts MUST be aborted or removed
- AND no capability may be issued, no capability may be exercised, the receipt MUST NOT be treated as stored, and no backend attachment may occur.

#### Scenario: object upload failure cleans technical artifacts

- GIVEN object storage fails while uploading a receipt
- WHEN ingestion handles the failure
- THEN incomplete technical upload artifacts MUST be aborted or removed
- AND no capability may be issued, no capability may be exercised, the receipt MUST NOT be treated as stored, and no backend attachment may occur.

#### Scenario: size limit is enforced

- GIVEN a media stream exceeds 10 MB or its declared size is over the limit
- WHEN bytes are read
- THEN ingestion MUST stop, incomplete technical upload artifacts MUST be aborted or removed, no capability MUST be exposed, the receipt MUST NOT be treated as stored, and no attachment may occur.

### Requirement: Receipt lifecycle is durable and resumable

The lifecycle MUST expose durable states equivalent to `RESERVED`, `DOWNLOADED`, `STORED`, `AWAITING_AMOUNT`, `AWAITING_CONFIRMATION`, `ATTACHING`, `ATTACHED`, definite terminal failure, and `ATTACH_OUTCOME_UNKNOWN`. Transient Meta metadata/download/storage failures MUST be retried no more than 3 attempts. Resume after restart MUST be idempotent and MUST not blind-retry an ambiguous backend attach.

#### Scenario: transient failure is capped

- GIVEN Meta download or private storage fails transiently
- WHEN retry processing occurs
- THEN at most three attempts may be made and a definite terminal outcome MUST follow if all fail.

#### Scenario: restart resumes a stored receipt

- GIVEN a record is durable at any resumable state when the process stops
- WHEN a fresh process resumes it
- THEN it MUST continue from that state without repeating completed side effects.

#### Scenario: unknown attachment outcome is escalated

- GIVEN §4.4.7 may have committed but the response is ambiguous
- WHEN the state is persisted
- THEN it MUST be `ATTACH_OUTCOME_UNKNOWN`, never automatically retried, and made available for manual reconciliation.

#### Scenario: unknown attachment outcome gives a safe customer outcome

- GIVEN the backend attachment outcome is ambiguous and the receipt enters `ATTACH_OUTCOME_UNKNOWN`
- WHEN the customer is notified
- THEN the bot MUST tell the customer the receipt was received, payment confirmation is delayed, and staff will follow up
- AND the bot MUST NOT claim that payment succeeded.

### Requirement: Enforce one active receipt flow per sender

A sender MUST have at most one active ingestion/amount flow. An image received during `AWAITING_AMOUNT` or `AWAITING_CONFIRMATION` MUST be rejected without ingestion, replacement, reservation, or queuing. A new image is allowed only after the prior flow reaches a terminal state and MUST create a separate record.

#### Scenario: overlapping image is rejected

- GIVEN S is awaiting amount or confirmation
- WHEN S sends another image
- THEN no media side effect may occur and the bot MUST ask S to finish or cancel first in Spanish.

#### Scenario: sequential receipt is separate

- GIVEN S's previous receipt is terminal
- WHEN S sends a new supported image
- THEN the new record MUST be independently trackable and the previous record MUST remain unchanged.

### Requirement: Amount confirmation controls attachment

The system MUST deterministically parse MXN amounts from an image caption or following customer message, normalize accepted formats to positive integer cents, present the normalized amount, and require explicit customer confirmation. Cancellation MUST prevent attachment and clear or terminate the active flow safely.

#### Scenario: caption amount is parsed

- GIVEN a caption contains a valid Mexican peso amount
- WHEN the receipt reaches amount collection
- THEN the normalized amount MUST be proposed for confirmation.
- AND `$1,234.50` MUST normalize to `123450` integer MXN cents.

#### Scenario: following message amount is parsed

- GIVEN the caption has no usable amount
- WHEN the next relevant customer message contains a valid amount
- THEN that amount MUST be proposed for confirmation.
- AND `1234` MUST normalize deterministically to `123400` integer MXN cents
- AND valid Spanish cents wording such as `mil doscientos treinta y cuatro pesos con cincuenta centavos` MUST normalize to `123450` integer MXN cents.

#### Scenario: invalid amount is not attached

- GIVEN amount text is ambiguous, malformed, zero, negative, or absent
- WHEN parsing runs
- THEN the bot MUST ask for a valid amount and no attachment may occur
- AND ambiguous separators, invalid Spanish number words, and unsupported formats MUST be rejected before explicit confirmation
- AND accepted values MUST be normalized deterministically to one positive integer number of MXN cents.

#### Scenario: explicit confirmation is required

- GIVEN an amount is awaiting confirmation
- WHEN the customer has not explicitly confirmed
- THEN §4.4.7 MUST not be called; after explicit confirmation it MAY be called once.

#### Scenario: cancellation stops the flow

- GIVEN a receipt is awaiting amount or confirmation
- WHEN the customer cancels
- THEN the flow MUST terminate without attachment and the customer MUST receive a Spanish cancellation outcome.

### Requirement: Preserve customer-media and operational governance

The system MUST not automatically delete attached or abandoned customer media. It MUST clean failed-validation buffers and technical partial uploads, including incomplete multipart uploads; such technical cleanup is mandatory, not optional. Operations MUST expose monitoring for unbounded storage growth and a manual governance path for abandoned records and `ATTACH_OUTCOME_UNKNOWN` cases; no automated retention period may be invented.

#### Scenario: attached evidence is retained

- GIVEN a receipt is attached as PENDING
- WHEN time passes or no review callback exists
- THEN the media and stable access record MUST remain available.

#### Scenario: abandoned media is retained for governance

- GIVEN a pre-attachment receipt is abandoned
- WHEN cleanup runs
- THEN customer content MUST not be automatically deleted and its record MUST remain queryable for manual governance.

#### Scenario: storage monitoring is actionable

- GIVEN storage usage or unknown outcomes grow
- WHEN operators inspect monitoring
- THEN metrics/alerts and manual reconciliation guidance MUST identify the condition without deleting customer media automatically
- AND the runbook MUST specify incomplete multipart cleanup rules and step-by-step manual reconciliation for `ATTACH_OUTCOME_UNKNOWN`.
