import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { CHATBOT_API_CLIENT as CHATBOT_API_CLIENT_TOKEN } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE as CONVERSATION_STORE_TOKEN } from '../../conversation/domain/conversation-store';
import type { HumanHandoffService } from '../../human-handoff/application/human-handoff.service';
import {
  HUMAN_HANDOFF_STORE,
  type HumanHandoffStore,
} from '../../human-handoff/domain/human-handoff-store.port';
import type { ToolRegistry } from '../../llm-agent/domain/tool-registry.port';
import { requestShippingApproval } from '../../shipping/application/shipping-approval-request';
import { ShippingQuoteOrchestrator } from '../../shipping/application/shipping-quote-orchestrator';
import {
  MEASURED_DEMO_SHIPPING_CONFIG,
  type MeasuredDemoShippingConfig,
} from '../../shipping/application/measured-demo-shipping-config';
import type { ToolDeps } from '../application/tool-deps';
import { makeAttachReceiptTool } from '../application/tools/attach-receipt.tool';
import { makeCancelSaleTool } from '../application/tools/cancel-sale.tool';
import { makeCheckStockTool } from '../application/tools/check-stock.tool';
import { makeCreateSaleTool } from '../application/tools/create-sale.tool';
import { makeEvaluateCartTool } from '../application/tools/evaluate-cart.tool';
import { makeGetCustomerByPhoneTool } from '../application/tools/get-customer-by-phone.tool';
import { makeGetOrderHistoryTool } from '../application/tools/get-order-history.tool';
// prettier-ignore
import { makeGetShippingQuoteTool } from '../application/tools/get-shipping-quote.tool';
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
 * exact twelve-tool inventory in both states.
 *
 * `MEASURED_DEMO_SHIPPING_CONFIG` is likewise injected as an OPTIONAL
 * dependency (SQ-5B2B3) with a `null` default. The price-stripped
 * `getShippingQuote` tool is registered as the 13th key ONLY when BOTH the
 * orchestrator and the measured demo config are present; each alone (or
 * neither) keeps the exact twelve-tool inventory.
 *
 * `HUMAN_HANDOFF_STORE` (SQ-5C3c2) is also OPTIONAL with a `null` default.
 * In the enabled state it is passed to the quote tool through the committed
 * `requestShippingApproval` wrapper so the server-owned approval lifecycle
 * runs; when absent the tool still registers but its approval seam is
 * undefined, failing closed with a price-free `approval_unavailable`.
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
    @Optional()
    @Inject(MEASURED_DEMO_SHIPPING_CONFIG)
    private readonly measuredDemoShippingConfig: MeasuredDemoShippingConfig | null = null,
    @Optional()
    @Inject(HUMAN_HANDOFF_STORE)
    private readonly humanHandoffStore: HumanHandoffStore | null = null,
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

    const tools: Record<string, unknown> = {
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

    // SQ-5B2B3: register the price-stripped shipping-quote tool ONLY when
    // BOTH the shipping orchestrator and the measured demo config are
    // present. Every other combination keeps the exact twelve-tool set.
    if (
      this.shippingQuoteOrchestrator !== null &&
      this.measuredDemoShippingConfig !== null
    ) {
      // SQ-5C3c2: only in the enabled condition does the registry pass the
      // committed server-owned approval lifecycle. A missing row store leaves
      // the seam undefined so the tool registers yet fails closed with a
      // price-free `approval_unavailable`, never a success.
      const handoffRows = this.humanHandoffStore;
      tools.getShippingQuote = makeGetShippingQuoteTool({
        chatbotApi: deps.chatbotApi,
        store: deps.store,
        shippingQuoteOrchestrator: this.shippingQuoteOrchestrator,
        measuredDemoConfig: this.measuredDemoShippingConfig,
        requestShippingApproval:
          handoffRows === null
            ? undefined
            : (senderId: string) =>
                requestShippingApproval(
                  {
                    conversationStore: store,
                    handoffCreator: humanHandoffService,
                    handoffRows,
                    now: Date.now,
                  },
                  senderId,
                ),
      });
    }

    this.tools = tools;
  }

  getTools(): Record<string, unknown> {
    return this.tools;
  }
}
