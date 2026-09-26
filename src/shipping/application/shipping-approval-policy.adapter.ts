/**
 * Pure SQ-5C2a shipping-approval policy adapter over the committed C1
 * parser and the SQ-4 draft-record normalizer. No Nest/I/O/provider surface.
 */
import type {
  ShippingApprovalPinResult,
  ShippingApprovalPolicy,
} from '../../human-handoff/domain/shipping-approval-policy.port';
import { parseShippingApprovalDecision } from './shipping-approval';
import {
  normalizeShippingQuoteDraftRecord,
  SHIPPING_QUOTE_DRAFT_KEY,
} from './shipping-quote-draft-record';

const verdict = (kind: ShippingApprovalPinResult['kind']) =>
  Object.freeze({ kind }) as ShippingApprovalPinResult;
const VALID = verdict('valid');
const INVALID_CLOCK = verdict('invalid_clock');
const DRAFT_MISSING = verdict('draft_missing');
const DRAFT_EXPIRED = verdict('draft_expired');
const DRAFT_PIN_MISMATCH = verdict('draft_pin_mismatch');

const isSafeClock = (nowMs: unknown): nowMs is number =>
  typeof nowMs === 'number' &&
  Number.isSafeInteger(nowMs) &&
  nowMs >= 0 &&
  Number.isFinite(new Date(nowMs).getTime());

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
};

function verifyDraftPin(
  state: unknown,
  draftCreatedAt: string,
  nowMs: number,
): ShippingApprovalPinResult {
  if (!isSafeClock(nowMs)) return INVALID_CLOCK;
  let data: unknown;
  try {
    if (!isPlainObject(state)) return DRAFT_MISSING;
    data = state.data;
    if (!isPlainObject(data)) return DRAFT_MISSING;
  } catch {
    return DRAFT_MISSING;
  }
  let record: ReturnType<typeof normalizeShippingQuoteDraftRecord>;
  try {
    record = normalizeShippingQuoteDraftRecord(data[SHIPPING_QUOTE_DRAFT_KEY]);
  } catch {
    return DRAFT_MISSING;
  }
  if (record === null) return DRAFT_MISSING;
  if (record.createdAt !== draftCreatedAt) return DRAFT_PIN_MISMATCH;
  const created = Date.parse(record.createdAt);
  const expires = Date.parse(record.expiresAt);
  return created <= nowMs && nowMs < expires ? VALID : DRAFT_EXPIRED;
}

/** Frozen adapter; later bound with Nest `useValue` under the port token. */
export const shippingApprovalPolicyAdapter: ShippingApprovalPolicy =
  Object.freeze({
    parseDecision: parseShippingApprovalDecision,
    verifyDraftPin,
  });
