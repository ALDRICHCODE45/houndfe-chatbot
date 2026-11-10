/**
 * S5 scope for the per-sender recorded-context reads. Since migration 400 one
 * sender may hold several ACTIVE reservations (one per route + topic), so a
 * reader narrows by the exact request key (application ledgers, locks) or by
 * the subject topic (recovery of an existing request). Without a scope the
 * legacy per-sender read is kept unchanged, and its cardinality check still
 * throws once a second ACTIVE row exists.
 */
export type RecordedReservationScope =
  | { readonly requestKey: string }
  | { readonly topicKey: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPIC = /^(?:variant|product):[0-9a-f-]{36}$/;

/** Narrow `baseSql` (which ends with its sender/status predicate on `$1`) to
 * one route and scope; null for a malformed scope (callers hold). */
export function scopedRecordedQuery(
  baseSql: string,
  route: 'RESTOCK' | 'EXPIRATION',
  senderId: string,
  scope: RecordedReservationScope | undefined,
): { readonly text: string; readonly params: unknown[] } | null {
  if (scope === undefined) return { text: baseSql, params: [senderId] };
  try {
    if ('requestKey' in scope) {
      const key: unknown = scope.requestKey;
      return typeof key === 'string' && UUID.test(key)
        ? {
            text: `${baseSql} AND route = '${route}' AND request_key = $2`,
            params: [senderId, key],
          }
        : null;
    }
    const topic: unknown = scope.topicKey;
    return typeof topic === 'string' && TOPIC.test(topic)
      ? {
          text: `${baseSql} AND route = '${route}' AND topic_key = $2`,
          params: [senderId, topic],
        }
      : null;
  } catch {
    return null;
  }
}
