# Cart on the minimal WhatsApp route

The enabled, allowlisted minimal agent can now maintain a cart without using the legacy sales agent. It cannot create orders, collect payment, quote shipping or reserve stock.

## Customer rehearsal (after separately authorized deployment)

1. Search for a product and select its presentation explicitly.
2. Say “Agrega 2 ibuprofenos de 500mg a mi carrito por favor”: an empty line becomes two units; an existing two-unit line becomes four.
3. Say “Déjame 2 ibuprofenos de 500mg”: the total becomes two, not four. “Quita uno” leaves one; “quita el ibuprofeno de 500 de mi carrito por favor” removes the whole line. Use an actual catalog presentation; if identity or presentation is ambiguous, the bot must ask rather than guess.
4. Restart the service and ask to view a non-empty cart again.

No transfer or order is needed. Use controlled catalog data; this route reads the backend catalog, stock and pricing, but only writes the local conversation cart.

## Tools and guarantees

- `getCart`: reads the durable cart and obtains a fresh quote. Failed verification does not mean the cart is empty.
- `setCartItem`: sets the **total** quantity for an exact product/presentation; zero removes the line. Repeating the same requested total does not add it again. The model cannot supply a price or sender identity.
- `adjustCartItem`: applies a signed, nonzero integer `delta`. Positive adds units to the stored quantity (or starts a new line); negative subtracts units from an existing line. Reaching zero removes it; a negative/unsafe resulting total is rejected without a write. Arithmetic uses the same stored snapshot checked by CAS, not a model-calculated total. Each new “add two” request is an increment, unlike an absolute “leave two” request. Conflicts and uncertain persistence are never automatically retried, because deltas are not idempotent.
- The SDK instructions distinguish “Agrega 2”, “Déjame 2”, “Quita el producto”, and “Quita uno”. Mocked tool-call tests pin execution and instructions; live model interpretation of these phrases still requires the owner rehearsal.
- Product identity must have been found in the current conversation or already belong to this sender's cart. The service checks variant ownership against fresh catalog and stock responses. A variant product requires an explicit presentation.
- Every remaining line is repriced and stock-checked before confirmation. Unknown/unmanaged stock, missing price, insufficient quantity, backend failure or invalid pricing response holds without a cart write. No automatic stock reservation is performed.
- Pricing evaluation returns extended line totals; the cart sums each final line total once, not once per unit. `needs_human_review` is displayed, not presented as an approved promotion.
- A fresh `getCart` quote is read-only; saved prices are snapshots, not a checkout price guarantee.
- Replies following cart tools come from the server result, not an unsupported model success claim. Existing EXPIRATION/RESTOCK acknowledgement priority remains unchanged.

## Persistence and rollout

The existing `CartState` format is reused under `conversation_state.data.minimalCart`. The legacy `data.cart` is deliberately untouched: it belongs to the old checkout path and must not silently become the new checkout's authority.

An exact-prior-value compare-and-set writes only `minimalCart`, preserving live siblings. A conflict returns a cautious failure without automatic retry. Generic conversation updates cannot overwrite this CAS-owned key. PostgreSQL persists it across adapter/service restarts; the in-memory adapter is only a test substitute. No migration, dependency or new environment variable is required.

Availability follows the existing `MINIMAL_CATALOG_AGENT_ENABLED` and exact `MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS` gate. A deployment/configuration change still requires separate authorization. Catalog chat history remains in-memory; cart persistence does not make that history durable. After restart, view the cart to recover its product identities, or search again for a new product.

## Checks

```sh
pnpm test --runTestsByPath src/llm-agent/application/minimal-cart.service.spec.ts src/llm-agent/application/minimal-catalog-cart.spec.ts src/conversation/infrastructure/minimal-cart-persistence.spec.ts --runInBand
RUN_DOCKER_TESTS=1 pnpm test --runTestsByPath src/conversation/infrastructure/minimal-cart-persistence.spec.ts --runInBand
```

The Docker check uses disposable PostgreSQL, not the configured production database. Mock SDK/HTTP tests establish local tool behavior, not live model intent recognition or Meta delivery. WhatsApp rehearsal is still required after deployment. Checkout and shipping remain separate future increments.
