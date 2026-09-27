import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';
import { TERMINAL_RECEIPT_GUIDANCE } from '../application/tools/attach-receipt.tool';
import { CHATBOT_API_CLIENT } from '../../chatbot-api/domain/chatbot-api.client';
import { RESTOCK_INTAKE_SERVICE } from '../../human-decisions/application/restock-intake.service';
import { RESTOCK_EXISTING_REQUEST_STATUS_SERVICE } from '../../human-decisions/application/restock-existing-request-status.service';
import { SHARED_ROUTE_MARKERS } from '../../human-decisions/domain/shared-route-markers';
import {
  CONVERSATION_STORE,
  type ConversationState,
} from '../../conversation/domain/conversation-store';
import {
  HUMAN_HANDOFF_STORE,
  type HumanHandoffStore,
} from '../../human-handoff/domain/human-handoff-store.port';
import type { HumanHandoffRequest } from '../../human-handoff/domain/human-handoff.types';
import { ShippingQuoteOrchestrator } from '../../shipping/application/shipping-quote-orchestrator';
import {
  MEASURED_DEMO_SHIPPING_CONFIG,
  type MeasuredDemoShippingConfig,
} from '../../shipping/application/measured-demo-shipping-config';
import {
  buildShippingQuoteDraftRecord,
  SHIPPING_QUOTE_DRAFT_KEY,
} from '../../shipping/application/shipping-quote-draft-record';
import {
  buildShippingQuoteDraftContext,
  SHIPPING_QUOTE_DRAFT_CONTEXT_KEY,
} from '../../shipping/application/shipping-quote-draft-context';
import type { ShippingQuoteDraft } from '../../shipping/application/shipping-quote-draft';
import {
  HUMAN_HANDOFF_SERVICE_TOKEN,
  RealToolRegistry,
} from './real-tool-registry';

