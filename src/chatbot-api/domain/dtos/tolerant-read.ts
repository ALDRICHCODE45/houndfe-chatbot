import type { z } from 'zod';

/**
 * Read endpoints (catalog search, stock, evaluate-cart) fail closed on wrong
 * types, enums and missing keys but strip unknown keys: the backend adds
 * fields over time and a read must not break the conversation. Unknown keys
 * are reported as paths (`variants[].barcode`), never values.
 */
export interface TolerantRead<T> {
  value: T;
  unknownKeys: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Key paths present in the raw body but stripped from the parsed output. */
function strippedKeys(input: unknown, output: unknown, path: string): string[] {
  if (Array.isArray(input) && Array.isArray(output))
    return output.flatMap((item, i) =>
      strippedKeys(input[i], item, `${path}[]`),
    );
  if (!isRecord(input) || !isRecord(output)) return [];
  return Object.keys(input).flatMap((key) => {
    const keyPath = path ? `${path}.${key}` : key;
    return key in output
      ? strippedKeys(input[key], output[key], keyPath)
      : [keyPath];
  });
}

/** Null when the body does not match the schema. Never throws. */
export function parseTolerantRead<T>(
  schema: z.ZodType<T>,
  body: unknown,
): TolerantRead<T> | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) return null;
  return {
    value: parsed.data,
    unknownKeys: [...new Set(strippedKeys(body, parsed.data, ''))],
  };
}
