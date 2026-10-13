/**
 * Minimal checkout draft — a pure, local-only record of prospective
 * customer/delivery data for the minimal checkout route (T2A).
 *
 * Data only: no registration, saved-address mutation, order/stock/shipping side
 * effect and no SDK/Nest/HTTP/store dependency. `normalizeMinimalCheckoutDraft`
 * is fail-closed — malformed/missing/extra/symbol/`undefined`/wrongly-typed or
 * hostile fields yield `null` with no coercion, and results are fully detached
 * (returned/input mutation cannot leak either way).
 *
 * Callers must not misread `sourceCustomerId: null` as absence/unregistered
 * proof: the T3 fresh, sender-bound backend `status` is the sole
 * absence/revalidation authority. `saved` snapshots keep the exact T1
 * `CheckoutContextAddress` shape, case and canonical `toISOString` `version`;
 * that backend `version` is freshness only, not a local CAS guarantee (local
 * `revision` is the separate concurrency boundary). The record is unconfirmed —
 * confirmation state, tokens and activation belong to T3, and future
 * confirmation metadata must be an explicit compatible extension (no
 * placeholder flags here).
 */
import {
  isCheckoutUuid,
  type CheckoutContextAddress,
} from '../../chatbot-api/domain/dtos/checkout-context.dto';

/** Current draft schema version. Only `1` is accepted. */
export const MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION = 1 as const;

const DRAFT_KEYS = [
  'schemaVersion',
  'senderId',
  'revision',
  'sourceCustomerId',
  'customer',
  'address',
] as const;
const CUSTOMER_KEYS = ['firstName', 'lastName'] as const;
const NEW_ADDRESS_KEYS = ['kind', 'fields'] as const;
const SAVED_ADDRESS_KEYS = ['kind', 'snapshot'] as const;
/** All T1 delivery fields except `id`/`version`; all nullable for local collection. */
const NEW_FIELD_KEYS = [
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
/** Exact T1 `CheckoutContextAddress` key set, including `id`/`version`. */
const SNAPSHOT_KEYS = ['id', 'version', ...NEW_FIELD_KEYS] as const;

/** Prospective, locally collected customer name data (not saved profile data). */
export interface MinimalCheckoutDraftCustomer {
  firstName: string | null;
  lastName: string | null;
}

/** Locally collected new delivery fields; every field may still be incomplete. */
export interface MinimalCheckoutDraftNewAddressFields {
  label: string | null;
  street: string | null;
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

/** Sender elected a new, local-only address. */
export interface MinimalCheckoutDraftNewAddressChoice {
  kind: 'new';
  fields: MinimalCheckoutDraftNewAddressFields;
}

/** Sender elected a saved address, captured as an exact T1 snapshot. */
export interface MinimalCheckoutDraftSavedAddressChoice {
  kind: 'saved';
  snapshot: CheckoutContextAddress;
}

/**
 * Tagged union: `new` carries local fields; `saved` carries an exact backend
 * snapshot and requires a non-null `sourceCustomerId`. The two never mix, and
 * `saved` snapshots are never narrowed relative to the T1 shape.
 */
export type MinimalCheckoutDraftAddress =
  | MinimalCheckoutDraftNewAddressChoice
  | MinimalCheckoutDraftSavedAddressChoice;

export interface MinimalCheckoutDraft {
  schemaVersion: 1;
  /** Trusted WhatsApp sender id this draft is bound to; exact match required. */
  senderId: string;
  /** Non-negative safe integer; local concurrency boundary, not backend freshness. */
  revision: number;
  /** Opaque T1 correlation id, or `null` (not absence authority; see module docs). */
  sourceCustomerId: string | null;
  customer: MinimalCheckoutDraftCustomer;
  address: MinimalCheckoutDraftAddress;
}

/**
 * Capture own data properties once, without invoking accessors. Returns `null`
 * for non-objects, symbol keys, accessor properties or explicit `undefined`, so
 * a hostile getter is never read twice and cannot later yield a foreign value.
 */
function readDataRecord(value: unknown): Map<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const captured = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    if (descriptor.value === undefined) return null;
    captured.set(key, descriptor.value);
  }
  return captured;
}

/** True when the captured record has exactly the expected own keys. */
function hasExactKeys(
  captured: Map<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    captured.size === keys.length && keys.every((key) => captured.has(key))
  );
}

