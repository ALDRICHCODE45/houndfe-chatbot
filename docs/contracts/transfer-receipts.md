# Transfer receipts (backend contract summary)

Relayed by the houndfe-backend agent on 2026-11-05 (backend local `main`, merge 9847656, contract in backend `docs/transfer-receipts.md`). The backend is the source of truth; update this file when the backend contract changes.

## Upload — POST /chatbot-api/sales/:saleId/receipts

Scope: `sales:write`. Multipart form data.

| Part | Rule |
| --- | --- |
| `file` | Required. JPEG, PNG or PDF, type detected by magic bytes, max 10 MB. |
| `declaredAmountCents` | Optional. |
| `declaredDate` | Optional. |
| `declaredReference` | Optional. |
| `extracted` | Optional JSON string: `{ amountCents?, date?, reference?, bank?, confidence? (0..1) }`. |

Header `X-Idempotency-Key` is required: the WhatsApp media id (1–200 chars). A replay with the same key and file returns the same body with 201.

201 response:

```json
{ "receiptId": "...", "status": "PENDING", "mimeType": "...", "sizeBytes": 0, "sha256": "...", "previewStatus": "READY | UNAVAILABLE" }
```

Errors (`body.error`):

| Status | Codes |
| --- | --- |
| 400 | `INVALID_IDEMPOTENCY_KEY`, `RECEIPT_FILE_REQUIRED`, `INVALID_RECEIPT_FIELDS`, `INVALID_RECEIPT_EXTRACTED` |
| 404 | `SALE_NOT_FOUND` |
| 409 | `SALE_NOT_PAYABLE`, `SALE_ALREADY_PAID`, `IDEMPOTENCY_KEY_REUSED` (same key, different file) |
| 413 | `RECEIPT_FILE_TOO_LARGE` |
| 415 | `RECEIPT_FILE_TYPE_NOT_ALLOWED` |
| 502 | `RECEIPT_STORAGE_FAILED` |

A PDF can take up to about 60 s in the worst case (preview rendering is queued): use a generous HTTP timeout or retry with the same key.

The old JSON body with `mediaUrl` is still accepted without idempotency until the chatbot migrates; tell the backend when it can be closed.

## Outcome — GET /chatbot-api/receipts/:receiptId

Scope: `sales:read` (new; `sales:write` alone answers 403).

```json
{ "status": "PENDING | CONFIRMED | REJECTED", "customerReason": "only with REJECTED", "sale": { "debtCents": 0, "paymentStatus": "..." } }
```
