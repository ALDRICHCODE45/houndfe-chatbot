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
 *   2. WEBHOOK_DEDUP   — skip re-deliveries of already-processed msgs.
 *   3. **Ops pre-routing hook** (new, human-handoff slice) —
 *      when `message.senderId` matches the configured OPS_CHANNEL_PHONE
 *      (exact by default; both sides apply the same trunk-1 rewrite only
 *      when `META_SANDBOX_RECIPIENT_NORMALIZATION=true`, per ADR-22), the inbound
 *      is an ops reply to a previous escalation, NOT a customer message:
 *        - `humanHandoff.resolveReply({ text, from })` parses the agent's
 *          decision (or `HF-<id>` token, or newest-pending fallback) and
 *          resolves the durable row + clears the customer's marker.
 *        - `{ kind: 'resolved', customerId, syntheticUserText, ... }` →
 *          inject the synthetic user turn into `AgentRunner.handle` with
 *          `senderId = customerId` (NOT the ops phone) so the customer's
 *          resume gets the right transcript context. The runner's reply
 *          is then sent to the customer (NOT the ops phone).
 *        - `{ kind: 'no_pending', reply }` → reply to the ops phone with
 *          the ASK_FOR_REF message.
 *        - The hook `continue`s past the pending-marker short-circuit +
 *          customer runner path.
 *   4. **Pending-marker short-circuit** (new, ADR-29 defense-in-depth) —
 *      when the customer's `data.pendingHumanRequest` is set, send the
 *      canned byte-identical "seguimos esperando respuesta del agente,
 *      te avisamos en cuanto tengamos" reply and `continue`. No LLM call.
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
 *   6. WhatsappSenderPort.sendText — send the reply.
 *   7. RECENT_OUTBOUND.remember + WEBHOOK_DEDUP.markSeen — only after a
 *      successful send, so a failed send lets Meta re-deliver and retry.
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
  ) {}

  async dispatch(event: WebhookEventDto): Promise<void> {
    const messages = normalizeInboundMessages(event);

    for (const message of messages) {
      // ─── (1) Echo filter ────────────────────────────────────────────
      if (this.recentOutbound.isKnown(message.messageId)) {
        this.logger.log(
          `skip echo ${message.messageId} from ${message.senderId}`,
        );
        continue;
      }

      // ─── (2) Dedup ──────────────────────────────────────────────────
      if (await this.dedup.isDuplicate(message.messageId)) {
        this.logger.log(
          `skip duplicate ${message.messageId} from ${message.senderId}`,
        );
        continue;
      }

      this.logger.log(
        `process ${message.messageId} from ${message.senderId} (${message.text.length} chars)`,
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

        // ─── (4) Pending-marker short-circuit (ADR-29 defense-in-depth)
        // The runner has the same gate; this branch keeps the dispatcher
        // consistent even if a caller bypasses the runner.
        const custState = await this.conversationStore.get(message.senderId);
        if (readPendingHumanRequest(custState) !== null) {
          this.logger.log(
            `short-circuit pending-marker for ${message.messageId} from ${message.senderId}`,
          );
          const { providerMessageId } = await this.whatsappSender.sendText({
            to: message.senderId,
            text: PENDING_HUMAN_REQUEST_REPLY,
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
            productImageFallbackReply(recognition),
          );
          continue;
        }

        // ─── (5) Minimal catalog agent dispatch ────────────────────────
        await this.runCustomerTurn(message, message.text);
      } catch (error) {
        this.logger.error(
          `failed to process ${message.messageId} from ${message.senderId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw error;
      }
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
        text: guidance,
      });
      this.recentOutbound.remember(providerMessageId);
    }
    if (!receiptAdmissionAtomicallyMarksSeen(decision.kind)) {
      await this.markSeenSafely(message.messageId);
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
    const { providerMessageId } = await this.whatsappSender.sendText({
      to: message.senderId,
      text: minimal.reply,
    });
    // WU-B: arm the RESTOCK pending ONLY after Meta accepted the
    // question, and BEFORE the observational remember/markSeen writes so
    // an observation failure can never undo the accepted send.
    minimal.onSent?.();
    this.recentOutbound.remember(providerMessageId);
    await this.markSeenSafely(message.messageId);
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
              media,
            },
          ];
        }

        return [];
      });
    }),
  );
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

function receiptAdmissionAtomicallyMarksSeen(
  kind: ReceiptIngressDecision['kind'],
): boolean {
  return (
    kind === 'reserved' ||
    kind === 'webhook-replayed' ||
    kind === 'provider-media-reused' ||
    kind === 'webhook-media-conflict'
  );
}

// Re-export the AgentMessage type for any downstream consumers that
// import this module for convenience. (Pure type-only re-export.)
export type { AgentMessage };
