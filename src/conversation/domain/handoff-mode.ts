/**
 * S7 durable handoff mode, stored under the CAS-owned key
 * `conversation_state.data.handoff`.
 *
 * While the mode is HUMAN the bot never calls the LLM for that conversation
 * and never speaks on its own (contract human-intervention-v1 §4). Every
 * order carries the backend's `handoffEpoch`; an older epoch never changes
 * the stored state. See docs/conversation-handoff-mode.md.
 */
export type HandoffMode = 'BOT' | 'HUMAN';

/** One handoff order: the mode the backend says the epoch is in. */
export interface HandoffTransition {
  mode: HandoffMode;
  /** Backend `handoffEpoch`; integer >= 0. */
  epoch: number;
  /** The human request of the session; required (non-empty) for HUMAN. */
  requestId: string | null;
}

/** Persisted shape of `data.handoff`. */
export interface HandoffState extends HandoffTransition {
  /** ISO 8601 — when this state was applied; null only for the default. */
  updatedAt: string | null;
  /**
   * Live conversation T4: the epoch whose greeting actually went out to the
   * customer (absent until one did). Kept while that same epoch ends (a
   * START_TIMEOUT resume notice depends on it), dropped by a newer epoch.
   */
  greetedEpoch?: number;
  /**
   * Live conversation T7: the epoch whose safety notice (contract rule 8,
   * "feed down > 10 min") was already claimed, so a restart or another
   * replica never repeats it. Kept while that same epoch ends, dropped by a
   * newer epoch.
   */
  safetyNoticeEpoch?: number;
}

/** A conversation the bot itself holds in HUMAN mode (reconcile, T7). */
export interface HumanHandoffRef {
  senderId: string;
  epoch: number;
  requestId: string;
}

/** State of a conversation that never had a handoff order. */
export const DEFAULT_HANDOFF_STATE: Readonly<HandoffState> = Object.freeze({
  mode: 'BOT',
  epoch: 0,
  requestId: null,
  updatedAt: null,
});

export type HandoffApplyResult =
  | { applied: true; state: HandoffState }
  | {
      applied: false;
      /**
       * STALE_EPOCH: older epoch, or an illegal same-epoch transition
       * (a session that already ended cannot restart at the same epoch).
       * DUPLICATE: exact replay of the stored state; nothing to do.
       * INVALID: malformed order, or a corrupt stored value (never
       * overwritten blindly; operator repair).
       */
      reason: 'STALE_EPOCH' | 'DUPLICATE' | 'INVALID';
    };

/** Thrown when `data.handoff` exists but is not a valid HandoffState. */
export class CorruptHandoffStateError extends Error {
  constructor(senderId: string) {
    super(`corrupt data.handoff for sender ${senderId}`);
    this.name = 'CorruptHandoffStateError';
  }
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRequestId(value: unknown, mode: unknown): value is string | null {
  if (value === null) return mode === 'BOT';
  return typeof value === 'string' && value.length > 0;
}

/** Structural guard for an incoming order. */
export function isHandoffTransition(
  value: unknown,
): value is HandoffTransition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.mode === 'BOT' || candidate.mode === 'HUMAN') &&
    isEpoch(candidate.epoch) &&
    isRequestId(candidate.requestId, candidate.mode)
  );
}

/**
 * Reads a stored `data.handoff` value: the default when absent or JSON null,
 * a detached copy when valid, and `null` when present but corrupt.
 */
export function readHandoffState(raw: unknown): HandoffState | null {
  if (raw === undefined || raw === null) return { ...DEFAULT_HANDOFF_STATE };
  if (!isHandoffTransition(raw)) return null;
  // SAFETY: isHandoffTransition proved `raw` is a non-null object.
  const updatedAt = (raw as unknown as Record<string, unknown>).updatedAt;
  if (updatedAt !== null && typeof updatedAt !== 'string') return null;
  // A malformed marker is dropped, never fatal: the mode is what fails closed.
  const greetedEpoch = (raw as unknown as Record<string, unknown>).greetedEpoch;
  const safetyNoticeEpoch = (raw as unknown as Record<string, unknown>)
    .safetyNoticeEpoch;
  return {
    mode: raw.mode,
    epoch: raw.epoch,
    requestId: raw.requestId,
    updatedAt,
    ...(isEpoch(greetedEpoch) ? { greetedEpoch } : {}),
    ...(isEpoch(safetyNoticeEpoch) ? { safetyNoticeEpoch } : {}),
  };
}

/** True for an epoch value usable as `greetedEpoch` (integer >= 0). */
export const isGreetedEpoch = isEpoch;

/**
 * The epoch-monotonic CAS rule shared by every adapter:
 *   - epoch < stored → STALE_EPOCH;
 *   - epoch > stored → apply (either mode);
 *   - same epoch: HUMAN → BOT ends that session (apply); the same mode
 *     (and, for HUMAN, the same requestId) is a DUPLICATE; anything else
 *     (BOT → HUMAN, HUMAN with another requestId) is STALE_EPOCH.
 */
export function decideHandoffTransition(
  stored: HandoffState,
  next: HandoffTransition,
): 'APPLY' | 'STALE_EPOCH' | 'DUPLICATE' {
  if (next.epoch < stored.epoch) return 'STALE_EPOCH';
  if (next.epoch > stored.epoch) return 'APPLY';
  if (stored.mode === 'HUMAN' && next.mode === 'BOT') return 'APPLY';
  if (stored.mode === 'BOT' && next.mode === 'BOT') return 'DUPLICATE';
  if (
    stored.mode === 'HUMAN' &&
    next.mode === 'HUMAN' &&
    stored.requestId === next.requestId
  ) {
    return 'DUPLICATE';
  }
  return 'STALE_EPOCH';
}

/** Full CAS outcome for a stored raw value; the state to persist on APPLY. */
export function resolveHandoffApply(
  storedRaw: unknown,
  next: unknown,
  now: string,
): HandoffApplyResult {
  if (!isHandoffTransition(next)) return { applied: false, reason: 'INVALID' };
  const stored = readHandoffState(storedRaw);
  if (stored === null) return { applied: false, reason: 'INVALID' };
  const decision = decideHandoffTransition(stored, next);
  if (decision !== 'APPLY') return { applied: false, reason: decision };
  return {
    applied: true,
    state: {
      mode: next.mode,
      epoch: next.epoch,
      requestId: next.requestId,
      updatedAt: now,
      ...(stored.greetedEpoch !== undefined && stored.epoch === next.epoch
        ? { greetedEpoch: stored.greetedEpoch }
        : {}),
      ...(stored.safetyNoticeEpoch !== undefined && stored.epoch === next.epoch
        ? { safetyNoticeEpoch: stored.safetyNoticeEpoch }
        : {}),
    },
  };
}
