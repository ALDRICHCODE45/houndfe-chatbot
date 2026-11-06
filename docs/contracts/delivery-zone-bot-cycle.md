# DELIVERY_ZONE bot cycle (backend contract copy)

Verbatim copy of section 4 of houndfe-backend `docs/delivery-zones.md` (branch `feat/shipping-zones`, received 2026-11-05). The backend document is the source of truth; refresh this copy when it changes.

## 4. Bot cycle (service credential)

DELIVERY_ZONE reuses the existing human-decision bot routes and scopes. `DELIVERY_ZONE` is a wire discriminator only: these rows are not stored in `human_decisions`. RESTOCK/EXPIRATION responses are unchanged.

| Route | Scope | DELIVERY_ZONE behavior |
| --- | --- | --- |
| `POST /chatbot-api/human-decisions` | `human-decisions:create` | Intake when `type` is `"DELIVERY_ZONE"`. |
| `GET /chatbot-api/human-decisions/:id` | `human-decisions:read` | Poll by requester id. |
| `POST /chatbot-api/human-decisions/:id/application-outcome` | `human-decisions:ack` | Terminal ACK per requester id. |

Poll and ACK try RESTOCK/EXPIRATION first; only their not-found falls through to a DELIVERY_ZONE requester, so a miss in both is the same 404.

### 4.1 Intake

Header `X-Idempotency-Key` must equal `sourceRequestId` byte for byte. The body must contain exactly these keys:

```json
{
  "sourceRequestId": "6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b",
  "type": "DELIVERY_ZONE",
  "zipCode": "06700",
  "state": "Ciudad de México",
  "municipality": "Cuauhtémoc",
  "neighborhood": "Roma Norte",
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "conversationRef": "wa:conv-123",
  "lastCustomerMessageAt": "2026-11-05T10:00:00.000Z"
}
```

| Key | Rule |
| --- | --- |
| sourceRequestId | UUID v1–v8 |
| zipCode | exactly 5 digits |
| state, municipality, neighborhood | 1–120 chars after whitespace collapse; no control chars |
| phoneCountryCode | 1–10 digits, no + |
| phone | 1–20 digits |
| conversationRef | 1–200 chars |
| lastCustomerMessageAt | ISO UTC instant, at most 5 min in the future |

Any violation: 400 VALIDATION_ERROR.

- Same sourceRequestId + same content: replay, 200, same requester. Same id + different content: 409 IDEMPOTENCY_CONFLICT. New id: new requester, 201.
- Active zone for the postal code: requester created already RESOLVED (resolution.source EXISTING_ZONE, decisionId null); no validation opened.
- Otherwise: joins the single PENDING validation of the postal code (opened if none; email outbox written then). Same postal code customers share decisionId; each answered on its own.

201/200 body (current requester state):

```json
{
  "id": "c41b…",
  "sourceRequestId": "6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b",
  "type": "DELIVERY_ZONE",
  "status": "PENDING",
  "version": 1,
  "createdAt": "2026-11-05T10:01:00.000Z",
  "decisionId": "8a2f…",
  "snapshot": {
    "branchName": "Sucursal Centro",
    "zipCode": "06700",
    "state": "Ciudad de México",
    "municipality": "Cuauhtémoc",
    "neighborhood": "Roma Norte"
  },
  "resolution": null,
  "applyBefore": null
}
```

### 4.2 Poll — GET /chatbot-api/human-decisions/:id

Same body, current state, Cache-Control: no-store. Resolved:

```json
{
  "status": "RESOLVED",
  "version": 2,
  "decisionId": "8a2f…",
  "resolution": {
    "source": "VALIDATION",
    "zoneType": "SURCHARGE",
    "surchargeCents": 4500,
    "etaDays": 2,
    "resolvedAt": "2026-11-05T18:00:00.000Z"
  },
  "applyBefore": "2026-11-06T18:00:00.000Z"
}
```

- source: VALIDATION or EXISTING_ZONE.
- surchargeCents/etaDays omitted (never null) when not applicable (DENIED, CARRIER_ONLY carry neither).
- applyBefore = resolvedAt + 24 h.
- Phone, conversation ref, tenant, hash and credential never returned.

### 4.3 ACK — POST /chatbot-api/human-decisions/:id/application-outcome

Identical to the RESTOCK ACK: expectedResolutionVersion 2, attemptId, outcome (PROVIDER_ACCEPTED, PROVIDER_ACCEPTED_LATE, DELIVERY_UNKNOWN, STALE) and its evidence.
- One terminal outcome per requester.
- Exact replay (same attemptId + evidence): 200 with the same acknowledgment.
- Errors: 409 IDEMPOTENCY_CONFLICT, 409 OUTCOME_ALREADY_RECORDED, 409 VERSION_CONFLICT (not resolved yet), 404 (missing or foreign).
- Window 24 h: [resolvedAt, resolvedAt + 24 h), as EXPIRATION. Outside: 400.
