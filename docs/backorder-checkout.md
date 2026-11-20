# Restock backorder: confirm, cart line, checkout, errors and reschedule (T5b: S2, S6, S11)

The customer confirms a RESERVED backorder (arrival or reminder notice, tap or a
bare yes); it becomes a special line of the cart at the backorder's frozen
`finalPriceCents`, and the **normal** checkout continues (delivery or pickup,
address, shipping quote, order summary, «SÍ», payment). Nothing is paid before
the product arrives. Contract:
[`contracts/restock-backorder-bot-contract.md`](contracts/restock-backorder-bot-contract.md)
(«backend T3 built»). Notices (T5a): [`minimal-backorder.md`](minimal-backorder.md).
Tracker: `odd/tasks/restock-backorder.md`. No model call is made for any of
this (confirm, yes, reschedule, errors): all copy is server-owned, usted with
curated tú pairs, dates in America/Mexico_City.

```
notice [Confirmar pedido] backorder_confirm:<id>  ─┐
bare yes / «confirmo» / «sí lo quiero» (guarded) ──┴▶ MinimalBackorderConfirmService
      list by phone (ownership) + GET /backorders/:id ─ RESERVED, deadline ahead, final price?
        yes ─▶ MinimalCartService.addBackorderLine ─▶ cart reply + next-step buttons
                 (same continuation as a reorder: summary if shipping/delivery data exist)
        no  ─▶ honest answer, stop
cart ─▶ normal checkout ─▶ POST /checkouts  items[i].backorderId, unitPriceCents = finalPriceCents
        └ refused ─▶ minimal-backorder-checkout.ts decides ─▶ drop / reprice / apologise
```

## 1. Triggers

