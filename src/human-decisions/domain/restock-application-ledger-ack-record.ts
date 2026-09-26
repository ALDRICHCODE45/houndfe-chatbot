import { types } from 'node:util';
import {
  normalizeRestockApplicationOutcomeAck,
  type RestockApplicationOutcomeAck,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  prepareRestockApplicationOutcome,
  type RestockApplicationOutcomePreparation,
} from './restock-application-ledger-ack-preparation';

type TerminalRow = Extract<
  RestockApplicationOutcomePreparation,
  { action: 'prepared' }
>['expected'];
export type RestockApplicationAckRecord = Readonly<{
  row: TerminalRow;
  receipt: Readonly<RestockApplicationOutcomeAck>;
}>;
export type RestockApplicationAckRecordDecision =
  | Readonly<{
      action: 'record';
      expectedRow: TerminalRow;
      expectedRecord: null;
      next: RestockApplicationAckRecord;
    }>
  | Readonly<{ action: 'replay'; record: RestockApplicationAckRecord }>
  | Readonly<{ action: 'hold' }>;

/** Descriptor-only copy: reject proxies before invoking any traps. */
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

function bind(
  row: unknown,
  receipt: unknown,
): RestockApplicationAckRecord | null {
  const prepared = prepareRestockApplicationOutcome(snapshot(row));
  if (prepared.action !== 'prepared') return null;
  const received = snapshot(receipt);
  const bound = normalizeRestockApplicationOutcomeAck(
    received,
    prepared.decisionId,
    prepared.request,
  );
  if (!bound || !received || typeof received.ackReceivedAt !== 'string')
    return null;
  // DTO validates server time but canonicalizes it; keep the received bytes.
  return Object.freeze({
    row: prepared.expected,
    receipt: Object.freeze({ ...bound, ackReceivedAt: received.ackReceivedAt }),
  });
}

/** Validate and detach the entire persisted local record, not just its IDs. */
export function normalizeRestockApplicationAckRecord(
  value: unknown,
): RestockApplicationAckRecord | null {
  try {
    const record = snapshot(value);
    if (
      !record ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, 'row') ||
      !Object.hasOwn(record, 'receipt')
    )
      return null;
    return bind(record.row, record.receipt);
  } catch {
    return null;
  }
}

function sameData(
  left: TerminalRow | Readonly<RestockApplicationOutcomeAck>,
  right: TerminalRow | Readonly<RestockApplicationOutcomeAck>,
): boolean {
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(([key, value]) =>
      b.some(
        ([otherKey, otherValue]) => key === otherKey && value === otherValue,
      ),
    )
  );
}

/**
 * Inert LOCAL recommendations, not durable proof, API permission, provider
 * provenance or customer delivery. Receipt means server reporting ACK, NOT
 * send confirmation. Caller must correlate the actual HTTP response with the
 * exact prepared request: pure validation cannot prove response origin.
 * Adapter MUST atomically compare the exact current terminal row AND absent
 * ACK slot before recording. Never overwrite a conflict or infer another send.
 * Server ACK time follows the DTO contract, not the local sender's clock.
 */
export function classifyRestockApplicationAckRecord(
  row: unknown,
  receipt: unknown,
  previousRecord: unknown,
): RestockApplicationAckRecordDecision {
  const hold = Object.freeze({ action: 'hold' as const });
  try {
    const next = bind(row, receipt);
    if (!next) return hold;
    if (previousRecord === null) {
      return Object.freeze({
        action: 'record',
        expectedRow: next.row,
        expectedRecord: null,
        next,
      });
    }
    const previous = normalizeRestockApplicationAckRecord(previousRecord);
    if (
      !previous ||
      !sameData(previous.row, next.row) ||
      !sameData(previous.receipt, next.receipt)
    )
      return hold;
    return Object.freeze({ action: 'replay', record: previous });
  } catch {
    return hold;
  }
}
