import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { CHATBOT_API_CLIENT as CHATBOT_API_CLIENT_TOKEN } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE as CONVERSATION_STORE_TOKEN } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import type { ToolRegistry } from '../../llm-agent/domain/tool-registry.port';
import { ShippingQuoteOrchestrator } from '../../shipping/application/shipping-quote-orchestrator';
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
 *
 * `ShippingQuoteOrchestrator` is injected as an OPTIONAL dependency (SQ-5A):
 * the default-off `ShippingModule` only exports it when shipping quotes are
 * enabled, so the parameter defaults to `null` and the registry keeps its
 * exact twelve-tool inventory in both states. SQ-5A stores the instance but
 * registers no shipping tool yet.
 */
@Injectable()
export class RealToolRegistry implements ToolRegistry {
  private readonly tools: Record<string, unknown>;

  constructor(
    @Inject(CHATBOT_API_CLIENT_TOKEN) chatbotApi: ChatbotApiClient,
    @Inject(CONVERSATION_STORE_TOKEN) store: ConversationStore,
    @Inject(HUMAN_HANDOFF_SERVICE_TOKEN)
    humanHandoffService: HumanHandoffService,
    configService: ConfigService,
    @Optional()
    @Inject(ShippingQuoteOrchestrator)
    private readonly shippingQuoteOrchestrator: ShippingQuoteOrchestrator | null = null,
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
