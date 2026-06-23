# Chatbot Business Requirements

> Distilled from the houndfe-backend archive (exploration, proposal, design, conversation-analysis) on 2026-06-22.
> For conversational-logic details (R1–R16 flows, state machine, edge cases, tone), see [`conversation-analysis.md`](./conversation-analysis.md).
> For the API contract the chatbot consumes, see `AGENTS.md` Section 4.

---

## 1. Business Goal

HoundFe is a pet-products retailer (CDMX, Mexico). Human WhatsApp agents currently answer product questions, quote shipping, and close sales — but only during business hours with non-trivial error rates. The chatbot must **augment and eventually replace** human agents, closing sales 24/7 through WhatsApp using HoundFe's existing POS backend as the source of truth.

The chatbot is **HoundFe-only** (single tenant), not a multi-merchant SaaS feature.

---

## 2. Core Flows

### 2.1 Product Discovery

1. Customer sends a greeting; auto-reply template fires; bot introduces itself.
2. Customer asks about a product — via **text query** or **product photo**.
3. Bot searches the catalog and presents matching products with current price (including any active promotion).
4. If the customer sends a photo, the bot identifies the product by extracting brand/type/size/animal from the image and searching the catalog.
5. Bot can answer product questions (size, ingredients, etc.) from catalog data.

### 2.2 Cart Building

1. Customer selects product(s) and quantity.
2. Bot validates stock availability for each item.
3. If out of stock → **human escalation** before answering the customer (see §7).
4. Bot maintains a running cart with line items, unit prices, and applied promotions.
5. Customer can modify cart at any time (add/remove/change quantity).

### 2.3 Shipping Quote

1. Bot asks for **postal code** (código postal).
2. Bot requests a shipping quote from the carrier aggregator (Skydropx, and optionally Envíos Perros).
3. Bot applies the shipping credit rule (see §5.1) to compute the amount the customer pays.
4. **Before quoting the customer**, the bot requests **human approval** — sending a digest with: products, active promotions, carrier quotes, and the question "¿es gratis por Amazon?" (see §7).
5. Only after the human responds does the bot present the shipping cost to the customer.

### 2.4 Order Data Collection

Bot collects, in conversation:

| Field | Notes |
|-------|-------|
| Nombre completo | Full name |
| Dirección completa | Street, ext/int number, neighborhood, municipality, city, state, postal code |
| Referencias visuales del domicilio | Visual landmarks for the carrier |
| Teléfono | Contact phone |
| Teléfono alcanzable por la paquetería | A phone the carrier can actually reach — the customer may have unknown numbers blocked |
| Método de pago | Transfer, deposit, or card (Link EVO) |

### 2.5 Order Confirmation

1. Bot sends a **structured order summary** before payment:
   - Delivery date range
   - Full address
   - Each product with unit price
   - Applied promotions
   - Shipping cost
   - **Total to pay**
2. Customer confirms.

### 2.6 Payment (Transfer — v1)

1. Bot generates a unique **payment reference** for the sale.
2. Bot sends **bank details**: bank name (AFIRME), legal entity (HUN F.E. COMERCIALIZADORA SA DE CV), CLABE, and account number, plus the reference.
3. Bot asks the customer to send a **transfer receipt** (screenshot) showing reference, amount, and date.
4. Customer sends the receipt image.
5. Bot attaches the receipt to the sale and **notifies a human agent** for confirmation.
6. Human verifies the transfer in the bank app and confirms payment in the admin panel.
7. Sale transitions to PAID.

> **v1 constraint**: No automated receipt validation, OCR, or bank reconciliation. The human confirms manually.

### 2.7 Returning Customer (Reorder)

1. Customer returns (possibly weeks later) and says something like "quiero el mismo pedido de la última vez".
2. Bot recognizes the customer by phone number.
3. Bot retrieves the last order and stored delivery data (name, address, references, postal code, phone, payment method).
4. Bot asks for **confirmation only**: "¿Sus datos siguen siendo correctos?"
5. If confirmed, bot pre-fills the cart and skips data collection. If not, bot updates the changed fields.

