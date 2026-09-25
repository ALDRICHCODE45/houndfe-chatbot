import { z } from 'zod';

/** RESTOCK intake normalizer (contract v1,
 * docs/human-decisions-contract-v1.md): pure, no HTTP/store/send, fail-closed. */
export const RESTOCK_MAX_PRODUCT_NAME_LENGTH = 200;

export interface RestockIntakeInput {
  sourceRequestId: string;
  type: 'RESTOCK';
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: string | null;
  supersedesDecisionId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = z.iso.datetime({ offset: true });
const INTAKE_KEYS =
  'sourceRequestId type productId productName variantId sku requestedQuantity observedStockAtRequest stockObservedAt supersedesDecisionId'.split(
    ' ',
  );

/** `null` for absent/explicit-null, `undefined` for present-but-invalid. */
type Tri<T> = T | null | undefined;

/** Snapshot plain own data descriptors into a null-prototype object; a class/
 * symbol, accessor, non-plain, or descriptor/get mismatch fails closed. */
function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const proto = Reflect.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    const read = (value as Record<string, unknown>)[key];
    if (!Object.is(descriptor.value, read)) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: string[],
): boolean {
  return Reflect.ownKeys(record).every(
    (key) => typeof key === 'string' && allowed.includes(key),
  );
}
function asUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}
function asNullableUuid(value: unknown): Tri<string> {
  if (value === undefined || value === null) return null;
  return asUuid(value) ?? undefined;
}
function asNullableInt(value: unknown, min: number): Tri<number> {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    return undefined;
  }
  return value;
}
function asNullableInstant(value: unknown): Tri<string> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !INSTANT.safeParse(value).success) {
    return undefined;
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
function asNullableTrimmed(value: unknown): Tri<string> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC');
  if (hasControl(normalized)) return undefined;
  const trimmed = normalized.trim();
  return trimmed.length > 0 ? trimmed : null;
}
/** NFC first, reject C0/C1, then trim + collapse; `null` when invalid. */
function sanitizeProductName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC');
  if (hasControl(normalized)) return null;
  const collapsed = normalized.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length > RESTOCK_MAX_PRODUCT_NAME_LENGTH) return null;
  return collapsed;
}

export function normalizeRestockIntake(
  input: unknown,
): RestockIntakeInput | null {
  try {
    const record = asPlainRecord(input);
    if (record === null || !hasOnlyKeys(record, INTAKE_KEYS)) return null;
    if (record.type !== 'RESTOCK') return null;
    const sourceRequestId = asUuid(record.sourceRequestId);
    const productId = asUuid(record.productId);
    const productName = sanitizeProductName(record.productName);
    if (
      sourceRequestId === null ||
      productId === null ||
      productName === null
    ) {
      return null;
    }
    const variantId = asNullableUuid(record.variantId);
    const sku = asNullableTrimmed(record.sku);
    const requestedQuantity = asNullableInt(record.requestedQuantity, 1);
    const observedStockAtRequest = asNullableInt(
      record.observedStockAtRequest,
      0,
    );
    const stockObservedAt = asNullableInstant(record.stockObservedAt);
    const supersedesDecisionId = asNullableUuid(record.supersedesDecisionId);
    if (
      variantId === undefined ||
      sku === undefined ||
      requestedQuantity === undefined ||
      observedStockAtRequest === undefined ||
      stockObservedAt === undefined ||
      supersedesDecisionId === undefined
    ) {
      return null;
    }
    // `observedStockAtRequest` and `stockObservedAt` are both null or both set.
    if ((observedStockAtRequest === null) !== (stockObservedAt === null)) {
      return null;
    }
    return {
      sourceRequestId,
      type: 'RESTOCK',
      productId,
      productName,
      variantId,
      sku,
      requestedQuantity,
      observedStockAtRequest,
      stockObservedAt,
      supersedesDecisionId,
    };
  } catch {
    return null;
  }
}
