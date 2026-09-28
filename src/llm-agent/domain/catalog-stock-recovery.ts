/**
 * Conservative, SDK-agnostic catalog stock recovery selector and one-shot
 * recovery run controller.
 *
 * Production symptom: the model answers an availability question, gets
 * `catalog_identity_unverified` from `checkStock` (no backend stock GET),
 * recovers a valid identity with a fresh `searchCatalog`, and then ends the
 * turn without ever retrying the stock lookup. Raising the step cap or
 * rewording the prompt does not guarantee the retry.
 *
 * This module only recognizes the narrow subset of customer text that
 * authorizes an automatic READ-ONLY stock retry: a bounded availability
 * phrase, a strict affirmative continuation of an availability question
 * asked right after a real customer availability turn, or a strict answer to
 * its own fixed inventory clarification. The clarification path is authorized
 * only through a bounded, recognized continuation chain that reaches an
 * authentic customer availability turn for the same identity (the subject
 * always comes from the customer, never from the assistant). The run controller
 * additionally arms only after this run observed an identity-unverified
 * `checkStock` failure and a later successful fresh search. A target is
 * produced only when the reference matches exactly one product in the
 * validated backend snapshot and any variant is named explicitly. It never
 * guesses identity, never mutates, and never treats a search query, a failed
 * tool argument, assistant prose, or a single search result as customer choice.
 */
import type { InventoryCallEvidence } from './inventory-evidence.guard';

export interface CatalogStockRecoveryTarget {
  readonly productId: string;
  readonly variantId: string | null;
}

export interface CatalogStockRecoveryVariant {
  readonly variantId: string;
  readonly name: string;
  readonly option: string | null;
  readonly value: string | null;
}

export interface CatalogStockRecoveryProduct {
  readonly productId: string;
  readonly name: string;
  readonly variants: ReadonlyArray<CatalogStockRecoveryVariant>;
}

export interface CatalogStockRecoverySnapshot {
  readonly products: ReadonlyArray<CatalogStockRecoveryProduct>;
}

export interface CatalogStockRecoveryMessage {
  readonly role: string;
  readonly content: unknown;
}

