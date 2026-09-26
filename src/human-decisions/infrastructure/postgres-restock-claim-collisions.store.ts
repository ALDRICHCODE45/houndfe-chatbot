import type { PoolClient } from 'pg';
import type { ConversationState } from '../../conversation/domain/conversation-store';
import { classifyRestockConversationLegacyMarker } from '../domain/restock-conversation-marker';
import { PostgresSharedRouteMarkersStore } from './postgres-shared-route-markers.store';

const HOLD = Object.freeze({ action: 'hold' as const });
const CLEAR = Object.freeze({ action: 'clear' as const });
const LOCK =
  'SELECT sender_id, data FROM conversation_state WHERE sender_id=$1 FOR UPDATE';

/** Bounded fresh catalog-query demo snapshot, NOT a standalone claim.
 * Caller MUST already hold the ACTIVE reservation sender lock in a retained
 * transaction on this client and exactly prove the full recorded context.
 * RESTOCK presence does not prove ownership of that intent. Clear is only a
 * snapshot under those preconditions, not universal old-writer exclusion.
 * No transaction lifecycle, send ownership, time/window proof or marker writes.
 */
export class PostgresRestockClaimCollisionsStore {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async readForSender(
    senderId: string,
  ): Promise<Readonly<{ action: 'clear' | 'hold' }>> {
    if (
      typeof senderId !== 'string' ||
      !senderId.trim() ||
      senderId !== senderId.trim()
    )
      return HOLD;
    try {
      const { rows, rowCount } = await this.client.query<{
        sender_id: string;
        data: unknown;
      }>(LOCK, [senderId]);
      if (
        !Array.isArray(rows) ||
        rowCount !== 1 ||
        rows.length !== 1 ||
        rows[0]?.sender_id !== senderId
      )
        return HOLD;
      const data = rows[0].data;
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        return HOLD;
      const prototype = Object.getPrototypeOf(data) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return HOLD;
      const bag = data as Record<string, unknown>;
      if (
        Reflect.ownKeys(bag).some(
          (key) => key !== 'messages' && key !== 'pendingHumanRequest',
        ) ||
        (Object.hasOwn(bag, 'messages') && !Array.isArray(bag.messages)) ||
        classifyRestockConversationLegacyMarker(
          // Classifier reads identity/data only, never lastMessageAt authority.
          { senderId: rows[0].sender_id, data: bag } as ConversationState,
          senderId,
        ) !== false
      )
        return HOLD;
      // All conversation values are consumed before the next await; none escape.
      const markers = await new PostgresSharedRouteMarkersStore(
        this.client,
      ).readForSender(senderId);
      return markers.legacyRequestPending === false &&
        markers.restockIntentPresent === true
        ? CLEAR
        : HOLD;
    } catch {
      return HOLD;
    }
  }
}
