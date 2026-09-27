/**
 * Independent, SDK-agnostic inventory evidence boundary (R2).
 *
 * The model must never be allowed to treat catalog search — or any tool
 * other than a fresh, internally consistent `checkStock` — as stock
 * evidence. This guard aggregates completed model steps atomically (one
 * `recordStep` per finished step) and exposes only two facts the adapter
 * needs:
 *
 *   - `hasUnresolvedStockFailure()`: a stock check failed (or produced no
 *     trustworthy answer) and no later, same-subject authoritative result
 *     has cleared it.
 *   - `hasExecutedMutation()`: a mutating tool actually reached execution
 *     (a returned result OR an ambiguous error). Denied calls never ran and
 *     are deliberately excluded.
 *
 * The guard is intentionally free of any AI-SDK import: the adapter maps
 * its own step shape into `InventoryCallEvidence` so this module stays
 * provider-swappable and independently testable.
 */

/** Tools whose execution may change persisted business state. */
export const MUTATING_TOOL_NAMES = [
  'evaluateCart',
  'upsertCustomer',
  'createSale',
  'updateDelivery',
  'cancelSale',
  'requestHumanAssistance',
  'getShippingQuote',
] as const;

/** Tools that never change persisted business state. */
export const NON_MUTATING_TOOL_NAMES = [
  'searchCatalog',
  'checkStock',
  'getCustomerByPhone',
  'getOrderHistory',
  'getPaymentDetails',
  'attachReceipt',
] as const;

const MUTATING = new Set<string>(MUTATING_TOOL_NAMES);
const NON_MUTATING = new Set<string>(NON_MUTATING_TOOL_NAMES);

/** True only for the explicit mutating allowlist; unknown names fail closed. */
export function isMutatingToolName(name: string): boolean {
  return MUTATING.has(name);
}

/** True only for the explicit read-only allowlist. */
export function isNonMutatingToolName(name: string): boolean {
  return NON_MUTATING.has(name);
}

/**
 * True for any executed tool name that could change persisted state. The
 * non-mutating allowlist is the ONLY clearance; every other name (the seven
 * known mutations AND any unknown name) is a potential effect.
 */
export function isPotentialEffectToolName(name: string): boolean {
  return !NON_MUTATING.has(name);
}

/**
 * How a single tool call ended in a completed step.
 *
 *   - `result`: `execute` returned; `output` holds the returned value.
 *   - `error`: `execute` threw (SDK tool-error).
 *   - `denied`: the SDK denied execution; the tool never ran.
 *   - `unaccounted`: a tool call with no result/error/denial. Always treated
 *     as executed and, for `checkStock`, as a failed check (fail closed).
 */
export type InventoryCallState = 'result' | 'error' | 'denied' | 'unaccounted';

export interface InventoryCallEvidence {
  toolCallId: string;
  toolName: string;
  input: unknown;
  state: InventoryCallState;
  output?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Stable per-subject key. A check without a usable product id cannot be
 * correlated to any product, so it gets a unique un-clearable key: missing
 * identity must never be able to authorize a mutation.
 */
function subjectOf(input: unknown, toolCallId: string): string {
  const record = asRecord(input);
  const productId = record?.productId;
  if (typeof productId !== 'string' || productId.length === 0) {
    return `unknown\u0000${toolCallId}`;
  }
  const rawVariant = record?.variantId;
  const variantId =
    typeof rawVariant === 'string' && rawVariant.length > 0 ? rawVariant : '';
  return `${productId}\u0000${variantId}`;
}

/**
 * Return the authoritative status for a stock node, or `null` when the node
 * carries no trustworthy inventory answer. Consistency is enforced against
 * the real `StockCheckResponse` shape:
 *   - `available` / `low_stock` require a positive integer quantity;
 *   - `out_of_stock` requires an integer quantity of exactly zero;
 *   - `not_managed`, unknown, null, negative, or fractional quantities are
 *     never authoritative.
 */
function authoritativeStatus(stock: unknown): string | null {
  const record = asRecord(stock);
  if (record === null) return null;
  const status = record.status;
  const quantity = record.quantity;
  if (status === 'available' || status === 'low_stock') {
    return typeof quantity === 'number' &&
      Number.isInteger(quantity) &&
      quantity > 0
      ? status
      : null;
  }
  if (status === 'out_of_stock') {
    return quantity === 0 ? status : null;
  }
  return null;
}

/**
 * A check succeeds ONLY when it returns an internally consistent,
 * authoritative answer for the exact requested subject. Every other outcome
 * (error, denied, unaccounted, `ok:false`, malformed, mismatched, or an
 * unknown/`not_managed` status) is treated as a failure so a first
 * non-authoritative result already blocks inventory claims.
 */
function checkStockSuccess(call: InventoryCallEvidence): boolean {
  if (call.state !== 'result') return false;
  const output = asRecord(call.output);
  if (output === null || output.ok !== true) return false;

  const input = asRecord(call.input);
  const requestedProductId = input?.productId;
  if (
    typeof requestedProductId !== 'string' ||
    output.productId !== requestedProductId
  ) {
    return false;
  }

  const rawVariantId = input?.variantId;
  if (typeof rawVariantId === 'string' && rawVariantId.length > 0) {
    const variants = output.variants;
    if (!Array.isArray(variants)) return false;
    const list: unknown[] = variants;
    const matches = list.filter(
      (candidate) => asRecord(candidate)?.variantId === rawVariantId,
    );
    if (matches.length !== 1) return false;
    return authoritativeStatus(asRecord(matches[0])?.stock) !== null;
  }
  return authoritativeStatus(output.stock) !== null;
}

export class InventoryEvidenceGuard {
  #unresolved = new Set<string>();
  #executedMutation = false;

  /**
   * Record one completed step atomically. Any same-step non-authoritative
   * result dominates a same-step success for the same subject regardless of
   * call order; a success only clears a prior failure when it is internally
   * consistent and no failure for that subject occurred in the same step.
   */
  recordStep(calls: readonly InventoryCallEvidence[]): void {
    if (calls === null || typeof calls !== 'object') return;
    const evidence: InventoryCallEvidence[] = [];
    for (const call of calls) {
      if (call === null || typeof call !== 'object') continue;
      evidence.push(call);
      // Any executed name outside the explicit non-mutating allowlist is a
      // potential effect (including unknown tools and ambiguous errors).
      const executed = call.state !== 'denied';
      const clearedByAllowlist =
        typeof call.toolName === 'string' &&
        isNonMutatingToolName(call.toolName);
      if (executed && !clearedByAllowlist) this.#executedMutation = true;
    }

    const failures = new Set<string>();
    const successes = new Set<string>();
    for (const call of evidence) {
      if (call.toolName !== 'checkStock') continue;
      const subject = subjectOf(call.input, call.toolCallId);
      if (checkStockSuccess(call)) successes.add(subject);
      else failures.add(subject);
    }

    for (const subject of successes) {
      if (!failures.has(subject)) this.#unresolved.delete(subject);
    }
    for (const subject of failures) this.#unresolved.add(subject);
  }

  /** Any stock subject that has no later authoritative answer. */
  hasUnresolvedStockFailure(): boolean {
    return this.#unresolved.size > 0;
  }

  /**
   * Any executed call that is not explicitly non-mutating, including unknown
   * tools and ambiguous error returns. Denied (never-executed) calls do not
   * count. The reply fallback therefore never hides a possible effect.
   */
  hasExecutedMutation(): boolean {
    return this.#executedMutation;
  }
}
