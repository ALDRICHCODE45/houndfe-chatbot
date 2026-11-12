import { Logger } from '@nestjs/common';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type BackendOutboxBatchDeliveryPort,
  type BackendOutboxDeliveryResult,
  type BackendOutboxEnqueueInput,
  type BackendOutboxEntry,
  type BackendOutboxKind,
} from '../../backend-outbox/domain/backend-outbox';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';
import type { ConversationMirrorClient } from '../../chatbot-api/domain/conversation-mirror.port';
import {
  MIRROR_ERROR_CODE_MAX_CHARS,
  MIRROR_MAX_STATUSES,
  mirrorStatusProblem,
  type MirrorDeliveryStatus,
  type MirrorStatusInput,
} from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import {
  BatchReactor,
  DELIVERED,
  type BatchItem,
} from './mirror-batch-reactor';
import type { MirrorDeliveryGate } from './mirror-delivery-gate';
import { clampFuture, validIsoTimestamp } from './mirror-message-mapper';

const HOUR_MS = 3_600_000;
/** S5 #7: an unknown id is retried after the mirror ACK, never past 24 h. */
export const STATUS_GIVE_UP_MS = 24 * HOUR_MS;
/** Total delivery attempts of one status (the original row counts as 1). */
export const STATUS_MAX_ATTEMPTS = 3;

const FORWARDED: readonly string[] = ['SENT', 'DELIVERED', 'READ', 'FAILED'];
/** Statuses the backend owns (400 if sent): the row is dropped as DONE. */
const BACKEND_OWNED: readonly string[] = ['QUEUED', 'DEFERRED', 'UNKNOWN'];

interface StatusItem {
  entry: BackendOutboxEntry;
  status: MirrorStatusInput;
}

export interface MirrorStatusesDeliveryDeps {
  client: Pick<ConversationMirrorClient, 'recordMessageStatuses'>;
  outbox: { enqueue(input: BackendOutboxEnqueueInput): Promise<unknown> };
  gate: MirrorDeliveryGate;
  clock?: () => Date;
  maxCalls?: number;
}

/**
 * MESSAGE_STATUS delivery (backend unit 9, T5): up to 100 statuses of one
 * conversation in ONE `statuses:batch` call.
 *
 * `unknown[]` ids (the status raced ahead of its mirror row, which may still
 * be queued BEHIND it in the same lane) must not block the lane: the row is
 * ACKed and the status is re-enqueued at the lane tail as a new row, with NO
 * delay (a delayed row would hold back every later row of the conversation),
 * carrying the original `firstSeenAt` and an attempt counter. It gives up
 * (DONE) after `STATUS_MAX_ATTEMPTS` attempts or 24 h since `firstSeenAt`,
 * whichever comes first. The new row's key is derived from the original one
 * and the attempt, so a replay after a crash enqueues nothing new.
 */
export class MirrorStatusesDelivery implements BackendOutboxBatchDeliveryPort {
  private readonly logger = new Logger(MirrorStatusesDelivery.name);
  private readonly clock: () => Date;

