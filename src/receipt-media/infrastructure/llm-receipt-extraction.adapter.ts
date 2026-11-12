import { Logger } from '@nestjs/common';
import { openai } from '@ai-sdk/openai';
import { Output } from 'ai';
import { z } from 'zod';
import type { GenerateTextFn } from '../../llm-agent/infrastructure/generate-text.provider';
import {
  computeAmountMismatch,
  type ReceiptExtraction,
  type ReceiptExtractionConfidence,
  type ReceiptExtractionInput,
  type ReceiptExtractionPort,
} from '../domain/receipt-extraction.port';
import { describeError } from '../../common/log-safe';

export const DEFAULT_RECEIPT_EXTRACTION_TIMEOUT_MS = 15_000;
const MAX_TEXT_FIELD_LENGTH = 64;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONFIDENCES: readonly ReceiptExtractionConfidence[] = [
  'high',
  'medium',
  'low',
];

/**
 * Loose on purpose: provider structured output keeps the shape, while field
 * validity is checked afterwards so one bad field becomes null instead of
 * failing the whole extraction.
 */
const extractionSchema = z.object({
  isReceipt: z
    .boolean()
    .describe('True only if the document is a bank transfer/payment receipt.'),
  amountCents: z
    .number()
    .nullable()
    .describe('Transferred amount in integer cents (MXN), or null.'),
  date: z.string().nullable().describe('Transfer date as YYYY-MM-DD, or null.'),
  reference: z
    .string()
    .nullable()
    .describe('Tracking key, folio or reference number, or null.'),
  bank: z.string().nullable().describe('Issuing bank name, or null.'),
  confidence: z.enum(['high', 'medium', 'low']),
});

const RECEIPT_EXTRACTION_INSTRUCTIONS = [
  'You read Mexican bank transfer receipts (SPEI, deposits, app screenshots) to pre-fill data for a human reviewer.',
  'You never decide whether a payment is valid; only report what is visibly printed.',
  'Set isReceipt=false when the document is clearly not a payment receipt (product photos, selfies, memes, chats).',
  'amountCents: the transferred amount in integer cents (e.g. $1,500.00 -> 150000). Null if not legible.',
  'date: the transfer date as YYYY-MM-DD. Null if not legible.',
  'reference: the tracking key (clave de rastreo), folio or reference. Null if absent.',
  'bank: the issuing bank name. Null if absent.',
  'Never guess: use null for anything you cannot read with certainty and lower the confidence.',
].join('\n');

const PDF_PAGE_LIMIT_INSTRUCTION =
  'This is a PDF. Consider at most the first 2 pages and ignore any later pages.';

/** Structural slice of the LLM cost guard; it only records usage. */
export interface ReceiptExtractionUsageRecorder {
  record(usage: { promptTokens: number; completionTokens: number }): void;
}

export interface LlmReceiptExtractionOptions {
  timeoutMs?: number;
  costGuard?: ReceiptExtractionUsageRecorder;
}

class ExtractionTimeoutError extends Error {}

/**
 * Vision pre-fill over the project's AI SDK seam (GENERATE_TEXT + OpenAI).
 * Never throws and never confirms or rejects a payment (S1).
 */
export class LlmReceiptExtractionAdapter implements ReceiptExtractionPort {
  private readonly logger = new Logger(LlmReceiptExtractionAdapter.name);
  private readonly timeoutMs: number;
  private readonly costGuard?: ReceiptExtractionUsageRecorder;

  constructor(
    private readonly generateTextFn: GenerateTextFn,
    private readonly modelId: string,
    options: LlmReceiptExtractionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RECEIPT_EXTRACTION_TIMEOUT_MS;
    this.costGuard = options.costGuard;
  }

  async extract(input: ReceiptExtractionInput): Promise<ReceiptExtraction> {
    let raw: unknown;
    try {
      raw = await this.callModel(input);
    } catch (error) {
      if (error instanceof ExtractionTimeoutError) {
        return { kind: 'unavailable', reason: 'timeout' };
      }
      this.logger.warn(`Receipt extraction failed: ${describeError(error)}`);
      return { kind: 'unavailable', reason: 'error' };
    }
    return toExtraction(raw, input.expectedAmountCents);
  }

  /**
   * Bounded by an abort signal AND a race, so a provider that ignores the
   * signal still cannot hold the caller past the timeout.
   */
  private async callModel(input: ReceiptExtractionInput): Promise<unknown> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ExtractionTimeoutError());
      }, this.timeoutMs);
    });
    const isPdf = input.mimeType === 'application/pdf';
    const call = this.generateTextFn({
      model: openai(this.modelId),
      system: RECEIPT_EXTRACTION_INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: isPdf
                ? `Extract the receipt data. ${PDF_PAGE_LIMIT_INSTRUCTION}`
                : 'Extract the receipt data.',
            },
            {
              type: 'file',
              data: input.bytes,
              mediaType: input.mimeType,
            },
          ],
        },
      ],
      output: Output.object({ schema: extractionSchema }),
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
      if (controller.signal.aborted) throw new ExtractionTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
      // A late rejection from an abandoned call must not go unhandled.
      call.catch(() => undefined);
    }
  }
}

function toExtraction(
  raw: unknown,
  expectedAmountCents: number | null,
): ReceiptExtraction {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'unavailable', reason: 'error' };
  }
  const fields = raw as Record<string, unknown>;
  if (fields.isReceipt !== true) {
    return fields.isReceipt === false
      ? { kind: 'not_receipt' }
      : { kind: 'unavailable', reason: 'error' };
  }
  const amountCents = toAmountCents(fields.amountCents);
  return {
    kind: 'receipt',
    amountCents,
    date: toIsoDate(fields.date),
    reference: toTextField(fields.reference),
    bank: toTextField(fields.bank),
    confidence: CONFIDENCES.includes(
      fields.confidence as ReceiptExtractionConfidence,
    )
      ? (fields.confidence as ReceiptExtractionConfidence)
      : 'low',
    amountMismatch: computeAmountMismatch(amountCents, expectedAmountCents),
  };
}

function toAmountCents(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return isRealDate ? match[0] : null;
}

function toTextField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_TEXT_FIELD_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}
