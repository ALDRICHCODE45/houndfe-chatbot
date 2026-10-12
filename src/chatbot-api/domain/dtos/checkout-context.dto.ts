/**
 * Minimal checkout customer/address read projection (S6 frozen contract,
 * docs/checkout-customer-context.md).
 *
 * Pure, fail-closed helpers for `GET /chatbot-api/customers/checkout-context`:
 * the query validator rejects digit-identity/limit/cursor violations instead of
 * clamping them, and the response normalizer accepts only the exact
 * `{status, customer, addresses, nextAfterAddressId}` envelope. Malformed
 * upstream data returns `null`, so the caller can keep the lookup *unavailable*
 * rather than treating it as customer absence. This module performs no HTTP,
 * store, model or write side effect; `not_found`/`ambiguous` are results, not
 * errors.
 */

export const CHECKOUT_CONTEXT_DEFAULT_LIMIT = 10;
export const CHECKOUT_CONTEXT_MAX_LIMIT = 20;

const DIGIT_COUNTRY_CODE = /^[0-9]{1,10}$/;
const DIGIT_PHONE = /^[0-9]{1,20}$/;
/**
 * Exact backend `class-validator@0.15.1` / `validator@13.15.26`
 * `@IsUUID('all')` profile: canonical v1–v8 with any standard variant and any
 * case, plus the nil and max sentinels. Non-nil v0, v9/v10+ and invalid
 * variants are rejected by the specific alternatives above. Case is
 * significant only for the returned value: projected IDs and cursors are
 * never lowercased, trimmed or coerced.
 */
const CHECKOUT_UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

const ENVELOPE_KEYS = [
  'status',
  'customer',
  'addresses',
  'nextAfterAddressId',
] as const;
const CUSTOMER_KEYS = ['customerId', 'firstName', 'lastName'] as const;
const ADDRESS_KEYS = [
  'id',
  'version',
  'label',
  'street',
  'exteriorNumber',
  'interiorNumber',
  'zipCode',
  'neighborhood',
  'municipality',
  'city',
  'state',
  'visualReferences',
  'carrierPhone',
] as const;
const NULLABLE_ADDRESS_TEXT_KEYS = [
  'label',
  'exteriorNumber',
  'interiorNumber',
  'zipCode',
  'neighborhood',
  'municipality',
  'city',
  'state',
  'visualReferences',
  'carrierPhone',
] as const;
const QUERY_KEYS = ['limit', 'afterAddressId'] as const;

/** Caller-supplied lookup page options. */
export interface CheckoutContextQuery {
  limit?: number;
  afterAddressId?: string | null;
}

/** Validated lookup query with the resolved default limit. */
export interface NormalizedCheckoutContextQuery {
  limit: number;
  afterAddressId: string | null;
}

export interface CheckoutContextCustomer {
  customerId: string;
  firstName: string;
  lastName: string | null;
}

export interface CheckoutContextAddress {
  id: string;
  /** Backend `updatedAt` freshness marker, not a compare-and-set guarantee. */
  version: string;
  label: string | null;
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  visualReferences: string | null;
  carrierPhone: string | null;
}

export interface CheckoutContextNotFound {
  status: 'not_found';
  customer: null;
  addresses: [];
  nextAfterAddressId: null;
}

export interface CheckoutContextAmbiguous {
  status: 'ambiguous';
  customer: null;
  addresses: [];
  nextAfterAddressId: null;
}

export interface CheckoutContextUnique {
  status: 'unique';
  customer: CheckoutContextCustomer;
  addresses: CheckoutContextAddress[];
  nextAfterAddressId: string | null;
}

export type CustomerCheckoutContext =
  | CheckoutContextNotFound
  | CheckoutContextAmbiguous
  | CheckoutContextUnique;

/** Digit `phoneCountryCode`, 1–10 ASCII digits. */
export function isDigitCheckoutCountryCode(value: unknown): boolean {
  return typeof value === 'string' && DIGIT_COUNTRY_CODE.test(value);
}

/** Digit `phone`, 1–20 ASCII digits. */
export function isDigitCheckoutPhone(value: unknown): boolean {
  return typeof value === 'string' && DIGIT_PHONE.test(value);
}

/** Backend `@IsUUID('all')` profile accepted for an opaque checkout reference. */
export function isCheckoutUuid(value: unknown): boolean {
  return typeof value === 'string' && CHECKOUT_UUID.test(value);
}

/** Canonical backend instant: `Date.toISOString()` round-trips verbatim. */
function isCanonicalInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Exact own keys (symbols included), rejecting extras and explicit undefined. */
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const own = Reflect.ownKeys(value);
  const record = value as Record<string, unknown>;
  return (
    own.length === keys.length &&
    own.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        record[key] !== undefined,
    )
  );
}

/**
 * Resolve the lookup query, defaulting `limit` to 10 when omitted. Returns
 * `null` for any invalid limit (never clamped) or malformed cursor, so the
 * caller rejects the request before it reaches the network.
 */
