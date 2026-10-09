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
  groundCartQuantity,
  type CartOperation,
  type CartQuantityGroundingResult,
  type MinimalCartPendingRequest,
} from '../domain/minimal-cart-quantity';

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
  'setCartItem',
  'adjustCartItem',
  'prepareCartItem',
]);

/** Server-controlled quantity question; the model's own claim never substitutes. */
export const CART_QUANTITY_QUESTION =
  '¿Cuántas unidades desea agregar? Dígame un número, por favor.';

/** Server-controlled fail-closed reply for a citation/consistency rejection. */
export const CART_OPERATION_CLARIFICATION =
  'No pude confirmar esa operación con la información de su mensaje. No modifiqué el carrito; ¿puede indicarme de nuevo qué desea?';

/** Server-controlled reply for an unknown/expired selection reference. */
export const CART_UNKNOWN_REFERENCE_REPLY =
  'No pude completar esa operación del carrito. No confirmé ningún cambio; por favor, intente de nuevo.';

type GroundableSelection = {
  productId: string;
  productName: string;
  variantId?: string;
  variantName?: string;
  reference?: string;
};

/** A verified identity resolved from an opaque reference, with that reference. */
export type ResolvedCartSelection = MinimalCartSelectionIdentity & {
  reference: string;
};

type CartProposal = {
  operation: CartOperation;
  quantity: number | null;
  quantityText: string | null;
  continuation: boolean;
};

/**
 * One sender's cart conversation for a single SDK run. The registry snapshot
 * and pending intent are supplied by the caller and read back through
 * `snapshot()` / `pendingIntent` for persistence.
 */
export class MinimalCartConversation {
  constructor(
    private readonly selections: MinimalCartSelections,
    private readonly text: string,
    private pending: MinimalCartPendingRequest | null,
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
   */
  ground(
    selection: GroundableSelection,
    proposal: CartProposal,
  ): CartQuantityGroundingResult {
    const result = groundCartQuantity({
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
    if (result.kind === 'quantity_required') {
      this.pending = {
        productId: selection.productId,
        productName: selection.productName,
        operation: proposal.operation,
        ...(selection.variantId === undefined
          ? {}
          : { variantId: selection.variantId }),
        ...(selection.variantName === undefined
          ? {}
          : { variantName: selection.variantName }),
        ...(selection.reference === undefined
          ? {}
          : { reference: selection.reference }),
      };
    }
    return result;
  }

  /**
   * Ground a `prepareCartItem` proposal and, when it is fully grounded, record
   * it as the pending intent for the same request. A preparation is not a
   * mutation and never produces a cart write.
   */
  prepare(
    selection: GroundableSelection,
    proposal: CartProposal,
  ): CartQuantityGroundingResult {
    const result = this.ground(selection, proposal);
    if (result.kind === 'ready') this.pending = { ...result.intent };
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
