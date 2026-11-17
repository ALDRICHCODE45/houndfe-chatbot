# Inventory evidence boundary (R2)

## Authorization and scope

Owner authorized stock/catalog corrections and explicitly approved separating mutating tool calls from checkStock batches. R1 is committed at d632a74b006e587c3f18158b1267200a0205b433; its tracker is frozen. No commit, push, deployment, provider generation, network, DB, Meta, environment reads or dependency changes authorized. .env must never be read; preserve .codegraph.

## Intended behavior

Search installs original backend results into CatalogSession for trusted identity, then projects results without product or variant stock. Preserve IDs, prices, descriptions and other necessary fields; add explicit requires_check_stock marker. Search is not inventory evidence.

Use installed AI SDK 7.0.9 complete parsed batch hook onLanguageModelCallEnd BEFORE execution, with run-local tool-call metadata and automatic toolApproval denial for mutating/unknown executable siblings of checkStock. No user-approval UI. Fail closed on missing/malformed batch metadata for mutations; diagnostic callback exceptions must not bypass enforcement. Never treat denial as queued or completed: the model must reissue in a later step. Unknown tool names default conservative.

Current mutating names: evaluateCart, upsertCustomer, createSale, updateDelivery, cancelSale, requestHumanAssistance, getShippingQuote. Current non-mutating names: searchCatalog, checkStock, getCustomerByPhone, getOrderHistory, getPaymentDetails, attachReceipt (compatibility no-op; preserve existing implementation).

Independent SDK-agnostic evidence guard aggregates completed steps atomically by toolCallId and product/variant. A failed stock check is unresolved; search cannot clear it. Only a later same-subject internally consistent authoritative available/low_stock/out_of_stock result clears it. Unknown/not_managed/malformed/mismatched/different-subject results do not clear. Same-step failure dominates success regardless callback order. Restrict subsequent activeTools to non-mutating tools while unresolved, restore after verified recovery.

When unresolved stock failure exists and no earlier mutating execution could have had effects, replace final reply with truthful inventory-unconfirmed copy, using the same text in returned reply and persisted assistant history. Do not claim exhaustion or availability. If any earlier mutating execution may have changed data (including ambiguous results), preserve existing reply instead of hiding effects: this is an explicit unresolved safety limitation, not a solved inventory guarantee. Do not build a seven-tool effect renderer in this unit. Projection also cannot universally prevent zero-tool hallucinations or stale historical claims.

## Tasks and route

- [x] R2.1 Read-only map of SDK complete-batch approval and side-effect limitations.
- [x] R2.2 Implement catalog projection, independent evidence guard and pre-execution separation with tests. Independent findings corrected with meaningful SDK execution regressions.
- [ ] R2.3 Independent checks, offline full suite and native review. Independent follow-up closed all four findings; native review pending.
- [ ] R2.4 Separate delivery consent and owner runtime validation.

## Exact edit surfaces

- src/sale-flow/application/tools/search-catalog.tool.ts
- src/sale-flow/application/tools/search-catalog.tool.spec.ts
- src/llm-agent/domain/inventory-evidence.guard.ts (new)
- src/llm-agent/domain/inventory-evidence.guard.spec.ts (new)
- src/llm-agent/infrastructure/vercel-ai-llm-agent.ts
- src/llm-agent/infrastructure/vercel-ai-llm-agent.spec.ts
- src/llm-agent/application/catalog-identity.integration.spec.ts

## Verification

Meaningful RED then GREEN. Real SDK MockLanguageModelV4 multi-step tests prove pre-execution denial, no approval UI, explicit reissue once, no reissue/no execution, supported siblings, unknown/malformed callback fail-closed. Guard tests cover subject identity, result correlation, inconsistent stock, parallel ordering, failed check then search, later recovery and earlier ambiguous mutations. Projection tests cover both stock levels and retained identity/prices; original DTO untouched. Existing R1 diagnostics and response/history consistency preserved. Mock output is not proof that real model never fabricates success.

Run focused four specs (search-catalog, guard, adapter, catalog-identity integration), TypeScript noEmit tsconfig.spec.json, scoped eslint without fix, diff check, and default offline full Jest after confirming external gates disabled. No live calls.

Forecast 400–700 authored lines including tests, advisory only: no minification or test deletion. Delivery strategy ask-on-risk; R1 size exception does not authorize R2 exception. Parent selects delivery boundary after actual size and review. One writer only; parent owns tracker. Rollback this unit only, retaining R1.

## Observed verification

Writer: 149 focused tests, TypeScript noEmit, scoped eslint and diff check passed. Offline full suite: 5434 passed / 755 skipped tests; 182 passed / 30 skipped suites. Tracked diff 781 additions / 31 deletions plus two new guard files; total exceeds forecast. Parent identified areas for independent verification: activeTools visibility versus actual execution after unresolved failure, quantity/variant consistency before clearing failure, stale batch metadata and unknown-effect preservation. Independent review confirmed these defects, then the writer corrected them. Final independent follow-up: 167/167 focused tests, TypeScript noEmit and diff check passed; offline full suite 5452 passed / 755 skipped tests, 182 passed / 30 skipped suites. Real SDK mock regression observed execution before the hard-denial fix and zero execution after it. First untrustworthy checks now open the guard; inconsistent quantity/duplicate variants cannot clear it; unknown executed tools preserve possible effects. DTO nullable-quantity semantics remain unproven, so conservative denial is intentional. Native assessment unavailable due untracked declaration; required independent verification complete. No live calls or production changes.

## Deferred priorities

Staff estimate/no-estimate to WhatsApp restart-safe admission remains separate D1. Earlier mutating effects plus later stock failure require a separately scoped outcome renderer if a universal guarantee is needed. Neither limitation should be hidden in completion claims.

## Amendment S12 (2026-11-17): search stock status is live evidence for availability labels

Backend evidence (intercom 2026-11-17): the catalog search and `GET /catalog/:id/stock` read the same live columns (no cache/replica), use the same `deriveStockState` thresholds, one balance per tenant, and both exclude expired lots and OFF variants. This refines "Search is not inventory evidence" above for the **chatbot minimal route** (`searchCatalog` in `minimal-catalog-agent.service.ts`):

- The search payload's stock **status** is live evidence for **availability labels** (agotado / available / low_stock / not_managed) of the products shown, derived in code (`domain/minimal-catalog-availability.ts`) with zero extra backend calls. No per-search `getStock` read (the S11/T7 reads in a263816 were removed). Quantities remain hidden from the model and the customer; the projection still carries no `stock` key.
- **Variant rule.** Simple or not-managed product → the item's own `stock.status`. Product with variants → **each variant's status**; the product-level availability is derived from the variants (any available → available; all agotado → agotado). The product-level quantity/status of a product with variants is never used, from either endpoint: search's product quantity is the raw `product.quantity`, and `/stock`'s product-level status/quantity ignore variants (backend asked to fix both).
- `checkStock` (explicit tool, fresh read) is unchanged for products without variants; for products with variants it does not expose the product-level `/stock` stock and derives `availability` from the variants' statuses.
- Unchanged: stock facts for purchase decisions (cart adds, `insufficient_stock`) keep their own fresh authenticated reads; a missing/inconsistent status is `unverified` and is neither claimed as exhausted nor as available; the "Encontré…, no «tenemos»" wording and the guard/tool-batch rules of R2 are untouched.
