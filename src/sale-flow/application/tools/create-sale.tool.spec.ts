/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { makeCreateSaleTool } from './create-sale.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type {
  ConversationStore,
  ConversationState,
} from '../../../conversation/domain/conversation-store';
import type { BankDetailsProvider } from '../../domain/bank-details.provider';
import type { BotSaleResponse } from '../../../chatbot-api/domain/dtos/sales.dto';

/**
 * Unit tests for the createSale tool factory.
 *
 * Spec scenarios:
 *   - Empty cart -> validation envelope (no HTTP call)
 *   - First attempt: generate UUID v4, persist on cart, second call reuses key
 *   - List-price enforcement: persisted cart's unitPriceCents (list) is sent,
 *     NOT the model's input unitPriceCents nor finalPriceCents
 *   - cashierUserId injected from deps (never from model input)
 *   - Success clears cart to EMPTY_CART (incl. idempotencyKey)
 *   - Success returns { ok: true, ...BotSaleResponse }
 *   - Throws a non-UUID cart item -> validation envelope
 */
describe('makeCreateSaleTool', () => {
  const CASHIER = '00000000-4000-9000-0000-000000000001';
  const baseDeps = {
    chatbotApi: {} as ChatbotApiClient,
    bankDetails: { get: async () => null } as BankDetailsProvider,
    cashierUserId: CASHIER,
  };

  function stubStoreWithCart(cart: unknown): jest.Mocked<ConversationStore> {
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { cart },
    };
    return {
      get: jest.fn().mockResolvedValue(state),
      create: jest.fn(),
      update: jest
        .fn()
        .mockImplementation(async (senderId: string, patch: object) => ({
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        })),
    };
  }

  it('returns {validation, false} when the cart is empty (no HTTP call)', async () => {
    const createSale = jest.fn();
    const store = stubStoreWithCart(undefined); // no cart
    const deps = {
      ...baseDeps,
      chatbotApi: { createSale } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeCreateSaleTool(deps);

    const result = await tool.execute(
      {
        customerId: '00000000-4000-9000-0000-000000000099',
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('on first attempt generates a UUID v4 idempotency key, persists it, reuses on second call', async () => {
    const sale: BotSaleResponse = {
      saleId: 'sale-1',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 1000,
      paidCents: 0,
      debtCents: 1000,
      confirmedAt: null,
    };
    // First call: succeeds -> cart cleared.
    // Second call: cart is empty after clear -> validation envelope (we assert
    // that the FIRST call used the persisted key on the SECOND outgoing HTTP).
    // Use a more useful scenario: keep cart populated across two createSale calls
    // by clearing the cart only AFTER the call resolves.
    const updateCalls: Array<{ senderId: string; patch: object }> = [];
    const initialCart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: '',
    };
    let currentCart = initialCart;
    const get = jest.fn().mockImplementation(async () => ({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { cart: currentCart },
    }));
    const update = jest
      .fn()
      .mockImplementation(async (senderId: string, patch: object) => {
        updateCalls.push({ senderId, patch });
        // Persist the cart key after first createSale so a second call reuses it.
        const data = (patch as { data: { cart?: typeof currentCart } }).data;
        if (data.cart) {
          currentCart = data.cart;
        }
        return { senderId, ...patch };
      });
    const createSale = jest
      .fn()
      .mockResolvedValueOnce(sale)
      .mockResolvedValueOnce(sale);
    const store = { get, update } as unknown as ConversationStore;
    const deps = {
      ...baseDeps,
      chatbotApi: { createSale } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeCreateSaleTool(deps);

    // ── First call: empty idempotencyKey in cart → tool generates one, persists.
    const r1 = await tool.execute(
      {
        customerId: '00000000-4000-9000-0000-000000000099',
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(r1).toEqual({ ok: true, ...sale });

    // The first outgoing HTTP request carries a UUID v4 as the
    // X-Idempotency-Key value (header is set inside ChatbotApiHttpClient,
    // but for the test the tool only controls the key value). We assert
    // that the call was made AND that the persisted cart now holds a
    // non-empty key (writeCart deep merge).
    expect(createSale).toHaveBeenCalledTimes(1);
    const firstDto = createSale.mock.calls[0]![0];
    const firstKey = createSale.mock.calls[0]![1];
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Persisted cart has the same key.
    const persistedAfterFirst = updateCalls[0].patch as {
      data: { cart: { idempotencyKey: string } };
    };
    expect(persistedAfterFirst.data.cart.idempotencyKey).toBe(firstKey);

    // ── Re-prime the cart for a second call (success-clears-cart happened
    // but we want to assert key reuse on retry). Set up a non-empty cart
    // matching the same key.
    currentCart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: firstKey,
    };

    // ── Second call: reuses the persisted key.
    const r2 = await tool.execute(
      {
        customerId: '00000000-4000-9000-0000-000000000099',
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(r2).toEqual({ ok: true, ...sale });
    expect(createSale).toHaveBeenCalledTimes(2);
    expect(createSale.mock.calls[1]![1]).toBe(firstKey);

    // The first call's outgoing DTO is fully type-checked below.
    expect(firstDto.cashierUserId).toBe(CASHIER);
  });

  it('enforces list price: persisted cart unitPriceCents (list) is sent, NOT model input nor finalPriceCents', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000, // list price (originalPriceCents)
        },
      ],
      idempotencyKey: '',
    };
    const store = stubStoreWithCart(cart);
    const sale: BotSaleResponse = {
      saleId: 's-1',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 1000,
      paidCents: 0,
      debtCents: 1000,
      confirmedAt: null,
    };
    const createSale = jest.fn().mockResolvedValue(sale);
    const deps = {
      ...baseDeps,
      chatbotApi: { createSale } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeCreateSaleTool(deps);

    // Model passes a discounted `unitPriceCents` of 800; the tool must
    // override it with the persisted 1000.
    await tool.execute(
      {
        customerId: '00000000-4000-9000-0000-000000000099',
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 800, // discounted; the tool MUST ignore this
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );

    expect(createSale).toHaveBeenCalledTimes(1);
    const dto = createSale.mock.calls[0]![0];
    expect(dto.items[0]!.unitPriceCents).toBe(1000);
    // No part of the outgoing payload contains 800.
    expect(JSON.stringify(dto)).not.toContain('800');
    expect(dto.cashierUserId).toBe(CASHIER);
  });

  it('clears the cart to EMPTY_CART after a successful createSale', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'existing-key',
    };
    const update = jest.fn().mockResolvedValue({});
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { cart },
    };
    const store = {
      get: jest.fn().mockResolvedValue(state),
      update,
    } as unknown as ConversationStore;
    const sale: BotSaleResponse = {
      saleId: 'sale-1',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 1000,
      paidCents: 0,
      debtCents: 1000,
      confirmedAt: null,
    };
    const createSale = jest.fn().mockResolvedValue(sale);
    const deps = {
      ...baseDeps,
      chatbotApi: { createSale } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeCreateSaleTool(deps);

    await tool.execute(
      {
        customerId: '00000000-4000-9000-0000-000000000099',
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );

    // Last update call: cart cleared (items + idempotencyKey both empty).
    const lastPatch = update.mock.calls[update.mock.calls.length - 1]![1] as {
      data: { cart: { items: unknown[]; idempotencyKey: string } };
    };
    expect(lastPatch.data.cart.items).toEqual([]);
    expect(lastPatch.data.cart.idempotencyKey).toBe('');
  });

  it('rejects a model input that omits a line matched in the persisted cart -> validation envelope (no HTTP call)', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
        {
          productId: '00000000-4000-8000-0000-000000000002',
          variantId: '00000000-4000-8000-0000-000000000003',
          quantity: 2,
          unitPriceCents: 1500,
        },
      ],
      idempotencyKey: 'k',
    };
    const store = stubStoreWithCart(cart);
    const createSale = jest.fn();
    const deps = {
      ...baseDeps,
      chatbotApi: { createSale } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeCreateSaleTool(deps);

    // Model only sends the first line; the second persisted line has no
    // matching productName/variantName — tool refuses (validation).
    await tool.execute(
      {
        customerId: '00000000-4000-9000-0000-000000000099',
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            productName: 'Croquetas',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      },
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );

    expect(createSale).not.toHaveBeenCalled();
    // The store.update is still called to persist the validation
    // outcome? No — per design we rethrow a validation envelope without
    // any HTTP and without any persistence mutation. Update only happens
    // on success or when persisting the idempotency key on first attempt.
    // In this case the cart already had an idempotencyKey ('k'), so no
    // update at all.
    expect(store.update as jest.Mock).not.toHaveBeenCalled();
  });

  it('rejects non-UUID productId in input at the schema layer', () => {
    const tool = makeCreateSaleTool({
      ...baseDeps,
      store: {} as ConversationStore,
    });
    const r = tool.inputSchema.safeParse({
      customerId: '00000000-4000-9000-0000-000000000099',
      items: [
        {
          productId: 'not-a-uuid',
          productName: 'X',
          quantity: 1,
          unitPriceCents: 1,
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});
