# Real-number MVP onboarding runbook

> Scope: MVP-2 of `odd/tasks/real-number-mvp-launch.md`. Companion to
> `docs/operations-human-handoff.md`. This document contains **no secrets**
> and must never be used to carry them.

## 1. Scope and current state

A **purchased SIM is not yet a Cloud API number.** The physical SIM is just
the telephone line; it becomes a WhatsApp Cloud API sender only after it is
added to the WABA, its ownership is verified, and it is registered through
the Cloud API. Until that happens the bot keeps using the Meta test number.

The bot code already supports the real number. Cutover is Meta work plus
configuration, not a code change.

## Canonical execution order after local delivery

Keep this order even when other features are explored in parallel:

1. **Deliver the branch** — inspect remote divergence, then push and integrate
   `feat/real-number-mvp-launch` only with separate authorization. This does
   not authorize deployment.
2. **Owner-present readiness check** — confirm the SIM is active, can receive
   SMS/voice, is not registered in WhatsApp Business App, has a physical
   holder, and has an agreed display name.
3. **Register in Meta** — add and verify the number, wait for display-name
   approval when required, register the phone-number ID, create the permanent
   System User token, and subscribe the WABA/app webhook `messages` field.
4. **Configure Dokploy** — the owner enters secrets directly; use the exact
   digit-only ops `wa_id`, keep sandbox normalization off, and keep every
   receipt-media flag off.
5. **Migrate and deploy** — apply target-database migrations, deploy the
   reviewed commit, run `pnpm preflight:launch`, and confirm webhook health.
6. **Run one synthetic journey** — use controlled test data for the complete
   text-sales path before admitting any customer.
7. **Open a limited pilot** — admit a small monitored client group with the
   rollback path ready.
8. **Resume ODD-8 after stability** — only then provision receipt-media
   infrastructure and enable its flags gradually.

Exploring another capability does not reorder or implicitly authorize any of
these gates. New capabilities require their own disabled-by-default rollout
and verification evidence before joining the pilot.

## 2. Official steps vs. project procedure

Meta documents the platform behavior; HoundFe owns the project-specific
sequence around it. Treat the following as **verified official steps**:

- Add the number to the WABA, verify ownership, then register it.
- Registration is **API-only** via `POST /<PHONE_NUMBER_ID>/register`.
- Registration requires a **6-digit two-step-verification PIN**.
- Registration rate limit: **10 requests per 72 hours**.
- The temporary dashboard token (24h) is unsuitable; use a **permanent
  System User token**.
- Subscribe the app/WABA webhook and the `messages` field.
- Meta may retry failed webhook deliveries for up to **7 days**, which can
  create **duplicate** inbound processing.

Official Meta sources:

- https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
- https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration
- https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks

Everything else here (Dokploy env names, deploy order, smoke journey,
rollback) is **project-specific procedure**, not Meta documentation.

## 3. Timing: Sunday prep vs. Monday owner-present actions

**Sunday (developer, no Meta mutation)**

- Confirm the client answers in §4.
- Agree the Dokploy secret **names** with the owner (§8); set no values.
- Read §5 with the client before anything touches the number.

**Monday (owner present, coordinated)**

- Add the number to the WABA and verify ownership (§6).
- Wait for display-name approval when Meta requires it (§6).
- Register with the two-step PIN (§6).
- Owner enters secret values in Meta/Dokploy (§6, §8).
- Deploy, migrate, subscribe the webhook, run the smoke journey (§9).

## 4. Client checklist (record, do not assume)

- [ ] **New number** — is the purchased line dedicated to the bot, or
      already used elsewhere?
- [ ] **SMS + voice** — can the line receive SMS and/or a voice call? Meta
      sends the ownership code through one of them.
- [ ] **WhatsApp / Business App status** — is the number installed in
      WhatsApp or WhatsApp Business App today? (See §5.)
- [ ] **Physical holder** — who holds the SIM and can read the verification
      code on Monday?
- [ ] **Display name** — what name should customers see? It must meet Meta's
      naming rules and approval can take time.

## 5. Warning — do not touch WhatsApp Business App first

A number can live in the WhatsApp Business App **or** the Cloud API, never
both. Registering/using it in WhatsApp Business App before the coordinated
flow forces a migration that removes it from the app and may need cleanup.

- Do **not** register or use the number in WhatsApp/WhatsApp Business App
  before the coordinated Cloud API flow.
- Chat history does **not** migrate to the Cloud API; back it up first if it
  matters.
- Contacts live in the device address book, not in WhatsApp; export them so
  the customer list can be loaded into the backend later.

## 6. Meta sequence (owner present)

1. **Add the number to the WABA** (WhatsApp Manager → Phone numbers).
2. **Verify ownership** with the code Meta sends by SMS or voice.
3. **Display name** — submit/confirm it; when Meta requires review, wait for
   approval before treating the number as ready.
4. **Register** via `POST /<PHONE_NUMBER_ID>/register` with
   `messaging_product=whatsapp` and `pin` = the owner's **6-digit
   two-step-verification PIN**. There is no dashboard button.
   - Rate limit: **10 requests / 72h** — do not retry blindly; a rejected
     attempt spends budget.
5. **Permanent token** — create a **System User** token in Business
   Settings; do not use the temporary dashboard token.
6. **Webhook** — subscribe the app/WABA to the webhook callback and the
   `messages` field; confirm it verifies with the existing verify token.

## 7. Existing HoundFe context to revalidate (not assume)

