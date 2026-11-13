import type { LiveConversationMode } from '../../chatbot-api/domain/dtos/live-conversation.dto';

/**
 * What the producers of a reconcile signal need from the live reconcile
 * worker (unit 11, T7). Structural on purpose: the worker lives in
 * `human-requests`, which depends on this module, never the other way.
 */
export interface LiveReconcileTarget {
  /** The `{mode, handoffEpoch}` a `messages:batch` answered. Synchronous,
   *  never throws. */
  hint(
    conversationRef: string,
    hint: { mode: LiveConversationMode; handoffEpoch: number },
  ): void;
  /** One single-conversation reconcile (a refused session-ack). Never
   *  rejects. */
  reconcileOne(conversationRef: string): Promise<unknown>;
}

/**
 * Late-bound holder of the reconcile worker. The worker is built on
 * application bootstrap (it needs the pool and the live client), after the
 * services that signal it exist, and the mirror module signals it without
 * importing `human-requests` (no module cycle). Until the worker is set,
 * and after it stops, every signal is a no-op.
 */
export interface LiveReconcileRef {
  current?: LiveReconcileTarget;
}

export const LIVE_RECONCILE_REF = Symbol('LIVE_RECONCILE_REF');
