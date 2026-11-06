import { z } from 'zod';

/** DELIVERY_ZONE bot cycle (docs/contracts/delivery-zone-bot-cycle.md §4):
 * pure, fail-closed intake and requester normalizers. The ACK reuses the
 * RESTOCK application-outcome DTOs unchanged (§4.3 "identical"). */
export interface DeliveryZoneIntakeInput {
  sourceRequestId: string;
  type: 'DELIVERY_ZONE';
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  phoneCountryCode: string;
  phone: string;
  conversationRef: string;
  lastCustomerMessageAt: string;
}

export type DeliveryZoneType = 'FREE' | 'SURCHARGE' | 'CARRIER_ONLY' | 'DENIED';

export interface DeliveryZoneResolution {
  source: 'VALIDATION' | 'EXISTING_ZONE';
  zoneType: DeliveryZoneType;
  /** Omitted (never null) when not applicable. */
  surchargeCents?: number;
  etaDays?: number;
  resolvedAt: string;
}

export interface DeliveryZoneRequesterSnapshot {
  branchName: string | null;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
}

interface DeliveryZoneRequesterBase {
  /** Requester id: the `:id` of poll and ACK. */
  id: string;
  sourceRequestId: string;
  type: 'DELIVERY_ZONE';
  createdAt: string;
  snapshot: DeliveryZoneRequesterSnapshot;
}

export type DeliveryZoneRequesterPending = DeliveryZoneRequesterBase & {
  status: 'PENDING';
  version: 1;
  decisionId: string;
  resolution: null;
  applyBefore: null;
};

export type DeliveryZoneRequesterResolved = DeliveryZoneRequesterBase & {
  status: 'RESOLVED';
  version: 2;
  /** `null` only for an EXISTING_ZONE resolution. */
  decisionId: string | null;
  resolution: DeliveryZoneResolution;
  applyBefore: string;
};

export type DeliveryZoneRequester =
  | DeliveryZoneRequesterPending
  | DeliveryZoneRequesterResolved;

/** ACK window: [resolvedAt, resolvedAt + 24h). */
export const DELIVERY_ZONE_ACK_WINDOW_MS = 86_400_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_INSTANT = z.iso.datetime();
const INTAKE_KEYS =
  'sourceRequestId type zipCode state municipality neighborhood phoneCountryCode phone conversationRef lastCustomerMessageAt'.split(
    ' ',
  );
const REQUESTER_KEYS =
  'id sourceRequestId type status version createdAt decisionId snapshot resolution applyBefore'.split(
    ' ',
  );
const SNAPSHOT_KEYS =
  'branchName zipCode state municipality neighborhood'.split(' ');
const RESOLUTION_REQUIRED_KEYS = 'source zoneType resolvedAt'.split(' ');
const RESOLUTION_OPTIONAL_KEYS = 'surchargeCents etaDays'.split(' ');
const ZONE_TYPES: readonly string[] = [
  'FREE',
  'SURCHARGE',
  'CARRIER_ONLY',
  'DENIED',
];

