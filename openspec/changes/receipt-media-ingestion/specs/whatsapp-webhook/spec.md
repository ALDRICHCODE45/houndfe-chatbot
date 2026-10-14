# Delta for WhatsApp Webhook

## MODIFIED Requirements

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
The system MUST NOT send any message outside the inbound-driven path (no proactive sends), keeping all outbound traffic inside the WhatsApp 24h free service window. Before an early webhook HTTP 200, the system MUST atomically commit the admitted receipt reservation and durable ingestion-work causality, including immutable inbound message and receipt identifiers. If that admission transaction rolls back, the system MUST return failure and no worker execution or outbox notification MAY result. After worker processing determines that a customer notification is required (for example, a `STORED` → `AWAITING_AMOUNT` or `STORED` → `AWAITING_CONFIRMATION` transition), the receipt state transition and the exact deterministic outbox notification intent MUST commit atomically before any send attempt. A crash before that commit MUST send nothing; a crash after that commit MUST leave the intent restart-drainable at least once. The outbox worker MUST send only the deterministic receipt-workflow message recorded by the committed receipt state transition; it MUST NOT create new conversational intent, invoke the generic LLM, or send unrelated or proactive messages. Pending receipt notifications MAY be drained after restart because they remain causally inbound-driven. Delivery MUST be at least once, with deterministic duplicate-safe message content and state handling; the system MUST NOT claim exactly-once WhatsApp delivery.

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

#### Scenario: Admitted receipt may send its deterministic prompt after HTTP 200

- GIVEN a signed inbound receipt event whose admitted reservation and durable ingestion-work causality contain immutable inbound message and receipt identifiers
- WHEN that admission commits and the webhook returns early HTTP 200, then the worker validates and stores the media and determines that a customer notification is required
- THEN the receipt state transition (for example, `STORED` → `AWAITING_AMOUNT` or `STORED` → `AWAITING_CONFIRMATION`) and the exact deterministic notification outbox intent MUST commit atomically before any send attempt
- AND the recoverable worker MAY later send only that recorded deterministic receipt-workflow message
- AND the worker MUST NOT invoke the generic LLM or send any unrelated or proactive message.

#### Scenario: Restart drains a pending inbound receipt notification

- GIVEN an admitted receipt event with a committed pending receipt outbox intent
- AND the process restarts before the notification is delivered
- WHEN the worker recovers and drains pending intents
- THEN it MUST send only the recorded deterministic receipt-workflow message
- AND duplicate delivery handling MUST preserve deterministic content and state without claiming exactly-once WhatsApp delivery.

#### Scenario: Failed admission atomically produces no background send

- GIVEN an inbound receipt whose admitted reservation and durable ingestion-work causality cannot commit atomically
- WHEN the admission transaction rolls back before the webhook acknowledgement
- THEN the webhook MUST return failure rather than early HTTP 200
- AND no worker execution or outbox notification MUST result from the failed admission
- AND GIVEN a separately admitted receipt whose worker-determined notification state transition and exact outbox intent cannot commit atomically
- WHEN that second transaction rolls back or crashes before commit
- THEN no notification send attempt MUST occur until a later atomic state-transition-and-intent commit succeeds.

#### Scenario: Unsolicited background sends remain forbidden

- GIVEN no durably admitted inbound receipt event causally authorizes a notification
- WHEN a scheduler, idle process, restart recovery, or worker attempts to produce an outbound message
- THEN the system MUST NOT send it via WhatsApp
- AND the worker MUST NOT manufacture a conversational intent or send a proactive, marketing, scheduled, or otherwise non-inbound-caused message.

## ADDED Requirements

### Requirement: Media DTO normalization is explicit

The inbound DTO and normalized envelope MUST represent provider media id, declared MIME type, and optional caption for supported images, while PDF and other unsupported documents remain outside the supported receipt-media union.

#### Scenario: MIME and caption survive normalization

- GIVEN a signed image with provider media id, `image/png`, and a caption
- WHEN normalization runs
- THEN those values MUST be present and no temporary URL or bearer token MUST be present.

#### Scenario: PDF is excluded

- GIVEN a signed `application/pdf` document
- WHEN normalization runs
- THEN it MUST not produce a supported receipt-media event and MUST produce a deterministic customer outcome.

#### Scenario: Dispatcher order is documented and asserted

- GIVEN a unit test that records collaborator invocation order
- WHEN a normal inbound is processed
- THEN the order MUST be echo filter, webhook dedup, conditional ops routing, conditional pending-marker short-circuit, idle check, agent runner, and sendText.

#### Scenario: Non-receipt image outside receipt context receives deterministic guidance

- GIVEN a customer sends a supported image when no active receipt context exists
- WHEN webhook routing classifies the image
- THEN the customer MUST receive deterministic Spanish receipt-only guidance semantically stating `solo puedo recibir comprobantes de pago`
- AND the system MUST NOT silently drop the image or attempt product-photo recognition.
