# Restock backorder: the offer and scheduling (T4: S1, S2, S14)

After the team's RESTOCK estimate reaches the customer, the bot offers to
schedule the order. Accepting creates a backorder in the backend
(`POST /chatbot-api/backorders`); nothing is paid until the product arrives.
Contract: [`contracts/restock-backorder-bot-contract.md`](contracts/restock-backorder-bot-contract.md).
Tracker: `odd/tasks/restock-backorder.md`. The arrival notice, confirm and
checkout (T5), the ETA slip and cancel (T6) and the feed (T8) are other tasks.

## Flow

```
RESTOCK poller ── estimate + [Sí, apártamelo] [No, gracias] ─▶ customer
        │                                                          │
        └─ Meta accepted ─▶ arm gate `backorder_offer` (24 h)       │
                                                                    ▼
              next customer message ─▶ MinimalBackorderOfferService (no LLM)
                 tap / «sí»  ─▶ count known? ── no ─▶ «¿Cuántas piezas le aparto?» ─▶ a number
                                              └ yes ─▶ POST /chatbot-api/backorders ─▶ reply
                 tap / «no»  ─▶ «Entendido. ¡Que esté muy bien!»  (gate spent)
                 anything else ─▶ gate spent, the normal turn answers
```

### 1. The estimate message

`RestockApplicationCoordinator.format()` (`src/human-decisions/application`),
only for `PROVIDE_RESTOCK_ESTIMATE`, now ends with the offer instead of
«¡Que esté muy bien!»:

> … La fecha puede variar. ¿Quiere que se lo apartemos en cuanto llegue? Le aviso y no paga nada hasta entonces.

It goes out with two reply buttons (`sendInteractive`), or as plain text with
the same wording when the sender cannot send buttons. The negative estimate
(`REPORT_RESTOCK_ESTIMATE_UNAVAILABLE`) is unchanged: plain text, no offer.
Style (usted / tú) is applied by `applyCustomerStyle`; the button titles are
the same in both.

| Button | Title | Id |
| --- | --- | --- |
| schedule | Sí, apártamelo | `backorder:schedule:<decisionId>` |
| decline | No, gracias | `backorder:decline:<decisionId>` |

Ids are parsed by `parseInteractiveReplyId` (`customer-reply.ts`) into
`{ kind: 'backorder', action, reference }`; the reference must be a UUID.
A tapped «Sí, apártamelo» reaches the turn as the neutral text `SÍ`: the title
itself reads as a tú imperative to the style detector and would flip a usted
customer to tú.

HOLD / ACK semantics of `applyOnce` are untouched. The send is the same single
claimed attempt; a rejected interactive send holds like a rejected text (it is
**not** retried as text, the buttons may already be out). The stated count is
read before the claim (nothing async between the final check and the send).
The gate is armed right after Meta accepted the message and before the
acceptance is recorded; an arm that fails is only logged, so it can never
break `finish()`.

### 2. The gate `backorder_offer`

Durable, one per sender, TTL 24 h (`conversation_gates`, migration
`5500000000000_conversation_gate_backorder_offer.js`; see
[`conversation-gates.md`](conversation-gates.md)).

```json
{ "decisionId": "uuid", "productId": "uuid", "variantId": "uuid|null",
  "productName": "…", "estimatedAt": "ISO UTC", "statedQuantity": 3,
  "stage": "offer|ask_quantity|ask_name", "quantity": null }
```

`stage` / `quantity` are the bookkeeping of the multi-step answer; the
documented offer payload is the first six fields.

**Bridge.** The coordinator lives in `HumanDecisionsModule` and runs outside any
turn; the gate belongs to the LLM agent module. `BackorderOfferRegistry`
(`src/backorders/domain/backorder-offer.ts`, provided by `BackordersModule`) is
a late-bound holder like `DeliveryZoneResumeRegistry`: `LlmAgentModule`
registers `MinimalBackorderOfferService` at boot, the runtime hands the
coordinator `backorderOffer: () => registry.current()`. The capability has two
methods: `statedQuantity(sender, product, variant)` and `arm(input)` (resolves
`true` once the row is durable). The offer carries no origin message id, so
nothing but a real later customer message can answer it.

**Answering** (first thing in `MinimalCatalogAgentService.handleTurn`, after the
forget-my-data check, no model call):

| Customer | Result |
| --- | --- |
| tap «Sí, apártamelo» or `classifyConfirmationReply` = accept | schedule (below) |
| tap «No, gracias» or decline | «Entendido. ¡Que esté muy bien!», gate spent |
| any other message or button | gate spent, the normal turn continues |
| a backorder button of another decision, or with no live offer | the generic stale-button reply; a live offer is not spent |

The gate is spent with `ConversationGates.claim` (atomic `consume`), so a double
tap or two processes schedule once. A retryable failure puts the offer back with
its **original** expiry.

### 3. Quantity (S14)

