import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import { normalizeSandboxRecipient } from '../../whatsapp/infrastructure/meta-whatsapp.sender';
import { WHATSAPP_SENDER } from '../../whatsapp/domain/whatsapp-sender.port';
import type { WhatsappSenderPort } from '../../whatsapp/domain/whatsapp-sender.port';
import type {
  CreateHumanHandoffInput,
  HumanHandoffStore,
} from '../domain/human-handoff-store.port';
import { HUMAN_HANDOFF_STORE } from '../domain/human-handoff-store.port';
import type {
  HumanHandoffDigest,
  HumanHandoffKind,
  HumanHandoffRequest,
  HumanHandoffResolution,
} from '../domain/human-handoff.types';
import {
  SHIPPING_APPROVAL_POLICY,
  type ShippingApprovalPolicy,
} from '../domain/shipping-approval-policy.port';
import {
  clearPendingHumanRequest,
  readPendingHumanRequest,
  setPendingHumanRequest,
} from './pending-human-request-persistence';

/**
 * Byte-identical customer-facing "under review" notice.
 *
 * Sent EXACTLY ONCE per escalation when `create` succeeds (the idempotency
 * guard prevents duplicates within a single pending session). Subsequent
 * customer inbounds while waiting receive the runner's canned
 * `PENDING_HUMAN_REQUEST_REPLY` (not this literal).
 */
export const UNDER_REVIEW_NOTICE =
  'Gracias, ya contacté a un agente humano con tu caso. En cuanto tenga respuesta te aviso.';

/**
 * Byte-identical canned reply used by the runner's pending-marker
 * short-circuit and by the dispatcher's pre-routing hook when the
 * customer's `pendingHumanRequest` marker is set.
 */
export const PENDING_HUMAN_REQUEST_REPLY =
  'seguimos esperando respuesta del agente, te avisamos en cuanto tengamos';

/**
 * Sent to the ops thread when the resolver cannot find a pending request
 * for the agent (no token, no pending row). Asks the agent to include
 * the `HF-xxxx` code from the digest they received.
 */
export const ASK_FOR_REF =
  'No encontré una solicitud pendiente. Incluye el código HF-xxxx de la solicitud (está en el mensaje que te envié).';

export interface HumanHandoffCreateInput {
  senderId: string;
  kind: HumanHandoffKind;
  digest: HumanHandoffDigest;
}

export type HumanHandoffCreateResult =
  | { ok: true; requestId: string; ref: string; customerNotified: true }
  | { ok: false; error: { kind: 'disabled'; retryable: false } };

export type HumanHandoffResolveReplyResult =
  | {
      kind: 'resolved';
      customerId: string;
      ref: string;
      resolution: HumanHandoffResolution;
      syntheticUserText: string;
    }
  | { kind: 'no_pending'; reply: string };

/**
 * Application-layer service for the human-handoff channel.
 *
 * Responsibilities:
 *   - `create({ senderId, kind, digest })`: write the row, send the
 *     digest to the ops thread, send the customer the one-shot
 *     "under review" notice, and persist the `pendingHumanRequest`
 *     marker. Idempotent for repeat calls within the same pending
 *     session.
 *   - `resolveReply({ text, from })`: parse the `HF-<id>` token (or fall
 *     back to the newest pending row for the agent), parse the
 *     decision keyword (case/whitespace tolerant), resolve the row,
 *     clear the customer's marker, and produce a synthetic user turn
 *     for the runner to consume.
 *   - `isOpsSender(senderId)`: classify inbounds by senderId against
 *     the configured ops phone, compared under the explicit
 *     `META_SANDBOX_RECIPIENT_NORMALIZATION` mode (exact by default).
 */
@Injectable()
export class HumanHandoffService {
  constructor(
    @Inject(HUMAN_HANDOFF_STORE)
    private readonly store: HumanHandoffStore,
    @Inject(WHATSAPP_SENDER)
    private readonly whatsappSender: WhatsappSenderPort,
    @Inject(CONVERSATION_STORE)
    private readonly conversationStore: ConversationStore,
    private readonly configService: ConfigService,
    @Inject(SHIPPING_APPROVAL_POLICY)
    private readonly shippingApprovalPolicy: ShippingApprovalPolicy,
  ) {}

  isOpsSender(senderId: string): boolean {
    const opsChannelPhone = this.configService.get<string>(
      'humanHandoff.opsChannelPhone',
    );
    if (!opsChannelPhone) {
      return false;
    }
    const sandboxNormalization =
      this.configService.get<boolean>(
        'meta.sandboxRecipientNormalizationEnabled',
      ) === true;
    return (
      normalizeSandboxRecipient(senderId, sandboxNormalization) ===
      normalizeSandboxRecipient(opsChannelPhone, sandboxNormalization)
    );
  }

