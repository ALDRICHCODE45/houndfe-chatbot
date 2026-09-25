/**
 * HD-R3b1 spec: pure shared-reservation classifier over one verified `existing`
 * reading only — no CAS, SQL race, store write or send.
 */
import type { RestockIntakeInput } from '../../chatbot-api/domain/dtos/human-decisions.dto';
import {
  classifyReservation,
  type ActiveReservation,
  type ReservationBlockedReason,
  type ReservationDecision,
  type ReservationProposal,
  type ReservationRoute,
} from './shared-reservation';

const SENDER = 'whatsapp:+5215500000001';
const LEGACY_KEY = 'a1b2c3d4e5f6';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const intake = (o: Partial<RestockIntakeInput> = {}): RestockIntakeInput => ({
  sourceRequestId: A,
  type: 'RESTOCK',
  productId: B,
  productName: 'Alimento premium',
  variantId: null,
  sku: null,
  requestedQuantity: 2,
  observedStockAtRequest: null,
  stockObservedAt: null,
  supersedesDecisionId: null,
  ...o,
});

type Over = { senderId?: unknown; requestKey?: unknown; intake?: unknown };

const proposal = (route: ReservationRoute, o: Over = {}) =>
  ({
    route,
    senderId: SENDER,
    requestKey: route === 'LEGACY_OPS' ? LEGACY_KEY : A,
    intake: route === 'LEGACY_OPS' ? null : intake(),
    ...o,
  }) as ReservationProposal;
const legacy = (o: Over = {}) => proposal('LEGACY_OPS', o);
const restock = (o: Over = {}) => proposal('RESTOCK', o);
const bad = (payload: unknown) => restock({ intake: payload });

const ROW = { status: 'ACTIVE', senderId: SENDER };
const active = (
  route: ReservationRoute = 'LEGACY_OPS',
  requestKey = LEGACY_KEY,
  intake: unknown = null,
): ActiveReservation =>
  ({ ...ROW, route, requestKey, intake }) as ActiveReservation;
const heldRow = (payload: unknown) => active('RESTOCK', A, payload);

const decision = (action: string, reason: string): ReservationDecision =>
  ({ action, reason }) as ReservationDecision;
const blocked = (reason: ReservationBlockedReason): ReservationDecision =>
  decision('blocked', reason);
const CLAIM = decision('claim', 'single_sender_vacant');
const REPLAY = decision('replay', 'exact_active_replay');
const CONFLICT = decision('conflict', 'same_key_different_payload');
const ROUTE_CLASH = decision('conflict', 'same_key_different_route');
const LEGACY_HELD = decision('occupied_legacy', 'legacy_marker_present');
const AMBIGUOUS = blocked('ambiguous_active_hold');
const INDETERMINATE = blocked('indeterminate_legacy_marker');
const MALFORMED = blocked('malformed_proposal');
const occupied = (activeRoute: ReservationRoute): ReservationDecision => ({
  action: 'occupied',
  reason: 'different_active_key',
  activeRoute,
});

const classify = (
  p: ReservationProposal,
  existing: ActiveReservation | 'absent' | 'unknown',
  marker: unknown = false,
): ReservationDecision =>
  classifyReservation({
    proposal: p,
    existing,
    legacyMarkerPresent: marker as boolean | 'unknown',
  });

const hostile = (key: string): unknown =>
  Object.defineProperty({}, key, {
    get() {
      throw new Error('hostile');
    },
  });

const MALFORMED_PROPOSALS: ReadonlyArray<[string, ReservationProposal]> = [
  ['malformed legacy key', legacy({ requestKey: 'XYZ' })],
  ['malformed RESTOCK key', restock({ requestKey: 'nope' })],
  ['legacy RESTOCK payload', legacy({ intake: intake() })],
  ['RESTOCK without payload', bad(null)],
  ['unbound RESTOCK key', bad(intake({ sourceRequestId: B }))],
  ['blank sender', restock({ senderId: ' ' })],
  ['key-only payload', bad({ type: 'RESTOCK', sourceRequestId: A })],
  ['extra-field payload', bad({ ...intake(), ok: 1 })],
  ['undefined optional', bad({ ...intake(), variantId: undefined })],
  ['payload needing trim', bad(intake({ productName: ' A ' }))],
  ['instant drift', bad(intake({ stockObservedAt: '2026-01-01T00:00:00.5Z' }))],
];

