import { Logger } from '@nestjs/common';

export const STOP_BACKOFF_MS = 15 * 60_000;
const STOP_JITTER_MS = 60_000;
const ALERT_WINDOW_MS = 15 * 60_000;

export interface MirrorDeliveryGateOptions {
  clock?: () => number;
  random?: () => number;
  /** One error-level alert per key per window (default 15 min). */
  alertWindowMs?: number;
  /** Backoff after a credential problem (default 15 min, + up to 60 s). */
  stopBackoffMs?: number;
}

/**
 * Shared by the mirror and status adapters (same `conversation:write`
 * credential): the STOP policy of spec S4.
 *
 *   - `alert`: one error-level log per key per window; repeats are debug, so
 *     a revoked credential does not flood the logs once per conversation.
 *   - `blockConversationWrites`: after a 401/403 on `conversation:write`
 *     every batch of the process waits (RETRY, no HTTP) until the backoff
 *     passes; rows are never killed and the other lanes keep flowing.
 *
 * Messages carry fixed texts only (S6): no phone, no conversationRef.
 */
export class MirrorDeliveryGate {
  private readonly logger = new Logger(MirrorDeliveryGate.name);
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly alertWindowMs: number;
  private readonly stopBackoffMs: number;
  private readonly lastAlertAt = new Map<string, number>();
  private blockedUntil = 0;

  constructor(options: MirrorDeliveryGateOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.alertWindowMs = options.alertWindowMs ?? ALERT_WINDOW_MS;
    this.stopBackoffMs = options.stopBackoffMs ?? STOP_BACKOFF_MS;
  }

  alert(key: string, message: string): void {
    const now = this.clock();
    const last = this.lastAlertAt.get(key);
    if (last !== undefined && now - last < this.alertWindowMs) {
      this.logger.debug(message);
      return;
    }
    this.lastAlertAt.set(key, now);
    this.logger.error(message);
  }

  /** Backoff for a stopped batch, jittered per call. */
  stopDelayMs(): number {
    const jitter = Math.min(Math.max(this.random(), 0), 1);
    return this.stopBackoffMs + Math.round(STOP_JITTER_MS * jitter);
  }

  /** Blocks conversation writes; returns the delay to reschedule rows with. */
  blockConversationWrites(): number {
    const delay = this.stopDelayMs();
    this.blockedUntil = Math.max(this.blockedUntil, this.clock() + delay);
    return delay;
  }

  /** Remaining block in ms (0 when writes may go). */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.clock());
  }
}
