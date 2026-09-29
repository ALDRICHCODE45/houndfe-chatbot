import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { ConversationModule } from '../conversation/conversation.module';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../conversation/domain/conversation-store';
import {
  RESTOCK_INTAKE_SERVICE,
  type RestockIntakeService,
} from '../human-decisions/application/restock-intake.service';
import {
  RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
  type RestockExistingRequestStatusService,
} from '../human-decisions/application/restock-existing-request-status.service';
import {
  SHARED_ROUTE_MARKERS,
  type SharedRouteMarkersPort,
} from '../human-decisions/domain/shared-route-markers';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { RestockApplicationRuntime } from '../human-decisions/restock-application.runtime';
import { SaleFlowModule } from '../sale-flow/sale-flow.module';
import { RealToolRegistry } from '../sale-flow/infrastructure/real-tool-registry';
import { AgentRunner } from './application/agent-runner.service';
import { CostGuardService } from './application/cost-guard.service';
import { MinimalCatalogAgentService } from './application/minimal-catalog-agent.service';
import { MinimalRestockRequestService } from './application/minimal-restock-request.service';
import { LLM_AGENT } from './domain/llm-agent.port';
import { SYSTEM_PROMPT, LLM_AGENT_SYSTEM_PROMPT } from './domain/system-prompt';
import { TOOL_REGISTRY, type ToolRegistry } from './domain/tool-registry.port';
import {
  GENERATE_TEXT,
  generateTextImpl,
  type GenerateTextFn,
} from './infrastructure/generate-text.provider';
import { VercelAiLlmAgent } from './infrastructure/vercel-ai-llm-agent';
import { composeSaleFlowSystemPrompt } from '../sale-flow/domain/sale-flow-instructions';

/**
 * Fail-closed probe for the SQ-5C3d2 boot-time availability binding.
 *
 * Returns `true` only when the real registry exposes `getShippingQuote` as
 * an OWN key of the ToolSet — an inherited key, a non-object `getTools()`
 * result, a throwing `getTools`, and a hostile proxy that throws on
 * property inspection all resolve to `false`.
 */
function registryOwnsShippingQuote(registry: ToolRegistry): boolean {
  try {
    const tools = registry.getTools();
    if (tools === null || typeof tools !== 'object') return false;
    return Object.hasOwn(tools, 'getShippingQuote');
  } catch {
    return false;
  }
}

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
 * is the source of truth. `LLM_AGENT_SYSTEM_PROMPT` is still a sync
 * `useFactory`, now injecting the TOOL_REGISTRY seam.
 *
 * SQ-5C3d2: the `shippingQuoteAvailable` flag is derived at boot from the
 * ACTUAL registered tool key, never from env alone. The factory injects
 * TOOL_REGISTRY (already `useExisting: RealToolRegistry` from SaleFlowModule,
 * no DI cycle) and appends the opt-in shipping fragment only when the
 * registry owns `getShippingQuote`. Default-off composes the exact
 * byte-identical `base + '\n\n' + slice`.
 *
 * SaleFlowModule is imported so RealToolRegistry is reachable.
 * ChatbotApiModule is imported for parity (CHATBOT_API_CLIENT is injected
 * transitively into RealToolRegistry). Rollback to the placeholder
 * registry is a one-line binding change:
 *   TOOL_REGISTRY: { useExisting: RealToolRegistry }  -> useClass: InMemoryToolRegistry
 */
@Module({
  imports: [
    ConfigModule,
    ConversationModule,
    ChatbotApiModule,
    SaleFlowModule,
    // WU-B: DIRECT import (HumanHandoffModule does not re-export these) so the
    // RESTOCK markers/coordinator/recovery seams are visible for the bounded
    // confirmation service factory. Nest de-duplicates the shared instance.
    HumanDecisionsModule,
  ],
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
      //
      // SQ-5C3d2: shipping availability is derived from the registered
      // tool key (fail-closed on inherited/hostile registries), so the
      // opt-in fragment is appended only when `getShippingQuote` is
      // actually wired.
      provide: LLM_AGENT_SYSTEM_PROMPT,
      inject: [TOOL_REGISTRY],
      useFactory: (registry: ToolRegistry) =>
        composeSaleFlowSystemPrompt(SYSTEM_PROMPT, {
          shippingQuoteAvailable: registryOwnsShippingQuote(registry),
        }),
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
    MinimalCatalogAgentService,
    {
      // WU-B: the RESTOCK confirmation gate. The capability is built ONLY when
      // `humanDecisions.restockEnabled` is exactly true; otherwise it is
      // `undefined` and the read-only route stays byte-identical.
      provide: MinimalRestockRequestService,
      inject: [
        CHATBOT_API_CLIENT,
        CONVERSATION_STORE,
        ConfigService,
        SHARED_ROUTE_MARKERS,
        RESTOCK_INTAKE_SERVICE,
        RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
        RestockApplicationRuntime,
      ],
      useFactory: (
        chatbotApi: ChatbotApiClient,
        store: ConversationStore,
        config: ConfigService,
        markers: SharedRouteMarkersPort,
        coordinator: RestockIntakeService,
        recovery: RestockExistingRequestStatusService,
        runtime: RestockApplicationRuntime,
      ) =>
        new MinimalRestockRequestService({
          chatbotApi,
          store,
          restock:
            config.get<boolean>('humanDecisions.restockEnabled') === true
              ? {
                  enabled: true,
                  markers,
                  coordinator,
                  recovery,
                  reconcileExpired: (senderId) =>
                    runtime.reconcileExpired(senderId),
                }
              : undefined,
        }),
    },
  ],
  exports: [
    AgentRunner,
    CostGuardService,
    MinimalCatalogAgentService,
    MinimalRestockRequestService,
  ],
})
export class LlmAgentModule {}
