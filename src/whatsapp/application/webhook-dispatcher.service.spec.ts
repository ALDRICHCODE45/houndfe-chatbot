import {
  AgentRunner,
  type AgentRunnerConfig,
} from '../../llm-agent/application/agent-runner.service';
import { CostGuardService } from '../../llm-agent/application/cost-guard.service';
import { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import {
  type AgentMessage,
  type ConversationState,
  type ConversationStateData,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import { type LlmAgentPort } from '../../llm-agent/domain/llm-agent.port';
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
  SHIPPING_DECISION_GRAMMAR,
  SHIPPING_REQUOTE_REPLY,
  SHIPPING_RETRY_REPLY,
  type HumanHandoffService,
} from '../../human-handoff/application/human-handoff.service';
import { ReceiptAmountRouterService } from '../../receipt-media/application/receipt-amount-router.service';
import type { ActiveReceiptStatus } from '../../receipt-media/domain/receipt-media-store.port';
import {
  SHIPPING_CUSTOMER_ACCEPTANCE_KEY,
  SHIPPING_CUSTOMER_OFFER_KEY,
} from '../../shipping/application/shipping-customer-acceptance';
import {
  shippingAcceptancePair,
  shippingCustomerAcceptance,
  shippingCustomerOffer,
} from '../../../test/fixtures/shipping-customer-acceptance-fixture';
import type {
  ReceiptMediaOutboxRow,
  ReceiptMediaRow,
} from '../../receipt-media/domain/receipt-media.types';
import { type ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';

const receiptMediaRowFixture = (id: string): ReceiptMediaRow =>
  ({ id }) as unknown as ReceiptMediaRow;

const receiptMediaOutboxRowFixture = (id: string): ReceiptMediaOutboxRow =>
  ({ id }) as unknown as ReceiptMediaOutboxRow;

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
  let amountRouter: jest.Mocked<ReceiptAmountRouterService>;
  let ingress: jest.Mocked<ReceiptIngressService>;
  let minimalAgent: jest.Mocked<MinimalCatalogAgentService>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-23T12:00:00.000Z'));

    store = {
      commitAgentTurn: jest.fn().mockResolvedValue(true),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setPendingHumanRequest: jest.fn(),
      clearPendingHumanRequest: jest.fn(),
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
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
      commitAgentTurn: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      setPendingHumanRequest: jest.fn(),
      clearPendingHumanRequest: jest.fn(),
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
    };

    // WU13-B1: ReceiptAmountRouter mock. Default fenced so the ordinary
    // agent path runs. Tests override per scenario.
    amountRouter = {
      route: jest.fn().mockResolvedValue({ kind: 'fenced' }),
    } as unknown as jest.Mocked<ReceiptAmountRouterService>;

    // WU13-B2: ReceiptIngressService mock. Default reserved with a minimal
    // receipt fixture — the only valid closed terminal decision that carries
    // a receipt; guidance and other silent outcomes carry no receipt field.
    ingress = {
      admit: jest.fn().mockResolvedValue({
        kind: 'reserved',
        receipt: { id: 'r-default' },
      }),
    } as unknown as jest.Mocked<ReceiptIngressService>;

    // Experimental minimal SDK route. Default: not-handled so every existing
    // scenario continues through the unchanged legacy AgentRunner path.
    minimalAgent = {
      tryHandle: jest.fn().mockResolvedValue({ kind: 'not-handled' }),
    } as unknown as jest.Mocked<MinimalCatalogAgentService>;

    service = new WebhookDispatcherService(
      runner,
      sender,
      dedup,
      recentOutbound,
      humanHandoff as unknown as HumanHandoffService,
      conversationStore,
      amountRouter,
      ingress,
      minimalAgent,
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

    expect(store.commitAgentTurn).toHaveBeenCalledWith(
      '5215550001111',
      expect.objectContaining({
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola, ¿en qué te puedo ayudar?' },
        ],
      }),
    );

    expect(sender.sendText).toHaveBeenCalledWith({
      to: '5215550001111',
      text: 'Hola, ¿en qué te puedo ayudar?',
    });

    // G-11 whatsapp-webhook/R1/S5: a customer inbound with no pending marker
    // takes the normal path and never routes to the ops resolveReply hook.
    expect(humanHandoff.resolveReply).not.toHaveBeenCalled();
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
    expect(store.commitAgentTurn).toHaveBeenCalledWith(
      '5215550001111',
      expect.objectContaining({
        expected: { messages: prior.data.messages },
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola' },
          { role: 'user', content: 'precio?' },
          { role: 'assistant', content: 'precio: $100' },
        ],
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
  // ─── R3b3-c4c1b: customer inbound identity forwarding (inert) ─────
  describe('customer inbound identity forwarding', () => {
    const CUSTOMER = '5215550001111';
    const OPS_SENDER = '5219999888777';
    const PHONE_ID = '123456789012345';
    const EXPECTED = {
      receivingPhoneNumberId: PHONE_ID,
      senderId: CUSTOMER,
      messageId: 'wamid.inbound',
    };

    const inbound = (
      messageId: string,
      body: string,
      phoneNumberId?: string,
      from = CUSTOMER,
    ): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                ...(phoneNumberId === undefined
                  ? {}
                  : { metadata: { phone_number_id: phoneNumberId } }),
                contacts: [{ wa_id: from }],
                messages: [
                  {
                    id: messageId,
                    from,
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

    const ready = () => {
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      });
      llm.run.mockResolvedValue({
        reply: 'ok',
        messages: [{ role: 'assistant', content: 'ok' }],
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    };
    const input = (index = 0) => llm.run.mock.calls[index][0];
    const hasEvent = (index = 0) =>
      Object.prototype.hasOwnProperty.call(input(index), 'inboundEvent');

    it('forwards the normalized customer identity into the agent run', async () => {
      ready();
      await service.dispatch(inbound('wamid.inbound', 'hola', PHONE_ID));
      expect(llm.run).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: CUSTOMER,
          text: 'hola',
          inboundEvent: EXPECTED,
        }),
      );
    });

    it('omits the property when the customer inbound has no phone metadata', async () => {
      ready();
      await service.dispatch(inbound('wamid.inbound', 'hola'));
      expect(hasEvent()).toBe(false);
    });

    it('never forwards the ops identity into the synthetic customer turn', async () => {
      ready();
      humanHandoff.isOpsSender.mockImplementation(
        (sender) => sender === OPS_SENDER,
      );
      humanHandoff.resolveReply.mockResolvedValue({
        kind: 'resolved',
        customerId: CUSTOMER,
        ref: 'HF-abc123def456',
        resolution: { decision: 'YES_RESTOCK_IN_X_DAYS', days: 3 },
        syntheticUserText: '[Resolución humana] disponible en 3 días.',
      });
      await service.dispatch(
        inbound('wamid.ops', 'HF-abc123def456', PHONE_ID, OPS_SENDER),
      );
      expect(humanHandoff.isOpsSender).toHaveBeenCalledWith(OPS_SENDER);
      expect(input().senderId).toBe(CUSTOMER);
      expect(hasEvent()).toBe(false);
    });

    it('preserves the event identity across a redelivery of the same message', async () => {
      ready();
      const event = inbound('wamid.inbound', 'hola', PHONE_ID);
      await service.dispatch(event);
      await service.dispatch(event);
      expect(llm.run).toHaveBeenCalledTimes(2);
      const [first, second] = llm.run.mock.calls.map((c) => c[0].inboundEvent);
      expect(first).toEqual(EXPECTED);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
    });
  });

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
        opsEvent(
          'wamid.ops-resolve',
          'HF-abc123def456 YES_RESTOCK_IN_X_DAYS:3',
        ),
      );

      expect(humanHandoff.resolveReply).toHaveBeenCalledWith({
        text: 'HF-abc123def456 YES_RESTOCK_IN_X_DAYS:3',
        from: OPS,
      });
      // The synthetic turn runs through the runner as a CUSTOMER turn
      // (NOT the ops phone).
      expect(llm.run).toHaveBeenCalledTimes(1);
      const [syntheticTurn] = llm.run.mock.calls[0];
      expect(syntheticTurn.senderId).toBe(CUSTOMER);
      expect(syntheticTurn.text).toContain('HF-abc123def456');
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

    // SQ-5C2d: the dispatcher already hands every non-`resolved` ops outcome
    // the same way (reply to ops, no runner). Characterize the three
    // data-free shipping outcomes so their exact SHIPPING_* copy is pinned
    // and can never leak to the customer.
    it.each([
      ['needs_decision', SHIPPING_DECISION_GRAMMAR],
      ['needs_requote', SHIPPING_REQUOTE_REPLY],
      ['ops_error', SHIPPING_RETRY_REPLY],
    ] as const)(
      '%s outcome: the exact data-free SHIPPING_* reply goes to the OPS number with no runner call',
      async (kind, reply) => {
        humanHandoff.isOpsSender.mockReturnValue(true);
        humanHandoff.resolveReply.mockResolvedValue({ kind, reply });
        const messageId = `wamid.ops-${kind}`;

        await service.dispatch(opsEvent(messageId, 'APPROVE_SHIPPING'));

        expect(humanHandoff.resolveReply).toHaveBeenCalledWith({
          text: 'APPROVE_SHIPPING',
          from: OPS,
        });
        // Ops-only: the canned shipping reply never reaches the customer.
        expect(sender.sendText).toHaveBeenCalledTimes(1);
        expect(sender.sendText).toHaveBeenCalledWith({ to: OPS, text: reply });
        expect(sender.sendText).not.toHaveBeenCalledWith(
          expect.objectContaining({ to: CUSTOMER }),
        );
        // No customer synthetic turn and no LLM/runner invocation.
        expect(llm.run).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
        // The ops path short-circuits BEFORE the pending-marker read.
        expect(conversationStore.get).not.toHaveBeenCalled();
        expect(dedup.markSeen).toHaveBeenCalledWith(messageId);
      },
    );

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

  // ─── SCA-3b2: post-approval deterministic shipping disclosure ─────────────
  describe('SCA-3b2: SHIPPING_APPROVED deterministic price disclosure', () => {
    const OPS = '5219999888777';
    const CUSTOMER = '5215550001111';
    const PIN = '2026-06-23T12:00:00.000Z';
    const EXPIRES = '2026-06-23T12:30:00.000Z';
    const REQUEST = 'abcdef123456';
    const MERCH = 60_000;
    const CHARGE = 6_900;
    const CUSTOMER_UUID = '11111111-1111-1111-1111-111111111111';
    const ADDR = '22222222-2222-2222-2222-222222222222';
    const PRODUCT = '33333333-3333-3333-3333-333333333333';
    // Exact deterministic disclosure bytes (merchandise + freight + total).
    const TEXT = [
      'Detalle de tu envío (producto medido):',
      'Mercancía: $600.00 MXN',
      'Envío: $69.00 MXN',
      'Total: $669.00 MXN',
      '',
      'Verificaremos el precio antes de registrar tu pedido. Si cambia, te mostraremos el nuevo total para que lo confirmes otra vez.',
      '',
      'Responde exactamente "SÍ" para aceptar o "NO" para rechazar.',
    ].join('\n');

    const line = (unitPriceCents = MERCH) => ({
      productId: PRODUCT,
      variantId: null,
      quantity: 1,
      unitPriceCents,
    });
    const data = (
      over: Record<string, unknown> = {},
    ): ConversationStateData => ({
      shippingQuoteDraft: {
        schemaVersion: 1,
        draft: {
          quoteId: 'quote-1',
          selectedRate: {
            rateId: 'rate-1',
            carrierName: 'Skydropx',
            serviceName: 'Express',
            priceCents: CHARGE + 12_000,
            currency: 'MXN',
            estimatedDeliveryDays: 3,
            validUntil: null,
          },
          providerExpiresAt: null,
          bestRateCents: CHARGE + 12_000,
          totalCreditCents: 12_000,
          appliedCreditCents: 12_000,
          unusedCreditCents: 0,
          qualifyingUnitCount: 1,
          customerPaysCents: CHARGE,
        },
        createdAt: PIN,
        expiresAt: EXPIRES,
      },
      shippingQuoteDraftContext: {
        schemaVersion: 1,
        draftCreatedAt: PIN,
        customerId: CUSTOMER_UUID,
        shippingAddressId: ADDR,
        cart: [line()],
        destination: {
          zipCode: '06700',
          state: 'Ciudad de México',
          municipality: 'Cuauhtémoc',
          neighborhood: 'Roma Norte',
        },
      },
      shippingApproval: {
        requestId: REQUEST,
        draftCreatedAt: PIN,
        decision: 'SHIPPING_APPROVED',
        decidedAt: '2026-06-23T12:05:00.000Z',
      },
      cart: {
        items: [line()],
        idempotencyKey: 'key-1',
        expectedTotalCents: MERCH,
      },
      ...over,
    });
    const state = (over: Record<string, unknown> = {}): ConversationState => ({
      senderId: CUSTOMER,
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: data(over),
    });
    const opsEvent = (): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.ops-ship-approve',
                    from: OPS,
                    timestamp: '1719000000',
                    type: 'text',
                    text: { body: 'HF-abcdef123456 APPROVE_SHIPPING' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    beforeEach(() => {
      jest.setSystemTime(new Date('2026-06-23T12:10:00.000Z'));
      humanHandoff.isOpsSender.mockReturnValue(true);
      humanHandoff.resolveReply.mockResolvedValue({
        kind: 'resolved',
        customerId: CUSTOMER,
        ref: 'HF-abcdef123456',
        resolution: { decision: 'SHIPPING_APPROVED', draftCreatedAt: PIN },
        syntheticUserText: '[Resolución del agente humano]',
      });
      conversationStore.update.mockImplementation(
        (
          senderId: string,
          patch: Partial<Omit<ConversationState, 'senderId'>>,
        ) => Promise.resolve({ senderId, ...patch } as ConversationState),
      );
    });

    it('sends the price to the CUSTOMER first, then persists the sent offer with the real provider id', async () => {
      conversationStore.get.mockResolvedValue(state());
      sender.sendText.mockResolvedValue({ providerMessageId: 'wamid.offer' });

      await service.dispatch(opsEvent());

      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: TEXT,
      });
      const sendOrder = sender.sendText.mock.invocationCallOrder[0];
      const persistOrder = conversationStore.update.mock.invocationCallOrder[0];
      expect(sendOrder).toBeLessThan(persistOrder);
      const [, patch] = conversationStore.update.mock.calls[0];
      expect(patch.data![SHIPPING_CUSTOMER_OFFER_KEY]).toEqual({
        schemaVersion: 1,
        requestId: REQUEST,
        draftCreatedAt: PIN,
        offeredAt: '2026-06-23T12:10:00.000Z',
        expiresAt: EXPIRES,
        merchandiseCents: MERCH,
        chargeCents: CHARGE,
        expectedTotalCents: MERCH + CHARGE,
        providerMessageId: 'wamid.offer',
      });
      expect(patch.data![SHIPPING_CUSTOMER_ACCEPTANCE_KEY]).toBeNull();
      expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.offer');
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.ops-ship-approve');
    });

    it('never routes the approval through the LLM runner or the transcript store', async () => {
      conversationStore.get.mockResolvedValue(state());

      await service.dispatch(opsEvent());

      expect(llm.run).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
      expect(humanHandoff.resolveReply).toHaveBeenCalledWith({
        text: 'HF-abcdef123456 APPROVE_SHIPPING',
        from: OPS,
      });
    });

    it('send failure fails closed: no persist, no remember and no dedup mark', async () => {
      conversationStore.get.mockResolvedValue(state());
      sender.sendText.mockRejectedValue(new Error('send-down'));

      await expect(service.dispatch(opsEvent())).rejects.toThrow('send-down');

      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(recentOutbound.remember).not.toHaveBeenCalled();
      expect(dedup.markSeen).not.toHaveBeenCalled();
    });

    it('persist failure fails closed: the send is remembered but never marked seen', async () => {
      conversationStore.get.mockResolvedValue(state());
      sender.sendText.mockResolvedValue({ providerMessageId: 'wamid.offer' });
      conversationStore.update.mockResolvedValueOnce(
        null as unknown as ConversationState,
      );

      await expect(service.dispatch(opsEvent())).rejects.toThrow();

      expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.offer');
      expect(dedup.markSeen).not.toHaveBeenCalled();
    });

    it('replay: an active persisted offer on the same request/pin/amounts skips re-send and marks seen', async () => {
      conversationStore.get.mockResolvedValue(
        state({ [SHIPPING_CUSTOMER_OFFER_KEY]: shippingCustomerOffer() }),
      );

      await service.dispatch(opsEvent());

      expect(sender.sendText).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(recentOutbound.remember).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.ops-ship-approve');
    });

    it('stale cart fails closed: no send, no persist and no dedup mark', async () => {
      conversationStore.get.mockResolvedValue(
        state({
          cart: {
            items: [line(MERCH + 100)],
            idempotencyKey: 'key-1',
            expectedTotalCents: MERCH + 100,
          },
        }),
      );

      await expect(service.dispatch(opsEvent())).rejects.toThrow();

      expect(sender.sendText).not.toHaveBeenCalled();
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(dedup.markSeen).not.toHaveBeenCalled();
    });

    it('changed price: distrusts the stale offer, re-sends and clears any prior acceptance', async () => {
      const stale = shippingCustomerOffer({ chargeCents: CHARGE - 100 });
      const prior = shippingCustomerAcceptance({ chargeCents: CHARGE - 100 });
      conversationStore.get.mockResolvedValue(
        state({
          [SHIPPING_CUSTOMER_OFFER_KEY]: stale,
          [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: prior,
        }),
      );
      sender.sendText.mockResolvedValue({ providerMessageId: 'wamid.reprice' });

      await service.dispatch(opsEvent());

      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: TEXT,
      });
      const [, patch] = conversationStore.update.mock.calls[0];
      expect(patch.data![SHIPPING_CUSTOMER_OFFER_KEY]).toMatchObject({
        chargeCents: CHARGE,
        expectedTotalCents: MERCH + CHARGE,
        providerMessageId: 'wamid.reprice',
      });
      expect(patch.data![SHIPPING_CUSTOMER_ACCEPTANCE_KEY]).toBeNull();
    });

    // ─── SCA-3b3: replay fencing + post-send clock ─────────────────────────
    describe('SCA-3b3: replay fence and post-send clock', () => {
      it('re-discloses when the persisted acceptance is malformed, clearing it', async () => {
        conversationStore.get.mockResolvedValue(
          state({
            [SHIPPING_CUSTOMER_OFFER_KEY]: shippingCustomerOffer(),
            [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: { schemaVersion: 1 },
          }),
        );
        sender.sendText.mockResolvedValue({
          providerMessageId: 'wamid.reaccept',
        });

        await service.dispatch(opsEvent());

        expect(llm.run).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: TEXT,
        });
        const [, patch] = conversationStore.update.mock.calls[0];
        expect(patch.data![SHIPPING_CUSTOMER_OFFER_KEY]).toMatchObject({
          chargeCents: CHARGE,
          providerMessageId: 'wamid.reaccept',
        });
        expect(patch.data![SHIPPING_CUSTOMER_ACCEPTANCE_KEY]).toBeNull();
        expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.reaccept');
      });

      it('re-discloses when the persisted acceptance is orphaned from the offer', async () => {
        conversationStore.get.mockResolvedValue(
          state({
            [SHIPPING_CUSTOMER_OFFER_KEY]: shippingCustomerOffer(),
            [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: shippingCustomerAcceptance({
              requestId: 'ffffffffffff',
            }),
          }),
        );
        sender.sendText.mockResolvedValue({
          providerMessageId: 'wamid.reaccept',
        });

        await service.dispatch(opsEvent());

        expect(llm.run).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: TEXT,
        });
        const [, patch] = conversationStore.update.mock.calls[0];
        expect(patch.data![SHIPPING_CUSTOMER_OFFER_KEY]).toMatchObject({
          providerMessageId: 'wamid.reaccept',
        });
        expect(patch.data![SHIPPING_CUSTOMER_ACCEPTANCE_KEY]).toBeNull();
      });

      it('re-discloses when the persisted acceptance is dated in the future', async () => {
        conversationStore.get.mockResolvedValue(
          state({
            [SHIPPING_CUSTOMER_OFFER_KEY]: shippingCustomerOffer(),
            [SHIPPING_CUSTOMER_ACCEPTANCE_KEY]: shippingCustomerAcceptance({
              acceptedAt: '2026-06-23T12:20:00.000Z',
            }),
          }),
        );
        sender.sendText.mockResolvedValue({
          providerMessageId: 'wamid.reaccept',
        });

        await service.dispatch(opsEvent());

        expect(llm.run).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: TEXT,
        });
        const [, patch] = conversationStore.update.mock.calls[0];
        expect(patch.data![SHIPPING_CUSTOMER_OFFER_KEY]).toMatchObject({
          providerMessageId: 'wamid.reaccept',
        });
        expect(patch.data![SHIPPING_CUSTOMER_ACCEPTANCE_KEY]).toBeNull();
      });

      it('replay: a fully valid charged acceptance keeps the active offer and skips re-send', async () => {
        conversationStore.get.mockResolvedValue(
          state(shippingAcceptancePair()),
        );

        await service.dispatch(opsEvent());

        expect(sender.sendText).not.toHaveBeenCalled();
        expect(conversationStore.update).not.toHaveBeenCalled();
        expect(recentOutbound.remember).not.toHaveBeenCalled();
        expect(dedup.markSeen).toHaveBeenCalledWith('wamid.ops-ship-approve');
      });

      it('clock advance during send fails closed: send remembered, no marker write and no markSeen', async () => {
        conversationStore.get.mockResolvedValue(state());
        sender.sendText.mockImplementation(async () => {
          jest.setSystemTime(new Date('2026-06-23T12:31:00.000Z'));
          return { providerMessageId: 'wamid.late' };
        });

        await expect(service.dispatch(opsEvent())).rejects.toThrow();

        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: TEXT,
        });
        expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.late');
        expect(conversationStore.update).not.toHaveBeenCalled();
        expect(dedup.markSeen).not.toHaveBeenCalled();
      });
    });
  });

  // ─── WU13-A2: normalizeInboundMessages — image / document media ───────────
  describe('normalizeInboundMessages (image + document media)', () => {
    // Shared sender/metadata anchors
    const SENDER = '5215550001111';
    const PHONE_ID = '1234567890';

    const baseEvent = (
      messages: Record<string, unknown>[],
    ): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_ID },
                contacts: [{ wa_id: SENDER }],
                messages,
              },
            },
          ],
        },
      ],
    });

    const baseMessage = (
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id: 'wamid.media-1',
      from: SENDER,
      timestamp: '1719000000',
      ...overrides,
    });

    it('normalizes an image message WITH caption into the domain envelope', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({
          type: 'image',
          image: {
            id: 'media-img-001',
            mime_type: 'image/jpeg',
            caption: 'Mira este producto',
            sha256: 'abc123',
          },
        }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Mira este producto');
      expect(messages[0].media).toEqual({
        kind: 'image',
        providerMediaId: 'media-img-001',
        declaredMimeType: 'image/jpeg',
        caption: 'Mira este producto',
        filename: undefined,
        sha256: 'abc123',
      });
      expect(messages[0].senderId).toBe(SENDER);
      expect(messages[0].messageId).toBe('wamid.media-1');
      expect(messages[0].receivingPhoneNumberId).toBe(PHONE_ID);
    });

    it('normalizes an image message WITHOUT caption as text empty string', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({
          type: 'image',
          image: { id: 'media-img-002', mime_type: 'image/png' },
        }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('');
      expect(messages[0].media).toEqual({
        kind: 'image',
        providerMediaId: 'media-img-002',
        declaredMimeType: 'image/png',
        caption: undefined,
        filename: undefined,
        sha256: undefined,
      });
    });

    it('normalizes a PDF document with filename into the domain envelope', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({
          type: 'document',
          document: {
            id: 'media-doc-001',
            mime_type: 'application/pdf',
            filename: 'comprobante.pdf',
          },
        }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('');
      expect(messages[0].media).toEqual({
        kind: 'document',
        providerMediaId: 'media-doc-001',
        declaredMimeType: 'application/pdf',
        caption: undefined,
        filename: 'comprobante.pdf',
        sha256: undefined,
      });
    });

    it('uses sender fallback when message.from is absent', () => {
      const event: WebhookEventDto = baseEvent([
        {
          id: 'wamid.media-2',
          // from omitted — uses contacts[0].wa_id
          timestamp: '1719000000',
          type: 'image',
          image: { id: 'media-img-003', mime_type: 'image/jpeg' },
        },
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(1);
      expect(messages[0].senderId).toBe(SENDER);
      expect(messages[0].media?.providerMediaId).toBe('media-img-003');
    });

    it('drops media message whose image payload is missing', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({ type: 'image' }), // image key absent
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(0);
    });

    it('drops media message whose id field is missing', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({
          type: 'image',
          image: { mime_type: 'image/jpeg' }, // id absent
        }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(0);
    });

    it('drops media message whose mime_type is empty string', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({
          type: 'image',
          image: { id: 'media-img-004', mime_type: '' },
        }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(0);
    });

    it('drops document type whose type field does not match the present payload', () => {
      // DTO declares type=document but the actual payload is 'image'
      const event: WebhookEventDto = baseEvent([
        baseMessage({
          type: 'document',
          document: { id: 'media-doc-002', mime_type: 'application/pdf' },
          image: { id: 'media-img-005', mime_type: 'image/jpeg' },
        }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      // No message emitted because type=document but image payload is present
      // (a mismatched structural anomaly — drops the message per spec)
      expect(messages).toHaveLength(0);
    });

    it('preserves existing text normalization unchanged', () => {
      const event: WebhookEventDto = baseEvent([
        baseMessage({ type: 'text', text: { body: 'hola mundo' } }),
      ]);

      const messages: InboundMessage[] = normalizeInboundMessages(event);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('hola mundo');
      expect(messages[0].media).toBeUndefined();
    });
  });

  // ─── WU13-B1: ReceiptAmountRouter integration ──────────────────────────────
  describe('WU13-B1: ReceiptAmountRouter customer-text routing', () => {
    const CUSTOMER = '5215550001111';

    const textEvent = (messageId: string, body: string): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: messageId,
                    from: CUSTOMER,
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

    beforeEach(() => {
      amountRouter.route.mockResolvedValue({ kind: 'fenced' });
      store.get.mockResolvedValue(null);
      store.update.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { messages: [] },
      });
      llm.run.mockResolvedValue({
        reply: 'Hola!',
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'Hola!' },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      });
    });

    it('calls amountRouter for customer text before agentRunner', async () => {
      await service.dispatch(textEvent('wamid.route-order', '500 pesos'));
      expect(amountRouter.route).toHaveBeenCalled();
      expect(llm.run).toHaveBeenCalled();
    });

    it('fenced: calls AgentRunner and sends reply normally', async () => {
      amountRouter.route.mockResolvedValue({ kind: 'fenced' });
      await service.dispatch(textEvent('wamid.fenced', 'hola'));
      expect(llm.run).toHaveBeenCalledWith(
        expect.objectContaining({ senderId: CUSTOMER, text: 'hola' }),
      );
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: 'Hola!',
      });
    });

    // ─── G-2 llm-agent/R2/S1: safe guidance after a terminal receipt ─────
    it('llm-agent/R2/S1: a definite terminal receipt outcome reaches the normal AgentRunner path with no protected identifiers in the runner input', async () => {
      // A receipt that already reached a terminal/raced state no longer accepts
      // the customer's confirmation, so the real router fences it and the
      // follow-up takes the ordinary LLM path. The canonical pointer's
      // protected receipt/sale identifiers must reach the real routing
      // boundary but never cross the llm.run port.
      const protectedPointer = {
        receiptMediaId: 'receipt-sentinel-9f2c',
        saleId: 'sale-sentinel-9f2c',
        receiptVersion: '7',
      };
      conversationStore.get.mockResolvedValue({
        senderId: CUSTOMER,
        lastMessageAt: '2026-06-23T11:59:00.000Z',
        data: { receiptAmountPointer: protectedPointer },
      });
      const routerStore = {
        proposeAmount: jest.fn().mockResolvedValue({ kind: 'fenced' as const }),
        rejectProposedAmount: jest
          .fn()
          .mockResolvedValue({ kind: 'fenced' as const }),
        cancelReceipt: jest.fn().mockResolvedValue({ kind: 'fenced' as const }),
        startAttachment: jest
          .fn()
          .mockResolvedValue({ kind: 'fenced' as const }),
      };
      const realRouter = new ReceiptAmountRouterService(
        { get: conversationStore.get },
        routerStore,
      );
      const realService = new WebhookDispatcherService(
        runner,
        sender,
        dedup,
        recentOutbound,
        humanHandoff as unknown as HumanHandoffService,
        conversationStore,
        realRouter,
        ingress,
        minimalAgent,
      );

      await realService.dispatch(textEvent('wamid.terminal-followup', 'sí'));

      // The real router propagated the protected identifiers to its store op,
      // which fenced because the durable row is already terminal/raced.
      expect(routerStore.startAttachment).toHaveBeenCalledTimes(1);
      expect(routerStore.startAttachment).toHaveBeenCalledWith({
        sourceWebhookMessageId: 'wamid.terminal-followup',
        senderId: CUSTOMER,
        receiptMediaId: protectedPointer.receiptMediaId,
        capturedSaleId: protectedPointer.saleId,
        expectedReceiptVersion: protectedPointer.receiptVersion,
        expectedPointer: protectedPointer,
        expectedReceiptStatus: 'AWAITING_CONFIRMATION',
      });
      // The fence fell through to the ordinary LLM path.
      expect(llm.run).toHaveBeenCalledTimes(1);
      const [runnerInput] = llm.run.mock.calls[0];
      expect(runnerInput).toEqual({
        catalogSession: expect.objectContaining({
          senderId: CUSTOMER,
        }) as unknown,
        senderId: CUSTOMER,
        text: 'sí',
        history: [],
        systemPrompt: 'sys',
        tools: {},
      });
      const serialized = JSON.stringify(runnerInput);
      expect(serialized).not.toContain(protectedPointer.receiptMediaId);
      expect(serialized).not.toContain(protectedPointer.saleId);
      expect(runnerInput).not.toHaveProperty('receiptAmountPointer');
    });

    // ─── ODD-4D: deterministic active-text fallback ────────────────────
    // An active amount/confirmation flow with malformed or unrecognized
    // text must never reach the LLM: the dispatcher sends the exact
    // finish-or-cancel guidance deterministically.
    const ACTIVE_FLOW_GUIDANCE =
      'Tienes un proceso abierto: finalízalo o cancélalo.';

    it('ODD-4D unrecognized: exact guidance, one send/remember/markSeen, no LLM', async () => {
      amountRouter.route.mockResolvedValue({ kind: 'unrecognized' });
      sender.sendText.mockResolvedValueOnce({
        providerMessageId: 'wamid.unrecognized-out',
      });
      await service.dispatch(textEvent('wamid.unrecognized', 'hola'));

      expect(sender.sendText).toHaveBeenCalledTimes(1);
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: ACTIVE_FLOW_GUIDANCE,
      });
      expect(recentOutbound.remember as jest.Mock).toHaveBeenCalledTimes(1);
      expect(recentOutbound.remember as jest.Mock).toHaveBeenCalledWith(
        'wamid.unrecognized-out',
      );
      expect(dedup.markSeen as jest.Mock).toHaveBeenCalledTimes(1);
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.unrecognized');
      const order = [
        sender.sendText as jest.Mock,
        recentOutbound.remember as jest.Mock,
        dedup.markSeen as jest.Mock,
      ].map((mock) => mock.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((left, right) => left - right));
      expect(llm.run).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    });

    it('ODD-4D unrecognized: send failure propagates with no remember/markSeen/LLM', async () => {
      amountRouter.route.mockResolvedValue({ kind: 'unrecognized' });
      sender.sendText.mockRejectedValueOnce(new Error('Meta 131030'));
      await expect(
        service.dispatch(textEvent('wamid.unrecognized-fail', 'hola')),
      ).rejects.toThrow('Meta 131030');
      expect(recentOutbound.remember as jest.Mock).not.toHaveBeenCalled();
      expect(dedup.markSeen as jest.Mock).not.toHaveBeenCalled();
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('ODD-4D unrecognized: markSeen failure is swallowed after a successful send', async () => {
      amountRouter.route.mockResolvedValue({ kind: 'unrecognized' });
      dedup.markSeen.mockRejectedValueOnce(new Error('dedup write failed'));
      await expect(
        service.dispatch(textEvent('wamid.unrecognized-markseen-fail', 'hola')),
      ).resolves.toBeUndefined();
      expect(sender.sendText).toHaveBeenCalledTimes(1);
      expect(recentOutbound.remember as jest.Mock).toHaveBeenCalledTimes(1);
      expect(dedup.markSeen).toHaveBeenCalledWith(
        'wamid.unrecognized-markseen-fail',
      );
      expect(llm.run).not.toHaveBeenCalled();
    });

    it('proposed: skips AgentRunner and sender, marks dedup seen, continues', async () => {
      amountRouter.route.mockResolvedValue({
        kind: 'proposed',
        receipt: receiptMediaRowFixture('r1'),
        intent: receiptMediaOutboxRowFixture('i1'),
      });
      await service.dispatch(textEvent('wamid.proposed', '500 pesos'));
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.proposed');
    });

    it('started: skips AgentRunner and sender, marks dedup seen, continues', async () => {
      amountRouter.route.mockResolvedValue({
        kind: 'started',
        receipt: receiptMediaRowFixture('r2'),
        intent: receiptMediaOutboxRowFixture('i2'),
      });
      await service.dispatch(textEvent('wamid.started', 'si'));
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.started');
    });

    it('rejected: skips AgentRunner and sender, marks dedup seen, continues', async () => {
      amountRouter.route.mockResolvedValue({
        kind: 'rejected',
        receipt: receiptMediaRowFixture('r3'),
        intent: receiptMediaOutboxRowFixture('i3'),
      });
      await service.dispatch(textEvent('wamid.rejected', 'no'));
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.rejected');
    });

    it('cancelled: skips AgentRunner and sender, marks dedup seen, continues', async () => {
      amountRouter.route.mockResolvedValue({
        kind: 'cancelled',
        receipt: receiptMediaRowFixture('r4'),
        intent: receiptMediaOutboxRowFixture('i4'),
      });
      await service.dispatch(textEvent('wamid.cancelled', 'cancelar'));
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.cancelled');
    });

    it('replayed: skips AgentRunner and sender, marks dedup seen, continues', async () => {
      amountRouter.route.mockResolvedValue({
        kind: 'replayed',
        receipt: receiptMediaRowFixture('r5'),
        intent: receiptMediaOutboxRowFixture('i5'),
      });
      await service.dispatch(textEvent('wamid.replayed', '500 pesos'));
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.replayed');
    });

    it('terminal outcome with markSeen failure does not throw', async () => {
      amountRouter.route.mockResolvedValue({
        kind: 'proposed',
        receipt: receiptMediaRowFixture('r6'),
        intent: receiptMediaOutboxRowFixture('i6'),
      });
      dedup.markSeen.mockRejectedValue(new Error('dedup write failed'));
      await expect(
        service.dispatch(
          textEvent('wamid.terminal-markseen-fail', '500 pesos'),
        ),
      ).resolves.toBeUndefined();
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith(
        'wamid.terminal-markseen-fail',
      );
    });

    it('ops inbound: amountRouter is NEVER called', async () => {
      humanHandoff.isOpsSender.mockReturnValue(true);
      humanHandoff.resolveReply.mockResolvedValue({
        kind: 'no_pending',
        reply: ASK_FOR_REF,
      });
      await service.dispatch({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.ops-bypass',
                      from: '5219999888777',
                      timestamp: '1719000000',
                      type: 'text',
                      text: { body: 'HF-abc123def456 YES_RESTOCK' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      expect(amountRouter.route).not.toHaveBeenCalled();
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalled();
    });

    it('pending-human short-circuit: amountRouter is NEVER called', async () => {
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
      await service.dispatch(textEvent('wamid.pending-bypass', '¿siguen?'));
      expect(amountRouter.route).not.toHaveBeenCalled();
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: PENDING_HUMAN_REQUEST_REPLY,
      });
    });

    it('media message: amountRouter is NEVER called (media ingress is WU13-B2)', async () => {
      await service.dispatch({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'wamid.media-bypass',
                      from: CUSTOMER,
                      timestamp: '1719000000',
                      type: 'image',
                      image: {
                        id: 'media-img-bypass',
                        mime_type: 'image/jpeg',
                        caption: 'comprobante',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      expect(amountRouter.route).not.toHaveBeenCalled();
      expect(llm.run).not.toHaveBeenCalled();
    });

    // ─── WU13-B2: ReceiptIngressService customer media routing ─────────────────
    describe('WU13-B2: ReceiptIngressService customer media routing', () => {
      const mediaEvent = (
        messageId: string,
        mediaType: 'image' | 'document',
        overrides: Record<string, unknown> = {},
      ): WebhookEventDto => ({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: messageId,
                      from: CUSTOMER,
                      timestamp: '1719000000',
                      type: mediaType,
                      ...(mediaType === 'image'
                        ? {
                            image: {
                              id: 'media-001',
                              mime_type: 'image/jpeg',
                              ...overrides,
                            },
                          }
                        : {
                            document: {
                              id: 'media-001',
                              mime_type: 'application/pdf',
                              ...overrides,
                            },
                          }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      // admit receives exactly 5 fields: the normalized optional caption is
      // the only added field. filename/sha256 and every other payload field
      // are NOT forwarded, and captioned media never reaches the LLM or the
      // amount router.
      const ADMIT_FIELDS = [
        'caption',
        'declaredMimeType',
        'providerMediaId',
        'senderId',
        'webhookMessageId',
      ];

      it('admit: caption-only 5-field contract skips LLM and amount router', async () => {
        let captured:
          | Parameters<jest.Mocked<ReceiptIngressService>['admit']>[0]
          | undefined;
        ingress.admit.mockImplementationOnce(async (input) => {
          captured = input;
          return {
            kind: 'reserved',
            receipt: receiptMediaRowFixture('r-admit'),
          };
        });
        await service.dispatch(
          mediaEvent('wamid.strict', 'image', {
            caption: 'komprobante.png',
            filename: 'evil.pdf',
            sha256: 'deadbeef',
          }),
        );
        expect(captured).toEqual({
          webhookMessageId: 'wamid.strict',
          providerMediaId: 'media-001',
          senderId: CUSTOMER,
          declaredMimeType: 'image/jpeg',
          caption: 'komprobante.png',
        });
        expect(Object.keys(captured ?? {}).sort()).toEqual(ADMIT_FIELDS);
        expect(amountRouter.route).not.toHaveBeenCalled();
        expect(llm.run).not.toHaveBeenCalled();
      });

      it('admit: absent caption still forwards only the 5-field contract', async () => {
        let captured:
          | Parameters<jest.Mocked<ReceiptIngressService>['admit']>[0]
          | undefined;
        ingress.admit.mockImplementationOnce(async (input) => {
          captured = input;
          return {
            kind: 'reserved',
            receipt: receiptMediaRowFixture('r-nocaption'),
          };
        });
        await service.dispatch(
          mediaEvent('wamid.nocaption', 'image', {
            filename: 'evil.pdf',
            sha256: 'deadbeef',
          }),
        );
        expect(captured).toEqual({
          webhookMessageId: 'wamid.nocaption',
          providerMediaId: 'media-001',
          senderId: CUSTOMER,
          declaredMimeType: 'image/jpeg',
          caption: undefined,
        });
        expect(Object.keys(captured ?? {}).sort()).toEqual(ADMIT_FIELDS);
        expect(llm.run).not.toHaveBeenCalled();
      });

      // Guidance: customer sees guidance text, no agent, dedup marked
      const guidanceCases: Array<{
        decision: { kind: string; text: string; status?: ActiveReceiptStatus };
        expected: string;
      }> = [
        {
          decision: {
            kind: 'disabled',
            text: 'El servicio no está disponible. Intenta más tarde.',
          },
          expected: 'El servicio no está disponible. Intenta más tarde.',
        },
        {
          decision: {
            kind: 'unsupported-media',
            text: 'Formato no soportado. Envía JPEG o PNG.',
          },
          expected: 'Formato no soportado. Envía JPEG o PNG.',
        },
        {
          decision: {
            kind: 'no-placed-sale',
            text: 'Primero registra la venta en el sistema.',
          },
          expected: 'Primero registra la venta en el sistema.',
        },
        {
          decision: {
            kind: 'sender-active',
            status: 'AWAITING_AMOUNT',
            text: 'Tienes un proceso abierto: finalízalo o cancélalo.',
          },
          expected: 'Tienes un proceso abierto: finalízalo o cancélalo.',
        },
      ];

      test.each(guidanceCases)(
        '%s: sends guidance and marks seen',
        async (c) => {
          (ingress.admit as jest.Mock).mockResolvedValueOnce(c.decision);
          await service.dispatch(
            mediaEvent(
              `wamid.${c.decision.kind}`,
              c.decision.kind === 'unsupported-media' ? 'document' : 'image',
            ),
          );
          expect(sender.sendText).toHaveBeenCalledWith({
            to: CUSTOMER,
            text: c.expected,
          });
          expect(llm.run).not.toHaveBeenCalled();
          expect(dedup.markSeen).toHaveBeenCalledTimes(1);
        },
      );

      // ── ODD-4C: active-image guidance text by durable status ──────────
      const activeGuidanceCases: Array<{
        status: ActiveReceiptStatus;
        text: string;
      }> = [
        {
          status: 'AWAITING_AMOUNT',
          text: 'Tienes un proceso abierto: finalízalo o cancélalo.',
        },
        {
          status: 'AWAITING_CONFIRMATION',
          text: 'Tienes un proceso abierto: finalízalo o cancélalo.',
        },
        { status: 'RESERVED', text: 'Estamos procesando tu comprobante.' },
        { status: 'DOWNLOADED', text: 'Estamos procesando tu comprobante.' },
        { status: 'STORED', text: 'Estamos procesando tu comprobante.' },
        { status: 'ATTACHING', text: 'Estamos procesando tu comprobante.' },
      ];

      test.each(activeGuidanceCases)(
        'ODD-4C sender-active $status: exact guidance, one send/remember/markSeen, no router/LLM',
        async ({ status, text }) => {
          const wamid = `wamid.active.${status}`;
          ingress.admit.mockResolvedValueOnce({
            kind: 'sender-active',
            status,
          });
          sender.sendText.mockResolvedValueOnce({
            providerMessageId: 'wamid.active-out',
          });

          await service.dispatch(mediaEvent(wamid, 'image'));

          expect(sender.sendText).toHaveBeenCalledTimes(1);
          expect(sender.sendText).toHaveBeenCalledWith({ to: CUSTOMER, text });
          expect(recentOutbound.remember as jest.Mock).toHaveBeenCalledTimes(1);
          expect(recentOutbound.remember as jest.Mock).toHaveBeenCalledWith(
            'wamid.active-out',
          );
          expect(dedup.markSeen).toHaveBeenCalledTimes(1);
          expect(dedup.markSeen).toHaveBeenCalledWith(wamid);
          expect(amountRouter.route).not.toHaveBeenCalled();
          expect(llm.run).not.toHaveBeenCalled();
        },
      );

      // Atomic outcomes: no send, no agent, no extra dedup write. Their
      // admission transaction already persists the inbound marker.
      const silentCases: Array<{
        decision: { kind: string; receiptId?: string };
        wamid: string;
      }> = [
        {
          decision: { kind: 'reserved', receiptId: 'r-s1' },
          wamid: 'wamid.reserved',
        },
        {
          decision: { kind: 'webhook-replayed', receiptId: 'r-s2' },
          wamid: 'wamid.webhookreplayed',
        },
        {
          decision: { kind: 'provider-media-reused', receiptId: 'r-s3' },
          wamid: 'wamid.providermediareused',
        },
        {
          decision: { kind: 'webhook-media-conflict' },
          wamid: 'wamid.webhookmediaconflict',
        },
      ];

      test.each(silentCases)(
        '$decision.kind: no sendText, no LLM, no extra marker write',
        async (c) => {
          const decision = c.decision.receiptId
            ? { kind: c.decision.kind, receipt: { id: c.decision.receiptId } }
            : { kind: c.decision.kind };
          (ingress.admit as jest.Mock).mockResolvedValueOnce(decision);
          await service.dispatch(mediaEvent(c.wamid, 'image'));
          expect(sender.sendText).not.toHaveBeenCalled();
          expect(llm.run).not.toHaveBeenCalled();
          expect(dedup.markSeen).not.toHaveBeenCalled();
        },
      );

      // Error: admit rejection propagates; no send, no markSeen
      it('admit rejection: propagates, no sendText, no markSeen', async () => {
        (ingress.admit as jest.Mock).mockRejectedValueOnce(
          new Error('admission unavailable'),
        );
        await expect(
          service.dispatch(mediaEvent('wamid.fail', 'image')),
        ).rejects.toThrow('admission unavailable');
        expect(sender.sendText).not.toHaveBeenCalled();
        expect(dedup.markSeen).not.toHaveBeenCalled();
      });

      // Ops media bypasses ingress entirely
      it('ops media: ingress.admit is NEVER called', async () => {
        (humanHandoff.isOpsSender as jest.Mock).mockReturnValueOnce(true);
        (humanHandoff.resolveReply as jest.Mock).mockResolvedValueOnce({
          kind: 'no_pending',
          reply: 'ACK',
        });
        await service.dispatch({
          object: 'whatsapp_business_account',
          entry: [
            {
              changes: [
                {
                  value: {
                    messages: [
                      {
                        id: 'wamid.ops-media',
                        from: '5219999888777',
                        timestamp: '1719000000',
                        type: 'image',
                        image: { id: 'media-ops', mime_type: 'image/jpeg' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
        expect(ingress.admit).not.toHaveBeenCalled();
        expect(sender.sendText).toHaveBeenCalled();
      });

      // Pending-human media bypasses ingress entirely
      it('pending-human media: ingress.admit is NEVER called', async () => {
        (conversationStore.get as jest.Mock).mockResolvedValueOnce({
          senderId: CUSTOMER,
          lastMessageAt: '2026-06-23T12:00:00.000Z',
          data: {
            pendingHumanRequest: {
              requestId: 'abc',
              ref: 'HF-abc',
              createdAt: '2026-06-23T12:00:00.000Z',
              customerNotifiedAt: '2026-06-23T12:00:00.000Z',
            },
          },
        });
        await service.dispatch(mediaEvent('wamid.pending', 'image'));
        expect(ingress.admit).not.toHaveBeenCalled();
        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: PENDING_HUMAN_REQUEST_REPLY,
        });
      });

      // Pre-ingress guards: echo and durable marker-only replay skip ingress.
      it('echo: ingress not called', async () => {
        (recentOutbound.isKnown as jest.Mock).mockReturnValueOnce(true);
        await service.dispatch(mediaEvent('wamid.echo', 'image'));
        expect(ingress.admit).not.toHaveBeenCalled();
      });

      it('marker-only duplicate: skips ingress and every downstream processor', async () => {
        (dedup.isDuplicate as jest.Mock).mockResolvedValueOnce(true);

        await service.dispatch(mediaEvent('wamid.marker-only', 'image'));

        expect(ingress.admit).not.toHaveBeenCalled();
        expect(sender.sendText).not.toHaveBeenCalled();
        expect(amountRouter.route).not.toHaveBeenCalled();
        expect(llm.run).not.toHaveBeenCalled();
        expect(dedup.markSeen).not.toHaveBeenCalled();
      });

      it('orders guidance collaborators and remembers the outbound id', async () => {
        ingress.admit.mockResolvedValueOnce({ kind: 'disabled' });
        sender.sendText.mockResolvedValueOnce({
          providerMessageId: 'wamid.out',
        });

        await service.dispatch(mediaEvent('wamid.guidance-order', 'image'));

        const order = [
          dedup.isDuplicate,
          humanHandoff.isOpsSender,
          conversationStore.get,
          ingress.admit,
          sender.sendText,
          recentOutbound.remember as jest.Mock,
          dedup.markSeen as jest.Mock,
        ].map((mock) => mock.mock.invocationCallOrder[0]);
        expect(order).toEqual([...order].sort((left, right) => left - right));
        expect(recentOutbound.remember as jest.Mock).toHaveBeenCalledWith(
          'wamid.out',
        );
      });

      test.each([
        { kind: 'disabled' } as const,
        { kind: 'unsupported-media' } as const,
        { kind: 'no-placed-sale' } as const,
        { kind: 'sender-active', status: 'AWAITING_AMOUNT' } as const,
      ])(
        'guidance marker-write failure after $kind remains terminal',
        async (decision) => {
          ingress.admit.mockResolvedValueOnce(decision);
          dedup.markSeen.mockRejectedValueOnce(new Error('dedup write failed'));

          await expect(
            service.dispatch(mediaEvent('wamid.markseen-fail', 'image')),
          ).resolves.toBeUndefined();
          expect(sender.sendText as jest.Mock).toHaveBeenCalledTimes(1);
          expect(dedup.markSeen).toHaveBeenCalledWith('wamid.markseen-fail');
          expect(llm.run.mock.calls).toHaveLength(0);
          expect(amountRouter.route.mock.calls).toHaveLength(0);
        },
      );

      it('does not remember or mark seen when guidance delivery fails', async () => {
        ingress.admit.mockResolvedValueOnce({ kind: 'disabled' });
        sender.sendText.mockRejectedValueOnce(new Error('Meta 131030'));

        await expect(
          service.dispatch(mediaEvent('wamid.guidance-fail', 'image')),
        ).rejects.toThrow('Meta 131030');
        expect(recentOutbound.remember as jest.Mock).not.toHaveBeenCalled();
        expect(dedup.markSeen as jest.Mock).not.toHaveBeenCalled();
        expect(llm.run.mock.calls).toHaveLength(0);
        expect(amountRouter.route.mock.calls).toHaveLength(0);
      });
    });
  });

  // ─── Experimental minimal SDK catalog route (default-off) ────────────────
  describe('experimental minimal SDK catalog route', () => {
    const CUSTOMER = '5215550001111';
    const event = (id: string): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '123456789012345' },
                messages: [
                  {
                    id,
                    from: CUSTOMER,
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
    });

    it('routes allowlisted senders to the minimal agent, others to legacy', async () => {
      minimalAgent.tryHandle.mockResolvedValueOnce({
        kind: 'handled',
        reply: 'SDK reply',
      });
      await service.dispatch(event('wamid.min.on'));
      expect(minimalAgent.tryHandle).toHaveBeenCalledWith({
        senderId: CUSTOMER,
        text: 'hola',
        inboundEvent: {
          receivingPhoneNumberId: '123456789012345',
          senderId: CUSTOMER,
          messageId: 'wamid.min.on',
        },
      });
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: 'SDK reply',
      });

      store.get.mockResolvedValue(null);
      llm.run.mockResolvedValue({
        reply: 'legacy reply',
        messages: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      });
      await service.dispatch(event('wamid.min.off'));
      expect(llm.run).toHaveBeenCalledTimes(1);
      expect(minimalAgent.tryHandle).toHaveBeenCalledTimes(2);
      expect(sender.sendText).toHaveBeenLastCalledWith({
        to: CUSTOMER,
        text: 'legacy reply',
      });
    });

    it('arms onSent only after a successful send, before remember/dedup', async () => {
      const onSent = jest.fn();
      minimalAgent.tryHandle.mockResolvedValueOnce({
        kind: 'handled',
        reply: 'question',
        onSent,
      });
      await service.dispatch(event('wamid.min.arm'));
      expect(onSent).toHaveBeenCalledTimes(1);
      expect(sender.sendText.mock.invocationCallOrder[0]).toBeLessThan(
        onSent.mock.invocationCallOrder[0],
      );
      expect(onSent.mock.invocationCallOrder[0]).toBeLessThan(
        recentOutbound.remember.mock.invocationCallOrder[0],
      );
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.min.arm');
    });

    it('never arms onSent when the send fails', async () => {
      const onSent = jest.fn();
      minimalAgent.tryHandle.mockResolvedValueOnce({
        kind: 'handled',
        reply: 'question',
        onSent,
      });
      sender.sendText.mockRejectedValueOnce(new Error('Meta 131030'));
      await expect(
        service.dispatch(event('wamid.min.failsend')),
      ).rejects.toThrow('Meta 131030');
      expect(onSent).not.toHaveBeenCalled();
      expect(dedup.markSeen).not.toHaveBeenCalled();
    });

    it('a minimal-agent failure never falls back to the legacy runner', async () => {
      minimalAgent.tryHandle.mockRejectedValueOnce(new Error('minimal down'));
      await expect(service.dispatch(event('wamid.min.err'))).rejects.toThrow(
        'minimal down',
      );
      expect(llm.run).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
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
