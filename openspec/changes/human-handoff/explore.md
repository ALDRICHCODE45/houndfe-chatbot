# Exploration: human-handoff

Build the human-handoff foundation: an internal **async request/response channel** between the bot and a human agent, plus the conversation state and correlation needed for R6 (shipping-quote approval gate), R7 (out-of-stock restock query), R14 (expiration dates), and the pending `needs_human_review` promo case. Future shipping slice depends on this.

> Note: exploration-only. Engram memory server is DOWN this session; persistence is to this openspec file only.

---

## 1. Current state machine

There is **no explicit step/phase state machine** today. `ConversationState` is a keyed bag, and the agent loop is driven entirely by the transcript + the 15-step prompt.

- **Domain shape** (`src/conversation/domain/conversation-store.ts`):
  ```ts
  ConversationState { senderId: string; lastMessageAt: string /* ISO */; data: ConversationStateData }
  ConversationStateData { messages?: AgentMessage[]; placedSaleId?: string; [k: string]: unknown }
  AgentMessage = { role: 'user'|'assistant', content } | { role: 'tool', toolCallId, content: unknown }
  ```
- **Data bag contents in use**: `data.messages` (transcript), `data.cart` (`CartState`, owned by sale-flow), `data.placedSaleId` (just-confirmed sale). There is **no** `phase`, `status`, or `awaitingHuman` field.
- **Agent loop** (`src/llm-agent/application/agent-runner.service.ts` `handle()`): `store.get(senderId)` → idle-check (`LLM_IDLE_TIMEOUT_MS`, default 3h) → truncate history in memory (`LLM_HISTORY_TURNS`) → `llm.run({ senderId, text, history, systemPrompt, tools })` → cost-guard → UPSERT user+assistant turns + `lastMessageAt=now`. The model decides the next action by tool-calling against `SALE_FLOW_INSTRUCTIONS` (15 steps in `src/sale-flow/domain/sale-flow-instructions.ts`); the runner itself never branches on a phase.
- **Where "waiting for human" fits**: a new typed field on `ConversationStateData` (e.g. `pendingHumanRequest: { requestId, ref, createdAt } | null`), checked in `AgentRunner.handle()` **before** running the LLM. While set, inbound customer messages are either (a) held/nudged or (b) short-circuited to a "still waiting" reply instead of a fresh LLM turn. Crucially, this field must **survive** the idle-timeout reset (today idle-expiry wipes history; it must NOT wipe the pending marker).
- **How the agent handles unresolvable cases today**: purely by prompt. (a) no tool → literal refusal `esa función aún no está disponible`; (b) `noActivePaymentDetail` → literal `en un momento un agente te comparte los datos de pago`; (c) `saleNotCancellable` → "deriva a un agente humano"; (d) `evaluateCart.promotionEvaluationStatus === 'needs_human_review'` → "deriva a revisión humana". These are **LLM-phrased words with no backing mechanism** — no durable request, no human notification, no reply correlation, no state change.

## 2. WhatsApp outbound capabilities

- **Sender port** (`src/whatsapp/domain/whatsapp-sender.port.ts` + `infrastructure/meta-whatsapp.sender.ts`): text-only `sendText({ to, text })` → `POST /{phoneNumberId}/messages` with `recipient_type: 'individual'` hardcoded and `type: 'text'`. Non-text throws `UnsupportedOutboundError`.
- **Arbitrary recipient**: yes — `to` is any string; `normalizeSandboxRecipient()` strips the Mexican trunk `1` for the test number only. **Groups are NOT supported** as-is: sending to a group id requires `recipient_type: 'group'` (a code change), and the current sender would fail.
- **Media API**: not implemented (text only). Media items are out of scope for this slice (🟡 media item already noted in backend responses).
- **24h / service-conversation constraints**: the spec hard-forbids proactive sends (`whatsapp-webhook` + `whatsapp-sender`); all outbound today flows only inside the inbound-driven dispatcher path. A digest to a human agent is a **business-initiated** message to the agent's number, so it is only free inside a service conversation (agent messaged the bot within 24h) or requires an approved template. Test-number dev mode additionally caps to 5 verified recipients + a temporary 24h token.
- **Human reply path already exists**: webhook → `WebhookDispatcherService.dispatch()` → `normalizeInboundMessages` (text only) → echo filter (`RECENT_OUTBOUND`, exact wamid match, in-memory) → dedup (`WEBHOOK_DEDUP`, messageId, Postgres) → `AgentRunner`. **Limitation**: normalization captures `senderId = message.from ?? contacts[0].wa_id` and text body only — it does **not** capture the receiving business number (`value.metadata.phone_number_id` / `display_phone_number`), so routing by "which number received it" is not possible without a DTO/normalizer extension.

## 3. Correlation options

How a human reply maps back to the pending customer conversation:

1. **Reference token embedded in the digest (RECOMMENDED)** — bot sends `HF-<requestId>` in the digest; the human replies including that ref; the bot parses it and resolves the matching request. Works with existing text-only parsing; no DTO changes. Downside: human must type/quote the ref (copy-paste mitigates).
2. **thread_id in state** — the pending request already stores `customerSenderId`; correlation is `agentSenderId + ref` → request. This is complementary to (1), not an alternative: the request row links agent↔customer.
3. **Inbound routing by internal channel number** — dedicate a number/group; any inbound to that number is an agent reply, correlated by "latest pending request for that agent". Requires capturing `metadata.phone_number_id` in the webhook DTO/normalizer + a dedicated number. More robust UX (no ref typing) but more infra and ambiguous with multiple concurrent pending requests.

- **Existing parsing**: `message.from` (who), `message.text.body` (what), `message.id` (wamid for dedup/echo). No metadata recipient capture, no group detection.

## 4. Persistence

- **What the durable store supports today**: `conversation_state` (`sender_id` PK, `last_message_at timestamptz`, `data jsonb`) — point lookups/UPSERT only, **no** secondary index and **no** query-inside-JSONB. Plus `processed_webhook_messages` (webhook dedup). Raw `pg` + `node-pg-migrate` (see `migrations/1700…`, `migrations/1800…`).
- **New persistence needed**: a `human_handoff_requests` table (separate from the jsonb bag, because we must look up by `ref`/status — the jsonb bag cannot be indexed cheaply). Sketch:
  ```sql
  CREATE TABLE human_handoff_requests (
    id            text        PRIMARY KEY,   -- short ref "HF-xxxx" + internal id
    customer_id   text        NOT NULL,      -- customer senderId (wa_id)
    agent_id      text,                      -- agent senderId once they reply
    kind          text        NOT NULL,      -- out_of_stock | needs_human_review | expiration_date | generic
    digest        jsonb       NOT NULL,      -- renderable payload (products, cart, context)
    status        text        NOT NULL DEFAULT 'pending',  -- pending | resolved | expired | cancelled
    resolution    jsonb,                     -- human-supplied resolution payload
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz,
    expires_at    timestamptz
  );
  -- index: (status, created_at) for listing; PK lookup by id/ref
  ```
  A `HumanHandoffStore` port + `PostgresHumanHandoffStore` mirrors the existing `ConversationStore`/`WebhookDedupStore` pattern (port in `domain/`, adapter in `infrastructure/`, one `node-pg-migrate` migration).

## 5. Integration points (escalation triggers)

Exact files where escalation hooks in:

| Trigger | Where | Today's behavior |
|---|---|---|
| `needs_human_review` (promo) | `src/sale-flow/application/tools/evaluate-cart.tool.ts` returns `evaluation` verbatim; only the **prompt** step 11 tells the model to "deriva a revisión humana" | no mechanism |
| Out-of-stock (R7) | `src/sale-flow/application/tools/check-stock.tool.ts` returns `{ ok:true, ...stock }` with `stock.status`; model decides | no mechanism |
| Expiration dates (R14) | no tool covers it; falls to refusal phrase in `SALE_FLOW_INSTRUCTIONS` | refusal, no escalation |
| Shipping approval (R6) | **not present** — belongs to future shipping slice (Skydropx/Enviós Perros) | n/a |

Concrete wiring to touch:
- `src/sale-flow/application/tool-deps.ts` — add a `HumanHandoffService` (or store) to `ToolDeps`.
- `src/sale-flow/infrastructure/real-tool-registry.ts` — register a new `requestHumanAssistance` tool (12th tool) + pass deps.
- `src/sale-flow/application/tools/*` — `check-stock.tool.ts` (or a wrapper) detects `out_of_stock`; `evaluate-cart.tool.ts` detects `needs_human_review`.
- `src/sale-flow/domain/sale-flow-instructions.ts` — new steps: when to call `requestHumanAssistance`, and the awaiting-human posture ("avísale al cliente que un agente revisará y regresará").
- `src/llm-agent/application/agent-runner.service.ts` — short-circuit inbound while `pendingHumanRequest` is set (skip LLM / issue a hold reply).
- `src/whatsapp/application/webhook-dispatcher.service.ts` — route agent-side replies (by ref or by ops-channel recipient) to the handoff resolver **before** `AgentRunner`, so the human's reply is not fed to the customer's LLM turn.
- `src/whatsapp/presentation/dto/webhook-event.dto.ts` + `normalizeInboundMessages` — only if option 3 (channel-number routing) is chosen; capture `metadata.phone_number_id`.
- NEW `src/human-handoff/` feature module: `domain/` (port, types), `application/` (service: create request, send digest, resolve on reply), `infrastructure/` (Postgres store + Meta digest sender via existing `WHATSAPP_SENDER`).

## 6. Internal channel decision

