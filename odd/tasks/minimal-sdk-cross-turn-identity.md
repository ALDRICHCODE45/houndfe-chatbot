# Minimal SDK cross-turn identity (bounded local bugfix)

**Authorization.** Owner-approved LOCAL additive bugfix at `98b3f01`. No
commits/push/deploy; no backend repo, DB, real API/Meta, Docker, secrets, `.env`,
deps. Route stays `searchCatalog`/`checkStock` — no solicitudes/handoff/restock/sales/payments.

**Defect.** `runTurn` rebuilt an empty id set every turn, so turn B's direct
`checkStock` on a productId verified in turn A was denied `unknown_product`
before any GET, though the flattened history still carried the search.

**Fix.** Per-sender history is an array of whole-turn records
`{messages, verifiedProductIds}`. `runTurn` retains the last `LLM_HISTORY_TURNS`
records, flattens their messages in order, and unions their ids into the allowed
set. A separate current-search set starts empty and records ONLY fresh successful
searches; projection runs before granting, so a failed/throwing search grants
nothing. Stock reads, greetings and user text never grant or renew ids; ids expire
with their originating turn.

**TDD.** RED at `98b3f01` before the production edit: the real-`generateText`
turn-B test saw `getStock` 0 times, expiry 0, failed/projection 1 (granted before
projection). GREEN after the change: 14/14 focused pass. **Limits:** mocks prove
tool/authority wiring, not real-model obedience.
