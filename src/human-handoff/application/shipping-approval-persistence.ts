import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import type {
  ShippingApprovalDecisionKind,
  ShippingApprovalMarker,
} from '../domain/shipping-approval-policy.port';

/**
 * SQ-5C2b local `shippingApproval` marker lifecycle. Pure normalization plus
 * the injected ConversationStore write seam: no Nest/provider/network and no
 * caller-state mutation. Stored via the ConversationStateData index signature
 * so the conversation domain imports no shipping/human feature.
 */
export const SHIPPING_APPROVAL_KEY = 'shippingApproval';

const REQUEST_ID = /^[0-9a-f]{12}$/;
// prettier-ignore
const MARKER_KEYS = new Set(['requestId', 'draftCreatedAt', 'decision', 'decidedAt']);
// prettier-ignore
const isPlainObject = (v: unknown): v is Record<string, unknown> => { try { if (typeof v !== 'object' || v === null || Array.isArray(v)) return false; const p: unknown = Object.getPrototypeOf(v); return p === Object.prototype || p === null; } catch { return false; } };
// prettier-ignore
const isDecision = (v: unknown): v is ShippingApprovalDecisionKind => v === 'SHIPPING_APPROVED' || v === 'SHIPPING_REJECTED';
/** Canonical ISO: a string equal to its own round-tripped `toISOString()` and
 *  a nonnegative, representable epoch. */
// prettier-ignore
const isCanonicalIso = (v: unknown): v is string => { if (typeof v !== 'string') return false; const ms = Date.parse(v); if (!Number.isFinite(ms) || ms < 0) return false; try { return new Date(ms).toISOString() === v; } catch { return false; } };

/** Snapshots a plain exact-key marker once; hostile getters/proxies/revoked
 *  values collapse to null without throwing or retaining source refs. */
function normalizeMarker(raw: unknown): ShippingApprovalMarker | null {
  try {
    if (!isPlainObject(raw)) return null;
    const requestId: unknown = raw.requestId;
    const draftCreatedAt: unknown = raw.draftCreatedAt;
    const decision: unknown = raw.decision;
    const decidedAt: unknown = raw.decidedAt;
    const keys = Object.keys(raw);
    // prettier-ignore
    if (keys.length !== MARKER_KEYS.size || !keys.every((k) => MARKER_KEYS.has(k))) return null;
    // prettier-ignore
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return null;
    // prettier-ignore
    if (!isCanonicalIso(draftCreatedAt) || !isCanonicalIso(decidedAt)) return null;
    if (!isDecision(decision)) return null;
    // prettier-ignore
    if (Date.parse(decidedAt) < Date.parse(draftCreatedAt)) return null;
    return Object.freeze({ requestId, draftCreatedAt, decision, decidedAt });
  } catch {
    return null;
  }
}

// prettier-ignore
function snapshotData(state: ConversationState | null): Record<string, unknown> | null { try { if (state === null) return {}; const d: unknown = state.data; if (!isPlainObject(d)) return null; return { ...d }; } catch { return null; } }

function resolveLastMessageAt(state: ConversationState | null): string {
  try {
    const lastMessageAt: unknown = state?.lastMessageAt;
    if (isCanonicalIso(lastMessageAt)) return lastMessageAt;
  } catch {
    // hostile state: fall through to a fresh canonical timestamp
  }
  return new Date().toISOString();
}

export function readShippingApprovalMarker(
  state: unknown,
): ShippingApprovalMarker | null {
  try {
    if (typeof state !== 'object' || state === null) return null;
    const data: unknown = (state as { data?: unknown }).data;
    if (!isPlainObject(data)) return null;
    return normalizeMarker(data[SHIPPING_APPROVAL_KEY]);
  } catch {
    return null;
  }
}

export async function setShippingApprovalMarker(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
  rawMarker: unknown,
  lastMessageAt: string,
): Promise<ConversationState | null> {
  const marker = normalizeMarker(rawMarker);
  if (marker === null || !isCanonicalIso(lastMessageAt)) return null;
  const data = snapshotData(state);
  if (data === null) return null;
  // prettier-ignore
  const next: ConversationStateData = { ...data, [SHIPPING_APPROVAL_KEY]: marker };
  return store.update(senderId, { lastMessageAt, data: next });
}

export async function clearShippingApprovalMarker(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
): Promise<ConversationState | null> {
  const snapshot = snapshotData(state);
  if (snapshot === null) return null;
  // prettier-ignore
  const data: ConversationStateData = { ...snapshot, [SHIPPING_APPROVAL_KEY]: null };
  const lastMessageAt = resolveLastMessageAt(state);
  return store.update(senderId, { lastMessageAt, data });
}
