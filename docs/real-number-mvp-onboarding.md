# Real-number MVP onboarding runbook

> Scope: MVP-2 of `odd/tasks/real-number-mvp-launch.md`. Companion to
> `docs/operations-human-handoff.md`. This document contains **no secrets**
> and must never be used to carry them.

## 0. Resume here (status 2026-11-09)

Cutover is **paused until the client confirms** the number is available.
When they do, resume from this checklist; the sections below hold detail.

### Where things stand

- Chatbot `main` is deployed on Dokploy at `https://bot.houndfe.com/webhook`.
  Checked 2026-11-09: GET verification returns the challenge, and a POST
  signed with the app secret returns `{"received":true}`. The chatbot side works.
- The Meta app **lost its test number**: the dashboard shows "No hay números
  de teléfono disponibles para esta app", so Meta delivers no webhooks (the
  dashboard Test button reached nothing). The temporary access token can no
  longer be found. Cause unknown (portfolio change or app/WABA detachment).
  Instead of recovering it, the owner chose to move to the real number.
- The chatbot database was emptied for a clean test (all tables except
  `pgmigrations`; 21 migrations applied).
- `OPS_CHANNEL_PHONE` holds a placeholder number only so that the app
  boots. The WhatsApp ops channel is being replaced by in-system requests
  (see the human-intervention design work).

**Owner preference: do everything from the Meta web UI, no terminal.**
Meta has no dashboard button for the final _register_ step: it is one
Graph API call (Meta Help Center: "you'll need a developer to connect your
phone number"). Do it from the browser with Meta's **Graph API Explorer**
(`https://developers.facebook.com/tools/explorer/`), which is a Meta web page.

### Checklist (owner and SIM holder present, about 30 minutes plus display-name review)

1. Client answers §4 (send the message in §11). If the number has WhatsApp
   or WhatsApp Business installed, back up chats, export contacts, then delete
   that WhatsApp account on the phone **before** step 3 (§5).
2. Revalidate Meta (§7): Business Settings → the app belongs to the right
   business portfolio and has a WhatsApp Business Account (WABA). This also
   explains where the test number went.
3. Add the number: Meta Business Suite → All tools → WhatsApp Manager →
   select the WABA → **Phone numbers → Add phone number**. Enter the display
   name, category and the number, choose SMS or voice call, and type the
   6-digit code the SIM holder receives. The code expires in minutes.
4. Display name: wait until it shows approved, or wait for review if Meta asks.
5. Copy the number's **Phone number ID** (WhatsApp Manager → Phone numbers,
   or App Dashboard → WhatsApp → API Setup).
6. Permanent token: Business Settings → Users → **System users** → add or
   reuse an admin system user → **Assign assets** (the app with full
   control and the WABA) → **Generate token** for the app with
   `whatsapp_business_messaging` and `whatsapp_business_management`, expiry
   **Never**. Store it somewhere safe; Meta shows it only once.
7. Register (browser): Graph API Explorer → select the app → paste the
   system-user token → method **POST** → path `<PHONE_NUMBER_ID>/register`
   → body `{"messaging_product":"whatsapp","pin":"<6 digits you choose>"}`
   → Submit. Expect `{"success":true}`. The PIN becomes the number's
   two-step-verification PIN: save it. Limit: 10 attempts per 72 h, so
   never retry blindly.
8. Subscribe the WABA to the app (browser, same Explorer): **POST**
   `<WABA_ID>/subscribed_apps` → `{"success":true}`. Check with **GET** on
   the same path; the app must appear in `data`.
9. App Dashboard → WhatsApp → Configuration: the callback URL stays
   `https://bot.houndfe.com/webhook`, and `messages` must be **Subscribed**.
10. Dokploy (owner types the values): `META_PHONE_NUMBER_ID` (new),
    `META_ACCESS_TOKEN` (system-user token),
    `META_SANDBOX_RECIPIENT_NORMALIZATION=false`. Keep `META_APP_SECRET` and
    `META_VERIFY_TOKEN` unchanged. Redeploy and check the boot logs.
11. Smoke test from the owner's phone to the **new number**, following
    the manual test script: greeting → search → cart → delivery data →
    shipping → order → bank details → receipt. A valid inbound logs
    `process <id> from <number>`.

