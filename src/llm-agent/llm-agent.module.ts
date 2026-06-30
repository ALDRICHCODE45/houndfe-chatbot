import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConversationModule } from '../conversation/conversation.module';
import { AgentRunner } from './application/agent-runner.service';
import { CostGuardService } from './application/cost-guard.service';
import { LLM_AGENT } from './domain/llm-agent.port';
import { TOOL_REGISTRY } from './domain/tool-registry.port';
import { InMemoryToolRegistry } from './infrastructure/in-memory-tool-registry';
import {
  GENERATE_TEXT,
  generateTextImpl,
  type GenerateTextFn,
} from './infrastructure/generate-text.provider';
import { VercelAiLlmAgent } from './infrastructure/vercel-ai-llm-agent';

/**
 * LlmAgentModule
 *
 * Wires the LLM agent feature:
 *   - LLM_AGENT  → VercelAiLlmAgent (calls the SDK via the GENERATE_TEXT seam)
 *   - TOOL_REGISTRY → InMemoryToolRegistry (placeholder tools only)
 *   - GENERATE_TEXT → `generateTextImpl` re-exported from the infra provider
 *   - CostGuardService (process-local monthly token counter)
 *   - AgentRunner (load → idle → truncate → port → cost-guard → persist)
 *
 * AppModule registers this module. WhatsappModule imports it to inject
 * AgentRunner into WebhookDispatcherService.
 */
@Module({
  imports: [ConfigModule, ConversationModule],
  providers: [
    {
      provide: GENERATE_TEXT,
      useValue: generateTextImpl,
    },
    {
      provide: LLM_AGENT,
      inject: [GENERATE_TEXT, ConfigService],
      useFactory: (generateTextFn: GenerateTextFn, config: ConfigService) => {
        const llm = config.get<{
          model: string;
          maxSteps: number;
          monthlyTokenCeiling: number;
        }>('llm')!;
        return new VercelAiLlmAgent(generateTextFn, llm.model, llm.maxSteps);
      },
    },
    {
      provide: TOOL_REGISTRY,
      useClass: InMemoryToolRegistry,
    },
    {
      provide: CostGuardService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new CostGuardService(
          config.get<{ monthlyTokenCeiling: number }>('llm')!.monthlyTokenCeiling,
        ),
    },
    AgentRunner,
  ],
  exports: [AgentRunner],
})
export class LlmAgentModule {}