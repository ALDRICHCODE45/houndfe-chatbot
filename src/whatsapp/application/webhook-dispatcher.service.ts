import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  CONVERSATION_STORE,
  readPendingHumanRequest,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import type { AgentMessage } from '../../conversation/domain/conversation-store';
import {
  ReceiptIngressService,
  type ReceiptIngressDecision,
} from '../../receipt-media/application/receipt-ingress.service';
import {
  HumanHandoffService,
  PENDING_HUMAN_REQUEST_REPLY,
} from '../../human-handoff/application/human-handoff.service';
import { HUMAN_HANDOFF_SERVICE_TOKEN } from '../../sale-flow/infrastructure/real-tool-registry';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
import { MinimalCatalogAgentService } from '../../llm-agent/application/minimal-catalog-agent.service';
import { readPlacedOrder } from '../../receipt-media/domain/placed-order';
import {
  DEFAULT_CUSTOMER_STYLE,
  applyCustomerStyle,
  type CustomerStyle,
} from '../../llm-agent/domain/customer-style';
import {
  interactiveReplyText,
  type CustomerReply,
  type CustomerReplyMedia,
} from '../../llm-agent/domain/customer-reply';
import { ProductImageRecognitionService } from '../../product-image/application/product-image-recognition.service';
import {
  buildProductImageTurnText,
  isIdentifiableProduct,
  looksLikeProductQuestion,
  PRODUCT_IMAGE_UNAVAILABLE_REPLY,
  PRODUCT_IMAGE_UNCLEAR_REPLY,
  RECEIPT_IMAGE_WITHOUT_ORDER_REPLY,
  type ProductImageRecognition,
} from '../../product-image/domain/product-image';
import { TranscriptRecorder } from '../../conversation-transcript/application/transcript-recorder';
import { BackendOutboxService } from '../../backend-outbox/application/backend-outbox.service';
import { conversationRefFor } from '../../backend-outbox/domain/backend-outbox';
import { HandoffModeService } from '../../conversation/application/handoff-mode.service';
import { checkHandoffSendHold } from '../../conversation/application/handoff-send-hold';
import { maskConversationRef } from '../../human-requests/domain/human-request-feed';
import { HumanRequestDeliveryService } from '../../human-requests/application/human-request-delivery.service';
import { normalizeMetaStatuses } from './meta-status-normalizer';
import { InboundMessage, InboundMedia } from '../domain/inbound-message';
import { WHATSAPP_SENDER } from '../domain/whatsapp-sender.port';
import type { WhatsappSenderPort } from '../domain/whatsapp-sender.port';
import { RECENT_OUTBOUND } from '../domain/recent-outbound.store';
import type { RecentOutboundStore } from '../domain/recent-outbound.store';
import { WEBHOOK_DEDUP } from '../domain/webhook-dedup.store';
import type { WebhookDedupStore } from '../domain/webhook-dedup.store';
import {
  WebhookEventDto,
  WebhookMessageDto,
} from '../presentation/dto/webhook-event.dto';

