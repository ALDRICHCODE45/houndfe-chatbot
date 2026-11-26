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
- Tool `getStoreInfo({})` (minimal catalog agent): «¿dónde están?», «¿a qué hora abren/cierran?», «¿abren el domingo?», «¿puedo pasar a recoger?». One gate (`storeInfoRunFor`): offered only when the client has `getBranch` and no checkout step is pending — an order summary or delivery-data summary waiting for its answer, the delivery-or-pickup question just asked, or delivery data being collected for an order not placed yet (T2-fix J4: there «paso a recoger» chooses pickup through `chooseStorePickup`, exactly as before; the tool and its prompt fragment are absent). The prompt fragment comes from one helper (`storeInfoInstructions`) and tells the model the application appends the store part, so it never writes an address or hours.
- The store block (`storeLines`): «Nos encuentra en *{name}*» (tú: «Nos encuentras en …»), the formatted address and «*Horario:* {summary}»; a null part is left out. With coordinates the reply also carries the WhatsApp location pin (`storePin`): name and address as labels, capped at 100 and 250 characters on a word boundary with «…».
- Composition (T2-fix J2/J3): the store part is appended, after a blank line, to whichever reply wins the turn, and the session history stores that full reply. Catalog options or the model's text come first; a pure store question (getStoreInfo the run's only answering tool) gets the store block alone. Server-owned replies carry it too, after their own text, with their buttons attached (a text fallback gets the block as well): cart summary (after the next-step question), checkout presentation, cart-change continuation, payment details, reorder offer, askTeam outcome, RESTOCK / expiration replies and the invalid-tool clarifications. The which-pet / memory question is the exception: when it already won the run, `getStoreInfo` returns `store_info_deferred` (nothing is read; the tapped pet re-runs the original request, which asks again); a block promised before the question rides on it.
- Results: `{ok, presentedByApplication}`; `store_info_settled` (a second call in the same run, nothing new); `store_info_deferred` (above); `store_info_unavailable` — a failed or drifted read, or both `address` and `hours` null. Unavailable (T2-fix J5): the application replaces the model's text with the fixed line «Por ahora no puedo confirmar la dirección ni el horario de la sucursal.» plus «Si quiere, lo consulto con el equipo.» (tú: «Si quieres, …») when askTeam is offered and was not used in the run; next to catalog options or a server reply, the line is appended like the block. The model's own text about the store is never sent.
- Logs (T2-fix J6): `minimal_catalog tool getStoreInfo read failed trace=… : UpstreamError status=503 errorCode=…` (status and backend error code, never the body) and, for a branch with neither address nor hours, `minimal_catalog tool getStoreInfo branch_unconfigured (no address, no hours) trace=…`.
- The pickup order-created reply attaches the same pin when the checkout `pickupLocation.location` exists; without it the reply is unchanged. The pin also survives the steps that reach that reply (`continueToOrder`, [Recoger en tienda], reorder replies; T2-fix J7).
- The pin goes out after the text (`WhatsappSenderPort.sendLocation`, Graph API `type: "location"`) and after the inbound is marked seen (T2-fix J1), bounded by `REPLY_LOCATION_TIMEOUT_MS` (5 s). A failed or timed-out pin is logged; the text was sent once and a crash or a hung pin never redelivers it.
