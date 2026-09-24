/**
 * SCA-1a1: pure, fail-closed offer/acceptance marker contract for the
 * measured-product shipping pilot: two exact-key `schemaVersion: 1` immutable
 * markers plus a pure match helper. Rejects accessor/inherited/excess/symbol
 * fields and fails closed on throwing traps; each result is a detached frozen copy. No store I/O,
 * router, provider, prompt, sale gate or backend access.
 */
export const SHIPPING_CUSTOMER_OFFER_KEY = 'shippingCustomerOffer';
export const SHIPPING_CUSTOMER_ACCEPTANCE_KEY = 'shippingCustomerAcceptance';

interface ShippingMarkerAmounts {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly draftCreatedAt: string;
  readonly merchandiseCents: number;
  readonly chargeCents: number;
  readonly expectedTotalCents: number;
}

export interface ShippingCustomerOffer extends ShippingMarkerAmounts {
  readonly offeredAt: string;
  readonly expiresAt: string;
  /** Outbound provider message id we disclosed the offer with. */
  readonly providerMessageId: string;
}

export interface ShippingCustomerAcceptance extends ShippingMarkerAmounts {
  readonly acceptedAt: string;
  /** Inbound webhook message id that carried the acceptance. */
  readonly inboundMessageId: string;
}

const REQUEST_ID = /^[0-9a-f]{12}$/;
const BOUNDED_ID = /^[\x21-\x7e]{1,128}$/;
const INT32_MAX_CENTS = 2_147_483_647;

const OFFER_KEYS = [
  'schemaVersion',
  'requestId',
  'draftCreatedAt',
  'offeredAt',
  'expiresAt',
  'merchandiseCents',
  'chargeCents',
  'expectedTotalCents',
  'providerMessageId',
] as const;

const ACCEPTANCE_KEYS = [
  'schemaVersion',
  'requestId',
  'draftCreatedAt',
  'merchandiseCents',
  'chargeCents',
  'expectedTotalCents',
  'acceptedAt',
  'inboundMessageId',
] as const;

/** Canonical ISO: a string equal to its own round-tripped `toISOString()` with
 *  a nonnegative representable epoch. */
function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return false;
  try {
    return new Date(ms).toISOString() === value;
  } catch {
    return false;
  }
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && BOUNDED_ID.test(value);
}

function isCents(value: unknown, min: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  );
}

/** Integer nonnegative merchandise, positive charge and the exact
 *  freight-inclusive total bounded to signed int32. */
function normalizeAmounts(
  merchandise: unknown,
  charge: unknown,
  total: unknown,
): readonly [number, number, number] | null {
  if (!isCents(merchandise, 0) || !isCents(charge, 1) || !isCents(total, 1)) {
    return null;
  }
  if (total !== merchandise + charge || total > INT32_MAX_CENTS) return null;
  return [merchandise, charge, total];
}

/** Exact-key guarded snapshot: rejects accessor/inherited/excess/symbol fields
 *  and reads each value from its own enumerable data descriptor once. */
function snapshotExact(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null;
    }
    const proto: unknown = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertyNames(raw).length !== keys.length) return null;
    if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      if (!Object.hasOwn(raw, key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !('value' in descriptor)
      ) {
        return null;
      }
      const value: unknown = descriptor.value;
      snapshot[key] = value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** Shared marker core: schemaVersion, ids, draft pin and disclosed amounts. */
function readMarkerBase(
  snapshot: Record<string, unknown>,
): ShippingMarkerAmounts | null {
  if (snapshot.schemaVersion !== 1) return null;
  const { requestId, draftCreatedAt } = snapshot;
  if (!isRequestId(requestId) || !isCanonicalIso(draftCreatedAt)) return null;
  const amounts = normalizeAmounts(
    snapshot.merchandiseCents,
    snapshot.chargeCents,
    snapshot.expectedTotalCents,
  );
  if (amounts === null) return null;
  return {
    schemaVersion: 1,
    requestId,
    draftCreatedAt,
    merchandiseCents: amounts[0],
    chargeCents: amounts[1],
    expectedTotalCents: amounts[2],
  };
}

export function normalizeShippingCustomerOffer(
  raw: unknown,
): ShippingCustomerOffer | null {
  const snapshot = snapshotExact(raw, OFFER_KEYS);
  if (snapshot === null) return null;
  const base = readMarkerBase(snapshot);
  if (base === null) return null;
  const { offeredAt, expiresAt, providerMessageId } = snapshot;
  if (!isCanonicalIso(offeredAt) || !isCanonicalIso(expiresAt)) return null;
  if (
    Date.parse(base.draftCreatedAt) > Date.parse(offeredAt) ||
    Date.parse(offeredAt) >= Date.parse(expiresAt)
  ) {
    return null;
  }
  if (!isBoundedId(providerMessageId)) return null;
  return Object.freeze({ ...base, offeredAt, expiresAt, providerMessageId });
}

export function normalizeShippingCustomerAcceptance(
  raw: unknown,
): ShippingCustomerAcceptance | null {
  const snapshot = snapshotExact(raw, ACCEPTANCE_KEYS);
  if (snapshot === null) return null;
  const base = readMarkerBase(snapshot);
  if (base === null) return null;
  const { acceptedAt, inboundMessageId } = snapshot;
  if (!isCanonicalIso(acceptedAt)) return null;
  if (Date.parse(acceptedAt) < Date.parse(base.draftCreatedAt)) return null;
  if (!isBoundedId(inboundMessageId)) return null;
  return Object.freeze({ ...base, acceptedAt, inboundMessageId });
}

/** Pure match/validity helper: the acceptance must pin the offer requestId,
 *  draftCreatedAt and three amounts and satisfy `offeredAt <= acceptedAt <
 *  expiresAt`. Invalid or hostile input fails closed. */
export function matchShippingCustomerAcceptance(
  offer: unknown,
  acceptance: unknown,
): boolean {
  try {
    const normalizedOffer = normalizeShippingCustomerOffer(offer);
    const normalizedAcceptance =
      normalizeShippingCustomerAcceptance(acceptance);
    if (normalizedOffer === null || normalizedAcceptance === null) return false;
    if (
      normalizedOffer.requestId !== normalizedAcceptance.requestId ||
      normalizedOffer.draftCreatedAt !== normalizedAcceptance.draftCreatedAt
    ) {
      return false;
    }
    if (
      normalizedOffer.merchandiseCents !==
        normalizedAcceptance.merchandiseCents ||
      normalizedOffer.chargeCents !== normalizedAcceptance.chargeCents ||
      normalizedOffer.expectedTotalCents !==
        normalizedAcceptance.expectedTotalCents
    ) {
      return false;
    }
    const acceptedMs = Date.parse(normalizedAcceptance.acceptedAt);
    return (
      acceptedMs >= Date.parse(normalizedOffer.offeredAt) &&
      acceptedMs < Date.parse(normalizedOffer.expiresAt)
    );
  } catch {
    return false;
  }
}
