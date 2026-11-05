import type { GenerateTextFn } from '../../llm-agent/infrastructure/generate-text.provider';
import type { ReceiptExtractionInput } from '../domain/receipt-extraction.port';
import { LlmReceiptExtractionAdapter } from './llm-receipt-extraction.adapter';

type CallArgs = {
  system: string;
  messages: Array<{
    role: string;
    content: Array<{ type: string; data?: unknown; mediaType?: string }>;
  }>;
  abortSignal?: AbortSignal;
};

const PNG_INPUT: ReceiptExtractionInput = {
  bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  mimeType: 'image/png',
  expectedAmountCents: 150000,
};

const RECEIPT_OUTPUT = {
  isReceipt: true,
  amountCents: 150000,
  date: '2026-11-04',
  reference: '  ABC123  ',
  bank: 'BBVA',
  confidence: 'high',
};

function fakeModel(
  output: unknown,
  usage = { inputTokens: 10, outputTokens: 5 },
) {
  return jest.fn().mockResolvedValue({ output, usage });
}

function adapterWith(
  generate: jest.Mock,
  options?: ConstructorParameters<typeof LlmReceiptExtractionAdapter>[2],
) {
  const generateTextFn: GenerateTextFn = generate;
  return new LlmReceiptExtractionAdapter(generateTextFn, 'gpt-test', options);
}

function callArgs(generate: jest.Mock): CallArgs {
  const [[args]] = generate.mock.calls as [[CallArgs]];
  return args;
}

describe('LlmReceiptExtractionAdapter', () => {
  it('parses a receipt into pre-fill fields', async () => {
    const generate = fakeModel(RECEIPT_OUTPUT);

    await expect(adapterWith(generate).extract(PNG_INPUT)).resolves.toEqual({
      kind: 'receipt',
      amountCents: 150000,
      date: '2026-11-04',
      reference: 'ABC123',
      bank: 'BBVA',
      confidence: 'high',
      amountMismatch: false,
    });
  });

  it('classifies an image that is not a receipt', async () => {
    const generate = fakeModel({ ...RECEIPT_OUTPUT, isReceipt: false });

    await expect(adapterWith(generate).extract(PNG_INPUT)).resolves.toEqual({
      kind: 'not_receipt',
    });
  });

  it('returns unavailable:timeout when the model exceeds the timeout', async () => {
    const generate = jest.fn(
      (args: CallArgs) =>
        new Promise((_resolve, reject) => {
          args.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    await expect(
      adapterWith(generate, { timeoutMs: 10 }).extract(PNG_INPUT),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(callArgs(generate).abortSignal?.aborted).toBe(true);
  });

  it('returns unavailable:timeout even when the provider ignores the abort', async () => {
    const generate = jest.fn(() => new Promise(() => undefined));

    await expect(
      adapterWith(generate, { timeoutMs: 10 }).extract(PNG_INPUT),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
  });

  it('returns unavailable:error on a provider error', async () => {
    const generate = jest.fn().mockRejectedValue(new Error('500 upstream'));

    await expect(adapterWith(generate).extract(PNG_INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'error',
    });
  });

  it('returns unavailable:error when the output is not an object', async () => {
    const generate = fakeModel(undefined);

    await expect(adapterWith(generate).extract(PNG_INPUT)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'error',
    });
  });

  it('nulls malformed fields instead of failing the result', async () => {
    const generate = fakeModel({
      isReceipt: true,
      amountCents: 12.5,
      date: '04/11/2026',
      reference: 'R'.repeat(100),
      bank: '   ',
      confidence: 'certain',
    });

    await expect(adapterWith(generate).extract(PNG_INPUT)).resolves.toEqual({
      kind: 'receipt',
      amountCents: null,
      date: null,
      reference: 'R'.repeat(64),
      bank: null,
      confidence: 'low',
      amountMismatch: false,
    });
  });

  it.each([
    ['negative amount', { amountCents: -100 }, 'amountCents'],
    ['string amount', { amountCents: '150000' }, 'amountCents'],
    ['impossible calendar date', { date: '2026-02-30' }, 'date'],
    ['non-string reference', { reference: 12345 }, 'reference'],
  ])('nulls a %s', async (_label, patch, field) => {
    const generate = fakeModel({ ...RECEIPT_OUTPUT, ...patch });

    const result = await adapterWith(generate).extract(PNG_INPUT);

    expect(result).toMatchObject({ kind: 'receipt', [field]: null });
  });

  it.each([
    ['true when amounts differ', 140000, 150000, true],
    ['false when amounts match', 150000, 150000, false],
    ['false when the owed amount is unknown', 140000, null, false],
    ['false when the extracted amount is unknown', null, 150000, false],
  ])(
    'flags amountMismatch %s',
    async (_label, amountCents, expectedAmountCents, mismatch) => {
      const generate = fakeModel({ ...RECEIPT_OUTPUT, amountCents });

      const result = await adapterWith(generate).extract({
        ...PNG_INPUT,
        expectedAmountCents,
      });

      expect(result).toMatchObject({
        kind: 'receipt',
        amountMismatch: mismatch,
      });
    },
  );

  it('sends a PDF as a file part limited to the first 2 pages', async () => {
    const generate = fakeModel(RECEIPT_OUTPUT);
    const bytes = Buffer.from('%PDF-1.7');

    await adapterWith(generate).extract({
      bytes,
      mimeType: 'application/pdf',
      expectedAmountCents: null,
    });

    const args = callArgs(generate);
    const parts = args.messages[0].content;
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'file',
        mediaType: 'application/pdf',
        data: bytes,
      }),
    );
    const text = JSON.stringify(parts) + args.system;
    expect(text).toMatch(/first 2 pages/i);
  });

  it('sends an image as a file part with its mime type', async () => {
    const generate = fakeModel(RECEIPT_OUTPUT);

    await adapterWith(generate).extract(PNG_INPUT);

    expect(callArgs(generate).messages[0].content).toContainEqual(
      expect.objectContaining({ type: 'file', mediaType: 'image/png' }),
    );
  });

  it('records token usage on the optional cost guard', async () => {
    const generate = fakeModel(RECEIPT_OUTPUT, {
      inputTokens: 700,
      outputTokens: 40,
    });
    const costGuard = { record: jest.fn() };

    await adapterWith(generate, { costGuard }).extract(PNG_INPUT);

    expect(costGuard.record).toHaveBeenCalledWith({
      promptTokens: 700,
      completionTokens: 40,
    });
  });
});
