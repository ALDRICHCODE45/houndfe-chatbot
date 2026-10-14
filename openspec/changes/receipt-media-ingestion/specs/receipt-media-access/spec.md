# Receipt Media Access and Private Storage Specification

## Purpose

Store receipt objects privately and expose stable, bearer-by-possession access that works in a plain browser without public buckets or custom authorization headers.

## Requirements

### Requirement: Private provider-neutral object storage

Receipt media MUST be stored through a provider-neutral port backed by private S3-compatible storage. Objects MUST use random non-PII keys and MUST NOT be publicly readable. Storage credentials, object keys, and provider URLs MUST not enter model context or normal application logs.

#### Scenario: private storage is used

- GIVEN a validated receipt
- WHEN it is stored
- THEN the object MUST be written through the storage port to a private location and no public bucket/object URL may be used.

#### Scenario: object key has no customer data

- GIVEN a receipt from a sender, sale, and filename
- WHEN an object key is generated
- THEN it MUST be random and MUST contain none of sender id, sale id, filename, amount, or capability token.

### Requirement: Stable opaque capability access works in a browser

The system MUST issue a stable high-entropy capability URL served by the chatbot. The raw bearer token MUST be stored only as a hash, MUST be redacted from application and proxy logs, and MUST be usable by a plain browser GET/HEAD without custom auth headers or cookies. Lookup MUST authorize only the matching stored capability and stream the private object.

#### Scenario: capability lookup succeeds

- GIVEN a valid capability URL for an attached receipt
- WHEN a browser performs GET or HEAD without custom headers
- THEN the chatbot MUST stream or describe the corresponding object with stable access and MUST not expose storage credentials.

#### Scenario: invalid capability is denied

- GIVEN a missing, altered, expired-by-revocation, or unknown capability token
- WHEN the URL is requested
- THEN access MUST be denied without revealing whether other receipt records exist.

#### Scenario: token hygiene is enforced

- GIVEN a capability URL is used in an application or reverse-proxy request
- WHEN logs are emitted
- THEN the raw token, full capability URL, object key, Meta bearer token, and temporary Meta URL MUST not appear at normal log levels.

#### Scenario: HEAD metadata denials are indistinguishable

- GIVEN a malformed, unknown, altered, or revoked capability token, or a private object that is missing
- WHEN HEAD is requested
- THEN the chatbot MUST return one identical empty 404 with the safe response headers and MUST NOT contact private storage for a denial.

#### Scenario: unknown-token comparison timing stays uniform

- GIVEN a well-formed capability token that matches no stored row
- WHEN access is evaluated
- THEN a timing-safe comparison against the fixed dummy hash MUST run before the row-existence decision, and the resulting denial MUST be indistinguishable from the other denials.

#### Scenario: authorized Range receives 416 without storage

- GIVEN an authorized capability token
- WHEN HEAD is requested with a Range header
- THEN the chatbot MUST return 416 with the safe response headers without any storage call, while an unauthorized Range still receives the denial 404.

#### Scenario: transient failures are a distinct 503, never a false denial

- GIVEN a database lookup failure or a private storage failure other than a missing object
- WHEN HEAD is requested
- THEN the chatbot MUST return one empty 503 with a fixed `Retry-After: 5` (seconds) and no provider, token, or object detail, and MUST NOT retry the failure server-side or return a false 404 denial.

#### Scenario: client disconnect suppresses later work

- GIVEN a client disconnects while a capability lookup or storage metadata read is in flight
- WHEN the pending operation settles
- THEN the in-flight storage read MUST be aborted through its exact abort signal and a disconnect during the database lookup MUST produce no later storage call or response.

#### Scenario: future GET stream failure after headers

- GIVEN a future GET streams the object and the stream fails after response headers were sent
- WHEN the failure occurs
- THEN the connection MUST be terminated and the outcome MUST be recorded separately, never as a false 5xx status.

### Requirement: Safe response headers are returned

Receipt access MUST return detected `Content-Type`, `X-Content-Type-Options: nosniff`, a restrictive content security policy, and safe `Content-Disposition`; GET and HEAD behavior MUST be consistent. The route MUST not expose private storage details.

#### Scenario: media headers are safe

- GIVEN a valid JPEG or PNG capability request
- WHEN the response is returned
- THEN it MUST contain correct detected content type, `nosniff`, restrictive CSP, and safe disposition headers.

### Requirement: Metadata and redirect validation prevent SSRF

The Meta media client MUST accept provider media ids rather than customer/model URLs, use authenticated metadata/download requests, require HTTPS, enforce an allowlisted expected Meta download host/origin policy, revalidate every redirect target, and apply bounded timeouts and streaming limits. Any invalid origin, redirect, MIME, magic bytes, or size MUST fail safely.

#### Scenario: trusted Meta metadata is downloaded

- GIVEN a provider media id resolves to an HTTPS URL on an allowed Meta host
- WHEN metadata and binary content are fetched
- THEN the client MUST authenticate the provider request and stream within configured bounds.

#### Scenario: redirect to an untrusted host is rejected

- GIVEN Meta returns a redirect to HTTP, a private address, or an unallowlisted host
- WHEN the client follows the redirect
- THEN it MUST reject the download before fetching the untrusted target.

#### Scenario: customer URL is never fetched

- GIVEN a customer or model supplies an arbitrary URL
- WHEN receipt ingestion runs
- THEN the Meta client MUST ignore/reject it and fetch only the URL resolved from the provider media id.

#### Scenario: invalid metadata origin receives universal technical cleanup

- GIVEN metadata resolution returns an invalid origin
- WHEN receipt ingestion rejects the metadata
- THEN it MUST abort or remove any incomplete buffer, object, or multipart artifact
- AND it MUST issue no capability, MUST NOT mark the media stored, and MUST NOT call the backend
- AND if rejection occurs before artifact creation, no artifact MUST be created; if partial state exists, it MUST be removed.

#### Scenario: invalid download origin receives universal technical cleanup

- GIVEN a resolved download has an invalid origin
- WHEN the download is rejected
- THEN it MUST abort or remove any incomplete buffer, object, or multipart artifact
- AND it MUST issue no capability, MUST NOT mark the media stored, and MUST NOT call the backend
- AND if rejection occurs before artifact creation, no artifact MUST be created; if partial state exists, it MUST be removed.

#### Scenario: invalid redirect receives universal technical cleanup

- GIVEN a Meta download redirect targets an invalid origin
- WHEN redirect validation rejects the target
- THEN it MUST abort or remove any incomplete buffer, object, or multipart artifact
- AND it MUST issue no capability, MUST NOT mark the media stored, and MUST NOT call the backend
- AND if rejection occurs before artifact creation, no artifact MUST be created; if partial state exists, it MUST be removed.
