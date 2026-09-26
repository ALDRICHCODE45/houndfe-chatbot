/**
 * SQ-5C3b: narrow async, server-owned shipping-approval request lifecycle.
 * Reads the stored draft, gates through `prepareShippingApprovalRequest`,
 * creates one `shipping_approval` handoff, then verifies the durable row and
 * the fresh canonical pending marker. Output is finite, frozen, price-free
 * (`{ ok: true }` or `{ ok: false, reason }`). Fail-closed: seam/transport
 * errors, a wrong-kind or drifted row, a missing/replaced marker, a prior
 * decision, or a draft that expires across the async call never yield
 * success. No cross-store atomicity is claimed after the final read.
 */
import type {
  HumanHandoffCreateInput,
  HumanHandoffCreateResult,
} from '../../human-handoff/application/human-handoff.service';
import type {
  HumanHandoffRequest,
  ShippingApprovalDigest,
} from '../../human-handoff/domain/human-handoff.types';
import {
  isPendingHumanRequest,
  isPendingHumanRequestId,
  readPendingHumanRequest,
  type ConversationState,
} from '../../conversation/domain/conversation-store';
import { buildShippingApprovalDigest } from './shipping-approval';
import {
  prepareShippingApprovalRequest,
  type ShippingApprovalTriggerResult,
} from './shipping-approval-trigger';
import { readShippingQuoteDraft } from './shipping-quote-draft-persistence';

export type ShippingApprovalRequestFailure =
  | 'unavailable'
  | 'pending_handoff'
  | 'prior_decision'
  | 'malformed_state'
  | 'handoff_failed'
  | 'verification_failed';

export type ShippingApprovalRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ShippingApprovalRequestFailure };

/** Structural seams keep this application layer free of a runtime
 *  human-handoff import cycle. */
export interface ShippingApprovalRequestDeps {
  readonly conversationStore: {
    get(senderId: string): Promise<ConversationState | null>;
  };
  readonly handoffCreator: {
    create(input: HumanHandoffCreateInput): Promise<HumanHandoffCreateResult>;
  };
  readonly handoffRows: {
    findById(id: string): Promise<HumanHandoffRequest | null>;
  };
  readonly now: () => number;
}

type BlockedKind = Exclude<ShippingApprovalTriggerResult['kind'], 'ready'>;

const BLOCKED_REASON: Record<BlockedKind, ShippingApprovalRequestFailure> = {
  pending_handoff: 'pending_handoff',
  prior_decision: 'prior_decision',
  malformed_state: 'malformed_state',
  unavailable: 'unavailable',
};

const OK: ShippingApprovalRequestResult = Object.freeze({ ok: true });

const fail = (
  reason: ShippingApprovalRequestFailure,
): ShippingApprovalRequestResult => Object.freeze({ ok: false, reason });

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
};

/** Exact match of every redacted digest field, including the draft pin, so a
 *  row reusing the pin with a different amount/carrier is rejected. */
function digestMatches(
  raw: unknown,
  expected: ShippingApprovalDigest,
): boolean {
  try {
    if (!isPlainObject(raw) || raw.kind !== 'shipping_approval') return false;
    return (
      raw.draftCreatedAt === expected.draftCreatedAt &&
      raw.customerPaysCents === expected.customerPaysCents &&
      raw.totalCreditCents === expected.totalCreditCents &&
      raw.carrierName === expected.carrierName &&
      raw.serviceName === expected.serviceName &&
      raw.estimatedDeliveryDays === expected.estimatedDeliveryDays
    );
  } catch {
    return false;
  }
}

/** Guarded snapshot: hostile or throwing getters fail closed, never reject. */
function takeCreated(
  value: unknown,
): { readonly requestId: string; readonly ref: string } | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    const result = value as Record<string, unknown>;
    if (result.ok !== true || result.customerNotified !== true) return null;
    const { requestId, ref } = result;
    if (!isPendingHumanRequestId(requestId)) return null;
    if (ref !== `HF-${requestId}`) return null;
    return { requestId, ref: String(ref) };
  } catch {
    return null;
  }
}

/** Guarded durable-row check after the create race: a wrong-kind, absent,
 *  foreign, or drifted row, or a hostile getter, is never accepted. */
function isVerifiableRow(
  row: unknown,
  requestId: string,
  senderId: string,
  digest: ShippingApprovalDigest,
): boolean {
  try {
    if (typeof row !== 'object' || row === null) return false;
    const record = row as Record<string, unknown>;
    return (
      record.id === requestId &&
      record.customerId === senderId &&
      record.kind === 'shipping_approval' &&
      record.status === 'pending' &&
      record.resolution === null &&
      digestMatches(record.digest, digest)
    );
  } catch {
    return false;
  }
}

/** Guarded fresh-state check: the pending marker must still point at this
 *  request, no decision may appear, and the digest rebuilt from the current
 *  draft must match the original field-for-field. Matching the pin alone is
 *  insufficient because a racing writer can keep `createdAt` while changing
 *  the rate or the financial amounts. */
function hasFreshApproval(
  fresh: ConversationState | null,
  requestId: string,
  ref: string,
  digest: ShippingApprovalDigest,
  laterMs: number,
): boolean {
  try {
    if (fresh === null || !isPlainObject(fresh.data)) return false;
    const marker = readPendingHumanRequest(fresh);
    if (
      marker === null ||
      !isPendingHumanRequest(marker) ||
      marker.requestId !== requestId ||
      marker.ref !== ref
    ) {
      return false;
    }
    const prior = fresh.data.shippingApproval;
    if (prior !== undefined && prior !== null) return false;
    const freshDraft = readShippingQuoteDraft(fresh, laterMs);
    const freshDigest = buildShippingApprovalDigest(freshDraft, laterMs);
    return freshDigest !== null && digestMatches(freshDigest, digest);
  } catch {
    return false;
  }
}

export async function requestShippingApproval(
  deps: ShippingApprovalRequestDeps,
  senderId: string,
): Promise<ShippingApprovalRequestResult> {
  let nowMs: number;
  let state: ConversationState | null;
  try {
    nowMs = deps.now();
    state = await deps.conversationStore.get(senderId);
  } catch {
    return fail('unavailable');
  }

  const prepared = prepareShippingApprovalRequest(
    state,
    readShippingQuoteDraft(state, nowMs),
    nowMs,
  );
  if (prepared.kind !== 'ready') return fail(BLOCKED_REASON[prepared.kind]);
  const digest = prepared.digest;

  let created: HumanHandoffCreateResult;
  try {
    created = await deps.handoffCreator.create({
      senderId,
      kind: 'shipping_approval',
      digest,
    });
  } catch {
    return fail('handoff_failed');
  }
  const request = takeCreated(created);
  if (request === null) return fail('handoff_failed');
  const { requestId, ref } = request;

  let row: HumanHandoffRequest | null;
  try {
    row = await deps.handoffRows.findById(requestId);
  } catch {
    return fail('verification_failed');
  }
  if (!isVerifiableRow(row, requestId, senderId, digest)) {
    return fail('verification_failed');
  }

  let fresh: ConversationState | null;
  let laterMs: number;
  try {
    fresh = await deps.conversationStore.get(senderId);
    laterMs = deps.now();
  } catch {
    return fail('verification_failed');
  }
  if (!hasFreshApproval(fresh, requestId, ref, digest, laterMs)) {
    return fail('verification_failed');
  }
  return OK;
}
