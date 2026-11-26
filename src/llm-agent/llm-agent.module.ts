import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BackordersModule } from '../backorders/backorders.module';
import {
  BACKORDER_CLIENT,
  type BackorderClient,
} from '../backorders/domain/backorder';
import { BackorderOfferRegistry } from '../backorders/domain/backorder-offer';
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
import { MinimalPaymentService } from './application/minimal-payment.service';
import { ReceiptReviewStatusRegistry } from './domain/receipt-review-status';
import { MinimalShippingService } from './application/minimal-shipping.service';
import { DeliveryZonesModule } from '../delivery-zones/delivery-zones.module';
import { DeliveryZoneResumeRegistry } from '../delivery-zones/domain/delivery-zone-resume';
import { MinimalZoneResumeService } from './application/minimal-zone-resume.service';
import {
  DELIVERY_ZONE_INTAKE,
  type DeliveryZoneIntakePort,
} from '../delivery-zones/application/delivery-zone-intake.service';
import { HumanHandoffModule } from '../human-handoff/human-handoff.module';
import { HumanRequestsServicesModule } from '../human-requests/human-requests.module';
import { MinimalExpirationRequestService } from './application/minimal-expiration-request.service';
import { MinimalRestockRequestService } from './application/minimal-restock-request.service';
import { BackorderGates } from './application/gates/backorder.gates';
import { MinimalBackorderConfirmService } from './application/minimal-backorder-confirm.service';
import { MinimalBackorderManageService } from './application/minimal-backorder-manage.service';
import { MinimalBackorderOfferService } from './application/minimal-backorder-offer.service';
import { CustomerProfileService } from '../customer-profile/application/customer-profile.service';
import { CustomerPetsService } from '../customer-profile/application/customer-pets.service';
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
 *   - CostGuardService       (persistent LLM spend cap + per-number limit)
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
    // S1: persistent customer memory (style, names, last order).
    CustomerProfileModule,
    // Restock backorder S1: the backorder port and the late-bound holder of
    // the offer capability the RESTOCK estimate coordinator resolves.
    BackordersModule,
    // S6: askTeam → HumanRequestCreateService (services only, no consumer).
    HumanRequestsServicesModule,
  ],
  providers: [
    {
      provide: LLM_AGENT,
      inject: [GENERATE_TEXT, ConfigService],
      useFactory: (generateTextFn: GenerateTextFn, config: ConfigService) => {
        const llm = config.get<{
          model: string;
          maxSteps: number;
          maxOutputTokens: number;
        }>('llm')!;
        return new VercelAiLlmAgent(
          generateTextFn,
          llm.model,
          llm.maxSteps,
          llm.maxOutputTokens,
        );
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
    // Multi-pet T4b: backend pets / local prospect pets for the agent and
    // the post-checkout upload (S8).
    CustomerPetsService,
    MinimalCartService,
    MinimalCheckoutService,
    MinimalOrderService,
    // Payment step after an order: bank details on demand.
    MinimalPaymentService,
    // Retest S3: "receipt in review" read, registered late by WhatsappModule
    // (the receipt-media module is never imported here).
    ReceiptReviewStatusRegistry,
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
      // S4: an approved delivery zone resumes the customer's checkout. The
      // delivery-zone runtime (which this module imports, not the reverse)
      // resolves it through the registry at call time.
      provide: MinimalZoneResumeService,
      inject: [
        CONVERSATION_STORE,
        MinimalCheckoutService,
        MinimalShippingService,
        MinimalOrderService,
        DeliveryZoneResumeRegistry,
      ],
      useFactory: (
        store: ConversationStore,
        checkout: MinimalCheckoutService,
        shipping: MinimalShippingService,
        order: MinimalOrderService,
        registry: DeliveryZoneResumeRegistry,
      ) => {
        const resume = new MinimalZoneResumeService(
          store,
          checkout,
          shipping,
          order,
        );
        registry.register(resume);
        return resume;
      },
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
      // Restock backorder: the two durable gates (each kind registers once),
      // shared by the RESTOCK confirmation (writes the stated count) and the
      // offer service (arms and answers the offer).
      provide: BackorderGates,
      inject: [ConversationGates],
      useFactory: (gates: ConversationGates) => new BackorderGates(gates),
    },
    {
      // Restock backorder S1/S14: arms and answers the offer that closes the
      // RESTOCK estimate. The RESTOCK application coordinator (human
      // decisions module, outside any turn) resolves it through the registry.
      provide: MinimalBackorderOfferService,
      inject: [
        BackorderGates,
        BACKORDER_CLIENT,
        CHATBOT_API_CLIENT,
        BackorderOfferRegistry,
        CustomerProfileService,
      ],
      useFactory: (
        gates: BackorderGates,
        backorders: BackorderClient,
        chatbotApi: ChatbotApiClient,
        registry: BackorderOfferRegistry,
        profiles: CustomerProfileService,
      ) => {
        const service = new MinimalBackorderOfferService({
          backorders,
          chatbotApi,
          gates,
          profiles,
        });
        registry.register(service);
        return service;
      },
    },
    {
      // Restock backorder S8 (T6): cancel / status of a scheduled restock
      // order from the chat. Deterministic; its cancel question is
      // process-local with a short expiry, so it adds no gate kind.
      provide: MinimalBackorderManageService,
      inject: [BACKORDER_CLIENT],
      useFactory: (backorders: BackorderClient) =>
        new MinimalBackorderManageService({ backorders }),
    },
    {
      // Restock backorder S6 (T5b): confirm a RESERVED backorder (tap or bare
      // yes) into the cart, and schedule an expired one again. Deterministic.
      provide: MinimalBackorderConfirmService,
      inject: [BACKORDER_CLIENT, CHATBOT_API_CLIENT],
      useFactory: (backorders: BackorderClient, chatbotApi: ChatbotApiClient) =>
        new MinimalBackorderConfirmService({ backorders, chatbotApi }),
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
        BackorderGates,
      ],
      useFactory: (
        chatbotApi: ChatbotApiClient,
        store: ConversationStore,
        markers: SharedRouteMarkersPort,
        coordinator: RestockIntakeService,
        recovery: RestockExistingRequestStatusService,
        runtime: RestockApplicationRuntime,
        gates: ConversationGates,
        backorder: BackorderGates,
      ) =>
        new MinimalRestockRequestService({
          chatbotApi,
          store,
          gates,
          // S14: the stated count waits here for the estimate.
          backorderQuantities: backorder.quantities,
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
    ReceiptReviewStatusRegistry,
  ],
})
export class LlmAgentModule {}
