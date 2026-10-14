# Minimal atomic checkout wiring

Objective: place minimal-route orders through the backend atomic checkout (POST /chatbot-api/checkouts) and use its status endpoint to resolve uncertain outcomes, keeping every existing order/shipping safety guarantee.
Branch: `feat/minimal-atomic-checkout` from `ce07cab` (on top of `feat/minimal-shipping-quote`); delivery: local work-unit commits only (no push/PR/deploy); runner: direct Jest with mocked HTTP/SDK, in-memory stores. The backend endpoint is committed locally in houndfe-backend (b51e8e5, 3e85510) but NOT deployed: no live calls.

## Specs

S1 — Owner go-ahead, verbatim: "Si, adelante" in reply to "¿Arranco con la conexión al checkout atómico?", after the recommendation: "1. Alinear el cliente con este contrato final. 2. Pasar la creación del pedido del chatbot del POST /sales viejo al nuevo POST /chatbot-api/checkouts. 3. Usar el endpoint de estado para destrabar los pedidos inciertos de forma automática." Contract source of truth: houndfe-backend docs/chatbot-atomic-checkout.md as recorded in odd/tasks/minimal-shipping-quote.md L20.

S2 — Default-off switch (parent safety decision, endpoint not deployed): `minimalCatalogAgent.atomicCheckoutEnabled = MINIMAL_CATALOG_ATOMIC_CHECKOUT_ENABLED === 'true'`. Off → current POST /sales behavior byte-identical. Launch preflight expects 'false'.

S3 — Same scope as today: unique registered customer (customer mode `existing`) and confirmed saved address (deliveryAddress mode `existing` with the exact snapshot `version` as expectedVersion). New customers/addresses (createIfAbsent/newSaved) are a later slice.

S4 — Inherited safety unchanged: exact-snapshot one-shot SÍ, payload fingerprint over the exact checkout payload, attempts counter, uncertain-outcome lock (S7 of minimal-order-placement), approved current shipping when shipping is enabled; one POST attempt per consent; never a new key while an outcome is uncertain.

S5 — Recovery: when an outstanding key exists with the same fingerprint, read GET /chatbot-api/checkouts/status first. `succeeded` → treat as the created order (clear cart, record placedSale, success reply, no new POST). `not_observed` → retry the same payload with the same key (never a fresh key). Status failure → keep the lock, ambiguous-outcome reply.

## Tasks

T1 [S1,S2,S3,S4,S5] route=worker; status=pending; align the T6 client with the final contract and switch MinimalOrderService.place() to createCheckout behind the switch, with status-based recovery and contract error mapping; commit=pending.
T2 [S2] route=inline/worker; status=pending; config + preflight + docs (docs/minimal-order-placement.md, docs/minimal-shipping.md); independent verification; commit=pending.

## Log

L1 — Owner request, verbatim: "Si, adelante" (see S1).
L2 — Backend update (session 01a135e7, no code/delivery change): a native review over exact target 2ada5dd7 (17 paths, 3663 lines: checkout-context + atomic checkout) was started (review-32c8c59150530d8c, 4 lenses) after host consent; the reviewer group capture was CANCELLED by a 180 s timeout without usable results; one STATUS shows reviewing/collect with 4 slots pending — NOT approved, no ACK. Backend did not retry/reset/recover; HEAD 3e85510 clean, PG fixture stopped. Review blocked on owner disposition in the backend session. C1 earlier review approved/burned; C2 still has no native approval. Does not block this chatbot slice (no live calls).