const UNPROVABLE: ReadonlyArray<[string, ActiveReservation]> = [
  ['absent payload', heldRow(null)],
  ['key-only payload', heldRow({ type: 'RESTOCK', sourceRequestId: A })],
  ['extra-field payload', heldRow({ ...intake(), ok: 1 })],
  ['undefined optional', heldRow({ ...intake(), variantId: undefined })],
];

describe('classifyReservation', () => {
  it('claims, honors a literal marker, replays, conflicts and occupies', () => {
    const held = heldRow(intake());
    expect(classify(restock(), 'absent')).toEqual(CLAIM);
    expect(classify(restock(), 'absent', true)).toEqual(LEGACY_HELD);
    expect(classify(legacy(), active())).toEqual(REPLAY);
    expect(classify(restock(), held)).toEqual(REPLAY);
    expect(classify(bad(intake({ requestedQuantity: 3 })), held)).toEqual(
      CONFLICT,
    );
    expect(classify(restock(), active('LEGACY_OPS', A))).toEqual(ROUTE_CLASH);
    expect(classify(restock(), active())).toEqual(occupied('LEGACY_OPS'));
    expect(classify(legacy(), held)).toEqual(occupied('RESTOCK'));
    const other = restock({
      requestKey: B,
      intake: intake({ sourceRequestId: B }),
    });
    expect(classify(other, held)).toEqual(occupied('RESTOCK'));
  });

  it.each(MALFORMED_PROPOSALS)('%s blocks as malformed', (_n, p) => {
    expect(classify(p, 'absent')).toEqual(MALFORMED);
  });

  it('fails closed on unknown, indeterminate or mismatched state', () => {
    const held = heldRow(intake());
    expect(classify(restock(), 'unknown')).toEqual(blocked('unknown_existing'));
    expect(classify(restock(), 'absent', 'unknown')).toEqual(INDETERMINATE);
    expect(classify(restock(), { ...held, senderId: 'x' })).toEqual(
      blocked('sender_mismatch'),
    );
    expect(classify(restock(), active('RESTOCK', '', intake()))).toEqual(
      blocked('malformed_existing'),
    );
  });

  it.each([undefined, null, '', 'true', 0, {}, [], NaN])(
    'blocks marker %p',
    (m) => {
      expect(
        classifyReservation({
          proposal: restock(),
          existing: 'absent',
          legacyMarkerPresent: m as boolean | 'unknown',
        }),
      ).toEqual(INDETERMINATE);
    },
  );

  it.each(UNPROVABLE)('holds an ACTIVE row with %s', (_n, held) => {
    expect(classify(restock(), held)).toEqual(AMBIGUOUS);
  });

  it('holds an ACTIVE RESTOCK while legacy state may be pending', () => {
    expect(classify(restock(), heldRow(intake()), true)).toEqual(AMBIGUOUS);
    expect(classify(restock(), heldRow(intake()), 'unknown')).toEqual(
      INDETERMINATE,
    );
    expect(classify(restock(), active(), 'unknown')).toEqual(INDETERMINATE);
    expect(classify(legacy(), active(), true)).toEqual(REPLAY);
  });

  it('blocks a null or hostile input instead of throwing', () => {
    expect(classifyReservation(null as never).action).toBe('blocked');
    expect(classify(restock(), null as never).action).toBe('blocked');
    expect(
      classifyReservation({
        proposal: hostile('senderId') as never,
        existing: 'absent',
        legacyMarkerPresent: false,
      }).action,
    ).toBe('blocked');
    expect(classify(restock(), hostile('status') as never).action).toBe(
      'blocked',
    );
  });

  it('is deterministic and never mutates its inputs', () => {
    const p = restock();
    const existing = heldRow(intake());
    const snap = structuredClone({ p, existing });
    expect(classify(p, existing)).toEqual(classify(p, existing));
    expect({ p, existing }).toEqual(snap);
  });
});
