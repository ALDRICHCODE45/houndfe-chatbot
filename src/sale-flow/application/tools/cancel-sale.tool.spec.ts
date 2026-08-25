/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { makeCancelSaleTool } from './cancel-sale.tool';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import type { CancelSaleResult } from '../../../chatbot-api/domain/dtos/sales.dto';
import {
  ChatbotApiError,
  UpstreamError,
} from '../../../chatbot-api/domain/errors';
import type {
  ConversationState,
  ConversationStore,
} from '../../../conversation/domain/conversation-store';

/**
 * Unit tests for the 11th AI-SDK tool factory `cancelSale` (design.md §e).
 *
 * Spec scenarios (sale-flow-tools spec §cancelSale):
 *   (a) happy path: returns { ok: true, ...CancelSaleResult }, clears placedSaleId
 *   (b) missing-placedSaleId guard: returns {missingPlacedSaleId, false}, NO HTTP call
 *   (c) reason='CUSTOMER_REQUEST' + cashierUserId from deps (never model input)
 *   (d) SALE_NOT_FOUND (404) → {saleNotFound, false} + clears placedSaleId
 *   (e) SALE_DELIVERED_CANNOT_CANCEL (409) → {saleNotCancellable, false} + clears placedSaleId
 *   (f) IDEMPOTENCY_KEY_IN_FLIGHT (409) → {idempotencyInFlight, true} + PRESERVES placedSaleId
 *   (g) unknown code (422) → {validation, false} + PRESERVES placedSaleId (safe degradation)
 *   (h) already-canceled sale returns replay success (200 status:'CANCELED'), clears id
 *   (i) inputSchema rejects extras (z.object({}).strict())
 */
