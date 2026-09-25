import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { CHATBOT_API_CLIENT as CHATBOT_API_CLIENT_TOKEN } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE as CONVERSATION_STORE_TOKEN } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import {
  RESTOCK_INTAKE_SERVICE,
  type RestockIntakeService,
} from '../../human-decisions/application/restock-intake.service';
import {
  SHARED_ROUTE_MARKERS,
  type SharedRouteMarkersPort,
} from '../../human-decisions/domain/shared-route-markers';
import type { ToolRegistry } from '../../llm-agent/domain/tool-registry.port';
import type { ToolDeps } from '../application/tool-deps';
import { makeAttachReceiptTool } from '../application/tools/attach-receipt.tool';
import { makeCancelSaleTool } from '../application/tools/cancel-sale.tool';
import { makeCheckStockTool } from '../application/tools/check-stock.tool';
import { makeCreateSaleTool } from '../application/tools/create-sale.tool';
import { makeEvaluateCartTool } from '../application/tools/evaluate-cart.tool';
import { makeGetCustomerByPhoneTool } from '../application/tools/get-customer-by-phone.tool';
import { makeGetOrderHistoryTool } from '../application/tools/get-order-history.tool';
import { makeGetPaymentDetailsTool } from '../application/tools/get-payment-details.tool';
import { makeRequestHumanAssistanceTool } from '../application/tools/request-human-assistance.tool';
import { makeSearchCatalogTool } from '../application/tools/search-catalog.tool';
import { makeUpdateDeliveryTool } from '../application/tools/update-delivery.tool';
import { makeUpsertCustomerTool } from '../application/tools/upsert-customer.tool';

export const HUMAN_HANDOFF_SERVICE_TOKEN = Symbol('HUMAN_HANDOFF_SERVICE');

/**
 * Production `ToolRegistry` for the twelve sale-flow tools.
 *
 * Replaces the historical `InMemoryToolRegistry` placeholder in the
 * production wiring of `LlmAgentModule`. The ToolSet is built ONCE in the
 * constructor — every `getTools()` call returns the SAME frozen
 * reference, so the AI-SDK never observes tool-definition churn.
 *
 * Inventory (12):
 *   - searchCatalog, checkStock, evaluateCart
 *   - getCustomerByPhone, upsertCustomer
 *   - createSale, attachReceipt, updateDelivery, getOrderHistory
 *   - getPaymentDetails  (Q1 / R11)
 *   - cancelSale         (Q8)
 *   - requestHumanAssistance (12th, human-handoff slice — R7 + needs_human_review + R14)
 *
 * `cashierUserId` is sourced from typed `AppConfig.chatbotApi.cashierUserId`
 * and injected into the tool deps so the model can never pick it.
 *
 * `attachReceipt` is the one exception: it stays a registry key but is
 * factory-instantiated with NO deps — it is a terminal compatibility tool
 * (strict `{}` schema, zero backend attachment calls; the server-owned
 * `ReceiptAttachmentService` is the sole §4.4.7 attachment path).
 */
@Injectable()
export class RealToolRegistry implements ToolRegistry {
  private readonly tools: Record<string, unknown>;

  constructor(
    @Inject(CHATBOT_API_CLIENT_TOKEN) chatbotApi: ChatbotApiClient,
    @Inject(CONVERSATION_STORE_TOKEN) store: ConversationStore,
    @Inject(HUMAN_HANDOFF_SERVICE_TOKEN)
    humanHandoffService: HumanHandoffService,
    @Inject(SHARED_ROUTE_MARKERS) markers: SharedRouteMarkersPort,
    @Inject(RESTOCK_INTAKE_SERVICE) coordinator: RestockIntakeService,
    configService: ConfigService,
  ) {
    const cashierUserId = configService.get<string>(
      'chatbotApi.cashierUserId',
    ) as string;

    const deps: ToolDeps = {
      chatbotApi,
      store,
      cashierUserId,
      humanHandoffService,
    };

    // WU2B: the experimental RESTOCK gate is an EXACT boolean read. When it is
    // not exactly true the `restock` property is omitted ENTIRELY, so the
    // legacy deps stay byte-identical; nothing here reads the markers or
    // invokes the coordinator, and no tool branches on the capability.
    if (configService.get<boolean>('humanDecisions.restockEnabled') === true) {
      deps.restock = { enabled: true, markers, coordinator };
    }

    this.tools = {
      searchCatalog: makeSearchCatalogTool(deps),
      checkStock: makeCheckStockTool(deps),
      evaluateCart: makeEvaluateCartTool(deps),
      getCustomerByPhone: makeGetCustomerByPhoneTool(deps),
      upsertCustomer: makeUpsertCustomerTool(deps),
      createSale: makeCreateSaleTool(deps),
      // attachReceipt is a compatibility key wired WITHOUT any
      // model-controlled or backend-attachment dependency (WU12):
      // zero-arg factory, terminal guidance only.
      attachReceipt: makeAttachReceiptTool(),
      updateDelivery: makeUpdateDeliveryTool(deps),
      getOrderHistory: makeGetOrderHistoryTool(deps),
      getPaymentDetails: makeGetPaymentDetailsTool(deps),
      cancelSale: makeCancelSaleTool(deps),
      requestHumanAssistance: makeRequestHumanAssistanceTool(deps),
    };
  }

  getTools(): Record<string, unknown> {
    return this.tools;
  }
}
