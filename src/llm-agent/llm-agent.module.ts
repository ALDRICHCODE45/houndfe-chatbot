import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { ConversationModule } from '../conversation/conversation.module';
import { SaleFlowModule } from '../sale-flow/sale-flow.module';
import { RealToolRegistry } from '../sale-flow/infrastructure/real-tool-registry';
import { AgentRunner } from './application/agent-runner.service';
import { CostGuardService } from './application/cost-guard.service';
import { LLM_AGENT } from './domain/llm-agent.port';
import { SYSTEM_PROMPT, LLM_AGENT_SYSTEM_PROMPT } from './domain/system-prompt';
import { TOOL_REGISTRY } from './domain/tool-registry.port';
import {
  GENERATE_TEXT,
  generateTextImpl,
  type GenerateTextFn,
} from './infrastructure/generate-text.provider';
import { VercelAiLlmAgent } from './infrastructure/vercel-ai-llm-agent';
import { composeSaleFlowSystemPrompt } from '../sale-flow/domain/sale-flow-instructions';

/**
 * LlmAgentModule
 *
 * Wires the LLM agent feature:
 *   - LLM_AGENT              -> VercelAiLlmAgent (calls the SDK via GENERATE_TEXT seam)
 *   - TOOL_REGISTRY          -> RealToolRegistry (the 10 sale-flow tools incl. getPaymentDetails)
 *   - LLM_AGENT_SYSTEM_PROMPT -> composed at boot (base + slice; no bank block)
 *   - GENERATE_TEXT          -> generateTextImpl re-exported from infrastructure
 *   - CostGuardService       (process-local monthly token counter)
 *   - AgentRunner            (load -> idle -> truncate -> port -> cost-guard -> persist)
 *
 * Q1 / R11: bank details no longer flow through a boot-time seam. The
 * runtime `getPaymentDetails` AI-SDK tool (registered by RealToolRegistry)
 * is the source of truth. `LLM_AGENT_SYSTEM_PROMPT` collapses to a sync
 * `useFactory: () => composeSaleFlowSystemPrompt(SYSTEM_PROMPT)` with no
 * `await` and no `inject`.
 *
 * SaleFlowModule is imported so RealToolRegistry is reachable.
 * ChatbotApiModule is imported for parity (CHATBOT_API_CLIENT is injected
 * transitively into RealToolRegistry). Rollback to the placeholder
 * registry is a one-line binding change:
 *   TOOL_REGISTRY: { useExisting: RealToolRegistry }  -> useClass: InMemoryToolRegistry
 */
@Module({
  imports: [ConfigModule, ConversationModule, ChatbotApiModule, SaleFlowModule],
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
      // Production binding for the ten sale-flow tools.
      provide: TOOL_REGISTRY,
      useExisting: RealToolRegistry,
    },
    {
      // Composed system prompt: base SYSTEM_PROMPT + '\n\n' +
      // SALE_FLOW_INSTRUCTIONS. Evaluated ONCE at module boot;
      // AgentRunner injects the resolved string and never overrides it
      // per turn. The boot-time bank-details seam is gone — the runtime
      // `getPaymentDetails` tool is the source of truth.
      provide: LLM_AGENT_SYSTEM_PROMPT,
      useFactory: () => composeSaleFlowSystemPrompt(SYSTEM_PROMPT),
    },
    {
      provide: CostGuardService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new CostGuardService(
          config.get<{ monthlyTokenCeiling: number }>('llm')!
            .monthlyTokenCeiling,
        ),
    },
    AgentRunner,
  ],
  exports: [AgentRunner],
})
export class LlmAgentModule {}
