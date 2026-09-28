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
const DISPLAY_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const CATALOG_RECOVERY = {
  ok: false as const,
  error: { kind: 'catalog_identity_unverified', retryable: false },
  guidance:
    'Realiza una búsqueda real con searchCatalog y pide al cliente elegir explícitamente el producto y su variante. No corrijas UUID ni elijas por tu cuenta.',
};

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
  ) {
    const parsed = this.validate(snapshot);
    if (parsed && retainedHistory[parsed.origin]?.role === 'user') {
      this.#references = parsed;
    }
  }

  private validate(raw: unknown): CatalogReferences | null {
    try {
      const parsed = snapshotSchema.safeParse(raw);
      if (!parsed.success) return null;
      const refs = parsed.data;
      const now = this.clock();
      if (
        refs.senderId !== this.senderId ||
        !Number.isFinite(now) ||
        refs.observedAt > now ||
        now - refs.observedAt > this.idleTimeoutMs ||
        Buffer.byteLength(JSON.stringify(refs), 'utf8') > 65536
      )
        return null;
      const ids = new Set<string>();
      let variants = 0;
      for (const product of refs.products) {
        if (ids.has(product.productId)) return null;
        ids.add(product.productId);
        for (const variant of product.variants) {
          if (ids.has(variant.variantId)) return null;
          ids.add(variant.variantId);
          variants += 1;
        }
      }
      return variants > 100 ? null : refs;
    } catch {
      return null;
    }
  }

  beginSearch(): number {
    this.#references = null;
    return ++this.#search;
  }

  installSearch(ticket: number, results: unknown): void {
    if (ticket !== this.#search) return;
    this.#references = null;
    try {
      if (!Array.isArray(results) || results.length > 20) return;
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
      this.#references = this.validate({
        senderId: this.senderId,
        observedAt: this.clock(),
        origin: this.origin,
        products,
      });
    } catch {
      // Malformed backend projections cannot become identity authority.
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
    const refs = this.snapshot();
    if (refs === null) return null;
    const product = refs.products.find(
      (p) => p.productId === candidate.productId,
    );
    if (product === undefined) return null;
    if (candidate.name !== undefined && candidate.name !== product.name) {
      return null;
    }
    const variantId = candidate.variantId ?? null;
    if (variantId === null) {
      return {
        productId: product.productId,
        productName: product.name,
        variantId: null,
        variantName: null,
      };
    }
    const variant = product.variants.find((v) => v.variantId === variantId);
    if (variant === undefined) return null;
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
    return this.validate(this.#references);
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
    const refs = this.snapshot();
    if (!refs || refs.origin < retainedFrom) {
      this.#references = null;
      return null;
    }
    return `UNSELECTED catalog evidence; stock unknown. Ask for explicit customer choice.\n${JSON.stringify(refs.products)}`;
  }
}

/** The SDK must preserve the actual server-created instance, not parse a lookalike. */
export const catalogSessionSchema = z.custom<CatalogSession>(CatalogSession.is);
