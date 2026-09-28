import {
  CatalogSession,
  CATALOG_RECOVERY,
} from '../../../conversation/domain/catalog-references';
import {
  StockReadEvidence,
  type StockReadExecutionObserver,
  type StockReadReceiptInput,
} from '../../../llm-agent/domain/stock-read-evidence';
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
function recordingObserver(step = 2, serverTurnId = 'turn-1') {
  const receipts: StockReadReceiptInput[] = [];
  const observer: StockReadExecutionObserver = {
    serverTurnId,
    step,
    recordExecution: (receipt) => {
      receipts.push(receipt);
    },
  };
  return { observer, receipts };
}
/** Delay the stock GET until the caller resolves it, returning the resolver. */
function deferStock(readStock: jest.Mock) {
  let resolveStock!: (value: StockCheckResponse) => void;
  readStock.mockImplementation(
    () =>
      new Promise<StockCheckResponse>((resolve) => {
        resolveStock = resolve;
      }),
  );
  return (value: StockCheckResponse) => resolveStock(value);
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

  it('records a genuine receipt through the observer and preserves the envelope', async () => {
    const { tool, getStock } = setup();
    const { observer, receipts } = recordingObserver(3, 'turn-9');
    const result = await tool.execute(
      { productId, variantId, name: stock().name },
      {
        toolCallId: 'call-9',
        messages: [],
        context: { ...context(), stockReadObserver: observer },
      },
    );
    const envelope = {
      ok: true,
      ...stock(),
      humanAssistance: {
        kind: 'out_of_stock',
        digest: { productId, variantId, name: stock().name },
      },
    };
    expect(getStock).toHaveBeenCalledWith(productId);
    expect(result).toEqual(envelope);
    expect(receipts).toEqual([
      {
        serverTurnId: 'turn-9',
        toolCallId: 'call-9',
        step: 3,
        subject: {
          productId,
          productName: stock().name,
          variantId,
          variantName: '500g',
        },
        catalogGenerationBefore: 1,
        catalogGenerationAfter: 1,
        output: envelope,
      },
    ]);
  });

  it('records subject:null and skips the backend GET for a rejected identity', async () => {
    const { tool, getStock } = setup();
    const { observer, receipts } = recordingObserver(1, 'turn-2');
    const result = await tool.execute(
      { productId: otherId },
      {
        toolCallId: 'call-2',
        messages: [],
        context: { ...context(), stockReadObserver: observer },
      },
    );
    expect(getStock).not.toHaveBeenCalled();
    expect(result).toEqual(CATALOG_RECOVERY);
    expect(receipts).toEqual([
      {
        serverTurnId: 'turn-2',
        toolCallId: 'call-2',
        step: 1,
        subject: null,
        catalogGenerationBefore: 1,
        catalogGenerationAfter: 1,
        output: CATALOG_RECOVERY,
      },
    ]);
  });

  it('uses the invalid generation sentinel when no genuine session exists', async () => {
    const { tool, getStock } = setup();
    const { observer, receipts } = recordingObserver(0, 'turn-3');
    const result = await tool.execute(
      { productId },
      {
        toolCallId: 'call-3',
        messages: [],
        context: { stockReadObserver: observer },
      },
    );
    expect(getStock).not.toHaveBeenCalled();
    expect(result).toEqual(CATALOG_RECOVERY);
    expect(receipts[0]).toMatchObject({
      serverTurnId: 'turn-3',
      toolCallId: 'call-3',
      subject: null,
      catalogGenerationBefore: -1,
      catalogGenerationAfter: -1,
    });
  });

  it('marks catalog_changed when a byte-identical search installs during the GET', async () => {
    const { tool, getStock } = setup();
    const session = new CatalogSession('sender', 60000, 0);
    session.installSearch(session.beginSearch(), [stock()]);
    const { observer, receipts } = recordingObserver(0, 'turn-4');
    const resolveStock = deferStock(getStock);
    const pending = tool.execute(
      { productId, variantId },
      {
        toolCallId: 'call-4',
        messages: [],
        context: { catalogSession: session, stockReadObserver: observer },
      },
    );
    const ticket = session.beginSearch();
    session.installSearch(ticket, [stock()]);
    resolveStock(stock());
    await expect(pending).resolves.toEqual({
      ok: true,
      ...stock(),
      humanAssistance: {
        kind: 'out_of_stock',
        digest: { productId, variantId, name: stock().name },
      },
    });
    expect(receipts[0]).toMatchObject({
      catalogGenerationBefore: 1,
      catalogGenerationAfter: 2,
      subject: {
        productId,
        productName: stock().name,
        variantId,
        variantName: '500g',
      },
    });
    const evidence = new StockReadEvidence('turn-4');
    evidence.recordExecution(receipts[0]);
    evidence.admitCompletedStep(0, [
      {
        toolCallId: 'call-4',
        toolName: 'checkStock',
        input: { productId, variantId },
        outcome: 'result',
      },
    ]);
    expect(evidence.getLatestCompleted({ productId, variantId })).toMatchObject(
      { kind: 'unconfirmed', reason: 'catalog_changed' },
    );
  });

  it('records a mapped backend failure that revokes admitted evidence', async () => {
    const evidence = new StockReadEvidence('turn-5');
    evidence.recordExecution({
      serverTurnId: 'turn-5',
      toolCallId: 'seed',
      step: 0,
      subject: {
        productId,
        productName: stock().name,
        variantId: null,
        variantName: null,
      },
      catalogGenerationBefore: 1,
      catalogGenerationAfter: 1,
      output: { ok: true, ...stock() },
    });
    evidence.admitCompletedStep(0, [
      {
        toolCallId: 'seed',
        toolName: 'checkStock',
        input: { productId },
        outcome: 'result',
      },
    ]);
    expect(
      evidence.getLatestVerifiedShortage({ productId, variantId: null }, 1),
    ).not.toBeNull();

    const observer: StockReadExecutionObserver = {
      serverTurnId: 'turn-5',
      step: 1,
      recordExecution: (receipt) => evidence.recordExecution(receipt),
    };
    const { tool, getStock } = setup();
    getStock.mockRejectedValue(new NotFoundError('missing', 404));
    await expect(
      tool.execute(
        { productId },
        {
          toolCallId: 'fail',
          messages: [],
          context: { ...context(), stockReadObserver: observer },
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'notFound', retryable: false },
    });

    evidence.admitCompletedStep(1, [
      {
        toolCallId: 'fail',
        toolName: 'checkStock',
        input: { productId },
        outcome: 'result',
      },
    ]);
    expect(
      evidence.getLatestVerifiedShortage({ productId, variantId: null }, 2),
    ).toBeNull();
    expect(
      evidence.getLatestCompleted({ productId, variantId: null }),
    ).toMatchObject({ kind: 'unconfirmed', reason: 'backend_error' });
  });

  it('sources the canonical variant name from the catalog, not the stock DTO', async () => {
    const response: StockCheckResponse = {
      ...stock(),
      variants: [
        {
          variantId,
          name: 'Presentación actualizada 900 g',
          option: null,
          value: null,
          stock: { status: 'out_of_stock', quantity: 0 },
        },
      ],
    };
    const { tool } = setup(response);
    const { observer, receipts } = recordingObserver(2, 'turn-6');
    await tool.execute(
      { productId, variantId, name: stock().name },
      {
        toolCallId: 'call-6',
        messages: [],
        context: { ...context(), stockReadObserver: observer },
      },
    );
    expect(receipts[0].subject).toEqual({
      productId,
      productName: stock().name,
      variantId,
      variantName: '500g',
    });
  });

  it('records subject:null when the catalog reference expires during the GET', async () => {
    let now = 1000;
    const session = new CatalogSession(
      'sender',
      100,
      0,
      undefined,
      [],
      () => now,
    );
    session.installSearch(session.beginSearch(), [stock()]);
    const { tool, getStock } = setup();
    const { observer, receipts } = recordingObserver(0, 'turn-7');
    const resolveStock = deferStock(getStock);
    const pending = tool.execute(
      { productId },
      {
        toolCallId: 'call-7',
        messages: [],
        context: { catalogSession: session, stockReadObserver: observer },
      },
    );
    now = 2000;
    resolveStock(stock());
    await pending;
    expect(receipts[0]).toMatchObject({
      catalogGenerationBefore: 1,
      catalogGenerationAfter: 1,
      subject: null,
    });
  });

  it('preserves the exact envelope when no observer is installed', async () => {
    const { tool, getStock } = setup();
    await expect(
      tool.execute(
        { productId, variantId, name: stock().name },
        { toolCallId: 'call-8', messages: [], context: context() },
      ),
    ).resolves.toEqual({
      ok: true,
      ...stock(),
      humanAssistance: {
        kind: 'out_of_stock',
        digest: { productId, variantId, name: stock().name },
      },
    });
    expect(getStock).toHaveBeenCalledTimes(1);
  });

  it('never changes the tool output when the observer throws', async () => {
    const { tool } = setup();
    const observer: StockReadExecutionObserver = {
      serverTurnId: 'turn-9b',
      step: 1,
      recordExecution: () => {
        throw new Error('observer failure');
      },
    };
    await expect(
      tool.execute(
        { productId, variantId },
        {
          toolCallId: 'call-9b',
          messages: [],
          context: { ...context(), stockReadObserver: observer },
        },
      ),
    ).resolves.toEqual({
      ok: true,
      ...stock(),
      humanAssistance: {
        kind: 'out_of_stock',
        digest: { productId, variantId, name: stock().name },
      },
    });
  });

  it('skips the receipt when the SDK call id is not genuine', async () => {
    const { tool } = setup();
    const { observer, receipts } = recordingObserver(1, 'turn-10');
    await tool.execute(
      { productId, variantId },
      {
        toolCallId: '',
        messages: [],
        context: { ...context(), stockReadObserver: observer },
      },
    );
    expect(receipts).toEqual([]);
  });

  it('does not default a missing observer step to zero', async () => {
    const { tool } = setup();
    const receipts: StockReadReceiptInput[] = [];
    const observer = {
      serverTurnId: 'turn-12',
      recordExecution: (receipt: StockReadReceiptInput) =>
        receipts.push(receipt),
    } as unknown as StockReadExecutionObserver;
    await tool.execute(
      { productId, variantId },
      {
        toolCallId: 'call-12',
        messages: [],
        context: { ...context(), stockReadObserver: observer },
      },
    );
    expect(receipts).toEqual([]);
  });
});
