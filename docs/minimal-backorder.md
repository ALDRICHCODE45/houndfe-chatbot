# Restock backorder: the offer and scheduling (T4: S1, S2, S14) and cancel / status (T6: S8)

After the team's RESTOCK estimate reaches the customer, the bot offers to
schedule the order. Accepting creates a backorder in the backend
(`POST /chatbot-api/backorders`); nothing is paid until the product arrives.
Contract: [`contracts/restock-backorder-bot-contract.md`](contracts/restock-backorder-bot-contract.md).
Tracker: `odd/tasks/restock-backorder.md`. The arrival, reminder, expiry and
lost notices (T5a) are in [§8](#8-notices-from-the-feed-t5a-s4-s6-s9-s12-s13-s15);
confirm and checkout (T5b), the ETA slip (T6, S7) are other tasks. The
customer cancel and status from the chat (T6, S8) and the two verify
follow-ups of T4 (retry body, replay status) are described in
[§6](#6-customer-cancel-and-status-from-the-chat-t6-s8) and
[§7](#7-retries-conflicts-and-replays-t6-follow-ups-of-the-t4-verify).

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
  "stage": "offer|ask_quantity|ask_name|retry", "quantity": null,
  "customer": null }
```

`stage` / `quantity` / `customer` are the bookkeeping of the multi-step answer
(`customer` is only written in the `retry` stage, see
[§7](#7-retries-conflicts-and-replays-t6-follow-ups-of-the-t4-verify)); the
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

The two rows that change in T6 (retry and replay) are in
[§7](#7-retries-conflicts-and-replays-t6-follow-ups-of-the-t4-verify); a
`409 IDEMPOTENCY_KEY_CONFLICT` is no longer a plain failure and a replayed `200`
is no longer always «quedó agendado».

## 6. Customer cancel and status from the chat (T6, S8)

`MinimalBackorderManageService` (`src/llm-agent/application`) answers two typed
requests about a **scheduled** restock order, deterministically (no model call;
the only I/O is `BackorderClient.listBackorders` /
`cancelBackorder`). It runs in `MinimalCatalogAgentService.handleTurn` right
after the offer answer and **before** the RESTOCK question and every order
route, because the RESTOCK question's classifier can call a model.

### Trigger (conservative)

`classifyBackorderRequest` (`domain/backorder-requests.ts`) reads the whole
message (accent-free, ≤ 140 chars). A message is ours only when **all** of:

1. It reads as a **cancel** (`cancela`, `anula`, `ya no quiero/necesito …`) or a
   **status** request (`¿cómo va…`, `¿ya llegó…`, `¿cuándo llega…`, `estatus`,
   `¿qué pasó con…`) about an order, **and**
2. the sender is a Mexican WhatsApp number and has an **active** backorder
   (`GET /chatbot-api/backorders?phoneCountryCode&phone&status=WAITING,RESERVED`;
   no active one → `null`, the existing flows answer exactly as before), **and**
3. the wording is **explicit**, or nothing else is in play:

| Wording | Examples | Needs |
| --- | --- | --- |
| explicit | «por reposición», «lo que aparté / agendé / me apartaron», «pedido apartado / agendado / programado», «lo apartado», a `BO-000012` folio; «ver mi pedido por reposición» | an active backorder |
| generic | «ya no quiero el pedido», «cancela mi pedido», «¿cómo va mi pedido?», «¿ya llegó mi pedido?» | an active backorder **and** `competingOrderContext() === false` |

`competingOrderContext` (agent) is true when there is a non-empty **cart**, a
pending **reorder offer** (the bot's latest turn carries one), a pending **order summary**, a pending delivery-data **confirmation** or
**draft**, or a **placed sale** (paid or not). If the check throws it is
treated as true (fails closed). So the generic wording only reaches the backorder
when it is the customer's only order; with an unpaid placed sale the existing
sale path keeps «¿cómo va mi pedido?» unless the text names the restock/apartado
order.

Never a request: a bare `cancela` / `sí` / `no` (the confirmation gates own
them), cart removal (`quita…`, `elimina…`), a product the customer no longer
wants («ya no quiero las croquetas»), a negation («no quiero cancelar»), a
question about generic cancel wording («¿se puede cancelar mi pedido?»), a
previous order («pedido anterior», «la vez pasada»), a bare «ver mi pedido»
(the order summary). A message that is no request never reaches the backend.

**Why it cannot steal the other flows.** The first test is a regex over the
message (no I/O); the other flows' triggers (`isOrderSummaryRequest`,
`isPaymentQuestion`, cart verbs, bare yes/no) are all either excluded by it or
need the backorder to be named. Generic wording is handed back whenever a cart,
summary, draft or placed sale exists, which is exactly when those flows own the
message. The remaining exposure is documented in the risks of the T6 report: a
customer whose only order in this conversation is the backorder, who asks
«¿cómo va mi pedido?» about an older delivered order the conversation does not
know about.

### Cancel

```
«cancela lo que aparté» ─▶ list active ─┬─ 1 ─▶ «¿Cancelo su pedido BO-000012 de 2 × Croquetas…?»  [Sí, cancelar] [No]
                                        └─ n ─▶ «Tiene varios pedidos por reposición. ¿Cuál desea cancelar?» + folios
                                                 (≤ 3 reply buttons titled by folio, 4-10 a list; a typed folio also picks)
tap / «sí» ─▶ POST /chatbot-api/backorders/:id/cancel
```

| Backend | Reply |
| --- | --- |
| 200 | «Listo, cancelé su pedido {folio}.» |
| 409 `BACKORDER_NOT_CANCELLABLE` `{status: CANCELLED}` (a retried cancel) | the same success |
| 409 … `{status: EXPIRED}` | «Su pedido {folio} ya venció, así que no hay nada que cancelar.» |
| 409 … `{status: CONFIRMED}` | «Su pedido {folio} ya está confirmado, así que ya no puedo cancelarlo desde aquí.» |
| anything else (5xx, 404, timeout, 409 without status) | «No pude cancelarlo por ahora.» |
| [No] / «no» / «mejor no» | «Entendido, su pedido {folio} sigue agendado.» |

State of the question (**no new gate kind, no migration**): the confirm/pick
question is process-local with a 5-minute expiry. A tapped button carries the
backorder id (`backorder_cancel:<yes|no|pick>:<backorderId>`) and is
re-verified against the customer's own active list, so it works after a restart
and a button of a backorder that is no longer active is the generic stale reply
(nothing is cancelled). A *typed* yes/pick after a restart is lost (it falls to
the normal turn, never cancels). Any other message or button spends the
question; a typed yes is only the closed confirmation lexicon (`sí`, `ok`,
`cancela`, …), «sí, pero cambia la cantidad» never cancels. A double yes cancels
once.

If the list cannot be read: explicit wording answers «No pude cancelarlo por
ahora» (status: «No pude consultar su pedido por ahora»); generic wording is left
to the other flows. A shared phone (`CUSTOMER_PHONE_AMBIGUOUS`) is never guessed.

### Status

| State | Reply |
| --- | --- |
| WAITING, estimate in the future | «Su pedido {folio} sigue en espera; llega aprox. el {26 de noviembre}. Le aviso en cuanto llegue.» |
| WAITING, estimate in the past | «Su pedido {folio} sigue en espera; estamos confirmando la fecha con el equipo. Le aviso en cuanto llegue.» |
| RESERVED | «¡Ya llegó! Se lo tenemos apartado hasta el {21 de noviembre a las 9:00 a. m.}» (no checkout offer: T5 owns it; past or unknown deadline → «…Estamos confirmando con el equipo hasta cuándo se lo tenemos apartado.») |
| several | «Tiene varios pedidos por reposición:» and one line each, folio named (max 5) |

All dates and times are converted from UTC to America/Mexico_City. The tú
variants are curated pairs in `customer-style.ts`; button titles are the same in
both registers.

## 7. Retries, conflicts and replays (T6, follow-ups of the T4 verify)

**One request body per idempotency key.** The key is
`backorder:<decisionId>:<senderId>`, so the body must never change under it.
When the request was built and failed in a retryable way (5xx, 429, timeout,
`IDEMPOTENCY_KEY_IN_FLIGHT`) the offer is put back in the new stage `retry`
with the **count** and the **customer mode** it carried (`existing` +
`customerId`, or `createIfAbsent` + `firstName`). The next yes replays exactly
that body: no new customer lookup (the customer may exist by now) and no new
count question. The two fields ride the same durable `backorder_offer` payload
(optional `customer`, stage `retry`), so they survive a restart; no migration:
only the `gate_kind` CHECK is closed, not the payload.

**`409 IDEMPOTENCY_KEY_CONFLICT`** (older rows, or any earlier attempt that
built a different body): it means a backorder was already created under the key.
The bot lists the customer's `WAITING,RESERVED` backorders and, if one exists
for this product/variant that was scheduled **after the offer was armed**
(`backorder.scheduledAt ≥ expiresAt − 24 h`), confirms it as scheduled. The list
has no `sourceDecisionId`, so that is the closest proof of «created from this
offer». Otherwise the answer is «No pude agendar su pedido por ahora.» (the
offer is spent; nothing is rescheduled). A lookup that fails keeps the offer for
a retry.

**Replay status.** A `200` replay (or a recovered backorder) is worded by its
status: `WAITING` → the usual «quedó agendado» confirmation; `RESERVED` → the
status reply above; `CANCELLED` → «Su pedido {folio} ya estaba cancelado, así
que no está agendado.»; `EXPIRED` → «Su pedido {folio} ya venció, así que no
está agendado.»; `CONFIRMED` → «Su pedido {folio} ya está confirmado.» A
cancelled or expired backorder is **never** rescheduled automatically here.

## 8. Notices from the feed (T5a: S4, S6, S9, S12, S13, S15)

Backend T2 writes `backorder.*` items into the human request feed; the bot
turns each into one customer notice (`BackorderFeedNoticeService`,
`src/backorders/application/backorder-feed.handler.ts`; copy in
`src/backorders/domain/backorder-notices.ts`). The delivery service sends it as
a BOT message that is never deferred and owns the ACK
([`human-request-feed.md`](human-request-feed.md), "Restock backorder items").
No model is involved: names, folio, price and dates come from the feed item.
Dates are America/Mexico_City, money is `$1099.00 MXN`, and the customer's
stored style (usted / tú) is applied to the fixed copy only (a product or first
name is never rewritten).

| Item | Message (usted) | Buttons (inside the 24 h window) |
| --- | --- | --- |
| `backorder.reserved` | «¡Buenas noticias, {firstName}! Ya llegó su pedido {folio}: {quantity} × {product}{ (variant)}. Se lo apartamos a {finalPrice} c/u hasta el {21 de noviembre a las 9:00 a. m.}. ¿Lo confirmamos?» When `finalPriceCents < referencePriceCents`: «… a {finalPrice} c/u (bajó de precio, antes {referencePrice}) hasta …». No first name: «¡Buenas noticias! …». | [Confirmar pedido] `backorder_confirm:<backorderId>` · [Ya no lo quiero] `backorder_cancel:pick:<backorderId>` |
| `backorder.reservation_reminder` | «Le recuerdo que su pedido {folio} sigue apartado hasta el {fecha y hora}. ¿Lo confirmamos?» | the same two |
| `backorder.reservation_expired` | «Se venció el apartado de su pedido {folio} ({product}).» plus «¿Quiere que se lo vuelva a agendar?» **only when the payload carries `sourceDecisionId`** (backend T4) | with `sourceDecisionId`: [Sí, agéndalo] `backorder_reschedule:<backorderId>` · [No, gracias] `backorder_reschedule_decline:<backorderId>`; without it, none |
| `backorder.reservation_lost` | «Una disculpa, {firstName}: el lote que le apartamos de {product} caducó y no tenemos otro vigente. Su pedido {folio} sigue en primer lugar; le aviso en cuanto llegue (aprox. {27 de noviembre}).» The date is dropped when `estimatedAt` is absent or past. | none |
| `backorder.cancelled_by_staff` (backend T5, may arrive later) | «El equipo canceló su pedido {folio}: {reason}.» The reason is the team's text verbatim (not restyled); without one «El equipo canceló su pedido {folio}.» | none |
| `backorder.eta_updated` / `eta_unavailable` (backend T4) | not sent: ACK `STALE`, decision `BACKORDER_ETA_PENDING` (T6, S7 will handle them) | |
| any other `backorder.*` | ACK `STALE`, decision `UNKNOWN_TYPE` | |

The button ids are the contract with the answering turn: `backorder_cancel:pick`
is T6a's cancel-pick (it leads to «¿Cancelo su pedido …?», id format pinned by a
test against `parseInteractiveReplyId`); `backorder_confirm` and the two
`backorder_reschedule*` ids are T5b's. Button titles are the same in usted and
tú. A text longer than Meta's interactive limit is sent as text first and the
buttons carry a short body («¿Lo confirmamos?» / «¿Quiere que se lo vuelva a
agendar?»).

Not announced: a `reserved` / `reminder` whose `reservedUntil` already passed
when it was planned (a backlog drained late) is `STALE` /
`BACKORDER_OVERTAKEN`; the backend sends the expiry notice itself.

### Window, templates, HUMAN sessions (S9, S13)

| Situation | `reserved` / `reminder` | `expired` / `lost` / `cancelled` |
| --- | --- | --- |
| inside the 24 h window, chat in BOT mode | text + buttons, ACK `PROVIDER_ACCEPTED` | text (+ buttons for a reschedulable `expired`), `PROVIDER_ACCEPTED` |
| window closed, `BACKORDER_TEMPLATES_ENABLED` exactly `true` | the Meta template (below), no buttons | the Meta template; `cancelled_by_staff` has none → `STALE` / `WINDOW_CLOSED` |
| window closed, templates off | ACK **`PROVIDER_REJECTED` `TEMPLATE_NOT_APPROVED`**: the backend alerts staff to call | `STALE` / `WINDOW_CLOSED` |
| chat in HUMAN mode | **`PROVIDER_REJECTED` `HUMAN_SESSION`** (staff are with the customer; the backend alerts them) | `STALE` / `HUMAN_SESSION` |
| Meta refuses the message or template | **`PROVIDER_REJECTED`** `UNREACHABLE` / `TEMPLATE_NOT_APPROVED` | `STALE` |
| uncertain send (timeout, 5xx) | `DELIVERY_UNKNOWN`, never retried | same |

The 24 h window is read from the customer inbound observations (a failed read
throws and the page is read again, never "closed"). A template is sent through
`WhatsappSenderPort.sendTemplate` as a BOT message (mirrored and kept in the
transcript like `apartado_recordatorio`). Templates carry **no buttons**: the
customer answers in text (a reply also reopens the 24 h window). A template
whose parameter would be empty is treated as "no template".

**Unknown customer (`conversationRef` null: none or several mirrored chats).**
The handler asks an optional `resolveConversation(backorderId)` port; nothing is
wired today because `GET /chatbot-api/backorders/:id` names no phone (`BackorderBot`
has no customer phone), so those items are **never sent to anyone**: `reserved` /
`reminder` are `PROVIDER_REJECTED` `NO_CONVERSATION` (staff calls, S13), the
rest `STALE` / `NO_CONVERSATION`. A malformed `conversationRef` is treated the
same. Asking the backend to expose the customer's phone on that endpoint would
make these resolvable.

### Meta templates the owner creates (S9)

Category **UTILITY**, language **Spanish (Mexico) `es_MX`**, body only (no
header, footer or buttons). Create them in Meta WhatsApp Manager with these
names (or set `BACKORDER_TEMPLATE_*`) and these example values, then set
`BACKORDER_TEMPLATES_ENABLED=true`:

1. **`pedido_reposicion_llego`**: product arrived and reserved.
   ```
   ¡Buenas noticias, {{1}}! Ya llegó su pedido {{2}}: {{3}}. Se lo apartamos a {{4}} c/u hasta {{5}}. Para confirmarlo, responda SÍ a este mensaje.
   ```
   `{{1}}` first name («Rosa», «cliente» when unknown) · `{{2}}` folio («BO-000012») ·
   `{{3}}` «2 × Croquetas Adulto Raza Grande 18 kg» · `{{4}}` price, with «(bajó de
   precio)» appended when it dropped («$1099.00 MXN (bajó de precio)») · `{{5}}` deadline
   («el 21 de noviembre a las 9:00 a. m.»).
2. **`pedido_reposicion_recordatorio`**: reminder before the hold lapses.
   ```
   Le recuerdo que su pedido {{1}} sigue apartado hasta {{2}}. Para confirmarlo, responda SÍ a este mensaje.
   ```
   `{{1}}` folio · `{{2}}` deadline.
3. **`pedido_reposicion_vencido`**: the hold lapsed.
   ```
   Se venció el apartado de su pedido {{1}} ({{2}}). Si todavía lo quiere, responda a este mensaje y lo revisamos.
   ```
   `{{1}}` folio · `{{2}}` product.
4. **`pedido_reposicion_lote`**: the reserved lot expired and no valid one is left.
   ```
   Una disculpa, {{1}}: el lote que le apartamos de {{2}} caducó y no tenemos otro vigente. Su pedido {{3}} sigue en primer lugar; le aviso en cuanto llegue ({{4}}).
   ```
   `{{1}}` first name · `{{2}}` product · `{{3}}` folio · `{{4}}` «aprox. 27 de noviembre»,
   or «fecha por confirmar» when there is no estimate.

Every parameter is one line (newlines and repeated spaces collapsed), trimmed and
at most 1024 characters. Templates are in usted (Meta approves one text per
language). Until approved, leave the flag off: a refused template is
`PROVIDER_REJECTED` for reserved / reminder, so staff still calls the customer.
Note for T5b: a customer who answers «SÍ» to a template has no button id, so a
bare yes must confirm the customer's `RESERVED` backorder.

### Ledger, recovery, configuration

- **Migration `5600000000000_feed_backorder_outcomes.js`** (additive): the
  `ack_outcome` CHECK accepts `PROVIDER_REJECTED`, a nullable `ack_reason`
  column (1-280 chars, required by and only with that outcome) and the new
  decisions (`BACKORDER_RESERVED_NOTICE`, `_REMINDER_NOTICE`, `_EXPIRED_NOTICE`,
  `_LOST_NOTICE`, `_CANCELLED_NOTICE`, `_ETA_PENDING`, `_PAYLOAD_INVALID`,
  `_OVERTAKEN`, `TEMPLATE_NOT_APPROVED`). The ACK is rebuilt from the row, so a
  retried `PROVIDER_REJECTED` carries the same reason. `down` refuses while a
  row uses a new decision or the outcome.
- **Recovery after `410 CURSOR_EXPIRED`** folds
  `backorderUndeliveredResumeAfter` (`GET /chatbot-api/backorders?updatedSince=`)
  into the resume minimum; a 403 / 404 degrades to "no position" with one warning.
- **Config**: `BACKORDER_TEMPLATES_ENABLED` (default `false`, exactly `true`
  enables), `BACKORDER_TEMPLATE_RESERVED` / `_REMINDER` / `_EXPIRED` / `_LOST`
  (default the four names above; lowercase `[a-z0-9_]`).

## Deploy notes

- Apply `5600000000000_feed_backorder_outcomes.js` before the T5a chatbot
  version starts: the ledger writes `ack_reason`, `PROVIDER_REJECTED` and the new
  decisions (without it the first backorder item fails its ledger write and the
  page is retried). Deploy the bot (with 5600) before backend T2 goes live, or
  the first `backorder.reserved` is ACKed `STALE` by an older bot.
- The chatbot credential needs `backorders:read` for the recovery position
  (without it the recovery still works, without the backorder minimum).
- Meta templates and `BACKORDER_TEMPLATES_ENABLED` are optional; with the flag
  off, a customer outside the 24 h window gets no message and staff is alerted
  to call (`PROVIDER_REJECTED`).
- Apply `5500000000000_conversation_gate_backorder_offer.js` before the new
  chatbot version starts: it widens the `gate_kind` CHECK; without it the arm
  fails (logged) and the offer is unanswerable. Its `down` refuses while an
  unexpired backorder gate exists.
- Backend T1 must be deployed and the chatbot credential must carry
  `backorders:create`, `backorders:read` and `backorders:cancel`, or every «sí»
  answers «No pude agendar su pedido por ahora.».
- The estimate message now always carries the offer wording; if the offer
  capability is not registered (it always is in production) nothing is armed.
