import {
  AgentRunner,
  type AgentRunnerConfig,
} from '../../llm-agent/application/agent-runner.service';
import { CostGuardService } from '../../llm-agent/application/cost-guard.service';
import { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import { type ConversationStore } from '../../conversation/domain/conversation-store';
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
  HumanHandoffService,
} from '../../human-handoff/application/human-handoff.service';
import type { ActiveReceiptStatus } from '../../receipt-media/domain/receipt-media-store.port';
import type { ReceiptMediaRow } from '../../receipt-media/domain/receipt-media.types';
import { type ReceiptIngressService } from '../../receipt-media/application/receipt-ingress.service';
import type { ProductImageRecognitionService } from '../../product-image/application/product-image-recognition.service';
import type { ProductImageDescription } from '../../product-image/domain/product-image';

const PLACED_SALE_ID = '5b0a7c1e-3f2d-4c8a-9e61-2d4f8b7a9c10';

/** A customer whose order is placed and awaits the transfer receipt. */
const placedSaleState = (senderId: string) => ({
  senderId,
  lastMessageAt: '2026-06-23T12:00:00.000Z',
  data: {
    minimalCart: {
      items: [],
      idempotencyKey: '',
      placedSale: { saleId: PLACED_SALE_ID, folio: null, totalCents: 150_000 },
    },
  },
});

const RECEIPT_DESCRIPTION: ProductImageDescription = {
  kind: 'receipt',
  brand: null,
  productName: null,
  productType: null,
  species: null,
  size: null,
  flavorOrVariant: null,
  labelText: null,
  searchQueries: [],
  confidence: 'high',
};

const receiptMediaRowFixture = (id: string): ReceiptMediaRow =>
  ({ id }) as unknown as ReceiptMediaRow;

/** One customer text message in a Meta webhook event. */
const textEvent = (id: string, body: string): WebhookEventDto => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id,
                from: '5215550001111',
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

