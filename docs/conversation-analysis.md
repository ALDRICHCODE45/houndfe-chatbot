> Ported from `houndfe-backend/openspec/changes/archive/2026-06-11-whatsapp-ai-chatbot/conversation-analysis.md` on 2026-06-22. This remains the canonical conversational-logic document (R1–R16 flows, state machine, edge cases, tone).

# Real Conversation Analysis — whatsapp-ai-chatbot

Source: anonymized real WhatsApp conversations from the HoundFe main account, analyzed purchase by purchase with the owner. This is a LIVING document — new conversations append new findings.

Status: 1 conversation analyzed (2026-05-26..28, Diamond Naturals sale to San Luis Potosí).

---

## Conversation #1 — Product photo inquiry → quote → sale → transfer receipt

### Observed flow

1. Customer greets; auto-reply template fires; human agent ("Andrea") introduces herself.
2. Customer sends a **product photo** (Diamond Naturals Light Adult Dog 30 lbs) and asks for price **including shipping** to San Luis Potosí, SLP.
3. Agent identifies the product from the image, checks the system, finds an **active promotion**, and quotes: `Diamond Naturals Light Adult Dog Lamb & Rice 13.5 kg: $1,372.00`.
4. Agent asks for **postal code** to quote shipping.
5. Customer sends CP `78183` and increases order to 2 units "to take advantage of the promotion".
6. Agent replies: shipping is **$70.00 for both bags**.
7. Agent lists payment methods: **Transferencia, Depósito, Tarjeta de Crédito/Débito via Link EVO**.
8. Next day, agent requests order data: **Nombre, Dirección completa, Referencias visuales del domicilio, Teléfono, Método de pago**.
9. Customer provides all data. Agent additionally asks for a **phone number reachable by the carrier** (customer had unknown numbers blocked — real edge case: customer agreed to unblock).
10. Agent sends **order confirmation summary**: delivery date range, full address, products with unit price, shipping cost, total to transfer ($2,814.00 = 2 × $1,372 + $70).
11. Agent sends **bank details**: AFIRME, HUN F.E. COMERCIALIZADORA SA DE CV, CLABE + account number.
12. Agent requests the **transfer receipt** showing reference number, amount, and date.
13. Customer sends receipt screenshot next day. Notes she used an auto-generated reference because none was provided (minor process gap).

### Shipping pricing rule (CONFIRMED by owner)

The agent quotes on Envíos Perros AND Skydropx (and checks Amazon), then applies:

- Every product priced **> $500 MXN** carries a **$120 MXN shipping credit**.
- Credits SUM across items: 2 qualifying bags → $240 credit.
- If the best carrier quote ≤ total credit → **shipping is free**.
- If the quote exceeds the credit → customer pays **only the excess** (quote $310 − credit $240 = **$70** charged).
- **Amazon path**: if Amazon delivers to the address and package ≤ 25 kg, they ship via Amazon and it is usually free for the customer.
- **CDMX metro area**: shipping is free ONLY in certain zones of the metro area, NOT all of it. Zone list: **PENDING from owner**.

### Human-in-the-loop requirements (owner mandate, at least for v1)

The owner explicitly does NOT want to fully delegate these to the bot initially:

1. **Shipping quote approval**: before quoting the customer, the bot must message a human with a digest: products, active promotion, Envíos Perros quote, Skydropx quote, and the question "is it free on Amazon?". The human may take time to answer (manually checks Amazon). Only after the human replies does the bot pick the carrier, quote the customer, and proceed.
2. **Out-of-stock escalation**: when the system shows no stock, the bot asks a human: "A customer wants X but system shows no stock — is a restock arriving soon, or do I tell them it's unavailable?" (restocks often arrive within days and agents know it informally).

Implication: the bot needs an **internal human-notification channel** (likely a separate WhatsApp conversation, group, or dashboard) with asynchronous request/response semantics and conversation state that survives long waits.

### Returning customer flow (owner requirement)

A customer may return weeks later saying "quiero el mismo pedido de la última vez". The bot must:
- Recognize the customer by phone number.
- Retrieve last order + stored delivery data (name, address, references, CP, phone, payment method).
- Ask only for CONFIRMATION ("¿sus datos siguen siendo correctos?") instead of re-collecting everything.
- Implication for `chatbot-api-foundation`: customer profile + order history lookup by phone is a core API need.

### Information gaps customers ask about that the system does NOT hold

- **Expiration dates** (fechas de caducidad) of products — not in the POS. v1 answer: escalate to human; possible v2: add optional product metadata.

### POS sale lifecycle question (OPEN — for design)

Owner is unsure how the bot-driven sale should map to the existing sales module. Hypothesis: draft → confirmed (paid) → plus a delivery/"Enviada" (shipped) state. Current sales module states must be audited in design; a delivery-tracking concept (carrier, tracking ref, estimated delivery date) likely needs to be added. Estimated delivery time comes from the carrier API (Envíos Perros / Skydropx) or from the human when shipping via Amazon.

### Tone and conversation style notes

- Warm, professional Mexican Spanish with moderate emoji use (🤓😊🤗).
- Agent persona has a name ("Andrea") — decide whether the bot keeps a persona name and discloses being a bot.
- Structured, bulleted order summaries before payment — keep this format.
- Auto-greeting template already exists on the account.

---

## Extracted requirements backlog (feeds future slices)

| # | Requirement | Slice affected |
|---|---|---|
| R1 | Identify product from customer photo against catalog | image-recognition slice |
| R2 | Quote shipping via Skydropx (+ Envíos Perros later) by CP, weight, package | shipping-quotes slice |
| R3 | Apply $120-per-item->$500 shipping credit rule; charge only excess | shipping-quotes slice |
| R4 | Amazon shipping path requires human check (≤25 kg) | shipping-quotes + handoff slices |
| R5 | Free-shipping zone list for CDMX metro (pending owner) | shipping-quotes slice |
| R6 | Human approval gate for shipping quotes (async, slow human) | handoff slice |
| R7 | Out-of-stock → human restock query before answering customer | handoff slice |
| R8 | Collect order data: name, address, visual references, phone, payment method | order-creation slice |
| R9 | Carrier-reachable phone validation (blocked-numbers edge case) | order-creation slice |
| R10 | Order confirmation summary message (structured) | order-creation slice |
| R11 | Bank details message + receipt request (reference, amount, date) | payment-confirmation slice |
| R12 | Returning customer: lookup by phone, confirm stored data, reorder | chatbot-api-foundation + order-creation |
| R13 | Promotions awareness in quoting | chatbot-api-foundation (price/promo endpoint) |
| R14 | Expiration-date questions → human escalation (info not in system) | handoff slice |
| R15 | Sale lifecycle: paid + shipped states, carrier + tracking + ETA | chatbot-api-foundation / sales module gap |
| R16 | Payment methods include card via "Link EVO" — scope decision pending | payment-confirmation slice |