---

## 3. Business Rules

| # | Rule | Details |
|---|------|---------|
| BR-1 | Promotions are applied automatically | The bot evaluates active `AUTOMATIC` promotions against cart items and shows the discounted price. Complex promotion types that cannot be auto-evaluated return `needs_human_review` and escalate. |
| BR-2 | Sale channel is `ONLINE` | All bot-created sales use the `ONLINE` channel (distinct from `POS`). |
| BR-3 | Sale lifecycle: DRAFT → CONFIRMED → SHIPPED → DELIVERED | Bot creates a DRAFT, charges it to CONFIRMED once payment is confirmed, then delivery progresses through SHIPPED (with carrier, tracking ref, ETA) to DELIVERED. |
| BR-4 | Idempotency | Bot sale creation uses an idempotency key to prevent duplicate orders from retried messages. |
| BR-5 | Bot persona | Warm, professional Mexican Spanish with moderate emoji use (🤓😊🤗). The agent persona has a name ("Andrea") — open decision whether the bot keeps a named persona and whether it discloses being a bot. |
| BR-6 | Order summaries are structured | Before payment, the bot sends a bulleted summary (not prose). This matches the existing human-agent format. |
| BR-7 | No internal data exposed | The bot must NEVER reveal: purchase cost, gross cost, margin %, supplier info, tenant IDs, or internal business metrics. |
| BR-8 | LLM spend cap | Monthly LLM API cost must stay under **US $200**. Use cheaper models for intent classification; reserve capable models for image recognition and ambiguity resolution. |
| BR-9 | 24-hour WhatsApp window | After a customer messages, the bot has 24 hours for free-form replies. After 24 hours, only pre-approved **message templates** can be sent. Templates must be planned for: order confirmation, shipping update, payment reminder, follow-up. |

---

## 4. Pricing & Shipping Rules

### 4.1 Shipping Credit Rule (CONFIRMED by owner)

- Every product priced **> $500 MXN** carries a **$120 MXN shipping credit**.
- Credits **sum** across items: 2 qualifying items → $240 credit.
- If the best carrier quote ≤ total credit → **shipping is free**.
- If the quote exceeds the credit → customer pays **only the excess**.

**Worked example**: 2 bags at $1,372 each → $240 credit. Best quote = $310. Customer pays $310 − $240 = **$70**.

### 4.2 Amazon Shipping Path

- If Amazon delivers to the customer's address AND the package weighs ≤ 25 kg, HoundFe ships via Amazon (usually free for the customer).
- This check **requires a human** — the bot cannot query Amazon programmatically. Bot asks the human: "¿es gratis por Amazon?"

### 4.3 CDMX Metro Free Shipping

- Shipping is free **only in certain zones** of the CDMX metro area — NOT all of it.
- **Zone list: PENDING from the owner.** Bot cannot apply this rule until the zone list is provided.

### 4.4 Carrier Quoting

- Primary carrier aggregator: **Skydropx** (sandbox available, strong Mexican market).
- Secondary: **Envíos Perros** (used historically by agents — may or may not have an API).
- Quotes require: origin postal code, destination postal code, package weight, and dimensions.
- Quotes expire — design must lock a quote with a TTL and re-quote at checkout if expired.

---

## 5. Payment Flow (v1)

| Step | Actor | Action |
|------|-------|--------|
| 1 | Bot | Generates unique payment reference for the sale |
| 2 | Bot | Sends bank details + reference to customer |
| 3 | Customer | Transfers funds, including the reference in the concept field |
| 4 | Customer | Sends receipt screenshot to bot |
| 5 | Bot | Attaches receipt image to the sale; notifies human agent |
| 6 | Human | Verifies transfer in bank app; confirms in admin panel |
| 7 | System | Sale transitions to PAID; bot notifies customer |

**Accepted payment methods** (v1):
- **Transferencia** (bank transfer) — primary, fully supported.
- **Depósito** (bank deposit) — same flow as transfer.
- **Tarjeta de Crédito/Débito via Link EVO** — scope decision pending. If supported, the agent sends a payment link; no receipt collection needed.

