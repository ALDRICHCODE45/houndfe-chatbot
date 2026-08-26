# Delta for chatbot-api-client

## Out of Scope (non-goals)

This delta does NOT introduce:

- **Backend code.** `POST /chatbot-api/sales/:saleId/cancel`, the backend-derived idempotency key `sale:cancel:<saleId>`, restock/refund behavior, and `sale.canceled` emission are already implemented server-side (backend `PROGRAM-CONTEXT.md` §4.4.10, confirmed `cancelBotSale` → `SalesService.cancelSale` `buildResult`). The bot is consumer-only.
- **A client `X-Idempotency-Key` for cancel.** Unlike `createSale` (which mints a client UUID v4), the cancel idempotency key is derived BACKEND-side from `{saleId, actorId, reason}` (SHA-256). The client MUST NOT send an idempotency header on the cancel call.
- **Reusing `BotSaleResponse` for cancel.** The backend cancel response is the `CancelSaleResult` projection `{ saleId, status: 'CANCELED', refundedCents, restockedItems, canceledAt }` — a different shape; the bot defines its own DTO and MUST NOT deserialize it as `BotSaleResponse`.
- **New retry semantics.** `POST/PUT/PATCH` MUST NOT blind retry continues to hold for the cancel POST; no retry policy is added.
- **`AGENTS.md` §4.4 endpoint-table sync.** Carried in the existing `chatbot-api-doc-sync` follow-up, not this slice.
- **New environment variables.** No env additions; `cashierUserId` reuses the already-injected `CHATBOT_API_CASHIER_USER_ID`.

## ADDED Requirements

### Requirement: cancelSale calls POST /chatbot-api/sales/:saleId/cancel

`ChatbotApiClient` MUST expose `cancelSale(saleId: string, dto: CancelSaleInput): Promise<CancelSaleResult>`. The HTTP implementation MUST issue `POST /chatbot-api/sales/${encodeURIComponent(saleId)}/cancel` with `data: dto`, applying the standard single-branch auth headers (`Authorization: Bearer svc_<key>` + `X-Branch-Id`). The request MUST NOT carry an `X-Idempotency-Key` header — the backend derives `sale:cancel:<saleId>`; this differs from `createSale`, which mints a client UUID v4.

`CancelSaleInput` MUST be the DTO `{ reason: 'CUSTOMER_REQUEST' | 'ORDER_ERROR' | 'OUT_OF_STOCK' | 'DUPLICATE_SALE' | 'OTHER'; cashierUserId: string }`, with an optional Zod `CancelSaleInputSchema` for wire validation. The tool layer always sends `reason: 'CUSTOMER_REQUEST'` and the injected `cashierUserId`.

On HTTP 200, the response body MUST deserialize into `CancelSaleResult`:

```text
CancelSaleResult {
  saleId: string;          // UUID of the canceled sale
  status: 'CANCELED';      // literal
  refundedCents: number;   // non-negative integer cents
  restockedItems: Array<{ productId: string; variantId: string | null; quantity: number }>;
  canceledAt: string;      // ISO 8601 timestamp
}
```

`CancelSaleResult` MUST be its own DTO — the client MUST NOT reuse `BotSaleResponse` (which has a different projection, e.g. `deliveryStatus`/`totalCents`). A sale already `CANCELED` server-side MUST resolve as a normal 200 success (`status: 'CANCELED'`) — the backend returns a replay success, not an error.

On error, `ChatbotApiError.errorCode` MUST surface the backend code verbatim. Confirmed codes for this endpoint: `SALE_NOT_FOUND` (404), `SALE_NOT_CANCELLABLE` (409), `SALE_DELIVERED_CANNOT_CANCEL` (409), `IDEMPOTENCY_KEY_CONFLICT` (409), `IDEMPOTENCY_KEY_IN_FLIGHT` (409). Unrecognized codes fall through to the existing status mapping.

#### Scenario: 200 returns the CancelSaleResult projection, not BotSaleResponse

- GIVEN a `ChatbotApiHttpClient` configured for one branch
- AND the stub server returns `200` with body `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }], canceledAt: '2026-08-25T12:00:00.000Z' }`
- WHEN `client.cancelSale('sale-1', { reason: 'CUSTOMER_REQUEST', cashierUserId: '<uuid>' })` is invoked
- THEN the resolved `CancelSaleResult` MUST deep-equal the body's projection
- AND the resolved value MUST NOT carry `BotSaleResponse` fields such as `deliveryStatus`, `totalCents`, or `subtotalCents`.

#### Scenario: request shape is the encoded path with DTO body and no idempotency header

- GIVEN a `CancelSaleInput` with `reason: 'CUSTOMER_REQUEST'` and `cashierUserId: '<uuid>'`
- WHEN `client.cancelSale('sale-1', input)` is invoked
- THEN the outgoing HTTP request MUST be `POST /chatbot-api/sales/sale-1/cancel` (with `saleId` percent-encoded when it contains reserved characters)
- AND the request body MUST contain exactly `{ reason: 'CUSTOMER_REQUEST', cashierUserId: '<uuid>' }`
- AND the request MUST NOT contain an `X-Idempotency-Key` header.

