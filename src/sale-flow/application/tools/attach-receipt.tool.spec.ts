/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */

import { makeAttachReceiptTool } from './attach-receipt.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { BankDetailsProvider } from '../../domain/bank-details.provider';
import type { AttachReceiptResponse } from '../../../chatbot-api/domain/dtos/sales.dto';

/**
 * Unit tests for the attachReceipt tool factory.
 *
 * Spec scenarios:
 *   - Maps saleId / mediaUrl / declaredAmountCents (+ optional declaredDate
 *     ISO datetime, declaredReference) to chatbotApi.attachReceipt
 *   - Rejects non-URL mediaUrl, zero declaredAmountCents, non-UUID saleId
 *   - Catches UpstreamError into a retryable upstream envelope
 */
describe('makeAttachReceiptTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    bankDetails: { get: async () => null } as BankDetailsProvider,
    cashierUserId: '00000000-4000-9000-0000-000000000001',
  };

  it('forwards saleId + mediaUrl + declaredAmountCents to chatbotApi.attachReceipt', async () => {
    const attachReceiptResponse: AttachReceiptResponse = {
      receiptId: 'receipt-1',
      status: 'PENDING',
    };
    const attachReceipt = jest.fn().mockResolvedValue(attachReceiptResponse);
    const deps = {
      ...baseDeps,
      chatbotApi: { attachReceipt } as unknown as ChatbotApiClient,
    };
    const tool = makeAttachReceiptTool(deps);

    const result = await tool.execute(
      {
        saleId: '00000000-4000-9000-0000-000000000001',
        mediaUrl: 'https://example.com/receipt.jpg',
        declaredAmountCents: 50000,
      },
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(attachReceipt).toHaveBeenCalledWith(
      '00000000-4000-9000-0000-000000000001',
      expect.objectContaining({
        mediaUrl: 'https://example.com/receipt.jpg',
        declaredAmountCents: 50000,
      }),
    );
    expect(result).toEqual({ ok: true, ...attachReceiptResponse });
  });

  it('rejects a non-URL mediaUrl at the schema layer', () => {
    const tool = makeAttachReceiptTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      saleId: '00000000-4000-9000-0000-000000000001',
      mediaUrl: 'not-a-url',
      declaredAmountCents: 1,
    });
    expect(r.success).toBe(false);
  });

  it('rejects declaredAmountCents: 0 at the schema layer (AGENTS.md §4.4.7 @Min(1))', () => {
    const tool = makeAttachReceiptTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({
      saleId: '00000000-4000-9000-0000-000000000001',
      mediaUrl: 'https://example.com/x.jpg',
      declaredAmountCents: 0,
    });
    expect(r.success).toBe(false);
  });

  it('catches UpstreamError(500) into a retryable upstream envelope', async () => {
    const attachReceipt = jest
      .fn()
      .mockRejectedValue(new UpstreamError('x', 500));
    const deps = {
      ...baseDeps,
      chatbotApi: { attachReceipt } as unknown as ChatbotApiClient,
    };
    const tool = makeAttachReceiptTool(deps);

    await expect(
      tool.execute(
        {
          saleId: '00000000-4000-9000-0000-000000000001',
          mediaUrl: 'https://example.com/x.jpg',
          declaredAmountCents: 1000,
        },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
