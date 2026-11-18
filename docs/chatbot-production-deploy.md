# Chatbot production deploy (Meta test number)

Checklist for deploying `houndfe-chatbot` `main` to its VPS against the already-deployed production backend, using the Meta **test** number. The backend side is covered by `houndfe-backend/docs/deploy/production-launch-checklist.md`.

## 1. Before deploying

- The production backend is deployed and its post-deploy quick test passed.
- A production `ServiceCredential` exists with every scope the backend checklist lists. The chatbot code uses these 11: `catalog:read`, `pricing:evaluate`, `customers:read`, `customers:write`, `sales:create`, `sales:write`, `sales:read`, `shipping:quote`, `human-decisions:create`, `human-decisions:read`, `human-decisions:ack`. The raw `svc_...` key is generated on the owner's machine; never paste it in chat or logs.
- The cashier user is a **member of the bot's branch in production**; otherwise checkout fails with `404 CASHIER_NOT_FOUND`.
- Production data is loaded in the backend: at least one delivery zone, origin address (also the store-pickup address), store hours, boxes, per-product packaging, transfer bank details (without them payment details return 404), role permissions, and the notification-config entries `DELIVERY_ZONE_VALIDATION_REQUESTED` and `RECEIPT_REVIEW_REQUESTED`.

## 2. Push and deploy

1. `git push origin main` from this repo.
2. Deploy `main` on the chatbot VPS. Chatbot migrations (3200–5100) run automatically at startup.

### Customer memory table (migration 3700)

`3700000000000_customer_profiles` creates `customer_profiles`. It is additive and has no backfill. There is one row per WhatsApp sender (`sender_id` = wa_id digits), holding:

- how to address the customer: WhatsApp profile name, the name they asked to be called (or their checkout first name), usted/tú, emojis, tone;
- pet facts the customer gave, as JSONB;
- a pointer to their last order: folio, date and total. The order itself stays in the backend.

Writes are merge-only, so a known value is never erased by a later turn. The bot reads the stored style for later notices (receipt outcome, resolved zone, restock and expiration answers); with no row, or if the read fails, those notices go out in usted. A customer who writes "olvida mis datos" or "borra mis datos" has their row deleted. The bot does not write it again until the next restart; after a restart, new messages start a new profile. The down migration refuses to drop a non-empty table.

## 3. Environment variables on the chatbot VPS

| Variable                               | Value                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `META_PHONE_NUMBER_ID`                 | Phone Number ID of the Meta test number                                                                               |
| `META_ACCESS_TOKEN`                    | A valid token (the temporary one lasts 24 h; a System User token is permanent)                                        |
| `META_APP_SECRET`                      | App secret (verifies webhook signatures)                                                                              |
| `META_VERIFY_TOKEN`                    | The same value registered in the Meta webhook settings                                                                |
| `META_SANDBOX_RECIPIENT_NORMALIZATION` | `true` for the test number; remove or `false` for the real number                                                     |
| `OPS_CHANNEL_PHONE`                    | WhatsApp ID (digits only) that receives human-attention notices; with the test number it must be a verified recipient |
| `CHATBOT_API_BASE_URL`                 | Production backend URL                                                                                                |
| `SERVICE_KEY`                          | The new production `svc_...` key                                                                                      |
| `CHATBOT_API_BRANCH_ID`                | Branch (tenant) id bound to the credential                                                                            |
| `CHATBOT_API_CASHIER_USER_ID`          | Production cashier user id (member of that branch)                                                                    |
| `OPENAI_API_KEY`, `LLM_MODEL`          | OpenAI key and model                                                                                                  |
| `DATABASE_URL`                         | The chatbot's own Postgres                                                                                            |
| `CONVERSATION_MIRROR_DELIVERY_ENABLED` | Default `false` (off unless exactly `true`). See "Conversation mirror delivery flag" below                            |
| `LLM_PRICE_INPUT_USD_PER_MTOK`         | Default `0.15` (gpt-4o-mini list price, USD per million input tokens). **Update if `LLM_MODEL` changes**              |
| `LLM_PRICE_OUTPUT_USD_PER_MTOK`        | Default `0.60` (gpt-4o-mini list price, USD per million output tokens). **Update if `LLM_MODEL` changes**             |
| `LLM_DAILY_BUDGET_USD`                 | Default `10`. LLM spend cap per calendar day (America/Mexico_City). See "LLM cost protection" below                   |
| `LLM_MONTHLY_BUDGET_USD`               | Default `200`. LLM spend cap per calendar month (America/Mexico_City)                                                 |
| `LLM_MAX_OUTPUT_TOKENS`                | Default `600`. Output cap of every LLM call                                                                           |
| `INBOUND_TEXT_MAX_CHARS`               | Default `1000`. Customer text is cut to this length before any LLM use (the transcript keeps the original)            |
| `SENDER_LLM_LIMIT_PER_HOUR`            | Default `40`. LLM-using turns per WhatsApp number in a rolling hour                                                   |
| `SENDER_LLM_LIMIT_PER_DAY`             | Default `120`. LLM-using turns per WhatsApp number in a rolling 24 h                                                  |
| `PAY_IN_STORE_ENABLED`                 | Default `false` (on for `true`, `TRUE` or `True`). «Pagar en tienda» for pickup orders and the `sale.pickup_*` notices; turn on only after the backend's pay-in-store deploy and chatbot migration 5200 (docs/minimal-order-placement.md, "Pay in store") |

