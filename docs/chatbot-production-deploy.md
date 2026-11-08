# Chatbot production deploy (Meta test number)

Checklist for deploying `houndfe-chatbot` `main` to its VPS against the already-deployed production backend, using the Meta **test** number. The backend side is covered by `houndfe-backend/docs/deploy/production-launch-checklist.md`.

## 1. Before deploying

- The production backend is deployed and its post-deploy quick test passed.
- A production `ServiceCredential` exists with every scope the backend checklist lists. The chatbot code uses these 11: `catalog:read`, `pricing:evaluate`, `customers:read`, `customers:write`, `sales:create`, `sales:write`, `sales:read`, `shipping:quote`, `human-decisions:create`, `human-decisions:read`, `human-decisions:ack`. The raw `svc_...` key is generated on the owner's machine; never paste it in chat or logs.
- The cashier user is a **member of the bot's branch in production**; otherwise checkout fails with `404 CASHIER_NOT_FOUND`.
- Production data is loaded in the backend: at least one delivery zone, origin address (also the store-pickup address), store hours, boxes, per-product packaging, transfer bank details (without them payment details return 404), role permissions, and the notification-config entries `DELIVERY_ZONE_VALIDATION_REQUESTED` and `RECEIPT_REVIEW_REQUESTED`.

## 2. Push and deploy

1. `git push origin main` from this repo.
2. Deploy `main` on the chatbot VPS. Chatbot migrations (3200–3700) run automatically at startup.

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

Obsolete variables that can be deleted (ignored if left): `SKYDROPX_*`, `RECEIPT_STORAGE_*`, every former feature flag, `META_WABA_ID`, `META_API_VERSION`.

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
