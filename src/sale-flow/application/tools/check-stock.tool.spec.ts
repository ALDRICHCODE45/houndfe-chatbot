/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */

import { makeCheckStockTool } from './check-stock.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import {
  NotFoundError,
  UpstreamError,
} from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { BankDetailsProvider } from '../../domain/bank-details.provider';
import type { StockCheckResponse } from '../../../chatbot-api/domain/dtos/catalog.dto';

/**
 * Unit tests for the checkStock tool factory.
 *
 * Spec scenarios:
 *   - Maps productId (UUID) to chatbotApi.getStock
 *   - Returns { ok: true, ...StockCheckResponse } on success
 *   - 404 -> { ok: false, error: { kind: 'notFound', retryable: false } }
 *   - 5xx -> { ok: false, error: { kind: 'upstream', retryable: true } }
 *   - Rejects non-UUID productId at the schema layer
 */
describe('makeCheckStockTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    bankDetails: { get: async () => null } as BankDetailsProvider,
    cashierUserId: '00000000-0000-4000-8000-000000000001',
  };

  it('forwards productId to chatbotApi.getStock and returns { ok: true, ... }', async () => {
    const stock: StockCheckResponse = {
      productId: '00000000-0000-4000-8000-000000000001',
      name: 'Croquetas',
      stock: { status: 'available', quantity: 10 },
      variants: [],
    };
    const getStock = jest.fn().mockResolvedValue(stock);
    const deps = {
      ...baseDeps,
      chatbotApi: { getStock } as unknown as ChatbotApiClient,
    };
    const tool = makeCheckStockTool(deps);

    const result = await tool.execute(
      { productId: '00000000-0000-4000-8000-000000000001' },
      { toolCallId: 't', messages: [], context: undefined },
    );

    expect(getStock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(result).toEqual({ ok: true, ...stock });
  });

  it('rejects a non-UUID productId at the schema layer', () => {
    const tool = makeCheckStockTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ productId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('catches NotFoundError into a non-retryable notFound envelope', async () => {
    const getStock = jest.fn().mockRejectedValue(new NotFoundError('x', 404));
    const deps = {
      ...baseDeps,
      chatbotApi: { getStock } as unknown as ChatbotApiClient,
    };
    const tool = makeCheckStockTool(deps);

    await expect(
      tool.execute(
        { productId: '00000000-0000-4000-8000-000000000001' },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'notFound', retryable: false },
    });
  });

  it('catches UpstreamError(500) into a retryable upstream envelope', async () => {
    const getStock = jest.fn().mockRejectedValue(new UpstreamError('x', 500));
    const deps = {
      ...baseDeps,
      chatbotApi: { getStock } as unknown as ChatbotApiClient,
    };
    const tool = makeCheckStockTool(deps);

    await expect(
      tool.execute(
        { productId: '00000000-0000-4000-8000-000000000001' },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
