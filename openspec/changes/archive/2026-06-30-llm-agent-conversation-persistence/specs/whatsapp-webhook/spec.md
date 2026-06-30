# Delta for whatsapp-webhook

## MODIFIED Requirements

### Requirement: Accept signed inbound events

The system MUST verify `X-Hub-Signature-256` with HMAC-SHA256 over the raw request body and MUST reject missing or invalid signatures with HTTP 401.
It MUST parse valid inbound message envelopes into a normalized event for downstream dispatch.
For text events, the dispatcher MUST invoke the agent (`agent.run({ senderId, text })`) and persist the resulting assistant turn before replying; the assistant reply MUST be sent back via `WhatsappSenderPort.sendText`.
(Previously: the dispatcher replied with `Echo: ${text}` and persisted only the inbound metadata.)

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

## ADDED Requirements

### Requirement: Dispatcher invokes the agent and persists the assistant turn

For each normalized inbound text message, the dispatcher MUST call the agent and on success MUST append both the user message and the assistant reply to the per-sender `ConversationState.data.messages`.
The assistant reply MUST be sent back via `WhatsappSenderPort.sendText`.
The system MUST NOT send any message outside the inbound-driven path (no proactive sends), keeping all outbound traffic inside the WhatsApp 24h free service window.

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
