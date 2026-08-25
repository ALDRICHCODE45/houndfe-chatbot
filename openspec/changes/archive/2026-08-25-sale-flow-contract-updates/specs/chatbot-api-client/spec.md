# chatbot-api-client Spec

## Purpose

Provide a typed HTTP client that consumes the HoundFe backend `chatbot-api`
endpoints documented in AGENTS.md §4.4.1–4.4.10. The client MUST inject
single-branch auth headers (`Authorization: Bearer svc_<key>` + `X-Branch-Id`)
and MUST refuse to send if the request would target a different branch.
Transient idempotent GETs SHOULD retry with exponential backoff; `429`
responses MUST honor `Retry-After`; `POST/PUT/PATCH` requests MUST NOT blind
retry. Backend status codes MUST be mapped to typed errors so callers do not
branch on raw HTTP status. `ChatbotApiError` MUST carry an `errorCode: string |
null` populated from the backend envelope's `responseBody.error` so tool-layer
callers can discriminate the five new envelope codes (`PROMO_RE_QUOTE`,
`IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_IN_FLIGHT`,
`INVALID_IDEMPOTENCY_KEY`, `NO_ACTIVE_PAYMENT_DETAIL`) without parsing message
strings.

## Requirements

### Requirement: Apply single-branch auth headers

The system MUST call backend `chatbot-api` endpoints from AGENTS.md §4.4.1–4.4.10
using `Authorization: Bearer svc_<key>` and a fixed `X-Branch-Id` for the
configured branch.
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

The system MUST expose typed methods for the documented endpoints and MUST map
backend `401`, `403`, `404`, `429`, and `5xx` responses to typed errors.
Idempotent GETs SHOULD retry with backoff on transient failures; `429` responses
MUST honor `Retry-After`; `POST/PUT/PATCH` requests MUST NOT blind retry.

The client MUST populate `ChatbotApiError.errorCode: string | null` from the
backend envelope's `responseBody.error` value for every mapped response that
returns a JSON body. `errorCode` MUST be `null` when the body is absent, when
the body is not JSON, or when the body has no `error` field.

The four new chatbot-api error envelope codes (`PROMO_RE_QUOTE`,
`IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_IN_FLIGHT`,
`INVALID_IDEMPOTENCY_KEY`) — plus the `NO_ACTIVE_PAYMENT_DETAIL` 404 from
`GET /chatbot-api/payment-details` — MUST be discoverable from
`ChatbotApiError.errorCode` so the tool-layer error-mapping can branch on them
without parsing message strings. The transport-level fallback (`UpstreamError`
for network failures without a status) MUST continue to apply.

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

### Requirement: getPaymentDetails returns the active PaymentDetail projection

`ChatbotApiClient` MUST expose `getPaymentDetails(): Promise<PaymentDetail>`. The
HTTP implementation MUST issue `GET /chatbot-api/payment-details` with no query
string, no path parameters, and no request body, applying the standard
single-branch auth headers (`Authorization: Bearer svc_<key>` + `X-Branch-Id`) per
the `chatbot-api-client` auth contract. The tool scope on the credential
(`payment-details:read`) covers the call server-side; the bot does not assert the
scope locally.

On HTTP 200, the response body MUST be deserialized into a `PaymentDetail`
projection `{ id, bankName, beneficiary, clabe, accountNumber, isActive,
updatedAt }`.

On 404 with body `error: 'NO_ACTIVE_PAYMENT_DETAIL'`, the client MUST throw a
`ChatbotApiError` with `statusCode: 404`, `errorCode: 'NO_ACTIVE_PAYMENT_DETAIL'`,
and a message that is safe to surface to the model. The tool layer maps this to
`kind: 'noActivePaymentDetail'`.

On other status codes, the existing mapping (`AuthError`, `ForbiddenError`,
`NotFoundError`, `RateLimitError`, `UpstreamError`) MUST apply, with `errorCode`
populated from the body when present and `null` otherwise.

#### Scenario: 200 returns the bot-safe PaymentDetail projection

