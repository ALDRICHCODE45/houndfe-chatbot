# whatsapp-webhook Spec

## Purpose

Expose the Meta WhatsApp Cloud API webhook endpoint to HoundFe's chatbot. The endpoint
MUST handle the GET verification challenge exchange and accept signed POST event payloads.
Inbound events MUST be authenticated via `X-Hub-Signature-256` HMAC-SHA256 over the raw
request body and rejected (HTTP 401) when the signature is missing or invalid. Valid events
are normalized into a domain envelope that downstream layers can consume. The dispatcher
MUST route ops-side inbounds to `HumanHandoffService.resolveReply(...)` BEFORE invoking
`AgentRunner`, MUST short-circuit customer inbounds whose `data.pendingHumanRequest` is
set with a byte-identical canned literal, and MUST otherwise follow the existing path
(invoke the agent, persist the assistant turn, reply via `WhatsappSenderPort.sendText`).
The DTO surface gains one optional `metadata` sub-object on `WebhookValueDto` and one
optional `receivingPhoneNumberId` field on `InboundMessage`; the existing GET/POST
handlers, echo filter, and Postgres dedup are unchanged.

## Requirements

### Requirement: Verify webhook challenge

The system MUST validate GET webhook verification using the configured verify token and return the Meta challenge only on success.

#### Scenario: Valid verify token

- GIVEN a GET request with `hub.verify_token` matching configuration
- WHEN the webhook verify endpoint is called
- THEN the system returns `hub.challenge` with HTTP 200

#### Scenario: Invalid verify token

- GIVEN a GET request with a missing or different `hub.verify_token`
- WHEN the webhook verify endpoint is called
- THEN the system returns HTTP 403

### Requirement: Accept signed inbound events

The system MUST verify `X-Hub-Signature-256` with HMAC-SHA256 over the raw request body and MUST reject missing or invalid signatures with HTTP 401.
It MUST parse valid inbound message envelopes into a normalized event for downstream dispatch.
For text events, the dispatcher MUST invoke the agent (`agent.run({ senderId, text })`) and persist the resulting assistant turn before replying; the assistant reply MUST be sent back via `WhatsappSenderPort.sendText`.

For ops-side inbounds (where `message.from` matches the configured
`OPS_CHANNEL_PHONE` after `normalizeSandboxRecipient`), the dispatcher MUST route the
inbound to `HumanHandoffService.resolveReply({ text, from })` BEFORE invoking the
agent, and the agent MUST NOT be invoked for that inbound. The agent's reply (a fresh
LLM turn) is never produced for ops-side inbounds.

For customer-side inbounds whose `ConversationState.data.pendingHumanRequest` is set,
the dispatcher MUST short-circuit to the canned reply path (no LLM turn, no
`costGuard.record`, no transcript append — see the `llm-agent` delta).

For customer-side inbounds whose `pendingHumanRequest` is null, the dispatcher MUST
follow the existing path: invoke the agent and persist the resulting assistant turn
before replying.

(Previously: every inbound reached `AgentRunner`; no `pendingHumanRequest` marker
existed; no ops-side discrimination existed.)

#### Scenario: Invalid signature is rejected

- GIVEN a POST webhook payload without `X-Hub-Signature-256` or with a bad MAC
- WHEN the event is received
- THEN the system returns HTTP 401

#### Scenario: Signed inbound text reaches agent dispatch

- GIVEN a simulated signed inbound text webhook and a mocked `LlmAgentPort`
- WHEN the POST event is processed
- THEN the normalized message envelope includes sender id and text body
- AND the dispatcher invokes `agent.run({ senderId, text })`
- AND the assistant turn is persisted to `ConversationStore`
- AND the assistant reply is sent via `WhatsappSenderPort.sendText`.

#### Scenario: Ops-side inbound routes to resolveReply before the runner

- GIVEN a signed inbound with `from = <OPS_CHANNEL_PHONE>` (after normalization)
- AND a stubbed `HumanHandoffService.resolveReply`
- WHEN the dispatcher processes the inbound
- THEN `HumanHandoffService.resolveReply({ text, from })` MUST be called BEFORE
  `AgentRunner.handle(...)`
- AND `AgentRunner.handle(...)` MUST NOT be called for this inbound.

#### Scenario: Customer inbound with pendingHumanRequest gets the canned reply

- GIVEN a customer sender S whose `data.pendingHumanRequest` is set
- AND a signed inbound from S
- WHEN the dispatcher processes the inbound
- THEN `HumanHandoffService.resolveReply(...)` MUST NOT be called
- AND `AgentRunner.handle(...)` MUST NOT be called (short-circuit; no LLM turn)
- AND the canned literal reply
  `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos` MUST be
  sent via `WhatsappSenderPort.sendText` to S
- AND no `ConversationStore.update(...)` MUST be issued for this inbound.

