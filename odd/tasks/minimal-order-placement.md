# Minimal order placement

Objective: let an allowlisted WhatsApp customer turn the verified minimal cart plus a locally confirmed saved-address draft into a real backend ONLINE sale after explicit consent, then send transfer payment details.
Branch: `feat/minimal-order-placement` from `92bb259` (on top of `feat/minimal-checkout-customer-address`); delivery: local work-unit commits only (no push/PR/deploy); runner: direct Jest with mocked HTTP/SDK, in-memory stores.

## Specs

S1 — Shipping out of scope for this slice. Owner selected "Sin envío por ahora — recomendado", description: "El pedido registra solo productos y dirección guardada; la cotización+aprobación de envío va en el slice siguiente, antes de salir a producción." Question context: "(Nada se activa en producción hasta tener envío resuelto.)" The sale is created without the `shipping` object. The order route stays behind a default-off gate so it cannot run in production until shipping exists.

S2 — Only registered customers with a saved address. Owner selected "Solo guardados + pedir endpoint", description: "Recomendado: este slice crea pedidos solo con cliente único y dirección guardada; le pedimos al agente del backend un alta aditiva (sin sobrescribir) para el próximo slice." An order requires a `unique` customer (`sourceCustomerId`) and a `saved` address snapshot (`shippingAddressId` = snapshot `id`). New addresses or unregistered customers are not ordered: the customer gets a clear reply. This slice never calls customer upsert or address mutation. The backend owner is asked (S5 of the prior feature: backend agent explores, chatbot does not read backend source) for an additive customer/address creation that never overwrites existing addresses.

S3 — Payment details after a created order. Owner selected "Sí, datos de pago — recomendado", description: "Reutiliza getPaymentDetails existente; el comprobante ya lo recibe el servidor por su propio flujo." After a successful sale the reply includes the active transfer payment details; a failed payment-details read never hides that the order was created.

S4 — Explicit, bound consent before any sale (inherited safety rule; prior feature S3 and L63 advisory A). Before creating a sale, the server re-checks that the delivery data was locally confirmed AND still equals the current draft, re-reads the saved address freshness, and re-evaluates the cart with fresh prices/stock. It presents a server-owned order summary (items, totals, address) and creates the sale only on a strict, armed `SÍ` bound to that exact summary. Any change invalidates it. The model never creates a sale or claims an order exists.

S5 — Idempotent, never duplicated sale. `X-Idempotency-Key` is minted once per presented order and persisted through the existing cart CAS before the call; a retry of the same order reuses it; a confirmed sale clears the cart and records the placed sale through owned CAS writes, never the legacy whole-bag update. `cashierUserId` comes only from server config. Ambiguous outcomes (timeouts, IN_FLIGHT) never report success and never create a second sale.

S6 — Local delivery only (prior feature S4 authorization pattern): verified local work-unit commits; no push, PR, merge, deployment, production query or dependency change. Preserve unrelated untracked files.

## Tasks

T1 [S2,S4] route=inline; status=done; pure order domain: eligibility (exact confirmed-draft recheck via MinimalCheckoutConfirmation.confirmedDraft, saved/unique, fully evaluated non-empty cart), server-owned summary, one-shot armed strict-SÍ consent, sameMinimalOrder binding; idempotency moved to T2 (L5); commit=see L5.
T2 [S1,S2,S3,S5] route=inline; status=pending; MinimalOrderService: createSale without shipping via config cashier, CAS idempotency + post-sale state, error mapping, payment details; commit=pending.
T3 [S1,S2,S3,S4] route=inline; status=pending; SDK route integration (placeOrder tool, SÍ consume priority, default-off gate, docs) with public offline regressions; independent verify; commit=pending.
T4 [S2] route=backend agent message; status=blocked (awaiting backend reply, L4); request additive customer/address creation contract from the backend owner; no chatbot code.

## Log

L1 — Owner request, verbatim: "Si, por favor, adelante con tu recomendacion." in reply to "¿Seguimos con el slice de pedido o preferís cerrar antes alguna de esas observaciones?" (recommendation: order slice, which resolves advisory A).
L2 — Read-only explorer mv792dyh-3-wo4f mapped legacy src/sale-flow: cashierUserId from CHATBOT_API_CASHIER_USER_ID (config cashierUserId, configuration.ts:55); idempotency mint/reuse/rotate rules in create-sale.tool.ts; legacy placed-sale persistence uses whole-bag store.update (must not be used by the minimal route); getPaymentDetails reusable; receipt ingestion is server-owned. Parent spot check: CreateSaleInput.shipping optional (sales.dto.ts:111,151); prior L3 confirms the backend PUT overwrites the oldest address.
L3 — Owner decisions (ask_user_question, verbatim selections): shipping "Sin envío por ahora — recomendado"; new customers/addresses "Solo guardados + pedir endpoint"; payment "Sí, datos de pago — recomendado". Recorded as S1–S3. S4–S5 derive from inherited safety rules, not new product scope.
L4 — T4 request sent via intercom to backend session 01a135e7 ("Backend checkout contract coordination"): additive, non-overwriting customer create by trusted phone + add-new-address returning addressId/version, idempotent, service-auth scoped, no foreign data in errors; asked for exact contract and whether owner OK is needed. Awaiting reply; does not block T1–T3.
L5 — T1 inline. RED: new src/llm-agent/domain/minimal-order-confirmation.spec.ts failed to load (module missing) and new confirmedDraft test failed (TypeError, 1 failed/41 passed). GREEN: src/llm-agent/domain 10 suites 316/316. Added MinimalCheckoutConfirmation.confirmedDraft (exact canonical content vs confirmed binding — closes prior advisory A at the domain level) and exported isAffirmative; new MinimalOrderConfirmation domain. ESLint exit0, tsc zero src errors. Idempotency key lifecycle is owned by T2 because it needs the cart CAS slot: finding — minimal cart schema pins idempotencyKey to '' and the store does not validate cart content, so T2 extends the cart schema inside the same owned minimalCart slot (no new store method).
