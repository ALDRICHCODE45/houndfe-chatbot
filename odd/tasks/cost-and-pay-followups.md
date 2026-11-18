# Follow-ups: cost protection and pay in store

Small fixes recorded by reviews/verifications of `feat/cost-guard` and `feat/pay-in-store` (merged in main 58c4612), plus the owner's decision on the ops resume route. Branch `fix/cost-and-pay-followups`.

## Specs

- **S1 — Owner (verbatim):** "sobre la respuesta que necesites de mi, si, seguimos con tu recomendacion." — recommendation: when the LLM budget is spent and staff resolve a request, the staff answer still reaches the customer without using the LLM.
- **S2 — Ops resume with spent budget.** The AgentRunner ops "resolved" route (src/llm-agent/application/agent-runner.service.ts, dispatcher ops branch) must not reply LLM_BUDGET_EXHAUSTED_REPLY when the budget is spent: it relays the staff's answer deterministically (the same text the human typed, with the existing team prefix styling if any), with no LLM call. Budget available → today's behaviour unchanged.
- **S3 — Captioned receipt from a limited sender.** A photo during awaitingPayment / with a placed sale that vision would treat as a receipt must reach the receipt flow even when the sender is over the per-number limit or the budget is spent; receipts never count toward the per-number limit (S5 of cost-and-abuse-phase1). Rule: when a placed sale is awaiting payment, run receipt intake without photo admission (receipt extraction is already budget-gated inside the adapter, which skips extraction when spent but still uploads). A product question photo from a limited sender with no placed sale keeps being refused.
- **S4 — Notice retry backoff.** When the team request keeps failing, the released notice must not cause one notice + one request per message: release at most once per 15 minutes per sender and notice key (persisted or in-process is fine; document); within the backoff the refusal behaves as already notified (silence for the per-number limit; the budget fixed reply without a new request).
- **S5 — Pay in store copy.** Hours 1 o'clock use the singular article: «a la 1:00» (and «a las 2:00» etc.) in the reminder and in every «{fecha y hora}» text.
- **S6 — No [Pagar en tienda] while a receipt is in review.** The payment offer/status never shows the «Pagar en tienda» button when the placed sale has a receipt in review (the receipt-in-review reply already covers taps).
- **S7 — Receipt on an expired hold.** Backend: a receipt uploaded to a sale the hold sweep already cancelled is rejected 409 `SALE_NOT_PAYABLE`. When the placed sale was a pay-in-store hold, the customer reply is «Su pedido {folio} se canceló porque venció el plazo para recogerlo y pagarlo en tienda, así que no pudimos aplicar este comprobante. Si todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.» (tú styled). Other SALE_NOT_PAYABLE cases keep today's text.
- **S8 — Evidence.** RED test per rule; existing behaviour green; Docker specs for any store change; docs updated.

## Tasks

| ID  | Specs    | Route                         | Commit |
| --- | -------- | ----------------------------- | ------ |
| T1  | S2–S8    | worker: follow-up batch       | |

## Log

- **L1 (owner, 2026-11-18):** S1 quoted. Backend hold sweep contract (pay-in-store-hold-bot-contract.md «Hold sweep (T2)»): sweep every 30 s; reminder at holdExpiresAt−3h once per holdVersion; unpaid (CREDIT, paidCents 0) and no pending receipt → cancelled HOLD_EXPIRED, stock and promos returned, sale.pickup_expired; partial payment or pending receipt → not cancelled, staff notified, no bot item; fully paid → closed silently; receipt to a cancelled sale → SALE_NOT_PAYABLE.
