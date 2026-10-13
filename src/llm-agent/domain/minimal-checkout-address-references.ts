/**
 * Sender-bound saved-address and next-page reference registry (T3, Unit B) —
 * pure and SDK/HTTP/store-agnostic.
 *
 * The model may describe a saved address, but only a trusted, normalized T1
 * `unique` checkout-context read may bind a real identity. The caller registers
 * that verified page once; the registry returns opaque, stable references for
 * each exact saved address and for the next page, and later resolves them back
 * to retained snapshots.
 *
 * Safety properties:
 *   - A reference is a truncated SHA-256 digest, not a concatenated UUID or a
 *     raw backend id. The digest is unkeyed and publicly computable, so it
 *     provides correlation and opacity, NOT authentication: it must never be
 *     treated as a secret or as proof of address ownership. Ownership comes
 *     only from the trusted sender-derived GET.
 *   - A reference binds the trusted sender, the exact normalized lookup scope
 *     (limit and after-cursor), the customer id and the raw address id plus the
 *     exact freshness version. It is never decoded from a model-supplied id:
 *     `resolveAddress` accepts a reference string only.
 *   - Only `status: 'unique'` pages register. `not_found`, `ambiguous`, a
 *     malformed envelope and a malformed query are not authorizers, and no
 *     binding changes when any of them is rejected.
 *   - Retention is volatile, bounded and expiring. Restarting the process (or a
 *     new instance) forgets every reference; there is no snapshot/restore API
 *     and a model-supplied snapshot is never trusted. When the bounded capacity
 *     needs room for forward paging, the oldest page is retired and its
 *     references become stale (they resolve to `null`), so later pages stay
 *     reachable one bounded page at a time.
 *   - Resolution never drains: one explicit caller request resolves to one
 *     exact bounded page query; the registry performs no client call, mutates no
 *     draft and writes no persistent context.
 *   - Every returned snapshot, query, offer and resolution is a defensive copy;
 *     a caller cannot mutate an internal binding.
 *
 * Page-query provenance is as volatile as the bindings themselves. After a
 * restart, a durable draft that only holds an address id plus a cached version
 * cannot be freshness-revalidated in place: the coordinator must run a fresh,
 * explicit, sender-bound lookup page and re-select, then `revalidateAddress`
 * against that live page. There is no by-id endpoint, no unlimited scan and no
 * cached-version trust.
 */
import { createHash } from 'node:crypto';
import {
  normalizeCheckoutContextQuery,
  normalizeCustomerCheckoutContext,
  type CheckoutContextAddress,
  type NormalizedCheckoutContextQuery,
} from '../../chatbot-api/domain/dtos/checkout-context.dto';

/** Volatile lifetime of one registered page, its addresses and its cursor. */
export const MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS = 5 * 60 * 1000;
/** Maximum retained address bindings before the oldest page is retired. */
export const MINIMAL_CHECKOUT_ADDRESS_REFERENCE_MAX = 50;

const ADDRESS_TAG = 'CHECKOUT_ADDRESS/v1';
const PAGE_TAG = 'CHECKOUT_ADDRESS_PAGE/v1';
const NEXT_PAGE_TAG = 'CHECKOUT_ADDRESS_NEXT_PAGE/v1';
const REFERENCE_HEX_LENGTH = 16;

/** One selectable saved address: an opaque reference plus grounding evidence. */
export interface MinimalCheckoutAddressOffer {
  /** Opaque sender-bound address reference; never a raw backend id. */
  readonly reference: string;
  /** 1-based server order within the offered page. Deterministic for a page. */
  readonly ordinal: number;
  /** Verified backend display label, or `null` when the backend exposed none. */
  readonly label: string | null;
  /** The label only when it is unique within the page; otherwise `null`. */
  readonly uniqueLabel: string | null;
}

