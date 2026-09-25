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

/** Immutable historical POST receipt projection (contract v1 addenda): the
 * first `201` and an exact `200` replay, even after a human resolution, always
 * carry `PENDING`, version 1, `resolution:null` and `applyBefore:null`. Current
 * state comes only from the GET poll, never from this receipt. */
export interface RestockIntakeReceiptSnapshot {
  branchId: string;
  branchName: string | null;
  productId: string;
  productName: string;
  variantId: string | null;
  sku: string | null;
  requestedQuantity: number | null;
  observedStockAtRequest: number | null;
  stockObservedAt: string | null;
}

export interface RestockIntakeReceipt {
  id: string;
  sourceRequestId: string;
  type: 'RESTOCK';
  status: 'PENDING';
  version: 1;
  createdAt: string;
  snapshot: RestockIntakeReceiptSnapshot;
  supersedesDecisionId: string | null;
  resolution: null;
  applyBefore: null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = z.iso.datetime({ offset: true });
const INTAKE_KEYS =
  'sourceRequestId type productId productName variantId sku requestedQuantity observedStockAtRequest stockObservedAt supersedesDecisionId'.split(
    ' ',
  );
const RECEIPT_KEYS =
  'id sourceRequestId type status version createdAt snapshot supersedesDecisionId resolution applyBefore'.split(
    ' ',
  );
const SNAPSHOT_KEYS =
  'branchId branchName productId productName variantId sku requestedQuantity observedStockAtRequest stockObservedAt'.split(
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
/** Exact key set: every declared key present, none `undefined`, no extras. */
function hasExactKeys(r: Record<string, unknown>, keys: string[]): boolean {
  const own = Reflect.ownKeys(r);
  if (own.length !== keys.length) return false;
  return hasOnlyKeys(r, keys) && keys.every((k) => r[k] !== undefined);
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
/** Required UTC instant: canonical ISO or `null` when absent/invalid. */
function asRequiredInstant(value: unknown): string | null {
  const instant = asNullableInstant(value);
  return typeof instant === 'string' ? instant : null;
}
/** UUID identity compares case-insensitively; echoed bytes stay as received. */
function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
function sameNullableUuid(left: Tri<string>, right: string | null): boolean {
  if (left === undefined || left === null || right === null) {
    return left === right;
  }
  return sameUuid(left, right);
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
/** Preserve an exact backend string or `null`; never NFC/trim/blank-fold. */
function asNullableExactString(value: unknown): Tri<string> {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || hasControl(value)) return undefined;
  return value;
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

/** Normalize the backend-confirmed immutable RESTOCK intake receipt (201/200)
 * against `sent`; requires exact receipt and snapshot keys, rejects a
 * non-historical or non-binding shape, returns validated backend fields. */
export function normalizeRestockIntakeReceipt(
  value: unknown,
  sent: RestockIntakeInput,
): RestockIntakeReceipt | null {
  try {
    const record = asPlainRecord(value);
    if (record === null || !hasExactKeys(record, RECEIPT_KEYS)) return null;
    const snapshot = asPlainRecord(record.snapshot);
    if (snapshot === null || !hasExactKeys(snapshot, SNAPSHOT_KEYS)) {
      return null;
    }

    if (
      record.type !== 'RESTOCK' ||
      record.status !== 'PENDING' ||
      record.version !== 1 ||
      record.resolution !== null ||
      record.applyBefore !== null
    ) {
      return null;
    }

    const id = asUuid(record.id);
    const sourceRequestId = asUuid(record.sourceRequestId);
    const createdAt = asRequiredInstant(record.createdAt);
    const branchId = asUuid(snapshot.branchId);
    const branchName = asNullableExactString(snapshot.branchName);
    const productId = asUuid(snapshot.productId);
    const variantId = asNullableUuid(snapshot.variantId);
    const sku = asNullableExactString(snapshot.sku);
    const requestedQuantity = asNullableInt(snapshot.requestedQuantity, 1);
    const observedStockAtRequest = asNullableInt(
      snapshot.observedStockAtRequest,
      0,
    );
    const stockObservedAt = asNullableInstant(snapshot.stockObservedAt);
    const supersedesDecisionId = asNullableUuid(record.supersedesDecisionId);
    if (
      id === null ||
      sourceRequestId === null ||
      createdAt === null ||
      branchId === null ||
      branchName === undefined ||
      productId === null ||
      variantId === undefined ||
      sku === undefined ||
      requestedQuantity === undefined ||
      observedStockAtRequest === undefined ||
      stockObservedAt === undefined ||
      supersedesDecisionId === undefined
    ) {
      return null;
    }

    // Bind receipt identity and snapshot subject to the normalized intake.
    if (
      !sameUuid(sourceRequestId, sent.sourceRequestId) ||
      !sameUuid(productId, sent.productId) ||
      snapshot.productName !== sent.productName ||
      !sameNullableUuid(variantId, sent.variantId) ||
      sku !== sent.sku ||
      requestedQuantity !== sent.requestedQuantity ||
      observedStockAtRequest !== sent.observedStockAtRequest ||
      stockObservedAt !== sent.stockObservedAt ||
      !sameNullableUuid(supersedesDecisionId, sent.supersedesDecisionId)
    ) {
      return null;
    }

    return {
      id,
      sourceRequestId,
      type: 'RESTOCK',
      status: 'PENDING',
      version: 1,
      createdAt,
      snapshot: {
        branchId,
        branchName,
        productId,
        productName: sent.productName,
        variantId,
        sku,
        requestedQuantity,
        observedStockAtRequest,
        stockObservedAt,
      },
      supersedesDecisionId,
      resolution: null,
      applyBefore: null,
    };
  } catch {
    return null;
  }
}

/** Current GET poll projection (backend 1188206): discriminated `PENDING`
 * (version 1, null `resolution`/`applyBefore`) or `RESOLVED` (version 2, one
 * exact typed resolution and `applyBefore = resolvedAt + 1h`). Only the GET
 * carries current state; the immutable POST receipt never does. */
export type RestockResolution =
  | {
      action: 'PROVIDE_RESTOCK_ESTIMATE';
      restockDays: number;
      resolvedAt: string;
    }
  | { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE'; resolvedAt: string };

export interface RestockDecisionBase {
  id: string;
  sourceRequestId: string;
  type: 'RESTOCK';
  createdAt: string;
  snapshot: RestockIntakeReceiptSnapshot;
  supersedesDecisionId: string | null;
}

export type RestockDecisionPending = RestockDecisionBase & {
  status: 'PENDING';
  version: 1;
  resolution: null;
  applyBefore: null;
};

export type RestockDecisionResolved = RestockDecisionBase & {
  status: 'RESOLVED';
  version: 2;
  resolution: RestockResolution;
  applyBefore: string;
};

export type RestockDecision = RestockDecisionPending | RestockDecisionResolved;

const RESOLUTION_POSITIVE_KEYS = 'action restockDays resolvedAt'.split(' ');
const RESOLUTION_NEGATIVE_KEYS = 'action resolvedAt'.split(' ');

/** Parse the current GET snapshot: exact nine keys, the same subject fields as
 * the historical receipt, plus the both-null-or-both-set stock pair. */
function normalizeDecisionSnapshot(
  value: unknown,
): RestockIntakeReceiptSnapshot | null {
  const snapshot = asPlainRecord(value);
  if (snapshot === null || !hasExactKeys(snapshot, SNAPSHOT_KEYS)) return null;
  const branchId = asUuid(snapshot.branchId);
  const branchName = asNullableExactString(snapshot.branchName);
  const productId = asUuid(snapshot.productId);
  const productName = asNullableExactString(snapshot.productName);
  const variantId = asNullableUuid(snapshot.variantId);
  const sku = asNullableExactString(snapshot.sku);
  const requestedQuantity = asNullableInt(snapshot.requestedQuantity, 1);
  const observedStockAtRequest = asNullableInt(
    snapshot.observedStockAtRequest,
    0,
  );
  const stockObservedAt = asNullableInstant(snapshot.stockObservedAt);
  if (typeof productName !== 'string' || productName.trim() === '') return null;
  if (productName.length > RESTOCK_MAX_PRODUCT_NAME_LENGTH) return null;
  if (
    branchId === null ||
    branchName === undefined ||
    productId === null ||
    variantId === undefined ||
    sku === undefined ||
    requestedQuantity === undefined ||
    observedStockAtRequest === undefined ||
    stockObservedAt === undefined
  ) {
    return null;
  }
  if ((observedStockAtRequest === null) !== (stockObservedAt === null)) {
    return null;
  }
  return {
    branchId,
    branchName,
    productId,
    productName,
    variantId,
    sku,
    requestedQuantity,
    observedStockAtRequest,
    stockObservedAt,
  };
}

/** Exact discriminated resolution: positive adds a bounded integer
 * `restockDays`, negative forbids it. No `resolvedBy`/`evidenceCode`. */
function normalizeRestockResolution(value: unknown): RestockResolution | null {
  const record = asPlainRecord(value);
  if (record === null) return null;
  const resolvedAt = asRequiredInstant(record.resolvedAt);
  if (resolvedAt === null) return null;
  if (record.action === 'PROVIDE_RESTOCK_ESTIMATE') {
    if (!hasExactKeys(record, RESOLUTION_POSITIVE_KEYS)) return null;
    const restockDays = record.restockDays;
    if (
      typeof restockDays !== 'number' ||
      !Number.isSafeInteger(restockDays) ||
      restockDays < 1 ||
      restockDays > 365
    ) {
      return null;
    }
    return { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays, resolvedAt };
  }
  if (record.action !== 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE') return null;
  if (!hasExactKeys(record, RESOLUTION_NEGATIVE_KEYS)) return null;
  return { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE', resolvedAt };
}

/** Normalize the current GET poll projection: exact ten top-level keys, a
 * `PENDING`/v1 state with null resolution and applyBefore, or a `RESOLVED`/v2
 * state whose `applyBefore` is exactly `resolvedAt + 1h`. No HTTP/store/send,
 * never throws, fails closed. */
export function normalizeRestockDecision(
  value: unknown,
): RestockDecision | null {
  try {
    const record = asPlainRecord(value);
    if (record === null || !hasExactKeys(record, RECEIPT_KEYS)) return null;
    if (record.type !== 'RESTOCK') return null;
    const id = asUuid(record.id);
    const sourceRequestId = asUuid(record.sourceRequestId);
    const createdAt = asRequiredInstant(record.createdAt);
    const supersedesDecisionId = asNullableUuid(record.supersedesDecisionId);
    const snapshot = normalizeDecisionSnapshot(record.snapshot);
    if (
      id === null ||
      sourceRequestId === null ||
      createdAt === null ||
      supersedesDecisionId === undefined ||
      snapshot === null
    ) {
      return null;
    }
    const base = {
      id,
      sourceRequestId,
      type: 'RESTOCK' as const,
      createdAt,
      snapshot,
      supersedesDecisionId,
    };
    if (
      record.status === 'PENDING' &&
      record.version === 1 &&
      record.resolution === null &&
      record.applyBefore === null
    ) {
      return {
        ...base,
        status: 'PENDING',
        version: 1,
        resolution: null,
        applyBefore: null,
      };
    }
    if (record.status !== 'RESOLVED' || record.version !== 2) return null;
    const resolution = normalizeRestockResolution(record.resolution);
    const applyBefore = asRequiredInstant(record.applyBefore);
    if (resolution === null || applyBefore === null) return null;
    const window = Date.parse(resolution.resolvedAt) + 3_600_000;
    if (Date.parse(applyBefore) !== window) return null;
    return {
      ...base,
      status: 'RESOLVED',
      version: 2,
      resolution,
      applyBefore,
    };
  } catch {
    return null;
  }
}
