import { z } from 'zod';
import type { AgentMessage } from './conversation-store';

const name = z.string().min(1).max(256);
const variantSchema = z.strictObject({
  variantId: z.uuid(),
  name,
  option: z.string().max(128).nullable(),
  value: z.string().max(128).nullable(),
});
const productSchema = z.strictObject({
  productId: z.uuid(),
  name,
  variants: z.array(variantSchema).max(100),
});
const snapshotSchema = z.strictObject({
  senderId: z.string().min(1),
  observedAt: z.number().finite().nonnegative(),
  origin: z.number().int().nonnegative(),
  products: z.array(productSchema).min(1).max(20),
});
export type CatalogReferences = z.infer<typeof snapshotSchema>;

// A Cc/Cf/Zl/Zp char in a label can forge extra choices; fail closed.
export const DISPLAY_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const CATALOG_RECOVERY = {
  ok: false as const,
  error: { kind: 'catalog_identity_unverified', retryable: false },
  guidance:
    'Realiza una búsqueda real con searchCatalog y pide al cliente elegir explícitamente el producto y su variante. No corrijas UUID ni elijas por tu cuenta.',
};

/** Closed phase of one direct catalog-identity validation branch. */
export type CatalogIdentityPhase =
  | 'restore'
  | 'install_search'
  | 'resolve'
  | 'history';

/** Closed reason for the branch that was taken; never carries identity data. */
export type CatalogIdentityReason =
  | 'accepted'
  | 'missing_snapshot'
  | 'invalid_snapshot'
  | 'sender_mismatch'
  | 'invalid_clock'
  | 'future_observation'
  | 'expired'
  | 'oversized'
  | 'duplicate_id'
  | 'variant_limit'
  | 'origin_removed'
  | 'stale_ticket'
  | 'unknown_product'
  | 'name_mismatch'
  | 'unknown_variant'
  | 'malformed_projection';

/** One categorical diagnostic; contains no ids, names, text or raw inputs. */
export interface CatalogIdentityEvent {
  phase: CatalogIdentityPhase;
  reason: CatalogIdentityReason;
}

export type CatalogIdentityObserver = (event: CatalogIdentityEvent) => void;

/** Detached identity evidence only: neither customer selection nor fresh stock. */
export class CatalogSession {
  #references: CatalogReferences | null = null;
  #search = 0;

  static is(this: void, value: unknown): value is CatalogSession {
    return typeof value === 'object' && value !== null && #references in value;
  }

  constructor(
    readonly senderId: string,
    private readonly idleTimeoutMs: number,
    private readonly origin: number,
    snapshot?: unknown,
    retainedHistory: readonly AgentMessage[] = [],
    private readonly clock: () => number = Date.now,
    private readonly observe?: CatalogIdentityObserver,
  ) {
    const { refs, reason } = this.classify(snapshot);
    if (refs === null) {
      this.emit('restore', reason);
    } else if (retainedHistory[refs.origin]?.role !== 'user') {
      this.emit('restore', 'origin_removed');
    } else {
      this.#references = refs;
      this.emit('restore', 'accepted');
    }
  }

  /** Direct branch outcome; callers that only need refs stay silent. */
  private classify(raw: unknown): {
    refs: CatalogReferences | null;
    reason: CatalogIdentityReason;
  } {
    if (raw === null || raw === undefined) {
      return { refs: null, reason: 'missing_snapshot' };
    }
    try {
      const parsed = snapshotSchema.safeParse(raw);
      if (!parsed.success) return { refs: null, reason: 'invalid_snapshot' };
      const refs = parsed.data;
      const now = this.clock();
      if (refs.senderId !== this.senderId)
        return { refs: null, reason: 'sender_mismatch' };
      if (!Number.isFinite(now)) return { refs: null, reason: 'invalid_clock' };
      if (refs.observedAt > now)
        return { refs: null, reason: 'future_observation' };
      if (now - refs.observedAt > this.idleTimeoutMs)
        return { refs: null, reason: 'expired' };
      if (Buffer.byteLength(JSON.stringify(refs), 'utf8') > 65536)
        return { refs: null, reason: 'oversized' };
      const ids = new Set<string>();
      let variants = 0;
      for (const product of refs.products) {
        if (ids.has(product.productId))
          return { refs: null, reason: 'duplicate_id' };
        ids.add(product.productId);
        for (const variant of product.variants) {
          if (ids.has(variant.variantId))
            return { refs: null, reason: 'duplicate_id' };
          ids.add(variant.variantId);
          variants += 1;
        }
      }
      if (variants > 100) return { refs: null, reason: 'variant_limit' };
      return { refs, reason: 'accepted' };
    } catch {
      return { refs: null, reason: 'invalid_snapshot' };
    }
  }

  /** Diagnostics must never affect validation or the return shape. */
  private emit(
    phase: CatalogIdentityPhase,
    reason: CatalogIdentityReason,
  ): void {
    if (this.observe === undefined) return;
    try {
      this.observe({ phase, reason });
    } catch {
      // Swallow: an observer failure is never a validation failure.
    }
  }

  beginSearch(): number {
    this.#references = null;
    return ++this.#search;
  }