export function normalizeCheckoutContextQuery(
  options: unknown,
): NormalizedCheckoutContextQuery | null {
  if (options === undefined) {
    return { limit: CHECKOUT_CONTEXT_DEFAULT_LIMIT, afterAddressId: null };
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    return null;
  }
  try {
    const own = Reflect.ownKeys(options);
    if (
      !own.every(
        (key) =>
          typeof key === 'string' &&
          (QUERY_KEYS as readonly string[]).includes(key),
      )
    ) {
      return null;
    }
    const record = options as Record<string, unknown>;

    let limit = CHECKOUT_CONTEXT_DEFAULT_LIMIT;
    if (record.limit !== undefined) {
      if (
        typeof record.limit !== 'number' ||
        !Number.isInteger(record.limit) ||
        record.limit < 1 ||
        record.limit > CHECKOUT_CONTEXT_MAX_LIMIT
      ) {
        return null;
      }
      limit = record.limit;
    }

    let afterAddressId: string | null = null;
    if (record.afterAddressId !== undefined && record.afterAddressId !== null) {
      if (!isCheckoutUuid(record.afterAddressId)) return null;
      afterAddressId = record.afterAddressId as string;
    }

    return { limit, afterAddressId };
  } catch {
    return null;
  }
}

function normalizeCustomer(value: unknown): CheckoutContextCustomer | null {
  if (!exactKeys(value, CUSTOMER_KEYS)) return null;
  const record = value as Record<string, unknown>;
  if (!isCheckoutUuid(record.customerId)) return null;
  if (typeof record.firstName !== 'string') return null;
  if (!isNullableString(record.lastName)) return null;
  return {
    customerId: record.customerId as string,
    firstName: record.firstName,
    lastName: record.lastName,
  };
}

function normalizeAddress(value: unknown): CheckoutContextAddress | null {
  if (!exactKeys(value, ADDRESS_KEYS)) return null;
  const record = value as Record<string, unknown>;
  if (!isCheckoutUuid(record.id)) return null;
  if (!isCanonicalInstant(record.version)) return null;
  if (typeof record.street !== 'string') return null;
  for (const key of NULLABLE_ADDRESS_TEXT_KEYS) {
    if (!isNullableString(record[key])) return null;
  }
  return {
    id: record.id as string,
    version: record.version as string,
    label: record.label as string | null,
    street: record.street,
    exteriorNumber: record.exteriorNumber as string | null,
    interiorNumber: record.interiorNumber as string | null,
    zipCode: record.zipCode as string | null,
    neighborhood: record.neighborhood as string | null,
    municipality: record.municipality as string | null,
    city: record.city as string | null,
    state: record.state as string | null,
    visualReferences: record.visualReferences as string | null,
    carrierPhone: record.carrierPhone as string | null,
  };
}

/**
 * Normalize the untrusted checkout-context envelope; fail-closed. Returns
 * `null` for any malformed/mismatched status, envelope, UUID, freshness
 * version, cursor, duplicate address or projection. A valid `unique` page
 * never exceeds 20 addresses and its `nextAfterAddressId`, when present, is
 * the exact last address id.
 */
export function normalizeCustomerCheckoutContext(
  value: unknown,
): CustomerCheckoutContext | null {
  try {
    if (!exactKeys(value, ENVELOPE_KEYS)) return null;
    const record = value as Record<string, unknown>;
    const status = record.status;

    if (status === 'not_found' || status === 'ambiguous') {
      if (record.customer !== null) return null;
      if (!Array.isArray(record.addresses) || record.addresses.length !== 0) {
        return null;
      }
      if (record.nextAfterAddressId !== null) return null;
      return status === 'not_found'
        ? {
            status: 'not_found',
            customer: null,
            addresses: [],
            nextAfterAddressId: null,
          }
        : {
            status: 'ambiguous',
            customer: null,
            addresses: [],
            nextAfterAddressId: null,
          };
    }

    if (status !== 'unique') return null;

    const customer = normalizeCustomer(record.customer);
    if (customer === null) return null;

    const rawAddresses = record.addresses;
    if (
      !Array.isArray(rawAddresses) ||
      rawAddresses.length > CHECKOUT_CONTEXT_MAX_LIMIT
    ) {
      return null;
    }

    const addresses: CheckoutContextAddress[] = [];
    const seenIds = new Set<string>();
    for (const raw of rawAddresses) {
      const address = normalizeAddress(raw);
      if (address === null) return null;
      if (seenIds.has(address.id)) return null;
      seenIds.add(address.id);
      addresses.push(address);
    }

    let nextAfterAddressId: string | null = null;
    if (record.nextAfterAddressId !== null) {
      if (!isCheckoutUuid(record.nextAfterAddressId)) return null;
      const cursor = record.nextAfterAddressId as string;
      const last = addresses[addresses.length - 1];
      if (last === undefined || last.id !== cursor) {
        return null;
      }
      nextAfterAddressId = cursor;
    }

    return {
      status: 'unique',
      customer,
      addresses,
      nextAfterAddressId,
    };
  } catch {
    return null;
  }
}
