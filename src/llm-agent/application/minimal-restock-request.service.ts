/**
 * WU-A bounded Spanish RESTOCK confirmation gate: the ONLY customer-consent
 * boundary for a RESTOCK query already grounded by a fresh trusted `getStock`.
 * `prepare` offers one natural question after canonical validation and never
 * writes; `consume` turns a strict, sender-bound, armed, unexpired, new-message
 * affirmative into exactly ONE existing `runRestockRoute` attempt whose
 * reservation/ledger/idempotency stays the sole write authority. Exact SÍ/NO
 * stay deterministic; any other genuine reply is resolved by an optional
 * semantic seam (accept|decline|unclear) against the EXACT sent question, while
 * an unclear, missing or failed classification keeps the pending and asks for a
 * natural clarification. Pending state is in-memory (one per sender, 5-minute
 * TTL) and is lost on restart.
 */
import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { StockCheckResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  CatalogSession,
  DISPLAY_BREAKING,
} from '../../conversation/domain/catalog-references';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import {
  bindRestockInboundEvent,
  type RestockInboundEventIdentity,
} from '../../human-decisions/domain/restock-source-identity';
import { runRestockRoute } from '../../sale-flow/application/tools/request-human-assistance.tool';
import type { RestockToolCapability } from '../../sale-flow/application/tool-deps';
import { parseShippingCustomerDecision } from '../../shipping/application/shipping-customer-decision';

export const MINIMAL_RESTOCK_PENDING_TTL_MS = 5 * 60 * 1000;
export const MINIMAL_RESTOCK_AMBIGUOUS_REPLY =
  'Por ahora no puedo confirmar que su consulta haya quedado registrada.';
export const MINIMAL_RESTOCK_CLARIFY_REPLY =
  'Perdón, no estoy seguro de haberle entendido. ¿Quiere que consulte si hay ' +
  'una fecha estimada de reposición?';
/** Bounded per-pending memo of already-classified message ids. */
export const MINIMAL_RESTOCK_SEEN_MAX = 16;
export type RestockReplyVerdict = 'accept' | 'decline' | 'unclear';
/** Task-only classification of the current reply against the sent question. */
export type RestockReplyClassifier = (
  question: string,
  reply: string,
) => Promise<RestockReplyVerdict>;
const DECLINE_REPLY =
  'Entendido, no registraré su consulta de reposición. ¡Gracias!';
const confirmed = (l: string) =>
  `¡Listo! 😊 Ya quedó registrada su consulta sobre la reposición de «${l}». ¡Gracias!`;
const already = (l: string) =>
  `Su consulta sobre la reposición de «${l}» ya estaba registrada. ¡Gracias!`;
const proposal = (l: string) =>
  `Por ahora no tenemos «${l}» 😕. ¿Quiere que consulte si hay una fecha ` +
  `estimada de reposición?`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_BYTES = 2048;
// RESTOCK-LOCAL bounded consent: the strict shipping decision first, then
// exactly one polite affirmative form. No substring, NLP or model inference;
// every other text (including a polite "NO, por favor") stays `null`.
const POLITE_AFFIRMATIVE = /^(?:si|sí),?[ \t]+por[ \t]+favor\.?$/i;
const OUTER_SPACING = /^[ \t]+|[ \t]+$/g;
const NEWLINES = /[\r\n]/;

function parseRestockDecision(raw: unknown): 'accept' | 'decline' | null {
  const strict = parseShippingCustomerDecision(raw);
  if (strict !== null) return strict;
  if (typeof raw !== 'string' || NEWLINES.test(raw)) return null;
  return POLITE_AFFIRMATIVE.test(raw.replace(OUTER_SPACING, ''))
    ? 'accept'
    : null;
}

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

/**
 * Closed categorical cause for a rejected preparation; class-controlled
 * literals only, never derived from an exception, ID, status or raw input.
 */
export type MinimalRestockClosedReason =
  | 'disabled'
  | 'identity_unbound'
  | 'invalid_reference'
  | 'unknown_product'
  | 'stock_read_failed'
  | 'subject_mismatch'
  | 'parent_not_depleted'
  | 'unexpected_variant'
  | 'variant_required'
  | 'variant_unresolved'
  | 'variant_not_depleted'
  | 'catalog_unresolved'
  | 'display_unsafe_or_ambiguous'
  | 'preparation_failed';

export type MinimalRestockPrepareResult =
  | {
      readonly kind: 'offer';
      readonly reply: string;
      /** Arms the pending ONLY after the transport accepted the question. */
      readonly onSent: () => void;
    }
  | { readonly kind: 'closed'; readonly reason: MinimalRestockClosedReason };

export interface MinimalRestockConsumeInput {
  readonly senderId: string;
  readonly text: string;
  readonly inboundEvent?: unknown;
  /** Optional semantic seam; absent means no inference (fail closed). */
  readonly classify?: RestockReplyClassifier;
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
  /** Bounded memo of message ids already sent to the classifier. */
  readonly seen: Set<string>;
  armed: boolean;
}

/**
 * The trusted GET must read the EXACT requested subject as fully depleted;
 * otherwise it returns the closed reason (`null` means a valid shortage).
 */
