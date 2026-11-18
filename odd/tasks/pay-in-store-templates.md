# Pay in store: notices outside the 24 h window, shortened holds, expired with payment

Branch `feat/pay-in-store-templates`. Builds on odd/tasks/pay-in-store.md (S3) and the backend change on `feat/hold-expire-now` (not deployed yet).

## Specs

- **S1 — Owner (verbatim):** «Sí, crear las plantillas» (Meta utility templates so pay-in-store notices reach customers even after the 24 h window). Owner via the frontend session: «vale la pena pensar si cuando la venta se cancela en estas condiciones, sea "venta cancelada" pero tambien "plazo vencido" … y no se si el bot le deba mandar algo al cliente en ese momento la verdad, puede ser que la mejor opcion sea que si».
- **S2 — Backend contract (additive, final 2026-11-18):** `sale.pickup_extended` adds `previousHoldUntil` (ISO) and `direction: 'EXTENDED' | 'SHORTENED'` (equal → EXTENDED). New type `sale.pickup_expired_review {saleId, folio, holdVersion, conversationRef|null, branchName}`: one per sale+holdVersion when the hold expires with a partial payment or pending receipt and the sale is NOT cancelled (sweep and manual POST /sales/:id/hold/expire). `branchName` added to all four sale.pickup_* payloads. Same ACK rules as the other sale.* items (PROVIDER_ACCEPTED, DELIVERY_UNKNOWN, STALE; not deferrable). Until deployed, the new fields may be absent: parse them as optional.
- **S3 — Texts inside the 24 h window** (free text, usted; tú via customer-style):
  - extended with direction EXTENDED (or direction absent and previousHoldUntil absent): today's «Le ampliamos el plazo de su pedido {folio}: ahora puede recogerlo y pagarlo hasta el {fecha y hora}.»
  - direction SHORTENED (or previousHoldUntil later than the new holdUntil): «Actualizamos el plazo de su pedido {folio}: ahora puede recogerlo y pagarlo hasta el {fecha y hora}.»
  - expired_review: «El plazo de su pedido {folio} venció. Como tiene un pago registrado, alguien del equipo le va a contactar para cerrarlo.»
  - reminder and expired: today's texts unchanged.
- **S4 — Templates outside the 24 h window.** Behind `PAY_IN_STORE_TEMPLATES_ENABLED` (envBoolean, default false; the owner turns it on once Meta approves). Language `es_MX`, category utility, exact names and body parameters:
  - `apartado_recordatorio` (reminder): {{1}} folio, {{2}} deadline text («hoy a las 4:18 p. m.» / «mañana a las …» / date, same formatter as the free text), {{3}} store text (branch name + address from the stored pickup location; fallback `branchName`).
  - `apartado_vencido` (expired): {{1}} folio.
  - `apartado_plazo_actualizado` (extended, both directions): {{1}} folio, {{2}} «el {fecha y hora}» (same formatter), {{3}} store text.
  - expired_review: no template (staff contacts the customer) → STALE WINDOW_CLOSED outside the window, as today.
  With the flag off, or a send refused by Meta for a template reason (e.g. template not approved / missing), behaviour is today's: STALE WINDOW_CLOSED, warn log with the Meta code, no retry loop. Template sends reuse the existing template sender path (as `zona_entrega_revisada` in src/delivery-zones) and are mirrored like other template sends.
- **S5 — Evidence.** RED per rule; existing pay-in-store tests green; parser accepts payloads with and without the new fields; docs (env table, minimal-order-placement «Pay in store», human-request-feed) updated with the template names and bodies.

## Tasks

| ID  | Specs | Route                                   | Commit |
| --- | ----- | --------------------------------------- | ------ |
| T1  | S2–S5 | worker: templates, direction, expired_review | |

## Log

- **L1 (2026-11-18):** owner approved templates; template bodies given to the owner to create in Meta (usted, utility, es_MX): `apartado_recordatorio` «Le recordamos que su pedido {{1}} está apartado hasta {{2}}. Puede recogerlo y pagarlo en {{3}}. Si no pasa antes de esa hora, el pedido se cancela.»; `apartado_vencido` «Su pedido {{1}} se canceló porque venció el plazo para recogerlo y pagarlo en tienda. Si todavía lo quiere, responda a este mensaje y con gusto le ayudamos a pedirlo de nuevo.»; `apartado_plazo_actualizado` «Actualizamos el plazo de su pedido {{1}}: ahora puede recogerlo y pagarlo hasta {{2}}. Lo esperamos en {{3}}.» Backend contract in S2.
