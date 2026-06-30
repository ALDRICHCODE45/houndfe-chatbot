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
import {
  type ToolRegistry,
} from '../../llm-agent/domain/tool-registry.port';
import { SendResult, WhatsappSenderPort } from '../domain/whatsapp-sender.port';
import { WebhookEventDto } from '../presentation/dto/webhook-event.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Spec rewrite: the dispatcher MUST replace the echo path with
 * AgentRunner.handle(). After each run, both the user and the
 * assistant turns MUST be persisted via ConversationStore.update
 * (UPSERT), and the assistant reply MUST be sent via
 * WhatsappSenderPort.sendText. No proactive sends.
 */
describe('WebhookDispatcherService (agent dispatch path)', () => {
  let store: jest.Mocked<ConversationStore>;
  let sender: jest.Mocked<WhatsappSenderPort>;
  let llm: jest.Mocked<LlmAgentPort>;
  let tools: jest.Mocked<ToolRegistry>;
  let costGuard: CostGuardService;
  let runner: AgentRunner;
  let service: WebhookDispatcherService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-23T12:00:00.000Z'));

    store = {
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<ConversationStore>;

    sender = {
      sendText: jest
        .fn<Promise<SendResult>, [Parameters<WhatsappSenderPort['sendText']>[0]]>()
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
    runner = AgentRunner.forTest(
      store as unknown as ConversationStore,
      llm as unknown as LlmAgentPort,
      tools as unknown as ToolRegistry,
      costGuard,
      cfg,
    );

    service = new WebhookDispatcherService(runner, sender);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── Scenario: Signed inbound text reaches agent dispatch ───────────
  it('invokes the agent, persists the assistant turn, and sends the reply', async () => {
    store.get.mockResolvedValue(null);
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
    } as LlmRunResult);

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
    } as LlmRunResult);

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
});