  constructor(private readonly deps: MirrorStatusesDeliveryDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  batchLimit(kind: BackendOutboxKind): number {
    return kind === 'MESSAGE_STATUS' ? MIRROR_MAX_STATUSES : 1;
  }

  async deliver(
    entry: BackendOutboxEntry,
  ): Promise<BackendOutboxDeliveryResult> {
    return (await this.deliverBatch([entry]))[0];
  }

  async deliverBatch(
    entries: readonly BackendOutboxEntry[],
    options: { signal?: AbortSignal } = {},
  ): Promise<BackendOutboxDeliveryResult[]> {
    if (entries.length === 0) return [];
    const blocked = this.deps.gate.blockedForMs();
    if (blocked > 0)
      return entries.map(() => ({
        outcome: 'RETRY' as const,
        error: 'conversation writes paused after a credential error',
        retryAfterMs: blocked,
      }));

    const now = this.clock();
    const preset: Array<BackendOutboxDeliveryResult | undefined> = [];
    const items: BatchItem<StatusItem>[] = [];
    entries.forEach((entry, index) => {
      const mapped = this.map(entry, now);
      if ('result' in mapped) preset[index] = mapped.result;
      else items.push({ index, value: { entry, status: mapped.status } });
    });
    const sendable = items.filter((item) => {
      const problem = mirrorStatusProblem(item.value.status, now.getTime());
      if (problem === null) return true;
      preset[item.index] = {
        outcome: 'PERMANENT',
        error: `local validation: ${problem}`,
      };
      return false;
    });
    if (sendable.length === 0)
      return entries.map((_, i) => preset[i] ?? DELIVERED);

    const reactor = new BatchReactor<StatusItem>(
      {
        label: 'statuses',
        gate: this.deps.gate,
        signal: options.signal,
        maxCalls: this.deps.maxCalls,
        call: (batch) =>
          this.deps.client.recordMessageStatuses(
            batch.map((item) => item.value.status),
          ),
        onOk: async (batch, result, set) => {
          const unknown = new Set(result.unknown ?? []);
          for (const item of batch)
            set(
              item.index,
              unknown.has(item.value.status.providerMessageId)
                ? await this.requeue(item.value, now)
                : DELIVERED,
            );
        },
      },
      entries.length,
      preset,
    );
    return reactor.run(sendable);
  }

  private map(
    entry: BackendOutboxEntry,
    now: Date,
  ): { status: MirrorStatusInput } | { result: BackendOutboxDeliveryResult } {
    const { providerMessageId, status, errorCode } = entry.payload;
    if (typeof providerMessageId !== 'string' || typeof status !== 'string')
      return {
        result: {
          outcome: 'PERMANENT',
          error: 'payload has no providerMessageId or status',
        },
      };
    const upper = status.toUpperCase();
    if (BACKEND_OWNED.includes(upper)) {
      this.logger.debug(`status ${upper} is backend-owned: dropped`);
      return { result: DELIVERED };
    }
    if (!FORWARDED.includes(upper))
      return {
        result: { outcome: 'PERMANENT', error: 'payload status is unknown' },
      };
    const occurredAt = clampFuture(
      validIsoTimestamp(entry.payload.occurredAt) ??
        entry.createdAt.toISOString(),
      now.getTime(),
    );
    const mapped: MirrorStatusInput = {
      providerMessageId,
      status: upper as MirrorDeliveryStatus,
      occurredAt,
    };
    if (typeof errorCode === 'string' && errorCode !== '')
      mapped.errorCode = Array.from(errorCode)
        .slice(0, MIRROR_ERROR_CODE_MAX_CHARS)
        .join('');
    return { status: mapped };
  }

  /** Re-enqueues an unknown status at the lane tail (or gives up). */
  private async requeue(
    item: StatusItem,
    now: Date,
  ): Promise<BackendOutboxDeliveryResult> {
    const { entry, status } = item;
    const firstSeenAt =
      validIsoTimestamp(entry.payload.firstSeenAt) ??
      entry.createdAt.toISOString();
    const counter = entry.payload.attempt;
    const attempt =
      typeof counter === 'number' &&
      Number.isSafeInteger(counter) &&
      counter > 0
        ? counter
        : 1;
    const where = `${maskConversationRef(entry.conversationRef)} (row ${entry.id})`;
    if (attempt >= STATUS_MAX_ATTEMPTS) {
      this.logger.debug(
        `status still unknown after ${STATUS_MAX_ATTEMPTS} attempts: given up for ${where}`,
      );
      return DELIVERED;
    }
    if (now.getTime() - Date.parse(firstSeenAt) >= STATUS_GIVE_UP_MS) {
      this.logger.debug(
        `status still unknown after 24 h: given up for ${where}`,
      );
      return DELIVERED;
    }
    const baseKey =
      typeof entry.payload.retryBaseKey === 'string' &&
      entry.payload.retryBaseKey !== ''
        ? entry.payload.retryBaseKey
        : entry.idempotencyKey;
    const idempotencyKey = `${baseKey}:u${attempt + 1}`;
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      this.logger.warn(`status re-enqueue key too long: given up for ${where}`);
      return DELIVERED;
    }
    try {
      await this.deps.outbox.enqueue({
        conversationRef: entry.conversationRef,
        kind: 'MESSAGE_STATUS',
        idempotencyKey,
        payload: {
          providerMessageId: status.providerMessageId,
          status: status.status,
          occurredAt: status.occurredAt,
          ...(status.errorCode === undefined
            ? {}
            : { errorCode: status.errorCode }),
          firstSeenAt,
          attempt: attempt + 1,
          retryBaseKey: baseKey,
        },
      });
      return DELIVERED;
    } catch {
      return { outcome: 'RETRY', error: 'status re-enqueue failed' };
    }
  }
}
