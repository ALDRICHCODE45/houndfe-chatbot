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
- S3 Emojis. Owner answer: "Pocos, solo en títulos (recomendado)" — 🧾 summary, 🚚 shipping, ✅ order created; customers the bot already treats without emojis get none.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| F1 | S1 | Inventory (explorer, read-only): every server-owned customer message template (file:line, current text, which flow), the interactive texts and their text fallbacks, the per-customer emoji style policy (applyCustomerStyle / customerAllowsEmojis), the model's formatting guidance in prompts, the regexes that read or reject the bot's own text (IMITATED_CONFIRMATION, summary heading detection), and the tests pinning exact texts | in progress | — |
| F2 | S2, S3 | Shared WhatsApp formatting helpers (bold, italic, section, line item, money) + the order summary in the S2 layout; emoji stripped per customer style; the regexes that recognise the summary keep working | pending (after multi-pet T5a) | — |
| F3 | S2, S3 | The other server-owned messages from the F1 inventory (cart, payment details, shipping quote, order created, backorder notices, pet questions, receipts) in the same style | pending | — |
| F4 | S1, S2 | Model replies: formatting guidance in the system prompt (short paragraphs, product lists one per line with price, bold only for names/prices, no markdown headings or tables WhatsApp cannot render); pinned prompt tests updated | pending | — |

## Log

- L1 (2026-11-25, user): "Y me gustaria que ya de paso, revises el "formato" en el que se envia el mensaje, que se envie bonito, me explico?? con el texto acomodado, con el texto bien acomodado, etc.. me sigues??"
- L2 (2026-11-25, owner answers): scope "Mensajes del sistema (recomendado)" + "Respuestas del modelo"; style "Secciones con negritas (recomendado)" (preview in S2); emojis "Pocos, solo en títulos (recomendado)". Current summary for reference: «Resumen de su pedido:» then «• <producto>: 1 × $X; importe $Y (promoción…)», «Total de productos», «Entrega a: <todo en una línea>», envío, «Total a pagar», «Responda "SÍ"…» (src/llm-agent/domain/minimal-order-confirmation.ts renderMinimalOrderSummary).