/**
 * WebhookDispatcherService (agent + human-handoff router)
 *
 * Inbound-driven dispatch order (each step is conditional on the prior):
 *
 *   1. RECENT_OUTBOUND — skip echoes of the bot's own outbound.
 *   2. WEBHOOK_DEDUP   — S6: claim the message (PROCESSING + lease) before
 *      processing; a DONE message is a duplicate. A live claim held by another
 *      delivery throws (no 200: Meta retries). A failure releases the claim
 *      so Meta's redelivery is processed again.
 *   3. **Ops pre-routing hook** (new, human-handoff slice) —
 *      when `message.senderId` matches the configured OPS_CHANNEL_PHONE
 *      (exact by default; both sides apply the same trunk-1 rewrite only
 *      when `META_SANDBOX_RECIPIENT_NORMALIZATION=true`, per ADR-22), the inbound
 *      is an ops reply to a previous escalation, NOT a customer message:
 *        - `humanHandoff.resolveReply({ text, from })` parses the agent's
 *          decision (or `HF-<id>` token, or newest-pending fallback) and
 *          resolves the durable row + clears the customer's marker.
 *        - `{ kind: 'resolved', customerId, syntheticUserText, ... }` →
 *          when the customer is in HUMAN mode (or the mode is unreadable)
 *          nothing is run or sent, the ops message is only marked seen
 *          (S7); otherwise inject the synthetic user turn into
 *          `AgentRunner.handle` with `senderId = customerId` (NOT the ops phone) so the customer's
 *          resume gets the right transcript context. The runner's reply
 *          is then sent to the customer (NOT the ops phone).
 *        - `{ kind: 'no_pending', reply }` → reply to the ops phone with
 *          the ASK_FOR_REF message.
 *        - The hook `continue`s past the pending-marker short-circuit +
 *          customer runner path.
 *   3b. **S7 handoff gate** — when the customer conversation is in HUMAN
 *      mode (`data.handoff`), nothing below runs: no profile warm-up, no
 *      canned reply, no receipt ingress, no vision, no agent, no send. The
 *      inbound was already recorded in step 1b (so T3 mirrors it to the
 *      backend outbox, receipt images/documents included); it is only
 *      marked seen. An unreadable mode throws (fail closed: Meta
 *      redelivers, the bot never speaks while the mode is unknown).
 *   4. **Pending-marker short-circuit** (new, ADR-29 defense-in-depth) —
 *      when the customer's `data.pendingHumanRequest` is set, send the
 *      canned `PENDING_HUMAN_REQUEST_REPLY` (in the customer's style) and
 *      `continue`. No LLM call.
 *   4b. **Customer media** — documents (PDF) always go to receipt ingress.
 *      An image goes to receipt ingress only when an order awaits payment
 *      (`minimalCart.placedSale`) and the caption is not a product question;
 *      otherwise it is a product photo (S5): download + vision describer,
 *      then a synthetic agent turn (caption + compact description), a
 *      label-photo request, a product-name request, or — for a receipt with
 *      no order — a customer reply asking for the product first.
 *   5. `MinimalCatalogAgentService.tryHandle({ senderId, text })` — every
 *      customer turn runs through the minimal SDK route (no sender
 *      allowlist, no legacy fallback). `AgentRunner` is used only for the
 *      ops synthetic "resolved" turn in step 3.
 *   6. WhatsappSenderPort.sendText — send the reply. S7: the mode is
 *      re-checked first; a switch to HUMAN mid-turn drops the reply (still
 *      marked seen). S3: any product photo goes first via the optional
 *      sendImage (an image failure only warns). S4:
 *      a reply with buttons/list goes out through the optional
 *      sendInteractive; when absent or failing, the same text is sent.
 *   7. RECENT_OUTBOUND.remember + WEBHOOK_DEDUP.markSeen (claim → DONE) —
 *      only after the message was handled; a failed send releases the claim
 *      so Meta re-delivers and retries.
 *
 * Spec: `openspec/changes/human-handoff/specs/whatsapp-webhook/delta.md`.
 * Test: `webhook-dispatcher.service.spec.ts`.
 */
