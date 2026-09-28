/**
 * WU-A bounded Spanish RESTOCK confirmation gate: the ONLY customer-consent
 * boundary for a RESTOCK query already grounded by a fresh trusted `getStock`.
 * `prepare` offers one explicit SÍ/NO question after canonical validation and
 * never writes; `consume` turns a strict, sender-bound, armed, unexpired,
 * new-message affirmative into exactly ONE existing `runRestockRoute` attempt
 * whose reservation/ledger/idempotency stays the sole write authority. Pending
 * state is in-memory (one per sender, 5-minute TTL) and is lost on restart.
 */
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  CatalogSession,
  DISPLAY_BREAKING,
} from '../../conversation/domain/catalog-references';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { bindRestockInboundEvent } from '../../human-decisions/domain/restock-source-identity';
import { runRestockRoute } from '../../sale-flow/application/tools/request-human-assistance.tool';
import type { RestockToolCapability } from '../../sale-flow/application/tool-deps';
import { parseShippingCustomerDecision } from '../../shipping/application/shipping-customer-decision';

export const MINIMAL_RESTOCK_PENDING_TTL_MS = 5 * 60 * 1000;
export const MINIMAL_RESTOCK_AMBIGUOUS_REPLY =
  'Por ahora no puedo confirmar que su consulta haya quedado registrada.';
const DECLINE_REPLY = 'Entendido, no registraré la consulta de reposición.';
const confirmed = (l: string) =>
  `Ya quedó registrada su consulta sobre cuándo tendremos «${l}» de nuevo.`;
const already = (l: string) => `Su consulta sobre «${l}» ya estaba registrada.`;
const proposal = (l: string) =>
  `¿Quiere que registre una consulta sobre la reposición de «${l}»? Responda SÍ o NO.`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_BYTES = 2048;

export interface MinimalRestockDeps {
  readonly chatbotApi: ChatbotApiClient;
  readonly store: ConversationStore;
  readonly restock?: RestockToolCapability;
  /** Test seam; production uses `Date.now`. */
  readonly clock?: () => number;
}

export interface MinimalRestockPrepareInput {
  readonly senderId: string;
  readonly inboundEvent: unknown;
  readonly allowedProductIds: ReadonlySet<string>;
  readonly productId: string;
  readonly variantId?: string;
}

export type MinimalRestockPrepareResult =
  | {
      readonly kind: 'offer';
      readonly reply: string;
      /** Arms the pending ONLY after the transport accepted the question. */
      readonly onSent: () => void;
    }
  | { readonly kind: 'closed' };

export interface MinimalRestockConsumeInput {
  readonly senderId: string;
  readonly text: string;
  readonly inboundEvent?: unknown;
}

export type MinimalRestockConsumeResult = {
  readonly kind: 'handled';
  readonly reply: string;
  /**
   * Present ONLY for the origin-question replay: arms the SAME pending after
   * the transport accepted the re-sent question, so a failed initial send can
   * still be armed by a successful resend.
   */
  readonly onSent?: () => void;
} | null;

interface PendingRestock {
  readonly originPhoneNumberId: string;
  readonly originMessageId: string;
  readonly expiresAt: number;
  readonly session: CatalogSession;
  readonly digest: {
    readonly productId: string;
    readonly name: string;
    readonly variantId?: string;
  };
  readonly presentation: string;
  readonly proposal: string;
  armed: boolean;
}

/** The trusted GET must read the EXACT requested subject as fully depleted. */
function isShortage(
  stock: StockCheckResponse,
  productId: string,
  variantId: string | null,
): boolean {
  if (stock.productId !== productId) return false;
  if (stock.stock.status !== 'out_of_stock' || stock.stock.quantity !== 0) {
    return false;
  }
  if (stock.variants.length === 0) return variantId === null;
  if (variantId === null) return false;
  const hit = stock.variants.filter((v) => v.variantId === variantId);
  return (
    hit.length === 1 &&
    hit[0].stock.status === 'out_of_stock' &&
    hit[0].stock.quantity === 0
  );
}

/**
 * Final rendered label for ONE trusted variant, before display gating: a
 * repeated name adds option/value; an empty detail cannot disambiguate.
 * Uniqueness is NOT decided here — `presentationLabel` compares every
 * rendered label globally, so identically rendered variants alias there.
 */
function renderVariant(
  productName: string,
  stock: StockCheckResponse,
  variantId: string,
): string | null {
  const seen = stock.variants.filter((v) => v.variantId === variantId);
  if (seen.length !== 1) return null;
  const v = seen[0];
  const sameName = stock.variants.filter((x) => x.name === v.name);
  if (sameName.length <= 1) {
    return `${productName} (${v.name})`;
  }
  const detail = [v.option, v.value]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' ');
  if (detail.length === 0) return null;
  return `${productName} (${v.name}: ${detail})`;
}

/**
 * Display label from TRUSTED names only: the selected variant is unofferable
 * when its FULL rendered label aliases the rendered label of ANY other variant
 * — a unique raw name that renders like a repeated name plus detail, or two
 * option/value tuples that join identically, still fails closed within the
 * existing UTF-8 byte bound. Unselected variants aliasing each other do not by
 * themselves disqualify a distinct selection.
 */
