import type { FeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  AckCompletion,
  DeliveryExpectation,
  DeliveryRow,
  DeliveryTransition,
  HumanRequestFeedStore,
  HumanRequestRecord,
  HumanRequestStatus,
  OpenHumanRequestInput,
} from '../domain/human-request-feed';

/** Test double with the Postgres store's semantics (shared contract). */
export class InMemoryHumanRequestFeedStore implements HumanRequestFeedStore {
  private cursor: string | null = null;
  private readonly rows = new Map<string, DeliveryRow>();
  private readonly requests = new Map<string, HumanRequestRecord>();

  readCursor(): Promise<string | null> {
    return Promise.resolve(this.cursor);
  }

  saveCursor(cursor: string | null): Promise<void> {
    this.cursor = cursor;
    return Promise.resolve();
  }

  insertDelivery(
    item: FeedItem,
  ): Promise<{ row: DeliveryRow; inserted: boolean }> {
    const existing = this.rows.get(item.deliveryId);
    if (existing)
      return Promise.resolve({ row: copy(existing), inserted: false });
    const now = new Date();
    const row: DeliveryRow = {
      deliveryId: item.deliveryId,
      cursor: item.cursor,
      type: item.type === 'unknown' ? item.rawType : item.type,
      requestId: item.type === 'unknown' ? null : item.requestId,
      conversationRef: item.type === 'unknown' ? null : item.conversationRef,
      item: structuredClone(item),
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
    return Promise.resolve({ row: copy(row), inserted: true });
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
    const now = new Date();
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
    row.updatedAt = new Date();
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
        .slice(0, filter.limit)
        .map(copy),
    );
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
      const now = new Date();
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
}

const copy = (row: DeliveryRow): DeliveryRow => ({
  ...row,
  item: structuredClone(row.item),
  nextAckAt: row.nextAckAt === null ? null : new Date(row.nextAckAt),
});
