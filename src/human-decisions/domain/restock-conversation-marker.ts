/**
 * HD-R3b3 conversation legacy-marker classifier — the PURE, inert companion to
 * the durable `SharedRouteMarkersPort` and the existing `readPendingHumanRequest`.
 *
 * ADVISORY, NOT CAS. This reads (and never writes) the conversation `data`
 * bag; it reserves nothing and guarantees no exclusivity. A later caller must
 * COMBINE it with the committed durable marker reader under one rule: `unknown`
 * WINS — any indeterminate reading from either source blocks, never falls back
 * to `false`. The conversation `pending` marker (W2) is still a separate
 * blocker and is NOT resolved by this function.
 *
 * Fail-closed, never-false: a `null` state for a valid expected sender, an explicit own `pendingHumanRequest:
 * null`, and a plain data bag that simply omits the key are the only `false`
 * readings. Every hostile or indeterminate shape — a non-plain state/data, an
 * accessor, a Proxy whose reads diverge from its descriptors or that throws, an
 * own `undefined` marker, or a non-null marker that fails the
 * `readPendingHumanRequest` structure — is the explicit `'unknown'`, never
 * `false`. Reading is done once into own-data snapshots and never re-read from
 * the caller's mutable object, so a state that mutates mid-call cannot flip the
 * result. No mutation, no DB, no network.
 */
import type { ConversationState } from '../../conversation/domain/conversation-store';

/**
 * Own-data snapshot of a PLAIN object (null-prototype or {@link Object}-
 * prototype). Returns `null` — never throws — for a non-object, an array, a
 * class/instanced object, an accessor property, a symbol key, or a read that
 * diverges from its own descriptor (a Proxy). The caller then classifies the
 * returned snapshot only.
 */
function snapshotOwnData(value: unknown): Map<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const snapshot = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return null;
      const read = (value as Record<string, unknown>)[key];
      if (!Object.is(descriptor.value, read)) return null;
      snapshot.set(key, descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** Mirrors `readPendingHumanRequest`'s structural rule, on a snapshot value. */
function isPendingHumanRequestMarker(value: unknown): boolean {
  const fields = snapshotOwnData(value);
  if (fields === null) return false;
  const requestId = fields.get('requestId');
  const ref = fields.get('ref');
  const createdAt = fields.get('createdAt');
  const customerNotifiedAt = fields.get('customerNotifiedAt');
  return (
    typeof requestId === 'string' &&
    requestId.length > 0 &&
    typeof ref === 'string' &&
    ref.length > 0 &&
    typeof createdAt === 'string' &&
    typeof customerNotifiedAt === 'string'
  );
}

/**
 * Classify the conversation legacy marker for one state: `false` only for a
 * confirmed-absent marker, `true` for a confirmed present one, and `'unknown'`
 * for anything indeterminate. See the module note.
 */
export function classifyRestockConversationLegacyMarker(
  state: ConversationState | null,
  expectedSenderId: string,
): boolean | 'unknown' {
  if (
    typeof expectedSenderId !== 'string' ||
    expectedSenderId.length === 0 ||
    expectedSenderId.length > 200 ||
    expectedSenderId !== expectedSenderId.trim()
  ) {
    return 'unknown';
  }
  if (state === null) return false;
  const stateFields = snapshotOwnData(state);
  if (
    stateFields === null ||
    stateFields.get('senderId') !== expectedSenderId ||
    !stateFields.has('data')
  ) {
    return 'unknown';
  }
  const dataFields = snapshotOwnData(stateFields.get('data'));
  if (dataFields === null) return 'unknown';
  if (!dataFields.has('pendingHumanRequest')) return false;
  const marker = dataFields.get('pendingHumanRequest');
  if (marker === null) return false;
  if (marker === undefined) return 'unknown';
  return isPendingHumanRequestMarker(marker) ? true : 'unknown';
}
