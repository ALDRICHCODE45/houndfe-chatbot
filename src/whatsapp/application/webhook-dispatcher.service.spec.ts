import {
  AgentRunner,
  type AgentRunnerConfig,
} from '../../llm-agent/application/agent-runner.service';
import { CostGuardService } from '../../llm-agent/application/cost-guard.service';
import {
  type AgentMessage,
  type ConversationState,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  type LlmAgentPort,
  type LlmRunResult,
} from '../../llm-agent/domain/llm-agent.port';
import { type ToolRegistry } from '../../llm-agent/domain/tool-registry.port';
import { SendResult, WhatsappSenderPort } from '../domain/whatsapp-sender.port';
import type { WebhookDedupStore } from '../domain/webhook-dedup.store';
import type { RecentOutboundStore } from '../domain/recent-outbound.store';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import {
  normalizeInboundMessages,
  WebhookDispatcherService,
} from './webhook-dispatcher.service';
import type { InboundMessage } from '../domain/inbound-message';
import {
  ASK_FOR_REF,
  PENDING_HUMAN_REQUEST_REPLY,
  type HumanHandoffService,
} from '../../human-handoff/application/human-handoff.service';

/**
 * Spec rewrite: the dispatcher MUST replace the echo path with
 * AgentRunner.handle(). After each run, both the user and the
 * assistant turns MUST be persisted via ConversationStore.update
 * (UPSERT), and the assistant reply MUST be sent via
 * WhatsappSenderPort.sendText. No proactive sends.
 *
 * Post-incident additions (unsolicited greetings bug):
 *   - A re-delivered (duplicate) message id is skipped before any agent
 *     run — Meta re-delivery is deduped via WEBHOOK_DEDUP.
 *   - An echo of the bot's own outbound message is skipped via
 *     RECENT_OUTBOUND.
 *   - A message is marked seen ONLY after a successful send, so a failed
 *     send still lets a re-delivery retry it.
 */
