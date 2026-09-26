/**
 * SQ-5E1a bounded quote-context record: sibling key `shippingQuoteDraftContext`
 * (schemaVersion 1) pins a draft to its exact canonical `draftCreatedAt` and
 * snapshots only the customer, address, cart, and four destination fields a
 * future sale must match. Integrity snapshot, not secrecy; no I/O; malformed
 * or legacy JSONB returns `null`.
 */
export const SHIPPING_QUOTE_DRAFT_CONTEXT_KEY = 'shippingQuoteDraftContext';
export const SHIPPING_QUOTE_DRAFT_CONTEXT_VERSION = 1 as const;
export const MAX_SHIPPING_QUOTE_DRAFT_CONTEXT_LINES = 20;

export interface ShippingQuoteDraftContextLine {
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface ShippingQuoteDraftDestination {
  readonly zipCode: string;
  readonly state: string;
  readonly municipality: string;
  readonly neighborhood: string;
}

export interface ShippingQuoteDraftContext {
  readonly schemaVersion: typeof SHIPPING_QUOTE_DRAFT_CONTEXT_VERSION;
  readonly draftCreatedAt: string;
  readonly customerId: string;
  readonly shippingAddressId: string;
  readonly cart: readonly ShippingQuoteDraftContextLine[];
  readonly destination: ShippingQuoteDraftDestination;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i;
const ZIP_CODE = /^[0-9]{5}$/;
const EXACT_TEXT = /^\S(?:[\s\S]*\S)?$/;
const INPUT_KEYS = ['customerId', 'shippingAddressId', 'cart', 'destination'];
const LINE_KEYS = ['productId', 'variantId', 'quantity', 'unitPriceCents'];
const DESTINATION_KEYS = ['zipCode', 'state', 'municipality', 'neighborhood'];
const CONTEXT_KEYS = ['schemaVersion', 'draftCreatedAt', ...INPUT_KEYS];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

// Own enumerable data keys only: rejects inherited, accessor, non-enumerable,
// and symbol extras, not just a matching own enumerable string-key count.
function hasExactDataKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true) {
      return false;
    }
    return 'value' in descriptor;
  });
}

const safeInt = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

function canonicalUuid(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && UUID.test(value)
    ? value.toLowerCase()
    : undefined;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
    ? value
    : null;
}

function exactText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) {
    return null;
  }
  return EXACT_TEXT.test(value) ? value : null;
}

function destinationOf(raw: unknown): ShippingQuoteDraftDestination | null {
  if (!isPlainRecord(raw) || !hasExactDataKeys(raw, DESTINATION_KEYS)) {
    return null;
  }
  const { zipCode, state, municipality, neighborhood } = raw;
  if (typeof zipCode !== 'string' || !ZIP_CODE.test(zipCode)) return null;
  const exactState = exactText(state);
  const exactMunicipality = exactText(municipality);
  const exactNeighborhood = exactText(neighborhood);
  if (
    exactState === null ||
    exactMunicipality === null ||
    exactNeighborhood === null
  ) {
    return null;
  }
  return Object.freeze({
    zipCode,
    state: exactState,
    municipality: exactMunicipality,
    neighborhood: exactNeighborhood,
  });
}

function cartLineOf(raw: unknown): ShippingQuoteDraftContextLine | null {
  if (!isPlainRecord(raw) || !hasExactDataKeys(raw, LINE_KEYS)) return null;
  const productId = canonicalUuid(raw.productId);
  if (productId === null || productId === undefined) return null;
  const variantId = canonicalUuid(raw.variantId);
  if (variantId === undefined) return null;
  const quantity: unknown = raw.quantity;
  if (!safeInt(quantity, 1)) return null;
  const unitPriceCents: unknown = raw.unitPriceCents;
  if (!safeInt(unitPriceCents, 0)) return null;
  return Object.freeze({ productId, variantId, quantity, unitPriceCents });
}

