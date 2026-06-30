import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '../config/config.module';
import { ConversationModule } from '../conversation/conversation.module';
import { LlmAgentModule } from './llm-agent.module';
import {
  LLM_AGENT,
  type LlmAgentPort,
} from './domain/llm-agent.port';
import {
  TOOL_REGISTRY,
  type ToolRegistry,
} from './domain/tool-registry.port';
import { GENERATE_TEXT } from './infrastructure/generate-text.provider';
import { AgentRunner } from './application/agent-runner.service';
import { CostGuardService } from './application/cost-guard.service';
import { VercelAiLlmAgent } from './infrastructure/vercel-ai-llm-agent';

/**
 * Integration test for LlmAgentModule.
 *
 * Boots the full graph in a TestingModule, sets env vars via
 * AppConfigModule.forRoot(), and asserts every symbol binding resolves.
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
    AI_GATEWAY_API_KEY: 'gk',
    LLM_MODEL: 'anthropic/claude-sonnet-4.5',
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

  it('resolves every symbol binding and exports AgentRunner', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(), ConversationModule, LlmAgentModule],
    }).compile();

    // Generics / symbol bindings resolve to the expected concrete classes.
    const llm = moduleRef.get<LlmAgentPort>(LLM_AGENT);
    expect(llm).toBeInstanceOf(VercelAiLlmAgent);

    const tools = moduleRef.get<ToolRegistry>(TOOL_REGISTRY);
    expect(typeof tools.getTools).toBe('function');
    expect(tools.getTools()).toHaveProperty('getCurrentTime');

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
});