import { Logger } from '@nestjs/common';
import type { HumanHandoffRef } from '../../conversation/domain/handoff-mode';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import { describeError } from '../../common/log-safe';
import { styleFixedCopy } from '../domain/human-request-feed';

/**
 * Live conversation T7, contract rule 8 (safety notice, S5 copy approved by
 * the owner): when the feed has been down for more than 10 minutes while a
 * conversation is HUMAN and its 24 h window is open, tell the customer ONCE
 * per epoch «Tenemos una falla técnica, en cuanto se resuelva le respondemos.»
 * and stay silent.
 */
export const SAFETY_NOTICE =
  'Tenemos una falla técnica, en cuanto se resuelva le respondemos.';

/** The feed counts as down after this long without a successful sync. */
export const FEED_DOWN_AFTER_MS = 10 * 60_000;

/** At most this many HUMAN conversations are examined per run. */
export const SAFETY_MAX_CONVERSATIONS = 500;

export interface LiveSafetyPorts {
  /** The last instant the feed consumer completed a page (durable and
   *  shared by every replica: `HumanRequestFeedStore.readSyncedAt`), or
   *  null when unknown. */
  feedSyncedAt(): Promise<string | null>;
  /** The conversations held in HUMAN mode locally. */
  listHuman(limit: number): Promise<HumanHandoffRef[]>;
  /** Rejects when the read fails (transient, never "closed"). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Durable at-most-once claim of the epoch's notice; true for one caller. */
  claim(senderId: string, epoch: number): Promise<boolean>;
  /** Sends the text as a BOT message (mirrored like any bot message). */
  send(senderId: string, text: string): Promise<void>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
}

export type SafetyRunResult =
  | { kind: 'healthy' }
  | { kind: 'unknown' }
  | { kind: 'down'; sent: number; failed: number };

export class LiveConversationSafety {
  private readonly logger = new Logger(LiveConversationSafety.name);
  private readonly clock: () => number;

  constructor(
    private readonly ports: LiveSafetyPorts,
    options: { clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

  /**
   * One pass. Reads one cursor row while the feed is healthy and nothing else
   * (the cheap path). Never throws for a single conversation: a failure is
   * logged without the phone and the pass carries on. Throws only when the
   * feed timestamp or the HUMAN list cannot be read.
   */
  async run(): Promise<SafetyRunResult> {
    const syncedAt = await this.ports.feedSyncedAt();
    if (syncedAt === null) return { kind: 'unknown' };
    const syncedMs = Date.parse(syncedAt);
    if (!Number.isFinite(syncedMs)) return { kind: 'unknown' };
    if (this.clock() - syncedMs <= FEED_DOWN_AFTER_MS)
      return { kind: 'healthy' };

    const humans = await this.ports.listHuman(SAFETY_MAX_CONVERSATIONS);
    let sent = 0;
    let failed = 0;
    for (const human of humans) {
      try {
        // Window first: a closed window must not burn the epoch's claim.
        if (!(await this.ports.isWindowOpen(human.senderId))) continue;
        if (!(await this.ports.claim(human.senderId, human.epoch))) continue;
        // At-most-once: the claim is durable BEFORE the send.
        const text = styleFixedCopy(
          SAFETY_NOTICE,
          await this.readStyle(human.senderId),
        );
        try {
          await this.ports.send(human.senderId, text);
          sent += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `safety notice send failed, not retried: ${describeError(error)}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `safety notice check failed for a conversation: ${describeError(error)}`,
        );
      }
    }
    if (sent > 0 || failed > 0)
      this.logger.warn(
        `feed down for more than ${FEED_DOWN_AFTER_MS / 60_000} min: safety notice sent to ${sent} conversation(s), ${failed} failed`,
      );
    return { kind: 'down', sent, failed };
  }

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }
}
