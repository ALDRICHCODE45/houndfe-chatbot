/**
 * HD-R3c-T4c0 — pure, deterministic RESTOCK attempt identity. Binds the frozen
 * `(sourceRequestId, backendDecisionId, tuple version)` to a stable UUIDv5 so a
 * retry reuses the same `attemptId` instead of minting a fresh one. No clock,
 * no `randomUUID`, no persistence, no I/O.
 *
 * The tag is versioned: a future tuple shape must ship as a NEW tag
 * (`RESTOCK_ATTEMPT/v2`), never as a mutation of the v1 bytes. UUIDs are
 * lower-cased into the tuple so an upper/lower spelling of the same id cannot
 * alias into two attempts.
 */
import { uuidV5 } from './restock-source-identity';

/**
 * Fixed repository constant RFC4122 namespace. Changing it re-keys every
 * attempt id, so it is a published contract: never rotate it in place.
 */
export const RESTOCK_ATTEMPT_NAMESPACE = '7b1c9e2d-4a35-4f60-9c18-2d3e5a7b8c91';

/** Versioned name tag; the current tuple shape is `v1`. */
const ATTEMPT_NAME_TAG = 'RESTOCK_ATTEMPT/v1';
/** Frozen tuple version slot; a new shape ships as a new tag, not this bump. */
const ATTEMPT_TUPLE_VERSION = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

/**
 * Deterministically bind `(sourceRequestId, backendDecisionId)` to a RESTOCK
 * attempt id, or `null` when either id is not a UUID.
 *
 * The name is the exact `JSON.stringify` of
 * `["RESTOCK_ATTEMPT/v1", sourceRequestId, backendDecisionId, 2]` with both
 * ids lower-cased. Never throws and never mutates its inputs.
 */
export function deriveRestockAttemptId(
  sourceRequestId: unknown,
  backendDecisionId: unknown,
): string | null {
  if (!isUuid(sourceRequestId) || !isUuid(backendDecisionId)) return null;
  return uuidV5(
    RESTOCK_ATTEMPT_NAMESPACE,
    JSON.stringify([
      ATTEMPT_NAME_TAG,
      sourceRequestId.toLowerCase(),
      backendDecisionId.toLowerCase(),
      ATTEMPT_TUPLE_VERSION,
    ]),
  );
}
