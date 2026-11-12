import { Logger } from '@nestjs/common';
import type {
  BackendOutboxBatchDeliveryPort,
  BackendOutboxDeliveryResult,
  BackendOutboxEntry,
  BackendOutboxKind,
} from '../../backend-outbox/domain/backend-outbox';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';
import type { ConversationMirrorClient } from '../../chatbot-api/domain/conversation-mirror.port';
import {
  MIRROR_MAX_MESSAGES,
  mirrorMessageProblem,
  type MirrorMessageInput,
} from '../../chatbot-api/domain/dtos/conversation-mirror.dto';
import type {
  MirrorMediaContractType,
  ResolveMediaOutcome,
} from '../domain/mirror-media';
import {
  BatchReactor,
  type BatchItem,
  type ReactorResult,
} from './mirror-batch-reactor';
import type { MirrorDeliveryGate } from './mirror-delivery-gate';
import { mapMirrorEntry } from './mirror-message-mapper';
import type { MirrorMediaService } from './mirror-media.service';

/**
 * A media row whose file the backend keeps answering `422 MEDIA_NOT_FOUND`
 * for, after a forced re-upload and a resend, is retried this many times (the
 * outbox row's attempts); then it is mirrored as UNSUPPORTED OTHER so it
 * cannot block the rest of its conversation lane.
 */
export const MEDIA_NOT_FOUND_MAX_ATTEMPTS = 3;

interface MirrorItem {
  message: MirrorMessageInput;
  /** Attempts the outbox row has already used. */
  attempts: number;
  conversationRef: string;
  media?: { payload: unknown; type: MirrorMediaContractType };
  /** The media was already re-uploaded with `force` in this run. */
  forced: boolean;
}

export interface MirrorMessagesDeliveryDeps {
  client: Pick<ConversationMirrorClient, 'mirrorMessages'>;
  media: Pick<MirrorMediaService, 'resolveMedia'>;
  gate: MirrorDeliveryGate;
  clock?: () => Date;
  maxCalls?: number;
  /** Media resolved at once inside one run (the service also caps it). */
  mediaConcurrency?: number;
}

/**
 * MESSAGE_MIRROR delivery (backend unit 9, T4): a run of up to 50 rows of one
 * conversation goes out in ONE `messages:batch` call. Rows are mapped
 * (`mirror-message-mapper`), their media resolved to a `mediaId`
 * (`MirrorMediaService`), and the answer is handled by the S4 reactions
 * (`BatchReactor`). A row that cannot be mapped or fails local validation is
 * DEAD on its own and never parks its neighbours (L7).
 */
export class MirrorMessagesDelivery implements BackendOutboxBatchDeliveryPort {
  private readonly logger = new Logger(MirrorMessagesDelivery.name);
  private readonly clock: () => Date;

