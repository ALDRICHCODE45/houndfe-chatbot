/** EXPIRATION intake normalizer (contract v1,
 * docs/human-decisions-expiration-v1.md): pure, no HTTP/store/send, fail-closed.
 * The four wire keys carry only the request identity; the bot never invents ids,
 * and `variantId` stays explicit (null only for a product without variants). */
export interface ExpirationIntakeInput {
  sourceRequestId: string;
  type: 'EXPIRATION';
  productId: string;
  variantId: string | null;
}

/** RFC 4122 v1-v8 UUID with variant 8/9/a/b; the nil UUID is rejected, matching
 * the source-of-truth backend EXPIRATION intake parser. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = 'sourceRequestId type productId variantId'.split(' ');

function asUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** Exact four-key wire object: every declared key present, none `undefined`,
 * no extras. */
function hasExactKeys(value: Record<string, unknown>): boolean {
  const own = Reflect.ownKeys(value);
  if (own.length !== KEYS.length) return false;
  return own.every(
    (key) =>
      typeof key === 'string' && KEYS.includes(key) && value[key] !== undefined,
  );
}

/** Normalize the untrusted EXPIRATION intake body: exactly the four required
 * keys, a strict UUID identity, an explicit `variantId`, and nothing else. */
export function normalizeExpirationIntake(
  input: unknown,
): ExpirationIntakeInput | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return null;
    }
    const record = input as Record<string, unknown>;
    if (!hasExactKeys(record)) return null;
    if (record.type !== 'EXPIRATION') return null;
    const sourceRequestId = asUuid(record.sourceRequestId);
    const productId = asUuid(record.productId);
    if (sourceRequestId === null || productId === null) return null;
    if (record.variantId === null) {
      return {
        sourceRequestId,
        type: 'EXPIRATION',
        productId,
        variantId: null,
      };
    }
    const variantId = asUuid(record.variantId);
    if (variantId === null) return null;
    return { sourceRequestId, type: 'EXPIRATION', productId, variantId };
  } catch {
    return null;
  }
}