/** Own plain data properties only, or null (no accessors, symbols, classes). */
function plain(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const proto = Reflect.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return null;
    if (descriptor.value === undefined) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
function exactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
/** 1–120 chars after whitespace collapse; no control chars. */
function placeName(value: unknown): string | null {
  if (typeof value !== 'string' || hasControl(value)) return null;
  const collapsed = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return collapsed.length >= 1 && collapsed.length <= 120 ? collapsed : null;
}
function digits(value: unknown, max: number): string | null {
  return typeof value === 'string' &&
    new RegExp(`^[0-9]{1,${max}}$`).test(value)
    ? value
    : null;
}
/** Canonical `toISOString` UTC instant, or null. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !UTC_INSTANT.safeParse(value).success)
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Normalize the exact ten-key intake body; null when any rule fails. */
export function normalizeDeliveryZoneIntake(
  input: unknown,
): DeliveryZoneIntakeInput | null {
  try {
    const record = plain(input);
    if (record === null || !exactKeys(record, INTAKE_KEYS)) return null;
    if (record.type !== 'DELIVERY_ZONE') return null;
    const sourceRequestId =
      typeof record.sourceRequestId === 'string' &&
      SOURCE_UUID.test(record.sourceRequestId)
        ? record.sourceRequestId
        : null;
    const zipCode =
      typeof record.zipCode === 'string' && /^[0-9]{5}$/.test(record.zipCode)
        ? record.zipCode
        : null;
    const state = placeName(record.state);
    const municipality = placeName(record.municipality);
    const neighborhood = placeName(record.neighborhood);
    const phoneCountryCode = digits(record.phoneCountryCode, 10);
    const phone = digits(record.phone, 20);
    const conversationRef =
      typeof record.conversationRef === 'string' &&
      record.conversationRef.length >= 1 &&
      record.conversationRef.length <= 200 &&
      !hasControl(record.conversationRef)
        ? record.conversationRef
        : null;
    const lastCustomerMessageAt = instant(record.lastCustomerMessageAt);
    if (
      sourceRequestId === null ||
      zipCode === null ||
      state === null ||
      municipality === null ||
      neighborhood === null ||
      phoneCountryCode === null ||
      phone === null ||
      conversationRef === null ||
      lastCustomerMessageAt === null
    )
      return null;
    return {
      sourceRequestId,
      type: 'DELIVERY_ZONE',
      zipCode,
      state,
      municipality,
      neighborhood,
      phoneCountryCode,
      phone,
      conversationRef,
      lastCustomerMessageAt,
    };
  } catch {
    return null;
  }
}

function normalizeSnapshot(
  value: unknown,
): DeliveryZoneRequesterSnapshot | null {
  const record = plain(value);
  if (record === null || !exactKeys(record, SNAPSHOT_KEYS)) return null;
  const { branchName, zipCode, state, municipality, neighborhood } = record;
  if (branchName !== null && typeof branchName !== 'string') return null;
  if (typeof zipCode !== 'string' || !/^[0-9]{5}$/.test(zipCode)) return null;
  if (
    typeof state !== 'string' ||
    typeof municipality !== 'string' ||
    typeof neighborhood !== 'string'
  )
    return null;
  return { branchName, zipCode, state, municipality, neighborhood };
}

/** surcharge/eta are optional and never null; DENIED and CARRIER_ONLY carry neither. */
function normalizeResolution(value: unknown): DeliveryZoneResolution | null {
  const record = plain(value);
  if (record === null) return null;
  const keys = Object.keys(record);
  if (
    !RESOLUTION_REQUIRED_KEYS.every((key) => keys.includes(key)) ||
    !keys.every(
      (key) =>
        RESOLUTION_REQUIRED_KEYS.includes(key) ||
        RESOLUTION_OPTIONAL_KEYS.includes(key),
    )
  )
    return null;
  const { source, zoneType } = record;
  if (source !== 'VALIDATION' && source !== 'EXISTING_ZONE') return null;
  if (typeof zoneType !== 'string' || !ZONE_TYPES.includes(zoneType))
    return null;
  const resolvedAt = instant(record.resolvedAt);
  if (resolvedAt === null) return null;
  const resolution: DeliveryZoneResolution = {
    source,
    zoneType: zoneType as DeliveryZoneType,
    resolvedAt,
  };
  const carriesNone = zoneType === 'DENIED' || zoneType === 'CARRIER_ONLY';
  if ('surchargeCents' in record) {
    const surcharge = count(record.surchargeCents);
    if (surcharge === null || carriesNone) return null;
    resolution.surchargeCents = surcharge;
  }
  if ('etaDays' in record) {
    const eta = count(record.etaDays);
    if (eta === null || carriesNone) return null;
    resolution.etaDays = eta;
  }
  // Keep the wire key order stable for comparisons.
  return {
    source: resolution.source,
    zoneType: resolution.zoneType,
    ...(resolution.surchargeCents === undefined
      ? {}
      : { surchargeCents: resolution.surchargeCents }),
    ...(resolution.etaDays === undefined
      ? {}
      : { etaDays: resolution.etaDays }),
    resolvedAt: resolution.resolvedAt,
  };
}

/** Normalize the intake (201/200) or poll (200) requester body: exact keys,
 * PENDING/v1 with null resolution and applyBefore, or RESOLVED/v2 with
 * `applyBefore = resolvedAt + 24h`. EXISTING_ZONE carries `decisionId: null`;
 * every other state carries the shared validation id. Never throws. */
export function normalizeDeliveryZoneRequester(
  value: unknown,
): DeliveryZoneRequester | null {
  try {
    const record = plain(value);
    if (record === null || !exactKeys(record, REQUESTER_KEYS)) return null;
    if (record.type !== 'DELIVERY_ZONE') return null;
    const id =
      typeof record.id === 'string' && UUID.test(record.id) ? record.id : null;
    const sourceRequestId =
      typeof record.sourceRequestId === 'string' &&
      UUID.test(record.sourceRequestId)
        ? record.sourceRequestId
        : null;
    const createdAt = instant(record.createdAt);
    const snapshot = normalizeSnapshot(record.snapshot);
    if (
      id === null ||
      sourceRequestId === null ||
      createdAt === null ||
      snapshot === null
    )
      return null;
    const decisionId =
      typeof record.decisionId === 'string' && UUID.test(record.decisionId)
        ? record.decisionId
        : record.decisionId === null
          ? null
          : undefined;
    if (decisionId === undefined) return null;
    const base = {
      id,
      sourceRequestId,
      type: 'DELIVERY_ZONE' as const,
      createdAt,
      snapshot,
    };
    if (record.status === 'PENDING') {
      if (
        record.version !== 1 ||
        decisionId === null ||
        record.resolution !== null ||
        record.applyBefore !== null
      )
        return null;
      return {
        ...base,
        status: 'PENDING',
        version: 1,
        decisionId,
        resolution: null,
        applyBefore: null,
      };
    }
    if (record.status !== 'RESOLVED' || record.version !== 2) return null;
    const resolution = normalizeResolution(record.resolution);
    const applyBefore = instant(record.applyBefore);
    if (resolution === null || applyBefore === null) return null;
    if ((resolution.source === 'EXISTING_ZONE') !== (decisionId === null))
      return null;
    if (
      Date.parse(applyBefore) !==
      Date.parse(resolution.resolvedAt) + DELIVERY_ZONE_ACK_WINDOW_MS
    )
      return null;
    return {
      ...base,
      status: 'RESOLVED',
      version: 2,
      decisionId,
      resolution,
      applyBefore,
    };
  } catch {
    return null;
  }
}
