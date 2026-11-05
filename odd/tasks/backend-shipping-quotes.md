# Backend shipping quotes

Replace the chatbot's own Skydropx quoting and per-quote human approval with the backend shipping quote contract, add store pickup and DELIVERY_ZONE decisions.
Branch: `feat/always-on-features` (continues there until split). Backend contract: houndfe-backend `docs/shipping-and-delivery-zones-proposal.md` §9-11 (branch `docs/shipping-zones-proposal`, cf23f53); field names behind an adapter until the backend commits them.

## Specs

- S1. Owner: "Envios perros y skydropx son las dos opciones que hoy se ocupan como envios con externos, se usa la que sea mas barata, punto" — the backend chooses the carrier; the chatbot never quotes carriers itself.
- S2. Owner (relayed by backend, 2026-11-05): "Se elimina la aprobación humana por cargo de envío: el backend firma un quoteId con vencimiento." The chatbot sends `shipping: {quoteId}` on checkout; no `chargeCents` or `approvalId`; no per-quote human approval flow remains.
- S3. Owner (relayed by backend): credit "$120 por UNIDAD con precio unitario (con descuentos) mayor a $500, y los créditos se suman; el cliente paga max(0, costo − crédito)" — computed by the backend; the chatbot shows `costCents`, `creditCents`, `customerChargeCents` as returned.
- S4. Zone DENIED → the bot offers store pickup: `shipping: {mode: "pickup"}` (owner decision relayed by backend).
- S5. Owner: "el chatbot inserte algo en el sistema, una validacion pendiente, que se mande un correo al usuario del sistema para notificarle que tiene una validacion, el usuario se mete al sistema, observa la validacion pendiente y valida o denega la zona" — unknown ZIP → zoneStatus PENDING; the bot tells the customer the zone is being validated and learns the outcome through the DELIVERY_ZONE human decision cycle, then re-quotes (approved) or offers pickup (DENIED).
- S6. Checkout quote errors: SHIPPING_QUOTE_EXPIRED and SHIPPING_QUOTE_MISMATCH → re-quote and show the new total for a fresh SÍ; SHIPPING_QUOTE_NOT_FOUND, PACKAGING_DATA_MISSING, SHIPPING_QUOTE_UNAVAILABLE → specific customer replies, nothing created.
- S7. Quote ETA `{days: null, reason: "STOCK_PENDING"}` → the summary says the delivery date depends on restock (existing RESTOCK flow).
- S8. A zone resolved after the WhatsApp 24h window is announced with an approved utility template (chatbot-owned).
- S9. No feature flag guards any of this (owner S1 of always-on-features).

## Tasks

- U1 [S1,S3] `createShippingQuote` port, zod request/response DTOs (destination XOR, zoneStatus enum, eta), HTTP adapter, in-memory fake. Route: gentle-ai-worker. Commit: 3a4c7a3.
- U2 [S2,S6] Checkout DTO `shipping: {quoteId} | {mode:'pickup'}`; new quote error codes mapped in client and minimal-order.service. Route: gentle-ai-worker. Commit: 72b68ce.
- U3 [S2,S3] `minimalCart.shipping` schema with address/cart pin; MinimalShippingService over U1; currentShipping requires a live quoteId. Commit: —
- U4 [S4,S5,S6,S7] Conversation: tool/prompt without approval, pickup branch, PENDING/DENIED replies, summary with carrier and ETA, new shipping-required reply. Commit: —
- U5 [S2] Delete per-quote approval (minimal-shipping-approval, human-handoff shipping_approval branches, dispatcher ops commands). Commit: —
- U6 [S1,S9] Delete Skydropx provider, measured demo profile, local credit rule, legacy getShippingQuote tool and sale-flow shipping; drop SHIPPING*QUOTES_ENABLED, SHIPPING_DEMO_PARCEL_PROFILE_JSON, SKYDROPX*\*, MINIMAL_CATALOG_SHIPPING_ENABLED; preflight and docs. Commit: —
- U7 [S5] DELIVERY_ZONE route: reservation CHECK migration, ledgers, decision DTO, coordinator/poller cloned from EXPIRATION, customer texts (blocked: backend T1 exact names; key model agreed in L4). Commit: —
- U8 [S8] `sendTemplate` on WhatsappSenderPort and Meta adapter; late-zone template use (activation blocked: owner creates and Meta approves the template). Commit: bec2b84 (port and adapter, no caller).
- U9 [S1-S8] E2E against the live backend and runbook (blocked: backend endpoints in main). Commit: —

## Log

- L1 (2026-11-05, owner, verbatim): "2. Envios perros y skydropx son las dos opciones que hoy se ocupan como envios con externos, se usa la que sea mas barata, punto y no, no tengo conexion a su api. 3. Si lo recomiendas si. 4. Mira, todo en el sistema se maneja por permisos, asi que los usuarios del sistema que validen deben de tener los permisos necesarios para validar eso, lo que tengo en mente es que el chatbot inserte algo en el sistema, una validacion pendiente, que se mande un correo al usuario del sistema para notificarle que tiene una validacion, el usuario se mete al sistema, observa la validacion pendiente y valida o denega la zona, me sigues??"
- L2 (2026-11-05): Backend relayed owner decisions: zone approval decides deliverable+type+cost; one package per order with smallest standard box; per-quote approval removed (signed quoteId); credit per unit >$500 after discounts; always cheapest carrier. Credit on SURCHARGE provisional and configurable.
- L3 (2026-11-05): Explorer map: RESTOCK/EXPIRATION use per-route ledgers and a reservation keyed by sender turn; backend dedupes DELIVERY_ZONE per ZIP — key model open. WhatsApp sender supports text only (no Meta templates).
- L4 (2026-11-05): Backend accepted the DELIVERY_ZONE key model: one open decision per ZIP with many requesters; intake idempotent per chatbot sourceRequestId (sender+turn) and attached as requester; poll and ACK per sourceRequestId; an intake for an already resolved ZIP is accepted and resolved immediately. Exact names arrive with backend docs/delivery-zones.md after its T1.
- L5 (2026-11-05): U1 done in 3a4c7a3 (additive). Leftover: add POST /chatbot-api/shipping/quotes to preflight CLIENT_ROUTES. Worker-chosen strictness beyond the brief (digits-only phone, non-empty neighborhood/municipality/state, canonical ISO expiresAt, non-negative ETA) to re-check against backend docs.
- L6 (2026-11-05): U2 done in 72b68ce. Leftovers: legacy POST /sales wireShipping + create-sale.tool still send chargeCents/approvalId (U6 deletes); currentShipping still requires approval.state==='approved' and snapshot carries chargeCents/approvalId, used by summary, fingerprint and sameMinimalOrder (U3/U5); MINIMAL_ORDER_SHIPPING_REQUIRED_REPLY wording (U4); pickup not wired (U4); free shipping now also sends its quoteId.
- L7 (2026-11-05): U8 port and Meta adapter in bec2b84. Proposed template for the owner: utility `zona_entrega_revisada`, es_MX, body "Hola, ya revisamos la entrega a su código postal {{1}}. Responda a este mensaje para continuar con su pedido."
