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
import { LLM_AGENT_SYSTEM_PROMPT, SYSTEM_PROMPT } from './domain/system-prompt';
import {
  SALE_FLOW_INSTRUCTIONS,
  SHIPPING_QUOTE_GUIDANCE_FRAGMENT,
} from '../sale-flow/domain/sale-flow-instructions';
import { LlmAgentModule } from './llm-agent.module';
import { LLM_AGENT, type LlmAgentPort } from './domain/llm-agent.port';
import { TOOL_REGISTRY, type ToolRegistry } from './domain/tool-registry.port';
import { GENERATE_TEXT } from './infrastructure/generate-text.provider';
import { AgentRunner } from './application/agent-runner.service';
import { CostGuardService } from './application/cost-guard.service';
import { MinimalRestockRequestService } from './application/minimal-restock-request.service';
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
    OPS_CHANNEL_PHONE: '5215500000000',
    // SQ-5C3d2 environment isolation: pin shipping quotes OFF so a host-set
    // SHIPPING_QUOTES_ENABLED=true cannot enable the shipping module or the
    // default-off prompt byte-identity assertion. MANAGED_KEYS restores it.
    SHIPPING_QUOTES_ENABLED: 'false',
    // WU-B: pin the RESTOCK gate OFF by default; the binding test flips it.
    HUMAN_DECISIONS_RESTOCK_ENABLED: 'false',
  };
  const MANAGED_KEYS = [...Object.keys(VALID_ENV), 'LLM_MAX_STEPS'];

  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, VALID_ENV);
    delete process.env.LLM_MAX_STEPS;
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

    // TOOL_REGISTRY resolves to RealToolRegistry with the 12 sale-flow tools.
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
        'getPaymentDetails',
        'cancelSale',
        'requestHumanAssistance',
      ].sort(),
    );
    // The placeholder tool is no longer the production binding.
    expect(tools.getTools()).not.toHaveProperty('getCurrentTime');

    // LLM_AGENT_SYSTEM_PROMPT is composed at boot (base + slice, NO bank
    // block appended because the seam is gone) and contains the refusal
    // phrase + the sale-flow slice instruction markers + the new
    // step-12 getPaymentDetails gating substring.
    const composed = moduleRef.get<string>(LLM_AGENT_SYSTEM_PROMPT);
    // SQ-5C3d2: the default-off assertion runs under the pinned env.
    expect(process.env.SHIPPING_QUOTES_ENABLED).toBe('false');
    expect(composed).toContain('esa función aún no está disponible');
    expect(composed).toContain('searchCatalog');
    expect(composed).toContain('originalPriceCents');
    expect(composed).toContain(
      'Llama a `getPaymentDetails` después de que `createSale` confirme',
    );
    // SQ-5C3d2 full-DI default-off graph (no TOOL_REGISTRY override): the
    // real registry owns no `getShippingQuote`, so the boot-composed prompt
    // is byte-identical to base + '\n\n' + slice and never mentions the
    // shipping tool.
    expect(composed).toBe(SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS);
    expect(composed).not.toContain('getShippingQuote');

    const generateTextFn = moduleRef.get(GENERATE_TEXT);
    expect(typeof generateTextFn).toBe('function');

    const runner = moduleRef.get(AgentRunner);
    expect(runner).toBeInstanceOf(AgentRunner);

    const costGuard = moduleRef.get(CostGuardService);
    expect(costGuard).toBeInstanceOf(CostGuardService);

    // The config is also wired correctly (used by VercelAiLlmAgent ctor).
    const config = moduleRef.get(ConfigService);
    expect(config.get<string>('llm.model')).toBe('anthropic/claude-sonnet-4.5');
    expect(config.get<number>('llm.maxSteps')).toBe(4);

    await moduleRef.close();
  });

  it('builds the bounded RESTOCK gate only under the exact restockEnabled flag', async () => {
    const boot = async () => {
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
      const service = moduleRef.get(MinimalRestockRequestService);
      const internals = service as unknown as {
        deps: { restock?: { reconcileExpired?: unknown } };
      };
      const reconcileExpired = internals.deps.restock?.reconcileExpired;
      // The callback is bound to the runtime; before bootstrap it is inert.
      const bounded =
        typeof reconcileExpired === 'function'
          ? await (reconcileExpired as (senderId: string) => Promise<boolean>)(
              'sender',
            )
          : null;
      await moduleRef.close();
      return {
        enabled: service.enabled,
        hasCallback: typeof reconcileExpired === 'function',
        bounded,
      };
    };

    await expect(boot()).resolves.toEqual({
      enabled: false,
      hasCallback: false,
      bounded: null,
    });
    process.env.HUMAN_DECISIONS_RESTOCK_ENABLED = 'true';
    await expect(boot()).resolves.toEqual({
      enabled: true,
      hasCallback: true,
      bounded: false,
    });
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

  describe('LLM_AGENT_SYSTEM_PROMPT boot-time shipping availability (SQ-5C3d2)', () => {
    const disabledCanonical = SYSTEM_PROMPT + '\n\n' + SALE_FLOW_INSTRUCTIONS;

    async function composePromptFor(registry: unknown): Promise<string> {
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
        .useValue(registry)
        .compile();

      const composed = moduleRef.get<string>(LLM_AGENT_SYSTEM_PROMPT);
      await moduleRef.close();
      return composed;
    }

    it('appends the shipping fragment only when the registry owns a getShippingQuote key', async () => {
      const owned = {
        getTools: () => ({
          searchCatalog: { description: 'x' },
          getShippingQuote: { description: 'y' },
        }),
      };

      const composed = await composePromptFor(owned);

      expect(composed).toBe(
        disabledCanonical + SHIPPING_QUOTE_GUIDANCE_FRAGMENT,
      );
      expect(composed).toContain('getShippingQuote');
      expect(composed).not.toBe(disabledCanonical);
    });

    it('keeps the prompt byte-identical to base + "\\n\\n" + slice when the key is absent', async () => {
      const absent = {
        getTools: () => ({ searchCatalog: { description: 'x' } }),
      };

      const composed = await composePromptFor(absent);

      expect(composed).toBe(disabledCanonical);
      expect(composed).not.toContain('getShippingQuote');
    });

    it('fails closed on inherited keys, throwing getTools, hostile proxies, and non-object tools', async () => {
      const inherited = {
        getTools: () =>
          Object.create({ getShippingQuote: {} }) as Record<string, unknown>,
      };
      const throwingGetTools = {
        getTools: () => {
          throw new Error('hostile getTools');
        },
      };
      const hostileProxy = {
        getTools: () =>
          new Proxy(
            {},
            {
              getOwnPropertyDescriptor: () => {
                throw new Error('hostile proxy');
              },
            },
          ),
      };
      const nonObject = { getTools: () => null };

      for (const registry of [
        inherited,
        throwingGetTools,
        hostileProxy,
        nonObject,
      ]) {
        const composed = await composePromptFor(registry);
        expect(composed).toBe(disabledCanonical);
      }
    });
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