describe('makeCancelSaleTool', () => {
  const CASHIER = '00000000-4000-9000-0000-000000000001';

  function stubStore(initial: ConversationState | null): {
    store: jest.Mocked<ConversationStore>;
    update: jest.Mock;
  } {
    let current = initial;
    const update = jest
      .fn()
      .mockImplementation((senderId: string, patch: object) => {
        const next = {
          senderId,
          lastMessageAt: (patch as { lastMessageAt: string }).lastMessageAt,
          data: (patch as { data: object }).data,
        };
        current = next;
        return next;
      });
    const store = {
      get: jest.fn().mockImplementation(() => Promise.resolve(current)),
      create: jest.fn(),
      update,
    } as unknown as jest.Mocked<ConversationStore>;
    return { store, update };
  }

  const sampleResult: CancelSaleResult = {
    saleId: 'sale-1',
    status: 'CANCELED',
    refundedCents: 0,
    restockedItems: [{ productId: 'p-1', variantId: null, quantity: 2 }],
    canceledAt: '2026-08-25T12:00:00.000Z',
  };

  it('exposes description + Zod inputSchema (strict, empty) + execute + contextSchema', () => {
    const tool = makeCancelSaleTool({
      chatbotApi: {} as ChatbotApiClient,
      store: {} as ConversationStore,
      cashierUserId: CASHIER,
    });
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('inputSchema accepts an empty object {}', () => {
    const tool = makeCancelSaleTool({
      chatbotApi: {} as ChatbotApiClient,
      store: {} as ConversationStore,
      cashierUserId: CASHIER,
    });
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });

  it('inputSchema rejects an object with extra keys (strict)', () => {
    const tool = makeCancelSaleTool({
      chatbotApi: {} as ChatbotApiClient,
      store: {} as ConversationStore,
      cashierUserId: CASHIER,
    });
    expect(tool.inputSchema.safeParse({ extra: 'x' }).success).toBe(false);
  });

  it('inputSchema rejects undefined (schema is required, not optional)', () => {
    const tool = makeCancelSaleTool({
      chatbotApi: {} as ChatbotApiClient,
      store: {} as ConversationStore,
      cashierUserId: CASHIER,
    });
    expect(tool.inputSchema.safeParse(undefined).success).toBe(false);
  });

  it('(a) happy path: calls cancelSale with placedSaleId + fixed reason/cashier, clears placedSaleId, returns { ok: true, ...result }', async () => {
    const state: ConversationState = {
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    };
    const { store, update } = stubStore(state);
    const cancelSale = jest.fn().mockResolvedValue(sampleResult);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(cancelSale).toHaveBeenCalledTimes(1);
    expect(cancelSale).toHaveBeenCalledWith('sale-1', {
      reason: 'CUSTOMER_REQUEST',
      cashierUserId: CASHIER,
    });
    expect(result).toEqual({ ok: true, ...sampleResult });
    // placedSaleId was cleared in the durable write.
    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect('placedSaleId' in patch.data).toBe(false);
  });

  it('(b) missing-placedSaleId guard returns {missingPlacedSaleId, false} without any HTTP call', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: {},
    });
    const cancelSale = jest.fn();
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(cancelSale).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: { kind: 'missingPlacedSaleId', retryable: false },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('(c) outgoing DTO is fixed: reason=CUSTOMER_REQUEST and cashierUserId is injected from deps (never model-supplied)', async () => {
    const { store } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    const cancelSale = jest.fn().mockResolvedValue(sampleResult);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: 'boot-injected-cashier-id',
    });
    await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(cancelSale).toHaveBeenCalledWith('sale-1', {
      reason: 'CUSTOMER_REQUEST',
      cashierUserId: 'boot-injected-cashier-id',
    });
  });

  it('(d) SALE_NOT_FOUND (404) → {saleNotFound, false} and clears placedSaleId (stale id)', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    const err = new UpstreamError(
      'not found',
      404,
      {
        error: 'SALE_NOT_FOUND',
        message: 'Sale not found',
      },
      'SALE_NOT_FOUND',
    );
    const cancelSale = jest.fn().mockRejectedValue(err);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'saleNotFound', retryable: false },
    });
    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect('placedSaleId' in patch.data).toBe(false);
  });

  it('(e) SALE_DELIVERED_CANNOT_CANCEL (409) → {saleNotCancellable, false} and clears placedSaleId', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    const err = new UpstreamError(
      'delivered',
      409,
      {
        error: 'SALE_DELIVERED_CANNOT_CANCEL',
        message: 'Sale already delivered',
      },
      'SALE_DELIVERED_CANNOT_CANCEL',
    );
    const cancelSale = jest.fn().mockRejectedValue(err);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'saleNotCancellable', retryable: false },
    });
    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect('placedSaleId' in patch.data).toBe(false);
  });

  it('(f) IDEMPOTENCY_KEY_IN_FLIGHT (409) → {idempotencyInFlight, true} and PRESERVES placedSaleId', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    const err = new UpstreamError(
      'in-flight',
      409,
      { error: 'IDEMPOTENCY_KEY_IN_FLIGHT' },
      'IDEMPOTENCY_KEY_IN_FLIGHT',
    );
    const cancelSale = jest.fn().mockRejectedValue(err);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'idempotencyInFlight', retryable: true },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('(g) unknown errorCode with 4xx status → falls back to status mapping + PRESERVES placedSaleId (safe degradation)', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    const err = new UpstreamError(
      'future',
      422,
      { error: 'SOME_FUTURE_CODE' },
      'SOME_FUTURE_CODE',
    );
    const cancelSale = jest.fn().mockRejectedValue(err);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'validation', retryable: false },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('(h) replay success: out-of-band CANCELED sale resolves as success, clears placedSaleId', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    const replay: CancelSaleResult = {
      saleId: 'sale-1',
      status: 'CANCELED',
      refundedCents: 0,
      restockedItems: [],
      canceledAt: '2026-08-24T10:00:00.000Z',
    };
    const cancelSale = jest.fn().mockResolvedValue(replay);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(result).toEqual({ ok: true, ...replay });
    expect(update).toHaveBeenCalledTimes(1);
    const [, patch] = update.mock.calls[0] as [
      string,
      { data: Record<string, unknown> },
    ];
    expect('placedSaleId' in patch.data).toBe(false);
  });

  it('non-ChatbotApiError (e.g. BranchMismatchError) rethrows — config defect, never mapped', async () => {
    const { store } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    class BranchMismatchError extends Error {}
    const cancelSale = jest
      .fn()
      .mockRejectedValue(new BranchMismatchError('branch'));
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    await expect(
      tool.execute(
        {},
        { toolCallId: 't', messages: [], context: { senderId: 's' } },
      ),
    ).rejects.toBeInstanceOf(BranchMismatchError);
  });

  it('ChatbotApiError without errorCode falls back to status mapping + PRESERVES placedSaleId (unknown code)', async () => {
    const { store, update } = stubStore({
      senderId: 's',
      lastMessageAt: '2026-06-23T12:00:00.000Z',
      data: { placedSaleId: 'sale-1' },
    });
    // 5xx with no errorCode: maps to {upstream, true}.
    const err = new ChatbotApiError('boom', 500, { message: 'boom' }, null);
    const cancelSale = jest.fn().mockRejectedValue(err);
    const tool = makeCancelSaleTool({
      chatbotApi: { cancelSale } as unknown as ChatbotApiClient,
      store,
      cashierUserId: CASHIER,
    });
    const result = await tool.execute(
      {},
      { toolCallId: 't', messages: [], context: { senderId: 's' } },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
    // No clear write — unknown / transient codes preserve the id so the
    // model can retry the same call later (ADR-18).
    expect(update).not.toHaveBeenCalled();
  });
});