/**
 * Capture the deps object the registry hands to a factory, so the spec can
 * prove the optional `restock` capability is omitted or populated WITHOUT any
 * tool branching on it. One factory suffices: all twelve share one `deps`.
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
 *   - getTools() returns exactly the 12 keys by default (searchCatalog,
 *     checkStock, evaluateCart, getCustomerByPhone, upsertCustomer,
 *     createSale, attachReceipt, updateDelivery, getOrderHistory,
 *     getPaymentDetails, cancelSale, requestHumanAssistance) and a 13th
 *     `getShippingQuote` ONLY when both the shipping orchestrator and the
 *     measured demo config are injected.
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
  const stubMarkers = { readForSender: jest.fn() };
  const stubCoordinator = { coordinate: jest.fn() };
  const stubRecovery = { recover: jest.fn() };

  // DI wiring stub: the shipping tool core has its own tests; here we only
  // assert registration gating, never execution.
  const stubMeasuredDemoConfig = Object.freeze(
    {},
  ) as unknown as MeasuredDemoShippingConfig;

  type StoreStub = { get: jest.Mock; create: jest.Mock; update: jest.Mock };
  type ServiceStub = {
    create: jest.Mock;
    resolveReply: jest.Mock;
    isOpsSender: jest.Mock;
  };
  interface RegistryExtras {
    store?: StoreStub;
    humanHandoffService?: ServiceStub;
    humanHandoffStore?: HumanHandoffStore;
    restockEnabled?: boolean;
  }

  async function buildRegistry(
    orchestrator?: ShippingQuoteOrchestrator,
    measuredDemoConfig?: MeasuredDemoShippingConfig,
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
            if (key === 'humanDecisions.restockEnabled') {
              return extras.restockEnabled;
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
    if (measuredDemoConfig !== undefined) {
      providers.push({
        provide: MEASURED_DEMO_SHIPPING_CONFIG,
        useValue: measuredDemoConfig,
      });
    }
    if (extras.humanHandoffStore !== undefined) {
      providers.push({
        provide: HUMAN_HANDOFF_STORE,
        useValue: extras.humanHandoffStore,
      });
    }
    const moduleRef = await Test.createTestingModule({ providers }).compile();
    return moduleRef.get(RealToolRegistry);
  }

  const lastDeps = () => mockCapturedDeps[mockCapturedDeps.length - 1];
  const orchestratorOf = (registry: RealToolRegistry): unknown =>
    (registry as unknown as { shippingQuoteOrchestrator: unknown })
      .shippingQuoteOrchestrator;

  const measuredDemoConfigOf = (registry: RealToolRegistry): unknown =>
    (registry as unknown as { measuredDemoShippingConfig: unknown })
      .measuredDemoShippingConfig;

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

  it('omits the restock capability entirely when the gate is absent or false', async () => {
    for (const flag of [undefined, false]) {
      mockCapturedDeps.length = 0;
      const registry = await buildRegistry(undefined, undefined, {
        restockEnabled: flag,
      });
      expect(Object.keys(registry.getTools())).toHaveLength(12);
      expect('restock' in lastDeps()).toBe(false);
    }
    expect(stubMarkers.readForSender).not.toHaveBeenCalled();
    expect(stubCoordinator.coordinate).not.toHaveBeenCalled();
    expect(stubRecovery.recover).not.toHaveBeenCalled();
  });

  it('populates the restock capability only when the gate is exactly true, and stays inert', async () => {
    mockCapturedDeps.length = 0;
    const registry = await buildRegistry(undefined, undefined, {
      restockEnabled: true,
    });
    expect(Object.keys(registry.getTools())).toHaveLength(12);
    expect(lastDeps().restock).toEqual({
      enabled: true,
      markers: stubMarkers,
      coordinator: stubCoordinator,
      recovery: stubRecovery,
    });
    expect(stubMarkers.readForSender).not.toHaveBeenCalled();
    expect(stubCoordinator.coordinate).not.toHaveBeenCalled();
    expect(stubRecovery.recover).not.toHaveBeenCalled();
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

  it('stores an injected measured demo config as null-by-default in the neither case', async () => {
    const registry = await buildRegistry();
    expect(measuredDemoConfigOf(registry)).toBeNull();
    expect(Object.keys(registry.getTools())).toHaveLength(12);
  });

  it('does not register getShippingQuote with only the measured demo config (12 keys)', async () => {
    const registry = await buildRegistry(undefined, stubMeasuredDemoConfig);
    expect(measuredDemoConfigOf(registry)).toBe(stubMeasuredDemoConfig);
    expect(orchestratorOf(registry)).toBeNull();
    const tools = registry.getTools();
    expect(Object.keys(tools)).toHaveLength(12);
    expect(tools).not.toHaveProperty('getShippingQuote');
  });

  it('registers getShippingQuote when BOTH the orchestrator and the measured demo config are present (13 keys)', async () => {
    const orchestrator = new ShippingQuoteOrchestrator({ quote: jest.fn() });
    const registry = await buildRegistry(orchestrator, stubMeasuredDemoConfig);
    expect(orchestratorOf(registry)).toBe(orchestrator);
    expect(measuredDemoConfigOf(registry)).toBe(stubMeasuredDemoConfig);
    const tools = registry.getTools() as Record<
      string,
      { description?: string; inputSchema?: unknown; execute?: unknown }
    >;
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
        'getShippingQuote',
      ].sort(),
    );
    // Registered tool is the real AI-SDK tool (never executed here).
    const shipping = tools.getShippingQuote;
    expect(typeof shipping.description).toBe('string');
    expect(shipping.inputSchema).toBeDefined();
    expect(typeof shipping.execute).toBe('function');
    // Same ToolSet reference across repeated getTools() calls.
    expect(registry.getTools()).toBe(registry.getTools());
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

  describe('SQ-5C3c2 enabled-only shipping-approval wiring', () => {
    const SENDER = '525551234567';
    const ISO = '2026-06-23T12:00:00.000Z';
    const MS = Date.parse(ISO);
    const REQUEST_ID = 'abcdef012345';
    const REF = `HF-${REQUEST_ID}`;
    const DRAFT: ShippingQuoteDraft = {
      quoteId: 'q1',
      selectedRate: {
        rateId: 'r1',
        carrierName: 'Carrier',
        serviceName: 'Service',
        priceCents: 12900,
        currency: 'MXN',
        estimatedDeliveryDays: 2,
        validUntil: null,
      },
      providerExpiresAt: null,
      bestRateCents: 12900,
      totalCreditCents: 12000,
      appliedCreditCents: 12000,
      unusedCreditCents: 0,
      qualifyingUnitCount: 1,
      customerPaysCents: 900,
    };
    const DIGEST = {
      kind: 'shipping_approval' as const,
      draftCreatedAt: ISO,
      customerPaysCents: 900,
      totalCreditCents: 12000,
      carrierName: 'Carrier',
      serviceName: 'Service',
      estimatedDeliveryDays: 2,
    };

    const P = '11111111-1111-1111-1111-111111111111';
    const CID = '22222222-2222-2222-2222-222222222222';
    const AID = '33333333-3333-3333-3333-333333333333';
    const M = {
      weightGrams: 500,
      lengthCm: 10,
      widthCm: 20,
      heightCm: 30,
    };
    const ORIGIN = {
      postalCode: '06000',
      state: 'CDMX',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Centro',
    };
    const LINE = {
      productId: P,
      variantId: null,
      quantity: 1,
      unitPriceCents: 1500,
    };
    const QDEST = {
      zipCode: '06700',
      state: 'CDMX',
      municipality: 'Cuauhtémoc',
      neighborhood: 'Roma',
    };
    const DEST = {
      id: AID,
      label: null,
      street: 'Calle Falsa 123',
      exteriorNumber: '1',
      interiorNumber: null,
      zipCode: '06700',
      neighborhood: 'Roma',
      municipality: 'Cuauhtémoc',
      state: 'CDMX',
      visualReferences: 'portón azul',
      carrierPhone: '5512340000',
    };
    const LOOKUP = {
      found: true,
      customer: {
        customerId: CID,
        firstName: 'Ana',
        lastName: null,
        phoneCountryCode: '52',
        phone: '5551234567',
        preferredPaymentMethod: null,
        address: DEST,
      },
    };
    // Real matched measured-demo profile/config plus a live cart and pinned
    // context: the wrapper only reaches the approval seam when the stored
    // draft, its context pin, the current cart, and the backend reread all
    // agree. A contextless draft or an empty config fails closed earlier.
    const CONFIG: MeasuredDemoShippingConfig = {
      profile: {
        version: 1,
        items: [{ productId: P, variantId: null, quantity: 1, measurement: M }],
        parcel: M,
      },
      origin: ORIGIN,
    };
    const draftParts = () => {
      const record = buildShippingQuoteDraftRecord(DRAFT, MS)!;
      const context = buildShippingQuoteDraftContext(
        {
          customerId: CID,
          shippingAddressId: AID,
          destination: QDEST,
          cart: [{ ...LINE }],
        },
        record.createdAt,
      )!;
      return { record, context };
    };
    const draftState = (): ConversationState => {
      const { record, context } = draftParts();
      return {
        senderId: SENDER,
        lastMessageAt: ISO,
        data: {
          cart: { items: [{ ...LINE }], idempotencyKey: '' },
          [SHIPPING_QUOTE_DRAFT_KEY]: record,
          [SHIPPING_QUOTE_DRAFT_CONTEXT_KEY]: context,
        },
      };
    };
    const pendingState = (id: string): ConversationState => {
      const base = draftState();
      return {
        ...base,
        data: {
          ...base.data,
          pendingHumanRequest: {
            requestId: id,
            ref: `HF-${id}`,
            createdAt: ISO,
            customerNotifiedAt: ISO,
          },
        },
      };
    };
    const row = (over: Record<string, unknown> = {}): HumanHandoffRequest =>
      ({
        id: REQUEST_ID,
        customerId: SENDER,
        agentId: 'ops',
        kind: 'shipping_approval',
        digest: DIGEST,
        status: 'pending',
        resolution: null,
        createdAt: ISO,
        resolvedAt: null,
        ...over,
      }) as unknown as HumanHandoffRequest;
    const storeStub = (): StoreStub => ({
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    });
    const serviceStub = (create: jest.Mock): ServiceStub => ({
      create,
      resolveReply: jest.fn(),
      isOpsSender: jest.fn(),
    });
    const configStub = CONFIG;
    const rowStore = (findById: jest.Mock): HumanHandoffStore =>
      ({ findById }) as unknown as HumanHandoffStore;
    const callQuote = async (registry: RealToolRegistry): Promise<unknown> => {
      const tool = registry.getTools()['getShippingQuote'] as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      };
      return tool.execute(
        {},
        { toolCallId: 't', messages: [], context: { senderId: SENDER } },
      );
    };
    const OK_CREATE = {
      ok: true,
      requestId: REQUEST_ID,
      ref: REF,
      customerNotified: true,
    };
    const FROZEN_HANDOFF = {
      ok: false,
      status: 'handoff_required',
      reason: 'approval_unavailable',
    };

    // Each test owns its backend reread stub: resetting here keeps a lookup
    // resolved in one case from leaking a call count or implementation into
    // the next, so the exactly-once assertions stay meaningful.
    beforeEach(() => {
      stubChatbotApi.getCustomerByPhone.mockReset();
    });

    it('keeps exactly the twelve keys when shipping is disabled even with no handoff store', async () => {
      const registry = await buildRegistry();
      expect(Object.keys(registry.getTools()).sort()).toHaveLength(12);
      expect(registry.getTools()).not.toHaveProperty('getShippingQuote');
      expect(stubChatbotApi.getCustomerByPhone).not.toHaveBeenCalled();
    });

    it('registers the 13th key when enabled with a handoff row store', async () => {
      const registry = await buildRegistry(
        new ShippingQuoteOrchestrator({ quote: jest.fn() }),
        configStub,
        {
          humanHandoffStore: rowStore(jest.fn()),
        },
      );
      expect(Object.keys(registry.getTools())).toHaveLength(13);
      expect(registry.getTools()).toHaveProperty('getShippingQuote');
    });

    it('registers the 13th key but fails closed when enabled without a handoff row store', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(MS);
      try {
        const store = storeStub();
        store.get.mockResolvedValue(draftState());
        stubChatbotApi.getCustomerByPhone.mockResolvedValue(LOOKUP);
        const registry = await buildRegistry(
          new ShippingQuoteOrchestrator({ quote: jest.fn() }),
          configStub,
          { store },
        );
        expect(Object.keys(registry.getTools())).toHaveLength(13);
        const result = await callQuote(registry);
        expect(result).toEqual(FROZEN_HANDOFF);
        expect(Object.isFrozen(result)).toBe(true);
        expect(store.get).toHaveBeenCalledTimes(1);
        expect(store.update).not.toHaveBeenCalled();
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledTimes(1);
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledWith(
          '52',
          '5551234567',
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('executes a fresh stored draft through the real wrapper: creates the redacted request, verifies row/ref/marker, returns reused', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(MS);
      try {
        const store = storeStub();
        store.get
          .mockResolvedValueOnce(draftState())
          .mockResolvedValueOnce(draftState())
          .mockResolvedValueOnce(pendingState(REQUEST_ID));
        const create = jest.fn().mockResolvedValue(OK_CREATE);
        const findById = jest.fn().mockResolvedValue(row());
        const quote = jest.fn();
        stubChatbotApi.getCustomerByPhone.mockResolvedValue(LOOKUP);
        const registry = await buildRegistry(
          new ShippingQuoteOrchestrator({ quote }),
          configStub,
          {
            store,
            humanHandoffService: serviceStub(create),
            humanHandoffStore: rowStore(findById),
          },
        );
        const result = await callQuote(registry);
        expect(result).toEqual({ ok: true, status: 'reused' });
        expect(create).toHaveBeenCalledTimes(1);
        expect(create).toHaveBeenCalledWith({
          senderId: SENDER,
          kind: 'shipping_approval',
          digest: DIGEST,
        });
        expect(findById).toHaveBeenCalledTimes(1);
        expect(findById).toHaveBeenCalledWith(REQUEST_ID);
        expect(store.get).toHaveBeenCalledTimes(3);
        expect(store.update).not.toHaveBeenCalled();
        expect(quote).not.toHaveBeenCalled();
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledTimes(1);
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledWith(
          '52',
          '5551234567',
        );
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('fails closed with a price-free handoff when the created row is the wrong kind', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(MS);
      try {
        const store = storeStub();
        store.get.mockResolvedValue(draftState());
        const create = jest.fn().mockResolvedValue(OK_CREATE);
        const findById = jest
          .fn()
          .mockResolvedValue(row({ kind: 'needs_human_review' }));
        stubChatbotApi.getCustomerByPhone.mockResolvedValue(LOOKUP);
        const registry = await buildRegistry(
          new ShippingQuoteOrchestrator({ quote: jest.fn() }),
          configStub,
          {
            store,
            humanHandoffService: serviceStub(create),
            humanHandoffStore: rowStore(findById),
          },
        );
        const result = await callQuote(registry);
        expect(result).toEqual(FROZEN_HANDOFF);
        expect(Object.isFrozen(result)).toBe(true);
        expect(create).toHaveBeenCalledTimes(1);
        expect(findById).toHaveBeenCalledTimes(1);
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledTimes(1);
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledWith(
          '52',
          '5551234567',
        );
        const wire = JSON.stringify(result);
        for (const leaked of [REF, '900', '12000', 'Carrier', 'Service']) {
          expect(wire).not.toContain(leaked);
        }
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('fails closed with a price-free handoff on a pending collision without leaking the existing ref', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(MS);
      try {
        const collisionId = 'ffeeddccbbaa';
        const store = storeStub();
        store.get
          .mockResolvedValueOnce(draftState())
          .mockResolvedValueOnce(pendingState(collisionId));
        const create = jest.fn();
        stubChatbotApi.getCustomerByPhone.mockResolvedValue(LOOKUP);
        const registry = await buildRegistry(
          new ShippingQuoteOrchestrator({ quote: jest.fn() }),
          configStub,
          {
            store,
            humanHandoffService: serviceStub(create),
            humanHandoffStore: rowStore(jest.fn()),
          },
        );
        const result = await callQuote(registry);
        expect(result).toEqual(FROZEN_HANDOFF);
        expect(Object.isFrozen(result)).toBe(true);
        expect(create).not.toHaveBeenCalled();
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledTimes(1);
        expect(stubChatbotApi.getCustomerByPhone).toHaveBeenCalledWith(
          '52',
          '5551234567',
        );
        const wire = JSON.stringify(result);
        for (const leaked of [
          `HF-${collisionId}`,
          collisionId,
          '900',
          '12000',
        ]) {
          expect(wire).not.toContain(leaked);
        }
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('keeps the model-facing requestHumanAssistance schema unable to forge shipping_approval', async () => {
      const registry = await buildRegistry();
      const tool = registry.getTools()['requestHumanAssistance'] as {
        inputSchema: { safeParse: (v: unknown) => { success: boolean } };
      };
      expect(
        tool.inputSchema.safeParse({
          kind: 'shipping_approval',
          digest: DIGEST,
        }).success,
      ).toBe(false);
      expect(
        tool.inputSchema.safeParse({
          kind: 'out_of_stock',
          digest: {
            productId: '11111111-1111-4111-8111-111111111111',
            name: 'X',
          },
        }).success,
      ).toBe(true);
    });
  });
});
