export type AmountParseResult =
  | { readonly kind: 'parsed'; readonly cents: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'multiple' };

const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const TOKEN = /[^\s]*\d[^\s]*/g;
const VALID = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?$/;
const SPANISH =
  /(?<![\d.,\p{L}-])(\$?\d{1,3}(?:,\d{3})+|\$?\d+)\s+pesos?\s+con\s+(\d{1,2})\s+centavos?(?![^\s])/giu;
const SPANISH_HINT = /pesos?\s+con/gi;

function toCents(raw: string, esCents: string | undefined): AmountParseResult {
  const [intPart, fracPart] = raw.replace(/[,$]/g, '').split('.');
  const cents = BigInt(intPart) * 100n + BigInt(esCents ?? fracPart ?? '0');
  return cents > 0n && cents <= MAX_CENTS
    ? { kind: 'parsed', cents: Number(cents) }
    : { kind: 'none' };
}

/** Pure parser: integer cents, exactly one bounded amount, no salvage. */
export function parseAmount(text: string): AmountParseResult {
  const spanish = [...text.matchAll(SPANISH)];
  const tokens = [...text.replace(SPANISH, ' ').matchAll(TOKEN)];
  if ((text.match(SPANISH_HINT) ?? []).length > spanish.length) {
    return { kind: 'none' };
  }
  if (tokens.some((t) => !VALID.test(t[0].replace(/^\$/, '')))) {
    return { kind: 'none' };
  }
  const count = spanish.length + tokens.length;
  if (count !== 1) return { kind: count === 0 ? 'none' : 'multiple' };
  const match = spanish[0] ?? tokens[0];
  return spanish.length === 1
    ? toCents(match[1], match[2])
    : toCents(match[0], undefined);
}
