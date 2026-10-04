/** INACTIVE, unwired EXPIRATION POST orchestrator (O1/O2): plain class — no DI,
 * GET, ACK or runtime wiring. Single POST only after the store's atomic claim
 * authorizes; ambiguous outcomes fail closed (never resend, never fake UNKNOWN). */
import {
  normalizeExpirationIntakeReceipt,
  type ExpirationIntakeReceipt,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration-receipt.dto';
import {
  normalizeExpirationIntake,
  type ExpirationIntakeInput,
} from '../../chatbot-api/domain/dtos/human-decisions-expiration.dto';
import type { ExpirationPostDecision } from '../domain/expiration-post-ledger';
import type {
  ExpirationPrepareDecision,
  PostgresExpirationPostClaimStore,
} from '../infrastructure/postgres-expiration-post-claim.store';
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';

export type ExpirationPostStorePort = Pick<
  PostgresExpirationPostClaimStore,
  'preparePost' | 'beginPost' | 'recordReceipt' | 'markUnknown'
>;

export type ExpirationPostClientPort = Pick<
  ChatbotApiClient,
  'submitExpirationIntake'
>;

export type ExpirationPostOrchestrationOutcome =
  | { readonly action: 'receipt_recorded'; readonly backendDecisionId: string }
  | { readonly action: 'receipt_replayed'; readonly backendDecisionId: string }
  | {
      readonly action: 'historical_receipt';
      readonly backendDecisionId: string;
    }
  | {
      readonly action: 'held_unknown';
      readonly reason: 'pre_post' | 'ambiguous_post';
    }
  | { readonly action: 'hold'; readonly reason: string }
  | { readonly action: 'blocked'; readonly reason: string };

interface FrozenInput {
  readonly senderId: string;
  readonly sourceRequestId: string;
  readonly intake: ExpirationIntakeInput;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_KEYS = ['senderId', 'sourceRequestId', 'intake'];
const INTAKE_KEYS = ['sourceRequestId', 'type', 'productId', 'variantId'];
const isCanonicalLowercaseUuid = (value: string): boolean =>
  UUID.test(value) && value === value.toLowerCase();

function snapshotOwn(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const proto = Reflect.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === 'string' && keys.includes(key))
    ) {
      return null;
    }
    const snap: Record<string, unknown> = {};
    for (const key of own) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return null;
      const read = (value as Record<string, unknown>)[key as string];
      if (!Object.is(descriptor.value, read)) return null;
      snap[key as string] = descriptor.value;
    }
    return snap;
  } catch {
    return null;
  }
}

function snapshotInput(input: unknown): FrozenInput | null {
  const snap = snapshotOwn(input, INPUT_KEYS);
  if (snap === null) return null;
  const { senderId, sourceRequestId } = snap;
  if (typeof senderId !== 'string' || !senderId.trim()) return null;
  if (typeof sourceRequestId !== 'string' || !UUID.test(sourceRequestId)) {
    return null;
  }
  const intake = normalizeExpirationIntake(
    snapshotOwn(snap.intake, INTAKE_KEYS),
  );
  if (intake === null || intake.sourceRequestId !== sourceRequestId) {
    return null;
  }
  return Object.freeze({
    senderId,
    sourceRequestId,
    intake: Object.freeze(intake),
  });
}

export class ExpirationPostOrchestrator {
  constructor(
    private readonly store: ExpirationPostStorePort,
    private readonly client: ExpirationPostClientPort,
  ) {}

  async orchestrateExpirationPost(
    raw: unknown,
  ): Promise<ExpirationPostOrchestrationOutcome> {
    const input = snapshotInput(raw);
    if (input === null) return { action: 'blocked', reason: 'malformed_input' };

    let prepared: ExpirationPrepareDecision;
    try {
      prepared = await this.store.preparePost(input);
    } catch {
      return this.holdOrBlock(input, 'prepare_unconfirmed');
    }
    if (prepared.action === 'blocked') {
      return { action: 'blocked', reason: `prepare_${prepared.reason}` };
    }

    let claim: ExpirationPostDecision;
    try {
      claim = await this.store.beginPost(input);
    } catch {
      return this.holdOrBlock(input, 'claim_unconfirmed');
    }
    if (claim.action === 'hold') {
      return { action: 'hold', reason: claim.reason };
    }
    if (claim.action === 'historical_receipt') {
      return {
        action: 'historical_receipt',
        backendDecisionId: claim.backendDecisionId,
      };
    }
    if (claim.action === 'blocked') {
      return claim.reason === 'unknown_state' || claim.reason === 'unknown_row'
        ? this.holdOrBlock(input, `claim_${claim.reason}`)
        : { action: 'blocked', reason: `claim_${claim.reason}` };
    }
    if (claim.action !== 'authorize_post') {
      return { action: 'blocked', reason: 'claim_unexpected' };
    }

    let verified: ExpirationIntakeReceipt | null;
    try {
      verified = normalizeExpirationIntakeReceipt(
        await this.client.submitExpirationIntake(input.intake),
        input.intake,
      );
    } catch {
      return this.holdOrBlock(input, 'post_unconfirmed');
    }
    if (verified === null) {
      return this.holdOrBlock(input, 'receipt_unverifiable');
    }
    if (!isCanonicalLowercaseUuid(verified.id)) {
      return this.holdOrBlock(input, 'noncanonical_backend_id');
    }

    let recorded: ExpirationPostDecision;
    try {
      recorded = await this.store.recordReceipt({
        senderId: input.senderId,
        sourceRequestId: input.sourceRequestId,
        intake: input.intake,
        backendDecisionId: verified.id,
      });
    } catch {
      return this.holdOrBlock(input, 'receipt_persist_unconfirmed');
    }
    if (recorded.action === 'record_receipt') {
      return { action: 'receipt_recorded', backendDecisionId: verified.id };
    }
    if (recorded.action === 'replay_receipt') {
      return { action: 'receipt_replayed', backendDecisionId: verified.id };
    }
    if (recorded.action === 'conflict') {
      return {
        action: 'blocked',
        reason: `receipt_conflict_${recorded.storedBackendDecisionId}`,
      };
    }
    if (recorded.action === 'blocked') {
      return recorded.reason === 'unknown_state' ||
        recorded.reason === 'unknown_row'
        ? this.holdOrBlock(input, `receipt_persist_${recorded.reason}`)
        : { action: 'blocked', reason: `receipt_persist_${recorded.reason}` };
    }
    return { action: 'blocked', reason: 'receipt_persist_unexpected' };
  }

  private async holdOrBlock(
    input: FrozenInput,
    reason: string,
  ): Promise<ExpirationPostOrchestrationOutcome> {
    try {
      const marked = await this.store.markUnknown(input);
      if (marked.action === 'mark_unknown') {
        return { action: 'held_unknown', reason: marked.reason };
      }
    } catch {
      // Unconfirmed conservative hold; stay honestly blocked.
    }
    return { action: 'blocked', reason };
  }
}
