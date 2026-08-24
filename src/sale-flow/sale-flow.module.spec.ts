/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { PostgresConversationStore } from '../conversation/infrastructure/postgres-conversation.store';
import { AppConfigModule } from '../config/config.module';
import { BANK_DETAILS_PROVIDER } from './domain/bank-details.provider';
import { NullBankDetailsProvider } from './infrastructure/null-bank-details.provider';
import { RealToolRegistry } from './infrastructure/real-tool-registry';
import { SaleFlowModule } from './sale-flow.module';

/**
 * Integration tests for SaleFlowModule wiring.
 *
 * Spec scenarios:
 *   - RealToolRegistry is provided by SaleFlowModule and resolves.
 *   - BANK_DETAILS_PROVIDER is bound to NullBankDetailsProvider.
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
  };
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of Object.keys(VALID_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = VALID_ENV[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(VALID_ENV)) {
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
  const stubConfigService = {
    get: (key: string) => {
      if (key === 'chatbotApi.cashierUserId') {
        return '00000000-4000-9000-0000-000000000001';
      }
      return undefined;
    },
  };

  async function buildModule() {
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
      .overrideProvider(ConfigService)
      .useValue(stubConfigService)
      .compile();
    return moduleRef;
  }

  // AppConfigModule is imported above to make ConfigService available to
  // ChatbotApiModule's HttpClient. The ConfigService override wins because
  // it's at the test module level, but the AppConfigModule import ensures
  // ConfigService is reachable from the SaleFlowModule container chain.
  // AppConfigModule.forRoot({ ignoreEnvFile: true }) keeps the test
  // hermetic — it does NOT read the repo's .env file.

  it('resolves RealToolRegistry through the module', async () => {
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
      ].sort(),
    );
    await moduleRef.close();
  });

  it('binds BANK_DETAILS_PROVIDER to NullBankDetailsProvider', async () => {
    const moduleRef = await buildModule();
    const provider = moduleRef.get(BANK_DETAILS_PROVIDER);
    expect(provider).toBeInstanceOf(NullBankDetailsProvider);
    await expect(provider.get()).resolves.toBeNull();
    await moduleRef.close();
  });
});
