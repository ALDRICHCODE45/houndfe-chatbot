/**
 * Cart-conversation binding for the minimal SDK route (S1-S6).
 *
 * The model names a product/presentation conversationally, but it never
 * supplies a cart UUID. This module owns one sender's per-run cart state:
 *
 *   - an opaque `MinimalCartSelections` registry of server-verified
 *     (product, optional variant) pairs, rebuilt from a persisted snapshot;
 *   - a single grounded `pending` intent (product + operation + optional
 *     count) that may carry an explicit quantity into the same request.
 *
 * Its only jobs are to resolve an opaque reference to a verified identity,
 * ground a proposed operation/quantity against the CURRENT user text, and
 * remember or clear the pending intent. It performs NO cart write: the caller
 * maps a grounded intent onto the domain cart API, so variant ownership,
 * quoting, CAS and the persisted cart format stay in the existing service.
 *
 * OpenAI strict tool schemas live here too: every field is required and
 * nullable rather than optional, and no price, sender or raw snapshot field is
 * ever accepted from the model.
 */
import { z } from 'zod';
import {
  MinimalCartSelections,
  type MinimalCartSelectionIdentity,
  type MinimalCartSelectionSnapshot,
} from '../domain/minimal-cart-selections';
import {
  addRequestForm,
  asksCartChoice,
  cartWords,
  conversationalAddForm,
  distinctiveMatches,
  mentionsPhrase,
  nameCoverage,
  requestsCartChange,
  statedUnitCount,
} from '../domain/minimal-cart-request';
import {
  groundCartQuantity,
  type MinimalCartQuantityIntent,
  type CartOperation,
  type CartQuantityRejectionReason,
  type CartQuantityEvidenceDetail,
  type CartQuantityGroundingResult,
  type MinimalCartPendingRequest,
} from '../domain/minimal-cart-quantity';

/** Only existing cart lines to retain; an empty-cart command is not supported. */
export const cartKeepOnlyToolInput = z.strictObject({
  keepSelectionRefs: z.array(z.string().min(1)).min(1).max(20),
});

/** Required-nullable transport shape for `setCartItem` (total quantity). */
export const cartSetToolInput = z.strictObject({
  selectionRef: z.string().min(1),
  quantity: z.number().int().nullable(),
  quantityText: z.string().nullable(),
  continuation: z.boolean(),
});

/** Required-nullable transport shape for `adjustCartItem` (signed delta). */
export const cartAdjustToolInput = z.strictObject({
  selectionRef: z.string().min(1),
  delta: z.number().int().nullable(),
  quantityText: z.string().nullable(),
  continuation: z.boolean(),
});

/** Required-nullable transport shape for `prepareCartItem` (no mutation). */
export const cartPrepareToolInput = z.strictObject({
  selectionRef: z.string().min(1),
  operation: z.enum(['add', 'set', 'subtract', 'remove']),
  quantity: z.number().int().nullable(),
  quantityText: z.string().nullable(),
  continuation: z.boolean(),
});

/** Cart tool names whose malformed input must fail closed, never echo the model. */
export const CART_TOOL_NAMES: ReadonlySet<string> = new Set([
  'getCart',
  'keepOnlyCartItems',
  'setCartItem',
  'adjustCartItem',
  'prepareCartItem',
]);

/** Server-controlled quantity question; the model's own claim never substitutes. */
export const CART_QUANTITY_QUESTION =
  '¿Cuántas unidades desea agregar? Dígame un número, por favor.';

/** A grounded parent quantity is prepared, but its presentation is not chosen. */
export const CART_PRESENTATION_QUESTION = '¿Qué presentación desea agregar?';

/** States the one unit a countless "agrégalo"/"sí" to a cart offer added. */
export const CART_DEFAULT_UNIT_NOTE =
  'Le agregué 1 unidad; si desea otra cantidad, dígame cuántas.';

/** Server-controlled fail-closed reply for a citation/consistency rejection. */
export const CART_OPERATION_CLARIFICATION =
  'No pude confirmar esa operación con la información de su mensaje. No modifiqué el carrito; ¿puede indicarme de nuevo qué desea?';

/** Server-controlled reply for an unknown/expired selection reference. */
export const CART_UNKNOWN_REFERENCE_REPLY =
  'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.';

/** A verified identity resolved from an opaque reference, with that reference. */
export type ResolvedCartSelection = MinimalCartSelectionIdentity & {
  reference: string;
};

/** A stored cart line's identity (no prices), read from the persisted cart. */
export type CartLineIdentity = { productId: string; variantId?: string };

