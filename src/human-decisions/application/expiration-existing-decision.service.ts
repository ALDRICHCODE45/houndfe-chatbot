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
import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import type { PostgresExpirationApplicationContextStore } from '../infrastructure/postgres-expiration-application-context.store';

export type ExpirationContextReaderPort = Pick<
  PostgresExpirationApplicationContextStore,
  'readRecordedForSender'
>;
export type ExpirationDecisionClientPort = Pick<
  ChatbotApiClient,
  'getExpirationDecision'
>;

/** Immutable, policy-compatible evidence for a resolved success: the caller's
 * original ACTIVE EXPIRATION reservation (exact five keys), the persisted
 * backend decision id actually queried, and the trusted configured branch. */
export interface ExpirationDecisionBindingReservation {
  readonly status: 'ACTIVE';
  readonly route: 'EXPIRATION';
  readonly senderId: string;
  readonly requestKey: string;
  readonly intake: Readonly<ExpirationIntakeInput>;
}
export interface ExpirationDecisionBinding {
  readonly reservation: ExpirationDecisionBindingReservation;
  readonly backendDecisionId: string;
  readonly branchId: string;
}

type OutcomeOf<K, D> = {
  readonly outcome: K;
  readonly decision: D;
  readonly binding: ExpirationDecisionBinding;
};
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

/** Defense over the trusted port: the store already validated this snapshot,
 * but a malformed or mutating context must never reach the binding below. Every
 * primitive is copied here, BEFORE the GET await, so the dependency cannot
 * rebind the request across that await. The returned reservation and intake are
 * detached, frozen copies built from the trusted sender, the validated
 * byte-exact intake primitives and the configured branch. */
function snapshotTrustedContext(
  context: unknown,
  senderId: string,
  branchId: string,
): ExpirationDecisionBinding | null {
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
    const intake: ExpirationIntakeInput = Object.freeze({ ...normalized });
    const boundReservation: ExpirationDecisionBindingReservation =
      Object.freeze({
        status: 'ACTIVE' as const,
        route: 'EXPIRATION' as const,
        senderId,
        requestKey: normalized.sourceRequestId,
        intake,
      });
    return Object.freeze({
      reservation: boundReservation,
      backendDecisionId,
      branchId,
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
      const binding = snapshotTrustedContext(
        read.context,
        senderId,
        this.branchId,
      );
      if (binding === null) return HELD;
      let decision: ReturnType<typeof normalizeExpirationDecision>;
      try {
        decision = normalizeExpirationDecision(
          await this.backend.getExpirationDecision(binding.backendDecisionId),
        );
      } catch {
        return QUERY_FAILED;
      }
      if (decision === null) return QUERY_FAILED;
      if (decision.id !== binding.backendDecisionId) return QUERY_FAILED;
      if (
        decision.sourceRequestId !==
          binding.reservation.intake.sourceRequestId ||
        decision.snapshot.productId !== binding.reservation.intake.productId ||
        decision.snapshot.variantId !== binding.reservation.intake.variantId ||
        decision.snapshot.branchId !== binding.branchId
      ) {
        return HELD;
      }
      return decision.status === 'PENDING'
        ? Object.freeze({ outcome: 'pending' as const, decision, binding })
        : Object.freeze({ outcome: 'resolved' as const, decision, binding });
    } catch {
      return HELD;
    }
  }
}