### Conversation mirror delivery flag

`CONVERSATION_MIRROR_DELIVERY_ENABLED` (default `false`) controls whether the chatbot sends the conversation mirror (messages, media and delivery statuses) to the backend. Capture always runs: the transcript is written and the mirror rows are enqueued in the outbox. While the flag is off, no call is made to the backend; the rows wait in the outbox and retry with the usual backoff, so nothing is lost. The boot log shows "conversation mirror delivery disabled (CONVERSATION_MIRROR_DELIVERY_ENABLED=false): mirror rows are kept until enabled", and the not-wired fallback warns at most once per kind per minute.

Enable it (`true`, then restart) only after the backend has unit 9 (`messages:batch`, `statuses:batch`, `POST /media`) in production. Before that:

- The service credential needs the `conversation:write` and `media:write` scopes.
- Migrations 4600, 4700 and 4800 must have run on the chatbot database.

### LLM cost protection (migration 5100)

`5100000000000_llm_cost_guard` creates the spend ledger (`llm_usage_ledger`, `llm_spend_periods`) and the per-number windows (`llm_sender_turns`, `llm_guard_notices`). It is additive; its down migration refuses while any LLM call of the last 32 days is booked (dropping it would reset the month's budget).

- **Spend cap.** Every LLM call (agent turns and their retry/render calls, the restock classifier, receipt vision, product-photo description, the ops resume turn) is booked with its input/output tokens and an estimated USD = tokens × `LLM_PRICE_*_USD_PER_MTOK` / 1,000,000. Image inputs are billed as input tokens, so they need no separate price. The defaults are the gpt-4o-mini list prices: set them to the production model's real prices whenever `LLM_MODEL` changes. Totals are per calendar day and month in America/Mexico_City and survive restarts. At 80% of either cap the log shows one `warn` per period; at 100% it logs once more and no new LLM call starts. The customer then gets «En este momento no puedo atenderle por aquí; ya le avisé al equipo y le escriben en cuanto puedan.» (tú when the customer writes in tú), and the team gets one request per number per period. Receipt vision and product-photo description are skipped (a receipt is still uploaded, without pre-filled data). Buttons, SÍ confirmations, payment details, receipt uploads and human handoff keep working. If the ledger cannot be read or written, the customer is served (the LLM is allowed) and the log shows an `error`.
- **Per-number limit.** Only turns that would call the LLM count; buttons, deterministic replies, SÍ, receipts and handoff do not. When a number exceeds `SENDER_LLM_LIMIT_PER_HOUR` or `SENDER_LLM_LIMIT_PER_DAY`, the first refused message gets «Estamos revisando sus mensajes; en un momento le atiende alguien del equipo.» and one team request ("El número superó el límite de mensajes del bot…"). Later messages in that window get no reply and no LLM call, but they are still recorded and mirrored. Normal service resumes when the window frees. The limits hold across restarts and processes. A product photo counts as one LLM-using turn and is admitted before its vision call, so a refused number (or a spent budget) gets the same reply or silence as a text, with no vision call. Receipts of a placed order are never limited. If the team request of a first refusal (budget or limit) cannot be created, the notice is released, so the next message tries the reply and the request again. The bot never goes silent without a team request.
- **Caps.** Every call uses `maxOutputTokens = LLM_MAX_OUTPUT_TOKENS`. Customer text longer than `INBOUND_TEXT_MAX_CHARS` is cut before the model sees it.
- **Closings without the LLM.** Pure closings («gracias», «ok», «va», «listo», «perfecto», «👍», «🙏», «gracias, buen día», «nos vemos» and combinations of these) get «¡Con gusto! Aquí estoy si necesita algo más.», or nothing if the bot's previous message already closed the conversation. While a question, confirmation or offer from the bot is pending, or a purchase is in progress (items in the cart, or delivery data being collected), these messages go to the model as before.
- **Cost per turn.** One indexed query per LLM-using turn for both the budget and the limits (primary-key read of the two period rows plus the sender's rows of the last 24 h, which it also prunes). Usage is booked off the reply path.

`LLM_MONTHLY_TOKEN_CEILING` is retired (ignored if left).

Obsolete variables that can be deleted (ignored if left): `SKYDROPX_*`, `RECEIPT_STORAGE_*`, every former feature flag, `META_WABA_ID`, `META_API_VERSION`, `LLM_MONTHLY_TOKEN_CEILING`.

## 4. Smoke test over WhatsApp

From the verified test phone, message the test number:

1. Search a product, ask about stock, add it to the cart.
2. "Quiero comprar": try delivery to a ZIP in a configured zone, and store pickup.
3. Confirm with "SÍ": the bot returns the folio and transfer details.
4. Send a receipt photo or PDF: the bot replies "recibido, en revisión".
5. Confirm or reject the receipt in the system: the customer notice arrives within about 1 minute.

If something fails, note the message sent, the bot's reply and the time, and check the chatbot logs.

## 5. After deploy

- Tell the backend it can close the legacy receipt `mediaUrl` body and the legacy `chargeCents`/`approvalId` checkout shape.
- Moving to the real number later only changes `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` (permanent) and drops `META_SANDBOX_RECIPIENT_NORMALIZATION`; then create the `zona_entrega_revisada` and `comprobante_revisado` templates.
