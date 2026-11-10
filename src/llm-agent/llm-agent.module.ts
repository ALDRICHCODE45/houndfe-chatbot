import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import {
  CHATBOT_API_CLIENT,
  type ChatbotApiClient,
} from '../chatbot-api/domain/chatbot-api.client';
import { ConversationModule } from '../conversation/conversation.module';
import { ConversationGates } from '../conversation-gates/application/conversation-gates';
import { ConversationGatesModule } from '../conversation-gates/conversation-gates.module';
import { CustomerProfileModule } from '../customer-profile/customer-profile.module';
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
import {
  SHARED_RESERVATION,
  type SharedReservationPort,
} from '../human-decisions/domain/shared-reservation';
import { ExpirationPostOrchestrator } from '../human-decisions/application/expiration-post-orchestrator.service';
import { HumanDecisionsModule } from '../human-decisions/human-decisions.module';
import { RestockApplicationRuntime } from '../human-decisions/restock-application.runtime';
import { SaleFlowModule } from '../sale-flow/sale-flow.module';
import { RealToolRegistry } from '../sale-flow/infrastructure/real-tool-registry';
import { AgentRunner } from './application/agent-runner.service';
import { MinimalCatalogAgentService } from './application/minimal-catalog-agent.service';
import { MinimalCartService } from './application/minimal-cart.service';
import { MinimalCheckoutService } from './application/minimal-checkout.service';
import { MinimalOrderService } from './application/minimal-order.service';
import { MinimalShippingService } from './application/minimal-shipping.service';
import { DeliveryZonesModule } from '../delivery-zones/delivery-zones.module';
import {
  DELIVERY_ZONE_INTAKE,
  type DeliveryZoneIntakePort,
} from '../delivery-zones/application/delivery-zone-intake.service';
import { HumanHandoffModule } from '../human-handoff/human-handoff.module';
import { MinimalExpirationRequestService } from './application/minimal-expiration-request.service';
import { MinimalRestockRequestService } from './application/minimal-restock-request.service';
import { MINIMAL_CATALOG_SESSION_STORE } from './domain/minimal-catalog-session.store';
import { InMemoryMinimalCatalogSessionStore } from './infrastructure/in-memory-minimal-catalog-session.store';
import { LLM_AGENT } from './domain/llm-agent.port';
import { SYSTEM_PROMPT, LLM_AGENT_SYSTEM_PROMPT } from './domain/system-prompt';
import { TOOL_REGISTRY } from './domain/tool-registry.port';
import {
  GENERATE_TEXT,
  type GenerateTextFn,
} from './infrastructure/generate-text.provider';
import { LlmCoreModule } from './infrastructure/llm-core.module';
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
 * is the source of truth. `LLM_AGENT_SYSTEM_PROMPT` is still a sync
 * `useFactory`, now injecting the TOOL_REGISTRY seam.
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
    // GENERATE_TEXT + the shared CostGuardService (also used by receipts).
    LlmCoreModule,
    ConversationModule,
    // S4: one shared ConversationGates for the minimal route's durable gates.
    ConversationGatesModule,
    ChatbotApiModule,
    SaleFlowModule,
    HumanHandoffModule,
    // WU-B: DIRECT import (HumanHandoffModule does not re-export these) so the
    // RESTOCK markers/coordinator/recovery seams are visible for the bounded
    // confirmation service factory. Nest de-duplicates the shared instance.
    HumanDecisionsModule,
    // S5: PENDING zones register a DELIVERY_ZONE requester (always on).
    DeliveryZonesModule,
    // S1: persistent customer memory (style, names, pet, last order).
    CustomerProfileModule,
  ],
  providers: [
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
    AgentRunner,
    {
      // Read-only catalog route per-sender session history (in-memory;
      // restart loss). Injected so the service owns no hidden fallback map.
      provide: MINIMAL_CATALOG_SESSION_STORE,
      useClass: InMemoryMinimalCatalogSessionStore,
    },
    MinimalCatalogAgentService,
    MinimalCartService,
    MinimalCheckoutService,
    MinimalOrderService,
    {
      // Always on: backend-signed quotes back every delivery order (S9).
      provide: MinimalShippingService,
      inject: [
        CONVERSATION_STORE,
        MinimalCartService,
        MinimalCheckoutService,
        CHATBOT_API_CLIENT,
        DELIVERY_ZONE_INTAKE,
      ],
      useFactory: (
        store: ConversationStore,
        cart: MinimalCartService,
        checkout: MinimalCheckoutService,
        api: ChatbotApiClient,
        zones: DeliveryZoneIntakePort,
      ) => new MinimalShippingService(store, cart, checkout, api, zones),
    },
    {
      provide: MinimalExpirationRequestService,
      inject: [
        CHATBOT_API_CLIENT,
        SHARED_RESERVATION,
        ExpirationPostOrchestrator,
      ],
      useFactory: (
        chatbotApi: ChatbotApiClient,
        reservations: SharedReservationPort,
        orchestrator: ExpirationPostOrchestrator,
      ) =>
        new MinimalExpirationRequestService({
          chatbotApi,
          reservations,
          orchestrator,
        }),
    },
    {
      // WU-B: the RESTOCK confirmation gate. Human decisions are always on,
      // so the capability is always built.
      provide: MinimalRestockRequestService,
      inject: [
        CHATBOT_API_CLIENT,
        CONVERSATION_STORE,
        SHARED_ROUTE_MARKERS,
        RESTOCK_INTAKE_SERVICE,
        RESTOCK_EXISTING_REQUEST_STATUS_SERVICE,
        RestockApplicationRuntime,
        ConversationGates,
      ],
      useFactory: (
        chatbotApi: ChatbotApiClient,
        store: ConversationStore,
        markers: SharedRouteMarkersPort,
        coordinator: RestockIntakeService,
        recovery: RestockExistingRequestStatusService,
        runtime: RestockApplicationRuntime,
        gates: ConversationGates,
      ) =>
        new MinimalRestockRequestService({
          chatbotApi,
          store,
          gates,
          restock: {
            markers,
            coordinator,
            recovery,
            reconcileExpired: (senderId) => runtime.reconcileExpired(senderId),
          },
        }),
    },
  ],
  exports: [
    AgentRunner,
    LlmCoreModule,
    MinimalCatalogAgentService,
    MinimalRestockRequestService,
    MinimalExpirationRequestService,
  ],
})
export class LlmAgentModule {}
