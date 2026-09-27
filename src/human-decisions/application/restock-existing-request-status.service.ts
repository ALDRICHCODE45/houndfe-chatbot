/**
 * HD-R1 read-only recovery for an ALREADY accepted RESTOCK request.
 *
 * Production: a trusted recorded RESTOCK receipt made the request preflight
 * block with `existing_restock`, which the tool collapsed into the generic
 * `restock_unavailable`. This service proves the LOCAL accepted receipt plus the
 * requested subject and then asks the backend for the CURRENT state.
 *
 * It composes the three existing seams only:
 *   - `PostgresRestockApplicationContextStore.readRecordedForSender` (the
 *     trusted ACTIVE + RECEIPT_RECORDED snapshot),
 *   - `ChatbotApiClient.getRestockDecision` (the current-state GET), and
 *   - the pure `classifyRestockApplication` policy.
 *
 * It is strictly read-only: no POST, no intake coordinator, no legacy fallback,
 * no marker clear and no reservation release. A boolean route marker is never
 * acceptance evidence; only the recorded receipt is. The CURRENT customer turn
 * is validated for authenticity and sender binding, but its derived id is NEVER
 * used: the recorded receipt's own source identity is the only backend key.
 *
 * A proven receipt with a transport/5xx outage or a resolution race yields
 * `current_status_unknown`; a rejected 200 body (malformed or wrong identity),
 * an auth/forbidden read, malformed local context, forged/expired sessions,
 * subject mismatch and unrecorded senders are `unavailable`. Never throws.
 */
import { z } from 'zod';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import { UpstreamError } from '../../chatbot-api/domain/errors';
import {
  normalizeRestockDecision,
  normalizeRestockIntake,
} from '../../chatbot-api/domain/dtos/human-decisions.dto';
import { CatalogSession } from '../../conversation/domain/catalog-references';
import { classifyRestockApplication } from '../domain/restock-application-policy';
import { bindRestockInboundEvent } from '../domain/restock-source-identity';
import type {
  PostgresRestockApplicationContextStore as ContextStore,
  RecordedRestockContext,
} from '../infrastructure/postgres-restock-application-context.store';

/** DI token for the inert, read-only existing-request recovery service. */
export const RESTOCK_EXISTING_REQUEST_STATUS_SERVICE = Symbol(
  'RESTOCK_EXISTING_REQUEST_STATUS_SERVICE',
);

export interface RestockExistingRequestInput {
  readonly senderId: string;
  readonly catalogSession?: unknown;
  readonly inboundEvent: unknown;
  readonly digest: unknown;
}

export type RestockExistingRequestStatus =
  | 'pending'
  | 'response_recorded'
  | 'stale'
  | 'current_status_unknown';

export type RestockExistingRequestRecovery =
  | {
      readonly outcome: 'existing_restock_recorded';
      readonly status: RestockExistingRequestStatus;
    }
  | { readonly outcome: 'unavailable' };