#### Scenario: Customer inbound with no pendingHumanRequest follows the normal path

- GIVEN a customer sender S whose `data.pendingHumanRequest` is null
- AND a signed inbound from S
- WHEN the dispatcher processes the inbound
- THEN `HumanHandoffService.resolveReply(...)` MUST NOT be called (customer, not ops)
- AND `AgentRunner.handle(...)` MUST be called as today
- AND the assistant reply MUST be sent via `WhatsappSenderPort.sendText` to S
- AND the assistant turn MUST be persisted to `ConversationStore`.

### Requirement: Dispatcher invokes the agent and persists the assistant turn

For each normalized inbound text message, the dispatcher MUST call the agent and on success MUST append both the user message and the assistant reply to the per-sender `ConversationState.data.messages`.
The assistant reply MUST be sent back via `WhatsappSenderPort.sendText`.
The system MUST NOT send any message outside the inbound-driven path (no proactive sends), keeping all outbound traffic inside the WhatsApp 24h free service window.

The order of operations inside `WebhookDispatcherService.dispatch(...)` MUST be:

1. Signature verification (HMAC-SHA256).
2. `normalizeInboundMessages` — capture `from`, `text.body`, and `metadata.phone_number_id`
   (and `metadata.display_phone_number`) into the normalized envelope.
3. `RECENT_OUTBOUND` echo filter (exact wamid match against recent outbound wamids).
4. `WEBHOOK_DEDUP` Postgres dedup (by wamid).
5. **NEW — ops pre-routing hook**: when `isOpsSender(message.from)` is `true`, call
   `HumanHandoffService.resolveReply({ text: message.text.body, from: message.from })`
   and short-circuit the dispatcher (skip steps 6–9). When the result is
   `{ kind: 'no_pending', reply: <ASK_FOR_REF> }`, send `ASK_FOR_REF` back to `from`
   via `WhatsappSenderPort.sendText` and stop. When the result is
   `{ kind: 'resolved', customerId, syntheticUserText, ... }`, dispatch a synthetic
   turn to the customer by calling `agentRunner.handle({ senderId: customerId,
   text: syntheticUserText })` and sending the assistant reply to `customerId`. The
   `pendingHumanRequest` marker for the customer is already cleared (the handoff
   service cleared it during `resolveReply`), so the synthetic turn follows the
   normal LLM path (no short-circuit).
6. **NEW — pending-marker short-circuit**: when
   `readPendingHumanRequest(state(message.from))` is non-null AND the inbound is
   customer-side, send the canned literal
   `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos` to
   `message.from` and stop (no LLM turn, no transcript write).
7. Idle check (existing `LLM_IDLE_TIMEOUT_MS`).
8. `AgentRunner.handle(...)` (existing; fresh-state spread write preserved per the
   `llm-agent` delta).
9. `WhatsappSenderPort.sendText({ to: customerId, text: reply })` (existing).

(Previously: the order was signature → normalize → echo → dedup → idle → runner →
sendText; no ops hook and no pending-marker short-circuit.)

#### Scenario: Assistant turn is persisted after a successful run

- GIVEN a mocked `LlmAgentPort.run` resolving with `{ reply: "Hola", messages: [...] }`
- WHEN the dispatcher processes an inbound text
- THEN `ConversationStore.update` is called with the user + assistant messages appended
- AND the assistant reply is sent via `WhatsappSenderPort.sendText` to the sender.

#### Scenario: No proactive sends occur

- GIVEN a normal boot with no inbound traffic
- WHEN the dispatcher is idle
- THEN `WhatsappSenderPort.sendText` is never invoked
- AND no cron, scheduler, or background task produces outbound messages.

#### Scenario: Dispatcher order is documented and asserted

- GIVEN a unit test that records every collaborator invocation in dispatch order
- WHEN the dispatcher processes an inbound
- THEN the recorded order MUST be
  `[echoFilter, webhookDedup, isOpsSender?, resolveReply?, pendingMarkerShortCircuit?,
    idleCheck, agentRunnerHandle, sendText]`
  (steps marked `?` are conditional and appear only when their condition holds).

### Requirement: WebhookValueDto.metadata captures the receiving business number

`WebhookValueDto` MUST gain the optional field `metadata?: WebhookMetadataDto` (alongside
the existing `messages` and `contacts` fields). `WebhookMetadataDto` MUST be a new DTO
with the optional fields `display_phone_number?: string` and `phone_number_id?: string`,
matching the Meta Cloud API webhook payload shape documented at
https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks (the `metadata` object
is present on every `value` envelope when the bot is registered with Meta).

The DTO MUST NOT require `metadata` (it MAY be absent in older webhook versions or in
edge cases). When absent, the dispatcher's pre-routing hook falls back to senderId-only
classification (see below).

#### Scenario: DTO parses a payload that carries metadata

