# Message formatting (WhatsApp)

Make every message the customer receives easy to read on a phone: sections, short lines, bold titles, a few emojis in titles.
Applies to server-owned messages (code-rendered) and to model-written replies (prompt guidance). Separate from the multi-pet feature; the order summary is touched by both, so implementation starts after customer pets T5a lands.

## Specs

- S1 Scope. Owner: "Y me gustaria que ya de paso, revises el "formato" en el que se envia el mensaje, que se envie bonito, me explico?? con el texto acomodado, con el texto bien acomodado, etc.. me sigues??". Owner answer: "Mensajes del sistema (recomendado)" and "Respuestas del modelo".
- S2 Style. Owner answer: "Secciones con negritas (recomendado)" — the order summary as shown:
  ```
  *Resumen de su pedido* 🧾

  *Productos*
  • Croquetas Nupec Adulto — 15 kg
     1 × $1,250.00 = *$1,250.00*
     _Promoción Buen Fin: ahorra $125.00_

  *Entrega*
  Ana López
  Av. Reforma 123, int. 4
  Centro, C.P. 06000, CDMX

  *Envío:* DHL Express — sin costo
  *Total a pagar: $1,250.00*

  ¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.
  ```
- S3 Emojis. Owner answer: "Pocos, solo en títulos (recomendado)" — 🧾 summary, 🚚 shipping, ✅ order created. Follow-up owner answer: "Sí, a todos (recomendado)" — title emojis go to every customer; emojis in the rest of the text keep today's rule (only if the customer uses emojis).
- S4 Money. Owner answer: "$1,250.00 (recomendado)" — thousands separator, two decimals, no «MXN».

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| F1 | S1 | Inventory (explorer, read-only) | done: L3 | — |
| F2a | S3, S4 | Shared WhatsApp formatting helpers (bold, italic, section, item line, money «$1,250.00»); title emoji always kept for every customer while body emojis keep the current rule; limitEmojis no longer strips the indentation of item lines; customer-style tests | pending (after multi-pet T5a) | — |
| F2b | S2, S3, S4 | Order summary in the S2 layout: heading constant without emoji (emoji added by the helper), every `.includes(MINIMAL_ORDER_SUMMARY_HEADING)` check and the cart-vs-summary check (:3542) keep working, eval regexes (scripts/eval/conversation-eval.ts:288, scenarios.ts:242), TU_PHRASES pairs, summary under 1024 chars for usual orders | pending | — |
| F3a | S2, S4 | Cart reply, checkout data confirmation, reorder offer (same item-line helper; cart and summary stay consistent) | pending | — |
| F3b | S2, S3, S4 | Payment question and bank details, pay-in-store hold, shipping quote (🚚), order created (✅) | pending | — |
| F3c | S2, S4 | Receipts, backorder notices (skeletons with {placeholders}; Meta templates stay as approved), pet questions and the remaining copy where a layout helps; money format everywhere | pending | — |
| F4 | S1, S2 | Model replies: prompt guidance (system-prompt.ts:57-95, minimal-catalog-agent.service.ts:322/329, sale-flow-instructions.ts:38/70 conflicts with IMITATED_CONFIRMATION), toWhatsAppText keeps item indentation; pinned prompt tests | pending | — |

## Log

- L1 (2026-11-25, user): "Y me gustaria que ya de paso, revises el "formato" en el que se envia el mensaje, que se envie bonito, me explico?? con el texto acomodado, con el texto bien acomodado, etc.. me sigues??"
- L2 (2026-11-25, owner answers): scope "Mensajes del sistema (recomendado)" + "Respuestas del modelo"; style "Secciones con negritas (recomendado)" (preview in S2); emojis "Pocos, solo en títulos (recomendado)". Current summary for reference: «Resumen de su pedido:» then «• <producto>: 1 × $X; importe $Y (promoción…)», «Total de productos», «Entrega a: <todo en una línea>», envío, «Total a pagar», «Responda "SÍ"…» (src/llm-agent/domain/minimal-order-confirmation.ts renderMinimalOrderSummary).
- L3 (2026-11-25): F1 inventory (explorer): ~60 server-owned templates (summary, cart, checkout, payment, pay-in-store, shipping, order created, receipts, backorders ~40, reorder, pets, fallbacks, handoff, scheduling); few use *bold* (catalog option lines) or emoji (😊/😕, button titles ✅/✏️). Constraints: DEFAULT_CUSTOMER_STYLE emojis false and limitEmojis keeps one emoji and strips line indentation when it removes one; tú conversion matches whole usted phrases (TU_PHRASES); buttons attach by `.includes(heading)`; IMITATED_CONFIRMATION still matches a bold summary; eval regexes /^Resumen de su pedido/m break with a leading *; money is «$1250.00 MXN» everywhere; Meta templates (pay-in-store, backorder) fixed; POS mirror and transcript show raw * and _ (not checked whether the POS renders them — ask the frontend agent); interactive body 1024 (longer → text + short body). Owner follow-ups: title emojis for every customer; money «$1,250.00».
