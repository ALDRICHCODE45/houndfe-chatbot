/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { makeEvaluateCartTool } from './evaluate-cart.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { NotFoundError } from '../../../chatbot-api/domain/errors';
import type {
  ConversationStore,
  ConversationState,
} from '../../../conversation/domain/conversation-store';
import type { BankDetailsProvider } from '../../domain/bank-details.provider';
import type { CartEvaluationResult } from '../../../chatbot-api/domain/dtos/pricing.dto';

/**
 * Unit tests for the evaluateCart tool factory.
 *
 * Spec scenarios:
 *   - Persists the cart with `unitPriceCents = originalPriceCents`
 *     (list price enforcement; never the model's input price or finalPriceCents).
 *   - Keeps an existing `idempotencyKey` on the cart across writes.
 *   - contextSchema carries { senderId } and is forwarded into the cart write.
 *   - Success returns { ok: true, ...CartEvaluationResult }.
 *   - Thrown NotFoundError surfaces as a non-retryable notFound envelope.
 */
describe('makeEvaluateCartTool', () => {
  const baseDeps = {
    chatbotApi: {} as ChatbotApiClient,
    bankDetails: { get: async () => null } as BankDetailsProvider,
    cashierUserId: '00000000-0000-4000-8000-000000000001',
  };

  it('contextSchema declares { senderId: string }', () => {
    const tool = makeEvaluateCartTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    expect(tool.contextSchema).toBeDefined();
    const r = tool.contextSchema!.safeParse({ senderId: '5215550001111' });
    expect(r.success).toBe(true);
  });

  it('persists the cart with unitPriceCents = originalPriceCents and keeps existing idempotencyKey', async () => {
    const evaluation: CartEvaluationResult = {
      items: [
        {
          productId: 'p-uuid-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 1000,
          finalPriceCents: 800,
          appliedPromotionTitle: 'PROMO_X',
          discountAmountCents: 200,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    };
    const evaluateCart = jest.fn().mockResolvedValue(evaluation);

    const existingState: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: {
        cart: {
          items: [{ productId: 'p0', quantity: 1, unitPriceCents: 999 }],
          idempotencyKey: 'existing-key',
        },
      },
    };
    const get = jest.fn().mockResolvedValue(existingState);
    const update = jest
      .fn()
      .mockImplementation(async (senderId: string, patch: object) => ({
        senderId,
        lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
        data: (patch as { data: object }).data,
      }));
    const store = { get, update } as unknown as ConversationStore;

    const deps = {
      ...baseDeps,
      chatbotApi: { evaluateCart } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeEvaluateCartTool(deps);

    const items = [
      {
        productId: '00000000-0000-4000-8000-000000000001',
        quantity: 2,
        unitPriceCents: 500,
      },
    ];
    const result = await tool.execute(
      { items },
      {
        toolCallId: 't',
        messages: [],
        context: { senderId: 's' },
      },
    );

    expect(result).toEqual({ ok: true, ...evaluation });

    // Persisted cart uses originalPriceCents (1000), NOT 500 nor 800.
    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0]!;
    expect(patch).toMatchObject({
      data: {
        cart: {
          items: [
            {
              productId: 'p-uuid-1',
              variantId: undefined,
              quantity: 2,
              unitPriceCents: 1000, // list price (originalPriceCents)
            },
          ],
          // existing-key preserved across writes (writeCart shallow merge)
          idempotencyKey: 'existing-key',
        },
      },
    });
    // The serialized payload must not contain the discounted 800 anywhere.
    const serialized = JSON.stringify(patch);
    expect(serialized).not.toContain('800');
  });

  it('throws (rethrows via mapChatbotError) when the upstream call rejects with NotFoundError -> notFound envelope', async () => {
    const evaluateCart = jest
      .fn()
      .mockRejectedValue(new NotFoundError('x', 404));
    const store = {
      get: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    } as unknown as ConversationStore;

    const deps = {
      ...baseDeps,
      chatbotApi: { evaluateCart } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeEvaluateCartTool(deps);

    await expect(
      tool.execute(
        {
          items: [
            {
              productId: '00000000-0000-4000-8000-000000000001',
              quantity: 1,
              unitPriceCents: 100,
            },
          ],
        },
        { toolCallId: 't', messages: [], context: { senderId: 's' } },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'notFound', retryable: false },
    });
    // No persistence on failure.
    expect(store.update as jest.Mock).not.toHaveBeenCalled();
  });

  it('rejects an empty items array at the schema layer (AGENTS.md §4.4.3 @ArrayMinSize(1))', () => {
    const tool = makeEvaluateCartTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    const r = tool.inputSchema.safeParse({ items: [] });
    expect(r.success).toBe(false);
  });

  it('rejects a non-UUID productId at the schema layer', () => {
    const tool = makeEvaluateCartTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    const r = tool.inputSchema.safeParse({
      items: [{ productId: 'not-a-uuid', quantity: 1, unitPriceCents: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects quantity 0 at the schema layer (AGENTS.md §4.4.3 @Min(1))', () => {
    const tool = makeEvaluateCartTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    const r = tool.inputSchema.safeParse({
      items: [
        {
          productId: '00000000-0000-4000-8000-000000000001',
          quantity: 0,
          unitPriceCents: 0,
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
