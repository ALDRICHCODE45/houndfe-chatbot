import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { CHATBOT_API_CLIENT as CHATBOT_API_CLIENT_TOKEN } from '../../chatbot-api/domain/chatbot-api.client';
import { CONVERSATION_STORE as CONVERSATION_STORE_TOKEN } from '../../conversation/domain/conversation-store';
import {
  BANK_DETAILS_PROVIDER,
  type BankDetailsProvider,
} from '../domain/bank-details.provider';
import type { ToolRegistry } from '../../llm-agent/domain/tool-registry.port';
import type { ToolDeps } from '../application/tool-deps';
import { makeAttachReceiptTool } from '../application/tools/attach-receipt.tool';
import { makeCheckStockTool } from '../application/tools/check-stock.tool';
import { makeCreateSaleTool } from '../application/tools/create-sale.tool';
import { makeEvaluateCartTool } from '../application/tools/evaluate-cart.tool';
import { makeGetCustomerByPhoneTool } from '../application/tools/get-customer-by-phone.tool';
import { makeGetOrderHistoryTool } from '../application/tools/get-order-history.tool';
import { makeSearchCatalogTool } from '../application/tools/search-catalog.tool';
import { makeUpdateDeliveryTool } from '../application/tools/update-delivery.tool';
import { makeUpsertCustomerTool } from '../application/tools/upsert-customer.tool';

/**
 * Production `ToolRegistry` for the nine sale-flow tools.
 *
 * Replaces the historical `InMemoryToolRegistry` placeholder in the
 * production wiring of `LlmAgentModule`. The ToolSet is built ONCE in
 * the constructor — every `getTools()` call returns the SAME frozen
 * reference, so the AI-SDK never observes tool-definition churn.
 *
 * `cashierUserId` is sourced from typed `AppConfig.chatbotApi.cashierUserId`
 * and injected into the tool deps so the model can never pick it.
 */
@Injectable()
export class RealToolRegistry implements ToolRegistry {
  private readonly tools: Record<string, unknown>;

  constructor(
    @Inject(CHATBOT_API_CLIENT_TOKEN) chatbotApi: ChatbotApiClient,
    @Inject(CONVERSATION_STORE_TOKEN) store: ConversationStore,
    @Inject(BANK_DETAILS_PROVIDER) bankDetails: BankDetailsProvider,
    configService: ConfigService,
  ) {
    const cashierUserId = configService.get<string>(
      'chatbotApi.cashierUserId',
    ) as string;

    const deps: ToolDeps = { chatbotApi, store, bankDetails, cashierUserId };

    this.tools = {
      searchCatalog: makeSearchCatalogTool(deps),
      checkStock: makeCheckStockTool(deps),
      evaluateCart: makeEvaluateCartTool(deps),
      getCustomerByPhone: makeGetCustomerByPhoneTool(deps),
      upsertCustomer: makeUpsertCustomerTool(deps),
      createSale: makeCreateSaleTool(deps),
      attachReceipt: makeAttachReceiptTool(deps),
      updateDelivery: makeUpdateDeliveryTool(deps),
      getOrderHistory: makeGetOrderHistoryTool(deps),
    };
  }

  getTools(): Record<string, unknown> {
    return this.tools;
  }
}
