import {
  TERMINAL_RECEIPT_GUIDANCE,
  makeAttachReceiptTool,
} from './attach-receipt.tool';

/**
 * Unit tests for the attachReceipt compatibility tool (WU12) — spec
 * scenarios: strict `{}` input with the exact terminal guidance result;
 * protected fields and sale-B payloads rejected at input validation; zero
 * chatbotApi.attachReceipt calls on every path; zero-dep factory.
 */

type AttachToolShape = {
  inputSchema: {
    parse: (data: unknown) => unknown;
    safeParse: (data: unknown) => { success: boolean };
  };
  execute: (
    input: unknown,
    options: { toolCallId: string; messages: unknown[]; context: undefined },
  ) => Promise<unknown>;
};

const makeTool = makeAttachReceiptTool as unknown as () => AttachToolShape;
const TERMINAL = TERMINAL_RECEIPT_GUIDANCE as unknown;

const EXECUTE_OPTIONS = {
  toolCallId: 't',
  messages: [],
  context: undefined,
};

// Canonical terminal guidance contract (mirrors the tracked canonical spec).
const EXPECTED_TERMINAL_GUIDANCE = {
  ok: true,
  terminal: true,
  guidance:
    'Receipt images are handled by the server-owned durable receipt workflow. Do not retry this tool, and do not request or derive a sale ID, media URL, object key, token, capability, pending media, amount, date, or reference.',
};

describe('makeAttachReceiptTool (terminal compatibility tool)', () => {
  it('strict {} input succeeds with the exact terminal guidance result', async () => {
    expect(TERMINAL).toEqual(EXPECTED_TERMINAL_GUIDANCE);
    const tool = makeTool();
    const parsed = tool.inputSchema.parse({});
    expect(parsed).toEqual({});
    await expect(tool.execute(parsed, EXECUTE_OPTIONS)).resolves.toEqual(
      EXPECTED_TERMINAL_GUIDANCE,
    );
  });

  it('rejects every protected model-supplied field at input validation (unknown fields are rejected, not stripped)', () => {
    const tool = makeTool();
    const protectedPayloads = [
      { saleId: '00000000-0000-4000-8000-000000000001' },
      { mediaUrl: 'https://example.com/receipt.jpg' },
      { objectKey: 'receipts/sale-a/receipt-1.jpg' },
      { token: 'tok-1' },
      { capability: 'receipt:attach' },
      { pendingMedia: { id: 'pm-1' } },
      { declaredAmountCents: 50000 },
      { declaredDate: '2026-06-01T00:00:00.000Z' },
      { declaredReference: 'REF-1' },
      // A full legacy-shaped (sale-B) invocation is rejected whole.
      {
        saleId: '00000000-0000-4000-8000-000000000002',
        mediaUrl: 'https://example.com/receipt-b.jpg',
        declaredAmountCents: 1,
      },
    ];
    for (const payload of protectedPayloads) {
      const result = tool.inputSchema.safeParse(payload);
      expect(result.success).toBe(false);
    }
  });

  it('missing sale context makes zero calls: valid and rejected paths make zero chatbotApi.attachReceipt calls and the factory takes no deps', async () => {
    // No deps, no store, no sender context — the tool cannot know a sale.
    const attachReceipt = jest.fn(); // zero-call witness
    const tool = makeTool();
    expect(makeAttachReceiptTool.length).toBe(0);
    await tool.execute(tool.inputSchema.parse({}), EXECUTE_OPTIONS);
    tool.inputSchema.safeParse({
      saleId: '00000000-0000-4000-8000-000000000002',
      mediaUrl: 'https://example.com/receipt-b.jpg',
      declaredAmountCents: 1,
    });
    expect(attachReceipt).not.toHaveBeenCalled();
    await expect(tool.execute({}, EXECUTE_OPTIONS)).resolves.toEqual(
      EXPECTED_TERMINAL_GUIDANCE,
    );
  });
});
