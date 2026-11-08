# Checkout saved-address correction

Customer corrects a field of a selected saved address during WhatsApp checkout; the correction replaces the saved address.
Cross-repo: backend (session 01a14144) owns the contract; chatbot adapts. No PRs; merge to local main, owner pushes.

## Specs

- S1 — Owner report: the bot showed a saved address with a wrong ZIP; customer wrote "el codigo postal esta mal, el correcto es: 55635" and the bot answered it could not change it and asked to confirm the wrong data. Owner asked: "este es el comportamiento esperado?" Not expected.
- S2 — Owner chose "Que reemplace la dirección guardada": "La corrección actualiza la dirección existente. Necesita un cambio en el backend (permitir editarla en el checkout) y es más trabajo."
- S3 — Only the fields the customer states change; everything else comes from the saved snapshot. The customer confirms the corrected summary with SÍ before ordering.
- S4 — Atomic rule kept: the address update happens inside the checkout transaction; if the order fails nothing is saved. Stale versions are rejected.
- S5 — Never ask the customer to confirm data they said is wrong; if they say something is wrong without the correct value, ask for it.

- S6 — Backend found Sale stores only shippingAddressId (FK, onDelete SetNull); reads join the live address, so POS edits (CustomersService.updateAddress), bot PUT by-phone and deletes already rewrite or erase past orders' addresses. Owner chose "A directamente": "Primero la copia de la dirección en cada venta (más grande y con migración de datos) y después la corrección en el chatbot."

## Tasks

- T0 [S6] backend: shipping-address snapshot on Sale (all write paths, backfill migration, all reads switched). Status: done (backend 26e9e20).
- T1 [S2, S4] backend: checkout deliveryAddress mode existingUpdated (in-place, expectedVersion, atomic with sale). Status: done (backend dee23a1).
- T2 [S3, S5] chatbot: correction tool on the selected saved address, corrected summary, shipping quote binding, place with the new mode. Status: done (chatbot 09edb80).

## Log

- L6 — Chatbot T2 done: 09edb80 (worker mvg15ylu-4-iqgs, reviewed). Draft kind savedCorrected (snapshot + merged full fields); updateCheckoutDetails with useNewAddress:false on a selected saved address applies only corrected fields; identical -> plain saved; corrected server summary for SÍ; revalidation on base version; placement requires atomic switch, sends existingUpdated (expectedVersion = snapshot version); 409 ADDRESS_VERSION_CONFLICT / 404 SHIPPING_ADDRESS_NOT_FOUND -> clear selection + reselect reply; summary line "Actualizaremos su dirección guardada con estos datos."; shipping uses corrected fields. Full suite 8279 pass. Deploy: backend dee23a1 before chatbot 09edb80.
- L5 — Backend T1 done: 5ef3381 + merge dee23a1, no migration. POST /chatbot-api/checkouts deliveryAddress {mode:'existingUpdated', addressId, expectedVersion (exact from checkout-context), address:{street required; label, exteriorNumber, interiorNumber, zipCode, neighborhood, municipality, city, state, visualReferences, carrierPhone}} full replace (omitted optional -> null), no coordinates (location change clears lat/long). 201 address {resolution:'updated', id same, version new}; identical -> 'existing' no write. Atomic with sale + snapshot; rollback keeps address. Hash includes mode/addressId/expectedVersion/full address. Errors 400 INVALID_CHECKOUT_REQUEST, 404 SHIPPING_ADDRESS_NOT_FOUND, 409 ADDRESS_VERSION_CONFLICT (re-read checkout-context), 409 IDEMPOTENCY_KEY_CONFLICT, others unchanged. 7599 pass. Chatbot T2 starting.
- L4 — Backend A done: 5f1f22f, 398716a, bc9fe76, merge 26e9e20; schema-only migration 20261020000100_sale_shipping_address_snapshot (13 nullable columns). Snapshot on all writes (POS assign/set/clear, POS charge while DRAFT, bot /sales, checkout); reads switched (POS draft projection, delivery routes incl. eligible-sales/search/next stop, bot order history). Frontend: no keys added/removed; shippingAddress.id may be null with full address (relayed to frontend by backend). Old test sales without snapshot read as null; route creation with them -> 422. 7561 pass. In-place existingUpdated contract approved with coordinate rule (location change clears lat/long; non-body columns preserved); backend implementing T1.
- L3 — Owner: "actualmente en 'produccion' no hay nada real, nada importante, nadie usa el sistema (solo yo para pruebas) asi que no es necesario hacer migraciones de datos en 'produccion'". Told backend: schema migration only, no backfill, no backward-compat fallback for old test sales; general rule while there is no real usage.
- L2 — Backend options A snapshot / B copy-on-write archive / C in-place; owner chose A first. Requested backend A (snapshot columns, backfill with current address, reads switched, frontend impact report), then in-place existingUpdated contract proposal.
- L1 — Owner, 2026-10-19, chose option 2 "Que reemplace la dirección guardada" for the ZIP correction case above.
