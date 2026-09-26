import { makeSearchCatalogTool as makeSearchCatalogToolRaw } from './search-catalog.tool';
import type { ToolDeps } from '../tool-deps';
import { asSchemaVerifiedTool } from '../../../../test/fixtures/sale-flow-tool-schema';
import type { ChatbotApiClient } from '../../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../../chatbot-api/domain/errors';
import type { ConversationStore } from '../../../conversation/domain/conversation-store';
import type { CatalogItemResponse } from '../../../chatbot-api/domain/dtos/catalog.dto';

/**
 * Unit tests for the searchCatalog tool factory.
 *
 * Spec scenarios:
 *   - Maps q + limit to chatbotApi.searchCatalog (limit default 10)
 *   - Rejects limit 0 / 21 (out of AGENTS.md §4.4.1 bounds)
 *   - Returns { ok: true, results } on success
 *   - Returns { ok: false, error: { kind: 'upstream', retryable: true } } on 5xx
 *   - Does not propagate the thrown ChatbotApiError
 */
const makeSearchCatalogTool = (deps: ToolDeps) =>
  asSchemaVerifiedTool(makeSearchCatalogToolRaw(deps));

describe('makeSearchCatalogTool', () => {
  const baseDeps = {
    store: {} as ConversationStore,
    cashierUserId: '00000000-0000-4000-8000-000000000001',
    humanHandoffService: {} as never,
  };

  it('guides main-name search and preserves real out-of-stock candidates', () => {
    const tool = makeSearchCatalogTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    expect(tool.description).toContain('nombre principal');
    expect(tool.description).toContain('incluidos los agotados');
    expect(tool.description).toContain('pasos 2–5');
    const schema = tool.inputSchema as unknown as {
      shape: { q: { description?: string } };
    };
    expect(schema.shape.q.description).toContain('ibuprofeno');
    expect(schema.shape.q.description).toContain('dosis y forma');
    expect(schema.shape.q.description).toContain('no como filtro inicial');
  });

  it('keeps an empty success distinct from an error without rewriting the query', async () => {
    const searchCatalog = jest.fn().mockResolvedValue([]);
    const tool = makeSearchCatalogTool({
      ...baseDeps,
      chatbotApi: { searchCatalog } as unknown as ChatbotApiClient,
    });
    await expect(
      tool.execute(tool.inputSchema.parse({ q: 'ibuprofeno de 400 mg' }), {
        toolCallId: 't',
        messages: [],
        context: {},
      }),
    ).resolves.toEqual({ ok: true, results: [] });
    expect(searchCatalog).toHaveBeenCalledWith('ibuprofeno de 400 mg', 10);
    expect(searchCatalog).toHaveBeenCalledTimes(1);
  });

  it('forwards q + limit (default 10) to chatbotApi.searchCatalog and returns { ok: true, results }', async () => {
    const results: CatalogItemResponse[] = [
      {
        productId: 'p1',
        name: 'Croquetas premium',
        brand: 'HoundFe',
        imageUrl: null,
        description: null,
        price: {
          priceCents: 1000,
          fromPriceCents: null,
          promoPriceCents: null,
          promotionEvaluationStatus: 'needs_human_review',
        },
        stock: { status: 'available', quantity: 10 },
        packageInfo: { weightGrams: null, dimensions: null },
        variants: [],
      },
    ];
    const searchCatalog = jest.fn().mockResolvedValue(results);
    const deps = {
      ...baseDeps,
      chatbotApi: { searchCatalog } as unknown as ChatbotApiClient,
    };
    const tool = makeSearchCatalogTool(deps);

    const result = await tool.execute(
      { q: 'croquetas', limit: 5 },
      { toolCallId: 't', messages: [], context: {} },
    );
    expect(searchCatalog).toHaveBeenCalledWith('croquetas', 5);
    expect(result).toEqual({ ok: true, results });
  });

  it('defaults limit to 10 when omitted', async () => {
    const searchCatalog = jest.fn().mockResolvedValue([]);
    const deps = {
      ...baseDeps,
      chatbotApi: { searchCatalog } as unknown as ChatbotApiClient,
    };
    const tool = makeSearchCatalogTool(deps);

    // Mirror the AI-SDK contract: schema.parse applies the default BEFORE
    // the SDK invokes execute(); calling execute() with the parsed input
    // is how callers without the SDK plumbing exercise the tool.
    const parsed = tool.inputSchema.parse({ q: 'croquetas' });
    await tool.execute(parsed, {
      toolCallId: 't',
      messages: [],
      context: {},
    });
    expect(searchCatalog).toHaveBeenCalledWith('croquetas', 10);
  });

  it('rejects limit 0 at the schema layer (AGENTS.md §4.4.1)', () => {
    const tool = makeSearchCatalogTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ q: 'x', limit: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects limit 21 at the schema layer (above AGENTS.md §4.4.1 max)', () => {
    const tool = makeSearchCatalogTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ q: 'x', limit: 21 });
    expect(r.success).toBe(false);
  });

  it('rejects empty q at the schema layer (AGENTS.md §4.4.1)', () => {
    const tool = makeSearchCatalogTool({
      ...baseDeps,
      chatbotApi: {} as ChatbotApiClient,
    });
    const r = tool.inputSchema.safeParse({ q: '' });
    expect(r.success).toBe(false);
  });

  it('catches an UpstreamError (5xx) into a retryable upstream envelope without rethrowing', async () => {
    const searchCatalog = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', 503));
    const deps = {
      ...baseDeps,
      chatbotApi: { searchCatalog } as unknown as ChatbotApiClient,
    };
    const tool = makeSearchCatalogTool(deps);

    await expect(
      tool.execute(tool.inputSchema.parse({ q: 'x' }), {
        toolCallId: 't',
        messages: [],
        context: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
    expect(searchCatalog).toHaveBeenCalledTimes(1);
  });

  it('catches an UpstreamError(null statusCode) into a retryable upstream envelope', async () => {
    const searchCatalog = jest
      .fn()
      .mockRejectedValue(new UpstreamError('boom', null));
    const deps = {
      ...baseDeps,
      chatbotApi: { searchCatalog } as unknown as ChatbotApiClient,
    };
    const tool = makeSearchCatalogTool(deps);

    await expect(
      tool.execute(tool.inputSchema.parse({ q: 'x' }), {
        toolCallId: 't',
        messages: [],
        context: {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'upstream', retryable: true },
    });
  });
});
