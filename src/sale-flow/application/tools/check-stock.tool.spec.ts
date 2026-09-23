import { makeCheckStockTool as makeCheckStockToolRaw } from './check-stock.tool';
import type { ToolDeps } from '../tool-deps';
import { asSchemaVerifiedTool } from '../../../../test/fixtures/sale-flow-tool-schema';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import {
  NotFoundError,
  UpstreamError,
} from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
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
const makeCheckStockTool = (deps: ToolDeps) =>
  asSchemaVerifiedTool(makeCheckStockToolRaw(deps));

describe('makeCheckStockTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-0000-4000-8000-000000000001',
    humanHandoffService: {} as never,
  };

  it('returns the same tool and inputSchema references without reimplementing the schema', () => {
    const rawTool = makeCheckStockToolRaw({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const verified = asSchemaVerifiedTool(rawTool);

    expect(verified).toBe(rawTool);
    expect(verified.inputSchema).toBe(rawTool.inputSchema);
  });

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
      { toolCallId: 't', messages: [], context: {} },
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
        { toolCallId: 't', messages: [], context: {} },
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
        { toolCallId: 't', messages: [], context: {} },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });

  // ─── sale-flow-tools spec §"checkStock returns a humanAssistance
  // envelope on out_of_stock" (R7) ─────────────────────────────────────
  describe('humanAssistance envelope (R7)', () => {
    const uuid1 = '00000000-0000-4000-8000-000000000001';
    const uuid2 = '00000000-0000-4000-8000-000000000002';

    it('adds the envelope on out_of_stock, sourcing digest.name from the catalog response', async () => {
      const stock: StockCheckResponse = {
        productId: uuid1,
        name: 'Café Molido 500g',
        stock: { status: 'out_of_stock', quantity: 0 },
        variants: [],
      };
      const getStock = jest.fn().mockResolvedValue(stock);
      const deps = {
        ...baseDeps,
        chatbotApi: { getStock } as unknown as ChatbotApiClient,
      };
      const tool = makeCheckStockTool(deps);

      const result = await tool.execute(
        { productId: uuid1, variantId: uuid2 },
        { toolCallId: 't', messages: [], context: {} },
      );

      expect(result).toEqual({
        ok: true,
        ...stock,
        humanAssistance: {
          kind: 'out_of_stock',
          digest: {
            productId: uuid1,
            name: 'Café Molido 500g',
            variantId: uuid2,
            quantity: 0,
          },
        },
      });
    });

    it('prefers the model-supplied input.name over the catalog name', async () => {
      const stock: StockCheckResponse = {
        productId: uuid1,
        name: 'Nombre del catálogo',
        stock: { status: 'out_of_stock', quantity: 0 },
        variants: [],
      };
      const getStock = jest.fn().mockResolvedValue(stock);
      const tool = makeCheckStockTool({
        ...baseDeps,
        chatbotApi: { getStock } as unknown as ChatbotApiClient,
      });

      const result = await tool.execute(
        { productId: uuid1, name: 'Nombre del input' },
        { toolCallId: 't', messages: [], context: {} },
      );

      expect(result).toEqual({
        ok: true,
        ...stock,
        humanAssistance: {
          kind: 'out_of_stock',
          digest: { productId: uuid1, name: 'Nombre del input', quantity: 0 },
        },
      });
    });

    it('does NOT carry the envelope for available / low_stock / not_managed', async () => {
      for (const status of ['available', 'low_stock', 'not_managed'] as const) {
        const stock: StockCheckResponse = {
          productId: uuid1,
          name: 'X',
          stock: { status, quantity: 5 },
          variants: [],
        };
        const getStock = jest.fn().mockResolvedValue(stock);
        const tool = makeCheckStockTool({
          ...baseDeps,
          chatbotApi: { getStock } as unknown as ChatbotApiClient,
        });

        const result = await tool.execute(
          { productId: uuid1 },
          { toolCallId: 't', messages: [], context: {} },
        );

        expect(result).toEqual({ ok: true, ...stock });
        expect(result).not.toHaveProperty('humanAssistance');
      }
    });

    it('does NOT call HumanHandoffService — the envelope is a signal only', async () => {
      const stock: StockCheckResponse = {
        productId: uuid1,
        name: 'X',
        stock: { status: 'out_of_stock', quantity: 0 },
        variants: [],
      };
      const getStock = jest.fn().mockResolvedValue(stock);
      const humanHandoffService = { create: jest.fn() };
      const tool = makeCheckStockTool({
        ...baseDeps,
        humanHandoffService: humanHandoffService as never,
        chatbotApi: { getStock } as unknown as ChatbotApiClient,
      });

      await tool.execute(
        { productId: uuid1 },
        { toolCallId: 't', messages: [], context: {} },
      );

      expect(humanHandoffService.create).not.toHaveBeenCalled();
    });
  });
});