- GIVEN a webhook payload with
  `entry[0].changes[0].value.metadata = { display_phone_number: "5219999888777",
    phone_number_id: "1234567890" }`
- WHEN the DTO is validated
- THEN `value.metadata` MUST equal
  `{ display_phone_number: "5219999888777", phone_number_id: "1234567890" }`.

#### Scenario: DTO parses a payload without metadata

- GIVEN a webhook payload whose `value` has no `metadata` key
- WHEN the DTO is validated
- THEN `value.metadata` MUST equal `undefined` (no validation error).

### Requirement: InboundMessage.receivingPhoneNumberId carries the receiving business number

`InboundMessage` MUST gain the optional field `receivingPhoneNumberId?: string`. The
inline `normalizeInboundMessages` function in `WebhookDispatcherService` MUST set this
field from `value.metadata.phone_number_id` when present (string copy), and MUST leave
it `undefined` when `value.metadata` is absent. The field is observable + loggable; the
dispatcher MUST NOT use it as the ops-side discriminator (per ADR-22, both customer and
ops inbounds arrive at the same bot number, so the field is identical in both cases).

#### Scenario: normalized message carries the receiving number when present

- GIVEN a webhook payload with
  `value.metadata.phone_number_id = "1234567890"`
- WHEN `normalizeInboundMessages` runs
- THEN every produced `InboundMessage` MUST have
  `receivingPhoneNumberId = "1234567890"`.

#### Scenario: normalized message leaves the receiving number absent when metadata is absent

- GIVEN a webhook payload with no `value.metadata`
- WHEN `normalizeInboundMessages` runs
- THEN every produced `InboundMessage` MUST have `receivingPhoneNumberId` equal to
  `undefined`.

#### Scenario: receiving number is logged but not used as the discriminator

- GIVEN a unit test that spies on the ops pre-routing hook
- WHEN the dispatcher processes a customer inbound AND an ops inbound (both arrive at
  the same bot number)
- THEN `isOpsSender(from)` MUST return `false` for the customer and `true` for ops
- AND `receivingPhoneNumberId` MUST be identical for both inbounds
- AND the dispatcher MUST route only the ops inbound through
  `HumanHandoffService.resolveReply(...)`.

### Requirement: Ops pre-routing hook classifies and dispatches ops inbounds

The dispatcher MUST invoke `HumanHandoffService.isOpsSender(message.from)` on every
normalized inbound. When `isOpsSender(from)` is `true`, the dispatcher MUST call
`HumanHandoffService.resolveReply({ text: message.text.body, from })` and short-circuit
the dispatcher path (skip `AgentRunner.handle`, skip the pending-marker short-circuit,
skip the echo-filter / dedup / idle re-check — those already ran above). The ops
pre-routing hook MUST run AFTER the echo filter and Postgres dedup (so ops re-deliveries
are deduplicated like any other inbound) and BEFORE `AgentRunner.handle(...)`.

The hook MUST handle three `resolveReply` outcomes:

1. `{ kind: 'resolved', customerId, syntheticUserText, ... }` — dispatch the synthetic
   turn through `agentRunner.handle({ senderId: customerId, text: syntheticUserText })`
   (the marker is already cleared, so this is a normal LLM turn) and send the assistant
   reply to `customerId` via `WhatsappSenderPort.sendText`.
2. `{ kind: 'no_pending', reply: <ASK_FOR_REF> }` — send the `ASK_FOR_REF` reply to
   `from` (the agent) via `WhatsappSenderPort.sendText`. No LLM turn, no customer
   dispatch.
3. (defensive — never produced by `resolveReply` today) — emit an error log and stop.

#### Scenario: resolved outcome produces a synthetic customer turn

- GIVEN a customer S whose pending request just got resolved by the agent's reply
- AND `resolveReply` returns
  `{ kind: 'resolved', customerId: 'S', ref: 'HF-...', resolution, syntheticUserText }`
- WHEN the dispatcher processes the ops inbound
- THEN `agentRunner.handle({ senderId: 'S', text: <syntheticUserText> })` MUST be
  called once
- AND the assistant reply MUST be sent to `S` via `WhatsappSenderPort.sendText`.

#### Scenario: no_pending outcome asks the agent for the ref

- GIVEN no pending request for the agent
- AND `resolveReply` returns `{ kind: 'no_pending', reply: <ASK_FOR_REF> }`
- WHEN the dispatcher processes the ops inbound
- THEN `agentRunner.handle(...)` MUST NOT be called
- AND `WhatsappSenderPort.sendText({ to: <agent>, text: <ASK_FOR_REF> })` MUST be
  called once.

#### Scenario: ops inbound skips the pending-marker short-circuit