/** The customer's side of the dialogue the request answers. */
export type CartDialogue = {
  /** Text of the bot's previous message, or `null`. */
  previousAssistantText: string | null;
  /** The customer's earlier messages, oldest first (current one excluded). */
  recentCustomerTexts: readonly string[];
};

type CartProposal = {
  operation: CartOperation;
  quantity: number | null;
  quantityText: string | null;
  continuation: boolean;
};

/**
 * A grounding outcome bound to the selection the write must target (a parent
 * reference may resolve to the presentation the customer named). `defaulted`
 * marks the one unit of a countless "agrégalo"/"sí" that the reply must state.
 */
export type CartGrounding =
  | {
      kind: 'ready';
      intent: MinimalCartQuantityIntent;
      selection: ResolvedCartSelection;
      defaulted: boolean;
    }
  | { kind: 'quantity_required'; intent: MinimalCartQuantityIntent }
  | { kind: 'invalid_evidence' }
  | { kind: 'target_required'; question: string };

type Target =
  | { kind: 'ok'; selection: ResolvedCartSelection }
  | { kind: 'ask'; question: string };

/** A product line is "named" in a text from this share of its name words. */
const NAME_COVERAGE = 0.6;
const MAX_OPTIONS = 6;

/** Customer words that turn a count into the line TOTAL ("cambia a 2"). */
const SET_WORDS: ReadonlySet<string> = new Set([
  'cambia',
  'cambiar',
  'cambiala',
  'cambialo',
  'cambiame',
  'deja',
  'dejame',
  'dejala',
  'dejalo',
  'ajusta',
  'total',
]);

const joinOptions = (options: readonly string[]): string =>
  options.length === 1
    ? options[0]
    : `${options.slice(0, -1).join(', ')} o ${options[options.length - 1]}`;

/** Server-owned question when several shown products could be meant. */
export function cartProductQuestion(names: readonly string[]): string {
  return names.length === 0
    ? '¿A cuál producto se refiere? Dígame el nombre del producto, por favor. No modifiqué el carrito.'
    : `¿A cuál producto se refiere: ${joinOptions(names.slice(0, MAX_OPTIONS))}? No modifiqué el carrito.`;
}

/** Server-owned presentation question listing the verified options. */
export function cartPresentationQuestion(labels: readonly string[]): string {
  return labels.length === 0
    ? CART_PRESENTATION_QUESTION
    : `¿Qué presentación desea agregar: ${joinOptions(labels.slice(0, MAX_OPTIONS))}? No modifiqué el carrito.`;
}

/** Display label of a presentation: its name without the product prefix. */
function presentationLabel(selection: MinimalCartSelectionIdentity): string {
  const name = selection.variantName;
  if (name === undefined) return '';
  return name.startsWith(selection.productName)
    ? name.slice(selection.productName.length).trim()
    : name;
}

/**
 * One sender's cart conversation for a single SDK run. The registry snapshot
 * and pending intent are supplied by the caller and read back through
 * `snapshot()` / `pendingIntent` for persistence.
 */
export class MinimalCartConversation {
  private rejection: CartQuantityRejectionReason | null = null;
  private detail: CartQuantityEvidenceDetail = 'none';

  /** Closed private subcode; no literal evidence or count values. */
  get evidenceDetail(): CartQuantityEvidenceDetail {
    return this.detail;
  }

  /** Closed reason for the last grounding attempt; no customer data. */
  get rejectionReason(): CartQuantityRejectionReason | null {
    return this.rejection;
  }

  constructor(
    private readonly selections: MinimalCartSelections,
    private readonly text: string,
    private pending: MinimalCartPendingRequest | null,
    private readonly dialogue: CartDialogue = {
      previousAssistantText: null,
      recentCustomerTexts: [],
    },
  ) {}

  /** Detached copy of the pending intent, or `null` when none is armed. */
  get pendingIntent(): MinimalCartPendingRequest | null {
    return this.pending === null ? null : { ...this.pending };
  }

  /** Resolve an opaque reference to a verified identity, or `null`. */
  resolve(reference: string): ResolvedCartSelection | null {
    return this.selections.resolve(reference);
  }

  /**
   * Retain a server-verified identity and return its opaque reference, or
   * `null` when it is malformed or the bounded registry is full.
   */
  register(identity: MinimalCartSelectionIdentity): string | null {
    return this.selections.register(identity);
  }

