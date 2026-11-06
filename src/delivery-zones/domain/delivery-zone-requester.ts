import type {
  DeliveryZoneIntakeInput,
  DeliveryZoneResolution,
  DeliveryZoneType,
} from '../../chatbot-api/domain/dtos/human-decisions-delivery-zone.dto';
import type { RestockApplicationOutcomeCode } from '../../chatbot-api/domain/dtos/human-decisions.dto';

/**
 * One chatbot DELIVERY_ZONE requester (one sender + ZIP while open).
 *
 *   INTAKE_PENDING → PENDING → RESOLVED → SEND_STARTED → NOTIFIED → CLOSED
 *   INTAKE_PENDING → RESOLVED (EXISTING_ZONE answers the intake at once)
 *   INTAKE_PENDING → FAILED  (intake permanently rejected: 400/409)
 *
 * SEND_STARTED is written BEFORE the provider call, so a crash between the
 * two never resends: recovery records DELIVERY_UNKNOWN instead.
 */
export type DeliveryZoneRequesterStatus =
  | 'INTAKE_PENDING'
  | 'PENDING'
  | 'RESOLVED'
  | 'SEND_STARTED'
  | 'NOTIFIED'
  | 'CLOSED'
  | 'FAILED';

export type DeliveryZoneDeliveryOutcome = Exclude<
  RestockApplicationOutcomeCode,
  'STALE'
>;

export interface DeliveryZoneRequesterRow {
  sourceRequestId: string;
  senderId: string;
  zipCode: string;
  /** Exact intake body first sent; every replay re-sends these bytes. */
  intake: DeliveryZoneIntakeInput;
  requesterId: string | null;
  status: DeliveryZoneRequesterStatus;
  lastPolledAt: string | null;
  resolution: DeliveryZoneResolution | null;
  applyBefore: string | null;
  channel: 'TEXT' | 'TEMPLATE' | null;
  attemptId: string | null;
  attemptedAt: string | null;
  deliveryOutcome: DeliveryZoneDeliveryOutcome | null;
  providerMessageId: string | null;
  providerAcceptedObservedAt: string | null;
  notifiedAt: string | null;
  /** Outcome the backend acknowledged; null when no ACK was possible. */
  ackOutcome: DeliveryZoneDeliveryOutcome | null;
  ackedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryZoneRequesterPatch = Partial<
  Omit<
    DeliveryZoneRequesterRow,
    'sourceRequestId' | 'senderId' | 'zipCode' | 'intake' | 'createdAt'
  >
>;

/** Open = still owns the (sender, ZIP) slot. */
export const OPEN_DELIVERY_ZONE_STATUSES: readonly DeliveryZoneRequesterStatus[] =
  ['INTAKE_PENDING', 'PENDING', 'RESOLVED', 'SEND_STARTED', 'NOTIFIED'];

export interface DeliveryZonePollPolicy {
  /** Minimum gap between backend calls for a young requester. */
  intervalMs: number;
  /** Age after which a requester counts as long-pending. */
  slowAfterMs: number;
  /** Minimum gap between backend calls for a long-pending requester. */
  slowIntervalMs: number;
}

export const DEFAULT_DELIVERY_ZONE_POLL_POLICY: DeliveryZonePollPolicy = {
  intervalMs: 60_000,
  slowAfterMs: 3_600_000,
  slowIntervalMs: 300_000,
};

/**
 * Due selection (mirrored by the Postgres `listDue` query): a resolved,
 * started or notified row is always due; an intake/pending row is due when it
 * was never tried or its last backend call is older than the backoff gap.
 */
export function isDeliveryZoneRequesterDue(
  row: Pick<DeliveryZoneRequesterRow, 'status' | 'lastPolledAt' | 'createdAt'>,
  nowMs: number,
  policy: DeliveryZonePollPolicy,
): boolean {
  if (
    row.status === 'RESOLVED' ||
    row.status === 'SEND_STARTED' ||
    row.status === 'NOTIFIED'
  )
    return true;
  if (row.status !== 'INTAKE_PENDING' && row.status !== 'PENDING') return false;
  if (row.lastPolledAt === null) return true;
  const gap =
    nowMs - Date.parse(row.createdAt) >= policy.slowAfterMs
      ? policy.slowIntervalMs
      : policy.intervalMs;
  return nowMs - Date.parse(row.lastPolledAt) >= gap;
}

/**
 * Durable requester store. Every mutation is a CAS on `status` so two
 * workers (or a restart racing a tick) can never both advance one row.
 */
export interface DeliveryZoneRequesterStore {
  findOpen(
    senderId: string,
    zipCode: string,
  ): Promise<DeliveryZoneRequesterRow | null>;
  /** Insert, or return the row already open for (sender, ZIP). */
  createOrGetOpen(
    row: DeliveryZoneRequesterRow,
  ): Promise<DeliveryZoneRequesterRow>;
  /** Apply `patch` only while the row is still in `from`; null otherwise. */
  transition(
    sourceRequestId: string,
    from: DeliveryZoneRequesterStatus,
    patch: DeliveryZoneRequesterPatch,
  ): Promise<DeliveryZoneRequesterRow | null>;
  /** Due rows, never-tried and oldest-tried first, at most `limit`. */
  listDue(
    now: string,
    limit: number,
    policy: DeliveryZonePollPolicy,
  ): Promise<DeliveryZoneRequesterRow[]>;
}

export const DELIVERY_ZONE_REQUESTER_STORE = Symbol(
  'DELIVERY_ZONE_REQUESTER_STORE',
);

/** Chatbot-owned utility template (owner creates it; Meta approves it). */
export const DELIVERY_ZONE_TEMPLATE = Object.freeze({
  templateName: 'zona_entrega_revisada',
  languageCode: 'es_MX',
});

/**
 * Customer text inside the 24h WhatsApp window. The zone surcharge is not
 * quoted: the backend quote applies the product credit, so only a fresh
 * quote shows what the customer actually pays.
 */
export function deliveryZoneResolvedText(
  zipCode: string,
  zoneType: DeliveryZoneType,
): string {
  if (zoneType === 'DENIED')
    return `Revisamos su código postal ${zipCode} y por ahora no tenemos entrega ahí. Puede recoger su pedido en tienda sin costo de envío.`;
  return `¡Listo! Ya tenemos entrega a su código postal ${zipCode}. Pídame de nuevo el envío y le muestro el costo actualizado.`;
}