| Trigger                                                                                                                                                                           | When it is ours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tap `backorder_confirm:<backorderId>`                                                                                                                                             | always: the id names the backorder. A pending cart or summary is **not** a blocker (the line joins the cart; a pending order summary is dismissed because the cart changed).                                                                                                                                                                                                                                                                                                                                                                                                 |
| bare yes (`classifyConfirmationReply` accept: «sí», «ok», «dale», «confirmo»…) or «sí lo quiero», «lo quiero», «lo confirmo», «confirmo mi pedido (apartado)», «quiero confirmar» | only if **all** hold: no other flow answered it first; `competingOrderContext()` is false (T6a's check: no cart, reorder offer, pending summary, delivery draft or placed sale); the bot's latest turn has no pending offer / choice / pending cart request and did not ask another question (a question that names the apartado, e.g. the notice, still counts); and the customer has **exactly one** `RESERVED` backorder (`GET /backorders?status=RESERVED`). Anything else (several, none, a failed read, a throw) returns `null` and the normal turn answers as before. |

The bare yes is evaluated **last**, right before the model run (after the offer,
manage, payment, restock, reorder, summary and closing routes), so every flow
that owns a yes answers first. The tap is evaluated early (after the T1 offer
and T6a manage routes). The whole-message lexicon lives in
`domain/backorder-confirm.ts`; «sí pero cambia…» or any question is not a
confirmation. A «SÍ» typed to a Meta template (no button id) takes the same
yes path.

Verification (`MinimalBackorderConfirmService.load`): the id must be in the
customer's own list (`GET /chatbot-api/backorders?phoneCountryCode&phone`, so
another phone's backorder looks unknown), then `GET /chatbot-api/backorders/:id`
decides:

| State                                                              | Answer                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `RESERVED`, `reservedUntil` in the future, `finalPriceCents` known | add the line                                                                        |
| `RESERVED` past its deadline (before the sweep) or `EXPIRED`       | «Se venció el apartado de su pedido {folio}.» (+ reschedule offer, §5)              |
| `CONFIRMED`                                                        | «Ese pedido ya está confirmado.»                                                    |
| `CANCELLED`                                                        | «Ese pedido apartado ya está cancelado.»                                            |
| `WAITING`                                                          | «Su pedido {folio} todavía no está apartado. Le aviso en cuanto llegue.»            |
| not in the list / 404                                              | «No encontré ese pedido apartado.»                                                  |
| read failure, or no final price                                    | «No pude consultar su pedido apartado por ahora. Intente de nuevo en unos minutos.» |

## 2. The cart line

Stored in the existing durable slot `conversation_state.data.minimalCart` (JSONB:
**no migration**) as an optional field of the line:

```json
{
  "productId": "…",
  "variantId": "…",
  "quantity": 2,
  "unitPriceCents": 109900,
  "backorder": {
    "id": "<backorderId>",
    "folio": "BO-000012",
    "productName": "…",
    "variantName": null,
    "reservedUntil": "2026-11-21T15:00:00.000Z"
  }
}
```

`quantity` = the backorder's quantity, `unitPriceCents` = `finalPriceCents`.
Ordinary lines have no `backorder` key, so a cart without one is stored,
quoted, fingerprinted and sent exactly as before (pinned by tests).

- **Never merges.** `sameLine` compares the backorder id too: an ordinary
  `adjustCartItem`/`setCartItem` on the same product only touches the ordinary
  line, and `addItems` (reorder) never adds into it. Two lines of the same product
  are legal in the slot (`parseMinimalCart`), the fingerprint, the shipping pin
  (`backorderId` in the pin line) and the order snapshot.
- **No catalog, stock or promotion.** `quote()` skips the catalog/stock read for
  the line (reserved units are not sellable stock) and prices it from the stored
  final price: `finalPriceCents = unit × quantity`, no discount. `evaluate-cart`
  receives **only the ordinary lines** (and is not called at all for a
  backorder-only cart). `refreshPrices` never reprices the line from the catalog.
- **Quantity and price are fixed.** A set, or a decrease, of its quantity is
  refused (`backorder_line_locked`): «Esa pieza viene de su pedido apartado y no
  puedo cambiar su cantidad ni su precio; si quiere más, agrego otra línea. Su
  carrito no fue modificado.» «Agrega 1 más» is another, ordinary line (stock
  rules apply). The model cannot supply a backorder or a price (`minimalCartInput`
  omits both).
- **Removal does not cancel.** Quitar the line (set 0; keep-only without it)
  removes it, and the reply adds «Su pedido apartado {folio} sigue apartado {el 21
  de noviembre a las 9:00 a. m.}; no se canceló al quitarlo del carrito.» If an
  ordinary line of the same product exists, «quita» removes that one first.
- **Adding twice** keeps one line (no second write). An outstanding order key
  blocks it like any cart change (`order_unresolved`).

## 3. Checkout

The normal flow. `MinimalOrderService` snapshots the lines of the quote (the
backorder marker is part of the snapshot fingerprint and of the durable
`order_confirmation` gate), and the summary shows the line at its final price:

```
• Croquetas Adulto 18 kg: 2 × $1099.00 MXN; importe $2198.00 MXN (pedido apartado BO-000012)
```

`POST /chatbot-api/checkouts`: the backorder line carries `backorderId` and
`unitPriceCents = finalPriceCents` (sent only when present; an ordinary body is
byte-identical to before). Contract §7:

```
expectedTotalCents = Σ(finalPriceCents × qty of the backorder lines)
                   + total of the ordinary lines (evaluate-cart of ONLY those)
                   + shipping charge
```

That is exactly `snapshot.totalCents` (the quote sums backorder lines at their
final price and the evaluated ordinary lines) plus the shipping charge, so the
existing `PROMO_RE_QUOTE` path (re-present the summary, new «SÍ») needs no
change. Shipping: the quote request asks about the units together (the backend
rejects a repeated line with `DUPLICATE_CART_LINE`), so a backorder line next to
an ordinary one of the same product is sent as one item with the summed
quantity; the >$500 credit rule counts the units like any item.

## 4. Checkout refusals (contract §7)

`checkout.dto.ts` `backorderCheckoutFailure(error)` (T5a) types the error;
**`application/minimal-backorder-checkout.ts` `backorderLineDecision` is the
only mapping**, `MinimalOrderService.backorderRefusal` applies it to the cart
copy that is committed once (key cleared, shipping dropped on a drop) and words
the answer. Every refusal means nothing was charged; the key is rotated and
nothing is retried.

| Backend                                                             | Decision         | Reply / cart                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKORDER_RESERVATION_EXPIRED`, `BACKORDER_NOT_RESERVED {EXPIRED}` | drop `expired`   | «Se venció el apartado de su pedido {folio}. Quité esa pieza de su carrito y no se creó ningún pedido.» + reschedule offer when `sourceDecisionId` is known                                                                               |
| `BACKORDER_NOT_RESERVED {CONFIRMED}`                                | drop `confirmed` | «Ese pedido ya está confirmado, así que no lo agrego de nuevo. Quité esa pieza…»                                                                                                                                                          |
| `…{CANCELLED}` / `{WAITING}` / other                                | drop             | cancelled / «todavía no está apartado. Le aviso en cuanto llegue.» / «ya no está disponible para confirmar»                                                                                                                               |
| `BACKORDER_RESERVATION_LOST`                                        | drop `lost`      | «Lo siento, el lote apartado … venció y ya no se lo tenemos apartado. Sigue primero en la fila: le aviso en cuanto llegue de nuevo. Quité esa pieza…» **never retried**                                                                   |
| `BACKORDER_NOT_FOUND`                                               | drop             | «No encontré ese pedido apartado. Quité esa pieza…»                                                                                                                                                                                       |
| `BACKORDER_MISMATCH {field}`                                        | mismatch         | logged (`field`), «No pude confirmar su pedido apartado porque no coincide con la reserva. Quité esa pieza… Pida ayuda al equipo si lo necesita.»                                                                                         |
| `PRICE_OUT_OF_DATE {currentPriceCents}`                             | reprice          | line price refreshed from `GET :id` `finalPriceCents` (the detail is the fallback), summary shown again with the usual «Su pedido cambió…», a new «SÍ» is needed; an ordinary line's stale price has no detail and keeps today's handling |
| `BACKORDER_RESERVATION_UNAVAILABLE`                                 | unavailable      | «Hubo un problema … el equipo le va a llamar para resolverlo. No se creó ningún pedido.»; cart kept                                                                                                                                       |
| `INVALID_CHECKOUT_REQUEST`                                          | none             | existing: logged with the safe message, «No se pudo crear el pedido…», cart kept                                                                                                                                                          |
| `503 BACKORDER_CHECKOUT_UNAVAILABLE`                                | none             | unknown outcome, key kept (existing 5xx path)                                                                                                                                                                                             |
| `PROMO_RE_QUOTE`                                                    | none             | existing: re-presented with the §7 formula                                                                                                                                                                                                |

A price refusal of a **delivery** order also re-quotes the shipping (the stored
quote was pinned to the old line price): the stored total is parked on a value no
quote equals, so the next price refresh reports a re-price and `freshOrder`
asks for one fresh quote before showing the summary again, exactly like a
promotion change; pickup needs no quote.

The error does not name its line: with one backorder line it is that one; with
several, each backorder is read and only the ones the backend no longer
honours leave (all of them if none can be told apart). After an earlier **uncertain** attempt under the same key (e.g. a 503
`BACKORDER_CHECKOUT_UNAVAILABLE`), a refusal about the backorder line reads
`GET /checkouts/status` for the key, like the shipping-quote rejections: a sale
under it is completed as placed; a confirmed absence clears the key and the
refusal is applied (drop / refresh the line); a failed read keeps the «no pude
confirmar si su pedido anterior quedó registrado» hold and the line. Other
refusals after an uncertain attempt keep today's hold.

## 5. Reschedule after an expiry

Sent by T5a's expiry notice and by the checkout «expired» answer **only when
`sourceDecisionId` is known** (`BackorderBot.sourceDecisionId`, from `GET :id`):
[Sí, agendar] `backorder_reschedule:<id>` · [No, gracias]
`backorder_reschedule_decline:<id>` (a tap of the first reaches the turn as `SÍ`,
the second as `No, gracias`).

| Tap                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reschedule, backorder `EXPIRED`/`CANCELLED`, `sourceDecisionId` present | `POST /chatbot-api/backorders` with the same `sourceDecisionId`, product, variant, quantity, the existing customer (lookup by phone; unknown phone → `createIfAbsent` with the stored first name; shared phone → honest failure) and the **new** key `backorder-reschedule:<oldBackorderId>` (a double tap replays the same backorder); reply = the T4 «quedó agendado» copy (new queue position: back of the queue, same estimate) |
| no `sourceDecisionId`                                                   | «No puedo agendarlo de nuevo de forma automática. Si quiere, dígame «hablar con una persona» y el equipo le ayuda.» (nothing is created)                                                                                                                                                                                                                                                                                            |
| backorder `WAITING`/`RESERVED`/`CONFIRMED`                              | «sigue agendado; no hace falta agendarlo de nuevo» / «ya está confirmado»                                                                                                                                                                                                                                                                                                                                                           |
| decline                                                                 | «Entendido.»                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `STOCK_AVAILABLE_NOW`, `BACKORDER_DUPLICATE`, 5xx/429/in-flight, other  | the T4 copy for the same cases                                                                                                                                                                                                                                                                                                                                                                                                      |

## Where

| Piece                                                       | File                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| trigger lexicon                                             | `src/llm-agent/domain/backorder-confirm.ts`                                               |
| confirm / reschedule service                                | `src/llm-agent/application/minimal-backorder-confirm.service.ts`                          |
| agent glue (tap early, yes last, `acceptBackorderConfirm`)  | `src/llm-agent/application/minimal-catalog-agent.service.ts`                              |
| cart line (`addBackorderLine`, quote, locked, removal note) | `src/llm-agent/application/minimal-cart.service.ts`, `src/sale-flow/domain/cart-state.ts` |
| summary marker, snapshot, durable gate                      | `src/llm-agent/domain/minimal-order-confirmation.ts`, `gates/order-confirmation.gate.ts`  |
| body (`backorderId`) and refusals                           | `src/llm-agent/application/minimal-order.service.ts`, `minimal-backorder-checkout.ts`     |
| shipping pin / merged quote items                           | `src/llm-agent/domain/minimal-shipping.ts`, `minimal-shipping.service.ts`                 |
| copy, button ids, tú pairs                                  | `domain/backorder-copy.ts`, `domain/customer-reply.ts`, `domain/customer-style.ts`        |

## Checks

```sh
pnpm test --runTestsByPath src/llm-agent/application/minimal-backorder-cart.spec.ts \
  src/llm-agent/application/minimal-backorder-checkout.spec.ts \
  src/llm-agent/application/minimal-backorder-confirm.service.spec.ts \
  src/llm-agent/application/minimal-backorder-confirm.agent.spec.ts
```

Offline, mocked provider and in-memory state: they prove the local behaviour, not
live model intent recognition, Meta delivery or the backend T3 on a real
database (a dev rehearsal with a reserved backorder on :3003 is still pending).

## Deploy notes

- The checkout DTO must accept `sale.items[i].backorderId` (T5a), and the
  backend T3 must be deployed with or before backend T2 goes live (contract).
- No migration, dependency or environment variable. A cart stored by an older
  version has no `backorder` key and reads unchanged; a version older than this
  one cannot read a cart holding a backorder line (strict schema), so roll back
  only after such carts expire or are placed.
