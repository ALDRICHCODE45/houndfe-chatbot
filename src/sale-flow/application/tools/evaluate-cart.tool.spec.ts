/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { makeEvaluateCartTool } from './evaluate-cart.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { NotFoundError } from '../../../chatbot-api/domain/errors';
import type {
  ConversationStore,
  ConversationState,
} from '../../../conversation/domain/conversation-store';
import type { CartEvaluationResult } from '../../../chatbot-api/domain/dtos/pricing.dto';

type SafeParseSchema = {
  safeParse(input: unknown): { success: boolean };
};

/**
 * Unit tests for the evaluateCart tool factory.
 *
 * Spec scenarios:
 *   - Persists the per-unit `unitPriceCents` from the response (the backend
 *     echoes the caller's input), never an extended LINE total.
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
    const r = (tool.contextSchema as unknown as SafeParseSchema).safeParse({
      senderId: '5215550001111',
    });
    expect(r.success).toBe(true);
  });

  it('persists the per-unit unitPriceCents from the response (never an extended LINE total) and keeps existing idempotencyKey', async () => {
    // Backend shape (`evaluate-cart-promotions.use-case.ts`): with qty=2 and
    // unitPriceCents=1000, `originalPriceCents`/`finalPriceCents` are extended
    // LINE totals (2000 / 1800), NOT unit prices. The backend echoes the
    // caller's input, so the request carries the same unit price (1000).
    const evaluation: CartEvaluationResult = {
      items: [
        {
          productId: 'p-uuid-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
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
        unitPriceCents: 1000,
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

    // Persisted cart uses the response's per-unit unitPriceCents (1000), NOT
    // the extended original 2000 or the extended discounted final 1800.
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
              unitPriceCents: 1000, // per-unit value from the response
            },
          ],
          // existing-key preserved across writes (writeCart shallow merge)
          idempotencyKey: 'existing-key',
        },
      },
    });
    // No extended LINE total leaks into the persisted unit price.
    const persistedUnitPrices = (
      patch as { data: { cart: { items: Array<{ unitPriceCents: number }> } } }
    ).data.cart.items.map((i) => i.unitPriceCents);
    expect(persistedUnitPrices).toEqual([1000]);
    expect(persistedUnitPrices).not.toContain(1800);
    expect(persistedUnitPrices).not.toContain(2000);
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
    const r = (tool.inputSchema as unknown as SafeParseSchema).safeParse({
      items: [],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-UUID productId at the schema layer', () => {
    const tool = makeEvaluateCartTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    const r = (tool.inputSchema as unknown as SafeParseSchema).safeParse({
      items: [{ productId: 'not-a-uuid', quantity: 1, unitPriceCents: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects quantity 0 at the schema layer (AGENTS.md §4.4.3 @Min(1))', () => {
    const tool = makeEvaluateCartTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    const r = (tool.inputSchema as unknown as SafeParseSchema).safeParse({
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

  it('persists expectedTotalCents = Σ finalPriceCents once per LINE on the cart (legacy carts also gain the field)', async () => {
    // Backend LINE totals: qty=2, unit 1000 → original 2000, final 1800.
    const evaluation: CartEvaluationResult = {
      items: [
        {
          productId: 'p-uuid-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
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
            unitPriceCents: 1000,
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
          expectedTotalCents: 1800,
        },
      },
    });
  });

  it('preserves the existing idempotencyKey when persisting expectedTotalCents on top of a pre-existing cart', async () => {
    // Backend LINE totals: qty=3, unit 1000 → original 3000, final 2700.
    const evaluation: CartEvaluationResult = {
      items: [
        {
          productId: 'p-uuid-1',
          variantId: null,
          quantity: 3,
          unitPriceCents: 1000,
          originalPriceCents: 3000,
          finalPriceCents: 2700,
          appliedPromotionTitle: 'PROMO_X',
          discountAmountCents: 300,
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

  it('sums each LINE finalPriceCents once and persists the response per-unit prices for a multi-line cart with an active PRODUCT_DISCOUNT (qty>1)', async () => {
    // Realistic backend-shaped multi-line result: line 1 is a qty=2
    // PRODUCT_DISCOUNT (extended original 2000 → final 1800); line 2 is a
    // plain qty=1 line. The correct cart total is 1800 + 500 = 2300, never
    // 1800*2 + 500.
    const evaluation: CartEvaluationResult = {
      items: [
        {
          productId: 'p-uuid-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
          appliedPromotionTitle: 'PROMO_X',
          discountAmountCents: 200,
        },
        {
          productId: 'p-uuid-2',
          variantId: null,
          quantity: 1,
          unitPriceCents: 500,
          originalPriceCents: 500,
          finalPriceCents: 500,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
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

    // The backend echoes the caller's input, so the request carries the same
    // per-unit prices (1000/500) that come back in the response.
    await tool.execute(
      {
        items: [
          {
            productId: '00000000-0000-4000-8000-000000000001',
            quantity: 2,
            unitPriceCents: 1000,
          },
          {
            productId: '00000000-0000-4000-8000-000000000002',
            quantity: 1,
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
            {
              productId: 'p-uuid-2',
              variantId: undefined,
              quantity: 1,
              unitPriceCents: 500,
            },
          ],
          idempotencyKey: 'existing-key',
          expectedTotalCents: 2300,
        },
      },
    });
    const persistedCart = (
      patch as {
        data: {
          cart: {
            items: Array<{ unitPriceCents: number }>;
            expectedTotalCents: number;
          };
        };
      }
    ).data.cart;
    expect(persistedCart.items.map((i) => i.unitPriceCents)).toEqual([
      1000, 500,
    ]);
    expect(persistedCart.expectedTotalCents).toBe(2300);
    // Guard against the qty double-count regression (1800*2 + 500).
    expect(persistedCart.expectedTotalCents).not.toBe(4100);
  });

  // ─── sale-flow-tools spec §"evaluateCart returns a humanAssistance
  // envelope on needs_human_review" ────────────────────────────────────
  describe('humanAssistance envelope (needs_human_review)', () => {
    const uuid1 = '00000000-0000-4000-8000-000000000001';

    it('adds the envelope on needs_human_review with the persisted per-unit items', async () => {
      const evaluation: CartEvaluationResult = {
        items: [
          {
            productId: uuid1,
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
            originalPriceCents: 2000,
            finalPriceCents: 1800,
            appliedPromotionTitle: 'PROMO_X',
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
              unitPriceCents: 1000,
            },
          ],
        },
        { toolCallId: 't', messages: [], context: { senderId: 's' } },
      );

      // Existing payload preserved + envelope added. digest.items mirrors the
      // persisted cart at per-unit `unitPriceCents`, never an extended line
      // total. `originalTotalCents` is optional in the spec union; the backend
      // CartEvaluationResult DTO carries no top-level totals, so the digest
      // omits it (design intent: the per-unit lines are the review payload).
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
              appliedPromotionTitle: 'PROMO_X',
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
            appliedPromotionTitle: 'PROMO_X',
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
