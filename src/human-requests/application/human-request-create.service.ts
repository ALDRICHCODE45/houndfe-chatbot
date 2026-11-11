import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { HumanRequestsClient } from '../../chatbot-api/domain/chatbot-api.client';
import {
  isCreateHumanRequestInput,
  type CancelHumanRequestInput,
  type CreateDirectHumanRequestInput,
  type CreateHumanRequestInput,
  type HumanRequestCreated,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import {
  RETRY_AFTER_MAX_MS,
  type BackendOutboxDeliveryPort,
  type BackendOutboxDeliveryResult,
  type BackendOutboxEntry,
  type BackendOutboxKind,
} from '../../backend-outbox/domain/backend-outbox';
import {
  checkHandoffSendHold,
  type HandoffModeReader,
} from '../../conversation/application/handoff-send-hold';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import {
  ASK_TEAM_REGISTERED_REPLY,
  buildUnknownQuestionRequest,
  type UnknownQuestionInput,
} from '../domain/human-request-create';
import {
  maskConversationRef,
  senderIdFromRef,
  styleFixedCopy,
  type HumanRequestFeedStore,
} from '../domain/human-request-feed';

/** The outbox kinds this adapter delivers. */
export const HUMAN_REQUEST_OUTBOX_KINDS: readonly BackendOutboxKind[] = [
  'REQUEST_CREATE',
  'REQUEST_CANCEL',
];

export interface HumanRequestCreatePorts {
  client: Pick<
    HumanRequestsClient,
    'createHumanRequest' | 'cancelHumanRequest'
  >;
  store: Pick<HumanRequestFeedStore, 'recordOpenRequest' | 'closeRequest'>;
  outbox: Pick<BackendOutboxService, 'enqueue'>;
  sender: Pick<WhatsappSenderPort, 'sendText'>;
  /** Required, so a missing reader can never skip the HUMAN hold. */
  handoff: HandoffModeReader;
  /** 24 h window; rejects when the read fails. */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
}

export interface HumanRequestCreateOptions {
  clock?: () => Date;
  newSourceRequestId?: () => string;
}

/** What the customer is told is decided by the caller from `kind`. */
export type AskTeamOutcome =
  | { kind: 'registered'; requestId: string | null }
  | { kind: 'open_limit' }
  | { kind: 'customer_rate_limited' }
  /** Transient failure: the create is in the outbox (REQUEST_CREATE). */
  | { kind: 'queued' }
  | { kind: 'failed'; reason: string };

const CANCEL_REASONS: ReadonlySet<unknown> = new Set([
  'CUSTOMER_WITHDREW',
  'AUTO_RESOLVED',
]);

const retryAfterMs = (seconds: number | null): number | undefined =>
  seconds === null
    ? undefined
    : Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);

const retry = (
  error: string,
  seconds: number | null,
): BackendOutboxDeliveryResult => {
  const ms = retryAfterMs(seconds);
  return ms === undefined
    ? { outcome: 'RETRY', error }
    : { outcome: 'RETRY', error, retryAfterMs: ms };
};

/**
 * S6 create path (docs/human-request-feed.md): `askTeam` creates an
 * UNKNOWN_QUESTION request synchronously and queues it in the backend outbox
 * on a transient failure; `deliver` is the outbox adapter for
 * REQUEST_CREATE / REQUEST_CANCEL. A request the backend accepted is written
 * OPEN in the local registry.
 */
export class HumanRequestCreateService implements BackendOutboxDeliveryPort {
  private readonly logger = new Logger(HumanRequestCreateService.name);
  private readonly clock: () => Date;
  private readonly newSourceRequestId: () => string;

  constructor(
    private readonly ports: HumanRequestCreatePorts,
    options: HumanRequestCreateOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.newSourceRequestId = options.newSourceRequestId ?? randomUUID;
  }

  /** Never throws. */
  async askTeam(input: UnknownQuestionInput): Promise<AskTeamOutcome> {
    const request = buildUnknownQuestionRequest(input, {
      sourceRequestId: this.newSourceRequestId(),
      now: this.clock(),
    });
    if (request === null) return { kind: 'failed', reason: 'invalid_envelope' };
    let result;
    try {
      result = await this.ports.client.createHumanRequest(request);
    } catch (error) {
      this.logger.warn(
        `askTeam create failed for ${maskConversationRef(request.conversationRef)}, queueing: ${describe(error)}`,
      );
      return this.queue(request);
    }
    switch (result.kind) {
      case 'ok':
        return {
          kind: 'registered',
          requestId: await this.recordOpen(request, result.response, false),
        };
      case 'CUSTOMER_OPEN_LIMIT':
        return { kind: 'open_limit' };
      case 'CUSTOMER_RATE_LIMITED':
        return { kind: 'customer_rate_limited' };
      case 'RATE_LIMITED':
      case 'VERSION_CONFLICT':
        return this.queue(request);
      default:
        this.logger.error(
          `askTeam create for ${maskConversationRef(request.conversationRef)} refused: ${result.kind}`,
        );
        return { kind: 'failed', reason: result.kind };
    }
  }

