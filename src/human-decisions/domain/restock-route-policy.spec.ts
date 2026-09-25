/**
 * HD-R3a spec: deterministic, default-off out-of-stock route policy. Proves the
 * routing table only — no reservation, CAS, store write, HTTP call or send.
 */
import {
  selectOutOfStockRoute,
  type ActionableMarkerState,
  type OutOfStockRouteDecision,
  type OutOfStockRouteInput,
} from './restock-route-policy';

type Expected = Pick<OutOfStockRouteDecision, 'route' | 'reason'>;

const decide = (
  restockFeatureEnabled: unknown,
  legacyRequestPending: ActionableMarkerState,
  restockIntentPresent: ActionableMarkerState,
): OutOfStockRouteDecision =>
  selectOutOfStockRoute({
    restockFeatureEnabled,
    legacyRequestPending,
    restockIntentPresent,
  });

const expected = (
  route: OutOfStockRouteDecision['route'],
  reason: OutOfStockRouteDecision['reason'],
): Expected => ({ route, reason });

const LEGACY_OPS = expected('legacy_ops', 'feature_disabled');
const RESTOCK = expected('restock', 'feature_enabled');
const EXISTING_LEGACY = expected('existing_legacy', 'legacy_request_pending');
const EXISTING_RESTOCK = expected('existing_restock', 'restock_intent_present');
const CONFLICT = expected('blocked_conflict', 'conflicting_markers');
const INDETERMINATE = expected(
  'blocked_indeterminate',
  'indeterminate_marker_state',
);

// Eight boolean combinations. This matrix alone proves marker suppression on
// both flag states (marker suppresses on flag flips), conflict precedence
// (conflicts block both routes) and the literal-true gate opening RESTOCK; the
// former standalone suppression/conflict cases were redundant with it.
const BOOLEAN_MATRIX: ReadonlyArray<{
  flag: unknown;
  legacy: boolean;
  restock: boolean;
  expected: Expected;
}> = [
  { flag: false, legacy: false, restock: false, expected: LEGACY_OPS },
  { flag: false, legacy: false, restock: true, expected: EXISTING_RESTOCK },
  { flag: false, legacy: true, restock: false, expected: EXISTING_LEGACY },
  { flag: false, legacy: true, restock: true, expected: CONFLICT },
  { flag: true, legacy: false, restock: false, expected: RESTOCK },
  { flag: true, legacy: false, restock: true, expected: EXISTING_RESTOCK },
  { flag: true, legacy: true, restock: false, expected: EXISTING_LEGACY },
  { flag: true, legacy: true, restock: true, expected: CONFLICT },
];

const INVALID_MARKERS: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  '',
  'yes',
  'true',
  'TRUE',
  {},
  [],
  NaN,
];

// Non-literal-true feature flags: the invalid markers plus boolean `false`.
const NON_TRUE_FLAGS: readonly unknown[] = [...INVALID_MARKERS, false];

const INDETERMINATE_MATRIX: ReadonlyArray<
  [string, boolean, ActionableMarkerState, ActionableMarkerState]
> = [
  ['unknown legacy', false, 'unknown', false],
  ['unknown legacy, flag on', true, 'unknown', false],
  ['unknown restock', false, false, 'unknown'],
  ['unknown restock, flag on', true, false, 'unknown'],
  ['both unknown', true, 'unknown', 'unknown'],
  ['unknown legacy vs present restock', true, 'unknown', true],
  ['present legacy vs unknown restock', true, true, 'unknown'],
];

describe('selectOutOfStockRoute', () => {
  it.each(BOOLEAN_MATRIX)(
    'boolean matrix flag=$flag legacy=$legacy restock=$restock',
    ({ flag, legacy, restock, expected: want }) => {
      expect(decide(flag, legacy, restock)).toEqual(want);
    },
  );

  describe('default-off feature gate', () => {
    it.each(NON_TRUE_FLAGS)('does not activate RESTOCK for flag %p', (flag) => {
      expect(decide(flag, false, false)).toEqual(LEGACY_OPS);
    });

    it('stays default-off when the flag is omitted from the input', () => {
      expect(
        selectOutOfStockRoute({
          legacyRequestPending: false,
          restockIntentPresent: false,
        }),
      ).toEqual(LEGACY_OPS);
    });
  });

  describe('indeterminate marker state fails closed', () => {
    it.each(INDETERMINATE_MATRIX)(
      'blocks %s',
      (_name, flag, legacy, restock) => {
        expect(decide(flag, legacy, restock)).toEqual(INDETERMINATE);
      },
    );

    it.each(INVALID_MARKERS)(
      'blocks invalid marker %p in either slot',
      (marker) => {
        expect(decide(false, marker as ActionableMarkerState, false)).toEqual(
          INDETERMINATE,
        );
        expect(decide(false, false, marker as ActionableMarkerState)).toEqual(
          INDETERMINATE,
        );
      },
    );
  });

  describe('determinism and purity', () => {
    it('returns equal results for repeated identical input', () => {
      expect(decide(true, false, false)).toEqual(decide(true, false, false));
    });

    it('does not mutate the input object', () => {
      const source: OutOfStockRouteInput = {
        restockFeatureEnabled: true,
        legacyRequestPending: false,
        restockIntentPresent: false,
      };
      const snapshot = { ...source };
      selectOutOfStockRoute(source);
      expect(source).toEqual(snapshot);
    });
  });
});
