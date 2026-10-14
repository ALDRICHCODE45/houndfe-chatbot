# Minimal new-customer checkout

Objective: let customers without a saved registration, or with a new delivery address, order through the minimal route; the backend atomic checkout creates the customer and saves the new address only when the order is created.
Branch: `feat/minimal-new-customer-checkout` from `08a607b` (on top of `feat/minimal-atomic-checkout`); delivery: local work-unit commits only (no push/PR/deploy); runner: direct Jest with mocked HTTP/SDK/provider, in-memory stores. Backend endpoint committed locally (b51e8e5, 3e85510), NOT deployed: no live calls.

## Specs

S1 — Owner go-ahead, verbatim: "Adelante." in reply to "Te recomiendo seguir por el 3, clientes nuevos, que es lo que más amplía quiénes pueden comprar por el bot. En paralelo vos podés resolver el 1 y el 2. ¿Cuál querés que encare?" where 3 was: "Clientes nuevos. El checkout atómico ya permite crear cliente y dirección junto con el pedido. Conectarlo en el chatbot sería el próximo slice natural."

S2 — Registration only with a created order (owner rule, minimal-order-placement S2/L14 option B): use POST /chatbot-api/checkouts with customer {mode:'createIfAbsent', firstName, lastName?} and deliveryAddress {mode:'newSaved', address{...}} only inside the atomic checkout; never call customer upsert or a separate address write. A rejected/rolled-back checkout leaves nothing saved. Only available when the atomic checkout switch is on; with it off, new customers/addresses keep today's "not yet" reply.

S3 — Inputs: the locally confirmed new-address draft (S7 readiness gate unchanged) and the trusted WhatsApp sender phone. A unique existing customer with a confirmed NEW address uses createIfAbsent (backend reuses the unique customer without patching it) + newSaved. Ambiguous phone (409 CUSTOMER_PHONE_AMBIGUOUS) gets a deterministic reply directing to the store; no order.

S4 — State: the backend accepts `state` only as one of its MEXICAN_STATES values. The chatbot maps the confirmed free-text state to that exact list deterministically (accents/case-insensitive, common aliases such as CDMX); an unmappable state blocks the summary and asks the customer to give a valid state. Exact list obtained from the backend owner (S5 of minimal-checkout-customer-address: no backend source reading).

S5 — Shipping for new addresses: quoting/approval/freshness must work for a confirmed new address (no saved id/version); the shipping record binds to the exact confirmed new-address content instead.

S6 — Inherited safety unchanged: exact-snapshot one-shot SÍ, payload fingerprint over the exact checkout payload (now including the new customer/address fields), attempts counter, uncertain-outcome lock with status-first recovery, approved current shipping. The summary tells the customer the delivery address will be saved with the order (transparency, parent default).

## Tasks

T1 [S5] route=worker; status=pending; shipping quote/approval/freshness for a confirmed new address; commit=pending.
T2 [S2,S3,S4,S6] route=worker; status=pending (needs MEXICAN_STATES list); order eligibility + checkout payload createIfAbsent/newSaved + state mapping + replies; commit=pending.
T3 [S2] route=inline; status=pending; docs + independent verification; commit=pending.

## Log

L1 — Owner request, verbatim: "Adelante." (see S1). Parent spot check: the MEXICAN_STATES list exists only in the backend (src/sale-flow/application/tools/upsert-customer.tool.ts:17-20 documents that the chatbot never duplicated it); requested from the backend session.
