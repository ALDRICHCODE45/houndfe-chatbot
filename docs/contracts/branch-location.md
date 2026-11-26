# Branch location (backend contract summary)

Relayed by the houndfe-backend agent on 2026-11-26 (backend `main` ba138ae1, dev :3003). The backend is the source of truth; update this file when the backend contract changes. Feature: odd/tasks/store-info-and-suggestions.md (T1 backend, T2 chatbot).

## GET /chatbot-api/branch

Scope: `catalog:read` (no credential rotation needed). `401` / `403` as every chatbot-api route.

200 response:

```json
{
  "name": "Sucursal Centro",
  "address": {
    "addressLine1": "Av. Juárez 123",
    "addressLine2": null,
    "neighborhood": "Centro",
    "municipality": "Cuauhtémoc",
    "state": "Ciudad de México",
    "postalCode": "06000",
    "formatted": "Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, 06000"
  },
  "hours": {
    "timeZone": "America/Mexico_City",
    "days": [
      { "day": "MONDAY", "label": "Lunes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] }
    ],
    "summary": "Lunes a sábado: 09:00–18:00. Domingo: cerrado."
  },
  "location": { "latitude": 19.4326, "longitude": -99.1332 }
}
```

- Same source as the checkout `pickupLocation` (see [checkout-shipping.md](checkout-shipping.md)): `Tenant.name` + `ShippingOrigin` + `TenantOpeningHours`. `address` and `hours` have exactly the `pickupLocation` shapes.
- `address`, `hours` and `location` are each `null` until staff configure them. `address` may be the free-text sucursal address (only `formatted`, the other parts null).
- `location`: optional columns on the shipping origin, set together through `PUT /tenants/:id/shipping-origin`. Dev «Sucursal Centro» (2026-11-26): address and hours set, location null. Production hours: unknown (owner).
- The checkout `pickupLocation` carries the same `location` (missing on replays of sales created before the change → read as null).

## How the bot uses it (T2)

- `ChatbotApiClient.getBranch()` (`src/chatbot-api/infrastructure/chatbot-api-http.client.ts`): safe GET retry policy (network/5xx, three attempts), HTTP 200 with the strict `BranchInfoSchema` (`src/chatbot-api/domain/dtos/branch.dto.ts`): exactly the four keys, coordinates within ±90/±180. Anything else is an `UpstreamError` (contract drift). A good read is cached in process for 5 minutes (`BRANCH_CACHE_TTL_MS`); a failure is never cached.
- Tool `getStoreInfo({})` (minimal catalog agent): «¿dónde están?», «¿a qué hora abren/cierran?», «¿abren el domingo?», «¿puedo pasar a recoger?». Once per turn. The application answers with the shared store block (`storeLines`): «Nos encuentra en *{name}*» (tú: «Nos encuentras en …»), the formatted address and «*Horario:* {summary}»; a null part is left out. With coordinates the reply also carries the WhatsApp location pin (name and address as labels).
- Unavailable — a failed or drifted read, or both `address` and `hours` null — returns `store_info_unavailable`; the model says it cannot confirm it right now (and offers to ask the team with `askTeam` when that tool exists). The prompt forbids stating a store address or hours from memory.
- The pickup order-created reply attaches the same pin when the checkout `pickupLocation.location` exists; without it the reply is unchanged.
- The pin goes out after the text (`WhatsappSenderPort.sendLocation`, Graph API `type: "location"`). A failed pin is logged; the text was sent once and is not repeated.
