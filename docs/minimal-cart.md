# Cart on the minimal WhatsApp route

The enabled, allowlisted minimal agent can maintain a cart without using the legacy sales agent. It cannot create orders, collect payment, quote shipping or reserve stock.

## Customer rehearsal (after separately authorized deployment)

1. Search for a product and select its presentation explicitly.
2. Say “Agrega 2 ibuprofenos de 500mg a mi carrito por favor”: an empty line becomes two units; an existing two-unit line becomes four.
3. Say “Déjame 2 ibuprofenos de 500mg”: the total becomes two, not four. “Quita uno” leaves one; “quita el ibuprofeno de 500 de mi carrito por favor” removes the whole line. Use an actual catalog presentation; if identity or presentation is ambiguous, the bot must ask rather than guess.
4. Restart the service and ask to view a non-empty cart again.

No transfer or order is needed. Use controlled catalog data; this route reads the backend catalog, stock and pricing, but only writes the local conversation cart.

## Tools and guarantees

| Tool              | Input                                                                   | Behavior                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCart`         | `{}`                                                                    | Reads the durable cart and obtains a fresh quote. Failed verification does not mean the cart is empty.                                                                                                                   |
| `setCartItem`     | `selectionRef`, `quantity`, `quantityText`, `continuation`              | Sets the **total** quantity for the selected product/presentation; `0` removes the line. Repeating the same requested total does not add it again.                                                                       |
| `adjustCartItem`  | `selectionRef`, `delta`, `quantityText`, `continuation`                 | Applies a signed, nonzero integer delta. Positive adds units to the stored quantity (or starts a new line); negative subtracts. Reaching zero removes it; a negative/unsafe resulting total is rejected without a write. |
| `prepareCartItem` | `selectionRef`, `operation`, `quantity`, `quantityText`, `continuation` | Records a grounded intent (product + operation + optional count) for the same pending request. **Never writes the cart.** Used to preserve an explicit count before a presentation is chosen.                            |

- **Identity is server-owned.** All cart tools take only an opaque `selectionRef`; the model never supplies a `productId`, `variantId`, price or sender. A verified read (`searchCatalog`, `checkStock`, `getCart`) returns `cartSelectionRef` for the product and for each exact variant. `selectionRef` must be one of those server-returned references; an unknown, stale or invented reference is rejected without a write.
- **A reference binds one verified pair.** A presentation choice cannot be misattributed to another product: the reference resolves to the exact (product, optional variant) the server registered. Variant ownership is still rechecked against fresh catalog, stock and pricing; even a previously read pair is rejected if the fresh projection no longer contains it.
- **Quantities are grounded in the customer's text.** `quantityText` must quote the literal current message (`"2"`, `"una"`); an uncited or invented number, a dosage such as `500 mg`, a negative value or competing counts ask for clarification instead of writing. Recognized Spanish count words are `cero`, `un/una/uno` through `diez`; eleven and above must be cited as digits. The singular idiom `otra unidad` counts as one unit, and a bare `otra` citation does too only when its real context shows the singular noun `unidad`. This is a narrow grounded idiom, not general Spanish coverage: the plural `otras unidades`, `otra presentación` and repeated ambiguous `otra` evidence are not read as a quantity.
- **Presentation numbers are not unit counts.** A single measured dose in a server-verified variant label (including `Tabletas 500mg`) can identify a dose-role mention in the current text. A matching `500mg`, or a bare `de 500` bound to the named product/selected presentation, is excluded from a broad literal quantity citation: `un ibuprofeno de 500` still proves one unit. This is positional, not global number stripping: `500 unidades` remains a quantity; competing counts, unknown/mismatched doses, missing trusted measured labels and uncited actual counts still fail closed. `Sí, la de 500mg` without a count preserves the chosen reference and asks for quantity even if the model guessed one or proposed set-zero; no cart write occurs. A compatible grounded pending count may still carry within the same request. An explicit ADD proposed as SET remains rejected, never silently rewritten. A mixed measured-dose confirmation such as `500mg o 250mg` is rejected before clarification or pending-count carry; it cannot authorize a write simply because one dose matches the selected reference.
- **Pending intent is request-scoped.** A stated count may carry across turns only within the same pending request and the same product/operation. A new explicit count supersedes the pending one. A mutation attempt (successful or failed) disarms the request; within the same SDK run a later set, adjust or prepare on that **same pair** is blocked rather than re-armed, and the attempted operation is never automatically retried. A completed request must not run again. Clarification and preparation are not mutations.
- **Server-controlled replies.** A missing quantity produces a server question, not a model claim: `¿Cuántas unidades desea agregar? Dígame un número, por favor.` An ungrounded citation/consistency failure produces `No pude confirmar esa operación con la información de su mensaje. No modifiqué el carrito; ¿puede indicarme de nuevo qué desea?` An unknown/stale reference produces the generic cart rejection. Malformed tool arguments and unknown references must never become unsupported customer acknowledgements, and a later unknown/malformed call must not overwrite an already-delivered successful mutation acknowledgement with a false “no modifiqué / no confirmé” message.
- **Named whole-line removal.** Removing a named line (“Quita el ibuprofeno”) may rely on the optional server-trusted product/variant labels the caller supplies to grounding — never a model-supplied label — and only when the current text actually contains the name. A partial count (“Quita una unidad de ibuprofeno”, “Quita otra unidad de ibuprofeno”) still rejects whole-line removal, and an explicit negation (“No eliminar el ibuprofeno”) fails closed without a write.
- **Identity guidance is prompt-only.** The instructions and both mutation tool descriptions tell the model to copy the exact `cartSelectionRef` returned for the product or presentation and to prepare before asking for a presentation when a quantity was already supplied. These instructions guide the model; they do not replace server validation.
- **Every remaining line is rechecked.** Each line is repriced and stock-checked before confirmation. Unknown/unmanaged stock, missing price, insufficient quantity, backend failure or invalid pricing response holds without a cart write. No automatic stock reservation is performed.
- **Pricing evaluation returns extended line totals.** The cart sums each final line total once, not once per unit. `needs_human_review` is displayed, not presented as an approved promotion.
- A fresh `getCart` quote is read-only; saved prices are snapshots, not a checkout price guarantee.
- Replies following cart tools come from the server result, not an unsupported model success claim. Existing EXPIRATION/RESTOCK acknowledgement priority remains unchanged.

### Bounded context

- The selection registry holds at most **50 bindings per sender**. Registration beyond that returns `null`, so an unregistered pair cannot resolve; the model is asked to re-read rather than have a pending request silently rebound to another product.
- Session turns persist the typed selection snapshot and the pending intent, so a reference read in an earlier turn still resolves later. State is server-owned and sender-scoped; a model-supplied snapshot is never trusted.
- The durable cart format is unchanged (`conversation_state.data.minimalCart`). Minimal-route chat history and the selection/pending context remain in memory: a process restart forgets them, and the customer must view or search again to recover identities. This restart-loss boundary is unchanged by this feature.
- The boundaries, count-word limit and 50-binding cap are documented limits, not universal language coverage. Live model intent recognition is not proven by these tests.

## Safe cart diagnostics

Each completed `getCart`, `setCartItem` or `adjustCartItem` execution emits one best-effort trace using the same trace ID as `route_enter` and catalog tools:

```text
minimal_catalog tool getCart result=ok trace=<trace-id>
minimal_catalog tool adjustCartItem result=error code=stock_unverified trace=<trace-id>
```

Only the fixed tool name, success/error result, allowlisted error code and generated trace ID are recorded. Customer text, phone numbers, product/variant IDs, names, quantities, prices, tool payloads and credentials are not logged by these traces. Unknown error strings become `unrecognized_cart_error`; logger failures do not affect replies or persistence.

Grounding also emits a private, closed-code trace before a mutation/preparation outcome:

```text
minimal_catalog cart_grounding tool=setCartItem mode=set result=invalid_evidence reason=operation_mismatch trace=<trace-id>
```

`mode` is one of `add`, `set`, `subtract`, `remove`; `result` is `ready`, `quantity_required` or `invalid_evidence`. `reason` is `none`, `evidence_rejected`, `operation_mismatch`, `quantity_out_of_range` or `removal_unconfirmed`. These codes contain no customer text, count values, labels, references or payloads, and are not returned to the model or stored in conversation history. The trace is best-effort and makes no backend request. `operation_mismatch` identifies a clear ADD offered as SET; it does not permit an automatic retry or operation override.

For a failed rehearsal, capture all entries for that turn's trace ID. `getCart` alone indicates a completed read, not an attempted addition. `stock_unverified` means stock could not be verified; `insufficient_stock` means verified stock was too low; `invalid_evaluation` means the pricing response failed validation; `cart_changed` means the compare-and-set lost a conflict. `cart_unavailable` can represent a backend or persistence failure and does not identify which one. The result codes alone do not identify the failing line in a multi-item cart. Absence of a cart trace does not prove why a tool failed to execute (for example, SDK input validation can reject it before execution).

An `invalid_variant` rejection also emits a privacy-preserving comparison immediately before the result trace:

```text
minimal_catalog cart_variant_check operation=setCartItem line=2 origin=requested catalog_match=false stock_match=false variant_is_product=false trace=<trace-id>
```

- `line` is the one-based position in the proposed cart being validated, not necessarily the order shown before the operation: a modified line is moved to the end. Only the first rejected line is reported.
- `origin=requested` identifies the exact product/presentation targeted by the current mutation, including an existing line being adjusted; `stored` identifies another saved line. All lines in `getCart` are `stored`.
- `catalog_match` and `stock_match` indicate whether the supplied variant was present in the actual catalog and stock responses consumed for that line. Both false does not prove invention: a stale server reference or changing backend data can also explain it.
- `variant_is_product=true` indicates that the supplied variant ID equals that line's product ID; it does not log either ID.

These traces contain only a position, fixed operation/origin labels and booleans, besides the generated trace ID. Unexpected diagnostic values become `unknown`. No IDs or response payloads are logged; the comparison is neither returned to the model nor persisted. Diagnostic/logger exceptions do not change the original rejection or permit a write. No additional backend requests are made.

This instrumentation changes neither cart rules nor reply priority. It is diagnostic evidence, not a fix for live intent interpretation. After deploying, rehearse adding one simple product while a different variantful product is already in the cart: the saved presentation must remain unchanged, the simple product must have no invented presentation, and the total must match the verified prices. This live model check is still pending until performed. After separately authorized deployment, repeat the failed phrase once and inspect the correlated traces; do not automatically retry quantity adjustments.

## Persistence and rollout

The existing `CartState` format is reused under `conversation_state.data.minimalCart`. The legacy `data.cart` is deliberately untouched: it belongs to the old checkout path and must not silently become the new checkout's authority.

An exact-prior-value compare-and-set writes only `minimalCart`, preserving live siblings. A conflict returns a cautious failure without automatic retry. Generic conversation updates cannot overwrite this CAS-owned key. PostgreSQL persists it across adapter/service restarts; the in-memory adapter is only a test substitute. No migration, dependency or new environment variable is required. The selection/pending context is not part of this durable cart format and is lost on restart.

Availability follows the existing `MINIMAL_CATALOG_AGENT_ENABLED` and exact `MINIMAL_CATALOG_AGENT_ALLOWED_SENDERS` gate. A deployment/configuration change still requires separate authorization. Catalog chat history remains in-memory; cart persistence does not make that history durable. After restart, view the cart to recover its product identities, or search again for a new product.

## Checks

```sh
pnpm test --runTestsByPath src/llm-agent/application/minimal-catalog-cart.spec.ts src/llm-agent/application/minimal-catalog-cart-ambiguity.spec.ts src/llm-agent/domain/minimal-cart-quantity.spec.ts --runInBand
RUN_DOCKER_TESTS=1 pnpm test --runTestsByPath src/conversation/infrastructure/minimal-cart-persistence.spec.ts --runInBand
```

The SDK checks use an offline/mocked provider and isolated in-memory state; they establish local tool behavior, not live model intent recognition or Meta delivery. The Docker check uses disposable PostgreSQL, not the configured production database. WhatsApp rehearsal is still required after deployment. Checkout and shipping remain separate future increments.