  /**
   * Ground a `setCartItem`/`adjustCartItem` proposal. Never writes the cart,
   * but a `quantity_required` outcome records a no-count pending request bound
   * to the chosen identity/reference so a later explicit quantity can target
   * the same line instead of reconstructing dropped tool messages.
   *
   * The strict citation rules decide first. Only when they reject for missing
   * evidence (or ask for a count) does the conversational reading apply: a
   * single count in the customer's words, the pending count, or one unit for
   * a countless "agrégalo"/"sí" to a cart offer — and then only when the
   * target product and presentation are unambiguous from the conversation.
   */
  ground(
    selection: ResolvedCartSelection,
    proposal: CartProposal,
    cartLines: readonly CartLineIdentity[] = [],
  ): CartGrounding {
    const strict = this.groundStrict(selection, proposal);
    let result: CartGrounding;
    if (strict.kind === 'ready') {
      result = {
        kind: 'ready',
        intent: strict.intent,
        // Strict path: only a presentation the customer named (or the
        // pending one) upgrades a parent reference; never a cart guess.
        selection: this.namedPresentation(selection, []) ?? selection,
        defaulted: false,
      };
    } else if (
      proposal.operation === 'remove' ||
      (strict.kind === 'invalid_evidence' &&
        this.rejection !== 'evidence_rejected')
    ) {
      result = strict;
    } else {
      result = this.rescue(selection, proposal, cartLines) ?? strict;
    }
    if (result.kind === 'quantity_required') {
      this.pending = {
        productId: selection.productId,
        productName: selection.productName,
        operation: result.intent.operation,
        ...(selection.variantId === undefined
          ? {}
          : { variantId: selection.variantId }),
        ...(selection.variantName === undefined
          ? {}
          : { variantName: selection.variantName }),
        reference: selection.reference,
      };
    }
    return result;
  }

  /**
   * True when the selection is a final cart line: a presentation, or a
   * product with no verified presentations.
   */
  isFinalSelection(selection: ResolvedCartSelection): boolean {
    return (
      selection.variantId !== undefined ||
      this.variantsOf(selection.productId).length === 0
    );
  }

  /** Presentation question for a product, listing its verified options. */
  presentationQuestion(productId: string): string {
    return cartPresentationQuestion(
      this.variantsOf(productId)
        .map(presentationLabel)
        .filter((label) => label.length > 0),
    );
  }

  private groundStrict(
    selection: ResolvedCartSelection,
    proposal: CartProposal,
  ): CartQuantityGroundingResult {
    this.rejection = null;
    this.detail = 'none';
    return groundCartQuantity({
      onRejection: (reason, detail) => {
        this.rejection = reason;
        this.detail = detail;
      },
      text: this.text,
      productId: selection.productId,
      productName: selection.productName,
      ...(selection.variantName === undefined
        ? {}
        : { variantName: selection.variantName }),
      operation: proposal.operation,
      quantity: proposal.quantity,
      quantityText: proposal.quantityText,
      ...(this.pending === null ? {} : { pending: this.pending }),
      continuation: proposal.continuation,
    });
  }

  private rescue(
    selection: ResolvedCartSelection,
    proposal: CartProposal,
    cartLines: readonly CartLineIdentity[],
  ): CartGrounding | null {
    const presentationNumbers = new Set(
      this.variantsOf(selection.productId).flatMap((variant) =>
        cartWords(presentationLabel(variant)).filter((word) =>
          /^\d+$/.test(word),
        ),
      ),
    );
    const count = statedUnitCount(this.text, presentationNumbers);
    if (count.status === 'ambiguous') return null;
    let operation = proposal.operation;
    let quantity: number | undefined;
    let defaulted = false;
    if (count.status === 'ok') {
      if (
        proposal.quantity !== null &&
        Math.abs(proposal.quantity) !== count.value
      )
        return null;
      if (
        operation === 'add' &&
        cartWords(this.text).some((word) => SET_WORDS.has(word))
      )
        operation = 'set';
      if (operation === 'set' ? count.value < 0 : count.value <= 0) return null;
      quantity = count.value;
    } else {
      if (operation === 'subtract') return null;
      const pending = this.pending;
      const form =
        conversationalAddForm(this.text, this.dialogue.previousAssistantText) ??
        this.answeredChoiceForm(selection.productId);
      if (
        pending !== null &&
        pending.productId === selection.productId &&
        typeof pending.quantity === 'number' &&
        pending.quantity > 0 &&
        (pending.operation === 'add' || pending.operation === 'set')
      ) {
        if (
          proposal.quantity !== null &&
          proposal.quantity !== pending.quantity
        )
          return null;
        operation = pending.operation;
        quantity = pending.quantity;
      } else if (form === null) {
        return null;
      } else {
        operation = 'add';
        // A countless singular request is one unit; a plural one or a model
        // number the customer never said asks for the count instead.
        if (
          form === 'singular' &&
          (proposal.quantity === null || proposal.quantity === 1)
        ) {
          quantity = 1;
          defaulted = true;
        }
      }
    }
    const target = this.resolveTarget(selection, cartLines);
    if (target.kind === 'ask')
      return { kind: 'target_required', question: target.question };
    const intent = { productId: selection.productId, operation };
    if (quantity === undefined) return { kind: 'quantity_required', intent };
    return {
      kind: 'ready',
      intent: { ...intent, quantity },
      selection: target.selection,
      defaulted,
    };
  }