- GIVEN a `ChatbotApiHttpClient` configured for one branch
- AND the stub server returns `200` with body
  `{ id: 'p-1', bankName: 'AFIRME', beneficiary: 'HUN F.E. COMERCIALIZADORA SA DE CV', clabe: '012345678901234567', accountNumber: '1234567890', isActive: true, updatedAt: '2026-08-24T12:00:00.000Z' }`
- WHEN `client.getPaymentDetails()` is invoked
- THEN the outgoing HTTP request MUST be `GET /chatbot-api/payment-details` with
  no query string and no request body
- AND the auth headers MUST be sent (`Authorization: Bearer svc_…` + `X-Branch-Id`)
- AND the resolved `PaymentDetail` MUST deep-equal the body's projection
- AND the resolved value MUST NOT contain `tenantId` or `createdAt`.

#### Scenario: 404 NO_ACTIVE_PAYMENT_DETAIL surfaces the backend error field

- GIVEN the stub server returns `404` with body
  `{ statusCode: 404, error: 'NO_ACTIVE_PAYMENT_DETAIL', message: 'No active payment detail configured' }`
- WHEN `client.getPaymentDetails()` is invoked
- THEN the call MUST reject with `ChatbotApiError` carrying `statusCode: 404` and
  `errorCode: 'NO_ACTIVE_PAYMENT_DETAIL'`.

#### Scenario: 401 is mapped to AuthError

- GIVEN the stub server returns `401`
- WHEN `client.getPaymentDetails()` is invoked
- THEN the call MUST reject with `AuthError`
- AND `errorCode` MUST equal `null` (no body / body without `error` field).

#### Scenario: 5xx is mapped to UpstreamError

- GIVEN the stub server returns `503`
- WHEN `client.getPaymentDetails()` is invoked
- THEN the call MUST reject with `UpstreamError`
- AND `errorCode` MUST equal the body's `error` field if present, otherwise `null`.

### Requirement: PaymentDetail DTO is a bot-safe projection

The `PaymentDetail` DTO MUST carry the bot-safe projection documented in
`docs/backend-questions-sale-flow-responses.md` Q1:

```text
PaymentDetail {
  id: string;             // UUID
  bankName: string;       // non-empty after trim
  beneficiary: string;    // non-empty after trim
  clabe: string;          // exactly 18 digits (^\d{18}$)
  accountNumber: string;  // >= 10 digits (^\d+$)
  isActive: boolean;
  updatedAt: string;      // ISO 8601 timestamp
}
```

