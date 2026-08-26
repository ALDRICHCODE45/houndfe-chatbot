/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { makeEvaluateCartTool } from './evaluate-cart.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { NotFoundError } from '../../../chatbot-api/domain/errors';
import type {
  ConversationStore,
  ConversationState,
} from '../../../conversation/domain/conversation-store';
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
    cashierUserId: '00000000-0000-4000-8000-000000000001',
    humanHandoffService: {} as never,
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

  it('persists expectedTotalCents = Σ finalPriceCents × quantity on the cart (legacy carts also gain the field)', async () => {
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
          discountAmountCents: 400,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    };
    const evaluateCart = jest.fn().mockResolvedValue(evaluation);
    const existingState: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { cart: { items: [], idempotencyKey: 'k' } },
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
    await tool.execute(
      {
        items: [
          {
            productId: '00000000-0000-4000-8000-000000000001',
            quantity: 2,
            unitPriceCents: 500,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
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
              unitPriceCents: 1000,
            },
          ],
          idempotencyKey: 'k',
          expectedTotalCents: 1600,
        },
      },
    });
  });

  it('preserves the existing idempotencyKey when persisting expectedTotalCents on top of a pre-existing cart', async () => {
    const evaluation: CartEvaluationResult = {
      items: [
        {
          productId: 'p-uuid-1',
          variantId: null,
          quantity: 3,
          unitPriceCents: 1000,
          originalPriceCents: 1000,
          finalPriceCents: 900,
          appliedPromotionTitle: null,
          discountAmountCents: 100,
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
          items: [{ productId: 'old', quantity: 1, unitPriceCents: 100 }],
          idempotencyKey: 'existing-key',
          expectedTotalCents: 100,
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
    await tool.execute(
      {
        items: [
          {
            productId: '00000000-0000-4000-8000-000000000001',
            quantity: 3,
            unitPriceCents: 1000,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    const [, patch] = update.mock.calls[0]!;
    expect(patch).toMatchObject({
      data: {
        cart: {
          idempotencyKey: 'existing-key',
          expectedTotalCents: 2700,
        },
      },
    });
  });

  // ─── sale-flow-tools spec §"evaluateCart returns a humanAssistance
  // envelope on needs_human_review" ────────────────────────────────────
  describe('humanAssistance envelope (needs_human_review)', () => {
    const uuid1 = '00000000-0000-4000-8000-000000000001';

    it('adds the envelope on needs_human_review with the persisted list-price items', async () => {
      const evaluation: CartEvaluationResult = {
        items: [
          {
            productId: uuid1,
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
            originalPriceCents: 1000,
            finalPriceCents: 800,
            appliedPromotionTitle: null,
            discountAmountCents: 200,
          },
        ],
        promotionEvaluationStatus: 'needs_human_review',
      };
      const evaluateCart = jest.fn().mockResolvedValue(evaluation);
      const existingState: ConversationState = {
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: { items: [], idempotencyKey: 'k' } },
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

      const result = await tool.execute(
        {
          items: [
            {
              productId: uuid1,
              quantity: 2,
              unitPriceCents: 500,
            },
          ],
        },
        { toolCallId: 't', messages: [], context: { senderId: 's' } },
      );

      // Existing payload preserved + envelope added. digest.items mirrors
      // the persisted cart at LIST price (originalPriceCents), never the
      // discounted finalPriceCents. `originalTotalCents` is optional in the
      // spec union; the backend CartEvaluationResult DTO carries no
      // top-level totals, so the digest omits it (design intent: the
      // list-price lines are the review payload).
      expect(result).toEqual({
        ok: true,
        ...evaluation,
        humanAssistance: {
          kind: 'needs_human_review',
          digest: {
            items: [
              {
                productId: uuid1,
                variantId: undefined,
                quantity: 2,
                unitPriceCents: 1000,
              },
            ],
          },
        },
      });
    });

    it('does NOT carry the envelope for fully_evaluated (ok / rejected branches)', async () => {
      for (const promotionEvaluationStatus of ['fully_evaluated'] as const) {
        const evaluation: CartEvaluationResult = {
          items: [
            {
              productId: uuid1,
              variantId: null,
              quantity: 1,
              unitPriceCents: 1000,
              originalPriceCents: 1000,
              finalPriceCents: 900,
              appliedPromotionTitle: null,
              discountAmountCents: 100,
            },
          ],
          promotionEvaluationStatus,
        };
        const evaluateCart = jest.fn().mockResolvedValue(evaluation);
        const get = jest.fn().mockResolvedValue(null);
        const update = jest.fn();
        const store = { get, update } as unknown as ConversationStore;
        const tool = makeEvaluateCartTool({
          ...baseDeps,
          chatbotApi: { evaluateCart } as unknown as ChatbotApiClient,
          store,
        });

        const result = await tool.execute(
          {
            items: [
              {
                productId: uuid1,
                quantity: 1,
                unitPriceCents: 1000,
              },
            ],
          },
          { toolCallId: 't', messages: [], context: { senderId: 's' } },
        );

        expect(result).toEqual({ ok: true, ...evaluation });
        expect(result).not.toHaveProperty('humanAssistance');
      }
    });

    it('does NOT call HumanHandoffService — the envelope is a signal only', async () => {
      const evaluation: CartEvaluationResult = {
        items: [
          {
            productId: uuid1,
            variantId: null,
            quantity: 1,
            unitPriceCents: 1000,
            originalPriceCents: 1000,
            finalPriceCents: 900,
            appliedPromotionTitle: null,
            discountAmountCents: 100,
          },
        ],
        promotionEvaluationStatus: 'needs_human_review',
      };
      const evaluateCart = jest.fn().mockResolvedValue(evaluation);
      const get = jest.fn().mockResolvedValue(null);
      const update = jest.fn();
      const store = { get, update } as unknown as ConversationStore;
      const humanHandoffService = { create: jest.fn() };
      const tool = makeEvaluateCartTool({
        ...baseDeps,
        humanHandoffService: humanHandoffService as never,
        chatbotApi: { evaluateCart } as unknown as ChatbotApiClient,
        store,
      });

      await tool.execute(
        {
          items: [
            {
              productId: uuid1,
              quantity: 1,
              unitPriceCents: 1000,
            },
          ],
        },
        { toolCallId: 't', messages: [], context: { senderId: 's' } },
      );

      expect(humanHandoffService.create).not.toHaveBeenCalled();
    });
  });
});