  /**
   * The product and presentation must be unambiguous from the conversation:
   * the customer named it, it is the one product the bot just showed (or the
   * pending request / only cart line), and its presentation is the one the
   * customer chose, the bot showed alone, or the cart already holds.
   */
  private resolveTarget(
    selection: ResolvedCartSelection,
    cartLines: readonly CartLineIdentity[],
  ): Target {
    const productId = selection.productId;
    const products = this.registeredProducts();
    const previous = this.dialogue.previousAssistantText ?? '';
    const mentioned = this.shownProducts();
    const named =
      nameCoverage(this.text, selection.productName) >= NAME_COVERAGE;
    const askProduct = (names: string[]): Target => ({
      kind: 'ask',
      question: cartProductQuestion(names),
    });
    if (!named) {
      let inFocus: boolean;
      if (mentioned.length >= 2) {
        // Several shown: only the one the customer's own words single out.
        const picked = this.customerPick(mentioned);
        if (picked !== productId)
          return askProduct(mentioned.map(([, name]) => name));
        inFocus = true;
      } else if (this.pending?.productId === productId) inFocus = true;
      else if (mentioned.length === 1) inFocus = mentioned[0][0] === productId;
      else if (cartLines.length === 1)
        inFocus = cartLines[0].productId === productId;
      else if (products.size === 1) inFocus = products.has(productId);
      else {
        const scores = [...products].map(
          ([id, name]) => [id, nameCoverage(previous, name)] as const,
        );
        const best = Math.max(0, ...scores.map(([, score]) => score));
        const top = scores.filter(([, score]) => score === best);
        inFocus = best > 0 && top.length === 1 && top[0][0] === productId;
      }
      if (!inFocus) return askProduct([]);
    }
    const variants = this.variantsOf(productId);
    if (variants.length === 0)
      return selection.variantId === undefined
        ? { kind: 'ok', selection }
        : { kind: 'ask', question: this.presentationQuestion(productId) };
    const chosen = this.namedPresentation(selection, cartLines, true);
    if (
      chosen !== null &&
      (selection.variantId === undefined ||
        chosen.variantId === selection.variantId)
    )
      return { kind: 'ok', selection: chosen };
    return { kind: 'ask', question: this.presentationQuestion(productId) };
  }

  /** Distinct registered products, in registration order. */
  private registeredProducts(): Map<string, string> {
    const products = new Map<string, string>();
    for (const entry of this.selections.snapshot().selections)
      if (!products.has(entry.productId))
        products.set(entry.productId, entry.productName);
    return products;
  }

  /** Registered products the bot's previous message named. */
  private shownProducts(): Array<[string, string]> {
    const previous = this.dialogue.previousAssistantText ?? '';
    return [...this.registeredProducts()].filter(
      ([, name]) => nameCoverage(previous, name) >= NAME_COVERAGE,
    );
  }

  /**
   * The shown product the customer's words single out, newest message first:
   * the first message that singles out exactly one decides; one that matches
   * several, or none at all, leaves it open (`null`).
   */
  private customerPick(shown: ReadonlyArray<[string, string]>): string | null {
    const candidates = shown.map(([id, name]) => ({
      name,
      labels: this.variantsOf(id)
        .map(presentationLabel)
        .filter((label) => label.length > 0),
    }));
    for (const text of [
      this.text,
      ...[...this.dialogue.recentCustomerTexts].reverse(),
    ]) {
      const matches = distinctiveMatches(text, candidates);
      if (matches.length === 1) return shown[matches[0]][0];
      if (matches.length > 1) return null;
    }
    return null;
  }

  /**
   * The add form of the customer's earlier request when the current message
   * answers the server's "which product/presentation" question ("La de
   * sílice" after "Sí, agréguela"); `null` otherwise.
   */
  private answeredChoiceForm(productId: string): 'singular' | 'plural' | null {
    // Only the server "which product" question, and only for one of the
    // products it listed; a presentation question keeps asking the count.
    const previous = this.dialogue.previousAssistantText;
    if (previous === null || !mentionsPhrase(previous, 'a cual producto'))
      return null;
    if (!this.shownProducts().some(([id]) => id === productId)) return null;
    for (const text of [...this.dialogue.recentCustomerTexts].reverse()) {
      const form = addRequestForm(text);
      if (form === null) continue;
      // An earlier count belongs to the pending request, never a default.
      return statedUnitCount(text).status === 'none' ? form : null;
    }
    return null;
  }

