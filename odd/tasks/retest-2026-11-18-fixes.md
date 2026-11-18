# Production retest 2026-11-18 fixes

Fixes from the owner's production retest on the Meta test number (Engram `smoke-test/production-improvement-notes-2` and `-3`). Branch: `fix/retest-2026-11-18`. N18 needs the backend (receipt destination check); its bot part waits for the agreed contract.

## Specs

- **S1 — Owner (verbatim):** "si hermano, adelante." to: start with N17 and N19, then N15 and N14; N18 coordinated with the backend; N16 low.
- **S2 — N17 (bug, high).** Evidence: after «Confirma tus datos de entrega…» [✅ Sí, son correctos][✏️ Corregir datos] the customer typed «prefiero recogerlo en tienda»; the pickup summary «Listo, recoges tu pedido en tienda… Total a pagar: $389.00 MXN» with [✅ Confirmar pedido] appeared; tapping it replied «Gracias, tus datos de entrega quedaron confirmados.» + the same summary, no order; the second tap created A-202611-000003. Rules: choosing store pickup dismisses any pending delivery-data confirmation; a confirm tap / SÍ that answers an order summary is never consumed by an older delivery-data confirmation (the order summary is the current question). Pickup must never print «datos de entrega quedaron confirmados».
- **S3 — N19 (double payment risk, high).** Owner (verbatim): "creo que alguien que no se entera mucho, podria volver a hacer el pago y mandar el comprobante". Evidence: receipt sent for A-202611-000003, then the older [Transferencia] button was tapped → full bank details again. Rule: when the placed sale has a receipt pending review (receipt attached, no outcome yet), a Transferencia tap or a payment-details question replies verbatim «Ya recibimos su comprobante del pedido {folio} y lo estamos revisando; no hace falta que vuelva a pagar. Le aviso en cuanto quede confirmado.» (tú via customer-style: «Ya recibimos tu comprobante del pedido {folio} y lo estamos revisando; no hace falta que vuelvas a pagar. Te aviso en cuanto quede confirmado.») with no bank details and no team request. If the customer explicitly says they need to pay the rest / another amount, give the details. After a REJECTED outcome, details are given normally. Paid orders keep «Su pedido ya está pagado.».
- **S4 — N15 (pickup choice).** When checkout starts («quiero comprar» or [Seguir con la compra]) and store pickup is available, the bot first asks «¿Se lo enviamos a su dirección o prefiere recogerlo en tienda?» with two buttons «Envío a domicilio» and «Recoger en tienda» (tú styled). «Envío a domicilio» continues with today's delivery-data flow (saved address confirmation or capture); «Recoger en tienda» goes to the pickup summary. If pickup is not available, today's flow is unchanged. A customer who already said how they want it (e.g. «quiero comprar para recoger en tienda», «envíamelo a mi casa») skips the question.
- **S5 — N14 (default quantity).** When the customer picks a presentation without an explicit count («quiero el de 2 kg», «la de 7 piezas»), add 1 unit and reply with the existing «Le agregué 1 unidad; si desea otra cantidad…» pattern, then the cart summary with the T1 buttons. A number that is part of the presentation (2 kg, 7 piezas, 375 g) is never read as the quantity. Explicit counts («quiero 2 de 7 piezas», «dos bolsas de 2 kg») keep working.
- **S6 — N16 (low).** The pickup order summary includes the store name, address and hours (the same text the order-created reply already shows).
- **S7 — Evidence.** RED test per rule with the production cases; touched existing behaviour stays green; full suite before merge.

## Tasks

| ID  | Specs   | Route                                    | Commit |
| --- | ------- | ---------------------------------------- | ------ |
| T1  | S2, S3  | worker: pickup gate bug + receipt-in-review payment reply | |
| T2  | S4, S5, S6 | worker: pickup choice + default quantity + store data in summary | |
| T3  | N18     | backend contract first, then bot extraction fields | |

## Log

- **L1 (owner, 2026-11-18):** "si hermano, adelante." after the retest summary (N14–N19, N17 and N19 first).