  /** Outbox adapter. Throws (retryable) on transport failures. */
  async deliver(
    entry: BackendOutboxEntry,
  ): Promise<BackendOutboxDeliveryResult> {
    if (entry.kind === 'REQUEST_CREATE') return this.deliverCreate(entry);
    if (entry.kind === 'REQUEST_CANCEL') return this.deliverCancel(entry);
    return { outcome: 'RETRY', error: `kind ${entry.kind} not handled here` };
  }

  private async queue(
    request: CreateDirectHumanRequestInput,
  ): Promise<AskTeamOutcome> {
    try {
      await this.ports.outbox.enqueue({
        conversationRef: request.conversationRef,
        kind: 'REQUEST_CREATE',
        idempotencyKey: request.sourceRequestId,
        // SAFETY: the envelope is a plain JSON object (strings, arrays and
        // nested objects only), which is what the outbox payload stores.
        payload: request as unknown as Record<string, unknown>,
      });
      return { kind: 'queued' };
    } catch (error) {
      this.logger.error(
        `askTeam queue failed for ${maskConversationRef(request.conversationRef)}: ${describe(error)}`,
      );
      return { kind: 'failed', reason: 'queue_failed' };
    }
  }

  /** The registry row; a local write failure only logs unless `strict`. */
  private async recordOpen(
    request: CreateHumanRequestInput,
    response: HumanRequestCreated,
    strict: boolean,
  ): Promise<string | null> {
    const requestId = response.mergedIntoId ?? response.id;
    if (requestId === null || request.conversationRef === undefined)
      return requestId;
    try {
      await this.ports.store.recordOpenRequest({
        requestId,
        conversationRef: request.conversationRef,
        subtype: request.subtype,
        legacyId: null,
      });
    } catch (error) {
      if (strict) throw error;
      this.logger.warn(
        `request ${requestId} created but its registry row failed: ${describe(error)}`,
      );
    }
    return requestId;
  }

  private async deliverCreate(
    entry: BackendOutboxEntry,
  ): Promise<BackendOutboxDeliveryResult> {
    const request: unknown = entry.payload;
    if (!isCreateHumanRequestInput(request))
      return { outcome: 'PERMANENT', error: 'invalid payload' };
    const result = await this.ports.client.createHumanRequest(request);
    switch (result.kind) {
      case 'ok':
        // A registry failure throws: the replay answers REPLAYED.
        await this.recordOpen(request, result.response, true);
        await this.confirmQueued(request.conversationRef ?? null);
        return { outcome: 'DELIVERED' };
      case 'RATE_LIMITED':
      case 'CUSTOMER_RATE_LIMITED':
        return retry(result.kind, result.retryAfterSeconds);
      case 'VERSION_CONFLICT':
        return retry(result.kind, null);
      default:
        this.logger.error(
          `queued create ${entry.idempotencyKey} refused: ${result.kind}`,
        );
        return { outcome: 'PERMANENT', error: result.kind };
    }
  }

  private async deliverCancel(
    entry: BackendOutboxEntry,
  ): Promise<BackendOutboxDeliveryResult> {
    const { requestId, reason, triggerWaMessageId } = entry.payload;
    if (
      typeof requestId !== 'string' ||
      requestId === '' ||
      !CANCEL_REASONS.has(reason) ||
      typeof triggerWaMessageId !== 'string' ||
      triggerWaMessageId === ''
    )
      return { outcome: 'PERMANENT', error: 'invalid payload' };
    const input: CancelHumanRequestInput = {
      reason: reason as CancelHumanRequestInput['reason'],
      triggerWaMessageId,
    };
    const result = await this.ports.client.cancelHumanRequest(
      requestId,
      input,
      entry.idempotencyKey,
    );
    switch (result.kind) {
      case 'ok':
        await this.ports.store.closeRequest(requestId, 'CANCELLED');
        return { outcome: 'DELIVERED' };
      case 'ALREADY_RESOLVED':
        // The backend already holds a final answer for it.
        await this.ports.store.closeRequest(requestId, 'RESOLVED');
        return { outcome: 'DELIVERED' };
      case 'RATE_LIMITED':
        return retry(result.kind, result.retryAfterSeconds);
      default:
        this.logger.error(
          `queued cancel ${entry.idempotencyKey} refused: ${result.kind}`,
        );
        return { outcome: 'PERMANENT', error: result.kind };
    }
  }

  /** One confirmation for a create that left the outbox, only in an open
   *  window and outside a HUMAN session; otherwise skipped silently. Never
   *  throws. */
  private async confirmQueued(conversationRef: string | null): Promise<void> {
    const senderId = senderIdFromRef(conversationRef);
    if (senderId === null) return;
    try {
      const hold = await checkHandoffSendHold(this.ports.handoff, senderId);
      if (hold.hold) return;
      if (!(await this.ports.isWindowOpen(senderId))) return;
      const style = await this.readStyle(senderId);
      await this.ports.sender.sendText({
        to: senderId,
        text: styleFixedCopy(ASK_TEAM_REGISTERED_REPLY, style),
      });
    } catch (error) {
      this.logger.warn(
        `queued create confirmation skipped for ${maskConversationRef(conversationRef)}: ${describe(error)}`,
      );
    }
  }

  private async readStyle(senderId: string): Promise<CustomerStyle | null> {
    if (this.ports.customerStyle === undefined) return null;
    try {
      return await this.ports.customerStyle(senderId);
    } catch {
      return null;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