/**
 * Every customer turn is handled by the minimal SDK route
 * (MinimalCatalogAgentService.tryHandle) and its reply is sent via
 * WhatsappSenderPort.sendText. AgentRunner only serves the ops synthetic
 * "resolved" turn. No proactive sends.
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
  let ingress: jest.Mocked<ReceiptIngressService>;
  let minimalAgent: jest.Mocked<MinimalCatalogAgentService>;
  let productImage: { recognize: jest.Mock };

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
    };

    sender = {
      sendText: jest
        .fn<
          Promise<SendResult>,
          [Parameters<WhatsappSenderPort['sendText']>[0]]
        >()
        .mockResolvedValue({ providerMessageId: 'wamid.reply' }),
      sendTemplate: jest.fn(),
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
      claim: jest.fn().mockResolvedValue('claim-token'),
      release: jest.fn().mockResolvedValue(undefined),
      purgeBefore: jest.fn().mockResolvedValue(0),
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
    };

    // WU13-B2: ReceiptIngressService mock. Default reserved with a minimal
    // receipt fixture — the only valid closed terminal decision that carries
    // a receipt; guidance and other silent outcomes carry no receipt field.
    ingress = {
      admit: jest.fn().mockResolvedValue({
        kind: 'reserved',
        receipt: { id: 'r-default' },
      }),
    } as unknown as jest.Mocked<ReceiptIngressService>;

    // Minimal SDK route: handles every customer turn. Tests override the
    // reply per scenario.
    minimalAgent = {
      tryHandle: jest
        .fn()
        .mockResolvedValue({ kind: 'handled', reply: 'Hola' }),
    } as unknown as jest.Mocked<MinimalCatalogAgentService>;

    // S5 product image recognition: download + vision describer. Default:
    // the image is a receipt.
    productImage = {
      recognize: jest.fn().mockResolvedValue(RECEIPT_DESCRIPTION),
    };

    service = new WebhookDispatcherService(
      runner,
      sender,
      dedup,
      recentOutbound,
      humanHandoff as unknown as HumanHandoffService,
      conversationStore,
      ingress,
      minimalAgent,
      productImage as unknown as ProductImageRecognitionService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Neither the minimal customer route nor the ops AgentRunner ran a model.
  const expectNoAgentRun = () => {
    expect(llm.run).not.toHaveBeenCalled();
    expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
  };

  // ─── Scenario: Signed inbound text reaches agent dispatch ───────────
  it('routes the customer turn to the minimal agent and sends its reply', async () => {
    minimalAgent.tryHandle.mockResolvedValueOnce({
      kind: 'handled',
      reply: 'Hola, ¿en qué te puedo ayudar?',
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

    expect(minimalAgent.tryHandle).toHaveBeenCalledWith({
      senderId: '5215550001111',
      text: 'hola',
    });
    // The legacy AgentRunner never serves a customer turn.
    expect(llm.run).not.toHaveBeenCalled();
    expect(store.commitAgentTurn).not.toHaveBeenCalled();

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
    expectNoAgentRun();
  });

  // ─── Scenario: Meta re-delivers a SUCCESSFULLY processed message ──────
  // The observed production bug: a webhook re-delivery (retry) was
  // re-processed as a new message, producing unsolicited greetings.
  it('skips a duplicate delivery (dedup) — no agent run, no reply', async () => {
    dedup.claim.mockResolvedValue(null);
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

    expectNoAgentRun();
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

    expectNoAgentRun();
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  // ─── Scenario: successful processing records dedup + outbound echo ───
  it('marks the message seen and remembers the outbound wamid after success', async () => {
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
    expect(dedup.release).toHaveBeenCalledWith('wamid.failsend', 'claim-token');
  });

  // ─── S6: the claim is taken BEFORE any processing ─────────────────
  it('claims the message before the agent runs and the reply is sent', async () => {
    await service.dispatch(textEvent('wamid.claim-first', 'hola'));

    expect(dedup.claim).toHaveBeenCalledWith('wamid.claim-first');
    const claimed = dedup.claim.mock.invocationCallOrder[0];
    expect(claimed).toBeLessThan(
      minimalAgent.tryHandle.mock.invocationCallOrder[0],
    );
    expect(claimed).toBeLessThan(sender.sendText.mock.invocationCallOrder[0]);
    expect(dedup.markSeen).toHaveBeenCalledWith('wamid.claim-first');
    expect(dedup.release).not.toHaveBeenCalled();
  });

  it('a failure before any send releases the claim; the redelivery is processed', async () => {
    minimalAgent.tryHandle.mockRejectedValueOnce(new Error('LLM down'));
    await expect(
      service.dispatch(textEvent('wamid.redeliver', 'hola')),
    ).rejects.toThrow('LLM down');
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(dedup.release).toHaveBeenCalledWith(
      'wamid.redeliver',
      'claim-token',
    );

    await service.dispatch(textEvent('wamid.redeliver', 'hola'));
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(dedup.markSeen).toHaveBeenCalledWith('wamid.redeliver');
  });

  it('a failed release never masks the processing error', async () => {
    minimalAgent.tryHandle.mockRejectedValueOnce(new Error('LLM down'));
    dedup.release.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.dispatch(textEvent('wamid.release-fail', 'hola')),
    ).rejects.toThrow('LLM down');
  });

  it('a claim failure propagates before any processing (Meta redelivers)', async () => {
    dedup.claim.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.dispatch(textEvent('wamid.claim-fail', 'hola')),
    ).rejects.toThrow('db down');
    expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(dedup.release).not.toHaveBeenCalled();
  });

  // ─── Scenario: one event carries several messages, one already seen ──
  it('processes each new message and skips only the duplicate within one event', async () => {
    dedup.claim.mockImplementation(async (id: string) =>
      id === 'wamid.dup' ? null : 'claim-token',
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

    expect(minimalAgent.tryHandle).toHaveBeenCalledTimes(1);
    expect(minimalAgent.tryHandle).toHaveBeenCalledWith(
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
    const customerInput = (index = 0) =>
      minimalAgent.tryHandle.mock.calls[index][0];

    it('forwards the normalized customer identity into the agent run', async () => {
      ready();
      await service.dispatch(inbound('wamid.inbound', 'hola', PHONE_ID));
      expect(minimalAgent.tryHandle).toHaveBeenCalledWith(
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
      expect(customerInput()).not.toHaveProperty('inboundEvent');
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
      expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
    });

    it('preserves the event identity across a redelivery of the same message', async () => {
      ready();
      const event = inbound('wamid.inbound', 'hola', PHONE_ID);
      await service.dispatch(event);
      await service.dispatch(event);
      expect(minimalAgent.tryHandle).toHaveBeenCalledTimes(2);
      const [first, second] = minimalAgent.tryHandle.mock.calls.map(
        (c) => c[0].inboundEvent,
      );
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
      expectNoAgentRun();
      // The ops path short-circuits BEFORE the pending-marker read.
      expect(conversationStore.get).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.ops-nopending');
    });

    it('dedup applies to ops inbounds unchanged: a duplicate ops wamid never reaches resolveReply', async () => {
      dedup.claim.mockResolvedValue(null);
      humanHandoff.isOpsSender.mockReturnValue(true);

      await service.dispatch(
        opsEvent('wamid.ops-dup', 'HF-abc123def456 NO_RESTOCK'),
      );

      expect(dedup.claim).toHaveBeenCalledWith('wamid.ops-dup');
      expect(humanHandoff.resolveReply).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
      expect(dedup.markSeen).not.toHaveBeenCalled();
    });

    it('customer inbound with pending marker: canned reply, NO agent call, no transcript write', async () => {
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
      expectNoAgentRun(); // no agent invoked
      expect(store.update).not.toHaveBeenCalled(); // no transcript write
      expect(conversationStore.update).not.toHaveBeenCalled();
      expect(recentOutbound.remember).toHaveBeenCalledWith('wamid.reply');
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.cust-pending');
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

  // ─── R6: the receipt amount dialog is gone ─────────────────────────────────
  describe('R6: customer text always reaches the agent', () => {
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

    it.each(['500 pesos', 'CONFIRMAR', 'cancelar', 'sí'])(
      'R6: %s goes straight to the minimal agent (no amount dialog)',
      async (body) => {
        minimalAgent.tryHandle.mockResolvedValueOnce({
          kind: 'handled',
          reply: 'Hola!',
        });
        await service.dispatch(textEvent(`wamid.r6.${body}`, body));
        expect(minimalAgent.tryHandle).toHaveBeenCalledWith(
          expect.objectContaining({ senderId: CUSTOMER, text: body }),
        );
        expect(llm.run).not.toHaveBeenCalled();
        expect(sender.sendText).toHaveBeenCalledTimes(1);
        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: 'Hola!',
        });
      },
    );

    it('ops inbound: handled before any customer routing', async () => {
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
      expectNoAgentRun();
      expect(sender.sendText).toHaveBeenCalled();
    });

    it('pending-human short-circuit: no agent run', async () => {
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
      expectNoAgentRun();
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: PENDING_HUMAN_REQUEST_REPLY,
      });
    });

    it('media message with a placed sale: never reaches the agent (media ingress is WU13-B2)', async () => {
      conversationStore.get.mockResolvedValue(placedSaleState(CUSTOMER));
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
      expectNoAgentRun();
    });

    // ─── WU13-B2: ReceiptIngressService customer media routing ─────────────────
    describe('WU13-B2: ReceiptIngressService customer media routing', () => {
      // Images reach the receipt path only while an order awaits payment.
      beforeEach(() => {
        conversationStore.get.mockResolvedValue(placedSaleState(CUSTOMER));
      });

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
        expectNoAgentRun();
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
        expectNoAgentRun();
      });

      // Guidance: customer sees guidance text, no agent, dedup marked
      const guidanceCases: Array<{
        decision: { kind: string; text: string; status?: ActiveReceiptStatus };
        expected: string;
      }> = [
        {
          decision: {
            kind: 'unsupported-media',
            text: 'Envíenos su comprobante como imagen JPEG o PNG, o como PDF, de menos de 10 MB.',
          },
          expected:
            'Envíenos su comprobante como imagen JPEG o PNG, o como PDF, de menos de 10 MB.',
        },
        {
          // D6: customer copy, never the operator instruction.
          decision: {
            kind: 'no-placed-sale',
            text: 'Recibí su comprobante. Para registrarlo primero necesitamos confirmar su pedido. ¿Qué producto desea?',
          },
          expected:
            'Recibí su comprobante. Para registrarlo primero necesitamos confirmar su pedido. ¿Qué producto desea?',
        },
        {
          decision: {
            kind: 'sender-active',
            status: 'DOWNLOADED',
            text: 'Estamos procesando su comprobante.',
          },
          expected: 'Estamos procesando su comprobante.',
        },
      ];

      test.each(guidanceCases)(
        '%s: sends guidance and marks seen',
        async (c) => {
          (ingress.admit as jest.Mock).mockResolvedValueOnce(c.decision);
          await service.dispatch(
            mediaEvent(
              `wamid.${c.decision.kind}`,
              c.decision.kind === 'unsupported-media' ||
                c.decision.kind === 'no-placed-sale'
                ? 'document'
                : 'image',
            ),
          );
          expect(sender.sendText).toHaveBeenCalledWith({
            to: CUSTOMER,
            text: c.expected,
          });
          expectNoAgentRun();
          expect(dedup.markSeen).toHaveBeenCalledTimes(1);
        },
      );

      // ── ODD-4C: active-image guidance text by durable status ──────────
      const activeGuidanceCases: Array<{
        status: ActiveReceiptStatus;
        text: string;
      }> = [
        { status: 'RESERVED', text: 'Estamos procesando su comprobante.' },
        { status: 'DOWNLOADED', text: 'Estamos procesando su comprobante.' },
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
          expectNoAgentRun();
        },
      );

      // Atomic outcomes: no send, no agent. Their admission transaction
      // persists the marker, but the dispatcher's claim already holds the
      // row (PROCESSING), so S6 completes it once admission committed.
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
        '$decision.kind: no sendText, no LLM, completes the claim',
        async (c) => {
          const decision = c.decision.receiptId
            ? { kind: c.decision.kind, receipt: { id: c.decision.receiptId } }
            : { kind: c.decision.kind };
          (ingress.admit as jest.Mock).mockResolvedValueOnce(decision);
          await service.dispatch(mediaEvent(c.wamid, 'image'));
          expect(sender.sendText).not.toHaveBeenCalled();
          expectNoAgentRun();
          expect(dedup.markSeen).toHaveBeenCalledTimes(1);
          expect(dedup.markSeen).toHaveBeenCalledWith(c.wamid);
          expect(dedup.release).not.toHaveBeenCalled();
        },
      );

      // Error: admit rejection propagates; no send, no markSeen, and the
      // claim is released so Meta's redelivery is processed again (S6).
      it('admit rejection: propagates, no sendText, no markSeen', async () => {
        (ingress.admit as jest.Mock).mockRejectedValueOnce(
          new Error('admission unavailable'),
        );
        await expect(
          service.dispatch(mediaEvent('wamid.fail', 'image')),
        ).rejects.toThrow('admission unavailable');
        expect(sender.sendText).not.toHaveBeenCalled();
        expect(dedup.markSeen).not.toHaveBeenCalled();
        expect(dedup.release).toHaveBeenCalledWith('wamid.fail', 'claim-token');
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
        dedup.claim.mockResolvedValueOnce(null);

        await service.dispatch(mediaEvent('wamid.marker-only', 'image'));

        expect(ingress.admit).not.toHaveBeenCalled();
        expect(sender.sendText).not.toHaveBeenCalled();
        expectNoAgentRun();
        expect(dedup.markSeen).not.toHaveBeenCalled();
      });

      it('orders guidance collaborators and remembers the outbound id', async () => {
        ingress.admit.mockResolvedValueOnce({ kind: 'unsupported-media' });
        sender.sendText.mockResolvedValueOnce({
          providerMessageId: 'wamid.out',
        });

        await service.dispatch(mediaEvent('wamid.guidance-order', 'image'));

        const order = [
          dedup.claim,
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
        { kind: 'unsupported-media' } as const,
        { kind: 'no-placed-sale' } as const,
        { kind: 'sender-active', status: 'DOWNLOADED' } as const,
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
          expectNoAgentRun();
        },
      );

      it('does not remember or mark seen when guidance delivery fails', async () => {
        ingress.admit.mockResolvedValueOnce({ kind: 'unsupported-media' });
        sender.sendText.mockRejectedValueOnce(new Error('Meta 131030'));

        await expect(
          service.dispatch(mediaEvent('wamid.guidance-fail', 'image')),
        ).rejects.toThrow('Meta 131030');
        expect(recentOutbound.remember as jest.Mock).not.toHaveBeenCalled();
        expect(dedup.markSeen as jest.Mock).not.toHaveBeenCalled();
        expectNoAgentRun();
      });
    });
  });

  // ─── S5: product image recognition routing ──────────────────────────────
  describe('S5: product image routing', () => {
    const CUSTOMER = '5215550001111';
    const PRODUCT: ProductImageDescription = {
      kind: 'product',
      brand: 'Nupec',
      productName: null,
      productType: 'croquetas',
      species: 'perro',
      size: '18 kg',
      flavorOrVariant: 'salmón',
      labelText: null,
      searchQueries: ['Nupec salmón 18 kg', 'croquetas Nupec'],
      confidence: 'high',
    };
    const LABEL_REQUEST =
      'No alcanzo a identificar el producto en la imagen. ¿Me puede enviar una foto más clara de la etiqueta o decirme el nombre del producto?';
    const NAME_REQUEST =
      'Recibí su imagen, pero no pude revisarla en este momento. ¿Me puede decir el nombre del producto que busca?';
    const RECEIPT_WITHOUT_ORDER =
      'Recibí su imagen, parece un comprobante de pago. Para registrarlo primero necesitamos confirmar su pedido. ¿Qué producto desea?';

    const mediaEvent = (
      messageId: string,
      media:
        | { type: 'image'; caption?: string; mime?: string }
        | { type: 'document' },
    ): WebhookEventDto => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PNID-1' },
                messages: [
                  {
                    id: messageId,
                    from: CUSTOMER,
                    timestamp: '1719000000',
                    type: media.type,
                    ...(media.type === 'image'
                      ? {
                          image: {
                            id: 'media-p1',
                            mime_type: media.mime ?? 'image/jpeg',
                            ...(media.caption === undefined
                              ? {}
                              : { caption: media.caption }),
                          },
                        }
                      : {
                          document: {
                            id: 'media-p1',
                            mime_type: 'application/pdf',
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

    const agentText = (): string => {
      const [input] = minimalAgent.tryHandle.mock.calls[0];
      return input.text;
    };

    it('no placed sale + product photo: agent turn with the synthetic description, never receipts', async () => {
      productImage.recognize.mockResolvedValueOnce(PRODUCT);
      minimalAgent.tryHandle.mockResolvedValueOnce({
        kind: 'handled',
        reply: 'Sí, tenemos Nupec salmón 18 kg.',
      } as never);

      await service.dispatch(
        mediaEvent('wamid.p1', {
          type: 'image',
          caption: '¿Tienen este producto??',
        }),
      );

      expect(productImage.recognize).toHaveBeenCalledWith({
        providerMediaId: 'media-p1',
        declaredMimeType: 'image/jpeg',
      });
      expect(ingress.admit).not.toHaveBeenCalled();
      expect(minimalAgent.tryHandle).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: CUSTOMER,
          inboundEvent: {
            receivingPhoneNumberId: 'PNID-1',
            senderId: CUSTOMER,
            messageId: 'wamid.p1',
          },
        }),
      );
      const text = agentText();
      expect(text.startsWith('¿Tienen este producto??\n[Imagen enviada')).toBe(
        true,
      );
      expect(text).toContain('marca Nupec');
      expect(text).toContain('"Nupec salmón 18 kg"');
      expect(text).toContain('productos similares reales del catálogo');
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: 'Sí, tenemos Nupec salmón 18 kg.',
      });
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.p1');
    });

    it('no caption: defaults the customer text to "¿Tienen este producto?"', async () => {
      productImage.recognize.mockResolvedValueOnce(PRODUCT);

      await service.dispatch(mediaEvent('wamid.p2', { type: 'image' }));

      expect(agentText().startsWith('¿Tienen este producto?\n[')).toBe(true);
    });

    it('placed sale + product question caption: product path, not receipts', async () => {
      conversationStore.get.mockResolvedValue(placedSaleState(CUSTOMER));
      productImage.recognize.mockResolvedValueOnce(PRODUCT);

      await service.dispatch(
        mediaEvent('wamid.p3', { type: 'image', caption: '¿hay de este?' }),
      );

      expect(productImage.recognize).toHaveBeenCalledTimes(1);
      expect(ingress.admit).not.toHaveBeenCalled();
      expect(minimalAgent.tryHandle).toHaveBeenCalledTimes(1);
    });

    it('placed sale + product question but the image is a receipt: receipt path', async () => {
      conversationStore.get.mockResolvedValue(placedSaleState(CUSTOMER));
      productImage.recognize.mockResolvedValueOnce(RECEIPT_DESCRIPTION);

      await service.dispatch(
        mediaEvent('wamid.p4', { type: 'image', caption: '¿lo tienen?' }),
      );

      expect(ingress.admit).toHaveBeenCalledWith(
        expect.objectContaining({ webhookMessageId: 'wamid.p4' }),
      );
      expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
    });

    it('placed sale + no caption: receipt path unchanged, no vision call', async () => {
      conversationStore.get.mockResolvedValue(placedSaleState(CUSTOMER));

      await service.dispatch(mediaEvent('wamid.p5', { type: 'image' }));

      expect(productImage.recognize).not.toHaveBeenCalled();
      expect(ingress.admit).toHaveBeenCalledTimes(1);
      expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
    });

    it('PDF document: receipt path unchanged, no vision call', async () => {
      await service.dispatch(mediaEvent('wamid.p6', { type: 'document' }));

      expect(productImage.recognize).not.toHaveBeenCalled();
      expect(ingress.admit).toHaveBeenCalledWith(
        expect.objectContaining({ declaredMimeType: 'application/pdf' }),
      );
    });

    it('no placed sale + receipt-looking image: receipt-without-order reply, never the operator copy', async () => {
      productImage.recognize.mockResolvedValueOnce(RECEIPT_DESCRIPTION);

      await service.dispatch(mediaEvent('wamid.p7', { type: 'image' }));

      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: RECEIPT_WITHOUT_ORDER,
      });
      expect(sender.sendText).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Primero registra la venta en el sistema.',
        }),
      );
      expect(ingress.admit).not.toHaveBeenCalled();
      expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.p7');
    });

    test.each([
      ['unclear', { ...PRODUCT, kind: 'unclear' as const }],
      ['other', { ...PRODUCT, kind: 'other' as const }],
      [
        'low confidence without brand or name',
        {
          ...PRODUCT,
          brand: null,
          productName: null,
          confidence: 'low' as const,
        },
      ],
    ])('%s: asks for a label photo or the product name', async (_l, desc) => {
      productImage.recognize.mockResolvedValueOnce(desc);

      await service.dispatch(mediaEvent('wamid.p8', { type: 'image' }));

      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: LABEL_REQUEST,
      });
      expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
      expect(ingress.admit).not.toHaveBeenCalled();
    });

    test.each([
      ['timeout', { kind: 'unavailable', reason: 'timeout' }],
      ['error', { kind: 'unavailable', reason: 'error' }],
      ['unsupported', { kind: 'unavailable', reason: 'unsupported' }],
    ])('describer %s: asks for the product name', async (_l, result) => {
      productImage.recognize.mockResolvedValueOnce(result);

      await service.dispatch(mediaEvent('wamid.p9', { type: 'image' }));

      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: NAME_REQUEST,
      });
      expect(ingress.admit).not.toHaveBeenCalled();
      expect(minimalAgent.tryHandle).not.toHaveBeenCalled();
      expect(dedup.markSeen).toHaveBeenCalledWith('wamid.p9');
    });

    it('describer throwing unexpectedly: still asks for the product name', async () => {
      productImage.recognize.mockRejectedValueOnce(new Error('boom'));

      await service.dispatch(mediaEvent('wamid.p10', { type: 'image' }));

      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: NAME_REQUEST,
      });
    });

    describe('customer style (S2)', () => {
      const TU = { register: 'tu', emojis: false, tone: 'casual' } as const;
      beforeEach(() => {
        (
          minimalAgent as unknown as { customerStyle: jest.Mock }
        ).customerStyle = jest.fn().mockReturnValue(TU);
      });

      it('answers an unclear product photo in tú for a customer who tutea', async () => {
        productImage.recognize.mockResolvedValueOnce({
          ...PRODUCT,
          kind: 'unclear',
        });

        await service.dispatch(
          mediaEvent('wamid.s1', { type: 'image', caption: '¿tienes este?' }),
        );

        expect(
          (minimalAgent as unknown as { customerStyle: jest.Mock })
            .customerStyle,
        ).toHaveBeenCalledWith(CUSTOMER, '¿tienes este?');
        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: 'No alcanzo a identificar el producto en la imagen. ¿Me puedes enviar una foto más clara de la etiqueta o decirme el nombre del producto?',
        });
      });

      it('answers a receipt without order and an unavailable describer in tú', async () => {
        productImage.recognize.mockResolvedValueOnce(RECEIPT_DESCRIPTION);
        await service.dispatch(mediaEvent('wamid.s2', { type: 'image' }));
        productImage.recognize.mockResolvedValueOnce({
          kind: 'unavailable',
          reason: 'error',
        });
        await service.dispatch(mediaEvent('wamid.s3', { type: 'image' }));

        expect(sender.sendText).toHaveBeenNthCalledWith(1, {
          to: CUSTOMER,
          text: 'Recibí tu imagen, parece un comprobante de pago. Para registrarlo primero necesitamos confirmar tu pedido. ¿Qué producto quieres?',
        });
        expect(sender.sendText).toHaveBeenNthCalledWith(2, {
          to: CUSTOMER,
          text: 'Recibí tu imagen, pero no pude revisarla en este momento. ¿Me puedes decir el nombre del producto que buscas?',
        });
      });

      it('answers receipt ingress guidance in tú', async () => {
        ingress.admit.mockResolvedValueOnce({
          kind: 'no-placed-sale',
        } as never);
        await service.dispatch(mediaEvent('wamid.s4', { type: 'document' }));

        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: 'Recibí tu comprobante. Para registrarlo primero necesitamos confirmar tu pedido. ¿Qué producto quieres?',
        });
      });

      it('sends the pending-human reply in tú', async () => {
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
        await service.dispatch(mediaEvent('wamid.s5', { type: 'document' }));

        expect(sender.sendText).toHaveBeenCalledWith({
          to: CUSTOMER,
          text: 'Seguimos esperando la respuesta del equipo; te avisamos por aquí en cuanto la tengamos.',
        });
      });
    });

    it('duplicate image message: no vision call, no reply', async () => {
      dedup.claim.mockResolvedValueOnce(null);

      await service.dispatch(mediaEvent('wamid.p11', { type: 'image' }));

      expect(productImage.recognize).not.toHaveBeenCalled();
      expect(sender.sendText).not.toHaveBeenCalled();
    });
  });

  // ─── Minimal SDK catalog route (every customer turn) ────────────────────
  describe('minimal SDK catalog route', () => {
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

    it('routes every customer to the minimal agent, never the legacy runner', async () => {
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
      expect(sender.sendText).toHaveBeenCalledWith({
        to: CUSTOMER,
        text: 'SDK reply',
      });

      // A sender that was never on any allowlist takes the same route.
      const stranger = event('wamid.min.stranger');
      stranger.entry![0].changes![0].value!.messages![0].from = '5215559998888';
      minimalAgent.tryHandle.mockResolvedValueOnce({
        kind: 'handled',
        reply: 'SDK reply 2',
      });
      await service.dispatch(stranger);
      expect(minimalAgent.tryHandle).toHaveBeenCalledTimes(2);
      expect(minimalAgent.tryHandle).toHaveBeenLastCalledWith(
        expect.objectContaining({ senderId: '5215559998888' }),
      );
      expect(sender.sendText).toHaveBeenLastCalledWith({
        to: '5215559998888',
        text: 'SDK reply 2',
      });
      expect(llm.run).not.toHaveBeenCalled();
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