> «La que dijo al pedir; si no dijo, preguntar (recomendado)»

The RESTOCK request stores no quantity (`requestedQuantity` is always `null`),
so the count is captured on the chatbot side:

1. When the RESTOCK question is prepared (`MinimalRestockRequestService.prepare`)
   the count the customer stated in that turn is read with
   `statedPurchaseCount(text)` (`application/backorder-quantity.ts`): the cart's
   `statedUnitCount` + `statesCountToBuy`. Presentation numbers, measurements,
   prices and ages are not counts; several counts are ambiguous; **a count of
   one is not carried** (like the cart: «una» is mostly an article), so the bot
   asks. For the options-message offer (S13d) the count is read from the turn
   that rendered the options, not from the bare «sí».
2. It rides the durable `restock_pending` row (5-minute question) as
   `statedQuantity`.
3. When the request is recorded it is written to the gate `backorder_quantity`
   (48 h, keyed by product / variant topic, never erased by a later request
   without a count). The estimate arrives hours later, so it must outlive the
   question; it is the smallest durable place that needs no table and no change
   to the human-decision reservation (whose `intake` has exactly ten keys).
4. When the estimate is sent, the coordinator reads it and `arm` copies it into
   the offer (`statedQuantity`) and removes the note.

With a count: the yes schedules it and the confirmation states it. Without one:
the yes is answered with «¿Cuántas piezas le aparto?» (stage `ask_quantity`);
the next reply with a single number 1–999 schedules it; **anything else ends the
offer** (spent, the normal turn answers it); «no» declines.

### 4. Scheduling

`MinimalBackorderOfferService` → `BackorderClient` (`src/backorders`, a port
apart from `ChatbotApiClient`, HTTP adapter `BackorderHttpClient` with
`createBackorder`, `getBackorder`, `listBackorders`, `cancelBackorder`).

- Customer: `getCustomerCheckoutContext(52, phone, { limit: 1 })`. `unique` →
  `{ mode: "existing", customerId }`. `not_found` → `createIfAbsent` with the
  profile's `preferredName`, else the first word of the WhatsApp contact name;
  if neither is a plausible name the bot asks «¿A nombre de quién lo agendo?»
  (stage `ask_name`, 1–3 plain words) and records the answer as the preferred
  name. `ambiguous` (shared number) is never guessed: honest failure, no POST.
- Request: `sourceDecisionId = decisionId`, `variantId`, `quantity`, phone. The
  reference price is **not** sent (`expectedReferencePriceCents` omitted): the
  server computes it.
- `X-Idempotency-Key: backorder:<decisionId>:<senderId>`, stable per offer: a
  retry replays the same backorder (`200`), never a second one.

### 5. Replies (usted copy; tú pairs in `customer-style.ts`)

Dates are converted from UTC to America/Mexico_City; money is `$1149.00 MXN`.

| Backend | Reply |
| --- | --- |
| 201 / 200 | «Listo, quedó agendado su pedido {folio}: {quantity} × {product} a {price} c/u. Le aviso en cuanto llegue (aprox. el {27 de noviembre}); no paga nada hasta entonces.» The date is omitted when the estimate is already past. The 24 h reservation is **not** mentioned (it ships with the backend's arrival matching). |
| 409 `STOCK_AVAILABLE_NOW` | «¡Buenas noticias! Ya tenemos {product} disponible. ¿Cuántas piezas le agrego al carrito?» The existing cart pending-add mechanism needs a verified catalog session with selection references, which the notice does not have, so this is not a cart write: the model's next turn searches the catalog (the reply is in the transcript). |
| 409 `BACKORDER_DUPLICATE` | «Ya tiene agendado su pedido {folio} de {product}. Le aviso en cuanto llegue.» (folio from `GET :id`; without it «Ya tiene agendado ese producto…») |
| 5xx, 429, timeout, `IDEMPOTENCY_KEY_IN_FLIGHT`, lookup failure | «No pude agendar su pedido en este momento. Intente de nuevo en unos minutos.» The offer stays armed. |
| any other failure (400, other 409/404/422, 403, ambiguous phone, non-Mexican number) | «No pude agendar su pedido por ahora.» The offer is spent. |

Failures are logged as `backorder schedule failed: status=… code=…` (never the
body). No reply promises anything the backend did not confirm.

## Deploy notes

- Apply `5500000000000_conversation_gate_backorder_offer.js` before the new
  chatbot version starts: it widens the `gate_kind` CHECK; without it the arm
  fails (logged) and the offer is unanswerable. Its `down` refuses while an
  unexpired backorder gate exists.
- Backend T1 must be deployed and the chatbot credential must carry
  `backorders:create`, `backorders:read` and `backorders:cancel`, or every «sí»
  answers «No pude agendar su pedido por ahora.».
- The estimate message now always carries the offer wording; if the offer
  capability is not registered (it always is in production) nothing is armed.
