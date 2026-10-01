/** EXPIRATION intake RECEIPT normalizer (contract v1,
 * docs/human-decisions-expiration-v1.md): pure, no HTTP/store/send, fail-closed.
 * `POST`/201 and a `200` replay both carry the immutable historical receipt
 * (`PENDING`/v1, null `resolution`/`applyBefore`/`supersedesDecisionId`); only
 * GET exposes current state. Product + presentation only: one server-owned
 * `unit` for simple and variant products, variant labels, NO SKU/stock. Labels
 * are persisted strings, so this is a SHAPE validator: blank/control/whitespace
 * bytes pass through verbatim (no trim/NFC/sanitize). UUID identity binds
 * case-insensitively and the canonical lowercase backend UUID is echoed. */
import { z } from 'zod';
import type { ExpirationIntakeInput } from './human-decisions-expiration.dto';

/** Immutable snapshot projection returned inside the intake receipt. */
export interface ExpirationIntakeReceiptSnapshot {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  unit: string;
  variantId: string | null;
  variantName: string | null;
  variantOption: string | null;
  variantValue: string | null;
}

/** Exact bot-safe immutable intake receipt body. */
export interface ExpirationIntakeReceipt {
  id: string;
  sourceRequestId: string;
  type: 'EXPIRATION';
  status: 'PENDING';
  version: 1;
  createdAt: string;
  snapshot: ExpirationIntakeReceiptSnapshot;
  supersedesDecisionId: null;
  resolution: null;
  applyBefore: null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_KEYS =
  'id sourceRequestId type status version createdAt snapshot supersedesDecisionId resolution applyBefore'.split(
    ' ',
  );
const SNAPSHOT_KEYS =
  'branchId branchName productId productName unit variantId variantName variantOption variantValue'.split(
    ' ',
  );

const uuid = z.string().regex(UUID_RE);
const SNAPSHOT = z.strictObject({
  branchId: z.string(),
  branchName: z.string().nullable(),
  productId: uuid,
  productName: z.string(),
  unit: z.string(),
  variantId: uuid.nullable(),
  variantName: z.string().nullable(),
  variantOption: z.string().nullable(),
  variantValue: z.string().nullable(),
});
const RECEIPT = z.strictObject({
  id: uuid,
  sourceRequestId: uuid,
  type: z.literal('EXPIRATION'),
  status: z.literal('PENDING'),
  version: z.literal(1),
  createdAt: z.iso.datetime({ offset: true }),
  snapshot: SNAPSHOT,
  supersedesDecisionId: z.null(),
  resolution: z.null(),
  applyBefore: z.null(),
});

function exactKeys(value: unknown, keys: string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === 'string' && keys.includes(key))
  );
}
function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
function sameUuidOrNull(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return sameUuid(left, right);
}

/** Normalize the backend-confirmed immutable EXPIRATION intake receipt
 * (201/200) against `sent`; rejects a non-historical or non-binding shape. */
export function normalizeExpirationIntakeReceipt(
  value: unknown,
  sent: ExpirationIntakeInput,
): ExpirationIntakeReceipt | null {
  try {
    const record = value as Record<string, unknown>;
    if (
      !exactKeys(value, RECEIPT_KEYS) ||
      !exactKeys(record.snapshot, SNAPSHOT_KEYS)
    ) {
      return null;
    }
    const parsed = RECEIPT.safeParse(value);
    if (!parsed.success) return null;
    const { snapshot, ...rest } = parsed.data;
    if (
      !sameUuid(rest.sourceRequestId, sent.sourceRequestId) ||
      !sameUuid(snapshot.productId, sent.productId) ||
      !sameUuidOrNull(snapshot.variantId, sent.variantId)
    ) {
      return null;
    }
    const { variantId, variantName, variantOption, variantValue } = snapshot;
    if (variantId === null) {
      if (
        variantName !== null ||
        variantOption !== null ||
        variantValue !== null
      ) {
        return null;
      }
    } else if (variantName === null) {
      return null;
    }
    return {
      ...rest,
      createdAt: new Date(rest.createdAt).toISOString(),
      snapshot,
    };
  } catch {
    return null;
  }
}
