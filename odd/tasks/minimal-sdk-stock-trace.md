# Minimal SDK stock trace (bounded local follow-up)

**Authorization.** Owner-approved LOCAL additive follow-up to the minimal SDK
catalog route. No commits/push/deploy; no backend repo, DB/CAS, real API/Meta,
Docker, secrets, `.env` or dependency changes. Route stays exactly
`searchCatalog`/`checkStock` — no solicitudes/handoff/restock/sales/payments.

**Scope.** Tiny local NestJS `Logger` trace (prefix `minimal_catalog`) in the
inline tool `execute`s + a short `INSTRUCTIONS` tweak. Per-run opaque `randomUUID`
correlation (never sender/product/model-call id); positive `route_enter`; tool +
result + closed codes; checkStock logs `parentStockStatus`/`parentStockQuantity`.
Safe status allowlist (available/low_stock/out_of_stock/not_managed → else
`unknown`); finite else `null`. No raw query/text/name/UUID/phone/backend error/
stock-from-search; no new fallbacks/retries; a helper swallows logger throws so
tracing never changes tool bytes, reply or history. Budget 150–220 (ceiling 250).

**TDD.** RED: 3 failures — missing prompt facts (`en catálogo`, `agotado`,
`needs_human_review`, `no prueba`, `reservación`) and zero `route_enter`/tool
lines. GREEN: logs + prompt clauses → 7/7 focused pass, tools still two.
**Limits:** mocks cannot prove prompt obedience or tone; trace is log-only.