  installSearch(ticket: number, results: unknown): void {
    if (ticket !== this.#search) {
      this.emit('install_search', 'stale_ticket');
      return;
    }
    this.#references = null;
    try {
      if (!Array.isArray(results)) {
        this.emit('install_search', 'malformed_projection');
        return;
      }
      if (results.length > 20) {
        this.emit('install_search', 'oversized');
        return;
      }
      const products = results.map((product: Record<string, unknown>) => ({
        productId: product.productId,
        name: product.name,
        variants: Array.isArray(product.variants)
          ? product.variants.map((variant: Record<string, unknown>) => ({
              variantId: variant.variantId,
              name: variant.name,
              option: variant.option,
              value: variant.value,
            }))
          : null,
      }));
      const { refs, reason } = this.classify({
        senderId: this.senderId,
        observedAt: this.clock(),
        origin: this.origin,
        products,
      });
      if (refs === null) {
        this.emit('install_search', reason);
        return;
      }
      this.#references = refs;
      this.emit('install_search', 'accepted');
    } catch {
      // Malformed backend projections cannot become identity authority.
      this.emit('install_search', 'malformed_projection');
    }
  }

  /** Read-only run-local search generation (never persisted). */
  get generation(): number {
    return this.#search;
  }

  /**
   * Detached canonical subject for a validated candidate reference, or `null`
   * when the candidate is not backed by installed catalog identity. Names come
   * only from these validated backend references.
   */
  resolve(candidate: {
    productId: string;
    variantId?: string | null;
    name?: string;
  }): {
    productId: string;
    productName: string;
    variantId: string | null;
    variantName: string | null;
  } | null {
    const { refs, reason } = this.classify(this.#references);
    if (refs === null) {
      this.emit('resolve', reason);
      return null;
    }
    const product = refs.products.find(
      (p) => p.productId === candidate.productId,
    );
    if (product === undefined) {
      this.emit('resolve', 'unknown_product');
      return null;
    }
    if (candidate.name !== undefined && candidate.name !== product.name) {
      this.emit('resolve', 'name_mismatch');
      return null;
    }
    const variantId = candidate.variantId ?? null;
    if (variantId === null) {
      this.emit('resolve', 'accepted');
      return {
        productId: product.productId,
        productName: product.name,
        variantId: null,
        variantName: null,
      };
    }
    const variant = product.variants.find((v) => v.variantId === variantId);
    if (variant === undefined) {
      this.emit('resolve', 'unknown_variant');
      return null;
    }
    this.emit('resolve', 'accepted');
    return {
      productId: product.productId,
      productName: product.name,
      variantId: variant.variantId,
      variantName: variant.name,
    };
  }

  matches(candidate: {
    productId: string;
    variantId?: string | null;
    name?: string;
  }): boolean {
    return this.resolve(candidate) !== null;
  }

  snapshot(): CatalogReferences | null {
    return this.classify(this.#references).refs;
  }

  /**
   * Deterministic customer-facing question that asks for an explicit
   * product/presentation choice using ONLY the currently validated canonical
   * identities. It ASKS, never selects, and exposes no id, price or stock.
   * `null` when no snapshot is valid, or when the candidate set is empty, too
   * large, byte-heavy or indistinguishable, so the caller can fall back to
   * the generic reply without ever truncating a dose or name.
   */
  selectionPrompt(): string | null {
    const refs = this.snapshot();
    if (refs === null) return null;
    const labels: Array<{ text: string; variantless: boolean }> = [];
    for (const product of refs.products) {
      if (product.variants.length === 0) {
        labels.push({ text: product.name, variantless: true });
        continue;
      }
      const names = product.variants.map((variant) => variant.name);
      const repeated = new Set(
        names.filter((value, index) => names.indexOf(value) !== index),
      );
      for (const variant of product.variants) {
        const detail = repeated.has(variant.name)
          ? [variant.option, variant.value]
              .filter(
                (part): part is string => part !== null && part.length > 0,
              )
              .join(' ')
          : '';
        const suffix =
          detail.length === 0 ? variant.name : `${variant.name}: ${detail}`;
        labels.push({
          text: `${product.name} (${suffix})`,
          variantless: false,
        });
      }
    }
    if (labels.length === 0 || labels.length > 6) return null;
    const texts = labels.map((label) => label.text);
    if (new Set(texts).size !== texts.length) return null;
    if (texts.some((text) => DISPLAY_BREAKING.test(text))) return null;
    if (labels.length === 1 && labels[0].variantless) {
      return `Para consultar existencias, ¿se refiere a «${texts[0]}»?`;
    }
    const list = texts.map((text, index) => `${index + 1}. ${text}`).join('\n');
    const prompt =
      'Para consultar existencias, necesito identificar el producto y su presentación. ' +
      `¿Cuál desea consultar?\n${list}`;
    return Buffer.byteLength(prompt, 'utf8') <= 2048 ? prompt : null;
  }

  /** Only references whose original user turn survives prompt truncation. */
  evidence(retainedFrom: number): string | null {
    const { refs, reason } = this.classify(this.#references);
    if (refs === null) {
      this.#references = null;
      this.emit('history', reason);
      return null;
    }
    if (refs.origin < retainedFrom) {
      this.#references = null;
      this.emit('history', 'origin_removed');
      return null;
    }
    return `UNSELECTED catalog evidence; stock unknown. Ask for explicit customer choice.\n${JSON.stringify(refs.products)}`;
  }
}

/** The SDK must preserve the actual server-created instance, not parse a lookalike. */
export const catalogSessionSchema = z.custom<CatalogSession>(CatalogSession.is);
