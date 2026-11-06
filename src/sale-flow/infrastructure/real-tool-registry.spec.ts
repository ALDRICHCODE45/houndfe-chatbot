import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { RESTOCK_INTAKE_SERVICE } from '../../human-decisions/application/restock-intake.service';
import { RESTOCK_EXISTING_REQUEST_STATUS_SERVICE } from '../../human-decisions/application/restock-existing-request-status.service';
import { SHARED_ROUTE_MARKERS } from '../../human-decisions/domain/shared-route-markers';
import { CONVERSATION_STORE } from '../../conversation/domain/conversation-store';
import {
  HUMAN_HANDOFF_SERVICE_TOKEN,
  RealToolRegistry,
} from './real-tool-registry';

/**
 * Capture the deps object the registry hands to a factory, so the spec can
 * prove the optional `restock` capability is omitted or populated WITHOUT any
 * tool branching on it. One factory suffices: all eleven share one `deps`.
 */
const mockCapturedDeps: Record<string, unknown>[] = [];
jest.mock('../application/tools/check-stock.tool', () => ({
  makeCheckStockTool: (deps: Record<string, unknown>) => {
    mockCapturedDeps.push(deps);
    return { description: 'checkStock', inputSchema: {}, execute: () => {} };
  },
}));

/**
 * Integration tests for RealToolRegistry wiring.
 *
 * Spec scenarios:
 *   - getTools() returns exactly the 11 keys by default (searchCatalog,
 *     checkStock, evaluateCart, getCustomerByPhone, upsertCustomer,
 *     createSale, updateDelivery, getOrderHistory,
 *     getPaymentDetails, cancelSale, requestHumanAssistance); no
 *     shipping-quote tool (carrier quoting is backend-owned).
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
  const stubMarkers = { readForSender: jest.fn() };
  const stubCoordinator = { coordinate: jest.fn() };
  const stubRecovery = { recover: jest.fn() };

  type StoreStub = { get: jest.Mock; create: jest.Mock; update: jest.Mock };
  type ServiceStub = {
    create: jest.Mock;
    resolveReply: jest.Mock;
    isOpsSender: jest.Mock;
  };
  interface RegistryExtras {
    store?: StoreStub;
    humanHandoffService?: ServiceStub;
  }

  async function buildRegistry(
    extras: RegistryExtras = {},
  ): Promise<RealToolRegistry> {
    const providers: Provider[] = [
      RealToolRegistry,
      { provide: SHARED_ROUTE_MARKERS, useValue: stubMarkers },
      { provide: RESTOCK_INTAKE_SERVICE, useValue: stubCoordinator },
      {
        provide: RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
        useValue: stubRecovery,
      },
      { provide: CHATBOT_API_CLIENT, useValue: stubChatbotApi },
      { provide: CONVERSATION_STORE, useValue: extras.store ?? stubStore },
      {
        provide: HUMAN_HANDOFF_SERVICE_TOKEN,
        useValue: extras.humanHandoffService ?? stubHumanHandoffService,
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
    const moduleRef = await Test.createTestingModule({ providers }).compile();
    return moduleRef.get(RealToolRegistry);
  }

  const lastDeps = () => mockCapturedDeps[mockCapturedDeps.length - 1];
  it('resolves through Nest DI with CHATBOT_API_CLIENT + CONVERSATION_STORE + HUMAN_HANDOFF_SERVICE_TOKEN + ConfigService', async () => {
    const registry = await buildRegistry();
    expect(registry).toBeInstanceOf(RealToolRegistry);
  });

  it('getTools() returns exactly the 11 sale-flow tool keys including getPaymentDetails, cancelSale, and requestHumanAssistance', async () => {
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

  it('always populates the restock capability, and stays inert', async () => {
    mockCapturedDeps.length = 0;
    const registry = await buildRegistry();
    expect(Object.keys(registry.getTools())).toHaveLength(11);
    expect(lastDeps().restock).toEqual({
      markers: stubMarkers,
      coordinator: stubCoordinator,
      recovery: stubRecovery,
    });
    expect(stubMarkers.readForSender).not.toHaveBeenCalled();
    expect(stubCoordinator.coordinate).not.toHaveBeenCalled();
    expect(stubRecovery.recover).not.toHaveBeenCalled();
  });
});
