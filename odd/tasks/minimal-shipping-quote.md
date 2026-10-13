# Minimal shipping quote

Objective: on the minimal SDK route, quote home delivery with Skydropx, apply the credit rule, get human approval of every quote, and carry the approved charge into the order so it can go to production with shipping resolved.
Branch: `feat/minimal-shipping-quote` from `d208d6c` (on top of `feat/minimal-order-placement`); delivery: local work-unit commits only (no push/PR/deploy); runner: direct Jest with mocked HTTP/SDK/provider, in-memory stores.

## Specs

S1 — Human approval of every quote. Owner selected "Sí, siempre — recomendado", description: "Igual que se decidió para el flujo anterior: nada de montos de envío al cliente sin aprobación humana por el canal de operaciones. Más lento, cero sorpresas. Se puede automatizar después." Question: "Cuando el bot cotiza un envío con Skydropx, ¿una persona del equipo tiene que aprobar cada cotización antes de mostrársela al cliente?". No shipping amount reaches the customer before an ops-channel approval of that exact quote.

S2 — Free shipping when the credit covers it. Owner selected "Pedido con envío gratis — recomendado", description: "Igual pasa por la aprobación, y la venta se crea sin cargo de envío; el cliente ve 'envío cubierto por su compra'." Question: "Si el crédito ($120 por artículo de más de $500) cubre todo el envío y el cliente paga $0 de flete, ¿qué hacemos?". Credit rule as implemented in src/shipping/domain/shipping-credit.ts ($120 MXN per unit priced > $500, credits sum, customer pays max(0, best rate − credit)).

S3 — No store pickup in this slice. Owner selected "No por ahora — recomendado", description: "Este slice solo agrega envío a domicilio; recoger en tienda queda para otro slice." Question: "¿Ofrecemos 'recoger en tienda' como alternativa al envío en este slice?".

S4 — Inherited order safety (minimal-order-placement S4/S5/S7). The approved shipping charge is part of the presented order summary, the consent binding and the idempotency payload/fingerprint; any quote, approval or charge change invalidates the summary; the uncertain-outcome lock still applies. The model never authors a shipping amount, approval or order claim.

S5 — Delivery and activation (inherited). Default-off gate; local work-unit commits only; no push, PR, merge, deploy, production query or real Skydropx/WhatsApp call in tests. Owner said nothing goes to production until shipping is resolved.

## Tasks

T1 [S1,S2,S4] route=read-only design explorer; status=pending; choose minimal-route storage for quote/approval/acceptance (CAS, not legacy whole-bag writes), the approval wiring through the existing ops-channel handoff, how the charge enters the order summary/fingerprint, and the backend sale path (POST /sales with shipping vs the atomic checkout being built, L-backend); commit=n/a.
T2..Tn — defined after T1 design.

## Log

L1 — Owner request, verbatim: "Ok, adelante" in reply to "le paso al backend tu OK para implementarlo (con la condición del envío, con tests y verificación independiente, sin push ni deploy) y arranco el slice de envío. ¿Avanzo así?".
L2 — Read-only explorer mv7atv4c-7-ai73: legacy shipping is complete but default-off (SHIPPING_QUOTES_ENABLED, launch preflight expects false). Reusable pure pieces: shipping-credit.ts, quote request/result/error/port, shipping-quote-orchestrator.ts, shipping-sale-revalidation.ts (verdicts ordinary_free | charged | blocked), shipping-sale-gate.ts, shipping-sale-destination.ts, shipping-promo-requote.ts, customer acceptance/disclosure/decision modules, approval policy port. Coupled: whole-bag store.update persistence of shippingQuoteDraft/Context, shippingApproval, shippingCustomerOffer/Acceptance; trigger inside legacy get-shipping-quote tool. Approval = ops agent on OPS_CHANNEL_PHONE via handoff kind shipping_approval; real inbound customer-YES dispatcher wiring (SCA-4c) still pending. Backend charge persistence on POST /sales was localhost-only/not merged. Delivery zones (CDMX free zone) remain a live-activation prerequisite, no code. Parent spot check: credit constants shipping-credit.ts:8-9; SHIPPING_QUOTES_ENABLED configuration.ts:142 / launch-preflight.ts:71.
L3 — Owner decisions (ask_user_question, verbatim selections): approval "Sí, siempre — recomendado"; free shipping "Pedido con envío gratis — recomendado"; pickup "No por ahora — recomendado". Recorded as S1–S3.
L4 — Backend (session 01a135e7) acknowledged L18 authorization: implementing POST /chatbot-api/checkouts + GET status with full approved sale.shipping and freight-inclusive total, spec odd/tasks/atomic-chatbot-checkout.md in houndfe-backend; no push/PR/deploy.
