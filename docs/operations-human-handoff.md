# Human-Handoff Channel — Operations Runbook

> Spec: `openspec/changes/human-handoff/specs/human-handoff/spec.md`.
> Design: `openspec/changes/human-handoff/design.md` §Risk R-1 / §Dependencies.

The human-handoff channel is the asynchronous request/response bridge between
the chatbot (requesting) and a human agent (resolving). This runbook covers
the operator-side knobs the agent team needs at shift start, during normal
operation, and during a behaviour rollback.

## TL;DR

Human handoff is **always on**; there is no kill-switch env var.

| Knob      | Env var             | Default  | Purpose                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ops phone | `OPS_CHANNEL_PHONE` | required | Exact digit-only Meta senderId (`wa_id`) of the human agent who receives digests and replies to them, 10-15 digits. A leading `+`, whitespace, or separator is rejected at boot. Comparison is exact by default; the Mexican trunk-1 rewrite runs **only** when `META_SANDBOX_RECIPIENT_NORMALIZATION=true` (Meta test number), never in production. |

## 1. Shift-start "ops on" pattern

The Meta 24-hour service window covers any inbound from the customer — once
the customer messaged first, the bot can send free-form messages for the
next 24h. We don't have that window for the **outbound** direction because
the bot needs to push messages to the ops phone when a customer escalates.
If the customer's last inbound is older than 24h, the bot cannot deliver a
digest without an approved template.

To keep the channel alive for ops replies throughout the day, the operator
sends a short "ops on" message to the ops thread **at the start of every
shift**:

- The message is a normal free-form text from your phone to the ops
  WhatsApp number (or simply opening the conversation counts — Meta still
  re-opens the window for the person you message).
- It opens the 24h service window from the customer side toward the ops
  phone for the entire shift.

If the operator skips ops-on, the bot falls back to an approved template
(spends a template-credit per escalation) and surfaces a `Meta 131030`
warning log line. Templates cost real money; ops-on is the free path.

### Recommended ops-on message

```
🟢 Ops turno abierto — escribe las respuestas de HF-xxxx aquí
```

(Optional — operators can also just open the chat without sending anything;
the 24h window opens from the user-initiated direction regardless. Sending
the marker explicitly is helpful for traceability in the human chat.)

## 2. Provisioning the `OPS_CHANNEL_PHONE`

The phone number that the bot will send digests TO must be configured before
boot. Validate the format end-to-end:

1. **Production (default):** copy and store the **exact digit-only `wa_id`**
   Meta reports for the human agent, e.g. `5219999888777`; never the E.164
   form with a `+`. With `META_SANDBOX_RECIPIENT_NORMALIZATION` unset
   (default `false`) the value is retained verbatim and the sender/ops
   comparison is an exact string match against the digit-only inbound
   `wa_id`. Joi fails the boot on a `+`/separator/whitespace form or outside
   10-15 digits — a `+` would never match, silently losing ops replies.
2. **Meta test number only:** while building against the Meta test number,
   you may explicitly set `META_SANDBOX_RECIPIENT_NORMALIZATION=true`. Only
   then does the runtime rewrite `521` + 10-digit recipients (e.g.
   `5219999888777`) to `52` + 10 digits and apply the same conversion on
   both sides of the sender/ops comparison. This compatibility mode is
   opt-in and must return to `false` at real-number cutover.

### Env checklist

- [ ] `OPS_CHANNEL_PHONE` set in the deployment env (or `.env`).
- [ ] The associated phone is registered as a Meta WhatsApp sender (so the
      bot is allowed to send it outbound messages).
- [ ] After every change, restart the bot. Joi validation at boot fails
      fast when `OPS_CHANNEL_PHONE` is missing/empty/non-string, or when it is not the exact digit-only
      `wa_id` (leading `+`, whitespace, separators, or outside 10-15 digits).

### Test-number allowlist + 24h token cap

When registering Meta test numbers, follow the standard five-recipient limit
per Meta's onboarding docs. The 24h token cap is enforced by Meta; the bot
does not implement its own cap. If you see `Meta 131030` in the logs, the
24h window is closed — the customer's last inbound is older than 24h and you
have no approved template loaded. Solution: open the chat from the customer
phone ("ops on" pattern) before expecting digests to deliver.

## 3. Behaviour rollback

There is no env kill-switch: human handoff is always on. If the channel
misbehaves, roll back the code (section 4).

## 4. Code rollback

If the entire slice needs to be reverted:

1. Revert the three merge commits (`feat(human-handoff): foundation ...`,
   `feat(whatsapp): ops reply routing ...`,
   `feat(sale-flow): human-handoff triggers ...`).
2. Run `pnpm migrate:down` against the database — drops
   `human_handoff_requests` + its `(status, created_at)` index.
3. The `pendingHumanRequest` key on existing `conversation_state.data` rows
   becomes a no-op (the type allows free-form keys and no reader cares once
   the slice is gone). The field can be left in place; the next data-bearing
   UPSERT will overwrite the entire `data` blob and the lingering key will
   vanish naturally. A cleanup script is unnecessary.

## 5. Open follow-ups (non-blocking)

- **No shipping approval kind.** Per-quote human approval was removed: the
  backend signs each shipping quote (`quoteId` with expiry), so there is no
  `shipping_approval` request, digest or `APPROVE_SHIPPING`/`REJECT_SHIPPING`
  ops command. See [minimal shipping](minimal-shipping.md).
- **Scheduler-based nudge / expiry.** The current design waits indefinitely
  for the agent reply (no scheduler, no expiry). If operationally noisy,
  add a follow-up slice for an optional `expiresAt` column + a cron nudger.
- **Group-channel support.** The current classifier uses
  `isOpsSender(senderId)` against `OPS_CHANNEL_PHONE`. Group threads would
  need recipient-type + member-identity parsing.
- **Media forwarding to ops.** The digest is text-only today. If the
  customer's product photo is relevant, attach it to the digest (the
  Graph send API supports it).
- **Approved Meta template.** Optional cost optimisation: a pre-approved
  template lets the bot push digests outside the 24h service window without
  the "ops on" shift-start step. Cost + review cycle to be decided in v2.