const UNAVAILABLE: RestockExistingRequestRecovery = Object.freeze({
  outcome: 'unavailable' as const,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recorded = (
  status: RestockExistingRequestStatus,
): RestockExistingRequestRecovery =>
  Object.freeze({ outcome: 'existing_restock_recorded' as const, status });

/** Mirrors the request preflight digest schema; unknown keys are stripped. */
const DIGEST_SCHEMA = z.object({
  productId: z.uuid(),
  name: z.string().min(1),
  variantId: z.uuid().optional(),
  quantity: z.number().int().min(1).optional(),
});

function validSender(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function validBranch(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Only a genuine transport or 5xx outage is a receipt-backed unknown. The real
 * HTTP client throws one `UpstreamError` for both an unexpected status and a
 * rejected 200 body, so classify on its typed `statusCode` alone (never the
 * message, never the raw body): `null` (transport) or `>= 500` is an outage;
 * a `200`/`4xx`/local `ChatbotApiError` is a rejected read, not an outage.
 */
function isReceiptBackedOutage(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false;
  const status = error.statusCode;
  return status === null || (typeof status === 'number' && status >= 500);
}

/**
 * Defense in depth over the trusted port: the store already validated this
 * snapshot, but a malformed cached/foreign context must never reach the policy.
 */
function isTrustedContext(
  context: RecordedRestockContext,
  senderId: string,
): boolean {
  if (typeof context !== 'object' || context === null) return false;
  const reservation = context.reservation;
  if (typeof reservation !== 'object' || reservation === null) return false;
  if (
    reservation.senderId !== senderId ||
    reservation.status !== 'ACTIVE' ||
    reservation.route !== 'RESTOCK'
  ) {
    return false;
  }
  const normalized = normalizeRestockIntake(reservation.intake);
  if (normalized === null) return false;
  if (
    Object.keys(reservation.intake).length !== Object.keys(normalized).length ||
    Object.entries(normalized).some(
      ([key, value]) =>
        !Object.is(reservation.intake[key as keyof typeof normalized], value),
    )
  ) {
    return false;
  }
  if (reservation.requestKey !== normalized.sourceRequestId) return false;
  return (
    typeof context.backendDecisionId === 'string' &&
    UUID.test(context.backendDecisionId)
  );
}

export class RestockExistingRequestStatusService {
  constructor(
    private readonly reader: Pick<ContextStore, 'readRecordedForSender'>,
    private readonly backend: Pick<ChatbotApiClient, 'getRestockDecision'>,
    private readonly branchId: string,
    private readonly clock: () => Date,
  ) {}

  async recover(
    input: RestockExistingRequestInput,
  ): Promise<RestockExistingRequestRecovery> {
    try {
      const senderId = input.senderId;
      if (!validSender(senderId) || !validBranch(this.branchId)) {
        return UNAVAILABLE;
      }
      // Gate 1: a genuine, sender-bound CURRENT turn. Its derived id is
      // deliberately discarded; only the recorded receipt keys the GET.
      if (bindRestockInboundEvent(input.inboundEvent, senderId) === null) {
        return UNAVAILABLE;
      }
      // Gate 2: the requested subject parsed from the model digest.
      const parsed = DIGEST_SCHEMA.safeParse(input.digest);
      if (!parsed.success) return UNAVAILABLE;
      const productId = parsed.data.productId;
      const variantId = parsed.data.variantId ?? null;
      // Gate 3: a genuine sender-bound CatalogSession for that exact
      // product/variant identity. The model's display name is not identity.
      const session = input.catalogSession;
      if (
        !CatalogSession.is(session) ||
        session.senderId !== senderId ||
        !session.matches({ productId, variantId })
      ) {
        return UNAVAILABLE;
      }
      // Gate 4: the trusted recorded receipt for THIS sender.
      let read: Awaited<ReturnType<ContextStore['readRecordedForSender']>>;
      try {
        read = await this.reader.readRecordedForSender(senderId);
      } catch {
        return UNAVAILABLE;
      }
      if (read?.action !== 'recorded') return UNAVAILABLE;
      const context = read.context;
      if (!isTrustedContext(context, senderId)) return UNAVAILABLE;
      // Gate 5: no backend GET for a subject other than the recorded one.
      const recordedIntake = context.reservation.intake;
      if (recordedIntake.productId !== productId) return UNAVAILABLE;
      if ((recordedIntake.variantId ?? null) !== variantId) return UNAVAILABLE;
      // Gate 6: current state, keyed ONLY by the persisted backend decision id.
      let current: ReturnType<typeof normalizeRestockDecision>;
      try {
        current = normalizeRestockDecision(
          await this.backend.getRestockDecision(context.backendDecisionId),
        );
      } catch (error) {
        // A transport/5xx outage keeps the proven receipt as a safe unknown; a
        // rejected 200 body (malformed or wrong identity), an auth/forbidden
        // rejection or any local error stays unavailable.
        return isReceiptBackedOutage(error)
          ? recorded('current_status_unknown')
          : UNAVAILABLE;
      }
      // A non-throwing malformed body is the same rejected-read class.
      if (current === null) return UNAVAILABLE;
      let now: string;
      try {
        now = Date.prototype.toISOString.call(this.clock());
      } catch {
        return UNAVAILABLE;
      }
      const policy = classifyRestockApplication({
        senderId,
        branchId: this.branchId,
        reservation: context.reservation,
        backendDecisionId: context.backendDecisionId,
        decision: current,
        now,
      });
      if (policy.action === 'pending') return recorded('pending');
      if (policy.action === 'ready') return recorded('response_recorded');
      if (policy.action === 'stale') return recorded('stale');
      // A race (backend resolved after our clock) is a safe unknown; every
      // other hold is an identity/branch/malformed mismatch and stays generic.
      return policy.reason === 'clock_before_resolution'
        ? recorded('current_status_unknown')
        : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
}
