import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONVERSATION_STORE,
  readPendingHumanRequest,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import type { AgentMessage } from '../../conversation/domain/conversation-store';
import { ReceiptAmountRouterService } from '../../receipt-media/application/receipt-amount-router.service';
import {
  ReceiptIngressService,
  type ReceiptIngressDecision,
} from '../../receipt-media/application/receipt-ingress.service';
import type { ActiveReceiptStatus } from '../../receipt-media/domain/receipt-media-store.port';
import {
  HumanHandoffService,
  PENDING_HUMAN_REQUEST_REPLY,
} from '../../human-handoff/application/human-handoff.service';
import { HUMAN_HANDOFF_SERVICE_TOKEN } from '../../sale-flow/infrastructure/real-tool-registry';
import { AgentRunner } from '../../llm-agent/application/agent-runner.service';
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
import { prepareShippingCustomerDisclosure } from '../../shipping/application/shipping-customer-disclosure';
import { persistSentShippingCustomerOffer } from '../../shipping/application/shipping-customer-offer-persistence';
import {
  normalizeShippingCustomerOffer,
  SHIPPING_CUSTOMER_OFFER_KEY,
  type ShippingCustomerOffer,
} from '../../shipping/application/shipping-customer-acceptance';

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
 *   5. `AgentRunner.handle({ senderId, text })` — runner owns idle-check,
 *      history truncation, cost-guard, fresh-state spread (ADR-28), and
 *      UPSERT-persistence of user + assistant turns (with the pending-marker
 *      short-circuit gate inside).
 *   6. WhatsappSenderPort.sendText — send the reply.
 *   7. RECENT_OUTBOUND.remember + WEBHOOK_DEDUP.markSeen — only after a
 *      successful send, so a failed send lets Meta re-deliver and retry.
 *
 * Spec: `openspec/changes/human-handoff/specs/whatsapp-webhook/delta.md`.
 * Test: `webhook-dispatcher.service.spec.ts` (15 it() blocks: 8 agent-path
 * + 3 metadata + 4 ops-path/pending-marker short-circuit).
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
    private readonly amountRouter: ReceiptAmountRouterService,
    private readonly ingress: ReceiptIngressService,
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
            // SCA-3b2: a structured SHIPPING_APPROVED resolution is NEVER a
            // synthetic LLM turn. The dispatcher discloses the server-derived
            // price deterministically and only a successful send can persist
            // the pending customer-response marker.
            if (result.resolution.decision === 'SHIPPING_APPROVED') {
              await this.discloseApprovedShippingPrice(result.customerId);
            } else {
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
            }
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

        // ─── WU13-B1: ReceiptAmountRouter — customer text only ─────────────
        if (message.media == null) {
          const outcome = await this.amountRouter.route({
            senderId: message.senderId,
            text: message.text,
            sourceWebhookMessageId: message.messageId,
          });
          // ODD-4D: a valid active receipt pointer with no routing plan is
          // deterministic — send the active-flow guidance and never call the
          // LLM. Send failure propagates before remember/markSeen.
          if (outcome.kind === 'unrecognized') {
            this.logger.log(
              `amount router terminal [unrecognized] for ${message.messageId}`,
            );
            const { providerMessageId } = await this.whatsappSender.sendText({
              to: message.senderId,
              text: ACTIVE_RECEIPT_GUIDANCE,
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
          if (outcome.kind !== 'fenced') {
            this.logger.log(
              `amount router terminal [${outcome.kind}] for ${message.messageId}`,
            );
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
          // Fenced → fall through to the ordinary agent path below.
        }

        // ─── WU13-B2: ReceiptIngressService — customer media only ─────────────
        if (message.media != null) {
          // ODD-4A: the normalized optional caption is the only extra field
          // forwarded. filename/sha256 and every other payload field are
          // dropped, and the raw caption never reaches the amount router, the
          // LLM, or any durable type.
          const decision = await this.ingress.admit({
            webhookMessageId: message.messageId,
            providerMediaId: message.media.providerMediaId,
            senderId: message.senderId,
            declaredMimeType: message.media.declaredMimeType,
            caption: message.media.caption,
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
            try {
              await this.dedup.markSeen(message.messageId);
            } catch (error) {
              this.logger.warn(
                `markSeen failed for ${message.messageId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          continue;
        }

        // ─── (5) Normal agent dispatch ─────────────────────────────────
        const { reply } = await this.agentRunner.handle({
          senderId: message.senderId,
          text: message.text,
        });

        const { providerMessageId } = await this.whatsappSender.sendText({
          to: message.senderId,
          text: reply,
        });

        this.recentOutbound.remember(providerMessageId);

        // A dedup-write failure must NOT turn a successful send into a
        // failed webhook delivery (that would force Meta to re-deliver and
        // the customer would get the reply twice).
        try {
          await this.dedup.markSeen(message.messageId);
        } catch (error) {
          this.logger.warn(
            `markSeen failed for ${message.messageId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
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

  /**
   * SCA-3b2: deterministic post-`SHIPPING_APPROVED` price disclosure.
   *
   * Reads the current customer state and prepares the server-derived price;
   * only then does it send the fixed Spanish disclosure to the CUSTOMER and
   * remember the outbound id. It re-reads fresh state and persists the sent
   * offer built from the prepared fields plus the real provider message id
   * (SCA-3b1). A valid active offer on the same approved request/pin/amounts
   * is treated as a replay: no re-send. Any null/throw fails closed (no
   * dedup mark), so delivery uncertainty can never enable acceptance.
   */
  private async discloseApprovedShippingPrice(
    customerId: string,
  ): Promise<void> {
    const nowMs = Date.now();
    const state = await this.conversationStore.get(customerId);
    const prepared = prepareShippingCustomerDisclosure(
      state?.data ?? null,
      nowMs,
    );
    if (prepared === null) {
      throw new Error('shipping disclosure unavailable');
    }
    const existing = normalizeShippingCustomerOffer(
      state?.data?.[SHIPPING_CUSTOMER_OFFER_KEY],
    );
    if (
      existing !== null &&
      isActiveMatchingShippingOffer(existing, prepared.offer, nowMs)
    ) {
      this.logger.log(
        `shipping disclosure replay for ${customerId}: re-send skipped`,
      );
      return;
    }
    const { providerMessageId } = await this.whatsappSender.sendText({
      to: customerId,
      text: prepared.text,
    });
    // Remember the confirmed send immediately: even if persistence fails,
    // the outbound id must be filtered as an echo.
    this.recentOutbound.remember(providerMessageId);
    const freshState = await this.conversationStore.get(customerId);
    const offer = { ...prepared.offer, providerMessageId };
    const persisted = await persistSentShippingCustomerOffer(
      this.conversationStore,
      customerId,
      freshState,
      offer,
      nowMs,
    );
    if (persisted === null) {
      throw new Error('shipping disclosure persistence failed');
    }
  }
}

// SCA-3b2: replay predicate — a persisted offer is only trusted when it pins
// the same approved request, draft and disclosed amounts and is still active.
function isActiveMatchingShippingOffer(
  existing: ShippingCustomerOffer,
  prepared: Omit<ShippingCustomerOffer, 'providerMessageId'>,
  nowMs: number,
): boolean {
  return (
    existing.requestId === prepared.requestId &&
    existing.draftCreatedAt === prepared.draftCreatedAt &&
    existing.expiresAt === prepared.expiresAt &&
    existing.merchandiseCents === prepared.merchandiseCents &&
    existing.chargeCents === prepared.chargeCents &&
    existing.expectedTotalCents === prepared.expectedTotalCents &&
    Date.parse(existing.offeredAt) <= nowMs &&
    nowMs < Date.parse(existing.expiresAt)
  );
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
// media never reaches the amount router or AgentRunner. ODD-4C: a durable
// sender-active decision carries its exact status, so the guidance reflects
// whether the open flow still needs the customer's amount/confirmation or is
// still being processed internally.

/** ODD-4C/4D fixed Spanish guidance for a durable active amount or confirmation
 * flow that still needs a customer decision. Shared by sender-active image
 * guidance and the ODD-4D deterministic active-text fallback; defined locally
 * so the dispatcher never imports notification internals. */
const ACTIVE_RECEIPT_GUIDANCE =
  'Tienes un proceso abierto: finalízalo o cancélalo.';

function ingressGuidance(decision: ReceiptIngressDecision): string | undefined {
  switch (decision.kind) {
    case 'disabled':
      return 'El servicio no está disponible. Intenta más tarde.';
    case 'unsupported-media':
      return 'Formato no soportado. Envía JPEG o PNG.';
    case 'no-placed-sale':
      return 'Primero registra la venta en el sistema.';
    case 'sender-active':
      return senderActiveGuidance(decision.status);
    case 'reserved':
    case 'webhook-replayed':
    case 'provider-media-reused':
    case 'webhook-media-conflict':
      return undefined;
  }
}

/** ODD-4C fixed Spanish guidance for a durable active receipt. An amount or
 * confirmation flow needs a customer decision; every other active status is
 * still processing internally. */
function senderActiveGuidance(status: ActiveReceiptStatus): string {
  switch (status) {
    case 'AWAITING_AMOUNT':
    case 'AWAITING_CONFIRMATION':
      return ACTIVE_RECEIPT_GUIDANCE;
    case 'RESERVED':
    case 'DOWNLOADED':
    case 'STORED':
    case 'ATTACHING':
      return 'Estamos procesando tu comprobante.';
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
