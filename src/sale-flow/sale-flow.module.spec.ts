import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { PostgresConversationStore } from '../conversation/infrastructure/postgres-conversation.store';
import { AppConfigModule } from '../config/config.module';
import { PG_POOL } from '../database/postgres-pool.provider';
import { RESTOCK_INTAKE_SERVICE } from '../human-decisions/application/restock-intake.service';
import { SHARED_ROUTE_MARKERS } from '../human-decisions/domain/shared-route-markers';
import { HUMAN_HANDOFF_STORE } from '../human-handoff/domain/human-handoff-store.port';
import {
  HUMAN_HANDOFF_SERVICE_TOKEN,
  RealToolRegistry,
} from './infrastructure/real-tool-registry';
import { SaleFlowModule } from './sale-flow.module';

/**
 * Integration tests for SaleFlowModule wiring.
 *
 * Spec scenarios:
 *   - RealToolRegistry is provided by SaleFlowModule and resolves.
 *   - the boot-time bank-details seam is gone (no provider binding).
 *   - ChatbotApiModule + ConversationModule are transitively imported
 *     (CHATBOT_API_CLIENT + CONVERSATION_STORE resolve through the module).
 */
describe('SaleFlowModule', () => {
  // Set up the env so AppConfigModule.forRoot() can validate (with
  // ignoreEnvFile: true, only process.env matters).
  const VALID_ENV: Record<string, string> = {
    META_VERIFY_TOKEN: 't',
    META_APP_SECRET: 's',
    META_ACCESS_TOKEN: 'a',
    META_PHONE_NUMBER_ID: '1',
    CHATBOT_API_BASE_URL: 'https://api.example.com',
    SERVICE_KEY: 'svc_x',
    CHATBOT_API_BRANCH_ID: 'b',
    CHATBOT_API_CASHIER_USER_ID: '00000000-4000-9000-0000-000000000001',
    OPENAI_API_KEY: 'g',
    LLM_MODEL: 'm',
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    OPS_CHANNEL_PHONE: '5215500000000',
  };
  // WU2B sets HUMAN_DECISIONS_RESTOCK_ENABLED in one test, so the flag is saved
  // and restored alongside the validated env keys (and unset by default).
  const ENV_KEYS = [
    ...Object.keys(VALID_ENV),
    'HUMAN_DECISIONS_RESTOCK_ENABLED',
  ];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    for (const key of Object.keys(VALID_ENV)) {
      process.env[key] = VALID_ENV[key];
    }
    delete process.env.HUMAN_DECISIONS_RESTOCK_ENABLED;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
  });

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
  const stubConfigService = (restockEnabled?: boolean) => ({
    get: (key: string) => {
      if (key === 'chatbotApi.cashierUserId') {
        return '00000000-4000-9000-0000-000000000001';
      }
      if (key === 'humanDecisions.restockEnabled') {
        return restockEnabled;
      }
      return undefined;
    },
  });

  /** WU2B: the human-decisions adapters need a pool; init must never use it. */
  const fakePool = {
    connect: jest.fn(),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn().mockResolvedValue(undefined),
  };

  async function buildModule(restockEnabled?: boolean) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SaleFlowModule,
        HttpModule,
        AppConfigModule.forRoot({ ignoreEnvFile: true }),
      ],
    })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue(stubChatbotApi)
      .overrideProvider(ChatbotApiHttpClient)
      .useValue(stubChatbotApi)
      .overrideProvider(CONVERSATION_STORE)
      .useValue(stubStore)
      .overrideProvider(PostgresConversationStore)
      .useValue(stubStore)
      .overrideProvider(HUMAN_HANDOFF_SERVICE_TOKEN)
      .useValue({
        create: jest.fn(),
        resolveReply: jest.fn(),
        isOpsSender: jest.fn(),
      })
      .overrideProvider(HUMAN_HANDOFF_STORE)
      .useValue({
        create: jest.fn(),
        findById: jest.fn(),
        findByRef: jest.fn(),
        findLatestPendingForAgent: jest.fn(),
        resolve: jest.fn(),
      })

      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .overrideProvider(ConfigService)
      .useValue(stubConfigService(restockEnabled))
      .compile();
    return moduleRef;
  }

  // AppConfigModule is imported above to make ConfigService available to
  // ChatbotApiModule's HttpClient. The ConfigService override wins because
  // it's at the test module level, but the AppConfigModule import ensures
  // ConfigService is reachable from the SaleFlowModule container chain.
  // AppConfigModule.forRoot({ ignoreEnvFile: true }) keeps the test
  // hermetic — it does NOT read the repo's .env file.

  it('resolves RealToolRegistry through the module with exactly 12 tools', async () => {
    const moduleRef = await buildModule();
    const registry = moduleRef.get(RealToolRegistry);
    expect(registry).toBeInstanceOf(RealToolRegistry);
    expect(Object.keys(registry.getTools()).sort()).toEqual(
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
    await moduleRef.close();
  });

  it('does not bind the boot-time bank-details seam (only the runtime registry)', async () => {
    const moduleRef = await buildModule();
    // Probe the registry only — the boot-time bank-details symbol +
    // provider file no longer exist. The 12-tool registry is the
    // single SaleFlowModule export.
    const registry = moduleRef.get(RealToolRegistry);
    expect(Object.keys(registry.getTools())).toHaveLength(12);
    await moduleRef.close();
  });

  it('resolves the human-decisions RESTOCK tokens with no connection or SQL', async () => {
    const moduleRef = await buildModule(false);
    expect(moduleRef.get(SHARED_ROUTE_MARKERS)).toBeDefined();
    expect(moduleRef.get(RESTOCK_INTAKE_SERVICE)).toBeDefined();
    const registry = moduleRef.get(RealToolRegistry);
    expect(Object.keys(registry.getTools())).toHaveLength(12);
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(fakePool.query).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('stays inert on the SaleFlow surface even when the gate is exactly true', async () => {
    process.env.HUMAN_DECISIONS_RESTOCK_ENABLED = 'true';
    const moduleRef = await buildModule(true);
    const registry = moduleRef.get(RealToolRegistry);
    expect(Object.keys(registry.getTools())).toHaveLength(12);
    expect(fakePool.connect).not.toHaveBeenCalled();
    expect(fakePool.query).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
