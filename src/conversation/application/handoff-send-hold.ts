import type { HandoffModeService } from './handoff-mode.service';

/** What a proactive sender needs from the S7 handoff mode. */
export type HandoffModeReader = Pick<HandoffModeService, 'isHumanMode'>;

export type HandoffSendHold =
  | { hold: false }
  | { hold: true; reason: 'HUMAN' }
  | { hold: true; reason: 'MODE_UNREADABLE'; error: string };

/** Delay before a held customer send is tried again. */
export const HANDOFF_HOLD_RETRY_MS = 60_000;

/**
 * S7 ("never speak on its own while the epoch is HUMAN"): checked right
 * before a proactive customer send. A held send must be deferred through the
 * flow's own retry mechanism, never marked delivered or failed. An unreadable
 * mode holds too (fail closed). Without a reader (hand-built harnesses) the
 * send goes ahead.
 */
export async function checkHandoffSendHold(
  reader: HandoffModeReader | undefined,
  senderId: string,
): Promise<HandoffSendHold> {
  if (reader === undefined) return { hold: false };
  try {
    return (await reader.isHumanMode(senderId))
      ? { hold: true, reason: 'HUMAN' }
      : { hold: false };
  } catch (error) {
    return {
      hold: true,
      reason: 'MODE_UNREADABLE',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
