/** INACTIVE, unwired EXPIRATION reader→GET composition: a plain class with no
 * DI, module wiring or runtime HTTP instantiation. It reads the local recorded
 * receipt and queries the backend ONLY by the receipt's persisted decision id,
 * then binds origin, branch, product and variant with exact bytes (no folding,
 * trimming or rewriting) so the dependency cannot rebind the request across the
 * GET await. A `RESOLVED` past its deadline is still `resolved` — no
 * send-eligibility, ACK, message or polling claim. The `senderId` is a trusted
 * caller prerequisite (authentic ingress/current-interest/ownership is out of
 * scope) and `branchId` is trusted configuration. Nothing is sent or written. */
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  normalizeExpirationDecision,
  type ExpirationDecisionPending,
  type ExpirationDecisionResolved,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration-decision.dto';
import { normalizeExpirationIntake } from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import type { PostgresExpirationApplicationContextStore } from '../infrastructure/postgres-expiration-application-context.store';

export type ExpirationContextReaderPort = Pick<
  PostgresExpirationApplicationContextStore,
  'readRecordedForSender'
>;
export type ExpirationDecisionClientPort = Pick<
  ChatbotApiClient,
  'getExpirationDecision'
>;

type OutcomeOf<K, D> = { readonly outcome: K; readonly decision: D };
export type ExpirationExistingDecisionOutcome =
  | OutcomeOf<'pending', ExpirationDecisionPending>
  | OutcomeOf<'resolved', ExpirationDecisionResolved>
  | { readonly outcome: 'held' }
  | { readonly outcome: 'query_failed' };

/** The GET requires canonical lowercase ids; the persisted receipt too. */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HELD = Object.freeze({ outcome: 'held' as const });
const QUERY_FAILED = Object.freeze({ outcome: 'query_failed' as const });

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

interface TrustedExpirationContext {
  readonly backendDecisionId: string;
  readonly sourceRequestId: string;
  readonly productId: string;
  readonly variantId: string | null;
}

/** Defense over the trusted port: the store already validated this snapshot,
 * but a malformed or mutating context must never reach the binding below. Every
 * primitive is copied here, BEFORE the GET await, so the dependency cannot
 * rebind the request across that await. */
function snapshotTrustedContext(
  context: unknown,
  senderId: string,
): TrustedExpirationContext | null {
  try {
    if (typeof context !== 'object' || context === null) return null;
    const record = context as Record<string, unknown>;
    const reservation = record.reservation as Record<string, unknown> | null;
    if (typeof reservation !== 'object' || reservation === null) return null;
    if (
      reservation.senderId !== senderId ||
      reservation.status !== 'ACTIVE' ||
      reservation.route !== 'EXPIRATION'
    ) {
      return null;
    }
    const normalized = normalizeExpirationIntake(reservation.intake);
    if (normalized === null) return null;
    const raw = reservation.intake as Record<string, unknown>;
    if (
      Object.entries(normalized).some(
        ([key, value]) => !Object.is(raw[key], value),
      ) ||
      Reflect.ownKeys(raw).length !== Object.keys(normalized).length
    ) {
      return null;
    }
    if (reservation.requestKey !== normalized.sourceRequestId) return null;
    const backendDecisionId = record.backendDecisionId;
    if (
      typeof backendDecisionId !== 'string' ||
      !CANONICAL_UUID.test(backendDecisionId)
    ) {
      return null;
    }
    return Object.freeze({
      backendDecisionId,
      sourceRequestId: normalized.sourceRequestId,
      productId: normalized.productId,
      variantId: normalized.variantId,
    });
  } catch {
    return null;
  }
}

export class ExpirationExistingDecisionService {
  constructor(
    private readonly reader: ExpirationContextReaderPort,
    private readonly backend: ExpirationDecisionClientPort,
    private readonly branchId: string,
  ) {}

  async readExistingDecision(
    senderId: string,
  ): Promise<ExpirationExistingDecisionOutcome> {
    try {
      if (!validSender(senderId) || !validBranch(this.branchId)) return HELD;
      let read: Awaited<
        ReturnType<ExpirationContextReaderPort['readRecordedForSender']>
      >;
      try {
        read = await this.reader.readRecordedForSender(senderId);
      } catch {
        return QUERY_FAILED;
      }
      if (read?.action !== 'recorded') return HELD;
      const context = snapshotTrustedContext(read.context, senderId);
      if (context === null) return HELD;
      let decision: ReturnType<typeof normalizeExpirationDecision>;
      try {
        decision = normalizeExpirationDecision(
          await this.backend.getExpirationDecision(context.backendDecisionId),
        );
      } catch {
        return QUERY_FAILED;
      }
      if (decision === null) return QUERY_FAILED;
      if (decision.id !== context.backendDecisionId) return QUERY_FAILED;
      if (
        decision.sourceRequestId !== context.sourceRequestId ||
        decision.snapshot.productId !== context.productId ||
        decision.snapshot.variantId !== context.variantId ||
        decision.snapshot.branchId !== this.branchId
      ) {
        return HELD;
      }
      return decision.status === 'PENDING'
        ? Object.freeze({ outcome: 'pending' as const, decision })
        : Object.freeze({ outcome: 'resolved' as const, decision });
    } catch {
      return HELD;
    }
  }
}
