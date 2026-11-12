import { Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { Output } from 'ai';
import { z } from 'zod';
import type { GenerateTextFn } from '../../llm-agent/infrastructure/generate-text.provider';
import type {
  ProductImageConfidence,
  ProductImageDescriberInput,
  ProductImageDescriberPort,
  ProductImageKind,
  ProductImageRecognition,
} from '../domain/product-image';
import { describeError } from '../../common/log-safe';

export const DEFAULT_PRODUCT_IMAGE_TIMEOUT_MS = 15_000;
const MAX_TEXT_FIELD_LENGTH = 80;
const MAX_LABEL_TEXT_LENGTH = 120;
const MAX_QUERY_LENGTH = 60;
const MAX_QUERIES = 3;
const KINDS: readonly ProductImageKind[] = [
  'product',
  'receipt',
  'other',
  'unclear',
];
const CONFIDENCES: readonly ProductImageConfidence[] = [
  'high',
  'medium',
  'low',
];

/**
 * Loose on purpose (same rule as the receipt extraction): provider
 * structured output keeps the shape, while field validity is checked
 * afterwards so one bad field becomes null instead of failing the turn.
 */
const descriptionSchema = z.object({
  kind: z
    .enum(['product', 'receipt', 'other', 'unclear'])
    .describe(
      'product: a pet-store product; receipt: a bank transfer/payment receipt; other: anything else; unclear: cannot tell.',
    ),
  brand: z
    .string()
    .nullable()
    .describe('Brand printed on the product, or null.'),
  productName: z
    .string()
    .nullable()
    .describe('Product line/name printed on the package, or null.'),
  productType: z
    .string()
    .nullable()
    .describe('Product type in Spanish (croquetas, arena, juguete…), or null.'),
  species: z
    .string()
    .nullable()
    .describe('Target animal in Spanish (perro, gato…), or null.'),
  size: z
    .string()
    .nullable()
    .describe('Net content or size as printed (e.g. 18 kg), or null.'),
  flavorOrVariant: z
    .string()
    .nullable()
    .describe('Flavor, life stage or variant as printed, or null.'),
  labelText: z
    .string()
    .nullable()
    .describe('Short visible label text (max ~15 words), or null.'),
  searchQueries: z
    .array(z.string())
    .describe('1-3 short Spanish catalog search queries, most specific first.'),
  confidence: z.enum(['high', 'medium', 'low']),
});

const PRODUCT_IMAGE_INSTRUCTIONS = [
  'You look at photos sent by customers of "Tienda de mascotas HoundFe", a Mexican pet store (pet food and accessories), to identify the product they ask about.',
  'Classify the image: product (pet food, litter, toys, accessories, hygiene…), receipt (bank transfer/payment receipt or app screenshot of a payment), other (selfies, memes, chats, pets without a product), unclear (blurry, too dark, too far).',
  'Only report what is visible. Never invent a brand, product name, size or flavor that is not printed or clearly recognizable on the package; use null instead.',
  'Write productType and species in Spanish (e.g. croquetas, alimento húmedo, arena, juguete, correa; perro, gato).',
  'searchQueries: 1 to 3 short Spanish queries for a store catalog search, most specific first (brand + line + size), then broader (type + brand, type + species). Empty when the image is not a product.',
  'confidence: high when brand and product are legible, medium when partly legible, low when guessing.',
].join('\n');

/** Structural slice of the LLM cost guard; it only records usage. */
export interface ProductImageUsageRecorder {
  record(usage: { promptTokens: number; completionTokens: number }): void;
}

export interface LlmProductImageDescriberOptions {
  timeoutMs?: number;
  costGuard?: ProductImageUsageRecorder;
}

class DescriberTimeoutError extends Error {}

/**
 * Vision describer over the project's AI SDK seam (GENERATE_TEXT + OpenAI),
 * cloned from LlmReceiptExtractionAdapter. Never throws.
 */
export class LlmProductImageDescriberAdapter implements ProductImageDescriberPort {
  private readonly logger = new Logger(LlmProductImageDescriberAdapter.name);
  private readonly timeoutMs: number;
  private readonly costGuard?: ProductImageUsageRecorder;

  constructor(
    private readonly generateTextFn: GenerateTextFn,
    private readonly modelId: string,
    options: LlmProductImageDescriberOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PRODUCT_IMAGE_TIMEOUT_MS;
    this.costGuard = options.costGuard;
  }

  async describe(
    input: ProductImageDescriberInput,
  ): Promise<ProductImageRecognition> {
    let raw: unknown;
    try {
      raw = await this.callModel(input);
    } catch (error) {
      if (error instanceof DescriberTimeoutError) {
        return { kind: 'unavailable', reason: 'timeout' };
      }
      this.logger.warn(
        `Product image description failed: ${describeError(error)}`,
      );
      return { kind: 'unavailable', reason: 'error' };
    }
    return toRecognition(raw);
  }

  /**
   * Bounded by an abort signal AND a race, so a provider that ignores the
   * signal still cannot hold the caller past the timeout.
   */
  private async callModel(input: ProductImageDescriberInput): Promise<unknown> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DescriberTimeoutError());
      }, this.timeoutMs);
    });
    const call = this.generateTextFn({
      model: openai(this.modelId),
      system: PRODUCT_IMAGE_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Describe the product in this customer photo.',
            },
            { type: 'file', data: input.bytes, mediaType: input.mimeType },
          ],
        },
      ],
      output: Output.object({ schema: descriptionSchema }),
      abortSignal: controller.signal,
    });
    try {
      const result = await Promise.race([call, timeout]);
      this.costGuard?.record({
        promptTokens: result.usage?.inputTokens ?? 0,
        completionTokens: result.usage?.outputTokens ?? 0,
      });
      return result.output;
    } catch (error) {
      if (controller.signal.aborted) throw new DescriberTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
      // A late rejection from an abandoned call must not go unhandled.
      call.catch(() => undefined);
    }
  }
}

function toRecognition(raw: unknown): ProductImageRecognition {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'unavailable', reason: 'error' };
  }
  const fields = raw as Record<string, unknown>;
  const queries = Array.isArray(fields.searchQueries)
    ? fields.searchQueries
        .map((query) => toTextField(query, MAX_QUERY_LENGTH))
        .filter((query): query is string => query !== null)
        .slice(0, MAX_QUERIES)
    : [];
  return {
    kind: KINDS.includes(fields.kind as ProductImageKind)
      ? (fields.kind as ProductImageKind)
      : 'unclear',
    brand: toTextField(fields.brand),
    productName: toTextField(fields.productName),
    productType: toTextField(fields.productType),
    species: toTextField(fields.species),
    size: toTextField(fields.size),
    flavorOrVariant: toTextField(fields.flavorOrVariant),
    labelText: toTextField(fields.labelText, MAX_LABEL_TEXT_LENGTH),
    searchQueries: queries,
    confidence: CONFIDENCES.includes(
      fields.confidence as ProductImageConfidence,
    )
      ? (fields.confidence as ProductImageConfidence)
      : 'low',
  };
}

function toTextField(
  value: unknown,
  max = MAX_TEXT_FIELD_LENGTH,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max).trim();
  return trimmed.length > 0 ? trimmed : null;
}