The projection MUST NOT carry `tenantId` (per the backend's bot-safe contract)
and MUST NOT carry `createdAt`. The DTO MUST be the sole shape returned by
`client.getPaymentDetails()`; tool callers MUST NOT assume `tenantId` exists on
the response, and tests MUST assert the field-set explicitly.

#### Scenario: PaymentDetail projection matches the backend's documented shape

- GIVEN the canonical `PaymentDetail` DTO definition
- WHEN a test asserts the field set
- THEN it MUST contain exactly `id`, `bankName`, `beneficiary`, `clabe`,
  `accountNumber`, `isActive`, `updatedAt`
- AND it MUST NOT contain `tenantId` or `createdAt`.

### Requirement: createSale forwards the cart's expectedTotalCents and returns discountCents

`CreateSaleInput` MUST accept an optional `expectedTotalCents?: number | null`.
The HTTP implementation of `client.createSale(input)` MUST forward the field
when `input.expectedTotalCents` is a non-null number and MUST omit the key
entirely from the outgoing JSON body when the field is absent or `null`. The
HTTP implementation MUST reject `expectedTotalCents` that are not non-negative
integers with a typed Zod validation error before the request goes out. The bot
MUST NEVER send `expectedTotalCents: 0` to mean "absent" — absence means omission.

`BotSaleResponse` MUST include `discountCents: number` on the resolved value:
`0` when no promo applies; `subtotalCents − totalCents` (the result of the
backend promo engine) when a promo applies. The field MUST be a non-negative
integer cents value.

The HTTP implementation MUST populate `BotSaleResponse.discountCents` from the
backend response body's `discountCents` field; when the body omits the field, the
default MUST be `0` (legacy behavior, log a warning once at debug level).

#### Scenario: HTTP createSale forwards expectedTotalCents when present

- GIVEN a `CreateSaleInput` with `expectedTotalCents: 1500`
- WHEN `client.createSale(input)` is invoked
- THEN the outgoing `POST /chatbot-api/sales` body MUST include the key
  `expectedTotalCents: 1500`.

#### Scenario: HTTP createSale omits expectedTotalCents when absent

- GIVEN a `CreateSaleInput` that does NOT define `expectedTotalCents` (or sets
  it to `null`)
- WHEN `client.createSale(input)` is invoked
- THEN the outgoing `POST /chatbot-api/sales` body MUST NOT contain the key
  `expectedTotalCents` at all
- AND it MUST NOT contain `expectedTotalCents: 0` or `expectedTotalCents: null`.

#### Scenario: HTTP createSale rejects negative expectedTotalCents

- GIVEN a `CreateSaleInput` with `expectedTotalCents: -10`
- WHEN `client.createSale(input)` is invoked
- THEN the client MUST reject before sending the HTTP request with a Zod
  validation error
- AND the request body MUST NOT be serialized.

#### Scenario: BotSaleResponse surfaces discountCents

- GIVEN the stub server returns `200` with body
  `{ saleId: 'sale-1', subtotalCents: 1000, totalCents: 900, discountCents: 100, … }`
- WHEN `client.createSale(input)` is invoked
- THEN the resolved `BotSaleResponse` MUST contain `discountCents: 100`.

### Requirement: ChatbotApiError.errorCode passthrough surfaces backend envelope codes

`ChatbotApiError` MUST include `errorCode: string | null`. The HTTP client's
`mapError` function MUST read the parsed JSON body's `error` field and assign
it to `errorCode` (verbatim, no transformations). The value MUST be `null` in
the following cases:

- The HTTP transport itself failed (no body): `errorCode === null`.
- The body is not valid JSON: `errorCode === null`.
- The body has no `error` field: `errorCode === null`.

For every other 4xx or 5xx that returns a JSON body with an `error` string,
`errorCode` MUST equal that string verbatim.

The `createSale` failure branches in the tool layer (`error-mapping.ts`) MUST
switch on `errorCode` first, before the HTTP status, so the five discriminated
kinds (`promoReQuote`, `idempotencyInFlight`, `idempotencyConflict`,
`noActivePaymentDetail`, `priceOutOfDate`) always win over a blanket
status-based fallback.

#### Scenario: errorCode is populated from PROMO_RE_QUOTE body

- GIVEN the stub server returns `409` with body
  `{ statusCode: 409, error: 'PROMO_RE_QUOTE', message: 'Price changed', recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 }`
- WHEN `client.createSale(input)` rejects
- THEN the thrown `ChatbotApiError` MUST have `statusCode: 409` and
  `errorCode: 'PROMO_RE_QUOTE'`
- AND the `recomputedTotalCents`, `expectedTotalCents`, and `discountCents`
  fields MUST surface on the envelope so the tool can include them in the
  `kind: 'promoReQuote'` returned envelope.

#### Scenario: errorCode is null when the transport-level error happens

- GIVEN the HTTP transport rejects with a network error before any response
  body arrives
- WHEN `client.createSale(input)` rejects
- THEN the thrown error MUST be `UpstreamError` (not a status-bearing
  `ChatbotApiError`)
- AND no `errorCode` field is required on `UpstreamError` for the sale-flow
  tools to fall back to the legacy status-keyed mapping.

#### Scenario: errorCode is null when the body has no error field

- GIVEN the stub server returns `422` with body
  `{ statusCode: 422, message: 'Validation failed' }` (no `error` field)
- WHEN the client maps the response
- THEN `ChatbotApiError.errorCode` MUST equal `null`
- AND the error-mapping layer MUST fall back to the HTTP status (`422` →
  `validation`).
