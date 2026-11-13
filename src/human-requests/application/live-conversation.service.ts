import { Logger } from '@nestjs/common';
import type {
  ConversationEndedItem,
  ConversationReassignedItem,
  ConversationStaffMessageItem,
  ConversationStartedItem,
  TemplateRequestedItem,
} from '../../chatbot-api/domain/dtos/human-requests.dto';
import type {
  SessionAckInput,
  SessionAckResult,
} from '../../chatbot-api/domain/dtos/live-conversation.dto';
import type { LiveConversationClient } from '../../chatbot-api/domain/live-conversation.port';
import type { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import type { CustomerStyle } from '../../customer-profile/domain/notice-style';
import type {
  OutboundMediaFile,
  SendResult,
  WhatsappSenderPort,
} from '../../whatsapp/domain/whatsapp-sender.port';
import { describeError } from '../../common/log-safe';
import {
  LIVE_FAREWELL,
  LIVE_GREETING,
  LIVE_GREETING_NO_NAME,
  LIVE_REASSIGNED,
  LIVE_REASSIGNED_NO_NAME,
  LIVE_RESUME,
  liveNotice,
  maskConversationRef,
  messageIdOf,
  senderIdFromRef,
  styleFixedCopy,
  type DeliveryDecision,
  type DeliveryRow,
} from '../domain/human-request-feed';

/** The three lifecycle items (notices sent as BOT messages). */
export type ConversationLifecycleItem =
  | ConversationStartedItem
  | ConversationReassignedItem
  | ConversationEndedItem;

/** The two relay items (a person's words, never the bot's). */
export type ConversationRelayItem =
  | ConversationStaffMessageItem
  | TemplateRequestedItem;

/** Every live item this service plans. */
export type LiveItem = ConversationLifecycleItem | ConversationRelayItem;

/** What happened to the notice, reported to `LivePlan.after` once the
 *  delivery outcome is durably recorded. */
export interface LiveSendResult {
  kind: 'ACCEPTED' | 'UNKNOWN' | 'NOT_SENT';
  providerMessageId: string | null;
}

interface LivePlanBase {
  decision: DeliveryDecision;
  /** Runs after the outcome is recorded (never before the notice). Failures
   *  are logged by the caller, never retried through the feed. */
  after?: (result: LiveSendResult) => Promise<void>;
  /** Replay the conversation's held / deferred deliveries after `after`. */
  replay?: boolean;
}

/** The delivery service executes the plan: notices are BOT messages, never
 *  held by HUMAN mode and never deferred (a closed window is STALE). A
 *  relay (staff message / template) is sent by `deliver` (origin STAFF /
 *  TEMPLATE, so the sender never mirrors it), never held by HUMAN mode. */
export type LivePlan =
  | ({ action: 'stale' } & LivePlanBase)
  | ({ action: 'send'; senderId: string; text: string } & LivePlanBase)
  | ({
      action: 'relay';
      senderId: string;
      /** Performs the Meta send(s). Rejects with the sender's error; the
       *  delivery service classifies it (`classifyRelaySendError`). */
      deliver: () => Promise<SendResult>;
      /** Runs once the attempt is over, whatever happened (temp file
       *  cleanup). Never throws into the caller. */
      dispose?: () => Promise<void>;
      /** A closed window defers the delivery (staff messages only; a
       *  template is never DEFERRED). */
      deferrable: boolean;
    } & LivePlanBase);

export interface LiveConversationHandler {
  plan(row: DeliveryRow, item: LiveItem): Promise<LivePlan>;
}

export interface LiveConversationPorts {
  mode: Pick<
    HandoffModeService,
    'getState' | 'applyStarted' | 'applyEnded' | 'markGreeted'
  >;
  client: Pick<LiveConversationClient, 'sessionAck' | 'downloadStaffMedia'>;
  /** Staff relays: text, uploaded media files and templates. */
  sender: Pick<
    WhatsappSenderPort,
    'sendText' | 'sendTemplate' | 'sendMediaFile'
  >;
  /** Rejects when the read fails (transient, never "closed"). */
  isWindowOpen(senderId: string): Promise<boolean>;
  /** Stored customer style; null/failure keeps the usted copy. */
  customerStyle?(senderId: string): Promise<CustomerStyle | null>;
}

/**
 * Silence protocol, bot side (live conversation T4/T5, contract rules 1, 4,
 * 6, 7 and the reassignment notice): started / reassigned / ended items and
 * the staff relays (staff_message, template.requested).
 *
 * The inline, pre-send steps (durable mode compare-and-set, session-ack
 * STARTED, the window check) happen in `plan`, so a throw leaves the ledger
 * row RECEIVED and the feed retries the item (every step is idempotent: a
 * repeated CAS is a DUPLICATE, a repeated ack is a 200). The send, its
 * outcome and its ledger states are the delivery service's.
 */
export class LiveConversationService implements LiveConversationHandler {
  private readonly logger = new Logger(LiveConversationService.name);

  constructor(private readonly ports: LiveConversationPorts) {}

  async plan(row: DeliveryRow, item: LiveItem): Promise<LivePlan> {
    const senderId = senderIdFromRef(row.conversationRef);
    if (senderId === null || row.conversationRef === null) {
      this.logger.warn(
        `feed item ${row.deliveryId} (${item.type}) has no usable conversationRef: STALE`,
      );
      return { action: 'stale', decision: 'NO_CONVERSATION' };
    }
    switch (item.type) {
      case 'conversation.started':
        return this.started(row.conversationRef, senderId, item);
      case 'conversation.reassigned':
        return this.reassigned(senderId, item);
      case 'conversation.ended':
        return this.ended(row.conversationRef, senderId, item);
      case 'conversation.staff_message':
      case 'template.requested':
        return this.relay(row, senderId, item);
    }
  }

  // -------------------------------------------------------------- relay

  /**
   * Staff message / template (rules 4 and 10). Sent only while the
   * conversation is HUMAN on the item's epoch; an epoch or session mismatch
   * is the only STALE (rule 10: never for a conversation actually muted on
   * that epoch). An unreadable mode throws, so the item is retried. A closed
   * window is not read locally: Meta's verdict (131047) is the truth.
   */
  private async relay(
    row: DeliveryRow,
    senderId: string,
    item: ConversationRelayItem,
  ): Promise<LivePlan> {
    // Dedupe by messageId (stored before any Meta call): a row that should
    // carry one but does not lost the race to another delivery. It is
    // ACKed, never sent, on the first insert and on every replay.
    if (messageIdOf(item) !== null && row.messageId === null) {
      this.logger.log(
        `${item.type} ${item.deliveryId} repeats a messageId another delivery owns: STALE, not sent`,
      );
      return { action: 'stale', decision: 'DUPLICATE' };
    }
    const state = await this.ports.mode.getState(senderId);
    if (state.epoch !== item.payload.handoffEpoch)
      return { action: 'stale', decision: 'STALE_EPOCH' };
    if (state.mode !== 'HUMAN')
      return { action: 'stale', decision: 'SESSION_NOT_ACTIVE' };

    if (item.type === 'template.requested') {
      const { templateName, languageCode } = item.payload;
      return {
        action: 'relay',
        decision: 'TEMPLATE_SENT',
        senderId,
        deferrable: false,
        deliver: () =>
          this.ports.sender.sendTemplate({
            to: senderId,
            templateName,
            languageCode,
            bodyParameters: [],
            origin: 'TEMPLATE',
          }),
      };
    }

    const message = item.payload;
    if (message.type === 'TEXT')
      return {
        action: 'relay',
        decision: 'STAFF_MESSAGE',
        senderId,
        deferrable: true,
        deliver: () =>
          this.ports.sender.sendText({
            to: senderId,
            text: message.text,
            origin: 'STAFF',
          }),
      };

    // IMAGE / DOCUMENT: fetch the bytes before anything is claimed. A
    // transient failure throws (the item stays RECEIVED and is retried).
    const media = await this.ports.client.downloadStaffMedia(message.mediaId);
    switch (media.kind) {
      case 'MEDIA_NOT_FOUND':
        return { action: 'stale', decision: 'MEDIA_NOT_FOUND' };
      case 'MEDIA_TOO_LARGE':
        this.logger.warn(
          `${item.type} ${item.deliveryId} media is over the size cap: STALE, not sent`,
        );
        return { action: 'stale', decision: 'SEND_REFUSED' };
      case 'ok':
        break;
      default:
        throw new Error(`staff media download failed: ${media.kind}`);
    }
    const sendMediaFile = this.ports.sender.sendMediaFile?.bind(
      this.ports.sender,
    );
    if (sendMediaFile === undefined) {
      // A text-only sender adapter: nothing can be uploaded, definite non-send.
      await media.cleanup();
      this.logger.warn(
        `${item.type} ${item.deliveryId} needs a media upload the sender cannot do: STALE, not sent`,
      );
      return { action: 'stale', decision: 'SEND_REFUSED' };
    }
    // Meta image messages accept only JPEG/PNG: anything else (webp, or a
    // DOCUMENT that is not a PDF) goes as a document.
    const asDocument =
      (message.type === 'DOCUMENT' && media.mimeType !== 'application/pdf') ||
      (media.mimeType !== 'image/jpeg' &&
        media.mimeType !== 'image/png' &&
        media.mimeType !== 'application/pdf');
    const file: OutboundMediaFile & { asDocument?: true } = {
      to: senderId,
      filePath: media.filePath,
      mimeType: media.mimeType,
      filename: message.filename,
      ...(message.caption === null ? {} : { caption: message.caption }),
      ...(asDocument ? { asDocument: true as const } : {}),
      origin: 'STAFF',
    };
    return {
      action: 'relay',
      decision: 'STAFF_MESSAGE',
      senderId,
      deferrable: true,
      deliver: () => sendMediaFile(file),
      dispose: () => media.cleanup(),
    };
  }

  // ------------------------------------------------------------ started

  private async started(
    ref: string,
    senderId: string,
    item: ConversationStartedItem,
  ): Promise<LivePlan> {
    const { handoffEpoch: epoch, requestId, staffFirstName } = item.payload;
    // 1. One durable compare-and-set to HUMAN, BEFORE the ack.
    const applied = await this.ports.mode.applyStarted(
      senderId,
      epoch,
      requestId,
    );
    if (!applied.applied) {
      if (applied.reason === 'INVALID')
        throw new Error('handoff state unusable: corrupt value or bad order');
      if (applied.reason === 'STALE_EPOCH') {
        this.logger.log(
          `conversation.started ${item.deliveryId} epoch ${epoch} is not newer than ours (${maskConversationRef(ref)}): STALE, no ack`,
        );
        return { action: 'stale', decision: 'STALE_EPOCH' };
      }
      // DUPLICATE: an earlier attempt of this same item already muted us
      // and then failed before deciding it; carry on with the ack.
    }

    // 2. Inline session-ack STARTED (never waits for Meta).
    const ack = await this.ports.client.sessionAck(ref, {
      epoch,
      state: 'STARTED',
    });
    if (ack.kind !== 'ok') {
      if (
        ack.kind === 'STALE_EPOCH' ||
        ack.kind === 'SESSION_NOT_ENDING' ||
        ack.kind === 'NOT_FOUND'
      ) {
        // A reconcile signal, never a retry: no greeting.
        this.logger.warn(
          `session-ack STARTED epoch ${epoch} answered ${ack.kind} (${maskConversationRef(ref)}): no greeting, STALE; reconcile decides`,
        );
        return { action: 'stale', decision: 'STALE_EPOCH' };
      }
      // Retryable (5xx, 429, timeout, network) or a credential problem: the
      // item is retried later, nothing is sent and nothing is ACKed yet.
      throw new Error(`session-ack STARTED failed: ${ack.kind}`);
    }

    // 3. Only after the 200: the greeting, if the window is open.
    if (!(await this.ports.isWindowOpen(senderId)))
      return { action: 'stale', decision: 'SESSION_STARTED' };
    const style = await this.readStyle(senderId);
    return {
      action: 'send',
      decision: 'SESSION_STARTED',
      senderId,
      text: liveNotice(
        LIVE_GREETING,
        LIVE_GREETING_NO_NAME,
        staffFirstName,
        style,
      ),
      // A greeting that really went out is what a START_TIMEOUT resume
      // notice depends on (an uncertain one does not count).
      after: async (result) => {
        if (result.kind === 'ACCEPTED')
          await this.ports.mode.markGreeted(senderId, epoch);
      },
    };
  }

  // --------------------------------------------------------- reassigned

  private async reassigned(
    senderId: string,
    item: ConversationReassignedItem,
  ): Promise<LivePlan> {
    const { handoffEpoch: epoch, staffFirstName } = item.payload;
    const state = await this.ports.mode.getState(senderId);
    if (state.epoch !== epoch)
      return { action: 'stale', decision: 'STALE_EPOCH' };
    if (state.mode !== 'HUMAN')
      return { action: 'stale', decision: 'SESSION_NOT_ACTIVE' };
    if (!(await this.ports.isWindowOpen(senderId)))
      return { action: 'stale', decision: 'WINDOW_CLOSED' };
    const style = await this.readStyle(senderId);
    return {
      action: 'send',
      decision: 'REASSIGNED_NOTICE',
      senderId,
      text: liveNotice(
        LIVE_REASSIGNED,
        LIVE_REASSIGNED_NO_NAME,
        staffFirstName,
        style,
      ),
    };
  }

  // -------------------------------------------------------------- ended

  private async ended(
    ref: string,
    senderId: string,
    item: ConversationEndedItem,
  ): Promise<LivePlan> {
    const {
      handoffEpoch: epoch,
      reason,
      farewell,
      resumeNotice,
    } = item.payload;
    // 1. Durable BOT (the epoch is kept) BEFORE anything is sent.
    const applied = await this.ports.mode.applyEnded(senderId, epoch);
    if (!applied.applied) {
      if (applied.reason === 'INVALID')
        throw new Error('handoff state unusable: corrupt value or bad order');
      if (applied.reason === 'STALE_EPOCH') {
        this.logger.log(
          `conversation.ended ${item.deliveryId} epoch ${epoch} is older than ours (${maskConversationRef(ref)}): STALE, no ack`,
        );
        return { action: 'stale', decision: 'STALE_EPOCH' };
      }
      // DUPLICATE: already BOT at this epoch (a retry of this item).
    }

    if (reason === 'START_TIMEOUT') {
      // A revert, not an end: no session-ack. The resume notice only
      // follows a greeting that actually went out for this epoch.
      if (resumeNotice) {
        const state = await this.ports.mode.getState(senderId);
        if (
          state.greetedEpoch === epoch &&
          (await this.ports.isWindowOpen(senderId))
        ) {
          const style = await this.readStyle(senderId);
          return {
            action: 'send',
            decision: 'RESUME_NOTICE',
            senderId,
            text: styleFixedCopy(LIVE_RESUME, style),
            replay: true,
          };
        }
      }
      return { action: 'stale', decision: 'SESSION_REVERTED', replay: true };
    }

    // The ack comes after the outcome; the replay after the ack, so the
    // farewell always precedes any replayed delivery.
    const after = (result: LiveSendResult) =>
      this.ackEnded(ref, epoch, result.providerMessageId);
    if (farewell && (await this.ports.isWindowOpen(senderId))) {
      const style = await this.readStyle(senderId);
      return {
        action: 'send',
        decision: 'FAREWELL',
        senderId,
        text: styleFixedCopy(LIVE_FAREWELL, style),
        after,
        replay: true,
      };
    }
    return {
      action: 'stale',
      decision: 'SESSION_ENDED',
      after,
      replay: true,
    };
  }

  /** session-ack ENDED, best effort: a 409 is a reconcile signal and a
   *  failure is not retried (the backend marks the session ENDED itself
   *  after its own timeout). Never throws. */
  private async ackEnded(
    ref: string,
    epoch: number,
    providerMessageId: string | null,
  ): Promise<void> {
    const input: SessionAckInput = {
      epoch,
      state: 'ENDED',
      ...(providerMessageId === null ? {} : { providerMessageId }),
    };
    let result: SessionAckResult;
    try {
      result = await this.ports.client.sessionAck(ref, input);
    } catch (error) {
      this.logger.warn(
        `session-ack ENDED epoch ${epoch} failed (${maskConversationRef(ref)}), not retried: ${describeError(error)}`,
      );
      return;
    }
    if (result.kind === 'ok') return;
    if (
      result.kind === 'STALE_EPOCH' ||
      result.kind === 'SESSION_NOT_ENDING' ||
      result.kind === 'NOT_FOUND'
    )
      this.logger.warn(
        `session-ack ENDED epoch ${epoch} answered ${result.kind} (${maskConversationRef(ref)}): reconcile signal, not retried`,
      );
    else
      this.logger.warn(
        `session-ack ENDED epoch ${epoch} failed with ${result.kind} (${maskConversationRef(ref)}), not retried`,
      );
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