#### Scenario: CancelSaleInputSchema validates the five reason values and requires cashierUserId

- GIVEN the optional `CancelSaleInputSchema` (Zod)
- WHEN a test parses `{ reason: 'CUSTOMER_REQUEST', cashierUserId: '<uuid>' }` and each of the other four enum values (`ORDER_ERROR`, `OUT_OF_STOCK`, `DUPLICATE_SALE`, `OTHER`)
- THEN each parse MUST succeed
- AND a parse of `{ reason: 'NOT_A_REASON', cashierUserId: '<uuid>' }` MUST fail
- AND a parse of `{ reason: 'CUSTOMER_REQUEST' }` (missing `cashierUserId`) MUST fail.

#### Scenario: 409 SALE_NOT_CANCELLABLE surfaces the backend code verbatim

- GIVEN the stub server returns `409` with body `{ statusCode: 409, error: 'SALE_NOT_CANCELLABLE', message: 'Sale is not cancellable' }`
- WHEN `client.cancelSale('sale-1', input)` is invoked
- THEN the call MUST reject with `ChatbotApiError` carrying `statusCode: 409` and `errorCode: 'SALE_NOT_CANCELLABLE'` (verbatim, no transformation)
- AND the tool layer MUST map it to `kind: 'saleNotCancellable'`.

#### Scenario: already-canceled sale resolves as a 200 replay success

- GIVEN the stub server returns `200` with body `{ saleId: 'sale-1', status: 'CANCELED', refundedCents: 0, restockedItems: [], canceledAt: '2026-08-24T10:00:00.000Z' }` (the sale was canceled out-of-band)
- WHEN `client.cancelSale('sale-1', input)` is invoked
- THEN the call MUST resolve (not reject) with `CancelSaleResult` whose `status` equals `'CANCELED'`
- AND no error code is raised (there is no distinct "already canceled" code).

## MODIFIED Requirements

### Requirement: Map backend responses and retries

The system MUST expose typed methods for the documented endpoints and MUST map backend `401`, `403`, `404`, `429`, and `5xx` responses to typed errors. Idempotent GETs SHOULD retry with backoff on transient failures; `429` responses MUST honor `Retry-After`; `POST/PUT/PATCH` requests MUST NOT blind retry.

The client MUST populate `ChatbotApiError.errorCode: string | null` from the backend envelope's `responseBody.error` value for every mapped response that returns a JSON body. `errorCode` MUST be `null` when the body is absent, when the body is not JSON, or when the body has no `error` field.

The typed method surface MUST include `cancelSale(saleId, dto)`. The cancel call MUST NOT send an `X-Idempotency-Key` header — the backend derives `sale:cancel:<saleId>` (differs from `createSale`, which mints a client UUID v4). The cancel error codes `SALE_NOT_FOUND` (404), `SALE_NOT_CANCELLABLE` (409), `SALE_DELIVERED_CANNOT_CANCEL` (409), `IDEMPOTENCY_KEY_CONFLICT` (409), and `IDEMPOTENCY_KEY_IN_FLIGHT` (409) MUST be discoverable from `ChatbotApiError.errorCode` so the tool-layer error-mapping can branch on them without parsing message strings. A sale already `CANCELED` MUST resolve as a 200 replay success, never as an error. The transport-level fallback (`UpstreamError` for network failures without a status) MUST continue to apply.

(Previously: the typed method surface ended at `getPaymentDetails`; no cancel mapping; `createSale` was the only POST with an idempotency contract and it used a client-minted UUID v4 header.)

#### Scenario: Transient GET is retried

- GIVEN a `GET /chatbot-api/customers/by-phone` call (§4.4.4) receives a transient 5xx
- WHEN the client retries with backoff
- THEN the request succeeds without changing caller-visible data.

#### Scenario: POST rate limit is surfaced

- GIVEN `POST /chatbot-api/sales` (§4.4.6) returns HTTP 429 with `Retry-After`
- WHEN the client receives the response
- THEN it returns a typed rate-limit error and does not blindly retry
- AND the returned `ChatbotApiError.errorCode` field MUST equal `null` (the body for rate-limit responses does not carry an `error` envelope field).

#### Scenario: cancelSale sends no client idempotency key

- GIVEN a `ChatbotApiHttpClient` stub server that records request headers
- WHEN `client.cancelSale('sale-1', { reason: 'CUSTOMER_REQUEST', cashierUserId: '<uuid>' })` is invoked
- THEN the recorded request MUST NOT contain an `X-Idempotency-Key` header (idempotency is backend-derived from `sale:cancel:<saleId>`).

#### Scenario: cancel error codes are discoverable via errorCode passthrough

- GIVEN the stub server returns `409` with body `{ statusCode: 409, error: 'SALE_DELIVERED_CANNOT_CANCEL', message: 'Sale already delivered' }`
- WHEN `client.cancelSale('sale-1', input)` rejects
- THEN the thrown `ChatbotApiError` MUST carry `statusCode: 409` and `errorCode: 'SALE_DELIVERED_CANNOT_CANCEL'`
- AND the tool layer MUST map it to `kind: 'saleNotCancellable'` (errorCode-first, before the status branch).
