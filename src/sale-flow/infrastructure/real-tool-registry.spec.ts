import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';
import { TERMINAL_RECEIPT_GUIDANCE } from '../application/tools/attach-receipt.tool';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
import { ShippingQuoteOrchestrator } from '../../shipping/application/shipping-quote-orchestrator';
import {
  HUMAN_HANDOFF_SERVICE_TOKEN,
  RealToolRegistry,
} from './real-tool-registry';

/**
 * Integration tests for RealToolRegistry wiring.
 *
 * Spec scenarios:
 *   - getTools() returns exactly the 12 keys (searchCatalog, checkStock,
 *     evaluateCart, getCustomerByPhone, upsertCustomer, createSale,
 *     attachReceipt, updateDelivery, getOrderHistory, getPaymentDetails,
 *     cancelSale, requestHumanAssistance).
 *   - Each entry is an AI-SDK tool with a Zod object inputSchema.
 *   - DI resolves RealToolRegistry with CHATBOT_API_CLIENT +
 *     CONVERSATION_STORE + HUMAN_HANDOFF_SERVICE_TOKEN + ConfigService.
 *   - attachReceipt is wired WITHOUT the backend-attachment dependency
 *     (zero chatbotApi.attachReceipt calls; the server-owned
 *     ReceiptAttachmentService stays the sole §4.4.7 attachment path).
 */

describe('RealToolRegistry', () => {
  const stubChatbotApi = {
    searchCatalog: jest.fn(),
    getStock: jest.fn(),
    evaluateCart: jest.fn(),
    getCustomerByPhone: jest.fn(),
    upsertCustomer: jest.fn(),
    createSale: jest.fn(),
    attachReceipt: jest.fn(),
    updateDelivery: jest.fn(),
    getOrderHistory: jest.fn(),
    getPaymentDetails: jest.fn(),
    cancelSale: jest.fn(),
  };
  const stubStore = {
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const stubHumanHandoffService = {
    create: jest.fn(),
    resolveReply: jest.fn(),
    isOpsSender: jest.fn(),
  };

  async function buildRegistry(
    orchestrator?: ShippingQuoteOrchestrator,
  ): Promise<RealToolRegistry> {
    const providers: Provider[] = [
      RealToolRegistry,
      { provide: CHATBOT_API_CLIENT, useValue: stubChatbotApi },
      { provide: CONVERSATION_STORE, useValue: stubStore },
      {
        provide: HUMAN_HANDOFF_SERVICE_TOKEN,
        useValue: stubHumanHandoffService,
      },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => {
            if (key === 'chatbotApi.cashierUserId') {
              return '00000000-4000-9000-0000-000000000001';
            }
            return undefined;
          },
        },
      },
    ];
    if (orchestrator !== undefined) {
      providers.push({
        provide: ShippingQuoteOrchestrator,
        useValue: orchestrator,
      });
    }
    const moduleRef = await Test.createTestingModule({ providers }).compile();
    return moduleRef.get(RealToolRegistry);
  }

  const orchestratorOf = (registry: RealToolRegistry): unknown =>
    (registry as unknown as { shippingQuoteOrchestrator: unknown })
      .shippingQuoteOrchestrator;

  it('resolves through Nest DI with CHATBOT_API_CLIENT + CONVERSATION_STORE + HUMAN_HANDOFF_SERVICE_TOKEN + ConfigService', async () => {
    const registry = await buildRegistry();
    expect(registry).toBeInstanceOf(RealToolRegistry);
  });

  it('getTools() returns exactly the 12 sale-flow tool keys including getPaymentDetails, cancelSale, and requestHumanAssistance', async () => {
    const registry = await buildRegistry();
    const tools = registry.getTools();
    expect(Object.keys(tools).sort()).toEqual(
      [
        'searchCatalog',
        'checkStock',
        'evaluateCart',
        'getCustomerByPhone',
        'upsertCustomer',
        'createSale',
        'attachReceipt',
        'updateDelivery',
        'getOrderHistory',
        'getPaymentDetails',
        'cancelSale',
        'requestHumanAssistance',
      ].sort(),
    );
  });

  it('each entry is an AI-SDK tool with description + Zod inputSchema + execute', async () => {
    const registry = await buildRegistry();
    const tools = registry.getTools() as Record<
      string,
      { description?: string; inputSchema?: unknown; execute?: unknown }
    >;
    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.description).toBe('string');
      expect(t.description!.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.execute).toBe('function');
      expect(name).toMatch(/^[a-zA-Z]+$/);
    }
  });

  it('builds the ToolSet once in the constructor (subsequent getTools() returns the same reference)', async () => {
    const registry = await buildRegistry();
    const a = registry.getTools();
    const b = registry.getTools();
    expect(a).toBe(b);
  });

  it('stores an omitted shipping orchestrator as null without changing the 12 keys', async () => {
    const registry = await buildRegistry();
    expect(orchestratorOf(registry)).toBeNull();
    expect(Object.keys(registry.getTools())).toHaveLength(12);
  });

  it('stores an injected shipping orchestrator without changing the 12 keys', async () => {
    const orchestrator = new ShippingQuoteOrchestrator({ quote: jest.fn() });
    const registry = await buildRegistry(orchestrator);
    expect(orchestratorOf(registry)).toBe(orchestrator);
    expect(Object.keys(registry.getTools())).toHaveLength(12);
  });

  describe('attachReceipt compatibility wiring (WU12)', () => {
    type AttachTool = {
      inputSchema: {
        parse: (data: unknown) => unknown;
        safeParse: (data: unknown) => { success: boolean };
      };
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };

    const EXECUTE_OPTIONS = {
      toolCallId: 't',
      messages: [],
      context: undefined,
    } as unknown as Record<string, unknown>;

    async function getAttachTool(): Promise<AttachTool> {
      const registry = await buildRegistry();
      return registry.getTools()['attachReceipt'] as AttachTool;
    }

    it('strict {} input succeeds with the exact terminal guidance result and makes zero chatbotApi.attachReceipt calls', async () => {
      stubChatbotApi.attachReceipt.mockClear();
      stubStore.get.mockClear();
      const tool = await getAttachTool();
      const parsed = tool.inputSchema.parse({});
      expect(parsed).toEqual({});
      await expect(tool.execute(parsed, EXECUTE_OPTIONS)).resolves.toEqual(
        // Canonical terminal guidance contract (mirrors the tracked
        // canonical spec): exact machine shape + exact English wording,
        // asserted against the canonical constant in the tool unit spec.
        TERMINAL_RECEIPT_GUIDANCE,
      );
      expect(stubChatbotApi.attachReceipt).not.toHaveBeenCalled();
      expect(stubStore.get).not.toHaveBeenCalled();
    });

    it('rejects a sale-B payload at input validation (rejected, not stripped)', async () => {
      const tool = await getAttachTool();
      const result = tool.inputSchema.safeParse({
        saleId: '00000000-0000-4000-8000-000000000002',
        mediaUrl: 'https://example.com/receipt-b.jpg',
        declaredAmountCents: 1,
      });
      expect(result.success).toBe(false);
      expect(stubChatbotApi.attachReceipt).not.toHaveBeenCalled();
    });
  });
});
