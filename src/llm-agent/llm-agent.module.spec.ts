/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { AppConfigModule } from '../config/config.module';
import { ConversationModule } from '../conversation/conversation.module';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { SaleFlowModule } from '../sale-flow/sale-flow.module';
import { CHATBOT_API_CLIENT } from '../chatbot-api/domain/chatbot-api.client';
import { ChatbotApiHttpClient } from '../chatbot-api/infrastructure/chatbot-api-http.client';
import { CONVERSATION_STORE } from '../conversation/domain/conversation-store';
import { PostgresConversationStore } from '../conversation/infrastructure/postgres-conversation.store';
import { RealToolRegistry } from '../sale-flow/infrastructure/real-tool-registry';
import { LLM_AGENT_SYSTEM_PROMPT } from './domain/system-prompt';
import { LlmAgentModule } from './llm-agent.module';
import { LLM_AGENT, type LlmAgentPort } from './domain/llm-agent.port';
import { TOOL_REGISTRY, type ToolRegistry } from './domain/tool-registry.port';
import { GENERATE_TEXT } from './infrastructure/generate-text.provider';
import { AgentRunner } from './application/agent-runner.service';
import { CostGuardService } from './application/cost-guard.service';
import { VercelAiLlmAgent } from './infrastructure/vercel-ai-llm-agent';

/**
 * Integration test for LlmAgentModule.
 *
 * Boots the full graph in a TestingModule, sets env vars via
 * AppConfigModule.forRoot({ ignoreEnvFile: true }), and asserts every
 * symbol binding resolves.
 *
 * No live gateway calls: GENERATE_TEXT is the real ai.generateText
 * but the LlmAgentPort is reached only through AgentRunner, which we
 * do not invoke here. The test is about module wiring, not about
 * calling the SDK.
 */
describe('LlmAgentModule integration', () => {
  const VALID_ENV: Record<string, string> = {
    META_VERIFY_TOKEN: 't',
    META_APP_SECRET: 's',
    META_ACCESS_TOKEN: 'a',
    META_PHONE_NUMBER_ID: '123',
    CHATBOT_API_BASE_URL: 'https://api.houndfe.com',
    SERVICE_KEY: 'svc_x',
    CHATBOT_API_BRANCH_ID: 'b',
    CHATBOT_API_CASHIER_USER_ID: '00000000-4000-9000-0000-000000000001',
    OPENAI_API_KEY: 'ok',
    LLM_MODEL: 'anthropic/claude-sonnet-4.5',
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  };
  const MANAGED_KEYS = Object.keys(VALID_ENV);

  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const saved = savedEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    savedEnv = {};
  });

  function stubChatbotApi() {
    return {
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
  }

  function stubStore() {
    return {
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
  }

  it('resolves every symbol binding and exports AgentRunner', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot({ ignoreEnvFile: true }),
        HttpModule,
        ConversationModule,
        ChatbotApiModule,
        SaleFlowModule,
        LlmAgentModule,
      ],
    })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue(stubChatbotApi())
      .overrideProvider(ChatbotApiHttpClient)
      .useValue(stubChatbotApi())
      .overrideProvider(CONVERSATION_STORE)
      .useValue(stubStore())
      .overrideProvider(PostgresConversationStore)
      .useValue(stubStore())
      .compile();

    // Generics / symbol bindings resolve to the expected concrete classes.
    const llm = moduleRef.get<LlmAgentPort>(LLM_AGENT);
    expect(llm).toBeInstanceOf(VercelAiLlmAgent);

    // TOOL_REGISTRY resolves to RealToolRegistry with the 9 sale-flow tools.
    const tools = moduleRef.get<ToolRegistry>(TOOL_REGISTRY);
    expect(tools).toBeInstanceOf(RealToolRegistry);
    const toolKeys = Object.keys(tools.getTools()).sort();
    expect(toolKeys).toEqual(
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
    // The placeholder tool is no longer the production binding.
    expect(tools.getTools()).not.toHaveProperty('getCurrentTime');

    // LLM_AGENT_SYSTEM_PROMPT is composed at boot (base + slice) and
    // contains the refusal phrase + the sale-flow slice instruction markers.
    const composed = moduleRef.get<string>(LLM_AGENT_SYSTEM_PROMPT);
    expect(composed).toContain('esa función aún no está disponible');
    expect(composed).toContain('searchCatalog');
    expect(composed).toContain('originalPriceCents');

    const generateTextFn = moduleRef.get(GENERATE_TEXT);
    expect(typeof generateTextFn).toBe('function');

    const runner = moduleRef.get(AgentRunner);
    expect(runner).toBeInstanceOf(AgentRunner);

    const costGuard = moduleRef.get(CostGuardService);
    expect(costGuard).toBeInstanceOf(CostGuardService);

    // The config is also wired correctly (used by VercelAiLlmAgent ctor).
    const config = moduleRef.get(ConfigService);
    expect(config.get<string>('llm.model')).toBe('anthropic/claude-sonnet-4.5');
    expect(config.get<number>('llm.maxSteps')).toBe(3);

    await moduleRef.close();
  });

  it('allows tests to override TOOL_REGISTRY with a stub', async () => {
    const stubToolSet = {
      stub: { description: 'stub', inputSchema: {}, execute: jest.fn() },
    };
    const stubToolRegistry = { getTools: () => stubToolSet };

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot({ ignoreEnvFile: true }),
        HttpModule,
        ConversationModule,
        ChatbotApiModule,
        SaleFlowModule,
        LlmAgentModule,
      ],
    })
      .overrideProvider(CHATBOT_API_CLIENT)
      .useValue(stubChatbotApi())
      .overrideProvider(ChatbotApiHttpClient)
      .useValue(stubChatbotApi())
      .overrideProvider(CONVERSATION_STORE)
      .useValue(stubStore())
      .overrideProvider(PostgresConversationStore)
      .useValue(stubStore())
      .overrideProvider(TOOL_REGISTRY)
      .useValue(stubToolRegistry)
      .compile();

    const tools = moduleRef.get<ToolRegistry>(TOOL_REGISTRY);
    expect(tools.getTools()).toBe(stubToolSet);

    await moduleRef.close();
  });

  it('confines the `ai` SDK to infrastructure/ (the module itself never imports it)', () => {
    // Spec (llm-agent): "no file outside src/llm-agent/infrastructure/ imports from `ai`".
    // The module is the composition root but must reach the runtime `generateText`
    // through the infrastructure provider seam, not via a direct `from 'ai'` import.
    const moduleSource = readFileSync(
      join(__dirname, 'llm-agent.module.ts'),
      'utf8',
    );
    expect(moduleSource).not.toMatch(/from\s+['"]ai['"]/);
  });
});
