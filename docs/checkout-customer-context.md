# Checkout customer context client (T1)

Adds an additive, read-only chatbot client for the backend checkout-context route so a later minimal-checkout flow can resolve the WhatsApp sender's saved customer and addresses without registering anyone or writing anything. This unit is the typed client and normalizer only; the backend owner implements the endpoint and a later integration unit (T3) consumes it.

## Quick path

1. Call `ChatbotApiClient.getCustomerCheckoutContext(cc, phone, { limit?, afterAddressId? })` from an allowlisted minimal-route service (integration is a later unit).
2. Read `status`: `not_found` and `ambiguous` are results, not exceptions; only `unique` carries `customer` and `addresses`.
3. Treat a rejected promise as _lookup unavailable_, never as customer absence.

Focused offline check (mocked HTTP, no backend or network call):

```sh
node node_modules/jest/bin/jest.js --runTestsByPath src/chatbot-api/domain/dtos/checkout-context.dto.spec.ts src/chatbot-api/infrastructure/chatbot-api-http.client.spec.ts --runInBand
```

## Details

| Topic              | Decision                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route              | `GET /chatbot-api/customers/checkout-context`, scope `customers:read`, existing Bearer + `X-Branch-Id` auth.                                                                                                                                                                                                                                                           |
| Tenant/identity    | The credential owns the tenant; the trusted application derives the digit phone. The client never sends a tenant, branch or sender field.                                                                                                                                                                                                                              |
| Query              | Digit `phoneCountryCode` (1–10) and digit `phone` (1–20); `limit` integer 1–20, default 10; optional UUID `afterAddressId`.                                                                                                                                                                                                                                            |
| UUID profile       | The backend `class-validator@0.15.1`/`validator@13.15.26` `@IsUUID('all')` profile: v1–v8 with any standard variant and any case, plus the nil and max sentinels. Non-nil v0, v9/v10+ and invalid variants are rejected. The `/i` syntax check is not an identity case-fold: projected IDs and cursors are preserved unaltered — never lowercased, trimmed or coerced. |
| Invalid input      | Rejected locally before any HTTP request. An out-of-range `limit` is rejected, never clamped. A syntactically valid `afterAddressId` (including uppercase, nil or max) is forwarded so the backend can answer `400 INVALID_ADDRESS_CURSOR`; only syntactically malformed cursors are refused locally.                                                                  |
| Envelope           | Exact `{ status, customer, addresses, nextAfterAddressId }`; extra, missing, symbol or explicit-`undefined` keys fail closed.                                                                                                                                                                                                                                          |
| `status`           | `not_found`, `ambiguous` or `unique`. Unknown values are malformed.                                                                                                                                                                                                                                                                                                    |
| Empty statuses     | `not_found`/`ambiguous` force `customer: null`, `addresses: []` and `nextAfterAddressId: null`.                                                                                                                                                                                                                                                                        |
| `unique` customer  | `{ customerId, firstName, lastName }`; `customerId` follows the `@IsUUID('all')` profile, `lastName` is nullable.                                                                                                                                                                                                                                                      |
| Address            | `{ id, version, label, street, exteriorNumber, interiorNumber, zipCode, neighborhood, municipality, city, state, visualReferences, carrierPhone }`; `street` is non-null, every other delivery field is nullable.                                                                                                                                                      |
| `version`          | Canonical ISO `updatedAt` freshness marker, not a compare-and-set edit guarantee.                                                                                                                                                                                                                                                                                      |
| Pagination         | Stable ascending `(createdAt, id)` cursor. The client accepts at most 20 addresses; `nextAfterAddressId`, when present, must be exactly (byte-identical to) the last returned address id and is preserved unaltered. Duplicate address ids are rejected by exact string identity, so IDs differing only by case are distinct opaque values.                            |
| Malformed upstream | `UpstreamError` with status, raw body and `errorCode`. Malformed data stays _lookup unavailable_; it is never reported as `not_found`.                                                                                                                                                                                                                                 |
| Transport          | Reuses the bounded GET retry policy (network/5xx only, at most three attempts) and the existing `401`/`403`/`404`/`429`/5xx mappings. `not_found`/`ambiguous` are returned bodies, not error statuses.                                                                                                                                                                 |
| Boundaries         | GET only. No customer upsert, address mutation, sale, reservation, payment, shipping, model tool, DI/module/config/env or dependency change. No fallback to the legacy `getCustomerByPhone` lookup.                                                                                                                                                                    |

## Checklist

- [ ] `status` is one of the three discriminants before any field is trusted.
- [ ] Only `unique` exposes `customer` and `addresses`.
- [ ] Invalid identity, limit or cursor never reaches the network.
- [ ] A malformed body rejects instead of returning an empty/absent result.
- [ ] No write/upsert/sale/shipping surface is invoked by this read.

## Next step

The backend owner implements `GET /chatbot-api/customers/checkout-context` and returns bounded contract evidence. T3 then wires the read into the minimal draft/selection flow; T1 alone does not prove live WhatsApp behavior or deployment.