describe('WebhookDispatcherService (agent dispatch path)', () => {
  let store: jest.Mocked<ConversationStore>;
  let sender: jest.Mocked<WhatsappSenderPort>;
  let llm: jest.Mocked<LlmAgentPort>;
  let tools: jest.Mocked<ToolRegistry>;
  let costGuard: CostGuardService;
  let runner: AgentRunner;
  let service: WebhookDispatcherService;
  let dedup: jest.Mocked<WebhookDedupStore>;
  let recentOutbound: jest.Mocked<RecentOutboundStore>;
  let humanHandoff: jest.Mocked<
    Pick<HumanHandoffService, 'isOpsSender' | 'create' | 'resolveReply'>
  >;
  let conversationStore: jest.Mocked<ConversationStore>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-23T12:00:00.000Z'));

    store = {
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    sender = {
      sendText: jest
        .fn<
          Promise<SendResult>,
          [Parameters<WhatsappSenderPort['sendText']>[0]]
        >()
        .mockResolvedValue({ providerMessageId: 'wamid.reply' }),
    };

    llm = {
      run: jest.fn(),
    };

    tools = {
      getTools: jest.fn().mockReturnValue({}),
    };

    costGuard = new CostGuardService(1_000_000);

    const cfg: AgentRunnerConfig = {
      systemPrompt: 'sys',
      historyTurns: 12,
      idleTimeoutMs: 3 * 60 * 60 * 1000,
    };
    runner = AgentRunner.forTest(store, llm, tools, costGuard, cfg);

    dedup = {
      isDuplicate: jest.fn().mockResolvedValue(false),
      markSeen: jest.fn().mockResolvedValue(undefined),
    };

    recentOutbound = {
      remember: jest.fn(),
      isKnown: jest.fn().mockReturnValue(false),
    };

    // Human-handoff slice: stubbed service. Tests that exercise the ops
    // pre-routing hook override `.isOpsSender` or `.resolveReply`
    // per-scenario.
    humanHandoff = {
      isOpsSender: jest.fn().mockReturnValue(false),
      resolveReply: jest.fn(),
      create: jest.fn(),
    };

    // ConversationStore is used by the dispatcher to read
    // `data.pendingHumanRequest` for the customer's pending-marker
    // short-circuit (step 4). Default: returns null (no marker).
    conversationStore = {
      get: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    service = new WebhookDispatcherService(
      runner,
      sender,
      dedup,
      recentOutbound,
      humanHandoff,
      conversationStore,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── Scenario: Signed inbound text reaches agent dispatch ───────────
  it('invokes the agent, persists the assistant turn, and sends the reply', async () => {
    // ADR-28: after `llm.run` the runner re-fetches state. First
    // call returns null (first contact); second returns the
    // just-written state with empty messages.
    store.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
      senderId: '5215550001111',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { messages: [] },
    });
    store.update.mockResolvedValue({
      senderId: '5215550001111',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { messages: [] },
    });
    llm.run.mockResolvedValue({
      reply: 'Hola, ¿en qué te puedo ayudar?',
      messages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
      ],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '5215550001111' }],
                messages: [
                  {
                    id: 'wamid.inbound',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(llm.run).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: '5215550001111',
        text: 'hola',
      }),
    );

    expect(store.update).toHaveBeenCalledWith(
      '5215550001111',
      expect.objectContaining({
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          messages: [
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
          ],
        },
      }),
    );

    expect(sender.sendText).toHaveBeenCalledWith({
      to: '5215550001111',
      text: 'Hola, ¿en qué te puedo ayudar?',
    });
  });

  it('does NOT send any message outside the inbound-driven path (no proactive sends)', async () => {
    // Empty webhook event: no messages at all.
    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {} }] }],
    };

    await expect(service.dispatch(event)).resolves.toBeUndefined();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(llm.run).not.toHaveBeenCalled();
  });

  it('preserves prior history turns when UPSERTing after a successful run', async () => {
    const prior: ConversationState = {
      senderId: '5215550001111',
      lastMessageAt: '2026-06-23T11:59:30.000Z', // within idle window
      data: {
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola' },
        ] as AgentMessage[],
      },
    };
    store.get.mockResolvedValue(prior);
    store.update.mockResolvedValue({
      ...prior,
      lastMessageAt: '2026-06-23T12:00:00.000Z',
    });
    llm.run.mockResolvedValue({
      reply: 'precio: $100',
      messages: [
        ...prior.data.messages!,
        { role: 'user', content: 'precio?' },
        { role: 'assistant', content: 'precio: $100' },
      ],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.inbound-2',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'precio?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    // User + assistant both appended to the prior transcript.
    expect(store.update).toHaveBeenCalledWith(
      '5215550001111',
      expect.objectContaining({
        data: {
          messages: [
            { role: 'user', content: 'hola' },
            { role: 'assistant', content: 'Hola' },
            { role: 'user', content: 'precio?' },
            { role: 'assistant', content: 'precio: $100' },
          ],
        },
      }),
    );
    expect(sender.sendText).toHaveBeenCalledWith({
      to: '5215550001111',
      text: 'precio: $100',
    });
  });

  // ─── Scenario: Meta re-delivers a SUCCESSFULLY processed message ──────
  // The observed production bug: a webhook re-delivery (retry) was
  // re-processed as a new message, producing unsolicited greetings.
  it('skips a duplicate delivery (dedup) — no agent run, no reply', async () => {
    dedup.isDuplicate.mockResolvedValue(true);
    store.get.mockResolvedValue(null);

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.dup',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(llm.run).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });

  // ─── Scenario: the event is an ECHO of a message the bot sent ────────
  it('skips an echo of its own outbound message — no agent run, no reply', async () => {
    recentOutbound.isKnown.mockReturnValue(true);
    store.get.mockResolvedValue(null);

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.reply', // matches the last sendText result
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'Hola, ¿en qué te puedo ayudar?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(llm.run).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  // ─── Scenario: successful processing records dedup + outbound echo ───
  it('marks the message seen and remembers the outbound wamid after success', async () => {
    store.get.mockResolvedValue(null);
    store.update.mockResolvedValue({
      senderId: '5215550001111',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { messages: [] },
    });
    llm.run.mockResolvedValue({
      reply: 'Hola',
      messages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'Hola' },
      ],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.inbound-3',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.reply');
    expect(dedup.markSeen).toHaveBeenCalledWith('wamid.inbound-3');
  });

  // ─── Scenario: failed SEND → NOT marked seen (retry must reprocess) ──
  it('does NOT mark the message seen when the send fails, so a retry can reprocess', async () => {
    store.get.mockResolvedValue(null);
    store.update.mockResolvedValue({
      senderId: '5215550001111',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { messages: [] },
    });
    llm.run.mockResolvedValue({
      reply: 'Hola',
      messages: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    sender.sendText.mockRejectedValue(new Error('Meta 131030'));

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.failsend',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await expect(service.dispatch(event)).rejects.toThrow('Meta 131030');
    expect(dedup.markSeen).not.toHaveBeenCalled();
  });

  // ─── Scenario: one event carries several messages, one already seen ──
  it('processes each new message and skips only the duplicate within one event', async () => {
    store.get.mockResolvedValue(null);
    store.update.mockResolvedValue({
      senderId: '5215550001111',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { messages: [] },
    });
    llm.run.mockResolvedValue({
      reply: 'Hola',
      messages: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    dedup.isDuplicate.mockImplementation(
      async (id: string) => id === 'wamid.dup',
    );

    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.dup',
                    from: '5215550001111',
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'duplicado' },
                  },
                  {
                    id: 'wamid.new',
                    from: '5215550001111',
                    timestamp: '1719000001',
                    type: 'text',
                    text: { body: 'nuevo' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await service.dispatch(event);

    expect(llm.run).toHaveBeenCalledTimes(1);
    expect(llm.run).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'nuevo' }),
    );
    expect(sender.sendText).toHaveBeenCalledTimes(1);
  });

  // ─── Ops pre-routing hook + pending-marker short-circuit ──────────────
  // human-handoff slice (spec whatsapp-webhook delta §"Ops pre-routing
  // hook" + §"pendingHumanRequest short-circuit"). These scenarios were
  // the verify blocker: the ops path and the short-circuit had ZERO
  // coverage in this file. The hook runs AFTER echo + dedup and BEFORE
  // the runner; the short-circuit runs only for customer-side inbounds.
  describe('ops pre-routing hook + pending-marker short-circuit', () => {
    const OPS = '5219999888777';
    const CUSTOMER = '5215550001111';

    const opsEvent = (messageId: string, body: string): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: messageId,
                    from: OPS,
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    it('resolved outcome: resolveReply → synthetic customer turn via AgentRunner → reply sent to the CUSTOMER', async () => {
      humanHandoff.isOpsSender.mockReturnValue(true);
      humanHandoff.resolveReply.mockResolvedValue({
        kind: 'resolved',
        customerId: CUSTOMER,
        ref: 'HF-abc123def456',
        resolution: { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 },
        syntheticUserText:
          '[Resolución del agente humano (HF-abc123def456)] El producto estará disponible nuevamente en 3 día(s).',
      });
      // The runner processes the synthetic turn as a normal customer
      // turn (first contact — the marker was already cleared by
      // resolveReply, so the runner's ADR-29 gate does not fire).
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      });
      llm.run.mockResolvedValue({
        reply: '¡Claro! El producto estará disponible en 3 días.',
        messages: [
          {
            role: 'user',
            content:
              '[Resolución del agente humano (HF-abc123def456)] El producto estará disponible nuevamente en 3 día(s).',
          },
          {
            role: 'assistant',
            content: '¡Claro! El producto estará disponible en 3 días.',
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      await service.dispatch(
        opsEvent('wamid.ops-resolve', 'HF-abc123def456 YES_RESTOCK_IN_X_DAYS:3'),
      );

      expect(humanHandoff.resolveReply).toHaveBeenCalledWith({
        text: 'HF-abc123def456 YES_RESTOCK_IN_X_DAYS:3',
        from: OPS,
      });
      // The synthetic turn runs through the runner as a CUSTOMER turn
      // (NOT the ops phone).
      expect(llm.run).toHaveBeenCalledTimes(1);
      expect(llm.run).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: CUSTOMER,
          text: expect.stringContaining('HF-abc123def456'),
        }),
      );
      // The assistant reply goes to the CUSTOMER, never to ops.
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: '¡Claro! El producto estará disponible en 3 días.',
      });
      expect(sender.sendText).not.toHaveBeenCalledWith(
        expect.objectContaining({ to: OPS }),
      );
      // The ops inbound is still marked seen (dedup bookkeeping).
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.ops-resolve');
    });

    it('no_pending outcome: ASK_FOR_REF goes back to the OPS number, no agent run', async () => {
      humanHandoff.isOpsSender.mockReturnValue(true);
      humanHandoff.resolveReply.mockResolvedValue({
        kind: 'no_pending',
        reply: ASK_FOR_REF,
      });

      await service.dispatch(opsEvent('wamid.ops-nopending', 'hola'));

      expect(humanHandoff.resolveReply).toHaveBeenCalledWith({
        text: 'hola',
        from: OPS,
      });
      expect(sender.sendText).toHaveBeenCalledWith({
        to: OPS,
        text: ASK_FOR_REF,
      });
      expect(llm.run).not.toHaveBeenCalled();
      // The ops path short-circuits BEFORE the pending-marker read.
      expect(conversationStore.get).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.ops-nopending');
    });

    it('dedup applies to ops inbounds unchanged: a duplicate ops wamid never reaches resolveReply', async () => {
      dedup.isDuplicate.mockResolvedValue(true);
      humanHandoff.isOpsSender.mockReturnValue(true);

      await service.dispatch(
        opsEvent('wamid.ops-dup', 'HF-abc123def456 NO_RESTOCK'),
      );

      expect(dedup.isDuplicate).toHaveBeenCalledWith('wamid.ops-dup');
      expect(humanHandoff.resolveReply).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).not.toHaveBeenCalled();
    });

    it('customer inbound with pending marker: canned reply, NO AgentRunner call, no transcript write', async () => {
      // Default humanHandoff.isOpsSender → false: customer-side inbound.
      conversationStore.get.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: {
          pendingHumanRequest: {
            requestId: 'abc123def456',
            ref: 'HF-abc123def456',
            createdAt: '2026-06-23T12:00:00.000Z',
            customerNotifiedAt: '2026-06-23T12:00:00.000Z',
          },
        },
      });

      const event: WebhookEventDto = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.cust-pending',
                      from: CUSTOMER,
                      timestamp: '1719000000',
                      type: 'text',
                      text: { body: '¿siguen?' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      await service.dispatch(event);

      expect(humanHandoff.resolveReply).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: PENDING_HUMAN_REQUEST_REPLY,
      });
      expect(llm.run).not.toHaveBeenCalled(); // runner never invoked
      expect(store.update).not.toHaveBeenCalled(); // no transcript write
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.reply');
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.cust-pending');
    });
  });
});

