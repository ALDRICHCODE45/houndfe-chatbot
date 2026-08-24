import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
import { BANK_DETAILS_PROVIDER } from '../domain/bank-details.provider';
import { RealToolRegistry } from './real-tool-registry';

/**
 * Integration tests for RealToolRegistry wiring.
 *
 * Spec scenarios:
 *   - getTools() returns exactly the 9 keys (searchCatalog, checkStock,
 *     evaluateCart, getCustomerByPhone, upsertCustomer, createSale,
 *     attachReceipt, updateDelivery, getOrderHistory).
 *   - Each entry is an AI-SDK tool with a Zod object inputSchema.
 *   - DI resolves RealToolRegistry with the injected deps.
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
  };
  const stubStore = {
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const stubBankDetails = { get: jest.fn().mockResolvedValue(null) };

  async function buildRegistry(): Promise<RealToolRegistry> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RealToolRegistry,
        { provide: CHATBOT_API_CLIENT, useValue: stubChatbotApi },
        { provide: CONVERSATION_STORE, useValue: stubStore },
        { provide: BANK_DETAILS_PROVIDER, useValue: stubBankDetails },
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

  it('resolves through Nest DI with CHATBOT_API_CLIENT + CONVERSATION_STORE + BANK_DETAILS_PROVIDER', async () => {
    const registry = await buildRegistry();
    expect(registry).toBeInstanceOf(RealToolRegistry);
  });

  it('getTools() returns exactly the 9 sale-flow tool keys', async () => {
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
