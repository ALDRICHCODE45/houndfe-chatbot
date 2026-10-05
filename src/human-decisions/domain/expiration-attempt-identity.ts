/** INACTIVE EXPIRATION attempt identity: pure and deterministic, with no clock,
 * randomness, persistence or I/O. An id is not proof of sender/subject binding,
 * a valid resolution, send eligibility, STALE, ACK or duplicate prevention.
 * This helper is not wired into the classifier or any runtime path. */
import { uuidV5 } from './restock-source-identity';

/** Fixed route-specific namespace. Changing it re-keys every attempt, so never
 * rotate it in place. RESTOCK's identity contract remains untouched. */
export const EXPIRATION_ATTEMPT_NAMESPACE =
  'c2308181-dd04-4389-b8c3-148e570b496c';

/** Tag revision and frozen tuple slot are distinct parts of the contract.
 * A future shape needs a new tag, never a mutation of these v1 bytes. */
const ATTEMPT_NAME_TAG = 'EXPIRATION_ATTEMPT/v1';
const ATTEMPT_TUPLE_VERSION = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 36 && UUID.test(value);

/** Return a canonical lowercase UUIDv5, or null for either malformed input.
 * The exact UTF-8 name is JSON.stringify of
 * ["EXPIRATION_ATTEMPT/v1", lower sourceRequestId, lower backendDecisionId, 2].
 * UUID spelling aliases share an attempt; whitespace and coercion are rejected.
 * Validation here is UUID shape only, not trusted inquiry validation. */
export function deriveExpirationAttemptId(
  sourceRequestId: unknown,
  backendDecisionId: unknown,
): string | null {
  if (!isUuid(sourceRequestId) || !isUuid(backendDecisionId)) return null;
  return uuidV5(
    EXPIRATION_ATTEMPT_NAMESPACE,
    JSON.stringify([
      ATTEMPT_NAME_TAG,
      sourceRequestId.toLowerCase(),
      backendDecisionId.toLowerCase(),
      ATTEMPT_TUPLE_VERSION,
    ]),
  );
}
