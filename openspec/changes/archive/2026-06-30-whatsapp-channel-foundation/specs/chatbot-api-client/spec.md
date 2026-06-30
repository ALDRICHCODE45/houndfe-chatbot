# Delta for chatbot-api-client

## ADDED Requirements

### Requirement: Apply single-branch auth headers

The system MUST call backend `chatbot-api` endpoints from AGENTS.md §4.4.1–4.4.9 using `Authorization: Bearer svc_<key>` and a fixed `X-Branch-Id` for the configured branch.
The client MUST remain single-branch only.

#### Scenario: Read request uses configured headers

- GIVEN a client configured with one service key and one branch id
- WHEN it calls a read endpoint such as `GET /chatbot-api/catalog/search` (§4.4.1)
- THEN the request includes the bearer token and branch header

#### Scenario: Branch mismatch is not allowed

- GIVEN a request would target a different branch context
- WHEN the client is used
- THEN the request is rejected before sending

### Requirement: Map backend responses and retries

The system MUST expose typed methods for the documented endpoints and MUST map backend `401`, `403`, `404`, `429`, and `5xx` responses to typed errors.
Idempotent GETs SHOULD retry with backoff on transient failures; `429` responses MUST honor `Retry-After`; POST/PUT/PATCH requests MUST NOT blind retry.

#### Scenario: Transient GET is retried

- GIVEN a `GET /chatbot-api/customers/by-phone` call (§4.4.4) receives a transient 5xx
- WHEN the client retries with backoff
- THEN the request succeeds without changing caller-visible data

#### Scenario: POST rate limit is surfaced

- GIVEN `POST /chatbot-api/sales` (§4.4.6) returns HTTP 429 with `Retry-After`
- WHEN the client receives the response
- THEN it returns a typed rate-limit error and does not blindly retry
