# Saved-address and next-page references (T3, Unit B)

`MinimalCheckoutAddressReferences` is a pure, in-memory registry that turns a trusted, sender-bound checkout-context read into opaque references for saved addresses and for the next page. It is the address/cursor foundation for T3: it is not wired into the conversation flow yet, and it performs no client call, no draft mutation and no persistent write.

A reference is correlation and opacity only — never authentication. Address ownership comes exclusively from the trusted WhatsApp sender-derived `GET /chatbot-api/customers/checkout-context` read, not from the hash.

## Quick path

1. Resolve the sender with the existing trusted phone parser, then read one page through `ChatbotApiClient.getCustomerCheckoutContext(cc, phone, { limit, afterAddressId })`.
2. Register only a `status: 'unique'` result with `registerPage({ context, query })`. Keep the original `query`; the registry returns detached offers, the page's exact query and a `nextPageReference`.
3. Present `addresses` (ordinal, label, reference) as grounding evidence. Resolve a chosen reference with `resolveAddress(reference)`, or continue with `resolveNextPage(reference)` and fetch exactly one more bounded page.

Focused offline check (mocked/offline, no backend, DB or network):

```sh
node node_modules/jest/bin/jest.js --runTestsByPath src/llm-agent/domain/minimal-checkout-address-references.spec.ts --runInBand
```

## Details

| Topic                | Decision                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted registration | Only `status: 'unique'` registers. `not_found`, `ambiguous`, a malformed envelope and a malformed query are rejected with `null` and change no local binding; a failure/absence is never inferred from them.                                                                                                                            |
| Frozen helpers       | The input envelope and query are re-validated with the frozen T1 `normalizeCustomerCheckoutContext` and `normalizeCheckoutContextQuery`. Out-of-range limits are rejected, never clamped.                                                                                                                                               |
| Reference binding    | Each address reference binds the trusted sender, the exact normalized lookup scope (`limit` + `afterAddressId`), the customer id and the raw address `id` + freshness `version`. It is never decoded from a model-supplied id.                                                                                                          |
| Identifier bytes     | Supported UUID case, NIL and MAX are preserved byte-for-byte. Addresses whose ids differ only by case stay distinct; the reference is never lowercased, trimmed or coerced.                                                                                                                                                             |
| Freshness `version`  | The backend `version` is a freshness marker, not a CAS guarantee. Revalidation compares it exactly; a changed version fails closed.                                                                                                                                                                                                     |
| Detached results     | Offers, resolved addresses, page queries and cursor queries are defensive copies. Callers cannot mutate a retained binding.                                                                                                                                                                                                             |
| Bounded paging       | One explicit caller request resolves to exactly one bounded page query. The registry never drains or auto-pages; the cursor reference is reusable and not consumed.                                                                                                                                                                     |
| Cursor provenance    | A next page must reuse the exact retained cursor (`limit` and `afterAddressId`) and resolve to the same customer. A mismatched, foreign, unknown or malformed cursor is rejected before any local change.                                                                                                                               |
| Retention            | At most `MINIMAL_CHECKOUT_ADDRESS_REFERENCE_MAX` (50) address bindings per sender. When forward paging needs room, the oldest page is retired and its references become stale (they resolve to `null`), so later pages stay reachable one bounded page at a time; registration is not permanently blocked after the fifth 10-item page. |
| Lifetime             | Bindings expire after `MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS` (5 minutes). Expired address, cursor and page references resolve to `null`.                                                                                                                                                                                           |
| Restart              | Retention is volatile and in-memory. A new instance or process restart forgets every reference; there is no snapshot/restore API, so a model-supplied snapshot is never trusted.                                                                                                                                                        |
| Revalidation         | `revalidateAddress(reference, freshContext)` accepts only a fresh `unique` page for the same customer that still contains the exact `id` + `version`. A dropped or version-changed address fails closed and retires the reference; a non-unique/malformed read is a lookup failure and does not invalidate it.                          |
| Grounding            | `viewPage(pageReference)` returns each offer with its 1-based `ordinal`, `label` and `label` again only when it is unique within the page (`uniqueLabel`), else `null`. There is no automatic first/newest selection and no model-supplied id is read.                                                                                  |
| Boundaries           | No SDK, HTTP, store, Nest, controller, module, draft or backend dependency. No new backend endpoint, store capability, environment gate, dependency or configuration.                                                                                                                                                                   |

## Trusted registration and freshness obligations

- Register only the output of the trusted sender-bound read. Never register a model-authored or cached page, and never treat a retained reference as proof of ownership.
- Keep the exact original page `query` returned with the selected address. Revalidation re-reads that one bounded page; it must not scan or enumerate other pages.
- Page-query provenance is volatile, exactly like the references. After a restart, a durable saved draft that holds only an address id plus a cached version cannot be freshness-revalidated in place. Fail closed: run a fresh, explicit, sender-bound lookup page, re-offer and re-select, then `revalidateAddress` against that live page. Do not trust the cached version and do not add a new by-id endpoint or unbounded scan.
- A retired, expired, foreign or version-changed reference must be treated as unavailable; re-present instead of confirming.

## Checklist

- [ ] Only a `unique` sender-bound page is registered.
- [ ] The exact original `query` is retained with each selected address.
- [ ] The coordinator fetches at most one bounded page per explicit request.
- [ ] A restarting or capacity-retiring registry re-looks-up and re-selects instead of trusting cached ids/versions.
- [ ] No model-supplied address id or snapshot is ever treated as authority.

## Next step

The T3 coordinator/service wires this registry to the trusted phone parser, the T1 client and the durable draft, then runs the public offline SDK regressions. Unit B alone does not prove live WhatsApp delivery, confirmation semantics or deployment.