export type CatalogStockRecoveryDecision =
  | { readonly kind: 'recover'; readonly target: CatalogStockRecoveryTarget }
  | { readonly kind: 'none' };

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Latin diacritics are folded so `sí`/`si` and `disponible`/`disponible` agree. */
function fold(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

function words(value: string): string[] {
  return fold(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Function words and pleasantries never identify a product. */
const STOPWORDS = new Set<string>([
  'a',
  'al',
  'buen',
  'buenas',
  'buenos',
  'con',
  'cual',
  'cuales',
  'cuando',
  'cuanta',
  'cuantas',
  'cuanto',
  'cuantos',
  'de',
  'del',
  'dia',
  'dias',
  'disculpa',
  'disculpe',
  'e',
  'el',
  'en',
  'es',
  'esa',
  'esas',
  'ese',
  'eso',
  'esos',
  'esta',
  'estan',
  'este',
  'estos',
  'favor',
  'gracias',
  'hola',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'me',
  'mi',
  'mis',
  'noche',
  'noches',
  'o',
  'oiga',
  'para',
  'perdon',
  'por',
  'porfa',
  'porfavor',
  'que',
  'se',
  'senor',
  'senora',
  'sin',
  'son',
  'su',
  'sus',
  'tarde',
  'tardes',
  'te',
  'tu',
  'tus',
  'u',
  'un',
  'una',
  'unas',
  'unos',
  'y',
]);

/** Narrow availability vocabulary. Generic verbs (`revisar`, `checar`) stay out. */
const AVAILABILITY_CUES = new Set<string>([
  'disponibilidad',
  'disponible',
  'disponibles',
  'existen',
  'existencia',
  'existencias',
  'existe',
  'hay',
  'inventario',
  'maneja',
  'manejan',
  'manejas',
  'queda',
  'quedan',
  'quedas',
  'stock',
  'tiene',
  'tienen',
  'tienes',
  'tenemos',
  'tenes',
  'vende',
  'venden',
  'vendes',
]);

/**
 * Availability-offer vocabulary. A question built only from these words plus
 * function words names no product (for example "¿Le gustaría que revisara su
 * disponibilidad?" or "Claro. ¿Quieres que revise la disponibilidad?"), so it
 * constrains nothing. This is a closed list: any other token in the
 * assistant's question is treated as a proposed subject and must match the
 * customer's product and variant exactly.
 */
const GENERIC_REQUEST_WORDS = new Set<string>([
  'ayudar',
  'ayudarle',
  'ayudarte',
  'checa',
  'checar',
  'checo',
  'confirma',
  'confirmar',
  'confirmo',
  'consultar',
  'consulto',
  'desea',
  'deseas',
  'gustaria',
  'gustas',
  'podria',
  'podrias',
  'puede',
  'puedo',
  'queria',
  'quiere',
  'quieres',
  'revisa',
  'revisamos',
  'revisar',
  'revisara',
  'revise',
  'revisen',
  'reviso',
  'saber',
  'verifica',
  'verificar',
  'verifico',
]);

/** Short, closed affirmative confirmations. Nothing open-ended authorizes recovery. */
const AFFIRMATIVES = new Set<string>([
  'adelante',
  'adelante si',
  'asi es',
  'claro',
  'claro que si',
  'claro si',
  'correcto',
  'de acuerdo',
  'exacto',
  'gracias si',
  'hazlo',
  'hazlo por favor',
  'ok',
  'okay',
  'okey',
  'por favor',
  'por favor si',
  'porfa',
  'porfa si',
  'porfavor',
  'porfavor si',
  'revisa por favor',
  'revisalo',
  'revisalo por favor',
  'sale',
  'si',
  'si adelante',
  'si gracias',
  'si por favor',
  'si porfa',
  'si porfavor',
  'si senor',
  'si senora',
  'si si',
  'sii',
  'sip',
  'vale',
]);

/**
 * Closed whitelist of measurement units eligible for digit/unit adjacency
 * folding. `400mg` and `400 mg` must tokenize alike while `400g` never
 * matches `400mg` and `400` never matches `200`.
 */
const CLARIFICATION_UNITS = new Set<string>([
  'g',
  'kg',
  'mcg',
  'mg',
  'ml',
  'ui',
]);

/**
 * Fold only adjacent number/unit pairs whose unit is in the closed whitelist,
 * so `400mg` becomes the same evidence as `400 mg`. Every other unit is left
 * untouched, which is why `400g` can never be mistaken for `400mg`.
 */
function normalizeUnitAdjacency(value: string): string {
  return fold(value).replace(
    /(\d+)\s*([a-z]+)/g,
    (match: string, digits: string, unit: string) =>
      CLARIFICATION_UNITS.has(unit) ? `${digits} ${unit}` : match,
  );
}

/**
 * Tokenize a clarification answer: apply the closed unit folding and drop an
 * exact leading `busco` (never an arbitrary lead-in). Shortening or padding
 * the answer therefore changes the tokens and rejects the recovery.
 */
function clarificationTokens(value: string): string[] {
  const tokens = words(normalizeUnitAdjacency(value));
  const withoutPrefix = tokens[0] === 'busco' ? tokens.slice(1) : tokens;
  return withoutPrefix.filter((word) => !STOPWORDS.has(word));
}

function normalizePhrase(value: string): string {
  return fold(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokens that may identify a product: significant name words only. */
function nameTokens(value: string): string[] {
  return words(value).filter((word) => !STOPWORDS.has(word));
}

/** Tokens a customer phrase can use to reference a product. */
function referenceTokens(value: string): string[] {
  return words(value).filter(
    (word) => !STOPWORDS.has(word) && !AVAILABILITY_CUES.has(word),
  );
}

/**
 * A product matches a reference in either direction: the customer gave a
 * partial name (`ibuprofeno` for `Ibuprofeno de 400 mg`) or repeated the full
 * backend name. Both directions require exact token equality — no prefixes,
 * so `producto` never matches `product`.
 */
function matchesReference(
  name: string,
  reference: ReadonlySet<string>,
): boolean {
  const product = nameTokens(name);
  if (product.length === 0 || reference.size === 0) return false;
  const productSet = new Set(product);
  return (
    [...reference].every((token) => productSet.has(token)) ||
    product.every((token) => reference.has(token))
  );
}

function variantTokenUnion(
  product: CatalogStockRecoveryProduct,
): ReadonlySet<string> {
  const union = new Set<string>();
  for (const variant of product.variants) {
    for (const token of nameTokens(variant.name)) union.add(token);
  }
  return union;
}

/**
 * Variant tokens are removed from the reference before the product is
 * matched, so naming a presentation never hides the product it belongs to.
 */
function matchesProduct(
  product: CatalogStockRecoveryProduct,
  reference: ReadonlySet<string>,
): boolean {
  const variantTokens = variantTokenUnion(product);
  const productOnly = new Set(
    [...reference].filter((token) => !variantTokens.has(token)),
  );
  return matchesReference(product.name, productOnly);
}

function matchingProducts(
  snapshot: CatalogStockRecoverySnapshot,
  reference: ReadonlySet<string>,
): CatalogStockRecoveryProduct[] {
  return snapshot.products.filter((product) =>
    matchesProduct(product, reference),
  );
}

/** A variant must be named in full by the same reference; never inferred. */
function selectVariant(
  product: CatalogStockRecoveryProduct,
  reference: ReadonlySet<string>,
): string | null | undefined {
  const matches = product.variants.filter((candidate) => {
    const tokens = nameTokens(candidate.name);
    return tokens.length > 0 && tokens.every((token) => reference.has(token));
  });
  if (matches.length !== 1) return undefined;
  return matches[0].variantId;
}

/**
 * Tokens the assistant question uses to name its own subject, if any. Generic
 * offer wording and availability vocabulary are removed; an empty result means
 * the question is generic ("¿Le gustaría que revisara su disponibilidad?") and
 * constrains nothing.
 */
function assistantSubjectTokens(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return words(value).filter(
    (word) =>
      !STOPWORDS.has(word) &&
      !AVAILABILITY_CUES.has(word) &&
      !GENERIC_REQUEST_WORDS.has(word),
  );
}

/** A bounded availability cue inside a real customer turn. */
function hasAvailabilityCue(content: unknown): boolean {
  return (
    typeof content === 'string' &&
    words(content).some((word) => AVAILABILITY_CUES.has(word))
  );
}

function isAvailabilityQuestion(content: unknown): boolean {
  return (
    typeof content === 'string' &&
    content.includes('?') &&
    hasAvailabilityCue(content)
  );
}

function resolve(
  snapshot: CatalogStockRecoverySnapshot | null,
  reference: ReadonlySet<string>,
): CatalogStockRecoveryDecision {
  if (snapshot === null || snapshot.products.length === 0) {
    return { kind: 'none' };
  }
  const candidates = matchingProducts(snapshot, reference);
  if (candidates.length !== 1) return { kind: 'none' };
  const matched = candidates[0];
  if (matched.variants.length === 0) {
    return {
      kind: 'recover',
      target: { productId: matched.productId, variantId: null },
    };
  }
  const variantId = selectVariant(matched, reference);
  if (variantId === undefined) return { kind: 'none' };
  return {
    kind: 'recover',
    target: { productId: matched.productId, variantId },
  };
}

function sameTarget(
  a: CatalogStockRecoveryTarget,
  b: CatalogStockRecoveryTarget,
): boolean {
  return a.productId === b.productId && a.variantId === b.variantId;
}

/**
 * Token set for one candidate identity: the product's significant name tokens
 * plus, when a variant is selected, that variant's significant name tokens.
 * Overlapping tokens (a dose restated by the variant) collapse, so a shared
 * `400 mg` never coexists with an unselected `800 mg`.
 */
function candidateTokens(
  product: CatalogStockRecoveryProduct,
  variant: CatalogStockRecoveryVariant | null,
): ReadonlySet<string> {
  const tokens = new Set<string>(clarificationTokens(product.name));
  if (variant !== null) {
    for (const token of clarificationTokens(variant.name)) tokens.add(token);
  }
  return tokens;
}

function sameTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/**
 * Strict clarification resolution over candidate IDENTITIES, not products.
 *
 * Every product-only identity (a product without variants) and every
 * `(product, variant)` pair is a candidate; the answer's significant tokens
 * must equal exactly one candidate's token set — nothing missing and nothing
 * extra. That single rule rejects a wrong dose, a stray unselected variant
 * token, an added product, and a partially named product, while still
 * recovering a full variant answer whose dose tokens also appear in the
 * product name. A product that has variants can never resolve from its
 * product name alone, so an omitted presentation stays unselected.
 */
function strictResolve(
  snapshot: CatalogStockRecoverySnapshot | null,
  reference: ReadonlySet<string>,
): CatalogStockRecoveryDecision {
  if (
    snapshot === null ||
    snapshot.products.length === 0 ||
    reference.size === 0
  ) {
    return { kind: 'none' };
  }
  const candidates: CatalogStockRecoveryTarget[] = [];
  for (const product of snapshot.products) {
    if (product.variants.length === 0) {
      if (sameTokens(candidateTokens(product, null), reference)) {
        candidates.push({ productId: product.productId, variantId: null });
      }
      continue;
    }
    for (const variant of product.variants) {
      if (sameTokens(candidateTokens(product, variant), reference)) {
        candidates.push({
          productId: product.productId,
          variantId: variant.variantId,
        });
      }
    }
  }
  if (candidates.length !== 1) return { kind: 'none' };
  return { kind: 'recover', target: candidates[0] };
}

/** Bounded retained-history suffix that must carry the continuation chain. */
const CLARIFICATION_HISTORY_WINDOW = 8;

/** The product a resolved target points at, or null when it vanished. */
function findProduct(
  snapshot: CatalogStockRecoverySnapshot | null,
  productId: string,
): CatalogStockRecoveryProduct | null {
  return snapshot?.products.find((p) => p.productId === productId) ?? null;
}

function targetVariant(
  product: CatalogStockRecoveryProduct,
  target: CatalogStockRecoveryTarget,
): CatalogStockRecoveryVariant | null {
  if (target.variantId === null) return null;
  return product.variants.find((v) => v.variantId === target.variantId) ?? null;
}

/** True when an assistant turn is the exact fixed clarification delimiter. */
function isDelimiterTurn(content: unknown, delimiter: string): boolean {
  return typeof content === 'string' && content === delimiter;
}

function isAffirmativeTurn(content: unknown): boolean {
  return (
    typeof content === 'string' && AFFIRMATIVES.has(normalizePhrase(content))
  );
}

/**
 * True when a customer turn is an authentic availability question that may
 * anchor the retry for the pending identity. Product-level matching tolerates
 * leaving the variant for the clarification to refine, but every significant
 * token the customer named (product, dose, variant) must be consistent with
 * the selected identity. An unsupported product such as paracetamol, or a
 * dose the target does not carry, therefore cannot anchor the retry.
 */
function isAvailabilityAnchorTurn(
  content: unknown,
  snapshot: CatalogStockRecoverySnapshot | null,
  target: CatalogStockRecoveryTarget,
): boolean {
  if (!hasAvailabilityCue(content)) return false;
  const reference = new Set(referenceTokens(String(content)));
  if (reference.size === 0) return false;
  const product = findProduct(snapshot, target.productId);
  if (product === null || !matchesProduct(product, reference)) return false;
  const identity = candidateTokens(product, targetVariant(product, target));
  return [...reference].every((token) => identity.has(token));
}

/**
 * True when a customer turn is itself a strict answer to an earlier fixed
 * clarification for the SAME pending identity. A prior answer that selected a
 * different product or variant breaks the chain instead of being ignored.
 */
function isClarificationAnswerTurn(
  content: unknown,
  snapshot: CatalogStockRecoverySnapshot | null,
  target: CatalogStockRecoveryTarget,
): boolean {
  if (typeof content !== 'string') return false;
  const decision = strictResolve(
    snapshot,
    new Set(clarificationTokens(content)),
  );
  return decision.kind === 'recover' && sameTarget(decision.target, target);
}

/**
 * A fixed-clarification answer is authorized only when the immediately
 * preceding assistant turn is the exact clarification AND the retained suffix
 * carries a contiguous, recognized continuation chain back to an authentic
 * customer availability turn for the same pending identity.
 *
 * The bounded suffix is read backwards and the chain advances only on
 * explicitly recognized shapes:
 *   - assistant: the exact fixed clarification, or an availability question;
 *   - customer: an availability anchor for the pending identity, a strict
 *     short affirmative, or a strict clarification answer for that identity.
 * The chain starts at a customer availability anchor and succeeds only when
 * one is reached. Every other turn — a cancellation, a new topic, an
 * unsupported product, a conflicting dose, an answer for another identity, or
 * an unrecognized assistant message — ends the walk and rejects. This is a
 * positive recognition rule, never an ad hoc keyword list: a turn that is not
 * recognized simply cannot continue the chain. The exact clarification copy is
 * therefore a delimiter, not authority.
 */
function hasContinuationChain(
  history: ReadonlyArray<CatalogStockRecoveryMessage>,
  snapshot: CatalogStockRecoverySnapshot | null,
  target: CatalogStockRecoveryTarget,
  delimiter: string,
): boolean {
  const start = Math.max(0, history.length - CLARIFICATION_HISTORY_WINDOW);
  let index = history.length - 1;
  const last = history[index];
  if (
    last === undefined ||
    last.role !== 'assistant' ||
    !isDelimiterTurn(last.content, delimiter)
  ) {
    return false;
  }
  index -= 1;
  while (index >= start) {
    const message = history[index];
    if (message === undefined) return false;
    if (message.role === 'assistant') {
      if (
        !isDelimiterTurn(message.content, delimiter) &&
        !isAvailabilityQuestion(message.content)
      ) {
        return false;
      }
      index -= 1;
      continue;
    }
    if (message.role === 'user') {
      if (isAvailabilityAnchorTurn(message.content, snapshot, target)) {
        return true;
      }
      if (
        isAffirmativeTurn(message.content) ||
        isClarificationAnswerTurn(message.content, snapshot, target)
      ) {
        index -= 1;
        continue;
      }
      return false;
    }
    return false;
  }
  return false;
}

/**
 * Resolve a customer answer to the bot's own fixed clarification. Engagement
 * requires the exact clarification text as the immediately preceding assistant
 * turn (the adapter passes it; the domain never imports the adapter) plus a
 * contiguous, recognized customer continuation chain ending in an authentic
 * availability turn for the same identity. Everything else returns `null` so
 * the ordinary branches keep their behavior, and an engaged but unresolved
 * answer returns `none` instead of silently reusing old intent.
 */
function clarificationAnswer(
  input: CatalogStockRecoveryInput,
): CatalogStockRecoveryDecision | null {
  const delimiter = input.clarificationText;
  if (typeof delimiter !== 'string' || delimiter.length === 0) return null;
  const assistant = input.history[input.history.length - 1];
  if (
    assistant === undefined ||
    assistant.role !== 'assistant' ||
    !isDelimiterTurn(assistant.content, delimiter)
  ) {
    return null;
  }
  const decision = strictResolve(
    input.snapshot,
    new Set(clarificationTokens(input.text)),
  );
  if (decision.kind !== 'recover') return { kind: 'none' };
  if (
    !hasContinuationChain(
      input.history,
      input.snapshot,
      decision.target,
      delimiter,
    )
  ) {
    return { kind: 'none' };
  }
  return decision;
}

/** True when a completed step returned the identity-unverified recovery envelope. */
function isIdentityFailure(call: InventoryCallEvidence): boolean {
  if (call.toolName !== 'checkStock' || call.state !== 'result') return false;
  const output = asRecord(call.output);
  if (output?.ok !== false) return false;
  return asRecord(output.error)?.kind === 'catalog_identity_unverified';
}

/** True when a completed step ran a successful catalog search. */
function isSearchSuccess(call: InventoryCallEvidence): boolean {
  return (
    call.toolName === 'searchCatalog' &&
    call.state === 'result' &&
    asRecord(call.output)?.ok === true
  );
}

export interface CatalogStockRecoveryInput {
  readonly text: string;
  readonly history: ReadonlyArray<CatalogStockRecoveryMessage>;
  readonly snapshot: CatalogStockRecoverySnapshot | null;
  /**
   * Exact fixed clarification text the adapter used for its immediately
   * preceding question, or `undefined` when the bot did not clarify. It is a
   * delimiter only: the domain never imports the adapter copy.
   */
  readonly clarificationText?: string;
}

/**
 * Recover a current availability phrase, a strict affirmative continuation
 * whose subject comes from a real customer turn, or a strict answer to the
 * bot's own fixed clarification. Everything else returns `none` so the
 * ordinary model turn keeps its freedom.
 *
 * The customer, never the assistant, supplies the availability intent and the
 * product phrase. The assistant's availability question is only a constraint:
 * it must be the immediately preceding turn, and any subject it names must
 * resolve unambiguously to the customer's exact product and variant. A
 * question that names no subject (generic offer wording) constrains nothing;
 * an unsupported or conflicting proposal rejects the recovery. The
 * clarification continuation likewise requires the exact fixed delimiter as
 * the immediately preceding turn plus a bounded, recognized customer
 * continuation chain that reaches an authentic availability turn for the same
 * identity, and resolves its answer strictly over candidate identities (one
 * product, or one explicit product+variant pair).
 */
export function selectCatalogStockRecovery(
  input: CatalogStockRecoveryInput,
): CatalogStockRecoveryDecision {
  const currentWords = words(input.text);
  if (currentWords.some((word) => AVAILABILITY_CUES.has(word))) {
    return resolve(input.snapshot, new Set(referenceTokens(input.text)));
  }
  const clarification = clarificationAnswer(input);
  if (clarification !== null) return clarification;
  if (!AFFIRMATIVES.has(normalizePhrase(input.text))) {
    return { kind: 'none' };
  }
  const assistant = input.history[input.history.length - 1];
  const customer = input.history[input.history.length - 2];
  if (
    assistant === undefined ||
    assistant.role !== 'assistant' ||
    !isAvailabilityQuestion(assistant.content)
  ) {
    return { kind: 'none' };
  }
  if (
    customer === undefined ||
    customer.role !== 'user' ||
    !hasAvailabilityCue(customer.content)
  ) {
    return { kind: 'none' };
  }
  const decision = resolve(
    input.snapshot,
    new Set(referenceTokens(String(customer.content))),
  );
  if (decision.kind !== 'recover') return { kind: 'none' };
  // The assistant question may only repeat the customer's exact subject. A
  // named subject — supported or not, same product or not, same variant or
  // not — must resolve unambiguously to the SAME product AND variant, else the
  // customer is not confirmed to have affirmed that subject. Generic wording
  // names no subject and constrains nothing.
  const assistantTokens = assistantSubjectTokens(assistant.content);
  if (assistantTokens.length > 0) {
    const proposed = resolve(input.snapshot, new Set(assistantTokens));
    if (
      proposed.kind !== 'recover' ||
      proposed.target.productId !== decision.target.productId ||
      proposed.target.variantId !== decision.target.variantId
    ) {
      return { kind: 'none' };
    }
  }
  return decision;
}

export type CatalogStockRecoveryDirective =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'force-stock';
      readonly target: CatalogStockRecoveryTarget;
    }
  | { readonly kind: 'force-final' }
  | { readonly kind: 'fail-closed' };

export type CatalogStockRecoveryPhase =
  | 'candidate'
  | 'stock'
  | 'final'
  | 'complete'
  | 'failed';

export interface CatalogStockRecoveryStepOutcome {
  /** Evidence the R2 guard must record, with the effective input applied. */
  readonly calls: readonly InventoryCallEvidence[];
  /** True when the forced choreography was violated (fail closed). */
  readonly fault: boolean;
}

function forcedInput(
  target: CatalogStockRecoveryTarget,
): Record<string, string> {
  return target.variantId === null
    ? { productId: target.productId }
    : { productId: target.productId, variantId: target.variantId };
}

/** The exact server-selected args the forced `checkStock` must execute. */
export function catalogStockRecoveryInput(
  target: CatalogStockRecoveryTarget,
): Record<string, string> {
  return forcedInput(target);
}

function isForcedStockStep(calls: readonly InventoryCallEvidence[]): boolean {
  return (
    calls.length === 1 &&
    calls[0].toolName === 'checkStock' &&
    calls[0].state !== 'denied'
  );
}

/**
 * Run-local one-shot recovery choreography.
 *
 * The adapter asks for `nextDirective()` before every step. The recovery only
 * arms after THIS run observed an identity-unverified `checkStock` failure and
 * a strictly later successful fresh search; a prior-turn snapshot or the
 * assistant's prose can never arm it. Once armed, it forces exactly one
 * `checkStock` step and then one tool-free final step, and `deniesExecution()`
 * hard-denies every other tool (and everything after the stock step) before it
 * can run. Every deviation — a provider that ignores the forced tool, more than
 * one stock call, or a final step that still calls tools — fails closed. The
 * recovery only extends the step budget while those two steps are outstanding,
 * so ordinary runs keep their ordinary budget.
 */
export class CatalogStockRecoveryRun {
  #phase: CatalogStockRecoveryPhase;
  #target: CatalogStockRecoveryTarget | null = null;
  #engaged = false;
  #stockAuthorized = false;
  #declined = false;
  #steps = 0;
  #failureStep: number | null = null;
  #searchStep: number | null = null;

  constructor(
    private readonly options: {
      readonly checkStockAvailable: boolean;
      readonly select: () => CatalogStockRecoveryDecision;
      readonly snapshotAvailable?: () => boolean;
    },
  ) {
    this.#phase = options.checkStockAvailable ? 'candidate' : 'complete';
  }

  get phase(): CatalogStockRecoveryPhase {
    return this.#phase;
  }

  get target(): CatalogStockRecoveryTarget | null {
    return this.#target;
  }

  get failed(): boolean {
    return this.#phase === 'failed';
  }

  /**
   * Hard pre-execution lock. Before the recovery arms it never denies, so the
   * ordinary workflow keeps its freedom. Once it arms, only the single
   * authorized `checkStock` may run; every later tool, including the final
   * render step and any further batch, is denied before execution.
   */
  deniesExecution(toolName: unknown): boolean {
    if (!this.#engaged) return false;
    if (this.#phase === 'stock') {
      if (toolName === 'checkStock' && !this.#stockAuthorized) {
        this.#stockAuthorized = true;
        return false;
      }
      return true;
    }
    return true;
  }

  /**
   * True when the recovery gate was evaluated after a real identity failure
   * and a later fresh search, the selector could not pick one product, and a
   * valid snapshot is present. The adapter then owes the customer a truthful
   * clarification instead of an availability claim.
   */
  get requiresClarification(): boolean {
    return (
      this.#declined &&
      this.#phase === 'candidate' &&
      this.#gateSatisfied() &&
      (this.options.snapshotAvailable?.() ?? true)
    );
  }

  /** True only while forced recovery steps have not finished. */
  get extendsBudget(): boolean {
    return this.#phase === 'stock' || this.#phase === 'final';
  }

  /**
   * Arm only from evidence this run actually observed: an identity-unverified
   * `checkStock` failure and a strictly later successful fresh search. A
   * search success counter, a prior-turn snapshot, or assistant prose is never
   * enough, so a proactive GET cannot happen before the failure + recovery.
   */
  #gateSatisfied(): boolean {
    return (
      this.#failureStep !== null &&
      this.#searchStep !== null &&
      this.#searchStep > this.#failureStep
    );
  }

  nextDirective(): CatalogStockRecoveryDirective {
    switch (this.#phase) {
      case 'candidate': {
        if (!this.#gateSatisfied()) return { kind: 'none' };
        const decision = this.options.select();
        if (decision.kind !== 'recover') {
          this.#declined = true;
          return { kind: 'none' };
        }
        this.#target = decision.target;
        this.#phase = 'stock';
        this.#engaged = true;
        this.#stockAuthorized = false;
        return { kind: 'force-stock', target: decision.target };
      }
      case 'final':
        return { kind: 'force-final' };
      case 'stock':
        // Reaching a second step while the forced stock step is still
        // outstanding means the choreography was skipped: fail closed.
        this.#phase = 'failed';
        return { kind: 'fail-closed' };
      case 'complete':
        return { kind: 'none' };
      case 'failed':
        return { kind: 'fail-closed' };
    }
  }

  /**
   * Validate the step that just finished. In the candidate phase it only
   * records the gate evidence (step-indexed, so a same-batch or reversed
   * failure/search never arms). During the forced stock step the recorded
   * identity is replaced with the trusted server-selected input so the guard
   * accounts for what actually reached the backend.
   */
  completeStep(
    calls: readonly InventoryCallEvidence[],
  ): CatalogStockRecoveryStepOutcome {
    if (this.#phase === 'candidate') {
      this.#steps += 1;
      for (const call of calls) {
        if (isIdentityFailure(call)) this.#failureStep = this.#steps;
        if (isSearchSuccess(call)) this.#searchStep = this.#steps;
      }
      return { calls, fault: false };
    }
    if (this.#phase === 'stock') {
      const target = this.#target;
      if (target === null || !isForcedStockStep(calls)) {
        this.#phase = 'failed';
        return { calls, fault: true };
      }
      const effective = forcedInput(target);
      this.#phase = 'final';
      return {
        calls: calls.map((call) =>
          call.toolName === 'checkStock' ? { ...call, input: effective } : call,
        ),
        fault: false,
      };
    }
    if (this.#phase === 'final') {
      const fault = calls.length > 0;
      this.#phase = fault ? 'failed' : 'complete';
      return { calls, fault };
    }
    return { calls, fault: false };
  }
}