  /**
   * True when the current message asks for a cart change: a count, an add
   * request, a change word, a registered product or presentation named, or an
   * answer that singles out one product of a pending "which product"
   * question. Cart tools on any other message ("Quiero comprar.") are not a
   * rejected cart request but a misplaced call.
   */
  hasCartRequest(): boolean {
    if (requestsCartChange(this.text, this.dialogue.previousAssistantText))
      return true;
    const selections = this.selections.snapshot().selections;
    if (
      selections.some(
        (entry) =>
          nameCoverage(this.text, entry.productName) >= NAME_COVERAGE ||
          (presentationLabel(entry).length > 0 &&
            mentionsPhrase(this.text, presentationLabel(entry))),
      )
    )
      return true;
    const shown = this.shownProducts();
    return (
      asksCartChoice(this.dialogue.previousAssistantText) &&
      shown.length >= 2 &&
      this.customerPick(shown) !== null
    );
  }

  /**
   * The product question to repeat while several products the bot just
   * listed are still open, or `null` when fewer than two are shown.
   */
  openProductQuestion(): string | null {
    const shown = this.shownProducts();
    return shown.length >= 2
      ? cartProductQuestion(shown.map(([, name]) => name))
      : null;
  }

  /**
   * The presentation of the selected product that the conversation fixes:
   * named in the current message, the pending request's, named alone in the
   * customer's recent messages, the only cart line of that product, or (with
   * `includeShown`) the only one the bot's previous message mentioned.
   * `null` when none or several qualify.
   */
  private namedPresentation(
    selection: ResolvedCartSelection,
    cartLines: readonly CartLineIdentity[],
    includeShown = false,
  ): ResolvedCartSelection | null {
    const variants = this.variantsOf(selection.productId);
    if (variants.length === 0) return null;
    const namedIn = (text: string) =>
      variants.filter((variant) => {
        const label = presentationLabel(variant);
        return label.length > 0 && mentionsPhrase(text, label);
      });
    const current = namedIn(this.text);
    if (current.length === 1) return current[0];
    if (current.length > 1) return null;
    if (
      this.pending?.productId === selection.productId &&
      this.pending.variantId !== undefined
    ) {
      const pendingVariant = this.pending.variantId;
      return (
        variants.find((variant) => variant.variantId === pendingVariant) ?? null
      );
    }
    for (const text of [...this.dialogue.recentCustomerTexts].reverse()) {
      const found = namedIn(text);
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    const lines = cartLines.filter(
      (line) =>
        line.productId === selection.productId && line.variantId !== undefined,
    );
    if (lines.length === 1)
      return (
        variants.find((variant) => variant.variantId === lines[0].variantId) ??
        null
      );
    if (!includeShown) return null;
    const shown = namedIn(this.dialogue.previousAssistantText ?? '');
    return shown.length === 1 ? shown[0] : null;
  }

  private variantsOf(productId: string): ResolvedCartSelection[] {
    return this.selections
      .snapshot()
      .selections.filter(
        (entry) =>
          entry.productId === productId && entry.variantId !== undefined,
      );
  }

  /**
   * Ground a `prepareCartItem` proposal and, when it is fully grounded, record
   * it as the pending intent for the same request. A preparation is not a
   * mutation and never produces a cart write.
   */
  prepare(
    selection: ResolvedCartSelection,
    proposal: CartProposal,
    cartLines: readonly CartLineIdentity[] = [],
  ): CartGrounding {
    const result = this.ground(selection, proposal, cartLines);
    if (result.kind === 'ready') {
      const chosen = result.selection;
      this.pending = {
        ...result.intent,
        productName: chosen.productName,
        ...(chosen.variantId === undefined
          ? {}
          : { variantId: chosen.variantId }),
        ...(chosen.variantName === undefined
          ? {}
          : { variantName: chosen.variantName }),
        reference: chosen.reference,
      };
    }
    return result;
  }

  /** Disarm the pending intent; called after an actual mutation attempt. */
  clearPending(): void {
    this.pending = null;
  }

  /** Detached, serializable registry snapshot for persistence. */
  snapshot(): MinimalCartSelectionSnapshot {
    return this.selections.snapshot();
  }
}
