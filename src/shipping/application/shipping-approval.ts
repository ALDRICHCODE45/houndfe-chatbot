/**
 * Pure SQ-5C1 shipping-approval boundary.
 *
 * Two server-owned primitives:
 *   - `buildShippingApprovalDigest` turns one unexpired internal
 *     shipping-quote draft record into the exact redacted ops digest
 *     (`ShippingApprovalDigest`). It normalizes only through
 *     `normalizeShippingQuoteDraftRecord`, requires a safe finite runtime
 *     clock pinned by `createdAt <= now < expiresAt`, and never leaks
 *     quote/rate IDs, address, phone, product, measurements, raw
 *     provider/error, expiry/validity, gross/applied/unused amounts, or
 *     qualifying-unit count.
 *   - `parseShippingApprovalDecision` strictly parses the ops agent's
 *     explicit decision: only case-insensitive `APPROVE_SHIPPING` /
 *     `REJECT_SHIPPING` with surrounding whitespace. It never throws and
 *     never accepts prefixes, suffixes, reasons, prose, or coercible
 *     non-string values.
 *
 * No I/O, persistence, provider, migration, or customer/model price
 * surface. Resolution and exhaustion are owned by SQ-5C2.
 */
import type { ShippingApprovalDigest } from '../../human-handoff/domain/human-handoff.types';
import type { ShippingApprovalDecision } from '../../human-handoff/domain/shipping-approval-policy.port';
import { normalizeShippingQuoteDraftRecord } from './shipping-quote-draft-record';

/** Canonical union lives in the human-handoff policy port (SQ-5C2a);
 *  re-exported here so existing C1 consumers keep their import path. */
export type { ShippingApprovalDecision } from '../../human-handoff/domain/shipping-approval-policy.port';

const APPROVED: ShippingApprovalDecision = Object.freeze({
  decision: 'SHIPPING_APPROVED',
});
const REJECTED: ShippingApprovalDecision = Object.freeze({
  decision: 'SHIPPING_REJECTED',
});

const APPROVE_SHIPPING = /^approve_shipping$/i;
const REJECT_SHIPPING = /^reject_shipping$/i;

const isSafeClock = (nowMs: unknown): nowMs is number =>
  typeof nowMs === 'number' &&
  Number.isSafeInteger(nowMs) &&
  nowMs >= 0 &&
  Number.isFinite(new Date(nowMs).getTime());

export function buildShippingApprovalDigest(
  rawRecord: unknown,
  nowMs: number,
): ShippingApprovalDigest | null {
  try {
    if (!isSafeClock(nowMs)) return null;
    const record = normalizeShippingQuoteDraftRecord(rawRecord);
    if (record === null) return null;
    const createdMs = new Date(record.createdAt).getTime();
    const expiresMs = new Date(record.expiresAt).getTime();
    if (!(createdMs <= nowMs && nowMs < expiresMs)) return null;
    return Object.freeze({
      kind: 'shipping_approval',
      draftCreatedAt: record.createdAt,
      customerPaysCents: record.draft.customerPaysCents,
      totalCreditCents: record.draft.totalCreditCents,
      carrierName: record.draft.selectedRate.carrierName,
      serviceName: record.draft.selectedRate.serviceName,
      estimatedDeliveryDays: record.draft.selectedRate.estimatedDeliveryDays,
    });
  } catch {
    return null;
  }
}

export function parseShippingApprovalDecision(
  value: unknown,
): ShippingApprovalDecision | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (APPROVE_SHIPPING.test(token)) return APPROVED;
  if (REJECT_SHIPPING.test(token)) return REJECTED;
  return null;
}