| Option | Verdict |
|---|---|
| (a) **Dedicated ops number/recipient** — bot messages a configured human phone (`OPS_CHANNEL_PHONE`) | **RECOMMENDED** |
| (b) Shared WhatsApp group | Defer |
| (c) Dashboard/HTTP (new backend/admin infra) | Out of scope (requires backend + auth changes) |

**Recommendation: (a) a dedicated ops recipient (config `OPS_CHANNEL_PHONE`, reusing the existing text sender).**

- **Why (a)**: single unambiguous inbound "who" (agent = senderId); reuses the text-only sender unchanged; no group semantics; no new backend/dashboard infra. Correlation via a `HF-<id>` ref in the digest body (option 1/2 above). In dev/test mode, add the agent's phone to the test number's 5-recipient allowlist (remember the trunk-`1` normalization caveat); in production a real number lifts that cap.
- **Why not (b)**: group sends need `recipient_type: 'group'` (sender change) + member-identity parsing (which member sent it), and group replies mix customer/agent traffic in one thread — higher parsing risk for v1.
- **Why not (c)**: the owner mandate is "the bot must *message* a human"; a dashboard needs new backend endpoints, auth, and a UI — heavy, and the backend team is a separate repo. Revisit only if WhatsApp-window limits make push delivery unreliable.
- **Meta constraint to flag**: a digest to the agent is business-initiated → free only inside a 24h service conversation (agent messaged the bot within 24h), otherwise it needs an approved template. Pragmatic v1: agent "opens" the channel by sending the bot an "ops on" message at shift start (keeps a service window), or accept template cost. **Owner decision.**

## 7. Open questions / risks

1. **Meta 24h window & free service conversations** — proactive digests outside a 24h service window fail or need a template. Decide: "agent opens the channel" vs. approved template vs. defer. Test number: 5 verified recipients + 24h token (dev-only).
2. **Human reply parsing** — ref-token format (`HF-xxxx`), case/whitespace tolerance, and what happens when the human replies without a ref (fallback: newest pending request? ask for ref?).
3. **Timeout / nudge behavior** — how long does the bot wait before nudging the customer or expiring the request? There is **no scheduler/cron today** (spec forbids proactive sends). Options: nudge only on the next customer inbound (no infra), or add a scheduler (new infra — deferred). **Owner decision.**
4. **Idle-timeout vs. awaiting-human** — `LLM_IDLE_TIMEOUT_MS` (3h) wipes history; the pending marker must be exempted from that reset or the human's later resolution loses transcript context.
5. **LLM cost** — escalation must be a deterministic tool/state path, not extra LLM turns; avoid the model re-summarizing digests.
6. **Echo/dedupe interplay** — agent replies arrive via the same webhook; correlation must run before the generic `AgentRunner`, and the agent's own sends must not loop (echo filter already covers wamid).
7. **Group support** — deferred, but if the owner insists on a shared group, `recipient_type: 'group'` + member parsing becomes scope.
8. **What depends on owner** — ops-channel phone/group choice, Meta template approval (if push needed), timeout/nudge policy, and (for R6 later) Skydropx/Enviós Perros + CDMX free-zone list.

## 8. Recommended proposal scope (first slice)

**Include (foundation + cheap, high-value triggers):**
- New `human-handoff` module: `HumanHandoffStore` (Postgres) + `HumanHandoffService` (create request → send `HF-<id>` digest to `OPS_CHANNEL_PHONE` → resolve on reply) + `human_handoff_requests` migration.
- `ConversationStateData.pendingHumanRequest` + `AgentRunner` short-circuit while awaiting.
- `requestHumanAssistance` tool + registry registration + `SALE_FLOW_INSTRUCTIONS` new steps.
- Wire **R7 (out-of-stock)** and **`needs_human_review` (promo)** — both already surface in tool results/prompt today.
- **R14 (expiration dates)** as a prompt-only escalation (no tool → `requestHumanAssistance` instead of refusal).
- Dispatcher routing of agent replies by ref before the LLM turn.

**Defer:**
- **R6 (shipping-quote approval gate)** — hard dependency on the future shipping slice (Skydropx/Enviós Perros quotes, $120 credit rule, Amazon check). This slice only delivers the *channel*; R6 wires digest content into it later.
- Media/attachment digests (image receipt forwarding), group channel, scheduler-based nudges/expiry, dashboard/HTTP channel.

---

## Key Learnings

1. The chatbot has no explicit phase/state machine; conversation state is a keyed JSONB bag whose `data` holds only messages, cart, and placedSaleId.
2. All existing "human handoff" behavior is LLM-phrased prompt text with no durable request, notification, or reply-correlation mechanism.
3. The WhatsApp sender is text-only with `recipient_type: 'individual'` hardcoded, so group sends would require a code change.
4. Inbound webhook normalization captures only the sender and text body, not the receiving business number, so channel-number routing needs a DTO extension.
5. The durable store supports only sender-id point lookups with no secondary index, so pending human requests need a separate indexed table rather than a JSONB query.
