/**
 * HD-R3b1+EXPIRATION spec: pure EXPIRATION classification over one verified
 * `existing` reading. Route-explicit dispatch, exact replay/payload conflict,
 * cross-route occupancy/clash, fail-closed state, immutable inputs, no effects.
 */
import {
  classifyReservation,
  type ReservationClassifyInput,
  type ReservationDecision,
} from './shared-reservation';

const SENDER = 'whatsapp:+5215500000009';
const LEGACY = 'f1e2d3c4b5a6';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
type Rec = Record<string, unknown>;

const expIntake = (o: Rec = {}): Rec => ({
  sourceRequestId: A,
  type: 'EXPIRATION',
  productId: B,
  variantId: null,
  ...o,
});
const restockIntake = (o: Rec = {}): Rec => ({
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

const proposal = (
  route: string,
  requestKey: string,
  intake: unknown,
  o: Rec = {},
): Rec => ({ senderId: SENDER, route, requestKey, intake, ...o });
const expiration = (o: Rec = {}): Rec =>
  proposal('EXPIRATION', A, expIntake(), o);
const restock = (o: Rec = {}): Rec =>
  proposal('RESTOCK', A, restockIntake(), o);
const legacy = (o: Rec = {}): Rec => proposal('LEGACY_OPS', LEGACY, null, o);
const active = (route: string, requestKey: string, intake: unknown): Rec => ({
  status: 'ACTIVE',
  route,
  senderId: SENDER,
  requestKey,
  intake,
});

const ROUTES = ['LEGACY_OPS', 'RESTOCK', 'EXPIRATION'] as const;
const routeProposal = (route: string): Rec =>
  route === 'LEGACY_OPS'
    ? legacy()
    : route === 'RESTOCK'
      ? restock()
      : expiration({
          requestKey: B,
          intake: expIntake({ sourceRequestId: B }),
        });
const routeActive = (route: string): Rec => ({
  ...routeProposal(route),
  status: 'ACTIVE',
});

/** Cast the whole input so hostile / runtime values inject without weakening the
 * production contract. */
const classify = (
  proposal: unknown,
  existing: unknown,
  marker: unknown = false,
): ReservationDecision => {
  const input = { proposal, existing, legacyMarkerPresent: marker };
  return classifyReservation(input as unknown as ReservationClassifyInput);
};

const dec = (action: string, reason: string): ReservationDecision =>
  ({ action, reason }) as ReservationDecision;
const CLAIM = dec('claim', 'single_sender_vacant');
const REPLAY = dec('replay', 'exact_active_replay');
const SAME_PAYLOAD = dec('conflict', 'same_key_different_payload');
const ROUTE_CLASH = dec('conflict', 'same_key_different_route');
const LEGACY_HELD = dec('occupied_legacy', 'legacy_marker_present');
const MALFORMED = dec('blocked', 'malformed_proposal');
const AMBIGUOUS = dec('blocked', 'ambiguous_active_hold');
const SENDER_MISMATCH = dec('blocked', 'sender_mismatch');
const UNKNOWN = dec('blocked', 'unknown_existing');
const MALFORMED_EXISTING = dec('blocked', 'malformed_existing');
const INDETERMINATE = dec('blocked', 'indeterminate_legacy_marker');
const occupied = (activeRoute: string): ReservationDecision =>
  ({
    action: 'occupied',
    reason: 'different_active_key',
    activeRoute,
  }) as ReservationDecision;

const simpleHeld = (): Rec => active('EXPIRATION', A, expIntake());
const variantHeld = (): Rec =>
  active('EXPIRATION', A, expIntake({ variantId: C }));

describe('classifyReservation — EXPIRATION', () => {
  it('claims a vacant simple/variant EXPIRATION and honors a marker', () => {
    expect(classify(expiration(), 'absent')).toEqual(CLAIM);
    expect(
      classify(expiration({ intake: expIntake({ variantId: C }) }), 'absent'),
    ).toEqual(CLAIM);
    expect(classify(expiration(), 'absent', true)).toEqual(LEGACY_HELD);
  });

  it('replays exactly and conflicts on changed product/variant transitions', () => {
    expect(classify(expiration(), simpleHeld())).toEqual(REPLAY);
    expect(
      classify(
        expiration({ intake: expIntake({ variantId: C }) }),
        variantHeld(),
      ),
    ).toEqual(REPLAY);
    expect(
      classify(
        expiration({ intake: expIntake({ productId: C }) }),
        simpleHeld(),
      ),
    ).toEqual(SAME_PAYLOAD);
    expect(
      classify(
        expiration({ intake: expIntake({ variantId: C }) }),
        simpleHeld(),
      ),
    ).toEqual(SAME_PAYLOAD);
    expect(classify(expiration(), variantHeld())).toEqual(SAME_PAYLOAD);
  });

  it('conflicts on one key across RESTOCK/EXPIRATION both ways', () => {
    expect(
      classify(expiration(), active('RESTOCK', A, restockIntake())),
    ).toEqual(ROUTE_CLASH);
    expect(classify(restock(), active('EXPIRATION', A, expIntake()))).toEqual(
      ROUTE_CLASH,
    );
    expect(classify(legacy(), active('EXPIRATION', A, expIntake()))).toEqual(
      occupied('EXPIRATION'),
    );
  });

  const PAIRS = ROUTES.flatMap((p) =>
    ROUTES.filter((a) => a !== p).map((a) => [p, a] as const),
  );
  it.each(PAIRS)(
    'occupies a %s proposal under a different-key ACTIVE %s',
    (p, a) => {
      expect(classify(routeProposal(p), routeActive(a))).toEqual(occupied(a));
    },
  );

  it('holds a nonlegacy replay while a legacy marker may be pending', () => {
    expect(classify(expiration(), simpleHeld(), true)).toEqual(AMBIGUOUS);
    expect(
      classify(restock(), active('RESTOCK', A, restockIntake()), true),
    ).toEqual(AMBIGUOUS);
    expect(
      classify(legacy(), active('LEGACY_OPS', LEGACY, null), true),
    ).toEqual(REPLAY);
  });

  it('fails closed on sender, unknown, malformed existing and bad markers', () => {
    expect(classify(expiration({ senderId: 'x' }), simpleHeld())).toEqual(
      SENDER_MISMATCH,
    );
    expect(classify(expiration(), 'unknown')).toEqual(UNKNOWN);
    expect(
      classify(expiration(), { ...simpleHeld(), status: 'CLOSED' }),
    ).toEqual(MALFORMED_EXISTING);
    expect(classify(expiration(), { ...simpleHeld(), requestKey: '' })).toEqual(
      MALFORMED_EXISTING,
    );
    for (const marker of [undefined, null, '', 'true', 0, {}, [], NaN]) {
      expect(
        classifyReservation({
          proposal: expiration(),
          existing: 'absent',
          legacyMarkerPresent: marker,
        } as unknown as ReservationClassifyInput),
      ).toEqual(INDETERMINATE);
    }
  });

  const MALFORMED_CASES: ReadonlyArray<[string, Rec]> = [
    [
      'RESTOCK intake under EXPIRATION',
      expiration({ intake: restockIntake() }),
    ],
    ['EXPIRATION intake under RESTOCK', restock({ intake: expIntake() })],
    ['legacy null payload under EXPIRATION', expiration({ intake: null })],
    [
      'unbound source id',
      expiration({ intake: expIntake({ sourceRequestId: C }) }),
    ],
    [
      'missing variantId',
      expiration({
        intake: { sourceRequestId: A, type: 'EXPIRATION', productId: B },
      }),
    ],
    ['extra key', expiration({ intake: { ...expIntake(), extra: 1 } })],
    [
      'undefined variantId',
      expiration({ intake: { ...expIntake(), variantId: undefined } }),
    ],
    [
      'invalid product UUID',
      expiration({ intake: expIntake({ productId: 'nope' }) }),
    ],
    ['invalid request key', expiration({ requestKey: 'nope' })],
    [
      'wrong type literal',
      expiration({ intake: expIntake({ type: 'RESTOCK' }) }),
    ],
    ['blank sender', expiration({ senderId: ' ' })],
  ];
  it.each(MALFORMED_CASES)('%s blocks as malformed', (_name, proposal) => {
    expect(classify(proposal, 'absent')).toEqual(MALFORMED);
  });

  it('fails closed on hostile getters and is deterministic/immutable', () => {
    for (const key of ['senderId', 'requestKey', 'intake', 'route']) {
      const hostile = Object.defineProperty({ ...expiration() }, key, {
        get(): never {
          throw new Error('hostile');
        },
      });
      expect(classify(hostile, 'absent')).toEqual(MALFORMED);
    }
    expect(classifyReservation(null as never).action).toBe('blocked');
    const proposal = expiration();
    const existing = simpleHeld();
    const snapshot = structuredClone({ proposal, existing });
    expect(classify(proposal, existing)).toEqual(classify(proposal, existing));
    expect({ proposal, existing }).toEqual(snapshot);
  });
});
