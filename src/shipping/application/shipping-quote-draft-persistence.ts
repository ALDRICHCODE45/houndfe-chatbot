import type {
  ConversationState,
  ConversationStateData,
  ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  buildShippingQuoteDraftRecord,
  normalizeShippingQuoteDraftRecord,
  SHIPPING_QUOTE_DRAFT_KEY,
  type ShippingQuoteDraftRecord,
} from './shipping-quote-draft-record';

// Bounded SQ-4D2 lifecycle over SQ-4D1: no migration, no store-port change,
// no atomic helper. Whole `data` replacement (ADR-13) stays the accepted
// single-writer limitation; siblings are cloned and only `senderId` is used.
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  try {
    const proto: unknown =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.getPrototypeOf(value)
        : undefined;
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
};

const isValidClock = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  Number.isFinite(new Date(value).getTime());

function snapshotRuntimeState(
  state: ConversationState,
): { lastMessageAt: string; data: ConversationStateData } | null {
  try {
    const lastMessageAt: unknown = state.lastMessageAt;
    const rawData = state.data;
    if (typeof lastMessageAt !== 'string' || lastMessageAt.length === 0) {
      return null;
    }
    if (!isPlainObject(rawData)) return null;
    return { lastMessageAt, data: { ...rawData } };
  } catch {
    return null;
  }
}

export function readShippingQuoteDraft(
  state: ConversationState | null,
  nowMs: number,
): ShippingQuoteDraftRecord | null {
  if (state === null || !isValidClock(nowMs)) return null;
  try {
    const data: unknown = state.data;
    if (!isPlainObject(data)) return null;
    const record = normalizeShippingQuoteDraftRecord(
      data[SHIPPING_QUOTE_DRAFT_KEY],
    );
    if (record === null) return null;
    const created = Date.parse(record.createdAt);
    const expires = Date.parse(record.expiresAt);
    return nowMs < created || nowMs >= expires ? null : record;
  } catch {
    return null;
  }
}

export async function persistShippingQuoteDraft(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
  rawDraft: unknown,
  nowMs: number,
): Promise<ConversationState | null> {
  const record = buildShippingQuoteDraftRecord(rawDraft, nowMs);
  if (record === null) return null;
  const snapshot = state === null ? null : snapshotRuntimeState(state);
  if (state !== null && snapshot === null) return null;
  const data: ConversationStateData = {
    ...(snapshot?.data ?? {}),
    [SHIPPING_QUOTE_DRAFT_KEY]: record,
  };
  return store.update(senderId, {
    lastMessageAt: snapshot?.lastMessageAt ?? record.createdAt,
    data,
  });
}

export async function clearShippingQuoteDraft(
  store: ConversationStore,
  senderId: string,
  state: ConversationState | null,
  nowMs: number,
): Promise<ConversationState | null> {
  if (state === null) {
    if (!isValidClock(nowMs)) return null;
    return store.update(senderId, {
      lastMessageAt: new Date(nowMs).toISOString(),
      data: {},
    });
  }
  const snapshot = snapshotRuntimeState(state);
  if (snapshot === null) return null;
  const data: ConversationStateData = { ...snapshot.data };
  delete data[SHIPPING_QUOTE_DRAFT_KEY];
  return store.update(senderId, {
    lastMessageAt: snapshot.lastMessageAt,
    data,
  });
}
