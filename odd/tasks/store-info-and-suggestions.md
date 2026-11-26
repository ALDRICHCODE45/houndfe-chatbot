# Store info (roadmap #12) and complementary suggestions (roadmap #10)

Two independent tracks from docs/propuestas-chatbot-primer-nivel.md. Track A needs a backend endpoint (branch info with coordinates); track B is chatbot-only. Branch `feat/store-info-and-suggestions`.

## Specs

- S1 (#12, verbatim): "**Horario y ubicación** con mapa de la sucursal para recoger" — "Menos preguntas repetidas".
- S2 (owner, source): "Endpoint nuevo en el backend (recomendado)" — the bot reads the branch address and hours from a new backend read (same shape as `pickupLocation`), before any order exists.
- S3 (owner, map): "Pin de WhatsApp (recomendado)" — native WhatsApp location message (needs backend lat/lng and a new sender method).
- S4 (#10, verbatim): "**Sugerencias complementarias** discretas (arena + alimento de gato, premios) solo después de resolver la consulta" — "Ticket promedio mayor sin sonar a vendedor insistente".
- S5 (owner, pairs): "Criterio del modelo con reglas (recomendado)" — the model suggests one complementary product from the real catalog, by product and pet; no maintained list.
- S6 (owner, frequency): "Una vez por conversación, al agregar (recomendado)" — only after a cart add, at most one suggestion per day, never after the customer declined.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| A1 | S2, S3 | Backend agent (intercom): `GET /chatbot-api/branch` (name, address, hours, lat/lng), contract copy in docs/contracts | pending (waiting on backend) | — |
| A2 | S1-S3 | Chatbot: client method + DTO, `getStoreInfo` tool (store address/hours answer, server-owned copy), WhatsApp location sender method, pin after the text when coordinates exist; hours null → address only; eval scenario | pending | — |
| B1 | S4-S6 | Chatbot: relax the «sin upsell» rule into a bounded suggestion rule (one complementary catalog product after a cart add, pet-aware, never for a gone pet, once per day per sender, none after a decline or while checkout/summary is pending); persisted suggestion marker; eval scenarios | pending | — |

## Log

- L1 (2026-11-26, owner verbatim): "que tienes en mente como pendiente? ya esta todo pusheado." → chose «12 + 10: ubicación/horario y sugerencias (recomendado)».
- L2 (2026-11-26): explorer map — `pickupLocation` (checkout.dto.ts:196) exists only in the checkout response (no branch read, no lat/lng); no WhatsApp location send; the catalog prompt says «sin upsell ni aviso forzado» (minimal-catalog-agent.service.ts:334); natural hook after a cart add (MINIMAL_CART_NEXT_STEP_QUESTION). Owner answers S2, S3, S5, S6.
