/**
 * Minimal cart selection registry (S1, S4, S6) — pure and SDK-agnostic.
 *
 * The model may name a product or a presentation, but only a server-verified
 * catalog/stock/quoted-cart result may bind a real identity. Callers register
 * that verified identity once; the registry returns an opaque, stable
 * reference for the exact (sender, product, optional variant) pair and later
 * resolves the reference back to the retained identity.
 *
 * Safety properties:
 *   - The reference is a truncated SHA-256 digest, not a concatenated UUID.
 *     The digest is unkeyed and publicly computable, so it provides
 *     correlation and opacity, NOT authentication: it must never be treated
 *     as a secret or as proof that a binding was server-verified.
 *   - `resolve` accepts a reference string only. It never decodes a UUID, and
 *     it never picks a variant from a name; an unregistered reference is
 *     rejected.
 *   - Snapshots MUST stay server-owned. The sender match and re-derived
 *     reference check enforce only structural consistency (a snapshot cannot
 *     add a binding this instance could not itself derive); they do not make a
 *     forged or model-supplied snapshot safe.
 *   - Returned snapshots and resolved selections are defensive copies; a
 *     caller cannot mutate an internal binding.
 *
 * The registry holds no clock, TTL, backend client, persistence or logging.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Exact verified identity of one selectable product/presentation pair. */
export type MinimalCartSelectionIdentity = {
  productId: string;
  variantId?: string;
  productName: string;
  variantName?: string;
};

/** Detached, serializable registry state for one sender. */
export type MinimalCartSelectionSnapshot = {
  senderId: string;
  selections: Array<MinimalCartSelectionIdentity & { reference: string }>;
};

/** One retained binding: the identity plus its opaque reference. */
type Selection = MinimalCartSelectionIdentity & { reference: string };

const REFERENCE_TAG = 'CART_SELECTION/v1';
const REFERENCE_HEX_LENGTH = 16;
const MAX_LABEL_LENGTH = 256;
const MAX_SELECTIONS = 50;
const DISPLAY_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Domain-matching UUID validation (`z.uuid()`): version/variant aware. */
const uuidSchema = z.uuid();

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidSchema.safeParse(value).success;
}

/** A usable label is a bounded, pre-trimmed, non-empty display string. */
function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    value === value.trim() &&
    !DISPLAY_BREAKING.test(value)
  );
}

/**
 * Validate and canonicalize a caller-supplied identity, or `null` when it is
 * malformed. A variant name without a variant id is rejected: an unbound
 * presentation label must never become authority. `null`/`undefined` variant
 * ids are treated as a simple product. IDs keep their exact trusted bytes: no
 * case folding, so the reference binds the identity the caller was given.
 */
function normalizeIdentity(raw: unknown): MinimalCartSelectionIdentity | null {
  if (!isRecord(raw)) return null;
  if (!isUuid(raw.productId)) return null;
  if (!isLabel(raw.productName)) return null;
  const productId = raw.productId;
  const productName = raw.productName;
  const rawVariantId = raw.variantId;
  const rawVariantName = raw.variantName;
  const hasVariant = rawVariantId !== undefined && rawVariantId !== null;
  if (!hasVariant) {
    if (rawVariantName !== undefined && rawVariantName !== null) return null;
    return { productId, productName };
  }
  if (!isUuid(rawVariantId)) return null;
  const variantId = rawVariantId;
  if (rawVariantName === undefined || rawVariantName === null) {
    return { productId, variantId, productName };
  }
  if (!isLabel(rawVariantName)) return null;
  return { productId, variantId, productName, variantName: rawVariantName };
}

/** Opaque stable reference for the exact (sender, product, variant) pair. */
function referenceFor(
  senderId: string,
  productId: string,
  variantId?: string,
): string {
  const name = JSON.stringify([
    REFERENCE_TAG,
    senderId,
    productId,
    variantId ?? null,
  ]);
  return createHash('sha256')
    .update(name, 'utf8')
    .digest('hex')
    .slice(0, REFERENCE_HEX_LENGTH);
}

/** Null-separated pair key so ids cannot alias through concatenation. */
function pairKey(productId: string, variantId?: string): string {
  return `${productId}\u0000${variantId ?? ''}`;
}

/** Detached copy so callers can never mutate a retained binding. */
function copySelection(selection: Selection): Selection {
  const copy: Selection = {
    productId: selection.productId,
    productName: selection.productName,
    reference: selection.reference,
  };
  if (selection.variantId !== undefined) copy.variantId = selection.variantId;
  if (selection.variantName !== undefined) {
    copy.variantName = selection.variantName;
  }
  return copy;
}

export class MinimalCartSelections {
  readonly #senderId: string;
  readonly #byReference = new Map<string, Selection>();

  constructor(senderId: string, snapshot?: MinimalCartSelectionSnapshot) {
    this.#senderId = typeof senderId === 'string' ? senderId : '';
    if (snapshot !== undefined && snapshot !== null) {
      this.#restore(snapshot);
    }
  }

  /**
   * Retain one verified identity and return its opaque reference, or `null`
   * when the identity is malformed or the registry is full. Re-registering an
   * existing pair returns the same reference and refreshes its labels.
   */
  register(identity: MinimalCartSelectionIdentity): string | null {
    if (this.#senderId.length === 0) return null;
    const normalized = normalizeIdentity(identity);
    if (normalized === null) return null;
    const reference = referenceFor(
      this.#senderId,
      normalized.productId,
      normalized.variantId,
    );
    const existing = this.#byReference.get(reference);
    if (existing !== undefined) {
      // A digest collision across distinct pairs fails closed.
      if (
        pairKey(existing.productId, existing.variantId) !==
        pairKey(normalized.productId, normalized.variantId)
      ) {
        return null;
      }
    } else if (this.#byReference.size >= MAX_SELECTIONS) {
      return null;
    }
    this.#byReference.set(reference, { ...normalized, reference });
    return reference;
  }

  /**
   * Resolve an opaque reference to a detached identity, or `null` when it was
   * never registered. No decoding, no name matching, no UUID inference.
   */
  resolve(reference: string): Selection | null {
    if (typeof reference !== 'string' || reference.length === 0) return null;
    const selection = this.#byReference.get(reference);
    return selection === undefined ? null : copySelection(selection);
  }

  /** Detached snapshot safe to persist or hand to another instance. */
  snapshot(): MinimalCartSelectionSnapshot {
    return {
      senderId: this.#senderId,
      selections: [...this.#byReference.values()].map(copySelection),
    };
  }

  /**
   * Import a server-owned snapshot, failing closed on every anomaly: a wrong
   * sender, a malformed shape, an oversized list, an invalid identity, or a
   * reference that this instance could not itself derive.
   */
  #restore(snapshot: unknown): void {
    if (!isRecord(snapshot)) return;
    if (snapshot.senderId !== this.#senderId) return;
    const selections = snapshot.selections;
    if (!Array.isArray(selections) || selections.length > MAX_SELECTIONS) {
      return;
    }
    for (const raw of selections) {
      if (!isRecord(raw)) continue;
      const normalized = normalizeIdentity(raw);
      if (normalized === null) continue;
      const reference = referenceFor(
        this.#senderId,
        normalized.productId,
        normalized.variantId,
      );
      if (raw.reference !== reference) continue;
      if (this.#byReference.has(reference)) continue;
      this.#byReference.set(reference, { ...normalized, reference });
    }
  }
}
