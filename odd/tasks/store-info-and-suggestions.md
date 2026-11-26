# Store info (roadmap #12) and complementary suggestions (roadmap #10)

Two independent tracks from docs/propuestas-chatbot-primer-nivel.md. Track A (T1-T2) needs a backend endpoint (branch info with coordinates); track B (T3) is chatbot-only. Branch `feat/store-info-and-suggestions`.

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
| T1 | S2, S3 | Backend agent (intercom): `GET /chatbot-api/branch` (name, address, hours, lat/lng), contract copy in docs/contracts | pending (waiting on backend) | — |
| T2 | S1-S3 | Chatbot: client method + DTO, `getStoreInfo` tool (store address/hours answer, server-owned copy), WhatsApp location sender method, pin after the text when coordinates exist; hours null → address only; eval scenario | pending | — |
| T3 | S4-S6 | Chatbot (worker): D1 replace «sin upsell ni aviso forzado» with a bounded rule; D2 new tool `suggestComplement({productId, variantId?})` the model may call at most once per turn, only in a turn whose addItems/changeItem added a product, with a product read by searchCatalog in THIS chat that complements (not substitutes, not the same product) what was added, fits the known pet (species/stage/allergies; never a gone pet) and is not out_of_stock; D3 the application validates (id read this chat, not in cart, not the product added, availability not out_of_stock, sender eligible) and appends ONE server-owned line before MINIMAL_CART_NEXT_STEP_QUESTION, e.g. «💡 Por si le sirve: *{nombre}* ({precio}) suele ir bien con lo que eligió.» (tú form when the customer tutea; emoji only if the customer's style uses emojis), never in the model's free text; D4 eligibility: at most one suggestion per sender per 24 h, persisted (survives restart); none while an order summary/checkout or payment step is pending, none on backorder/restock flows; D5 decline: if the customer rejects a suggestion or asks for no suggestions, the model must not call the tool (instruction), and the agent records no further suggestion for 7 days when the customer's reply to a suggestion is a rejection detected by the model via an optional `declineSuggestions` call — or simpler if the worker finds a cleaner hook (report it); D6 cart buttons and pet-less/eligible-false turns byte-identical to today; eval scenario | pending | — |

## Log

- L1 (2026-11-26, owner verbatim): "que tienes en mente como pendiente? ya esta todo pusheado." → chose «12 + 10: ubicación/horario y sugerencias (recomendado)».
- L2 (2026-11-26): explorer map — `pickupLocation` (checkout.dto.ts:196) exists only in the checkout response (no branch read, no lat/lng); no WhatsApp location send; the catalog prompt says «sin upsell ni aviso forzado» (minimal-catalog-agent.service.ts:334); natural hook after a cart add (MINIMAL_CART_NEXT_STEP_QUESTION). Owner answers S2, S3, S5, S6.
- L3 (2026-11-26): T1 requested from the backend agent (01a217ad-71d6) via intercom: GET /chatbot-api/branch {name, address, hours, location{latitude,longitude}|null}, same source as pickupLocation; asked whether prod hours are configured and whether lat/lng can also be exposed in checkout pickupLocation. Design for T3 (parent): the cart reply after an add is server-owned (the model's text is discarded), so a suggestion must be a validated tool output the application appends, not free text.
