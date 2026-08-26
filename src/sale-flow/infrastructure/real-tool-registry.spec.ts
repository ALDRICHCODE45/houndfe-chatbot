import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
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

  async function buildRegistry(): Promise<RealToolRegistry> {
    const moduleRef = await Test.createTestingModule({
      providers: [
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
      ],
    }).compile();
    return moduleRef.get(RealToolRegistry);
  }

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
});