/** One registered bounded page and its remaining pagination handle. */
export interface MinimalCheckoutAddressPage {
  readonly pageReference: string;
  readonly customerId: string;
  /** Exact bounded query that produced this page. */
  readonly query: NormalizedCheckoutContextQuery;
  readonly addresses: readonly MinimalCheckoutAddressOffer[];
  /** Present only when the backend offered a further page. */
  readonly nextPageReference: string | null;
}

/** Caller input for registering one trusted lookup page. */
export interface MinimalCheckoutAddressLookupInput {
  /** Trusted normalized T1 checkout-context envelope; re-validated here. */
  readonly context: unknown;
  /** Raw lookup options, validated by the frozen T1 query normalizer. */
  readonly query?: unknown;
  /** Opaque cursor from a previous page to continue the same lookup. */
  readonly cursorReference?: string | null;
}

/** A detached saved-address resolution with its exact original page query. */
export interface ResolvedMinimalCheckoutAddress {
  readonly reference: string;
  readonly customerId: string;
  readonly address: CheckoutContextAddress;
  readonly query: NormalizedCheckoutContextQuery;
}

/** A detached next-page handle: one bounded query for one explicit request. */
export interface MinimalCheckoutNextPage {
  readonly reference: string;
  readonly customerId: string;
  readonly query: NormalizedCheckoutContextQuery;
}

interface AddressBinding {
  reference: string;
  customerId: string;
  address: CheckoutContextAddress;
  query: NormalizedCheckoutContextQuery;
  ordinal: number;
  expiresAt: number;
}

interface PageBinding {
  reference: string;
  customerId: string;
  query: NormalizedCheckoutContextQuery;
  addressReferences: string[];
  nextPageReference: string | null;
  expiresAt: number;
}

interface NextPageBinding {
  reference: string;
  customerId: string;
  query: NormalizedCheckoutContextQuery;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Opaque correlation digest; unkeyed, so never authentication. */
function digest(
  tag: string,
  parts: readonly (string | number | null)[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([tag, ...parts]), 'utf8')
    .digest('hex')
    .slice(0, REFERENCE_HEX_LENGTH);
}

/** Detached copy so callers can never mutate a retained address. */
function copyAddress(address: CheckoutContextAddress): CheckoutContextAddress {
  return {
    id: address.id,
    version: address.version,
    label: address.label,
    street: address.street,
    exteriorNumber: address.exteriorNumber,
    interiorNumber: address.interiorNumber,
    zipCode: address.zipCode,
    neighborhood: address.neighborhood,
    municipality: address.municipality,
    city: address.city,
    state: address.state,
    visualReferences: address.visualReferences,
    carrierPhone: address.carrierPhone,
  };
}

/** Detached copy of a normalized lookup query. */
function copyQuery(
  query: NormalizedCheckoutContextQuery,
): NormalizedCheckoutContextQuery {
  return { limit: query.limit, afterAddressId: query.afterAddressId };
}

function sameQuery(
  left: NormalizedCheckoutContextQuery,
  right: NormalizedCheckoutContextQuery,
): boolean {
  return (
    left.limit === right.limit && left.afterAddressId === right.afterAddressId
  );
}

export class MinimalCheckoutAddressReferences {
  readonly #senderId: string;
  readonly #clock: () => number;
  readonly #addresses = new Map<string, AddressBinding>();
  readonly #pages = new Map<string, PageBinding>();
  readonly #nextPages = new Map<string, NextPageBinding>();

  constructor(senderId: string, clock: () => number = () => Date.now()) {
    this.#senderId = typeof senderId === 'string' ? senderId : '';
    this.#clock = clock;
  }