**Process gap noted**: In the real conversation, no reference was pre-generated — the customer used an auto-generated one. The bot should fix this by always providing a reference upfront.

---

## 6. Stock Behavior

- Bot checks stock availability before adding items to the cart.
- If stock = 0, the bot does NOT immediately tell the customer "unavailable." Instead, it escalates to a human (see §7) because restocks often arrive within days and agents know informally.
- The bot asks the human: "A customer wants X but the system shows no stock — is a restock arriving soon, or do I tell them it's unavailable?"

---

## 7. Human Handoff

### 7.1 Mandatory Escalation Triggers

| Trigger | Reason |
|---------|--------|
| Shipping quote approval | Human must review carrier quotes + check Amazon before the customer sees a price |
| Out-of-stock items | Human knows about informal restocks |
| Payment confirmation | Human verifies transfer in bank app |
| Customer asks for a human | "Quiero hablar con alguien" or equivalent |
| Expiration date questions | Data not in the system — human must check physically |
| Returns, complaints, warranty | Outside bot scope |

### 7.2 Automatic Escalation Triggers

| Trigger | Condition |
|---------|-----------|
| Low confidence | LLM returns uncertain intent classification |
| Customer frustration | Sentiment detection suggests anger/frustration |
| Transaction failure | Payment issue, stock problem during checkout |
| Stuck conversation | Exceeds N turns without progress |
| Complex promotions | Promotion type cannot be auto-evaluated (`needs_human_review`) |

### 7.3 Handoff Mechanics (v1)

- The bot needs an **internal human-notification channel** (separate WhatsApp group, dashboard, or similar) with **asynchronous request/response semantics**.
- Conversation state must **survive long waits** — humans may take minutes to hours to respond (e.g., checking Amazon manually).
- When handed off, the human takes over the conversation. The bot logs the handoff and the agent assignment.
- The bot can resume the conversation after the human resolves the escalation.

---

## 8. Promotions Handling

- The bot must be **aware of active promotions** when quoting prices.
- Promotion types in the system: `PRODUCT_DISCOUNT`, `ORDER_DISCOUNT`, `BUY_X_GET_Y`, `ADVANCED`.
- Methods: `AUTOMATIC` (applied without human) | `MANUAL` (agent must apply).
- **v1 scope**: Bot auto-evaluates `AUTOMATIC` + `PRODUCT_DISCOUNT` (percentage or fixed discount on matching items). Other types → `needs_human_review` → human escalation.
- Promotions have scheduling (start/end dates, day-of-week restrictions) and targeting (categories, brands, products, customer scope).
- The bot shows the **discounted price** inline when quoting, not the original price with a separate discount line.

---

## 9. Conversation State Machine

```
IDLE → BROWSING → CART_BUILDING → CHECKOUT → SHIPPING → PAYMENT_PENDING → COMPLETED
  ↕        ↕           ↕             ↕          ↕            ↕
HUMAN_HANDOFF (reachable from any state)
```

- **State machine** controls transaction-critical transitions (cart commit, order creation, payment confirmation).
- **LLM agent** handles free conversation within states (product Q&A, recommendations, ambiguity).
- Each conversation tracks: state, cart items, progressively collected customer info, message history (for LLM context), and assigned human agent (if in handoff).

---

## 10. Safety & Guardrails

| Area | Rule |
|------|------|
| Prompt injection | LLM system prompt is hardcoded; customer input is sanitized; LLM cannot directly execute actions — state machine validates every tool call |
| Data leakage | Bot-facing API responses never include cost, margin, supplier, or tenant data. LLM system prompt explicitly forbids discussing internal financials. Post-process LLM responses to catch accidental leaks. |
| Restricted tools | LLM has access to read operations and cart manipulation only. Financial operations are state-machine-controlled. |
| Audit logging | Every message, tool call, state transition, and payment action is logged. Payment actions get dual logging (outbox event + conversation log). |

---

## 11. WhatsApp Channel Constraints

