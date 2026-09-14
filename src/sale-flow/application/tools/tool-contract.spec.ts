import { makeAttachReceiptTool } from './attach-receipt.tool';
import { makeCancelSaleTool } from './cancel-sale.tool';
import { makeCheckStockTool } from './check-stock.tool';
import { makeCreateSaleTool } from './create-sale.tool';
import { makeEvaluateCartTool } from './evaluate-cart.tool';
import { makeGetCustomerByPhoneTool } from './get-customer-by-phone.tool';
import { makeGetOrderHistoryTool } from './get-order-history.tool';
import { makeGetPaymentDetailsTool } from './get-payment-details.tool';
import { makeRequestHumanAssistanceTool } from './request-human-assistance.tool';
import { makeSearchCatalogTool } from './search-catalog.tool';
import { makeUpdateDeliveryTool } from './update-delivery.tool';
import { makeUpsertCustomerTool } from './upsert-customer.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';

/**
 * Shared contract suite that asserts every sale-flow tool exposes the
 * AI-SDK tool shape (description / Zod inputSchema / execute) and that
 * a representative malformed input is rejected by the schema BEFORE
 * `execute` is called.
 *
 * Spec scenario: representative schema rejects malformed inputs.
 */

type Factory = (deps: {
  chatbotApi: ChatbotApiClient;
  store: ConversationStore;
  cashierUserId: string;
}) => {
  description: string;
  inputSchema: {
    parse: (data: unknown) => unknown;
    safeParse: (data: unknown) => { success: boolean };
  };
  execute: (...args: unknown[]) => Promise<unknown>;
};

const stubChatbotApi = {} as ChatbotApiClient;
const stubStore = {} as ConversationStore;
const stubHumanHandoffService = {
  create: jest.fn(),
  resolveReply: jest.fn(),
  isOpsSender: jest.fn(),
};
const deps = {
  chatbotApi: stubChatbotApi,
  store: stubStore,
  cashierUserId: '00000000-0000-4000-8000-000000000001',
  humanHandoffService: stubHumanHandoffService as never,
};

const factories: Array<[string, Factory]> = [
  ['searchCatalog', makeSearchCatalogTool as unknown as Factory],
  ['checkStock', makeCheckStockTool as unknown as Factory],
  ['evaluateCart', makeEvaluateCartTool as unknown as Factory],
  ['getCustomerByPhone', makeGetCustomerByPhoneTool as unknown as Factory],
  ['upsertCustomer', makeUpsertCustomerTool as unknown as Factory],
  ['createSale', makeCreateSaleTool as unknown as Factory],
  ['attachReceipt', makeAttachReceiptTool as unknown as Factory],
  ['updateDelivery', makeUpdateDeliveryTool as unknown as Factory],
  ['getOrderHistory', makeGetOrderHistoryTool as unknown as Factory],
  ['getPaymentDetails', makeGetPaymentDetailsTool as unknown as Factory],
  ['cancelSale', makeCancelSaleTool as unknown as Factory],
  [
    'requestHumanAssistance',
    makeRequestHumanAssistanceTool as unknown as Factory,
  ],
];

describe('sale-flow tool contract (T4.1 / T4.12)', () => {
  it.each(factories)(
    '%s exposes description + Zod inputSchema + execute',
    (_name, factory) => {
      const tool = factory(deps);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema.parse).toBe('function');
      expect(typeof tool.execute).toBe('function');
    },
  );

  it.each(factories)(
    '%s rejects malformed input at the schema layer',
    (_name, factory) => {
      const tool = factory(deps);
      // `safeParse(undefined)` MUST fail for every tool — undefined is not
      // a valid input shape.
      const result = tool.inputSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    },
  );

  it('attachReceipt is the strict empty-object compatibility tool ({} parses, saleId payload is rejected)', () => {
    const tool = makeAttachReceiptTool();
    const schema = tool.inputSchema as unknown as {
      safeParse: (data: unknown) => { success: boolean };
    };
    const r = schema.safeParse({});
    expect(r.success).toBe(true);
    const result = schema.safeParse({
      saleId: '00000000-0000-4000-8000-000000000001',
      mediaUrl: 'https://example.com/receipt.jpg',
      declaredAmountCents: 50000,
    });
    expect(result.success).toBe(false);
  });
});