function presentationLabel(
  resolved: { productName: string; variantId: string | null },
  stock: StockCheckResponse,
): string | null {
  let label = resolved.productName;
  if (resolved.variantId !== null) {
    const rendered = renderVariant(
      resolved.productName,
      stock,
      resolved.variantId,
    );
    if (rendered === null) return null;
    label = rendered;
    const aliases = stock.variants.some(
      (x) =>
        x.variantId !== resolved.variantId &&
        renderVariant(resolved.productName, stock, x.variantId) === label,
    );
    if (aliases) return null;
  }
  if (DISPLAY_BREAKING.test(label)) return null;
  return Buffer.byteLength(label, 'utf8') <= MAX_LABEL_BYTES ? label : null;
}

export class MinimalRestockRequestService {
  private readonly clock: () => number;
  private readonly pending = new Map<string, PendingRestock>();

  constructor(private readonly deps: MinimalRestockDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.deps.restock?.enabled === true;
  }

  async prepare(
    input: MinimalRestockPrepareInput,
  ): Promise<MinimalRestockPrepareResult> {
    try {
      const restock = this.deps.restock;
      const senderId = input.senderId;
      const variantId = input.variantId ?? null;
      const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
      if (restock === undefined || restock.enabled !== true) {
        return { kind: 'closed' };
      }
      if (bound === null) return { kind: 'closed' };
      if (!UUID.test(input.productId)) return { kind: 'closed' };
      if (variantId !== null && !UUID.test(variantId)) {
        return { kind: 'closed' };
      }
      if (!input.allowedProductIds.has(input.productId)) {
        return { kind: 'closed' };
      }
      const stock = await this.deps.chatbotApi.getStock(input.productId);
      if (!isShortage(stock, input.productId, variantId)) {
        return { kind: 'closed' };
      }
      const session = new CatalogSession(
        senderId,
        MINIMAL_RESTOCK_PENDING_TTL_MS,
        0,
        undefined,
        [],
        this.clock,
      );
      session.installSearch(session.beginSearch(), [stock]);
      const resolved = session.resolve({
        productId: input.productId,
        variantId,
      });
      if (resolved === null) return { kind: 'closed' };
      const presentation = presentationLabel(resolved, stock);
      if (presentation === null) return { kind: 'closed' };
      const base = {
        productId: resolved.productId,
        name: resolved.productName,
      };
      const digest =
        resolved.variantId === null
          ? base
          : { ...base, variantId: resolved.variantId };
      const question = proposal(presentation);
      const pending: PendingRestock = {
        originPhoneNumberId: bound.event.receivingPhoneNumberId,
        originMessageId: bound.event.messageId,
        expiresAt: this.clock() + MINIMAL_RESTOCK_PENDING_TTL_MS,
        session,
        digest,
        presentation,
        proposal: question,
        armed: false,
      };
      this.pending.set(senderId, pending);
      return {
        kind: 'offer',
        reply: question,
        onSent: () => {
          if (this.pending.get(senderId) === pending) pending.armed = true;
        },
      };
    } catch {
      return { kind: 'closed' };
    }
  }

  async consume(
    input: MinimalRestockConsumeInput,
  ): Promise<MinimalRestockConsumeResult> {
    try {
      const restock = this.deps.restock;
      if (restock === undefined || restock.enabled !== true) return null;
      const senderId = input.senderId;
      const pending = this.pending.get(senderId);
      if (pending === undefined) return null;
      const decision = parseShippingCustomerDecision(input.text);
      const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
      const event = bound?.event;
      const trusted =
        event?.receivingPhoneNumberId === pending.originPhoneNumberId;
      const replay = event?.messageId === pending.originMessageId;
      const expired = this.clock() >= pending.expiresAt;
      // Expiry always clears the slot; it never authorizes a write.
      if (expired) this.pending.delete(senderId);
      if (decision === null) {
        // Ordinary text: only a trusted, fresh turn on this pending may clear
        // stale consent; the ambiguous receipt is reserved for real verdicts.
        if (trusted && !replay && !expired) this.pending.delete(senderId);
        return null;
      }
      const ambiguous: MinimalRestockConsumeResult = {
        kind: 'handled',
        reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY,
      };
      // A verdict (SÍ or NO) counts only on the trusted, fresh, armed turn.
      if (expired || !trusted || event === undefined) return ambiguous;
      if (replay) {
        return {
          kind: 'handled',
          reply: pending.proposal,
          onSent: () => {
            if (this.pending.get(senderId) === pending) pending.armed = true;
          },
        };
      }
      if (!pending.armed) return ambiguous;
      if (decision === 'decline') {
        this.pending.delete(senderId);
        return { kind: 'handled', reply: DECLINE_REPLY };
      }
      // Consume the slot BEFORE awaiting so a concurrent turn cannot re-enter.
      this.pending.delete(senderId);
      const result = await runRestockRoute(
        { chatbotApi: this.deps.chatbotApi, store: this.deps.store },
        restock,
        pending.digest,
        {
          senderId,
          inboundEvent: event,
          catalogSession: pending.session,
        },
      );
      if (result.ok && result.outcome === 'historical_intake_recorded') {
        return { kind: 'handled', reply: confirmed(pending.presentation) };
      }
      if (result.ok && result.outcome === 'existing_restock_recorded') {
        return { kind: 'handled', reply: already(pending.presentation) };
      }
      return ambiguous;
    } catch {
      return { kind: 'handled', reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY };
    }
  }
}
