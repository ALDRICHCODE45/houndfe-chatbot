# Payment step after the order (prod smoke test N8)

The bot leads the customer from the folio to the payment, gets bank details on demand (not only once at order time), and remembers a pending payment when they cannot be read. Branch: `feat/payment-step`. Found in the production smoke test of 2026-11-16 (Engram `smoke-test/payment-details-gap`).

## Specs

- **S1 — Owner (verbatim, N8):** "eso no lo deberia de escribir el cliente, eso lo deberia de escribir el bot, es decir.. los siguientes pasos son: pago con transferencia, pago con mercado libre (eso hay que discutirlo despues, pero no es el punto), y deberia preguntarle algo como, quiere continuar con el pago (o algo asi), y cuando responda que si, le pasa los datos bancarios".
- **S2 — Offer after the folio (owner choice):** "Una combinacion entre la calidez de la opcion B) y las opciones en botones de la opcion C) hoy solo con transferencia lista para incluir otros metodos despues." The order-created reply no longer includes bank details. It is: `¡Listo! ` + the existing created reply (folio, totals, pickup text) + `\n\nPara terminar solo falta el pago. ¿Cómo desea pagar?`, sent with one interactive reply button per payment method; today only `Transferencia`. Methods come from one list so Mercado Pago can be added later without touching the flow. usted/tú styling applies like other replies.
- **S3 — Transfer chosen:** tapping `Transferencia`, or answering yes / "transferencia" to the pending offer, fetches `GET /chatbot-api/payment-details` at that moment and sends the existing `minimalPaymentInstructions` text (Banco, Beneficiario, CLABE, Cuenta, "Cuando haga la transferencia, envíe aquí la foto de su comprobante."), preceded by the folio and amount to pay.
- **S4 — Payment question any time after an order:** a free-text question like "¿A qué cuenta le transfiero?" / "datos de pago" while the customer has a placed sale gets the bank details (same text as S3) and never creates an `askTeam` / UNKNOWN_QUESTION request. The minimal route exposes this; the ask-team prompt fragment excludes payments / transfer details.
- **S5 — Details unavailable (owner choice "Reintenta y avisa al equipo"):** when the fetch fails the bot replies verbatim `No pude obtener los datos en este momento; ya le avisé al equipo y se los comparto en cuanto estén.`, persists a payment-pending marker on the placed sale, and creates one human request in the POS (existing human-request creation path) stating the folio and that the customer wants to pay by transfer and bank details could not be read. A later payment question or yes retries the fetch; success clears the marker and sends S3. Repeated failures do not create duplicate requests for the same sale.
- **S6 — Observability:** a failed payment-details fetch logs a `warn` with status and error code (no secrets, no bank data). Checkout rejections that rotate the idempotency key log a `warn` with status and error code for every code, not only `INVALID_CHECKOUT_REQUEST` (`minimal-order.service.ts:954`) — prod failure `404 CASHIER_NOT_FOUND` was invisible in chatbot logs.
- **S7 — Compatibility:** stored conversation state written before this change (placedSale without the new marker, carts in flight) keeps working; the receipt routing that reads `placedSale` is unchanged.

## Tasks

| ID  | Specs     | Route                                    | Commit  |
| --- | --------- | ---------------------------------------- | ------- |
| T1  | S1–S5, S7 | worker: payment offer, transfer, pending | 54015f9 |
| T2  | S6        | worker (same run): warn logs             | 54015f9 |

## Log

- **L1 (owner, 2026-11-16):** "mejor hacemos el arreglo, lo despliego y seguimos con la prueba. si?"
- **L2 (evidence):** minimal route tool set has no `getPaymentDetails` (only `RealToolRegistry`, legacy path); `paymentInstructions()` runs once in `completeSale` with a silent `catch {}` (`minimal-order.service.ts:1086-1091`); `placedSale` schema strict at `minimal-cart.service.ts:32-49`; ask-team fragment `minimal-catalog-agent.service.ts:316-326`; button ids parsed in `customer-reply.ts:91-136`.
- **L3 (owner decisions, 2026-11-16):** S2 combined B+C with buttons; S5 retry and notify the team.
- **L4 (worker, 2026-11-16):** T1+T2 done in one commit `54015f9`. Payment offer + buttons, on-demand details (button / yes / `getPaymentDetails` tool), `paymentPending` marker + one human request, warn logs for payment fetch and every rotating checkout rejection. Related tests (99 suites), `tsc` and `eslint` clean. No reply text changed from S2/S5; tú pairs added in `customer-style.ts`.