  constructor(private readonly deps: MirrorMessagesDeliveryDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  batchLimit(kind: BackendOutboxKind): number {
    return kind === 'MESSAGE_MIRROR' ? MIRROR_MAX_MESSAGES : 1;
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
    const items: BatchItem<MirrorItem>[] = [];
    entries.forEach((entry, index) => {
      const mapped = mapMirrorEntry(entry, now);
      if (!mapped.ok) {
        preset[index] = { outcome: 'PERMANENT', error: mapped.reason };
        return;
      }
      items.push({
        index,
        value: {
          message: mapped.message,
          media: mapped.media,
          forced: false,
          attempts: entry.attempts,
          conversationRef: entry.conversationRef,
        },
      });
    });

    const halted = await this.resolveMedia(items, false, options.signal);
    if (halted !== undefined)
      return entries.map((_, index) => preset[index] ?? halted);
    // Rows that fail local validation are DEAD alone, before any call.
    const sendable = items.filter((item) => {
      const problem = mirrorMessageProblem(item.value.message, now.getTime());
      if (problem === null) return true;
      preset[item.index] = {
        outcome: 'PERMANENT',
        error: `local validation: ${problem}`,
      };
      return false;
    });
    if (sendable.length === 0)
      return entries.map(
        (_, index) =>
          preset[index] ?? { outcome: 'RETRY', error: 'row was not resolved' },
      );
    const conversationRef = entries[0].conversationRef;
    const reactor = new BatchReactor<MirrorItem>(
      {
        label: 'messages',
        gate: this.deps.gate,
        signal: options.signal,
        maxCalls: this.deps.maxCalls,
        call: (batch) => this.send(conversationRef, batch),
        needsMediaRefresh: (batch) =>
          batch.some((i) => i.value.media !== undefined && !i.value.forced),
        refreshMedia: (batch) => this.resolveMedia(batch, true, options.signal),
        carriesMedia: (item) => item.value.media !== undefined,
        mediaRetriesExhausted: (item) =>
          item.value.attempts >= MEDIA_NOT_FOUND_MAX_ATTEMPTS,
        degradeMedia: (item) => {
          this.logger.warn(
            `mirror media still not found after ${item.value.attempts} retries (${maskConversationRef(item.value.conversationRef)}#${item.index}): message mirrored as UNSUPPORTED`,
          );
          toUnsupported(item.value);
        },
      },
      entries.length,
      preset,
    );
    return reactor.run(sendable);
  }

  private async send(
    conversationRef: string,
    batch: BatchItem<MirrorItem>[],
  ): Promise<ReactorResult> {
    return this.deps.client.mirrorMessages(
      conversationRef,
      batch.map((item) => item.value.message),
    );
  }

  /**
   * Resolves the media of `items` (at most `mediaConcurrency` at a time,
   * starting no new one after a halt). `force` re-uploads even cached ids.
   * Returns a halt result (RETRY for the whole run) or undefined.
   */
  private async resolveMedia(
    items: BatchItem<MirrorItem>[],
    force: boolean,
    signal: AbortSignal | undefined,
  ): Promise<BackendOutboxDeliveryResult | undefined> {
    const pending = items.filter((item) => item.value.media !== undefined);
    let halted: BackendOutboxDeliveryResult | undefined;
    let next = 0;
    const lane = async (): Promise<void> => {
      while (halted === undefined) {
        const item = pending[next++];
        if (item === undefined) return;
        const media = item.value.media!;
        const outcome = await this.deps.media.resolveMedia(
          media.payload,
          media.type,
          { force, signal },
        );
        halted = this.apply(item.value, outcome, force);
      }
    };
    const lanes = Math.max(1, this.deps.mediaConcurrency ?? 2);
    await Promise.all(Array.from({ length: lanes }, () => lane()));
    return halted;
  }

  /** Applies one media outcome to its item; returns a halt result, if any. */
  private apply(
    item: MirrorItem,
    outcome: ResolveMediaOutcome,
    force: boolean,
  ): BackendOutboxDeliveryResult | undefined {
    switch (outcome.kind) {
      case 'ok':
        item.message.mediaId = outcome.mediaId;
        item.forced = item.forced || force;
        return undefined;
      case 'unsupported':
        this.logger.debug(
          `mirror media not stored (${outcome.reason}): mirrored as UNSUPPORTED`,
        );
        toUnsupported(item);
        return undefined;
      case 'park':
        this.logger.warn(
          `mirror media parked (${outcome.reason}): message mirrored as UNSUPPORTED`,
        );
        toUnsupported(item);
        return undefined;
      case 'retry':
        return {
          outcome: 'RETRY',
          error: `media ${outcome.cause}`,
          ...(outcome.retryAfterSeconds === null
            ? {}
            : { retryAfterMs: Math.round(outcome.retryAfterSeconds * 1000) }),
        };
      case 'stop': {
        const delay = this.deps.gate.stopDelayMs();
        this.deps.gate.alert(
          `media:${outcome.reason}`,
          `conversation mirror media stopped (${outcome.reason}): rows kept, retrying in ${Math.round(delay / 60_000)} min; check the credential or the Meta token`,
        );
        return {
          outcome: 'RETRY',
          error: `media stop ${outcome.reason}`,
          retryAfterMs: delay,
        };
      }
    }
  }
}

/** Keeps the message's place in the transcript without its file or text. */
function toUnsupported(item: MirrorItem): void {
  const { message } = item;
  message.type = 'UNSUPPORTED';
  message.kind = 'OTHER';
  delete message.text;
  delete message.mediaId;
  item.media = undefined;
}
