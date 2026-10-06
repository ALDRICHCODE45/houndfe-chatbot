import { types } from 'node:util';
import {
  normalizeRestockApplicationOutcomeAck,
  type RestockApplicationOutcomeAck,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  prepareExpirationApplicationOutcome,
  type ExpirationApplicationOutcomePreparation,
} from './expiration-application-ledger-ack-preparation';

type TerminalRow = Extract<
  ExpirationApplicationOutcomePreparation,
  { action: 'prepared' }
>['expected'];
export type ExpirationApplicationAckBinding =
  | Readonly<{
      action: 'bound';
      expected: TerminalRow;
      receipt: Readonly<RestockApplicationOutcomeAck>;
    }>
  | Readonly<{ action: 'hold' }>;

/** Descriptor-only snapshot; reject proxies before any reflective operation. */
function snapshot(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || types.isProxy(value))
    return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

/** INACTIVE pure binding, not durable ACK, HTTP provenance or delivery proof.
 * A trusted caller must correlate the actual response with its exact request
 * and prove the current persisted terminal row. This neither records/replays
 * an ACK nor sends, retries or closes a reservation. STALE still needs no-send
 * proof; LATE never grants automatic closure. No local clock is consulted.
 */
export function bindExpirationApplicationOutcomeAck(
  row: unknown,
  receipt: unknown,
): ExpirationApplicationAckBinding {
  const hold = Object.freeze({ action: 'hold' as const });
  try {
    const prepared = prepareExpirationApplicationOutcome(snapshot(row));
    if (prepared.action !== 'prepared') return hold;
    const received = snapshot(receipt);
    // Shared DTO accepts UUID case aliases; EXPIRATION binds exact bytes.
    if (
      !received ||
      received.id !== prepared.decisionId ||
      received.attemptId !== prepared.request.attemptId
    )
      return hold;
    const bound = normalizeRestockApplicationOutcomeAck(
      received,
      prepared.decisionId,
      prepared.request,
    );
    if (!bound || typeof received.ackReceivedAt !== 'string') return hold;
    return Object.freeze({
      action: 'bound',
      expected: prepared.expected,
      // Validate server time using the DTO, but retain the received spelling.
      receipt: Object.freeze({
        ...bound,
        ackReceivedAt: received.ackReceivedAt,
      }),
    });
  } catch {
    return hold;
  }
}
