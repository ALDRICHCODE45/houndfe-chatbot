/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await, @typescript-eslint/unbound-method */

import { makeCreateSaleTool } from './create-sale.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type {
  ConversationStore,
  ConversationState,
} from '../../../conversation/domain/conversation-store';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
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
    cashierUserId: CASHIER,
    humanHandoffService: {} as never,
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
      setReceiptAmountPointer: jest.fn(),
      clearReceiptAmountPointer: jest.fn(),
      update: jest
        .fn()
        .mockImplementation(
          async (senderId: string, patch: Record<string, unknown>) => ({
            senderId,
            lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
            data: (patch as { data: object }).data,
          }),
        ),
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
      discountCents: 0,
    };
    // First call: succeeds -> cart cleared.
    // Second call: cart is empty after clear -> validation envelope (we assert
    // that the FIRST call used the persisted key on the SECOND outgoing HTTP).
    // Use a more useful scenario: keep cart populated across two createSale calls
    // by clearing the cart only AFTER the call resolves.
    const updateCalls: Array<{
      senderId: string;
      patch: Record<string, unknown>;
    }> = [];
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
      .mockImplementation(
        async (senderId: string, patch: Record<string, unknown>) => {
          updateCalls.push({ senderId, patch });
          // Persist the cart key after first createSale so a second call reuses it.
          const data = (patch as { data: { cart?: typeof currentCart } }).data;
          if (data.cart) {
            currentCart = data.cart;
          }
          return { senderId, ...patch };
        },
      );
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
      discountCents: 0,
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

  it('clears the cart to EMPTY_CART and sets placedSaleId atomically after a successful createSale (one ConversationStore.update write)', async () => {
    // T3.3 (cancel-endpoint-conversational): `createSale` success MUST persist
    // `data.cart = EMPTY_CART` AND `data.placedSaleId = sale.saleId` in a
    // SINGLE `ConversationStore.update` (ADR-13). A second sequential write
    // would clobber the first's cart clear.
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
    const updateCalls: Array<{
      senderId: string;
      patch: Record<string, unknown>;
    }> = [];
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { cart },
    };
    const update = jest
      .fn()
      .mockImplementation(
        async (senderId: string, patch: Record<string, unknown>) => {
          updateCalls.push({ senderId, patch });
          return {
            senderId,
            lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
            data: (patch as { data: object }).data,
          };
        },
      );
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
      discountCents: 0,
    };
    const createSale = jest.fn().mockResolvedValue(sale);
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

    // Exactly ONE store.update write on the success path (cart clear +
    // placedSaleId set are atomic — never two sequential writes).
    expect(update).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, ...sale });

    // The single patch contains cart=EMPTY_CART AND placedSaleId='sale-1'.
    const firstCall = updateCalls[0];
    expect(firstCall.senderId).toBe('s');
    const patch = firstCall.patch as {
      data: {
        cart: { items: unknown[]; idempotencyKey: string };
        placedSaleId: string;
      };
    };
    expect(patch.data.cart.items).toEqual([]);
    expect(patch.data.cart.idempotencyKey).toBe('');
    expect(patch.data.placedSaleId).toBe('sale-1');
  });

  it('a new createSale overwrites the prior placedSaleId atomically with the cart clear', async () => {
    // T3.3 (b): subsequent createSale overwrites any prior placedSaleId.
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'k',
    };
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { cart, placedSaleId: 'sale-1' }, // prior placedSaleId present
    };
    const update = jest.fn().mockResolvedValue({});
    const store = {
      get: jest.fn().mockResolvedValue(state),
      update,
    } as unknown as ConversationStore;
    const sale: BotSaleResponse = {
      saleId: 'sale-2',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 1000,
      paidCents: 0,
      debtCents: 1000,
      confirmedAt: null,
      discountCents: 0,
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

    // Single atomic write overwrites placedSaleId + clears cart.
    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0]! as [
      string,
      {
        data: {
          cart: { items: unknown[]; idempotencyKey: string };
          placedSaleId: string;
        };
      },
    ];
    expect(patch.data.placedSaleId).toBe('sale-2');
    expect(patch.data.cart.items).toEqual([]);
    expect(patch.data.cart.idempotencyKey).toBe('');
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
      discountCents: 0,
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
    const inputSchema = tool.inputSchema as {
      safeParse(input: unknown): { success: boolean };
    };
    const r = inputSchema.safeParse({
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

  it('forwards expectedTotalCents sourced from the cart (never from model input)', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'k',
      expectedTotalCents: 1500,
    };
    const store = stubStoreWithCart(cart);
    const sale: BotSaleResponse = {
      saleId: 'sale-1',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 1500,
      paidCents: 0,
      debtCents: 1500,
      confirmedAt: null,
      discountCents: 0,
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
    expect(createSale).toHaveBeenCalledTimes(1);
    const dto = createSale.mock.calls[0]![0];
    expect(dto.expectedTotalCents).toBe(1500);
  });

  it('legacy cart (no expectedTotalCents) → outgoing DTO omits the key (no 0, no null)', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'k',
      // no expectedTotalCents on purpose
    };
    const store = stubStoreWithCart(cart);
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
      discountCents: 0,
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
    const dto = createSale.mock.calls[0]![0];
    expect(dto.expectedTotalCents).toBeUndefined();
    expect(JSON.stringify(dto)).not.toContain('expectedTotalCents');
  });

  it('PROMO_RE_QUOTE → {promoReQuote} envelope unchanged; cart items preserved, expectedTotalCents replaced by recomputedTotalCents, idempotencyKey cleared', async () => {
    const promoErr = new UpstreamError(
      'Price changed',
      409,
      {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      },
      'PROMO_RE_QUOTE',
    );
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'pre-key',
      expectedTotalCents: 1000,
    };
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
    } as unknown as ConversationStore;
    const createSale = jest.fn().mockRejectedValue(promoErr);
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
      error: {
        kind: 'promoReQuote',
        retryable: false,
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      },
    });
    expect(currentCart.items).toEqual(cart.items);
    expect(currentCart.expectedTotalCents).toBe(900);
    expect(currentCart.idempotencyKey).toBe('');
  });

  // R-D2 / ADR-5 contract: when the PROMO_RE_QUOTE body is malformed
  // (any of `recomputedTotalCents`, `expectedTotalCents`, or
  // `discountCents` is missing or not a non-negative integer), the
  // mapper falls through to `{validation, false}` AND the cart mutation
  // must agree: items + `expectedTotalCents` stay intact (no fabricated
  // total), only the `idempotencyKey` is cleared. State mutation and
  // returned envelope must NEVER disagree.
  const malformedPromoCases: ReadonlyArray<{
    label: string;
    body: Record<string, unknown>;
  }> = [
    {
      label: 'recomputedTotalCents missing entirely',
      body: {
        error: 'PROMO_RE_QUOTE',
        expectedTotalCents: 1000,
        discountCents: 100,
      },
    },
    {
      label: 'expectedTotalCents is a string',
      body: {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: 'not-a-number',
        discountCents: 100,
      },
    },
    {
      label: 'expectedTotalCents is negative',
      body: {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: -1,
        discountCents: 100,
      },
    },
    {
      label: 'discountCents is a string',
      body: {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 'not-a-number',
      },
    },
    {
      label: 'discountCents is null',
      body: {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: null,
      },
    },
  ];

  it.each(malformedPromoCases)(
    'PROMO_RE_QUOTE with malformed body ($label) → envelope falls through to {validation,false}; cart preserves items + expectedTotalCents and clears key (no fabricated total)',
    async ({ body }) => {
      const malformedErr = new UpstreamError(
        'bad promo body',
        409,
        body,
        'PROMO_RE_QUOTE',
      );
      const cart = {
        items: [
          {
            productId: '00000000-4000-9000-0000-000000000001',
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
        idempotencyKey: 'pre-key',
        expectedTotalCents: 1000,
      };
      let currentCart = cart;
      const store = {
        get: jest.fn().mockImplementation(async () => ({
          senderId: 's',
          lastMessageAt: '2026-06-23T12:00:00.000Z',
          data: { cart: currentCart },
        })),
        update: jest
          .fn()
          .mockImplementation(
            async (_: string, patch: Record<string, unknown>) => {
              const d = (patch as { data: { cart?: typeof currentCart } }).data;
              if (d.cart) currentCart = d.cart;
              return { senderId: 's', ...patch };
            },
          ),
      } as unknown as ConversationStore;
      const createSale = jest.fn().mockRejectedValue(malformedErr);
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
      expect(currentCart.items).toEqual(cart.items);
      expect(currentCart.expectedTotalCents).toBe(1000);
      expect(currentCart.idempotencyKey).toBe('');
    },
  );

  it('IDEMPOTENCY_KEY_IN_FLIGHT → {idempotencyInFlight, retryable:true}, key preserved', async () => {
    const err = new UpstreamError(
      'in-flight',
      409,
      { error: 'IDEMPOTENCY_KEY_IN_FLIGHT' },
      'IDEMPOTENCY_KEY_IN_FLIGHT',
    );
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'preserved-key',
    };
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
    } as unknown as ConversationStore;
    const createSale = jest.fn().mockRejectedValue(err);
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
      error: { kind: 'idempotencyInFlight', retryable: true },
    });
    expect(currentCart.idempotencyKey).toBe('preserved-key');
  });

  it('IDEMPOTENCY_KEY_CONFLICT → {idempotencyConflict, retryable:false}, key cleared', async () => {
    const err = new UpstreamError(
      'conflict',
      409,
      { error: 'IDEMPOTENCY_KEY_CONFLICT' },
      'IDEMPOTENCY_KEY_CONFLICT',
    );
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'conflicted-key',
    };
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
    } as unknown as ConversationStore;
    const createSale = jest.fn().mockRejectedValue(err);
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
      error: { kind: 'idempotencyConflict', retryable: false },
    });
    expect(currentCart.idempotencyKey).toBe('');
  });

  it('PRICE_OUT_OF_DATE → {priceOutOfDate, retryable:false}, key preserved', async () => {
    const err = new UpstreamError(
      'stale',
      409,
      { error: 'PRICE_OUT_OF_DATE' },
      'PRICE_OUT_OF_DATE',
    );
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'pre-key',
    };
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
    } as unknown as ConversationStore;
    const createSale = jest.fn().mockRejectedValue(err);
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
      error: { kind: 'priceOutOfDate', retryable: false },
    });
    expect(currentCart.idempotencyKey).toBe('pre-key');
  });

  it('INVALID_IDEMPOTENCY_KEY → {validation, retryable:false}, key preserved', async () => {
    const err = new UpstreamError(
      'bad-key',
      400,
      { error: 'INVALID_IDEMPOTENCY_KEY' },
      'INVALID_IDEMPOTENCY_KEY',
    );
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'pre-key',
    };
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
    } as unknown as ConversationStore;
    const createSale = jest.fn().mockRejectedValue(err);
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
    expect(currentCart.idempotencyKey).toBe('pre-key');
  });

  it('success with discountCents=250 → success envelope surfaces it; cart cleared (expectedTotalCents undefined)', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: 'pre-key',
      expectedTotalCents: 750,
    };
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
    } as unknown as ConversationStore;
    const sale: BotSaleResponse = {
      saleId: 'sale-1',
      folio: null,
      paymentStatus: 'CREDIT',
      channel: 'ONLINE',
      deliveryStatus: 'PENDING',
      totalCents: 750,
      paidCents: 0,
      debtCents: 750,
      confirmedAt: null,
      discountCents: 250,
    };
    const createSale = jest.fn().mockResolvedValue(sale);
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
    expect(result).toEqual({ ok: true, ...sale });
    expect(currentCart.items).toEqual([]);
    expect(currentCart.idempotencyKey).toBe('');
    expect(currentCart.expectedTotalCents).toBeUndefined();
  });

  it('success with discountCents=0 → success envelope includes 0', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: '',
    };
    const store = stubStoreWithCart(cart);
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
      discountCents: 0,
    };
    const createSale = jest.fn().mockResolvedValue(sale);
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
    expect(result).toEqual({ ok: true, ...sale });
    expect((result as { discountCents: number }).discountCents).toBe(0);
  });

  it('after PROMO_RE_QUOTE clears the key, the next createSale mints a fresh UUID v4', async () => {
    const cart = {
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
      idempotencyKey: '',
      expectedTotalCents: 1000,
    };
    const promoErr = new UpstreamError(
      'promo',
      409,
      {
        error: 'PROMO_RE_QUOTE',
        recomputedTotalCents: 900,
        expectedTotalCents: 1000,
        discountCents: 100,
      },
      'PROMO_RE_QUOTE',
    );
    let currentCart = cart;
    const store = {
      get: jest.fn().mockImplementation(async () => ({
        senderId: 's',
        lastMessageAt: '2026-06-23T12:00:00.000Z',
        data: { cart: currentCart },
      })),
      update: jest
        .fn()
        .mockImplementation(
          async (_: string, patch: Record<string, unknown>) => {
            const d = (patch as { data: { cart?: typeof currentCart } }).data;
            if (d.cart) currentCart = d.cart;
            return { senderId: 's', ...patch };
          },
        ),
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
      discountCents: 0,
    };
    const createSale = jest
      .fn()
      .mockRejectedValueOnce(promoErr)
      .mockResolvedValueOnce(sale);
    const deps = {
      ...baseDeps,
      chatbotApi: { createSale } as unknown as ChatbotApiClient,
      store,
    };
    const tool = makeCreateSaleTool(deps);
    const inputArgs = {
      customerId: '00000000-4000-9000-0000-000000000099',
      items: [
        {
          productId: '00000000-4000-9000-0000-000000000001',
          productName: 'Croquetas',
          quantity: 1,
          unitPriceCents: 1000,
        },
      ],
    };
    // First call: PROMO_RE_QUOTE → mints K1, persists, fails with promoReQuote, clears key.
    const r1 = await tool.execute(inputArgs, {
      toolCallId: 't',
      messages: [],
      context: { senderId: 's' },
    });
    expect(r1).toMatchObject({ ok: false, error: { kind: 'promoReQuote' } });
    const firstDto = createSale.mock.calls[0]![0];
    const firstKey = createSale.mock.calls[0]![1];
    // First outgoing DTO carried the cart's 1000.
    expect(firstDto.expectedTotalCents).toBe(1000);
    // After PROMO_RE_QUOTE: recomputed total persisted, key cleared.
    expect(currentCart.expectedTotalCents).toBe(900);
    expect(currentCart.idempotencyKey).toBe('');
    // Second call: mints a fresh UUID v4 structurally different from firstKey.
    await tool.execute(inputArgs, {
      toolCallId: 't',
      messages: [],
      context: { senderId: 's' },
    });
    const secondDto = createSale.mock.calls[1]![0];
    const secondKey = createSale.mock.calls[1]![1];
    // Second outgoing DTO carries the recomputed 900 (no stale-total loop).
    expect(secondDto.expectedTotalCents).toBe(900);
    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
