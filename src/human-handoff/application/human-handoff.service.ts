import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_STORE,
  type ConversationStore,
} from '../../conversation/domain/conversation-store';
import {
  SHARED_RESERVATION,
  type ReservationDecision,
  type SharedReservationPort,
} from '../../human-decisions/domain/shared-reservation';
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
  | { ok: false; error: { kind: 'disabled'; retryable: false } }
  | { ok: false; error: { kind: 'unavailable'; retryable: false } };

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
 *     the configured ops phone (sandbox trunk-1 normalized on both
 *     sides per ADR-22).
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
    @Inject(SHARED_RESERVATION)
    private readonly reservations: SharedReservationPort,
  ) {}

  isOpsSender(senderId: string): boolean {
    const opsChannelPhone = this.configService.get<string>(
      'humanHandoff.opsChannelPhone',
    );
    if (!opsChannelPhone) {
      return false;
    }
    return (
      normalizeSandboxRecipient(senderId) ===
      normalizeSandboxRecipient(opsChannelPhone)
    );
  }

  /** Claim the single ACTIVE legacy slot before any store/send/marker effect.
   * A non-claim or a thrown reservation fails closed (`unavailable`): the bot
   * never promises a human that was not actually reserved, and v1 has no
   * release, so a dead request is left ACTIVE for a later reconciliation cut. */
  private async reserveLegacy(
    senderId: string,
    requestKey: string,
  ): Promise<ReservationDecision | null> {
    try {
      return await this.reservations.reserve({
        senderId,
        route: 'LEGACY_OPS',
        requestKey,
        intake: null,
      });
    } catch {
      return null;
    }
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

    const reservation = await this.reserveLegacy(input.senderId, id);
    if (reservation?.action !== 'claim') {
      return { ok: false, error: { kind: 'unavailable', retryable: false } };
    }

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

    // CAS the marker BEFORE the customer notice: an ops-send failure must
    // not strand a marker, and a CAS conflict must not promise the customer
    // a human we did not reserve. On conflict the ops digest may already be
    // out (the caller must reconcile); we do not notify or report success.
    const markerSet = await setPendingHumanRequest(
      this.conversationStore,
      input.senderId,
      {
        requestId: id,
        ref,
        createdAt: nowIso,
        customerNotifiedAt: nowIso,
      },
      nowIso,
    );
    if (!markerSet) {
      return { ok: false, error: { kind: 'unavailable', retryable: false } };
    }

    await this.whatsappSender.sendText({
      to: input.senderId,
      text: UNDER_REVIEW_NOTICE,
    });

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
    const resolved = await this.store.resolve(target.id, resolution);
    if (
      resolved === null ||
      resolved.id !== target.id ||
      resolved.customerId !== target.customerId ||
      resolved.status !== 'resolved'
    ) {
      throw new Error('human handoff resolve was not persisted');
    }

    const customerState = await this.conversationStore.get(target.customerId);
    const cleared = await clearPendingHumanRequest(
      this.conversationStore,
      target.customerId,
      target.id,
      customerState?.lastMessageAt ?? new Date().toISOString(),
    );
    if (!cleared) {
      throw new Error('human handoff marker was not cleared');
    }

    const closed = await this.reservations.closeLegacyResolved(
      target.customerId,
      target.id,
    );
    if (!closed) {
      throw new Error('human handoff reservation was not closed');
    }

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
      lines.push(`Responde con "${ref}: GENERIC:<texto>"`);
      break;
    }
  }

  return lines.join('\n');
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
 * coherent reply without needing the prior transcript.
 */
function formatResolutionAsUserTurn(
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
  }
}
