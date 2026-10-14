# Delta for Chatbot API Client

## MODIFIED Requirements

### Requirement: Map backend responses and retries

The system MUST expose typed methods for the documented endpoints and MUST map
backend `401`, `403`, `404`, `429`, and `5xx` responses to typed errors.
Idempotent GETs SHOULD retry with backoff on transient failures; `429` responses
MUST honor `Retry-After`; `POST/PUT/PATCH` requests MUST NOT blind retry.

The client MUST populate `ChatbotApiError.errorCode: string | null` from the
backend envelope's `responseBody.error` value for every mapped response that
returns a JSON body. `errorCode` MUST be `null` when the body is absent, when
the body is not JSON, or when the body has no `error` field.

The typed method surface MUST include `cancelSale(saleId, dto)`. The cancel call
MUST NOT send an `X-Idempotency-Key` header — the backend derives
`sale:cancel:<saleId>` (differs from `createSale`, which mints a client UUID v4).
The cancel error codes `SALE_NOT_FOUND` (404), `SALE_NOT_CANCELLABLE` (409),
`SALE_DELIVERED_CANNOT_CANCEL` (409), `IDEMPOTENCY_KEY_CONFLICT` (409), and
`IDEMPOTENCY_KEY_IN_FLIGHT` (409) MUST be discoverable from
`ChatbotApiError.errorCode` so the tool-layer error-mapping can branch on them
without parsing message strings. A sale already `CANCELED` MUST resolve as a 200
replay success, never as an error. The transport-level fallback (`UpstreamError`
for network failures without a status) MUST continue to apply.

(Previously: the typed method surface ended at `getPaymentDetails`; no cancel
mapping; `createSale` was the only POST with an idempotency contract and it used
a client-minted UUID v4 header.)

#### Scenario: Transient GET is retried

- GIVEN a `GET /chatbot-api/customers/by-phone` call (§4.4.4) receives a transient
  5xx
- WHEN the client retries with backoff
- THEN the request succeeds without changing caller-visible data.

#### Scenario: POST rate limit is surfaced

- GIVEN `POST /chatbot-api/sales` (§4.4.6) returns HTTP 429 with `Retry-After`
- WHEN the client receives the response
- THEN it returns a typed rate-limit error and does not blindly retry
- AND the returned `ChatbotApiError.errorCode` field MUST equal `null` (the body
  for rate-limit responses does not carry an `error` envelope field).

#### Scenario: cancelSale sends no client idempotency key

- GIVEN a `ChatbotApiHttpClient` stub server that records request headers
- WHEN
  `client.cancelSale('sale-1', { reason: 'CUSTOMER_REQUEST', cashierUserId: '<uuid>' })`
  is invoked
- THEN the recorded request MUST NOT contain an `X-Idempotency-Key` header
  (idempotency is backend-derived from `sale:cancel:<saleId>`).

#### Scenario: cancel error codes are discoverable via errorCode passthrough

- GIVEN the stub server returns `409` with body
  `{ statusCode: 409, error: 'SALE_DELIVERED_CANNOT_CANCEL', message: 'Sale already delivered' }`
- WHEN `client.cancelSale('sale-1', input)` rejects
- THEN the thrown `ChatbotApiError` MUST carry `statusCode: 409` and
  `errorCode: 'SALE_DELIVERED_CANNOT_CANCEL'`
- AND the tool layer MUST map it to `kind: 'saleNotCancellable'` (errorCode-first,
  before the status branch).

## ADDED Requirements

### Requirement: Client never accepts model-owned sale or source metadata

The attachment call boundary MUST accept only application-derived sale association and stable media URL; model-facing tool context MUST not be a source for either value.

#### Scenario: application-derived values reach the wire

- GIVEN a receipt record captured sale-A and stable URL U
- WHEN attachment is requested
- THEN only sale-A and U may be serialized, regardless of attempted model tool fields.

#### Scenario: already-canceled sale resolves as a 200 replay success

- GIVEN the backend returns `200` with `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [], canceledAt: '2026-08-24T10:00:00.000Z' }`
- WHEN `client.cancelSale('sale-1', input)` is invoked
- THEN it MUST resolve with status `CANCELED` and raise no error.