Business verification, the Meta app, the test WABA, the System User, and the
test deployment already exist externally. **Revalidate each one** against
this number before cutover; do not assume inherited access or scope.

## 8. Secret handling

- Never put tokens, PINs, the app secret, or verification codes in the repo,
  chat, tickets, logs, or screenshots.
- The **owner** types secrets directly into Meta and Dokploy; the developer
  never prints or echoes them.
- Dokploy secret names set at cutover (names only, owner supplies values):

  - `META_PHONE_NUMBER_ID` — the real number's phone-number ID.
  - `META_ACCESS_TOKEN` — the permanent System User token.
  - `META_SANDBOX_RECIPIENT_NORMALIZATION=false` — production keeps the
    exact inbound `wa_id`.
  - `OPS_CHANNEL_PHONE` — exact **digit-only** `wa_id` of the human agent
    (copy the value Meta delivers in an inbound `wa_id`; never the E.164 form
    with a leading `+`). Boot fails fast on a `+`/separator/whitespace form, so
    ops handoff replies cannot be silently dropped.
  - `HUMAN_HANDOFF_ENABLED` — keep `true` for the pilot.
  - Receipt flags stay **false**: `RECEIPT_MEDIA_ENABLED=false`,
    `RECEIPT_MEDIA_INGESTION_ENABLED=false`,
    `RECEIPT_MEDIA_METRICS_ENABLED=false` (ODD-8 gates).

- Preserve `META_APP_SECRET` and `META_VERIFY_TOKEN` unless Meta actually
  changes them; do not rotate them for convenience at cutover.

## 9. Deploy, health, and synthetic smoke journey

1. Set the Dokploy env names in §8 (owner enters values) and restart.
2. Run chatbot migrations against the target database.
3. Deploy the current commit; Joi validates env at boot and fails fast when
   `HUMAN_HANDOFF_ENABLED=true` and `OPS_CHANNEL_PHONE` is missing.
4. Confirm the webhook GET verification returns the challenge and `messages`
   is subscribed.
5. Run **one controlled synthetic text-sales journey** from the owner or a
   known phone: greeting → product search → stock → cart → customer/address
   → quote → sale → payment details → optional cancellation. Text only — no
   real customer data, payment, or receipt.

## 10. Rollback, stop conditions, and ODD-8 deferral

Rollback is configuration only; the test-number path stays available.

1. Restore the previous Dokploy values (`META_PHONE_NUMBER_ID`,
   `META_ACCESS_TOKEN`, `META_SANDBOX_RECIPIENT_NORMALIZATION=true`,
   `OPS_CHANNEL_PHONE`).
2. Restart the service and re-point the webhook subscription to the test
   number.
3. Re-run the smoke journey on the test number.

Stop and roll back on: webhook verification failure, signature failure,
duplicate/looping deliveries, handoff digests not reaching ops, or any
unexpected outbound to a real customer number.

**ODD-8 deferral:** receipt-media rollout stays deferred. All receipt flags
remain `false`; Spaces, capability keys, redaction proof, alerting, and
reconciliation drills are out of scope for this pilot.

## 11. Client message (neutral Mexican Spanish, copy-paste)

Hola 👋 Te comparto lo que necesitamos para activar el número real del bot.

Confírmanos, por favor:

1. ¿El número comprado es exclusivo para el bot o ya se usa en otro lado?
2. ¿Puede recibir SMS y/o llamada? Meta manda ahí el código de verificación.
3. ¿El número YA está instalado en WhatsApp o en WhatsApp Business App?
4. ¿Quién tiene físicamente el chip y puede leer el código el lunes?
5. ¿Qué nombre quieres que vean los clientes? Meta lo revisa y puede tardar.

Importante: **no registres ni uses el número en WhatsApp Business App**
antes del proceso coordinado. El historial de chats no se pasa al sistema
del bot; si te importan las conversaciones, respáldalas antes. Los contactos
sí se conservan (se exportan del teléfono).

Plan tentativo, siempre que Meta y los datos estén listos:

- prueba interna de 2 a 3 días hábiles;
- piloto controlado de 5 a 8 días hábiles.

El lunes hacemos la parte de Meta contigo presente. No compartas códigos ni
tokens por chat: los ingresas tú directo en Meta y en el panel.

## 12. Launch preflight (MVP-3, offline, no secrets)

Run `pnpm preflight:launch` before cutover and after every config change. It
prints one deterministic JSON report and exits `0` (pass), `1` (check
failures), or `2` (usage/runtime error). It reads only environment variable
names/presence, five posture flags, and `migrations/` filenames: no network,
no `.env`, no Nest boot, and never a value, token, length, or hash.

Report: `coreConfig` (`present|missing`); `posture` (`safe|unsafe|missing`
against exact `META_SANDBOX_RECIPIENT_NORMALIZATION=false`,
`HUMAN_HANDOFF_ENABLED=true`, and the three receipt flags `false`; missing or
non-exact fails closed); `migrations` (`present_on_disk|missing_on_disk`);
`clientRoutes`/`manualChecks` (always `manual_external`, never flipping `ok`).
`ok` is false only for missing core names, unsafe/missing posture, or a missing
migration file.

Limitations: presence is not validity; a migration file on disk is not an
applied migration; all reachability and data checks (backend, the 11 routes,
cashier user, `ServiceCredential` with seven scopes including
`payment-details:read`, active `PaymentDetail`, populated catalog) stay manual.
