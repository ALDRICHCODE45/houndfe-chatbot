/**
 * HD-R3a — pure, default-off out-of-stock route policy.
 *
 * NOT A RESERVATION — READ BEFORE WIRING:
 * `selectOutOfStockRoute` is a decision function, not a compare-and-set (CAS)
 * reservation. It reads and writes no durable state and makes no atomicity or
 * exactly-once claim; two concurrent callers can both receive `legacy_ops` or
 * `restock` and each create an independent actionable request. Do NOT wire it
 * to any tool, dispatcher or sender until a durable, CAS-capable reservation
 * exists (tracked as HD-R3b) that atomically claims the chosen route for the
 * exact conversation/request. Until then it proves only the default-off routing
 * table, never exactly-once behavior.
 *
 * Default-off: RESTOCK needs the literal boolean `true`; any other value
 * (absent, `false`, `'true'`, `1`, `null`, `{}`) is disabled and falls back to
 * `legacy_ops`. Fail-closed markers: an existing actionable marker always
 * suppresses a new request, conflicting markers block both routes, and an
 * indeterminate reading (explicit `'unknown'` or any invalid value) is never
 * inferred as absence and blocks instead.
 */

/** Tri-state actionable-marker reading: present, absent, or cannot tell.
 *  `'unknown'` is explicit non-absence; it and any invalid runtime value are
 *  never coerced to `false` and fail closed. */
export type ActionableMarkerState = boolean | 'unknown';

export interface OutOfStockRouteInput {
  /** Literal boolean `true` enables RESTOCK; any other value, including an
   *  absent/`undefined` flag, leaves it disabled. */
  readonly restockFeatureEnabled?: unknown;
  /** Existing actionable legacy ops handoff, or `'unknown'` if indeterminate. */
  readonly legacyRequestPending: ActionableMarkerState;
  /** Existing durable RESTOCK intent, or `'unknown'` if indeterminate. */
  readonly restockIntentPresent: ActionableMarkerState;
}

/** One route locked to its exact reason: keeps the union discriminated. */
type RouteOutcome<Route extends string, Reason extends string> = {
  readonly route: Route;
  readonly reason: Reason;
};

/**
 * Deterministic routing outcome, discriminated on `route`, each variant
 * carrying its exact `reason`. A routing decision only; never a claim that any
 * route was reserved, claimed or created.
 */
export type OutOfStockRouteDecision =
  | RouteOutcome<'legacy_ops', 'feature_disabled'>
  | RouteOutcome<'restock', 'feature_enabled'>
  | RouteOutcome<'existing_legacy', 'legacy_request_pending'>
  | RouteOutcome<'existing_restock', 'restock_intent_present'>
  | RouteOutcome<'blocked_conflict', 'conflicting_markers'>
  | RouteOutcome<'blocked_indeterminate', 'indeterminate_marker_state'>;

/** Only a literal boolean survives; `'unknown'` and invalid values fail closed
 *  to the single non-absence sentinel. */
type NormalizedMarker = boolean | 'indeterminate';

function normalizeMarker(value: unknown): NormalizedMarker {
  if (value === true) return true;
  if (value === false) return false;
  return 'indeterminate';
}

/**
 * Selects the out-of-stock route for one new request. Pure and deterministic:
 * equal input yields equal output and the input is never mutated.
 *
 * Fixed fail-closed order: (1) any indeterminate marker blocks; (2) both
 * actionable markers block as a conflict; (3) a single actionable marker
 * suppresses; (4) with no marker, literal `true` enables RESTOCK, else the
 * default-off `legacy_ops` route. See the module note before wiring this to any
 * side effect: the result is a recommendation, not a reservation.
 */
export function selectOutOfStockRoute(
  input: OutOfStockRouteInput,
): OutOfStockRouteDecision {
  const legacy = normalizeMarker(input.legacyRequestPending);
  const restock = normalizeMarker(input.restockIntentPresent);

  if (legacy === 'indeterminate' || restock === 'indeterminate') {
    return {
      route: 'blocked_indeterminate',
      reason: 'indeterminate_marker_state',
    };
  }
  if (legacy && restock) {
    return { route: 'blocked_conflict', reason: 'conflicting_markers' };
  }
  if (legacy) {
    return { route: 'existing_legacy', reason: 'legacy_request_pending' };
  }
  if (restock) {
    return { route: 'existing_restock', reason: 'restock_intent_present' };
  }
  if (input.restockFeatureEnabled === true) {
    return { route: 'restock', reason: 'feature_enabled' };
  }
  return { route: 'legacy_ops', reason: 'feature_disabled' };
}
