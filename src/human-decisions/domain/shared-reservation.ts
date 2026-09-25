/**
 * HD-R3b1 — shared, route-agnostic ACTIVE reservation policy + port for legacy
 * ops (12-hex) and RESTOCK (UUID) keys. Pure decision over a verified `existing`
 * reading: never SQL/CAS proof, never `ConversationStore.update`, no release, so
 * an ambiguous POST or `DELIVERY_UNKNOWN` keeps ACTIVE.
 */
import {
  normalizeRestockIntake,
  type RestockIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';

export type ReservationRoute = 'LEGACY_OPS' | 'RESTOCK';

const LEGACY_KEY = /^[0-9a-f]{12}$/;
const UUID_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTAKE_FIELDS =
  'sourceRequestId type productId productName variantId sku requestedQuantity observedStockAtRequest stockObservedAt supersedesDecisionId'.split(
    ' ',
  ) as ReadonlyArray<keyof RestockIntakeInput>;

export type ReservationProposal = {
  readonly senderId: string;
  readonly requestKey: string;
} & (
  | { readonly route: 'LEGACY_OPS'; readonly intake: null }
  | { readonly route: 'RESTOCK'; readonly intake: RestockIntakeInput }
);

export interface ActiveReservation {
  readonly status: 'ACTIVE';
  readonly route: ReservationRoute;
  readonly senderId: string;
  readonly requestKey: string;
  readonly intake: RestockIntakeInput | null;
}

export interface ReservationClassifyInput {
  readonly proposal: ReservationProposal;
  readonly existing: ActiveReservation | 'absent' | 'unknown';
  readonly legacyMarkerPresent: boolean | 'unknown';
}

export type ReservationBlockedReason =
  | 'malformed_proposal'
  | 'unknown_existing'
  | 'malformed_existing'
  | 'ambiguous_active_hold'
  | 'sender_mismatch'
  | 'indeterminate_legacy_marker';

export type ReservationDecision =
  | { readonly action: 'claim'; readonly reason: 'single_sender_vacant' }
  | { readonly action: 'replay'; readonly reason: 'exact_active_replay' }
  | {
      readonly action: 'conflict';
      readonly reason:
        | 'same_key_different_payload'
        | 'same_key_different_route';
    }
  | {
      readonly action: 'occupied';
      readonly reason: 'different_active_key';
      readonly activeRoute: ReservationRoute;
    }
  | {
      readonly action: 'occupied_legacy';
      readonly reason: 'legacy_marker_present';
    }
  | { readonly action: 'blocked'; readonly reason: ReservationBlockedReason };

const blocked = (reason: ReservationBlockedReason): ReservationDecision => ({
  action: 'blocked',
  reason,
});
const nonBlank = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const isRoute = (v: unknown): v is ReservationRoute =>
  v === 'LEGACY_OPS' || v === 'RESTOCK';
const isRequestKey = (route: ReservationRoute, key: unknown): boolean =>
  typeof key === 'string' &&
  (route === 'LEGACY_OPS' ? LEGACY_KEY : UUID_KEY).test(key);

function validatedPayload(
  route: ReservationRoute,
  requestKey: string,
  intake: unknown,
): RestockIntakeInput | null | undefined {
  if (route === 'LEGACY_OPS') return intake === null ? null : undefined;
  const normalized = normalizeRestockIntake(intake);
  if (normalized === null || normalized.sourceRequestId !== requestKey) {
    return undefined;
  }
  const raw = intake as Record<keyof RestockIntakeInput, unknown>;
  return INTAKE_FIELDS.some((f) => !Object.is(raw[f], normalized[f]))
    ? undefined
    : normalized;
}

const asMarker = (v: unknown): boolean | 'unknown' | null =>
  v === true || v === false || v === 'unknown' ? v : null;

/**
 * Pure decision for one proposal against a verified `existing` reading. Fail
 * closed on malformed/unknown/mismatch; holds an unprovable payload; equality
 * yields replay/conflict/occupied, holding replay while an ACTIVE RESTOCK may
 * still have a concurrent legacy pending. Never reserves.
 */
export function classifyReservation(
  input: ReservationClassifyInput,
): ReservationDecision {
  try {
    const { proposal } = input;
    if (!nonBlank(proposal.senderId) || !isRoute(proposal.route)) {
      return blocked('malformed_proposal');
    }
    const route = proposal.route;
    const payload = validatedPayload(
      route,
      proposal.requestKey,
      proposal.intake,
    );
    if (!isRequestKey(route, proposal.requestKey) || payload === undefined) {
      return blocked('malformed_proposal');
    }
    const existing = input.existing;
    if (existing === 'unknown') return blocked('unknown_existing');
    const marker = asMarker(input.legacyMarkerPresent);
    if (marker === null || marker === 'unknown') {
      return blocked('indeterminate_legacy_marker');
    }
    if (existing === 'absent') {
      return marker
        ? { action: 'occupied_legacy', reason: 'legacy_marker_present' }
        : { action: 'claim', reason: 'single_sender_vacant' };
    }
    if (existing === null || typeof existing !== 'object') {
      return blocked('malformed_existing');
    }
    if (
      existing.status !== 'ACTIVE' ||
      !isRoute(existing.route) ||
      !nonBlank(existing.senderId) ||
      !nonBlank(existing.requestKey)
    ) {
      return blocked('malformed_existing');
    }
    if (existing.senderId !== proposal.senderId) {
      return blocked('sender_mismatch');
    }
    const held = validatedPayload(
      existing.route,
      existing.requestKey,
      existing.intake,
    );
    if (held === undefined) return blocked('ambiguous_active_hold');

    const sameKey = existing.requestKey === proposal.requestKey;
    if (existing.route === route && sameKey) {
      // Validated payloads stringify canonically (fixed key order upstream).
      if (JSON.stringify(payload) !== JSON.stringify(held)) {
        return { action: 'conflict', reason: 'same_key_different_payload' };
      }
      // A concurrent legacy pending cannot share the replay: hold instead.
      if (existing.route === 'RESTOCK' && marker !== false) {
        return blocked('ambiguous_active_hold');
      }
      return { action: 'replay', reason: 'exact_active_replay' };
    }
    if (sameKey) {
      return { action: 'conflict', reason: 'same_key_different_route' };
    }
    return {
      action: 'occupied',
      reason: 'different_active_key',
      activeRoute: existing.route,
    };
  } catch {
    return blocked('malformed_proposal');
  }
}

/**
 * Atomic single-sender claim port (contract only; no adapter, no wiring).
 * A later adapter MUST provide one durable compare-and-set across BOTH routes;
 * never `ConversationStore.update`, and no release in v1.
 */
export interface SharedReservationPort {
  reserve(proposal: ReservationProposal): Promise<ReservationDecision>;
}

/** Nest DI token for the `SharedReservationPort` binding. */
export const SHARED_RESERVATION = Symbol('SHARED_RESERVATION');