| Constraint | Implication |
|------------|-------------|
| 24-hour service window | After the customer's last message, the bot has 24h for free-form replies. After that, only approved templates. |
| Message templates | Must be pre-approved by Meta. Plan templates for: order confirmation, shipping update, payment reminder, follow-up. |
| Media support | Customers can send photos (product identification), documents, location. Bot must download media via Meta Cloud API. |
| Webhook ordering | Webhooks may arrive out of order — need sequence handling or idempotent processing. |
| Rate limits | Tiered by quality rating: 250 → 1K → 10K → 100K messages/day. |
| Sandbox | Meta provides a test phone number for development; can test with up to 5 numbers. |

---

## 12. Edge Cases

| # | Edge Case | Expected Behavior |
|---|-----------|-------------------|
| E-1 | Customer sends product photo but catalog search returns no match | Bot says "No encontré ese producto exacto — ¿podrías darme el nombre o la marca?" and retries with text search |
| E-2 | Customer has unknown numbers blocked on their phone | Bot asks for a phone number the carrier can reach. Warn customer they may need to unblock unknown numbers for delivery calls. |
| E-3 | Customer returns after 24h WhatsApp window | Bot can only send a pre-approved template message (e.g., greeting/follow-up template). Free-form conversation resumes when customer replies. |
| E-4 | Customer says "quiero el mismo pedido de la última vez" | Returning-customer flow: lookup by phone → retrieve last order → confirm data → pre-fill cart (§2.7). |
| E-5 | Customer asks about expiration dates (fechas de caducidad) | Escalate to human — data is not in the POS system. |
| E-6 | Shipping quote expires before customer confirms | Re-quote at checkout; notify customer if price changed. |
| E-7 | No payment reference was provided (real gap from conversation) | Bot always generates and provides a unique reference upfront — fixes the existing process gap. |
| E-8 | Customer wants to pay by card (Link EVO) | Scope decision pending. If supported, agent sends a payment link instead of bank details. No receipt collection needed. |
| E-9 | Multiple active promotions apply to the same item | Bot evaluates all AUTOMATIC promotions; applies the best one. Complex cases → `needs_human_review`. |
| E-10 | Customer modifies cart after shipping was quoted | Re-quote shipping (weight/dimensions changed). Notify customer of new shipping cost. |
| E-11 | Amazon shipping check takes a long time (human is slow) | Conversation state survives the wait. Bot can send a "Estoy verificando las opciones de envío, en un momento te confirmo" message and resume when human responds. |
| E-12 | Customer sends a doctored receipt image | Human confirms all transfers in v1 — no automated validation. Fraud risk is mitigated by the human gate. |
| E-13 | Bot tries to send a proactive message (order update) outside 24h window | Must use an approved WhatsApp message template. |

---

## 13. Open Product Questions

These items were ambiguous or unresolved in the source documentation. They need answers from the business owner before implementation:

1. **CDMX free-shipping zone list** — which specific zones/postal codes qualify? (Pending from owner.)
2. **Link EVO card payments** — is this in scope for v1? If yes, how is the link generated? Is it manual or API-driven?
3. **Bot persona name** — does the bot keep the "Andrea" persona name? Does it disclose being a bot?
4. **Envíos Perros API** — does this service have a programmatic API, or is it manual-only? Can it be replaced entirely by Skydropx?
5. **Product weight/dimensions data** — is this available in the POS for all products? (Needed for accurate shipping quotes.)
6. **Multi-unit Amazon shipping** — the 25 kg limit applies per package. What happens if an order exceeds 25 kg but could be split?
7. **Returning customer — partial reorder** — what if the customer wants "the same but only one bag instead of two"? Does the bot allow partial cart modifications from a previous order?
8. **Hours of human availability** — when humans are unavailable (nights, weekends), should the bot queue escalations for the next business day, or are some humans on-call?
9. **Sale lifecycle mapping** — exact states for bot-driven sales need to be finalized with the owner (DRAFT → CONFIRMED → SHIPPED → DELIVERED, plus what happens if a sale is cancelled after payment).
