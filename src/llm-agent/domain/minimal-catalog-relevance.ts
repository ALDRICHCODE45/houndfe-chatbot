/**
 * S10b/S10d: deterministic bound on the product options one catalog read can
 * put in front of the customer. Pure; the backend order is the relevance
 * order (the backend is asked to rank all-term matches first), and the
 * optional per-item `match` flag only refines it.
 */

/** At most this many product options reach the model (and the customer). */
export const MAX_CATALOG_OPTIONS = 3;

/** At most this many `partial` alternatives next to full matches. */
export const MAX_PARTIAL_ALTERNATIVES = 1;

export interface LimitedCatalogOptions<T> {
  /** Items to present and register, in order (≤ 3 matches [+ ≤ 1 partial]). */
  offered: T[];
  /** Matches beyond the cap that are NOT shown; the model asks to narrow. */
  moreResults: number;
  /** At least one item carried a recognized `match` flag. */
  flagged: boolean;
  /** Flags exist and no item is a full match: everything is an alternative. */
  noFullMatch: boolean;
}

/**
 * Orders partial matches after the rest (stable) and applies the cap:
 * - no flags: the first 3 in backend order;
 * - flags with full/unknown matches: the first 3 of those plus at most one
 *   `partial` shown as the labelled alternative (never counted as a match);
 * - flags with only partial items: the closest 3, all alternatives.
 */
export function limitCatalogOptions<T extends { match?: 'all' | 'partial' }>(
  items: readonly T[],
): LimitedCatalogOptions<T> {
  const partial = items.filter((item) => item.match === 'partial');
  const flagged = items.some((item) => item.match !== undefined);
  if (partial.length === 0) {
    return {
      offered: items.slice(0, MAX_CATALOG_OPTIONS),
      moreResults: Math.max(0, items.length - MAX_CATALOG_OPTIONS),
      flagged,
      noFullMatch: false,
    };
  }
  const matches = items.filter((item) => item.match !== 'partial');
  if (matches.length === 0) {
    return {
      offered: partial.slice(0, MAX_CATALOG_OPTIONS),
      moreResults: Math.max(0, partial.length - MAX_CATALOG_OPTIONS),
      flagged: true,
      noFullMatch: true,
    };
  }
  return {
    offered: [
      ...matches.slice(0, MAX_CATALOG_OPTIONS),
      ...partial.slice(0, MAX_PARTIAL_ALTERNATIVES),
    ],
    moreResults: Math.max(0, matches.length - MAX_CATALOG_OPTIONS),
    flagged: true,
    noFullMatch: false,
  };
}