- GIVEN a customer S with `pendingHumanRequest` set AND an ops inbound
- WHEN the dispatcher processes the ops inbound
- THEN `isOpsSender(<ops senderId>)` MUST be `true` (ops wins; the pending-marker
  check is for customer-side inbounds only).

#### Scenario: ops inbound is deduplicated like any other inbound

- GIVEN two webhook deliveries for the same ops `wamid`
- WHEN the dispatcher processes each
- THEN the FIRST delivery MUST reach `resolveReply`
- AND the SECOND delivery MUST be filtered by `WEBHOOK_DEDUP` (no `resolveReply` call
  for the dup).

### Requirement: pendingHumanRequest short-circuit sends a canned literal reply

When the inbound is customer-side AND `readPendingHumanRequest(state(message.from))` is
non-null, the dispatcher MUST send the literal canned reply
`seguimos esperando respuesta del agente, te avisamos en cuanto tengamos`
byte-identical to `message.from` via `WhatsappSenderPort.sendText`, then stop. The
runner MUST NOT be invoked; the transcript MUST NOT be appended; no outbound MUST go
to anyone other than `message.from`.

#### Scenario: customer inbound with pending marker produces the canned reply

- GIVEN a customer S with `pendingHumanRequest` set
- AND an inbound from S with `text = "¿siguen?"`
- WHEN the dispatcher processes the inbound
- THEN `WhatsappSenderPort.sendText({ to: 'S', text: <canned> })` MUST be called once
- AND the canned text MUST equal
  `seguimos esperando respuesta del agente, te avisamos en cuanto tengamos`
  byte-identical (whitespace, accents, final period, no trailing newline).

#### Scenario: short-circuit does not append to the transcript

- GIVEN a customer S with `pendingHumanRequest` set
- WHEN the dispatcher processes an inbound from S
- THEN `ConversationStore.update(...)` MUST NOT be called for this inbound (no user
  turn, no assistant turn, no marker write).

#### Scenario: short-circuit does not reach the ops hook

- GIVEN a customer S with `pendingHumanRequest` set
- AND `S !== OPS_CHANNEL_PHONE` (after normalization)
- WHEN the dispatcher processes an inbound from S
- THEN `isOpsSender(S)` MUST be `false` (the customer's inbound is not classified as
  ops; the marker is the discriminator, not the sender).

### Requirement: Synthetic user turn injection via the runner preserves the resolved-context

When `resolveReply` returns a synthetic user turn and the dispatcher dispatches it
through `AgentRunner.handle(...)`, the runner MUST append the synthetic text as a `user`
turn and MUST persist the resulting assistant reply in the same atomic
`ConversationStore.update(...)` write (per the `llm-agent` delta's fresh-state spread).
The synthetic turn MUST NOT carry the `pendingHumanRequest` marker (the handoff service
cleared it before returning); the dispatcher's synthetic-turn path MUST therefore skip
the pending-marker short-circuit (otherwise the synthetic turn would itself be
suppressed).

#### Scenario: synthetic turn is appended as a user message and the assistant reply follows

- GIVEN a customer S with the marker cleared by `resolveReply`
- WHEN the dispatcher passes the synthetic turn to `AgentRunner.handle({ senderId: 'S',
  text: <syntheticUserText> })`
- THEN the runner MUST persist `data.messages` ending with the synthetic user turn and
  the runner's assistant reply
- AND the dispatcher MUST send the assistant reply to S.

#### Scenario: synthetic turn does not collide with the pending-marker short-circuit

- GIVEN a customer S whose marker is being cleared by the same `resolveReply` call that
  produced the synthetic turn
- WHEN the dispatcher dispatches the synthetic turn
- THEN the dispatcher's pending-marker short-circuit MUST see `null` for S (the
  marker is already cleared) and MUST NOT suppress the synthetic turn.

### Requirement: Echo filter + Postgres dedup apply to ops-side inbounds unchanged

The `RECENT_OUTBOUND` echo filter (exact wamid match against recent outbound wamids) and
the `WEBHOOK_DEDUP` Postgres dedup (by wamid) MUST continue to apply to ops-side
inbounds unchanged. The ops pre-routing hook runs AFTER both, so an ops re-delivery
follows the same dedup path as any customer re-delivery.

#### Scenario: duplicate ops inbound is deduplicated

- GIVEN two webhook deliveries with the same `wamid` for an ops inbound
- WHEN the dispatcher processes each
- THEN the FIRST delivery MUST reach `resolveReply`
- AND the SECOND delivery MUST be filtered by `WEBHOOK_DEDUP` (no `resolveReply` call).

#### Scenario: ops inbound whose wamid is in RECENT_OUTBOUND is filtered

- GIVEN an ops `wamid` that matches a recent outbound wamid in the `RECENT_OUTBOUND`
  echo filter
- WHEN the dispatcher processes the inbound
- THEN the echo filter MUST reject the inbound
- AND `resolveReply` MUST NOT be called.