Never paste codes, PINs or tokens into chat, the repo, tickets or screenshots (§8).

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
   digit-only ops `wa_id` and keep sandbox normalization off. Receipt media
   is always on (no flag); the backend stores the receipt files.
5. **Migrate and deploy** — apply target-database migrations, deploy the
   reviewed commit, run `pnpm preflight:launch`, and confirm webhook health.
6. **Run one synthetic journey** — use controlled test data for the complete
   text-sales path before admitting any customer.
7. **Open a limited pilot** — admit a small monitored client group with the
   rollback path ready.
8. **Watch transfer receipts** — the bot uploads each receipt to the backend,
   a human confirms or rejects it there, and the bot relays the outcome.

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
  - No receipt flags or storage variables: receipt media is always on and the
    backend stores the files, so `RECEIPT_MEDIA_ENABLED`,
    `RECEIPT_MEDIA_INGESTION_ENABLED`, `RECEIPT_STORAGE_*`,
    `RECEIPT_CAPABILITY_*`, `RECEIPT_MEDIA_PUBLIC_BASE_URL` and
    `CHATBOT_API_ATTACH_TIMEOUT_MS` are not used (delete them from Dokploy if
    present; a leftover value has no effect). `META_MEDIA_*` and
    `RECEIPT_MEDIA_WORKER_*` have working defaults (see
    `docs/receipt-media-operations.md`). Leave `RECEIPT_MEDIA_METRICS_TOKEN`
    unset unless metrics are scraped; the metrics endpoint answers 404 without
    it.
  - No shipping variables: the backend quotes carriers, so
    `SHIPPING_QUOTES_ENABLED`, `MINIMAL_CATALOG_SHIPPING_ENABLED`,
    `SHIPPING_DEMO_PARCEL_PROFILE_JSON` and `SKYDROPX_*` are not used (delete
    them from Dokploy if present; a leftover value has no effect).

- Preserve `META_APP_SECRET` and `META_VERIFY_TOKEN` unless Meta actually
  changes them; do not rotate them for convenience at cutover.

## 9. Deploy, health, and synthetic smoke journey

1. Set the Dokploy env names in §8 (owner enters values) and restart.
2. Run chatbot migrations against the target database.
3. Deploy the current commit; Joi validates env at boot and fails fast when
   `OPS_CHANNEL_PHONE` is missing (human handoff is always on).
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

**Receipts:** the credential needs `sales:write` (upload) and `sales:read`
(outcome). Outside the 24 h WhatsApp window the outcome message is not sent
(recorded as `OUTSIDE_WINDOW`); alerting and reconciliation drills remain out
of scope for this pilot.

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
names/presence, the posture flags, and `migrations/` filenames: no network,
no `.env`, no Nest boot, and never a value, token, length, or hash.

Report: `coreConfig` (`present|missing`); `posture` (`safe|unsafe|missing`
against exact `META_SANDBOX_RECIPIENT_NORMALIZATION=false`; missing or
non-exact fails closed; there is no shipping or receipt posture: both are
always on); `migrations` (`present_on_disk|missing_on_disk`);
`clientRoutes`/`manualChecks` (always `manual_external`, never flipping `ok`).
`ok` is false only for missing core names, unsafe/missing posture, or a missing
migration file.

Limitations: presence is not validity; a migration file on disk is not an
applied migration; all reachability and data checks (backend, the 18 client routes
including `POST /chatbot-api/shipping/quotes` whose scope is still TBD by the
backend,
cashier user, `ServiceCredential` with twelve scopes including
`payment-details:read` and `sales:read`, active `PaymentDetail`, populated catalog) stay manual.

## 13. Template messages

`WhatsappSenderPort.sendTemplate` sends a pre-approved Meta template (name,
language code such as `es_MX`, and ordered body parameters `{{1}}..{{n}}`).

- Create each template in Meta WhatsApp Manager and wait for Meta to approve
  it **before** any code uses its name; an unapproved or unknown template is
  rejected by Meta (surfaced as `WhatsappSendError`).
- Use templates only **outside** the 24h customer service window (e.g. a late
  delivery-zone decision). Inside the window the bot keeps replying with
  free-form text via `sendText`.
- Body parameters must be non-empty and trimmed, at most 1024 characters,
  without newlines or tabs and with no more than 4 consecutive spaces; the
  adapter rejects violations before calling Meta.
- Template names must match the approved name exactly (lowercase `a-z`,
  `0-9`, `_`, at most 512 characters).
