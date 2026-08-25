/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { makeUpdateDeliveryTool } from './update-delivery.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';

/**
 * Unit tests for the updateDelivery tool factory.
 *
 * Spec scenarios:
 *   - Maps saleId + carrierName? + trackingRef? + estimatedDeliveryAt? to
 *     chatbotApi.updateDelivery
 *   - Registered only; not exercised end-to-end by the slice's flow
 *   - Catches UpstreamError into a retryable upstream envelope
 */
describe('makeUpdateDeliveryTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-4000-9000-0000-000000000001',
  };

  it('forwards saleId + optional fields to chatbotApi.updateDelivery', async () => {
    const updateDelivery = jest.fn().mockResolvedValue(undefined);
    const deps = {
      ...baseDeps,
      chatbotApi: { updateDelivery } as unknown as ChatbotApiClient,
    };
    const tool = makeUpdateDeliveryTool(deps);

    const result = await tool.execute(
      {
        saleId: '00000000-4000-9000-0000-000000000001',
        carrierName: 'DHL',
        trackingRef: 'TRACK-1',
        estimatedDeliveryAt: '2026-07-01T12:00:00Z',
      },
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(updateDelivery).toHaveBeenCalledWith(
      '00000000-4000-9000-0000-000000000001',
      {
        carrierName: 'DHL',
        trackingRef: 'TRACK-1',
        estimatedDeliveryAt: '2026-07-01T12:00:00Z',
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it('accepts an empty patch (only saleId)', async () => {
    const updateDelivery = jest.fn().mockResolvedValue(undefined);
    const deps = {
      ...baseDeps,
      chatbotApi: { updateDelivery } as unknown as ChatbotApiClient,
    };
    const tool = makeUpdateDeliveryTool(deps);

    await tool.execute(
      {
        saleId: '00000000-4000-9000-0000-000000000001',
      },
      { toolCallId: 't', messages: [], context: undefined },
    );
    expect(updateDelivery).toHaveBeenCalledWith(
      '00000000-4000-9000-0000-000000000001',
      expect.objectContaining({}),
    );
  });

  it('rejects a non-UUID saleId at the schema layer', () => {
    const tool = makeUpdateDeliveryTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ saleId: 'x' });
    expect(r.success).toBe(false);
  });

  it('catches UpstreamError(503) into a retryable upstream envelope', async () => {
    const updateDelivery = jest
      .fn()
      .mockRejectedValue(new UpstreamError('x', 503));
    const deps = {
      ...baseDeps,
      chatbotApi: { updateDelivery } as unknown as ChatbotApiClient,
    };
    const tool = makeUpdateDeliveryTool(deps);

    await expect(
      tool.execute(
        { saleId: '00000000-4000-9000-0000-000000000001' },
        { toolCallId: 't', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
