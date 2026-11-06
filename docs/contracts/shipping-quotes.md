# Shipping quotes (backend contract summary)

Relayed by the houndfe-backend agent on 2026-11-05 (branch `feat/shipping-zones`, not in backend `main` yet). The backend is the source of truth; update this file when the backend contract changes.

## POST /chatbot-api/shipping/quotes

Scope: `shipping:quote`.

Request:

```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "items": [{ "productId": "<uuid>", "variantId": "<uuid, optional>", "quantity": 1 }],
  "destination": { "zipCode": "06700", "state": "...", "municipality": "...", "neighborhood": "..." }
}
```

`destination` is either the four loose fields above or `{ "shippingAddressId": "<uuid>" }`.

201 response:

```json
{
  "quoteId": "shq_...",
  "expiresAt": "<ISO>",
  "zoneStatus": "FREE | SURCHARGE | CARRIER_ONLY | DENIED | PENDING",
  "option": { "carrier": "...", "service": "...", "etaDays": 2 },
  "eta": { "days": 2, "reason": null },
  "costCents": 0,
  "creditCents": 0,
  "customerChargeCents": 0,
  "currency": "MXN"
}
```

- FREE and SURCHARGE: `option` is null.
- DENIED and PENDING: `quoteId` and `expiresAt` are null, amounts are 0, nothing is stored.
- PENDING does not open the zone validation: the chatbot opens it with the DELIVERY_ZONE intake (docs/contracts/delivery-zone-bot-cycle.md).
- `eta.reason` is null or `"STOCK_PENDING"`.
- Until the Skydropx adapter exists, a CARRIER_ONLY zone answers 503.

Errors (`body.error`):

| Status | Codes |
| --- | --- |
| 400 | validation, `INVALID_SHIPPING_DESTINATION`, `DUPLICATE_CART_LINE` |
| 404 | `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND`, `SHIPPING_ADDRESS_NOT_FOUND` |
| 409 | `CUSTOMER_PHONE_AMBIGUOUS`, `PRICE_OUT_OF_DATE` |
| 422 | `SHIPPING_ADDRESS_INCOMPLETE`, `PACKAGING_DATA_MISSING`, `NO_SHIPPING_BOX_FITS`, `SHIPPING_ORIGIN_NOT_CONFIGURED` |
| 503 | `SHIPPING_QUOTE_UNAVAILABLE` |

## Checkout (in progress on the backend, T7)

`POST /chatbot-api/checkouts` and `/sales` accept `shipping: { "quoteId": "..." } | { "mode": "pickup" }`; the response adds `pickupLocation { name, address, hours }`. The old `chargeCents`/`approvalId` format still works, deprecated.
