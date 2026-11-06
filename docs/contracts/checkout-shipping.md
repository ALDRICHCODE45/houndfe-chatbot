# Checkout with shipping (backend contract copy)

Exact examples from houndfe-backend `docs/chatbot-checkout-shipping.md` (backend local main, merge e89cf14), relayed 2026-11-05. The backend document is the source of truth.

## Delivery checkout request (POST /chatbot-api/checkouts, X-Idempotency-Key, scopes customers:write + sales:create)
```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "customer": { "mode": "existing", "customerId": "c0a1…" },
  "deliveryAddress": {
    "mode": "newSaved",
    "address": { "street": "Calle 5", "zipCode": "64000", "state": "Nuevo León", "municipality": "Monterrey", "neighborhood": "Centro" }
  },
  "sale": {
    "cashierUserId": "3a9e…",
    "items": [ { "productId": "6f1c…", "productName": "Croquetas", "quantity": 1, "unitPriceCents": 60000 } ],
    "expectedTotalCents": 78000,
    "shipping": { "quoteId": "shq_Q2x9…" }
  }
}
```
## Delivery 201
```json
{
  "status": "created",
  "customer": { "resolution": "existing", "customerId": "c0a1…", "firstName": "Ana", "lastName": null },
  "address": { "resolution": "created", "id": "d4e5…", "version": "2026-11-06T18:01:02.345Z" },
  "sale": {
    "saleId": "1e06…", "folio": "A-202611-000001", "paymentStatus": "CREDIT", "channel": "ONLINE", "deliveryStatus": "PENDING",
    "totalCents": 78000, "discountCents": 0, "subtotalCents": 60000, "shippingChargeCents": 18000, "fulfillmentMode": "DELIVERY",
    "paidCents": 0, "debtCents": 78000, "confirmedAt": "2026-11-06T18:01:02.400Z"
  }
}
```
## Pickup checkout request (new customer, no deliveryAddress)
```json
{
  "phoneCountryCode": "52",
  "phone": "5511112222",
  "customer": { "mode": "createIfAbsent", "firstName": "Luis" },
  "sale": {
    "cashierUserId": "3a9e…",
    "items": [ { "productId": "6f1c…", "productName": "Croquetas", "quantity": 1, "unitPriceCents": 60000 } ],
    "expectedTotalCents": 60000,
    "shipping": { "mode": "pickup" }
  }
}
```
Existing customer pickup: same, with `"customer": { "mode": "existing", "customerId": "c0a1…" }` and no deliveryAddress.
## Pickup 201
```json
{
  "status": "created",
  "customer": { "resolution": "created", "customerId": "77b0…", "firstName": "Luis", "lastName": null },
  "address": null,
  "sale": {
    "saleId": "9c21…", "folio": "A-202611-000002", "paymentStatus": "CREDIT", "channel": "ONLINE", "deliveryStatus": "PENDING",
    "totalCents": 60000, "discountCents": 0, "fulfillmentMode": "PICKUP", "paidCents": 0, "debtCents": 60000, "confirmedAt": "2026-11-06T18:05:00.000Z"
  },
  "pickupLocation": {
    "name": "Sucursal Centro",
    "address": {
      "addressLine1": "Av. Juárez 123", "addressLine2": null, "neighborhood": "Centro", "municipality": "Cuauhtémoc",
      "state": "Ciudad de México", "postalCode": "06000",
      "formatted": "Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000"
    },
    "hours": {
      "timeZone": "America/Mexico_City",
      "days": [
        { "day": "MONDAY", "label": "Lunes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "TUESDAY", "label": "Martes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "WEDNESDAY", "label": "Miércoles", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "THURSDAY", "label": "Jueves", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "FRIDAY", "label": "Viernes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "SATURDAY", "label": "Sábado", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "SUNDAY", "label": "Domingo", "closed": true, "ranges": [] }
      ],
      "summary": "Lunes a sábado: 09:00–18:00. Domingo: cerrado."
    }
  }
}
```
pickupLocation.address falls back to the free-text sucursal address (only `formatted` set, rest null) without a shipping origin; it is null when there is neither. hours is null until configured.
## /chatbot-api/sales pickup: returns the `sale` object above plus `pickupLocation`; shippingAddressId must be omitted/null.
## Errors (body always {statusCode, error, message}; checkout only adds `mismatches`)
| 400 | INVALID_CHECKOUT_REQUEST (checkout) / validation (/sales) | bad or mixed shipping shape, or no deliveryAddress without pickup |
| 404 | SHIPPING_QUOTE_NOT_FOUND | malformed/unknown quote or another sucursal's |
| 409 | SHIPPING_QUOTE_EXPIRED | requote silently |
| 409 | SHIPPING_QUOTE_MISMATCH | requote and show the new total |
| 409 | SHIPPING_QUOTE_ALREADY_USED | the quote already backs another sale (no saleId) |
| 422 | SHIPPING_ADDRESS_REQUIRED | /sales with quote and no shippingAddressId |
| 422 | SHIPPING_EXPECTED_TOTAL_REQUIRED | /sales with quote and no expectedTotalCents |
| 422 | SHIPPING_ADDRESS_NOT_ALLOWED_FOR_PICKUP | /sales pickup with shippingAddressId |
| 409 | PROMO_RE_QUOTE | expectedTotalCents != merchandise + shipping charge |
```json
{ "statusCode": 409, "error": "SHIPPING_QUOTE_MISMATCH", "message": "SHIPPING_QUOTE_MISMATCH", "mismatches": ["LINES", "DESTINATION"] }
```
## Replay: same key + same body returns the first result even after expiry; after any SHIPPING_QUOTE_* nothing is written (checkout: reuse the key; /sales: slot freed, reuse the key).

## Verification order (§2.3, the first failure wins)

1. The quote belongs to this branch, else 404 `SHIPPING_QUOTE_NOT_FOUND`.
2. Not expired, else 409 `SHIPPING_QUOTE_EXPIRED`.
3. Phone (digits), lines (product, variant, quantity, order-insensitive) and destination (exact 5-digit ZIP plus state/municipality/neighborhood, ignoring case, accents and spaces) match, else 409 `SHIPPING_QUOTE_MISMATCH` with every failing part in `mismatches`.
4. Inside the transaction, with the quote locked: not used by another sale, else 409 `SHIPPING_QUOTE_ALREADY_USED` (expiry is re-checked here too).