/** Capture the record only when its own keys match `keys` exactly. */
function readExactRecord(
  value: unknown,
  keys: readonly string[],
): Map<string, unknown> | null {
  const captured = readDataRecord(value);
  return captured !== null && hasExactKeys(captured, keys) ? captured : null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Canonical backend instant: `Date.toISOString()` round-trips verbatim (T1 parity). */
function isCanonicalInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function normalizeDraftCustomer(
  value: unknown,
): MinimalCheckoutDraftCustomer | null {
  const captured = readExactRecord(value, CUSTOMER_KEYS);
  if (captured === null) return null;
  const firstName = captured.get('firstName');
  const lastName = captured.get('lastName');
  if (!isNullableString(firstName)) return null;
  if (!isNullableString(lastName)) return null;
  return { firstName, lastName };
}

function normalizeNewAddress(
  value: unknown,
): MinimalCheckoutDraftNewAddressChoice | null {
  const captured = readExactRecord(value, NEW_FIELD_KEYS);
  if (captured === null) return null;
  const fields: MinimalCheckoutDraftNewAddressFields = {
    label: null,
    street: null,
    exteriorNumber: null,
    interiorNumber: null,
    zipCode: null,
    neighborhood: null,
    municipality: null,
    city: null,
    state: null,
    visualReferences: null,
    carrierPhone: null,
  };
  for (const key of NEW_FIELD_KEYS) {
    const field = captured.get(key);
    if (!isNullableString(field)) return null;
    fields[key] = field;
  }
  return { kind: 'new', fields };
}

function normalizeSavedAddress(
  value: unknown,
): MinimalCheckoutDraftSavedAddressChoice | null {
  const captured = readExactRecord(value, SNAPSHOT_KEYS);
  if (captured === null) return null;
  const id = captured.get('id');
  const version = captured.get('version');
  const street = captured.get('street');
  if (!isCheckoutUuid(id)) return null;
  if (!isCanonicalInstant(version)) return null;
  if (typeof street !== 'string') return null;
  for (const key of NEW_FIELD_KEYS) {
    if (!isNullableString(captured.get(key))) return null;
  }
  return {
    kind: 'saved',
    snapshot: {
      id: id as string,
      version: version as string,
      label: captured.get('label') as string | null,
      street,
      exteriorNumber: captured.get('exteriorNumber') as string | null,
      interiorNumber: captured.get('interiorNumber') as string | null,
      zipCode: captured.get('zipCode') as string | null,
      neighborhood: captured.get('neighborhood') as string | null,
      municipality: captured.get('municipality') as string | null,
      city: captured.get('city') as string | null,
      state: captured.get('state') as string | null,
      visualReferences: captured.get('visualReferences') as string | null,
      carrierPhone: captured.get('carrierPhone') as string | null,
    },
  };
}

function normalizeDraftAddress(
  value: unknown,
  sourceCustomerId: string | null,
): MinimalCheckoutDraftAddress | null {
  const captured = readDataRecord(value);
  if (captured === null) return null;
  const kind = captured.get('kind');
  if (kind === 'new') {
    if (!hasExactKeys(captured, NEW_ADDRESS_KEYS)) return null;
    return normalizeNewAddress(captured.get('fields'));
  }
  if (kind === 'saved') {
    if (!hasExactKeys(captured, SAVED_ADDRESS_KEYS)) return null;
    return sourceCustomerId === null
      ? null
      : normalizeSavedAddress(captured.get('snapshot'));
  }
  return null;
}

/**
 * Validate and detach an untrusted minimal checkout draft. `expectedSenderId`
 * must be a non-blank string equal to the raw `senderId` exactly (not phone
 * validation). Returns a fully detached copy, or `null` (fail-closed).
 */
export function normalizeMinimalCheckoutDraft(
  raw: unknown,
  expectedSenderId: string,
): MinimalCheckoutDraft | null {
  if (typeof expectedSenderId !== 'string' || expectedSenderId.trim() === '') {
    return null;
  }
  try {
    const captured = readExactRecord(raw, DRAFT_KEYS);
    if (captured === null) return null;

    if (
      captured.get('schemaVersion') !== MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION
    ) {
      return null;
    }
    const senderId = captured.get('senderId');
    if (senderId !== expectedSenderId) return null;
    const revision = captured.get('revision');
    if (!isNonNegativeSafeInteger(revision)) return null;
    const sourceCustomerId = captured.get('sourceCustomerId');
    if (!isNullableString(sourceCustomerId)) return null;
    if (sourceCustomerId !== null && !isCheckoutUuid(sourceCustomerId)) {
      return null;
    }

    const customer = normalizeDraftCustomer(captured.get('customer'));
    if (customer === null) return null;

    const address = normalizeDraftAddress(
      captured.get('address'),
      sourceCustomerId,
    );
    if (address === null) return null;

    return {
      schemaVersion: MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION,
      senderId,
      revision,
      sourceCustomerId,
      customer,
      address,
    };
  } catch {
    return null;
  }
}