// ─── whatsapp-webhook spec §"InboundMessage.receivingPhoneNumberId" ──────────
// The spec delta requires the normalizer to capture
// `value.metadata.phone_number_id` (defensive + observable only; the ops
// discriminator stays `isOpsSender(from)` per ADR-22) and the
// `InboundMessage` interface to carry the typed optional field.
describe('normalizeInboundMessages (metadata → receivingPhoneNumberId)', () => {
  const textMessage = (id: string) => ({
    id,
    from: '5215550001111',
    timestamp: '1719000000',
    type: 'text',
    text: { body: 'hola' },
  });

  it('populates receivingPhoneNumberId from value.metadata.phone_number_id when present', () => {
    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: {
                  display_phone_number: '5219999888777',
                  phone_number_id: '1234567890',
                },
                messages: [textMessage('wamid.meta-1')],
              },
            },
          ],
        },
      ],
    };

    const messages: InboundMessage[] = normalizeInboundMessages(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].receivingPhoneNumberId).toBe('1234567890');
  });

  it('leaves receivingPhoneNumberId undefined when value.metadata is absent', () => {
    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [textMessage('wamid.meta-2')],
              },
            },
          ],
        },
      ],
    };

    const messages: InboundMessage[] = normalizeInboundMessages(event);
    expect(messages).toHaveLength(1);
    expect(messages[0].receivingPhoneNumberId).toBeUndefined();
  });

  it('propagates the field to EVERY message produced from one event', () => {
    const event: WebhookEventDto = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '999888777' },
                messages: [
                  textMessage('wamid.meta-3'),
                  textMessage('wamid.meta-4'),
                ],
              },
            },
          ],
        },
      ],
    };

    const messages: InboundMessage[] = normalizeInboundMessages(event);
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.receivingPhoneNumberId).toBe('999888777');
    }
  });
});
