import type { FeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import {
  messageIdOf,
  purgedItem,
  type InsertDeliveryResult,
  type AckCompletion,
  type DeliveryExpectation,
  type DeliveryRow,
  type DeliveryTransition,
  type HumanRequestFeedStore,
  type HumanRequestRecord,
  type HumanRequestStatus,
  type OpenHumanRequestInput,
} from '../domain/human-request-feed';

const TERMINAL = new Set(['SENT', 'STALE', 'UNKNOWN']);

/** Test double with the Postgres store's semantics (shared contract). */
export class InMemoryHumanRequestFeedStore implements HumanRequestFeedStore {
  private cursor: string | null = null;
  private syncedAt: string | null = null;
  private readonly rows = new Map<string, DeliveryRow>();
  /** messageId → owning deliveryId (the unique partial index). */
  private readonly messageOwners = new Map<string, string>();
  private readonly requests = new Map<string, HumanRequestRecord>();
  private lastStamp = 0;

  /** Strictly increasing write time, so ordering by `updatedAt` is exact. */
  private stamp(): Date {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp);
  }

  readCursor(): Promise<string | null> {
    return Promise.resolve(this.cursor);
  }

  saveCursor(cursor: string | null, syncedAt?: string): Promise<void> {
    this.cursor = cursor;
    if (syncedAt !== undefined) this.syncedAt = syncedAt;
    return Promise.resolve();
  }

  readSyncedAt(): Promise<string | null> {
    return Promise.resolve(this.syncedAt);
  }

  insertDelivery(item: FeedItem): Promise<InsertDeliveryResult> {
    const existing = this.rows.get(item.deliveryId);
    if (existing)
      return Promise.resolve({ row: copy(existing), inserted: false });
    const wanted = messageIdOf(item);
    const owner = wanted === null ? undefined : this.messageOwners.get(wanted);
    const messageId = owner === undefined ? wanted : null;
    const now = this.stamp();
    const row: DeliveryRow = {
      deliveryId: item.deliveryId,
      cursor: item.cursor,
      type: item.type === 'unknown' ? item.rawType : item.type,
      requestId: item.type === 'unknown' ? null : item.requestId,
      conversationRef: item.type === 'unknown' ? null : item.conversationRef,
      item: structuredClone(item),
      messageId,
      localState: 'RECEIVED',
      decision: null,
      attemptId: null,
      providerMessageId: null,
      attemptedAt: null,
      ackState: null,
      ackOutcome: null,
      ackAttempts: 0,
      nextAckAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.deliveryId, row);
    if (messageId !== null) this.messageOwners.set(messageId, row.deliveryId);
    return Promise.resolve({
      row: copy(row),
      inserted: true,
      ...(owner === undefined ? {} : { duplicateOf: owner }),
    });
  }

  getDelivery(deliveryId: string): Promise<DeliveryRow | null> {
    const row = this.rows.get(deliveryId);
    return Promise.resolve(row ? copy(row) : null);
  }

  transition(
    deliveryId: string,
    expected: DeliveryExpectation,
    next: DeliveryTransition,
  ): Promise<DeliveryRow | null> {
    const row = this.rows.get(deliveryId);
    if (
      !row ||
      row.localState !== expected.localState ||
      row.attemptId !== expected.attemptId
    )
      return Promise.resolve(null);
    const now = this.stamp();
    Object.assign(row, {
      localState: next.localState,
      decision: next.decision,
      attemptId: next.attemptId,
      attemptedAt: next.attemptedAt,
      providerMessageId: next.providerMessageId,
      ackState: next.ack === null ? null : 'PENDING',
      ackOutcome: next.ack,
      ackAttempts: 0,
      nextAckAt: next.ack === null ? null : now,
      updatedAt: now,
    });
    return Promise.resolve(copy(row));
  }

  completeAck(
    deliveryId: string,
    attemptId: string,
    completion: AckCompletion,
  ): Promise<boolean> {
    const row = this.rows.get(deliveryId);
    if (!row || row.attemptId !== attemptId || row.ackState !== 'PENDING')
      return Promise.resolve(false);
    switch (completion.ackState) {
      case 'ACKED':
        row.ackState = 'ACKED';
        row.nextAckAt = null;
        break;
      case 'FAILED_PERMANENT':
        row.ackState = 'FAILED_PERMANENT';
        row.ackAttempts += 1;
        row.nextAckAt = null;
        break;
      case 'PENDING':
        row.ackAttempts += 1;
        row.nextAckAt = new Date(completion.retryAt);
        break;
      case null:
        row.ackState = null;
        row.ackOutcome = null;
        row.nextAckAt = null;
        break;
    }
    row.updatedAt = this.stamp();
    return Promise.resolve(true);
  }

  listDueAcks(now: Date, limit: number): Promise<DeliveryRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.ackState === 'PENDING' &&
            row.nextAckAt !== null &&
            row.nextAckAt.getTime() <= now.getTime(),
        )
        .sort((a, b) => a.nextAckAt!.getTime() - b.nextAckAt!.getTime())
        .slice(0, limit)
        .map(copy),
    );
  }

  listHeld(filter: {
    conversationRef?: string;
    limit: number;
  }): Promise<DeliveryRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.localState === 'HELD_HUMAN' &&
            (filter.conversationRef === undefined ||
              row.conversationRef === filter.conversationRef),
        )
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, filter.limit)
        .map(copy),
    );
  }

  touchHeld(deliveryId: string, attemptId: string | null): Promise<void> {
    const row = this.rows.get(deliveryId);
    if (row?.localState === 'HELD_HUMAN' && row.attemptId === attemptId)
      row.updatedAt = this.stamp();
    return Promise.resolve();
  }

  listDeferredWindow(filter: {
    conversationRef: string;
    limit: number;
  }): Promise<DeliveryRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.localState === 'DEFERRED_WINDOW' &&
            row.conversationRef === filter.conversationRef,
        )
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, filter.limit)
        .map(copy),
    );
  }

  purgeTerminal(
    before: Date,
    limit: number,
  ): Promise<{ deleted: number; scrubbed: number }> {
    const old = [...this.rows.values()]
      .filter(
        (row) =>
          TERMINAL.has(row.localState) &&
          row.updatedAt.getTime() < before.getTime(),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    const acked = old.filter((row) => row.ackState === 'ACKED').slice(0, limit);
    for (const row of acked) {
      this.rows.delete(row.deliveryId);
      if (row.messageId !== null) this.messageOwners.delete(row.messageId);
    }
    const failed = old
      .filter(
        (row) =>
          row.ackState === 'FAILED_PERMANENT' &&
          (row.item.type !== 'unknown' || row.item.raw.purged !== true),
      )
      .slice(0, limit);
    for (const row of failed)
      row.item = purgedItem(row.deliveryId, row.cursor, row.type);
    return Promise.resolve({ deleted: acked.length, scrubbed: failed.length });
  }

  listStuckSending(before: Date, limit: number): Promise<DeliveryRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.localState === 'SENDING' &&
            row.attemptedAt !== null &&
            Date.parse(row.attemptedAt) < before.getTime(),
        )
        .slice(0, limit)
        .map(copy),
    );
  }

  recordOpenRequest(input: OpenHumanRequestInput): Promise<void> {
    if (!this.requests.has(input.requestId)) {
      const now = this.stamp();
      this.requests.set(input.requestId, {
        requestId: input.requestId,
        conversationRef: input.conversationRef,
        subtype: input.subtype,
        legacyId: input.legacyId ?? null,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
      });
    }
    return Promise.resolve();
  }

  closeRequest(
    requestId: string,
    status: Exclude<HumanRequestStatus, 'OPEN'>,
  ): Promise<boolean> {
    const record = this.requests.get(requestId);
    if (!record || record.status !== 'OPEN') return Promise.resolve(false);
    record.status = status;
    record.updatedAt = new Date();
    return Promise.resolve(true);
  }

  getRequest(requestId: string): Promise<HumanRequestRecord | null> {
    const record = this.requests.get(requestId);
    return Promise.resolve(record ? { ...record } : null);
  }

  listOpenRequestIds(createdBefore: Date): Promise<string[]> {
    return Promise.resolve(
      [...this.requests.values()]
        .filter(
          (record) =>
            record.status === 'OPEN' &&
            record.createdAt.getTime() < createdBefore.getTime(),
        )
        .map((record) => record.requestId),
    );
  }
}

const copy = (row: DeliveryRow): DeliveryRow => ({
  ...row,
  item: structuredClone(row.item),
  nextAckAt: row.nextAckAt === null ? null : new Date(row.nextAckAt),
});
