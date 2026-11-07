import type { GenerateTextFn } from '../../llm-agent/infrastructure/generate-text.provider';
import type { ProductImageDescriberInput } from '../domain/product-image';
import { LlmProductImageDescriberAdapter } from './llm-product-image-describer.adapter';

type CallArgs = {
  system: string;
  messages: Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      data?: unknown;
      mediaType?: string;
    }>;
  }>;
  abortSignal?: AbortSignal;
};

const JPEG_INPUT: ProductImageDescriberInput = {
  bytes: Buffer.from([0xff, 0xd8, 0xff]),
  mimeType: 'image/jpeg',
};

const PRODUCT_OUTPUT = {
  kind: 'product',
  brand: 'Nupec',
  productName: 'Nupec Adulto Raza Mediana',
  productType: 'croquetas',
  species: 'perro',
  size: '20 kg',
  flavorOrVariant: null,
  labelText: 'NUPEC Adulto',
  searchQueries: ['Nupec adulto 20 kg', 'croquetas Nupec'],
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
  options?: ConstructorParameters<typeof LlmProductImageDescriberAdapter>[2],
) {
  const generateTextFn: GenerateTextFn = generate;
  return new LlmProductImageDescriberAdapter(
    generateTextFn,
    'gpt-test',
    options,
  );
}

function callArgs(generate: jest.Mock): CallArgs {
  const [[args]] = generate.mock.calls as [[CallArgs]];
  return args;
}

describe('LlmProductImageDescriberAdapter', () => {
  it('parses a product description', async () => {
    const generate = fakeModel(PRODUCT_OUTPUT);

    await expect(adapterWith(generate).describe(JPEG_INPUT)).resolves.toEqual(
      PRODUCT_OUTPUT,
    );
  });

  it('sends the image as a file part with a pet-store prompt that forbids inventing brands', async () => {
    const generate = fakeModel(PRODUCT_OUTPUT);

    await adapterWith(generate).describe(JPEG_INPUT);

    const args = callArgs(generate);
    expect(args.messages[0].content).toContainEqual(
      expect.objectContaining({
        type: 'file',
        mediaType: 'image/jpeg',
        data: JPEG_INPUT.bytes,
      }),
    );
    expect(args.system).toMatch(/mascotas/i);
    expect(args.system).toMatch(/never invent/i);
  });

  it('trims fields, caps lengths and keeps at most 3 non-empty queries', async () => {
    const generate = fakeModel({
      ...PRODUCT_OUTPUT,
      brand: '  Nupec  ',
      productName: '   ',
      labelText: 'L'.repeat(300),
      searchQueries: ['  q1 ', '', 'q2', 'q3', 'q4', 42],
    });

    const result = await adapterWith(generate).describe(JPEG_INPUT);

    expect(result).toMatchObject({
      kind: 'product',
      brand: 'Nupec',
      productName: null,
      searchQueries: ['q1', 'q2', 'q3'],
    });
    expect(result.kind === 'product' && result.labelText?.length).toBe(120);
  });

  it('degrades an unknown kind to unclear and an unknown confidence to low', async () => {
    const generate = fakeModel({
      ...PRODUCT_OUTPUT,
      kind: 'cat-meme',
      confidence: 'certain',
    });

    await expect(
      adapterWith(generate).describe(JPEG_INPUT),
    ).resolves.toMatchObject({ kind: 'unclear', confidence: 'low' });
  });

  it('classifies a receipt', async () => {
    const generate = fakeModel({
      ...PRODUCT_OUTPUT,
      kind: 'receipt',
      brand: null,
      searchQueries: [],
    });

    await expect(
      adapterWith(generate).describe(JPEG_INPUT),
    ).resolves.toMatchObject({ kind: 'receipt' });
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
      adapterWith(generate, { timeoutMs: 10 }).describe(JPEG_INPUT),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(callArgs(generate).abortSignal?.aborted).toBe(true);
  });

  it('returns unavailable:timeout even when the provider ignores the abort', async () => {
    const generate = jest.fn(() => new Promise(() => undefined));

    await expect(
      adapterWith(generate, { timeoutMs: 10 }).describe(JPEG_INPUT),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
  });

  it('returns unavailable:error on a provider error or a non-object output', async () => {
    await expect(
      adapterWith(jest.fn().mockRejectedValue(new Error('500'))).describe(
        JPEG_INPUT,
      ),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'error' });
    await expect(
      adapterWith(fakeModel(undefined)).describe(JPEG_INPUT),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'error' });
  });

  it('records token usage on the optional cost guard', async () => {
    const generate = fakeModel(PRODUCT_OUTPUT, {
      inputTokens: 900,
      outputTokens: 60,
    });
    const costGuard = { record: jest.fn() };

    await adapterWith(generate, { costGuard }).describe(JPEG_INPUT);

    expect(costGuard.record).toHaveBeenCalledWith({
      promptTokens: 900,
      completionTokens: 60,
    });
  });
});
