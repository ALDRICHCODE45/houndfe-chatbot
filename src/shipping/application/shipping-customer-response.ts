/** SCA-4a: pure, fail-closed inbound customer-response classifier and decline
 *  replay tombstone; hostile input returns `null`. No store, send, router, gate,
 *  provider or backend access. */
import { normalizeShippingCustomerOffer } from './shipping-customer-acceptance';
import {
  parseShippingCustomerDecision,
  type ShippingCustomerDecision,
} from './shipping-customer-decision';

export const SHIPPING_CUSTOMER_DECLINE_RECEIPT_KEY =
  'shippingCustomerDeclineReceipt';

export interface ShippingCustomerDeclineReceipt {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly draftCreatedAt: string;
  readonly inboundMessageId: string;
  readonly declinedAt: string;
}

export interface ShippingCustomerResponseDecision {
  readonly decision: ShippingCustomerDecision;
  readonly decidedAt: string;
}

const REQUEST_ID = /^[0-9a-f]{12}$/;
const BOUNDED_ID = /^[\x21-\x7e]{1,128}$/;
const DECLINE_RECEIPT_KEYS = [
  'schemaVersion',
  'requestId',
  'draftCreatedAt',
  'inboundMessageId',
  'declinedAt',
] as const;

/** Canonical ISO: equal to its own round-tripped `toISOString()`. */
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

const isRequestId = (v: unknown): v is string =>
  typeof v === 'string' && REQUEST_ID.test(v);

const isBoundedId = (v: unknown): v is string =>
  typeof v === 'string' && BOUNDED_ID.test(v);

const isSafeClock = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Exact-key snapshot: rejects accessor/inherited/excess/symbol fields and
 *  reads each value from its own enumerable data descriptor once. */
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
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !('value' in descriptor)
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** Exact-key, frozen, fail-closed tombstone for one declined inbound message. */
export function normalizeShippingCustomerDeclineReceipt(
  raw: unknown,
): ShippingCustomerDeclineReceipt | null {
  const snapshot = snapshotExact(raw, DECLINE_RECEIPT_KEYS);
  if (snapshot === null || snapshot.schemaVersion !== 1) return null;
  const { requestId, draftCreatedAt, inboundMessageId, declinedAt } = snapshot;
  if (!isRequestId(requestId) || !isCanonicalIso(draftCreatedAt)) return null;
  if (!isBoundedId(inboundMessageId) || !isCanonicalIso(declinedAt)) {
    return null;
  }
  if (Date.parse(declinedAt) < Date.parse(draftCreatedAt)) return null;
  return Object.freeze({
    schemaVersion: 1,
    requestId,
    draftCreatedAt,
    inboundMessageId,
    declinedAt,
  });
}

/** Simple replay match by the exact bounded inbound id; hostile input fails. */
export function matchShippingCustomerDeclineReceipt(
  rawReceipt: unknown,
  rawInboundMessageId: unknown,
): boolean {
  try {
    const receipt = normalizeShippingCustomerDeclineReceipt(rawReceipt);
    if (receipt === null) return false;
    return (
      typeof rawInboundMessageId === 'string' &&
      rawInboundMessageId === receipt.inboundMessageId
    );
  } catch {
    return false;
  }
}

/** Classify one raw inbound message against a valid normalized offer. The
 *  timestamp must be canonical, strictly after `offeredAt` (never the clock)
 *  and not after `nowMs`; YES also needs both before `expiresAt`, while a late
 *  NO may cancel an expired offer. Frozen output: decision + timestamp. */
export function classifyShippingCustomerResponse(
  rawOffer: unknown,
  rawText: unknown,
  rawInboundTimestamp: unknown,
  nowMs: unknown,
): ShippingCustomerResponseDecision | null {
  try {
    const offer = normalizeShippingCustomerOffer(rawOffer);
    if (offer === null) return null;
    const decision = parseShippingCustomerDecision(rawText);
    if (decision === null) return null;
    if (!isCanonicalIso(rawInboundTimestamp) || !isSafeClock(nowMs)) {
      return null;
    }
    const inboundMs = Date.parse(rawInboundTimestamp);
    const expiresMs = Date.parse(offer.expiresAt);
    if (inboundMs <= Date.parse(offer.offeredAt) || inboundMs > nowMs) {
      return null;
    }
    if (
      decision === 'accept' &&
      (inboundMs >= expiresMs || nowMs >= expiresMs)
    ) {
      return null;
    }
    return Object.freeze({ decision, decidedAt: rawInboundTimestamp });
  } catch {
    return null;
  }
}