function compareLines(
  a: ShippingQuoteDraftContextLine,
  b: ShippingQuoteDraftContextLine,
): number {
  if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
  const av = a.variantId ?? '';
  const bv = b.variantId ?? '';
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function cartOf(raw: unknown): readonly ShippingQuoteDraftContextLine[] | null {
  try {
    if (!Array.isArray(raw)) return null;
    const length: unknown = raw.length;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_SHIPPING_QUOTE_DRAFT_CONTEXT_LINES
    ) {
      return null;
    }
    const lines: ShippingQuoteDraftContextLine[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(raw, i)) return null;
      const line = cartLineOf(raw[i]);
      if (line === null) return null;
      const key = `${line.productId}\u0000${line.variantId ?? ''}`;
      if (seen.has(key)) return null;
      seen.add(key);
      lines.push(line);
    }
    lines.sort(compareLines);
    return Object.freeze(lines);
  } catch {
    return null;
  }
}

function contextFromFields(
  raw: unknown,
  draftCreatedAt: string,
): ShippingQuoteDraftContext | null {
  if (!isPlainRecord(raw) || !hasExactDataKeys(raw, INPUT_KEYS)) return null;
  const customerId = canonicalUuid(raw.customerId);
  if (customerId === null || customerId === undefined) return null;
  const shippingAddressId = canonicalUuid(raw.shippingAddressId);
  if (shippingAddressId === null || shippingAddressId === undefined) {
    return null;
  }
  const destination = destinationOf(raw.destination);
  if (destination === null) return null;
  const cart = cartOf(raw.cart);
  if (cart === null) return null;
  return Object.freeze({
    schemaVersion: SHIPPING_QUOTE_DRAFT_CONTEXT_VERSION,
    draftCreatedAt,
    customerId,
    shippingAddressId,
    cart,
    destination,
  });
}

/** Builds a fresh version-1 context from exact fields plus the canonical pin. */
export function buildShippingQuoteDraftContext(
  raw: unknown,
  draftCreatedAt: unknown,
): ShippingQuoteDraftContext | null {
  try {
    const createdAt = canonicalIso(draftCreatedAt);
    if (createdAt === null) return null;
    return contextFromFields(raw, createdAt);
  } catch {
    return null;
  }
}

/** Normalizes persisted JSONB; any legacy or malformed shape returns `null`. */
export function normalizeShippingQuoteDraftContext(
  value: unknown,
): ShippingQuoteDraftContext | null {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactDataKeys(value, CONTEXT_KEYS) ||
      value.schemaVersion !== SHIPPING_QUOTE_DRAFT_CONTEXT_VERSION
    ) {
      return null;
    }
    const createdAt = canonicalIso(value.draftCreatedAt);
    if (createdAt === null) return null;
    return contextFromFields(
      {
        customerId: value.customerId,
        shippingAddressId: value.shippingAddressId,
        cart: value.cart,
        destination: value.destination,
      },
      createdAt,
    );
  } catch {
    return null;
  }
}

/**
 * Exact integrity match over customer, address, destination, and canonical
 * cart (sorted by product then variant, so a safe reorder is equal). The
 * draft-created pin is validated by the draft/approval layer, not here.
 */
export function compareShippingQuoteDraftContext(
  left: unknown,
  right: unknown,
): boolean {
  try {
    const a = normalizeShippingQuoteDraftContext(left);
    if (a === null) return false;
    const b = normalizeShippingQuoteDraftContext(right);
    if (b === null) return false;
    if (
      a.customerId !== b.customerId ||
      a.shippingAddressId !== b.shippingAddressId ||
      a.destination.zipCode !== b.destination.zipCode ||
      a.destination.state !== b.destination.state ||
      a.destination.municipality !== b.destination.municipality ||
      a.destination.neighborhood !== b.destination.neighborhood ||
      a.cart.length !== b.cart.length
    ) {
      return false;
    }
    return a.cart.every((line, index) => {
      const other = b.cart[index];
      return (
        line.productId === other.productId &&
        line.variantId === other.variantId &&
        line.quantity === other.quantity &&
        line.unitPriceCents === other.unitPriceCents
      );
    });
  } catch {
    return false;
  }
}
