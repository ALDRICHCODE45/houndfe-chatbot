import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CONVERSATION_STORE,
  type ConversationState,
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
  type ShippingApprovalDecision,
  type ShippingApprovalMarker,
  type ShippingApprovalPolicy,
} from '../domain/shipping-approval-policy.port';
import {
  clearPendingHumanRequest,
  readPendingHumanRequest,
  setPendingHumanRequest,
} from './pending-human-request-persistence';
import {
  clearShippingApprovalMarker,
  setShippingApprovalMarker,
} from './shipping-approval-persistence';

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

/** Data-free ops reply for a missing/malformed shipping decision. */
export const SHIPPING_DECISION_GRAMMAR =
  'No pude interpretar tu decisión de envío. Responde con "APPROVE_SHIPPING" o "REJECT_SHIPPING" (opcionalmente con el código HF-xxxx de la solicitud antes de los dos puntos).';

/** Data-free ops reply for a stale draft; the row resolves as expired. */
export const SHIPPING_REQUOTE_REPLY =
  'La cotización de envío ya no es válida. Se requiere una nueva cotización antes de continuar.';

/** Data-free ops reply for any fail-closed shipping error. */
export const SHIPPING_RETRY_REPLY =
  'No pude procesar la respuesta del envío. Revisa la solicitud e inténtalo de nuevo.';

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
  | { kind: 'no_pending'; reply: string }
  | { kind: 'needs_decision'; reply: string }
  | { kind: 'needs_requote'; reply: string }
  | { kind: 'ops_error'; reply: string };

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
    return this.isOpsPhone(senderId);
  }

  /** Same ops-phone comparison as `isOpsSender`; used for the assigned agent. */
  private isOpsPhone(candidate: string): boolean {
    const opsChannelPhone = this.configService.get<string>(
      'humanHandoff.opsChannelPhone',
    );
    return !!opsChannelPhone && this.phoneMatches(candidate, opsChannelPhone);
  }

  /** Equality of two wa_ids under the explicit sandbox-recipient mode. */
  private phoneMatches(a: string, b: string): boolean {
    const sandbox =
      this.configService.get<boolean>(
        'meta.sandboxRecipientNormalizationEnabled',
      ) === true;
    return (
      normalizeSandboxRecipient(a, sandbox) ===
      normalizeSandboxRecipient(b, sandbox)
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

    // SQ-5C2c2b: structured, fail-closed path; the generic parser below
    // must never see a shipping request.
    if (target.kind === 'shipping_approval') {
      return this.resolveShippingReply(args, target);
    }

    const resolution = parseResolution(args.text, target.kind);
    // SQ-5C2c2b4a: compare-and-set — the store transitions only a still-pending
    // row. A losing resolve (a concurrent reply already resolved it) returns
    // null; fail closed without clearing the customer marker or emitting a
    // synthetic losing decision.
    const resolved = await this.store.resolve(target.id, resolution);
    if (resolved === null) {
      return { kind: 'no_pending', reply: ASK_FOR_REF };
    }

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

  /**
   * Shipping-approval resolution. Guards: identity (status/agent/sender/id/
   * digest/canonical pin) → strict grammar (`parseDecision` only) →
   * pending-marker → draft pin verify. A stale verdict resolves
   * SHIPPING_EXPIRED and clears pending (needs_requote). A valid verdict
   * persists the local `shippingApproval` marker BEFORE resolving the row,
   * then clears pending against the marker-write state and returns an
   * amount-free synthetic turn. No direct customer outbound. Cross-store
   * recovery (partial writes) is deferred to b4.
   */
  private async resolveShippingReply(
    args: { text: string; from: string },
    target: HumanHandoffRequest,
  ): Promise<HumanHandoffResolveReplyResult> {
    const opsError: HumanHandoffResolveReplyResult = {
      kind: 'ops_error',
      reply: SHIPPING_RETRY_REPLY,
    };
    const { digest } = target;
    if (
      target.status !== 'pending' ||
      !this.isOpsPhone(target.agentId) ||
      !this.phoneMatches(args.from, target.agentId) ||
      !/^[0-9a-f]{12}$/.test(target.id) ||
      !digest ||
      digest.kind !== 'shipping_approval' ||
      !isCanonicalIso(digest.draftCreatedAt)
    ) {
      return opsError;
    }

    const parsed = parseShippingGrammar(
      args.text,
      target.id,
      this.shippingApprovalPolicy,
    );
    if (parsed === null) {
      return { kind: 'needs_decision', reply: SHIPPING_DECISION_GRAMMAR };
    }

    const customerState = await this.conversationStore.get(target.customerId);
    const pendingMarker = readPendingHumanRequest(customerState);
    if (!pendingMarker || pendingMarker.requestId !== target.id) {
      return opsError;
    }

    const pin = digest.draftCreatedAt;
    const now = Date.now();
    const verdict = this.shippingApprovalPolicy.verifyDraftPin(
      customerState,
      pin,
      now,
    );
    if (verdict.kind === 'valid') {
      const decidedAt = new Date(now).toISOString();
      let afterMarker: ConversationState | null;
      try {
        afterMarker = await setShippingApprovalMarker(
          this.conversationStore,
          target.customerId,
          customerState,
          {
            requestId: target.id,
            draftCreatedAt: pin,
            decision: parsed.decision,
            decidedAt,
          } satisfies ShippingApprovalMarker,
          decidedAt,
        );
      } catch {
        afterMarker = null;
      }
      if (afterMarker === null) {
        return opsError;
      }

      const resolution: HumanHandoffResolution = {
        decision: parsed.decision,
        draftCreatedAt: pin,
      };
      let resolved: HumanHandoffRequest | null;
      try {
        resolved = await this.store.resolve(target.id, resolution);
      } catch {
        resolved = null;
      }
      if (!resolved) {
        // No cross-store transaction: best-effort marker compensation; a
        // failure here is swallowed so it never surfaces as a rejection.
        try {
          await clearShippingApprovalMarker(
            this.conversationStore,
            target.customerId,
            afterMarker,
          );
        } catch {
          // Best-effort only.
        }
        return opsError;
      }

      let cleared: ConversationState | null;
      try {
        cleared = await clearPendingHumanRequest(
          this.conversationStore,
          target.customerId,
          afterMarker,
        );
      } catch {
        cleared = null;
      }
      if (cleared === null) {
        return opsError;
      }

      return {
        kind: 'resolved',
        customerId: target.customerId,
        ref: `HF-${target.id}`,
        resolution,
        syntheticUserText: formatResolutionAsUserTurn(target, resolution),
      };
    }

    const expired: HumanHandoffResolution = {
      decision: 'SHIPPING_EXPIRED',
      draftCreatedAt: pin,
      reason: verdict.kind,
    };
    let stale: HumanHandoffRequest | null;
    try {
      stale = await this.store.resolve(target.id, expired);
    } catch {
      stale = null;
    }
    if (!stale) {
      return opsError;
    }
    try {
      await clearPendingHumanRequest(
        this.conversationStore,
        target.customerId,
        customerState,
      );
    } catch {
      return opsError;
    }
    return { kind: 'needs_requote', reply: SHIPPING_REQUOTE_REPLY };
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

/** Strict anchored grammar: tokenless = exact command; with ref = only
 *  `HF-<id>: <command>` (i, outer-whitespace tolerant). Command parsed ONLY
 *  via `policy.parseDecision`; wrong/multiple/embedded refs, extra colon,
 *  prose, reasons, suffixes, coercible non-strings → null. */
function parseShippingGrammar(
  text: unknown,
  targetId: string,
  policy: ShippingApprovalPolicy,
): ShippingApprovalDecision | null {
  if (typeof text !== 'string') return null;
  if (!/\bHF-[A-Za-z0-9_-]{4,32}\b/i.test(text)) {
    return policy.parseDecision(text.trim());
  }
  const escaped = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*HF-${escaped}\\s*:\\s*(.+?)\\s*$`, 'i').exec(
    text,
  );
  return match ? policy.parseDecision(match[1]) : null;
}

/** Canonical ISO: equal to its own round-tripped `toISOString()`. */
function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return false;
  try {
    return new Date(ms).toISOString() === value;
  } catch {
    return false;
  }
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