@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly agentRunner: AgentRunner,
    @Inject(WHATSAPP_SENDER)
    private readonly whatsappSender: WhatsappSenderPort,
    @Inject(WEBHOOK_DEDUP)
    private readonly dedup: WebhookDedupStore,
    @Inject(RECENT_OUTBOUND)
    private readonly recentOutbound: RecentOutboundStore,
    @Inject(HUMAN_HANDOFF_SERVICE_TOKEN)
    private readonly humanHandoff: HumanHandoffService,
    @Inject(CONVERSATION_STORE)
    private readonly conversationStore: ConversationStore,
    private readonly ingress: ReceiptIngressService,
    // Handles every customer turn; AgentRunner only serves the ops synthetic
    // "resolved" turn above.
    private readonly minimalCatalogAgent: MinimalCatalogAgentService,
    // S5 product photos. Optional only so hand-built harnesses keep
    // compiling; without it a product photo gets the product-name request.
    @Optional()
    private readonly productImage?: ProductImageRecognitionService,
    // S1 durable transcript. Optional so hand-built harnesses keep compiling.
    // Explicit token: a `Pick<>` type would emit `Object` as DI metadata.
    @Optional()
    @Inject(TranscriptRecorder)
    private readonly transcript?: Pick<TranscriptRecorder, 'recordInbound'>,
    // S3 Meta statuses go to the backend outbox. Optional for harnesses.
    @Optional()
    @Inject(BackendOutboxService)
    private readonly outbox?: Pick<BackendOutboxService, 'enqueue'>,
    // S7 handoff gate. Required by DI (no @Optional: the runtime graph must
    // never silently lose the gate); optional in TS only for harnesses.
    @Inject(HandoffModeService)
    private readonly handoffMode?: Pick<HandoffModeService, 'isHumanMode'>,
    // S5 pending deliveries (window / HUMAN replay). Optional for harnesses.
    @Optional()
    @Inject(HumanRequestDeliveryService)
    private readonly humanRequestDelivery?: Pick<
      HumanRequestDeliveryService,
      'onCustomerInbound'
    >,
  ) {}

  async dispatch(event: WebhookEventDto): Promise<void> {
    // ─── (0) S3 statuses → outbox; never the agent or a reply ─────────
    await this.enqueueStatuses(event);

    const messages = normalizeInboundMessages(event);
    const rawTypes = rawMessageTypes(event);

    for (const message of messages) {
      // ─── (1) Echo filter ────────────────────────────────────────────
      if (this.recentOutbound.isKnown(message.messageId)) {
        this.logger.log(
          `skip echo ${message.messageId} from ${maskConversationRef(message.senderId)}`,
        );
        continue;
      }

      // ─── (1b) S1 durable transcript ────────────────────────────────
      // Before dedup: append is idempotent on the wamid, so a re-delivery
      // after a crash still lands in the transcript. A failed write throws
      // before any claim or reply, so Meta redelivers the message.
      await this.recordInbound(message, rawTypes.get(message.messageId));

      // ─── (2) Dedup claim (S6) ───────────────────────────────────────
      // Atomic: of two concurrent deliveries only one gets a token; null
      // means DONE. A claim failure, or a live claim held by another
      // delivery (WebhookClaimInFlightError), propagates before any
      // processing with nothing to release, so Meta redelivers.
      const claimToken = await this.dedup.claim(message.messageId);
      if (claimToken === null) {
        this.logger.log(
          `skip duplicate ${message.messageId} from ${maskConversationRef(message.senderId)}`,
        );
        continue;
      }

      this.logger.log(
        `process ${message.messageId} from ${maskConversationRef(message.senderId)} (${message.text.length} chars)`,
      );

      try {
        // ─── (3) Ops pre-routing hook (ADR-22) ─────────────────────────
        // Inbound from the ops phone is an agent reply to a previous
        // escalation, NOT a customer message. Route to
        // `humanHandoff.resolveReply` BEFORE the customer runner path so
        // we never LLM-process an ops message.
        if (this.humanHandoff.isOpsSender(message.senderId)) {
          const result = await this.humanHandoff.resolveReply({
            text: message.text,
            from: message.senderId,
          });

          if (result.kind === 'resolved') {
            // S7: a customer in HUMAN mode gets no bot turn (no LLM, no
            // send). An unreadable mode holds too: the request is already
            // resolved, so a redelivery could not resume it anyway.
            const hold = await checkHandoffSendHold(
              this.handoffMode,
              result.customerId,
            );
            if (hold.hold) {
              if (hold.reason === 'HUMAN')
                this.logger.log(
                  `handoff HUMAN: skip resume turn for ${maskConversationRef(result.customerId)} (ops ${message.messageId})`,
                );
              else
                this.logger.warn(
                  `handoff mode unreadable: skip resume turn for ${maskConversationRef(result.customerId)} (ops ${message.messageId}): ${hold.error}`,
                );
              await this.markSeenSafely(message.messageId);
              continue;
            }
            // Synthetic-turn injection through the runner. The marker
            // was cleared by `resolveReply` so the runner's gate
            // (ADR-29) does NOT suppress this turn; the customer resumes
            // normally and the runner's reply is sent to the customer
            // (NOT the ops phone).
            const { reply } = await this.agentRunner.handle({
              senderId: result.customerId,
              text: result.syntheticUserText,
            });
            const { providerMessageId } = await this.whatsappSender.sendText({
              to: result.customerId,
              text: reply,
            });
            this.recentOutbound.remember(providerMessageId);
          } else {
            // `no_pending` → reply to the ops phone asking for a ref.
            const { providerMessageId } = await this.whatsappSender.sendText({
              to: message.senderId,
              text: result.reply,
            });
            this.recentOutbound.remember(providerMessageId);
          }

          try {
            await this.dedup.markSeen(message.messageId);
          } catch (error) {
            this.logger.warn(
              `markSeen failed for ${message.messageId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          continue;
        }

        // ─── (3b) S7 handoff gate: HUMAN mode never reaches the bot ────
        if (await this.isHumanMode(message.senderId)) {
          this.logger.debug(
            `handoff HUMAN: mirror-only ${message.messageId} from ${maskConversationRef(message.senderId)}`,
          );
          await this.markSeenSafely(message.messageId);
          continue;
        }

        // S1: load the stored profile so every reply below (pending
        // marker, media, the turn) already uses the customer's stored style.
        await this.prepareCustomer(message.senderId);
        // S5: replay pending/held team deliveries; never awaited.
        this.notifyHumanRequests(message.senderId);

        // ─── (4) Pending-marker short-circuit (ADR-29 defense-in-depth)
        // The runner has the same gate; this branch keeps the dispatcher
        // consistent even if a caller bypasses the runner.
        const custState = await this.conversationStore.get(message.senderId);
        if (readPendingHumanRequest(custState) !== null) {
          this.logger.log(
            `short-circuit pending-marker for ${message.messageId} from ${maskConversationRef(message.senderId)}`,
          );
          const { providerMessageId } = await this.whatsappSender.sendText({
            to: message.senderId,
            text: applyCustomerStyle(
              PENDING_HUMAN_REQUEST_REPLY,
              this.customerStyle(message),
            ),
          });
          this.recentOutbound.remember(providerMessageId);
          try {
            await this.dedup.markSeen(message.messageId);
          } catch (error) {
            this.logger.warn(
              `markSeen failed for ${message.messageId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          continue;
        }

        // ─── WU13-B2 / S5: customer media ───────────────────────────────
        if (message.media != null) {
          const media = message.media;
          const awaitingPayment = readPlacedOrder(custState) !== null;
          const receiptFirst =
            media.kind === 'document' ||
            (awaitingPayment && !looksLikeProductQuestion(media.caption));
          if (receiptFirst) {
            await this.admitReceipt(message, media);
            continue;
          }

          const recognition = await this.recognizeProductImage(media);
          if (recognition.kind === 'receipt' && awaitingPayment) {
            await this.admitReceipt(message, media);
            continue;
          }
          if (
            recognition.kind !== 'unavailable' &&
            isIdentifiableProduct(recognition)
          ) {
            // The synthetic text is the customer's user turn in history;
            // the image bytes never reach the agent.
            await this.runCustomerTurn(
              message,
              buildProductImageTurnText(media.caption, recognition),
            );
            continue;
          }
          await this.replyAndMarkSeen(
            message,
            applyCustomerStyle(
              productImageFallbackReply(recognition),
              this.customerStyle(message),
            ),
          );
          continue;
        }

        // ─── (5) Minimal catalog agent dispatch ────────────────────────
        await this.runCustomerTurn(message, message.text);
      } catch (error) {
        this.logger.error(
          `failed to process ${message.messageId} from ${maskConversationRef(message.senderId)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.releaseSafely(message.messageId, claimToken);
        throw error;
      }
    }
  }

  /**
   * S3: one MESSAGE_STATUS row per (wamid, status); a re-delivery is an
   * outbox no-op. Ops-phone statuses are skipped like ops inbounds. Never
   * throws: a failed enqueue only warns so the messages still get a reply.
   */
  private async enqueueStatuses(event: WebhookEventDto): Promise<void> {
    if (this.outbox === undefined) return;
    const { statuses, ignored } = normalizeMetaStatuses(event);
    for (const item of ignored)
      this.logger.debug(
        `ignore Meta status ${String(item.status)} for ${
          item.providerMessageId ?? '?'
        } (${item.reason})`,
      );
    for (const update of statuses) {
      try {
        if (this.humanHandoff.isOpsSender(update.recipientWaId)) continue;
        await this.outbox.enqueue({
          conversationRef: conversationRefFor(update.recipientWaId),
          kind: 'MESSAGE_STATUS',
          idempotencyKey: `status:${update.providerMessageId}:${update.status}`,
          payload: {
            providerMessageId: update.providerMessageId,
            status: update.status,
            occurredAt: update.occurredAt,
            ...(update.errorCode === undefined
              ? {}
              : { errorCode: update.errorCode }),
          },
        });
      } catch (error) {
        this.logger.warn(
          `status enqueue failed for ${update.providerMessageId} ${
            update.status
          }: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** S7: false without a wired service (harnesses); read errors propagate. */
  private async isHumanMode(senderId: string): Promise<boolean> {
    if (this.handoffMode === undefined) return false;
    return this.handoffMode.isHumanMode(senderId);
  }

  /** S1: customer inbounds only (never the ops phone). A store failure
   * propagates: the webhook fails and Meta redelivers, so a customer
   * message is never lost from the transcript. */
  private async recordInbound(
    message: InboundMessage,
    rawType: string | undefined,
  ): Promise<void> {
    if (this.transcript === undefined) return;
    if (this.humanHandoff.isOpsSender(message.senderId)) return;
    try {
      await this.transcript.recordInbound(message, rawType);
    } catch (error) {
      this.logger.error(
        `transcript record failed for ${message.messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /** WU13-B2 receipt ingress for one customer media message. ODD-4A: the
   * normalized optional caption is the only extra field forwarded.
   * filename/sha256 and every other payload field are dropped, and the raw
   * caption never reaches the LLM or any durable type. */
  private async admitReceipt(
    message: InboundMessage,
    media: InboundMedia,
  ): Promise<void> {
    const decision = await this.ingress.admit({
      webhookMessageId: message.messageId,
      providerMediaId: media.providerMediaId,
      senderId: message.senderId,
      declaredMimeType: media.declaredMimeType,
      caption: media.caption,
    });
    const guidance = ingressGuidance(decision);

    if (guidance !== undefined) {
      const { providerMessageId } = await this.whatsappSender.sendText({
        to: message.senderId,
        text: applyCustomerStyle(guidance, this.customerStyle(message)),
      });
      this.recentOutbound.remember(providerMessageId);
    }
    // S6: atomic outcomes already wrote the marker inside admission, but the
    // claim holds the row as PROCESSING there, so it is completed here.
    await this.markSeenSafely(message.messageId);
  }

  /** S5: fire-and-forget; it never delays or breaks the reply. */
  private notifyHumanRequests(senderId: string): void {
    try {
      void this.humanRequestDelivery
        ?.onCustomerInbound(conversationRefFor(senderId))
        ?.catch((error: unknown) =>
          this.logger.warn(
            `pending deliveries replay failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    } catch (error) {
      this.logger.warn(
        `pending deliveries replay failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** S1: best effort; a profile failure never blocks the message. */
  private async prepareCustomer(senderId: string): Promise<void> {
    const agent = this
      .minimalCatalogAgent as Partial<MinimalCatalogAgentService>;
    if (typeof agent.prepareCustomer !== 'function') return;
    try {
      await agent.prepareCustomer(senderId);
    } catch (error) {
      this.logger.warn(
        `customer profile warm-up failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** S2: the sender's session style for a fixed media/handoff reply. Never
   * throws; without a readable style the copy stays in usted. */
  private customerStyle(message: InboundMessage): CustomerStyle {
    const agent = this
      .minimalCatalogAgent as Partial<MinimalCatalogAgentService>;
    if (typeof agent.customerStyle !== 'function') {
      return DEFAULT_CUSTOMER_STYLE;
    }
    try {
      return agent.customerStyle(message.senderId, message.text);
    } catch {
      return DEFAULT_CUSTOMER_STYLE;
    }
  }

  /** S5: never throws — any failure becomes `unavailable` so the customer
   * is asked for the product name instead of the webhook failing. */
  private async recognizeProductImage(
    media: InboundMedia,
  ): Promise<ProductImageRecognition> {
    if (this.productImage === undefined) {
      return { kind: 'unavailable', reason: 'error' };
    }
    try {
      return await this.productImage.recognize({
        providerMediaId: media.providerMediaId,
        declaredMimeType: media.declaredMimeType,
      });
    } catch (error) {
      this.logger.warn(
        `product image recognition failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { kind: 'unavailable', reason: 'error' };
    }
  }

  /** (5) One customer turn through the minimal SDK route. R3b3-c4c1b: a
   * REAL normalized customer inbound carries its receiving-phone metadata;
   * forward that inert identity only when it exists. Ops synthetic turns
   * never reach this method. */
  private async runCustomerTurn(
    message: InboundMessage,
    text: string,
  ): Promise<void> {
    const minimal = await this.minimalCatalogAgent.tryHandle({
      senderId: message.senderId,
      text,
      ...(message.interactiveReplyId === undefined
        ? {}
        : { interactiveReplyId: message.interactiveReplyId }),
      ...(message.profileName === undefined
        ? {}
        : { profileName: message.profileName }),
      ...(Number.isNaN(Date.parse(message.timestamp))
        ? {}
        : { inboundAt: new Date(message.timestamp).toISOString() }),
      ...(message.receivingPhoneNumberId === undefined
        ? {}
        : {
            inboundEvent: {
              receivingPhoneNumberId: message.receivingPhoneNumberId,
              senderId: message.senderId,
              messageId: message.messageId,
            },
          }),
    });
    // S7 (W2): the mode may have switched to HUMAN during the turn; the
    // reply is then dropped. A read error propagates (fail closed, Meta
    // redelivers), like the gate.
    if (await this.isHumanMode(message.senderId)) {
      this.logger.log(
        `handoff HUMAN mid-turn: drop reply for ${message.messageId} from ${maskConversationRef(message.senderId)}`,
      );
      await this.markSeenSafely(message.messageId);
      return;
    }
    // S3: the product photo goes first, then the explanation.
    for (const media of minimal.media ?? []) {
      await this.sendReplyImage(message.senderId, media);
    }
    const providerMessageIds = await this.sendReplyText(
      message.senderId,
      minimal,
    );
    // WU-B: arm the RESTOCK pending ONLY after Meta accepted the
    // question, and BEFORE the observational remember/markSeen writes so
    // an observation failure can never undo the accepted send.
    minimal.onSent?.();
    for (const id of providerMessageIds) this.recentOutbound.remember(id);
    await this.markSeenSafely(message.messageId);
  }

  /**
   * S4: the reply text, with its buttons/list when the sender supports them.
   * A missing or failed interactive send falls back to the same plain text
   * (it already says how to answer), so the reply is never lost.
   */
  private async sendReplyText(
    to: string,
    reply: CustomerReply,
  ): Promise<string[]> {
    const interactive = reply.interactive;
    if (
      interactive !== undefined &&
      this.whatsappSender.sendInteractive !== undefined
    ) {
      try {
        const { prompt, ...controls } = interactive;
        const sent = await this.whatsappSender.sendInteractive({
          to,
          body: reply.reply,
          interactive: controls,
          ...(prompt === undefined ? {} : { shortBody: prompt }),
        });
        return sent.providerMessageIds.length > 0
          ? sent.providerMessageIds
          : [sent.providerMessageId];
      } catch (error) {
        this.logger.warn(
          `interactive reply failed for ${maskConversationRef(to)}; sending the text only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const { providerMessageId } = await this.whatsappSender.sendText({
      to,
      text: reply.reply,
    });
    return [providerMessageId];
  }

  /** S3: best effort. A failed or unsupported image never blocks the text
   * reply (e.g. Meta refuses a >5 MB or non-JPEG/PNG image). */
  private async sendReplyImage(
    to: string,
    media: CustomerReplyMedia,
  ): Promise<void> {
    if (this.whatsappSender.sendImage === undefined) return;
    try {
      const { providerMessageId } = await this.whatsappSender.sendImage({
        to,
        link: media.url,
        ...(media.caption === undefined ? {} : { caption: media.caption }),
      });
      this.recentOutbound.remember(providerMessageId);
    } catch (error) {
      this.logger.warn(
        `reply image failed for ${maskConversationRef(to)}; sending the text only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async replyAndMarkSeen(
    message: InboundMessage,
    text: string,
  ): Promise<void> {
    const { providerMessageId } = await this.whatsappSender.sendText({
      to: message.senderId,
      text,
    });
    this.recentOutbound.remember(providerMessageId);
    await this.markSeenSafely(message.messageId);
  }

  /** S6: a failed release only leaves the claim to expire (the redelivery
   * after the lease is processed); it never masks the processing error. */
  private async releaseSafely(
    messageId: string,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.dedup.release(messageId, claimToken);
    } catch (error) {
      this.logger.warn(
        `release failed for ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** A dedup-write failure must NOT turn a successful send into a failed
   * webhook delivery (that would force Meta to re-deliver and the customer
   * would get the reply twice). */
  private async markSeenSafely(messageId: string): Promise<void> {
    try {
      await this.dedup.markSeen(messageId);
    } catch (error) {
      this.logger.warn(
        `markSeen failed for ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** S5: customer reply for a photo the agent cannot search for. A receipt
 * with no order asks for the product first (D6: never the operator copy). */
function productImageFallbackReply(
  recognition: ProductImageRecognition,
): string {
  switch (recognition.kind) {
    case 'unavailable':
      return PRODUCT_IMAGE_UNAVAILABLE_REPLY;
    case 'receipt':
      return RECEIPT_IMAGE_WITHOUT_ORDER_REPLY;
    default:
      return PRODUCT_IMAGE_UNCLEAR_REPLY;
  }
}

// ── WU13-A2: normalizeInboundMessages media helper ───────────────────────
function normalizeMediaPayload(
  message: WebhookMessageDto,
  kind: 'image' | 'document',
): InboundMedia | null {
  const payload = kind === 'image' ? message.image : message.document;

  if (
    !payload ||
    typeof payload.id !== 'string' ||
    payload.id.length === 0 ||
    typeof payload.mime_type !== 'string' ||
    payload.mime_type.length === 0
  ) {
    return null;
  }

  // Drop if the declared type does not match the actual payload MIME category.
  // Guard against a structurally anomalous DTO where `type` claims 'document'
  // but the actual payload is an image (or vice versa).
  if (kind === 'image' && !payload.mime_type.startsWith('image/')) {
    return null;
  }
  if (kind === 'document' && !payload.mime_type.startsWith('application/pdf')) {
    return null;
  }

  return {
    kind,
    providerMediaId: payload.id,
    declaredMimeType: payload.mime_type,
    caption: payload.caption,
    filename: payload.filename,
    sha256: payload.sha256,
  };
}

export function normalizeInboundMessages(
  event: WebhookEventDto,
): InboundMessage[] {
  const entry = event.entry ?? [];

  return entry.flatMap((item) =>
    (item.changes ?? []).flatMap((change) => {
      const value = change.value;
      const fallbackSenderId = value?.contacts?.[0]?.wa_id;
      // S1: the contact profile name of each sender (non-blank strings only).
      const profileNameOf = (senderId: string): { profileName?: string } => {
        const name = value?.contacts?.find(
          (contact) => contact.wa_id === senderId,
        )?.profile?.name;
        return typeof name === 'string' && name.trim() !== ''
          ? { profileName: name }
          : {};
      };
      const receivingPhoneNumberId =
        typeof value?.metadata?.phone_number_id === 'string'
          ? value.metadata.phone_number_id
          : undefined;

      return (value?.messages ?? []).flatMap((message): InboundMessage[] => {
        if (
          message.type === 'text' &&
          typeof message.text?.body === 'string' &&
          typeof message.id === 'string' &&
          typeof message.timestamp === 'string'
        ) {
          const senderId = message.from ?? fallbackSenderId;
          if (typeof senderId !== 'string' || senderId.length === 0) {
            return [];
          }
          return [
            {
              senderId,
              text: message.text.body,
              messageId: message.id,
              timestamp: normalizeTimestamp(message.timestamp),
              receivingPhoneNumberId,
              ...profileNameOf(senderId),
            },
          ];
        }

        // ── S4: tapped reply button / list row, legacy template button ─
        if (
          (message.type === 'interactive' || message.type === 'button') &&
          typeof message.id === 'string' &&
          typeof message.timestamp === 'string'
        ) {
          const reply = normalizeInteractiveReply(message);
          const senderId = message.from ?? fallbackSenderId;
          if (
            reply === null ||
            typeof senderId !== 'string' ||
            senderId.length === 0
          ) {
            return [];
          }
          return [
            {
              senderId,
              text: reply.text,
              messageId: message.id,
              timestamp: normalizeTimestamp(message.timestamp),
              receivingPhoneNumberId,
              ...profileNameOf(senderId),
              ...(reply.id === undefined
                ? {}
                : { interactiveReplyId: reply.id }),
            },
          ];
        }

        // ── WU13-A2: image / document media ──────────────────────
        if (
          (message.type === 'image' || message.type === 'document') &&
          typeof message.id === 'string' &&
          typeof message.timestamp === 'string'
        ) {
          // Drop structural anomaly: both image and document payloads present
          // (the declared type does not match the "present payload").
          if (message.image && message.document) {
            return [];
          }

          const media = normalizeMediaPayload(message, message.type);
          if (media === null) return [];

          const senderId = message.from ?? fallbackSenderId;
          if (typeof senderId !== 'string' || senderId.length === 0) {
            return [];
          }

          return [
            {
              senderId,
              text: media.caption ?? '',
              messageId: message.id,
              timestamp: normalizeTimestamp(message.timestamp),
              receivingPhoneNumberId,
              ...profileNameOf(senderId),
              media,
            },
          ];
        }

        return [];
      });
    }),
  );
}

/** S1: Meta's `message.type` per inbound wamid, for the transcript. */
function rawMessageTypes(event: WebhookEventDto): Map<string, string> {
  const types = new Map<string, string>();
  for (const item of event.entry ?? [])
    for (const change of item.changes ?? [])
      for (const message of change.value?.messages ?? [])
        if (typeof message.id === 'string' && typeof message.type === 'string')
          types.set(message.id, message.type);
  return types;
}

/**
 * S4: a tapped `button_reply`/`list_reply` becomes the text its id stands
 * for (see `interactiveReplyText`) plus the id; a legacy quick-reply
 * template `button` is just its text. `null` for anything unusable.
 */
function normalizeInteractiveReply(
  message: WebhookMessageDto,
): { text: string; id?: string } | null {
  if (message.type === 'button') {
    const text = message.button?.text;
    return typeof text === 'string' && text.trim() !== '' ? { text } : null;
  }
  const interactive = message.interactive;
  const reply =
    interactive?.type === 'button_reply'
      ? interactive.button_reply
      : interactive?.type === 'list_reply'
        ? interactive.list_reply
        : undefined;
  const id = reply?.id;
  if (typeof id !== 'string' || id === '') return null;
  const text = interactiveReplyText(id, reply?.title);
  return text.trim() === '' ? null : { text, id };
}

function normalizeTimestamp(timestamp: string): string {
  const seconds = Number(timestamp);

  if (!Number.isFinite(seconds)) {
    return timestamp;
  }

  return new Date(seconds * 1000).toISOString();
}

// WU13-B2: maps each closed ReceiptIngressDecision kind to customer-facing
// guidance text. Silent variants return undefined — no reply is sent and
// media never reaches AgentRunner. Customer text always goes to the agent:
// the receipt amount dialog (CONFIRMAR/CANCELAR) is gone (R6/S9).

/** S8: the formats the backend accepts (same text as the outbox template). */
const UNSUPPORTED_RECEIPT_FORMAT =
  'Envíenos su comprobante como imagen JPEG o PNG, o como PDF, de menos de 10 MB.';

function ingressGuidance(decision: ReceiptIngressDecision): string | undefined {
  switch (decision.kind) {
    case 'unsupported-media':
      return UNSUPPORTED_RECEIPT_FORMAT;
    case 'no-placed-sale':
      // D6: customer copy (PDF before any order), never an operator instruction.
      return 'Recibí su comprobante. Para registrarlo primero necesitamos confirmar su pedido. ¿Qué producto desea?';
    case 'sender-active':
      // R6: no amount dialog any more, so an active receipt is always still
      // being processed (downloaded, read and uploaded to the backend).
      return 'Estamos procesando su comprobante.';
    case 'reserved':
    case 'webhook-replayed':
    case 'provider-media-reused':
    case 'webhook-media-conflict':
      return undefined;
  }
}

// Re-export the AgentMessage type for any downstream consumers that
// import this module for convenience. (Pure type-only re-export.)
export type { AgentMessage };
