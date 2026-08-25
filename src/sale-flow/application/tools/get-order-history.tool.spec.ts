/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { makeGetOrderHistoryTool } from './get-order-history.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { OrderHistoryResponse } from '../../../chatbot-api/domain/dtos/sales.dto';

/**
 * Unit tests for the getOrderHistory tool factory.
 *
 * Spec scenarios:
 *   - Maps phone + phoneCountryCode to chatbotApi.getOrderHistory
 *   - Returns { ok: true, results } on success
 *   - Rejects empty/over-long phone or phoneCountryCode
 *   - Catches UpstreamError into a retryable upstream envelope
 */
describe('makeGetOrderHistoryTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-4000-9000-0000-000000000001',
  };

  it('forwards phone + phoneCountryCode to chatbotApi.getOrderHistory', async () => {
    const results: OrderHistoryResponse[] = [
      {
        saleId: 'sale-1',
        folio: null,
        confirmedAt: null,
        channel: 'ONLINE',
        deliveryStatus: 'PENDING',
        paymentStatus: 'CREDIT',
        totalCents: 1000,
        paidCents: 0,
        debtCents: 1000,
        items: [],
        payments: [],
        shippingAddress: null,
      },
    ];
    const getOrderHistory = jest.fn().mockResolvedValue(results);
    const deps = {
      ...baseDeps,
      chatbotApi: { getOrderHistory } as unknown as ChatbotApiClient,
    };
    const tool = makeGetOrderHistoryTool(deps);

    const result = await tool.execute(
      { phone: '5550001111', phoneCountryCode: '+52' },
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(getOrderHistory).toHaveBeenCalledWith('5550001111', '+52');
    expect(result).toEqual({ ok: true, results });
  });

  it('rejects an empty phone at the schema layer', () => {
    const tool = makeGetOrderHistoryTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      phone: '',
      phoneCountryCode: '+52',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a phone longer than 20 chars', () => {
    const tool = makeGetOrderHistoryTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      phone: '1'.repeat(21),
      phoneCountryCode: '+52',
    });
    expect(r.success).toBe(false);
  });

  it('catches UpstreamError(500) into a retryable upstream envelope', async () => {
    const getOrderHistory = jest
      .fn()
      .mockRejectedValue(new UpstreamError('x', 500));
    const deps = {
      ...baseDeps,
      chatbotApi: { getOrderHistory } as unknown as ChatbotApiClient,
    };
    const tool = makeGetOrderHistoryTool(deps);

    await expect(
      tool.execute(
        { phone: '5550001111', phoneCountryCode: '+52' },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