  async create(
    input: HumanHandoffCreateInput,
  ): Promise<HumanHandoffCreateResult> {
    const enabled = this.configService.get<boolean>('humanHandoff.enabled');
    const opsChannelPhone = this.configService.get<string>(
      'humanHandoff.opsChannelPhone',
    );
    if (!enabled) {
      return { ok: false, error: { kind: 'disabled', retryable: false } };
    }
    if (!opsChannelPhone) {
      return { ok: false, error: { kind: 'disabled', retryable: false } };
    }

    const state = await this.conversationStore.get(input.senderId);
    const existingMarker = readPendingHumanRequest(state);
    if (existingMarker) {
      return {
        ok: true,
        requestId: existingMarker.requestId,
        ref: existingMarker.ref,
        customerNotified: true,
      };
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const ref = `HF-${id}`;
    const nowIso = new Date().toISOString();

    const createInput: CreateHumanHandoffInput = {
      id,
      customerId: input.senderId,
      agentId: opsChannelPhone,
      kind: input.kind,
      digest: input.digest,
    };

    const request = await this.store.create(createInput);

    await this.whatsappSender.sendText({
      to: opsChannelPhone,
      text: renderDigest(request),
    });

    await this.whatsappSender.sendText({
      to: input.senderId,
      text: UNDER_REVIEW_NOTICE,
    });

    await setPendingHumanRequest(
      this.conversationStore,
      input.senderId,
      state,
      {
        requestId: id,
        ref,
        createdAt: nowIso,
        customerNotifiedAt: nowIso,
      },
      nowIso,
    );

    return { ok: true, requestId: id, ref, customerNotified: true };
  }

  async resolveReply(args: {
    text: string;
    from: string;
  }): Promise<HumanHandoffResolveReplyResult> {
    const refMatch = /\bHF-([A-Za-z0-9_-]{4,32})\b/i.exec(args.text);
    let target = refMatch
      ? await this.store.findByRef(`HF-${refMatch[1]}`)
      : null;

    if (!target) {
      // Newest-pending fallback (spec step 2): when no token is present
      // OR the token returned no row, try the agent's newest pending
      // request. Only when BOTH lookups miss do we answer no_pending.
      target = await this.store.findLatestPendingForAgent(args.from);
    }

    if (!target) {
      return { kind: 'no_pending', reply: ASK_FOR_REF };
    }

    const resolution = parseResolution(args.text, target.kind);
    await this.store.resolve(target.id, resolution);

    const customerState = await this.conversationStore.get(target.customerId);
    await clearPendingHumanRequest(
      this.conversationStore,
      target.customerId,
      customerState,
    );

    return {
      kind: 'resolved',
      customerId: target.customerId,
      ref: `HF-${target.id}`,
      resolution,
      syntheticUserText: formatResolutionAsUserTurn(target, resolution),
    };
  }
}

/**
 * Render the ops-facing digest.
 *
 * Emits a structured header + the kind-specific payload + a "reply
 * grammar" hint that documents which decision keyword the agent should
 * reply with.
 */
function renderDigest(request: HumanHandoffRequest): string {
  const ref = `HF-${request.id}`;
  const lines: string[] = [
    '🔔 HoundFe — solicitud de agente humano',
    `Ref: ${ref}`,
    `Tipo: ${request.kind}`,
  ];

  switch (request.kind) {
    case 'out_of_stock': {
      const d = request.digest as Extract<
        HumanHandoffDigest,
        { kind: 'out_of_stock' }
      >;
      lines.push(
        `Producto: ${d.name ?? 'sin nombre'} (id: ${d.productId})` +
          ('variantId' in d && d.variantId
            ? ` · variante: ${d.variantId}`
            : '') +
          ('quantity' in d && typeof d.quantity === 'number'
            ? ` · cantidad: ${d.quantity}`
            : ''),
      );
      lines.push(
        `Responde con "${ref}: YES_RESTOCK_IN_X_DAYS:<días>" o "${ref}: NO_RESTOCK"`,
      );
      break;
    }
    case 'needs_human_review': {
      const d = request.digest as Extract<
        HumanHandoffDigest,
        { kind: 'needs_human_review' }
      >;
      lines.push(`Carrito: ${d.items.length} línea(s)`);
      if (typeof d.originalTotalCents === 'number') {
        lines.push(`Total lista: ${d.originalTotalCents / 100} MXN`);
      }
      lines.push(
        `Responde con "${ref}: APPROVED_PROMO:<centavos>" o "${ref}: GENERIC:<texto>"`,
      );
      break;
    }
    case 'expiration_date': {
      const d = request.digest as Extract<
        HumanHandoffDigest,
        { kind: 'expiration_date' }
      >;
      lines.push(`Producto: ${d.name} (id: ${d.productId})`);
      lines.push(`Pregunta: ${d.question}`);
      lines.push(
        `Responde con "${ref}: EXPIRATION:<texto>" o "${ref}: GENERIC:<texto>"`,
      );
      break;
    }
    case 'shipping_approval': {
      const d = request.digest as Extract<
        HumanHandoffDigest,
        { kind: 'shipping_approval' }
      >;
      lines.push(`Cobro de envío: ${formatCents(d.customerPaysCents)} MXN`);
      lines.push(`Crédito total: ${formatCents(d.totalCreditCents)} MXN`);
      lines.push(`Paquetería: ${d.carrierName}`);
      lines.push(`Servicio: ${d.serviceName}`);
      lines.push(
        `Entrega estimada: ${
          typeof d.estimatedDeliveryDays === 'number'
            ? `${d.estimatedDeliveryDays} día(s)`
            : 'no disponible'
        }`,
      );
      lines.push(
        `Responde con "${ref}: APPROVE_SHIPPING" o "${ref}: REJECT_SHIPPING"`,
      );
      break;
    }
  }

  return lines.join('\n');
}

/**
 * Deterministic integer-cents money formatting (no `Intl`/locale): always
 * exactly two decimals, so `0` → `0.00` and `6901` → `69.01`.
 */
function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse the agent's reply text into a `HumanHandoffResolution`.
 *
 * Strategy (case/whitespace tolerant):
 *   - Strip the `HF-<id>` token if present.
 *   - Try `YES_RESTOCK_IN_X_DAYS:<n>` first → restock decision.
 *   - Try `APPROVED_PROMO:<n>` → cents decision.
 *   - Try `NO_RESTOCK` → bare restock-no decision.
 *   - Try `EXPIRATION:<text>` → expiration decision.
 *   - Anything else → `GENERIC:<text>` (the trimmed remainder).
 */
function parseResolution(
  text: string,
  kind: HumanHandoffKind,
): HumanHandoffResolution {
  const stripped = text.replace(/\bHF-[A-Za-z0-9_-]{4,32}\b/gi, '').trim();

  const restockMatch = /YES_RESTOCK_IN_X_DAYS\s*:\s*(\d+)/i.exec(stripped);
  if (restockMatch) {
    return {
      decision: 'YES_RESTOCK_IN_X_DAYS',
      days: Number.parseInt(restockMatch[1], 10),
    };
  }

  const promoMatch = /APPROVED_PROMO\s*:\s*(\d+)/i.exec(stripped);
  if (promoMatch) {
    return {
      decision: 'APPROVED_PROMO',
      totalCents: Number.parseInt(promoMatch[1], 10),
    };
  }

  if (/NO_RESTOCK/i.test(stripped)) {
    return { decision: 'NO_RESTOCK' };
  }

  const expirationMatch = /EXPIRATION\s*:\s*(.+)$/i.exec(stripped);
  if (expirationMatch) {
    return { decision: 'EXPIRATION', text: expirationMatch[1].trim() };
  }

  // Kind-aware fallback: for expiration_date, bare prose is treated as
  // an EXPIRATION answer (no EXPIRATION: prefix required); for every
  // other kind, bare prose is GENERIC.
  if (kind === 'expiration_date' && stripped.length > 0) {
    return { decision: 'EXPIRATION', text: stripped };
  }

  return { decision: 'GENERIC', text: stripped };
}

/**
 * Format the resolution as a synthetic user turn that the runner can
 * forward into the customer's next LLM turn. The text carries the kind
 * + the resolved value in Mexican Spanish so the model can phrase a
 * coherent reply without needing the prior transcript. The structured
 * shipping decisions emit amount-free, decision-only turns (SQ-5C2c1).
 */
export function formatResolutionAsUserTurn(
  request: HumanHandoffRequest,
  resolution: HumanHandoffResolution,
): string {
  const ref = `HF-${request.id}`;
  switch (resolution.decision) {
    case 'YES_RESTOCK_IN_X_DAYS':
      return `[Resolución del agente humano (${ref})] El producto estará disponible nuevamente en ${resolution.days} día(s). Informa al cliente que el restock llega en ${resolution.days} días y pregúntale si desea apartarlo.`;
    case 'NO_RESTOCK':
      return `[Resolución del agente humano (${ref})] El producto NO tendrá restock. Informa al cliente que el producto no estará disponible y sugiere alternativas del catálogo.`;
    case 'APPROVED_PROMO':
      return `[Resolución del agente humano (${ref})] El agente aprobó el total de ${resolution.totalCents / 100} MXN para la promoción. Confirma al cliente ese total y pregúntale si desea proceder con el pago.`;
    case 'EXPIRATION':
      return `[Resolución del agente humano (${ref})] Sobre la fecha de caducidad, el agente responde: "${resolution.text}". Comparte esa respuesta con el cliente.`;
    case 'GENERIC':
      return `[Resolución del agente humano (${ref})] El agente responde: "${resolution.text}". Comparte esa respuesta con el cliente.`;
    case 'SHIPPING_APPROVED':
      return `[Resolución del agente humano (${ref})] El agente aprobó el envío.`;
    case 'SHIPPING_REJECTED':
      return `[Resolución del agente humano (${ref})] El agente rechazó el envío.`;
    case 'SHIPPING_EXPIRED':
      return `[Resolución del agente humano (${ref})] La cotización de envío ya no es válida.`;
  }
}
