import { CatalogSession } from '../../../conversation/domain/catalog-references';
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

const productId = '00000000-0000-4000-8000-000000000001';
const variantId = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const stock = (): StockCheckResponse => ({
  productId,
  name: 'Café Molido 500g',
  stock: { status: 'out_of_stock', quantity: 0 },
  variants: [
    {
      variantId,
      name: '500g',
      option: null,
      value: null,
      stock: { status: 'out_of_stock', quantity: 0 },
    },
  ],
});
const baseDeps = {
  store: {} as ConversationStore,
  cashierUserId: productId,
  humanHandoffService: {} as never,
};
const makeCheckStockTool = (deps: ToolDeps) =>
  asSchemaVerifiedTool(makeCheckStockToolRaw(deps));
function context() {
  const catalogSession = new CatalogSession('sender', 60000, 0);
  catalogSession.installSearch(catalogSession.beginSearch(), [stock()]);
  return { catalogSession };
}
function setup(response = stock()) {
  const getStock = jest.fn().mockResolvedValue(response);
  const humanHandoffService = { create: jest.fn() };
  const tool = makeCheckStockTool({
    ...baseDeps,
    chatbotApi: { getStock } as unknown as ChatbotApiClient,
    humanHandoffService: humanHandoffService as never,
  });
  return { tool, getStock, humanHandoffService };
}

describe('makeCheckStockTool', () => {
  it('blocks an ungrounded UUID before any backend GET', async () => {
    const { tool, getStock } = setup();
    const result = await tool.execute(
      { productId: '00000000-0000-4000-8000-000000000099' },
      { toolCallId: 'ungrounded', messages: [], context: {} },
    );
    expect(getStock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a forged session even when a direct caller bypasses SDK validation', async () => {
    const forged = Object.assign(
      Object.create(CatalogSession.prototype) as CatalogSession,
      { matches: () => true },
    );
    const { tool, getStock } = setup();
    await expect(
      tool.execute(
        { productId },
        {
          toolCallId: 't',
          messages: [],
          context: { catalogSession: forged },
        },
      ),
    ).resolves.toMatchObject({ ok: false });
    expect(getStock).not.toHaveBeenCalled();
  });

  it('handles a grounded product without variants using the fresh backend name', async () => {
    const response = { ...stock(), name: 'Updated backend name', variants: [] };
    const { tool } = setup(response);
    const catalogSession = new CatalogSession('sender', 60000, 0);
    catalogSession.installSearch(catalogSession.beginSearch(), [
      { ...stock(), variants: [] },
    ]);
    await expect(
      tool.execute(
        { productId, name: stock().name },
        {
          toolCallId: 't',
          messages: [],
          context: { catalogSession },
        },
      ),
    ).resolves.toEqual({
      ok: true,
      ...response,
      humanAssistance: {
        kind: 'out_of_stock',
        digest: { productId, name: response.name },
      },
    });
  });

  it('does not escalate a grounded variant absent from fresh backend stock', async () => {
    const response = { ...stock(), variants: [] };
    const { tool, getStock } = setup(response);
    await expect(
      tool.execute(
        { productId, variantId },
        {
          toolCallId: 't',
          messages: [],
          context: context(),
        },
      ),
    ).resolves.toEqual({ ok: true, ...response });
    expect(getStock).toHaveBeenCalledTimes(1);
  });

  it('returns the same tool and inputSchema references without reimplementing the schema', () => {
    const rawTool = makeCheckStockToolRaw({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const verified = asSchemaVerifiedTool(rawTool);
    expect(verified).toBe(rawTool);
    expect(verified.inputSchema).toBe(rawTool.inputSchema);
  });

  it('rejects a non-UUID productId at the schema layer', () => {
    expect(
      setup().tool.inputSchema.safeParse({ productId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it.each([
    { productId: otherId },
    { productId, variantId: otherId },
    { productId, name: 'Nombre del input' },
  ])('blocks forged identity %j before GET', async (input) => {
    const { tool, getStock, humanHandoffService } = setup();
    const result = await tool.execute(input, {
      toolCallId: 't',
      messages: [],
      context: context(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'catalog_identity_unverified' },
    });
    expect(getStock).not.toHaveBeenCalled();
    expect(humanHandoffService.create).not.toHaveBeenCalled();
  });

  it('forwards grounded productId and sources the signal from fresh backend stock', async () => {
    const { tool, getStock, humanHandoffService } = setup();
    const result = await tool.execute(
      { productId, variantId, name: stock().name },
      { toolCallId: 't', messages: [], context: context() },
    );
    expect(getStock).toHaveBeenCalledWith(productId);
    expect(result).toEqual({
      ok: true,
      ...stock(),
      humanAssistance: {
        kind: 'out_of_stock',
        digest: { productId, variantId, name: stock().name },
      },
    });
    expect(humanHandoffService.create).not.toHaveBeenCalled();
  });

  it.each([
    [new NotFoundError('x', 404), 'notFound', false],
    [new UpstreamError('x', 500), 'upstream', true],
  ] as const)(
    'maps backend error %s after validation',
    async (error, kind, retryable) => {
      const { tool, getStock } = setup();
      getStock.mockRejectedValue(error);
      await expect(
        tool.execute(
          { productId },
          { toolCallId: 't', messages: [], context: context() },
        ),
      ).resolves.toEqual({ ok: false, error: { kind, retryable } });
    },
  );

  it.each(['available', 'low_stock', 'not_managed'] as const)(
    'does not carry an escalation envelope for fresh %s stock',
    async (status) => {
      const response = { ...stock(), stock: { status, quantity: 5 } };
      const { tool } = setup(response);
      await expect(
        tool.execute(
          { productId },
          { toolCallId: 't', messages: [], context: context() },
        ),
      ).resolves.toEqual({ ok: true, ...response });
    },
  );

  it('does not signal escalation for a mismatched backend product or newly available variant', async () => {
    const changed = stock();
    changed.variants[0].stock = { status: 'available', quantity: 2 };
    for (const response of [{ ...stock(), productId: otherId }, changed]) {
      const { tool } = setup(response);
      await expect(
        tool.execute(
          { productId, variantId },
          { toolCallId: 't', messages: [], context: context() },
        ),
      ).resolves.toEqual({ ok: true, ...response });
    }
  });
});
