/**
 * HD-R3b3-c4c2a — INERT, read-only trusted route-marker port.
 *
 * READ BEFORE WIRING: this port only READS two durable markers for one sender
 * so a caller can feed the pure `selectOutOfStockRoute` policy BEFORE any
 * effect. It writes nothing, releases nothing, and claims no exclusivity: the
 * final reserve CAS is still required. Absence of a pending legacy row here is
 * NOT a CAS against a pre-R3b3 legacy writer, and the conversation `pending`
 * marker (W2) is a separate later concern.
 *
 * Fail-closed: an inconsistent or indeterminate read is the explicit
 * `'unknown'`, never `false`, so the policy blocks instead of inferring
 * absence. Callers must treat `'unknown'` as "cannot tell", not as "absent".
 */

/** Tri-state marker reading: present, absent, or explicit non-absence. */
export type SharedRouteMarkerState = boolean | 'unknown';

/** Trusted route markers for one sender, as read (never inferred) from one
 *  durable snapshot. */
export interface SharedRouteMarkers {
  /** An actionable legacy ops handoff, or `'unknown'` when indeterminate. */
  readonly legacyRequestPending: SharedRouteMarkerState;
  /** A durable RESTOCK intent, or `'unknown'` when indeterminate. */
  readonly restockIntentPresent: SharedRouteMarkerState;
}

/** DI token for the read-only, trusted route-marker reader. */
export const SHARED_ROUTE_MARKERS = Symbol('SHARED_ROUTE_MARKERS');

export interface SharedRouteMarkersPort {
  /**
   * Snapshot the trusted route markers for one sender. Never throws: an
   * invalid sender id, a driver anomaly, an inconsistent snapshot, or a query
   * error all yield the explicit blocked reading
   * `{ legacyRequestPending: 'unknown', restockIntentPresent: 'unknown' }`.
   */
  readForSender(senderId: string): Promise<SharedRouteMarkers>;
}