function shortageReason(
  stock: StockCheckResponse,
  productId: string,
  variantId: string | null,
): MinimalRestockClosedReason | null {
  if (stock.productId !== productId) return 'subject_mismatch';
  if (stock.stock.status !== 'out_of_stock' || stock.stock.quantity !== 0) {
    return 'parent_not_depleted';
  }
  if (stock.variants.length === 0) {
    return variantId === null ? null : 'unexpected_variant';
  }
  if (variantId === null) return 'variant_required';
  const hit = stock.variants.filter((v) => v.variantId === variantId);
  if (hit.length !== 1) return 'variant_unresolved';
  if (hit[0].stock.status !== 'out_of_stock' || hit[0].stock.quantity !== 0) {
    return 'variant_not_depleted';
  }
  return null;
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
    const closed = (
      reason: MinimalRestockClosedReason,
    ): MinimalRestockPrepareResult => ({ kind: 'closed', reason });
    try {
      const restock = this.deps.restock;
      const senderId = input.senderId;
      const variantId = input.variantId ?? null;
      const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
      if (restock === undefined || restock.enabled !== true) {
        return closed('disabled');
      }
      if (bound === null) return closed('identity_unbound');
      if (!UUID.test(input.productId)) return closed('invalid_reference');
      if (variantId !== null && !UUID.test(variantId)) {
        return closed('invalid_reference');
      }
      if (!input.allowedProductIds.has(input.productId)) {
        return closed('unknown_product');
      }
      let stock: StockCheckResponse;
      try {
        stock = await this.deps.chatbotApi.getStock(input.productId);
      } catch {
        return closed('stock_read_failed');
      }
      const depletion = shortageReason(stock, input.productId, variantId);
      if (depletion !== null) return closed(depletion);
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
      if (resolved === null) return closed('catalog_unresolved');
      const presentation = presentationLabel(resolved, stock);
      if (presentation === null) {
        return closed('display_unsafe_or_ambiguous');
      }
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
        seen: new Set<string>(),
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
      return closed('preparation_failed');
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
      const decision = parseRestockDecision(input.text);
      const bound = bindRestockInboundEvent(input.inboundEvent, senderId);
      const event = bound?.event;
      const trusted =
        event?.receivingPhoneNumberId === pending.originPhoneNumberId;
      const replay = event?.messageId === pending.originMessageId;
      const expired = this.clock() >= pending.expiresAt;
      // Expiry always clears the slot; it never authorizes a write.
      if (expired) this.pending.delete(senderId);
      const ambiguous: MinimalRestockConsumeResult = {
        kind: 'handled',
        reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY,
      };
      const clarification: MinimalRestockConsumeResult = {
        kind: 'handled',
        reply: MINIMAL_RESTOCK_CLARIFY_REPLY,
      };
      if (decision !== null) {
        // A verdict counts only on the trusted, fresh turn.
        if (expired || !trusted || event === undefined) return ambiguous;
        // An already-classified message can never be re-read as a verdict.
        if (pending.seen.has(event.messageId)) return clarification;
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
        return await this.write(senderId, pending, event);
      }
      // Non-exact text: only a trusted, fresh, armed, non-replay turn is
      // interpretable; every other turn stays unhandled with no stale consent.
      if (expired || !trusted || event === undefined || replay) return null;
      if (!pending.armed) return null;
      return await this.classifyReply(input, senderId, pending, event);
    } catch {
      return { kind: 'handled', reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY };
    }
  }

  /**
   * Semantic fallback for ONE genuine reply to the sent question. Fail closed:
   * a missing seam, exhausted per-pending budget, classifier failure or
   * malformed output keeps the pending and returns a natural clarification.
   * The message id is memoized BEFORE the await, so a concurrent or replayed
   * turn can never change an already-issued verdict; after the await the SAME
   * pending must still be armed and unexpired or the turn fails closed.
   */
  private async classifyReply(
    input: MinimalRestockConsumeInput,
    senderId: string,
    pending: PendingRestock,
    event: RestockInboundEventIdentity,
  ): Promise<MinimalRestockConsumeResult> {
    const clarification: MinimalRestockConsumeResult = {
      kind: 'handled',
      reply: MINIMAL_RESTOCK_CLARIFY_REPLY,
    };
    if (pending.seen.has(event.messageId)) return clarification;
    if (pending.seen.size >= MINIMAL_RESTOCK_SEEN_MAX) return clarification;
    // Memoize BEFORE the seam check: a no-seam clarification must also block a
    // redelivery of the same event from gaining permission with a new seam.
    pending.seen.add(event.messageId);
    const classify = input.classify;
    if (classify === undefined) return clarification;
    let verdict: RestockReplyVerdict;
    try {
      verdict = await classify(pending.proposal, input.text);
    } catch {
      return clarification;
    }
    // Revalidate the SAME pending: replacement, expiry or disarm since the
    // await fails closed and never writes.
    if (
      this.pending.get(senderId) !== pending ||
      !pending.armed ||
      this.clock() >= pending.expiresAt
    ) {
      return clarification;
    }
    if (verdict === 'decline') {
      this.pending.delete(senderId);
      return { kind: 'handled', reply: DECLINE_REPLY };
    }
    if (verdict !== 'accept') return clarification;
    // Consume BEFORE awaiting so a concurrent accept cannot double-write.
    this.pending.delete(senderId);
    return await this.write(senderId, pending, event);
  }

  /** Runs the ONE existing deterministic RESTOCK route for the consumed turn. */
  private async write(
    senderId: string,
    pending: PendingRestock,
    event: RestockInboundEventIdentity,
  ): Promise<MinimalRestockConsumeResult> {
    const restock = this.deps.restock;
    if (restock === undefined || restock.enabled !== true) {
      return { kind: 'handled', reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY };
    }
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
    return { kind: 'handled', reply: MINIMAL_RESTOCK_AMBIGUOUS_REPLY };
  }
}
