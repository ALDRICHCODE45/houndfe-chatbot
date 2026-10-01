/** EXPIRATION current-state GET projection normalizer (contract v1,
 * docs/human-decisions-expiration-v1.md): pure, no HTTP/store/send, fail-closed.
 * GET is the only current-state surface: PENDING/v1 (null resolution/applyBefore)
 * or RESOLVED/v2 with a typed resolution and applyBefore = resolvedAt + 24h.
 * Snapshot labels stay historical/verbatim, `branchId` is a nonblank opaque
 * string (NOT a UUID), ids are canonical lowercase RFC UUIDs, timestamps are
 * canonical `Date.toISOString()` values, and backend-canonical text must already
 * equal its own canonical form (never rewritten). Binding to a requested id is
 * the future HTTP GET client's responsibility. */
import { z } from 'zod';
import type { ExpirationIntakeReceiptSnapshot } from './human-decisions-expiration-receipt.dto';

export type ExpirationDecisionResolution =
  | {
      action: 'PROVIDE_EXPIRATION_TEXT';
      expirationText: string;
      resolvedAt: string;
    }
  | { action: 'REPORT_EXPIRATION_UNAVAILABLE'; resolvedAt: string };

interface ExpirationDecisionBase {
  id: string;
  sourceRequestId: string;
  type: 'EXPIRATION';
  createdAt: string;
  snapshot: ExpirationIntakeReceiptSnapshot;
  supersedesDecisionId: null;
}
export interface ExpirationDecisionPending extends ExpirationDecisionBase {
  status: 'PENDING';
  version: 1;
  resolution: null;
  applyBefore: null;
}
export interface ExpirationDecisionResolved extends ExpirationDecisionBase {
  status: 'RESOLVED';
  version: 2;
  resolution: ExpirationDecisionResolution;
  applyBefore: string;
}
export type ExpirationDecision =
  | ExpirationDecisionPending
  | ExpirationDecisionResolved;

const UUID = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

/** Reject C0, DEL and C1 control characters without a control-char regex. */
function hasControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Backend text is guaranteed canonical: only accept an already-canonical value. */
function isCanonicalText(value: string): boolean {
  if (hasControl(value)) return false;
  const canonical = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return canonical === value && value.length > 0 && value.length <= 500;
}

/** Canonical backend instant: `Date.toISOString()` round-trips verbatim. */
function isCanonicalInstant(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

const TEXT = z.string().refine(isCanonicalText);
const INSTANT = z.string().refine(isCanonicalInstant);
const SNAPSHOT = z
  .strictObject({
    branchId: z.string().refine((v) => v.trim() !== ''),
    branchName: z.string().nullable(),
    productId: UUID,
    productName: z.string(),
    unit: z.string(),
    variantId: UUID.nullable(),
    variantName: z.string().nullable(),
    variantOption: z.string().nullable(),
    variantValue: z.string().nullable(),
  })
  .refine(
    (s) =>
      s.variantId !== null ||
      (s.variantName === null &&
        s.variantOption === null &&
        s.variantValue === null),
  )
  .refine((s) => s.variantId === null || s.variantName !== null);
const RESOLUTION = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('PROVIDE_EXPIRATION_TEXT'),
    expirationText: TEXT,
    resolvedAt: INSTANT,
  }),
  z.strictObject({
    action: z.literal('REPORT_EXPIRATION_UNAVAILABLE'),
    resolvedAt: INSTANT,
  }),
]);
const DECISION = z.discriminatedUnion('status', [
  z.strictObject({
    id: UUID,
    sourceRequestId: UUID,
    type: z.literal('EXPIRATION'),
    status: z.literal('PENDING'),
    version: z.literal(1),
    createdAt: INSTANT,
    snapshot: SNAPSHOT,
    supersedesDecisionId: z.null(),
    resolution: z.null(),
    applyBefore: z.null(),
  }),
  z.strictObject({
    id: UUID,
    sourceRequestId: UUID,
    type: z.literal('EXPIRATION'),
    status: z.literal('RESOLVED'),
    version: z.literal(2),
    createdAt: INSTANT,
    snapshot: SNAPSHOT,
    supersedesDecisionId: z.null(),
    resolution: RESOLUTION,
    applyBefore: INSTANT,
  }),
]);

const DECISION_KEYS =
  'id sourceRequestId type status version createdAt snapshot supersedesDecisionId resolution applyBefore'.split(
    ' ',
  );
const SNAPSHOT_KEYS =
  'branchId branchName productId productName unit variantId variantName variantOption variantValue'.split(
    ' ',
  );
const RESOLUTION_KEYS = new Map([
  ['PROVIDE_EXPIRATION_TEXT', ['action', 'expirationText', 'resolvedAt']],
  ['REPORT_EXPIRATION_UNAVAILABLE', ['action', 'resolvedAt']],
]);
const DAY_MS = 86_400_000;

/** Exact own keys (symbols included), rejecting extras and explicit undefined. */
function exactKeys(value: unknown, keys: string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Reflect.ownKeys(value);
  const record = value as Record<string, unknown>;
  return (
    own.length === keys.length &&
    own.every(
      (k) =>
        typeof k === 'string' && keys.includes(k) && record[k] !== undefined,
    )
  );
}

/** Normalize the untrusted current-state GET projection; fail-closed. */
export function normalizeExpirationDecision(
  value: unknown,
): ExpirationDecision | null {
  try {
    if (!exactKeys(value, DECISION_KEYS)) return null;
    const record = value as Record<string, unknown>;
    if (!exactKeys(record.snapshot, SNAPSHOT_KEYS)) return null;
    const resolution = record.resolution as Record<string, unknown> | null;
    if (resolution !== null) {
      const keys = RESOLUTION_KEYS.get(resolution.action as string);
      if (!keys || !exactKeys(resolution, keys)) return null;
    }
    const parsed = DECISION.safeParse(value);
    if (!parsed.success) return null;
    const decision = parsed.data;
    if (decision.status === 'PENDING') return decision;
    const deadline = new Date(
      Date.parse(decision.resolution.resolvedAt) + DAY_MS,
    ).toISOString();
    return deadline === decision.applyBefore ? decision : null;
  } catch {
    return null;
  }
}