  /**
   * Register one trusted, unique T1 page. Returns the detached page (offers,
   * exact query and next-page handle) or `null` when the input is missing,
   * ambiguous, malformed, belongs to another sender, uses a wrong/stale/expired
   * cursor, or would not fit a single page. A rejected registration never
   * changes a local binding.
   */
  registerPage(
    input: MinimalCheckoutAddressLookupInput,
  ): MinimalCheckoutAddressPage | null {
    try {
      if (!isRecord(input)) return null;
      if (this.#senderId.length === 0) return null;
      const now = this.#clock();
      this.#purgeExpired(now);

      const cursorRaw = input.cursorReference;
      let cursor: NextPageBinding | null = null;
      if (cursorRaw !== undefined && cursorRaw !== null) {
        if (typeof cursorRaw !== 'string' || cursorRaw.length === 0)
          return null;
        cursor = this.#nextPages.get(cursorRaw) ?? null;
        if (cursor === null) return null;
      }

      const query = normalizeCheckoutContextQuery(input.query);
      if (query === null) return null;
      if (cursor !== null && !sameQuery(query, cursor.query)) return null;

      const context = normalizeCustomerCheckoutContext(input.context);
      if (context === null || context.status !== 'unique') return null;
      const customerId = context.customer.customerId;
      if (cursor !== null && customerId !== cursor.customerId) return null;

      const candidates = context.addresses.map((address, index) => ({
        reference: digest(ADDRESS_TAG, [
          this.#senderId,
          query.limit,
          query.afterAddressId,
          customerId,
          address.id,
          address.version,
        ]),
        address,
        ordinal: index + 1,
      }));

      const added = candidates.filter(
        (candidate) => !this.#addresses.has(candidate.reference),
      ).length;
      this.#retireOldestUntil(added);
      if (
        this.#addresses.size + added >
        MINIMAL_CHECKOUT_ADDRESS_REFERENCE_MAX
      ) {
        return null;
      }

      const expiresAt = now + MINIMAL_CHECKOUT_ADDRESS_REFERENCE_TTL_MS;
      for (const candidate of candidates) {
        this.#addresses.set(candidate.reference, {
          reference: candidate.reference,
          customerId,
          address: copyAddress(candidate.address),
          query: copyQuery(query),
          ordinal: candidate.ordinal,
          expiresAt,
        });
      }

      const pageReference = digest(PAGE_TAG, [
        this.#senderId,
        query.limit,
        query.afterAddressId,
        customerId,
      ]);
      const nextQuery =
        context.nextAfterAddressId === null
          ? null
          : {
              limit: query.limit,
              afterAddressId: context.nextAfterAddressId,
            };
      const nextPageReference =
        nextQuery === null
          ? null
          : digest(NEXT_PAGE_TAG, [
              this.#senderId,
              nextQuery.limit,
              nextQuery.afterAddressId,
              customerId,
            ]);
      if (nextQuery !== null && nextPageReference !== null) {
        this.#nextPages.set(nextPageReference, {
          reference: nextPageReference,
          customerId,
          query: copyQuery(nextQuery),
          expiresAt,
        });
      }
      this.#pages.set(pageReference, {
        reference: pageReference,
        customerId,
        query: copyQuery(query),
        addressReferences: candidates.map((candidate) => candidate.reference),
        nextPageReference,
        expiresAt,
      });

      const page = this.#pages.get(pageReference);
      return page === undefined ? null : this.#toPage(page);
    } catch {
      return null;
    }
  }

  /** Detached view of one registered page's offered choices, or `null`. */
  viewPage(pageReference: unknown): MinimalCheckoutAddressPage | null {
    try {
      if (typeof pageReference !== 'string' || pageReference.length === 0) {
        return null;
      }
      this.#purgeExpired(this.#clock());
      const page = this.#pages.get(pageReference);
      return page === undefined ? null : this.#toPage(page);
    } catch {
      return null;
    }
  }

  /** Detached saved-address resolution, or `null` for unknown/stale/expired. */
  resolveAddress(reference: unknown): ResolvedMinimalCheckoutAddress | null {
    try {
      if (typeof reference !== 'string' || reference.length === 0) return null;
      this.#purgeExpired(this.#clock());
      const binding = this.#addresses.get(reference);
      if (binding === undefined) return null;
      return {
        reference: binding.reference,
        customerId: binding.customerId,
        address: copyAddress(binding.address),
        query: copyQuery(binding.query),
      };
    } catch {
      return null;
    }
  }

  /** Exact bounded next-page query, or `null` for unknown/stale/expired. */
  resolveNextPage(reference: unknown): MinimalCheckoutNextPage | null {
    try {
      if (typeof reference !== 'string' || reference.length === 0) return null;
      this.#purgeExpired(this.#clock());
      const binding = this.#nextPages.get(reference);
      if (binding === undefined) return null;
      return {
        reference: binding.reference,
        customerId: binding.customerId,
        query: copyQuery(binding.query),
      };
    } catch {
      return null;
    }
  }

  /**
   * Revalidate one selected saved address against a freshly read page from the
   * retained original query. Fails closed (and retires the reference) when the
   * unique live page no longer contains the exact id and freshness version.
   * A non-unique or malformed read is a lookup failure, not staleness, so it
   * does not invalidate the binding.
   */
  revalidateAddress(
    reference: unknown,
    freshContext: unknown,
  ): ResolvedMinimalCheckoutAddress | null {
    try {
      if (typeof reference !== 'string' || reference.length === 0) return null;
      this.#purgeExpired(this.#clock());
      const binding = this.#addresses.get(reference);
      if (binding === undefined) return null;

      const context = normalizeCustomerCheckoutContext(freshContext);
      if (context === null || context.status !== 'unique') return null;
      if (context.customer.customerId !== binding.customerId) return null;
      const live = context.addresses.find(
        (address) =>
          address.id === binding.address.id &&
          address.version === binding.address.version,
      );
      if (live === undefined) {
        this.#addresses.delete(reference);
        return null;
      }
      return {
        reference: binding.reference,
        customerId: binding.customerId,
        address: copyAddress(live),
        query: copyQuery(binding.query),
      };
    } catch {
      return null;
    }
  }

  /** Drop every binding whose volatile lifetime has elapsed. */
  #purgeExpired(now: number): void {
    for (const [reference, binding] of this.#addresses) {
      if (binding.expiresAt <= now) this.#addresses.delete(reference);
    }
    for (const [reference, binding] of this.#pages) {
      if (binding.expiresAt <= now) this.#pages.delete(reference);
    }
    for (const [reference, binding] of this.#nextPages) {
      if (binding.expiresAt <= now) this.#nextPages.delete(reference);
    }
  }

  /** Retire oldest pages so `needed` new addresses can still be registered. */
  #retireOldestUntil(needed: number): void {
    while (
      this.#addresses.size + needed >
      MINIMAL_CHECKOUT_ADDRESS_REFERENCE_MAX
    ) {
      const oldest = this.#pages.keys().next();
      if (oldest.done === true) return;
      this.#evictPage(oldest.value);
    }
  }

  /** Remove one page and everything only it retained. */
  #evictPage(pageReference: string): void {
    const page = this.#pages.get(pageReference);
    if (page === undefined) return;
    this.#pages.delete(pageReference);
    for (const reference of page.addressReferences) {
      this.#addresses.delete(reference);
    }
    if (page.nextPageReference !== null) {
      this.#nextPages.delete(page.nextPageReference);
    }
  }

  /** Build a detached page view, or `null` if a retained address is missing. */
  #toPage(page: PageBinding): MinimalCheckoutAddressPage | null {
    const bindings: AddressBinding[] = [];
    for (const reference of page.addressReferences) {
      const binding = this.#addresses.get(reference);
      if (binding === undefined) return null;
      bindings.push(binding);
    }
    const labelCounts = new Map<string, number>();
    for (const binding of bindings) {
      const label = binding.address.label;
      if (label !== null) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }
    const addresses = bindings.map((binding): MinimalCheckoutAddressOffer => {
      const label = binding.address.label;
      return {
        reference: binding.reference,
        ordinal: binding.ordinal,
        label,
        uniqueLabel:
          label !== null && labelCounts.get(label) === 1 ? label : null,
      };
    });
    return {
      pageReference: page.reference,
      customerId: page.customerId,
      query: copyQuery(page.query),
      addresses,
      nextPageReference: page.nextPageReference,
    };
  }
}
