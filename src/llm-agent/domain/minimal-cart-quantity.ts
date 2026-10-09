/**
 * Pure quantity-evidence grounding for minimal cart operations (S1, S3, S4, S6).
 *
 * The model may interpret everyday language and choose an operation, but it
 * may not invent a quantity. This module accepts the model's proposal and only
 * returns a cart-bound `MinimalCartQuantityIntent` when the number is grounded
 * in the CURRENT user text:
 *
 *   - An explicit quantity must be cited with `quantityText`, a literal span of
 *     the current turn. The span is matched on whole words (case- and
 *     diacritic-insensitive) and the count parsed from it must agree with the
 *     model's number. An invented quote, a mismatched number, a dosage such as
 *     `500mg`, a bare substring of a dosage, a negative count, a competing pair
 *     of counts, or a number whose matched span is followed by a measurement
 *     unit in the current text all fail closed.
 *   - When the model states no quantity, a previously validated quantity may be
 *     carried over ONLY in the same pending request: `continuation === true` and
 *     the pending intent is bound to the same `productId` with an identical
 *     operation. It is never inherited from saved cart units or another
 *     product's request.
 *   - Otherwise the caller must ask for a quantity: the result preserves
 *     `productId` and `operation` but carries no `quantity`.
 *
 * Operation policy mirrors the existing cart tools:
 *   - `add` / `subtract` require a positive count (whole units);
 *   - `set` fixes the line total; a `0` clear must cite a literal `0`/`cero` in
 *     the current message, never a bare model number;
 *   - `remove` clears the whole line only when the CURRENT message explicitly
 *     asks for whole-line removal (a removal verb plus a whole-line object such
 *     as "Quita el producto", with no partial count). It needs no count and
 *     always emits `0` (matching `setCartItem(quantity: 0)`).
 *
 * This is grounding, not universal language recognition. Unsupported phrasing
 * or missing evidence asks for clarification instead of guessing. The caller
 * owns pending-request binding and clearing after an attempt; this module has
 * no service or cart-store access and performs no writes.
 */

/** The minimal cart operation the caller will map onto a cart tool. */
export type CartOperation = 'add' | 'set' | 'subtract' | 'remove';

/** A quantity bound to one product and operation, ready for a cart write. */
export type MinimalCartQuantityIntent = {
  productId: string;
  operation: CartOperation;
  quantity?: number;
};

/**
 * Server-owned conversational context for one pending request. A superset of a
 * grounded intent: a quantity clarification may retain the chosen identity and
 * opaque reference with NO count, so the next explicit quantity targets the
 * same line even though the SDK tool messages were dropped from history. The
 * pure grounding helper never returns these extra fields; only the caller's
 * conversation wrapper records them.
 */
export type MinimalCartPendingRequest = MinimalCartQuantityIntent & {
  productName?: string;
  variantId?: string;
  variantName?: string;
  reference?: string;
};

/** Inputs for one grounding attempt against the current user text. */
export interface CartQuantityEvidenceInput {
  /** Current user turn; the only text a quote may come from. */
  text: string;
  /** Verified product id the operation is bound to. */
  productId: string;
  /** Operation proposed by the model. */
  operation: CartOperation;
  /** Model-proposed number, or `null` when it claims none. */
  quantity: number | null;
  /** Literal cited span from the current text, or `null` when none. */
  quantityText: string | null;
  /**
   * Server-trusted product label for the bound line, when known. Used ONLY to
   * recognize a named whole-line removal (e.g. "Quita el ibuprofeno"). It is
   * never model-supplied: the caller resolves it from the verified selection
   * registry. A partial count still rejects whole-line removal.
   */
  productName?: string;
  /** Server-trusted variant label for the bound line, when known. */
  variantName?: string;
  /** Previously validated intent for the same pending request, if any. */
  pending?: MinimalCartQuantityIntent;
  /** True only when this turn continues the same pending request. */
  continuation: boolean;
}

export type CartQuantityGroundingResult =
  | { kind: 'ready'; intent: MinimalCartQuantityIntent }
  | { kind: 'quantity_required'; intent: MinimalCartQuantityIntent }
  | { kind: 'invalid_evidence' };

const OPERATIONS: ReadonlySet<string> = new Set<CartOperation>([
  'add',
  'set',
  'subtract',
  'remove',
]);

/**
 * Documented count-word limits: only the clear Spanish cardinals `cero` and
 * `un/una/uno` through `diez` are recognized. Numbers above ten must be cited
 * as digits. Extending this map is an explicit, tested decision, not silent
 * language sprawl.
 */
const COUNT_WORDS: Readonly<Record<string, number>> = {
  cero: 0,
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

/** Measurement/dosage units that must never be read as a quantity count. */
const MEASURE_UNITS: ReadonlySet<string> = new Set([
  'mg',
  'mcg',
  'ug',
  'g',
  'gr',
  'grs',
  'gramo',
  'gramos',
  'kg',
  'kilo',
  'kilos',
  'kilogramo',
  'kilogramos',
  'ml',
  'l',
  'lt',
  'litro',
  'litros',
  'oz',
  'onza',
  'onzas',
  'lb',
  'libra',
  'libras',
  'cm',
  'mm',
]);

/** Minus sign, ASCII and the common Unicode minus. */
const NEGATIVE_NUMBER = /(?:^|[^a-z0-9])(?:-|\u2212)\s*\d/;

/**
 * Obvious imperative "add" verbs. Used only for the narrow add-vs-set
 * contradiction check below; this is deliberately not intent classification.
 */
const ADD_VERBS: ReadonlySet<string> = new Set([
  'agrega',
  'agregar',
  'agregame',
  'agregale',
  'anade',
  'anadir',
  'suma',
  'sumar',
  'sumale',
  'incorpora',
  'incorporar',
  'mete',
  'meter',
  'anexa',
  'anexar',
]);

/**
 * Clear set/total markers that legitimately disable the add-vs-set guard. A
 * generic "solo" is deliberately NOT here: "agrega solo 2" is still an add
 * unless a real set verb or total context is present. This is not intent
 * classification.
 */
const SET_MARKERS: ReadonlySet<string> = new Set([
  'deja',
  'dejame',
  'dejar',
  'dejale',
  'queda',
  'quedate',
  'pon',
  'poner',
  'ponme',
  'establece',
  'establecer',
  'fija',
  'fijar',
  'ajusta',
  'ajustar',
  'total',
]);

/** Whole-line removal verbs; paired with an object below to prove a line clear. */
const REMOVAL_VERBS: ReadonlySet<string> = new Set([
  'quita',
  'quitar',
  'quitas',
  'quitame',
  'elimina',
  'eliminar',
  'eliminas',
  'eliminame',
  'borra',
  'borrar',
  'borras',
  'borrame',
  'saca',
  'sacar',
  'sacas',
  'sacame',
  'remueve',
  'remover',
  'remueves',
]);

/** Objects that name an entire line, distinguishing a clear from a partial cut. */
const WHOLE_LINE_OBJECTS: ReadonlySet<string> = new Set([
  'producto',
  'productos',
  'linea',
  'lineas',
  'renglon',
  'renglones',
  'articulo',
  'articulos',
  'todo',
  'todos',
  'toda',
  'todas',
  'completo',
  'completa',
  'completos',
  'completas',
]);

/**
 * Narrow negation markers. A negation that precedes the removal verb turns
 * the sentence into a denial ("No eliminar el ibuprofeno"), which must never
 * authorize a clear. This is deliberately a small closed list, not intent
 * classification; an unlisted phrasing simply fails closed to clarification.
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  'no',
  'nunca',
  'jamas',
  'tampoco',
  'ni',
  'sin',
]);

type ParsedCount =
  | { status: 'ok'; value: number }
  | { status: 'none' }
  | { status: 'invalid' };

type ResolvedEvidence =
  | { status: 'ok'; value: number }
  | { status: 'none' }
  | { status: 'invalid' };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isWordChar(char: string): boolean {
  return char.length === 1 && /[a-z0-9]/.test(char);
}

/**
 * Index of the first whole-word occurrence of `needle` in `haystack`, or `-1`.
 * Returning the position lets a citation be judged in its real surroundings.
 */
function findWholeToken(haystack: string, needle: string): number {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    const before = index === 0 ? '' : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= haystack.length ? '' : haystack[afterIndex];
    if (!isWordChar(before) && !isWordChar(after)) return index;
    from = index + 1;
  }
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** True when a measurement unit immediately follows the digit run. */
function measureUnitFollows(text: string, endIndex: number): boolean {
  let index = endIndex;
  while (index < text.length && (text[index] === ' ' || text[index] === '\t'))
    index += 1;
  const match = /^[a-z]+/.exec(text.slice(index));
  return match !== null && MEASURE_UNITS.has(match[0]);
}

/** True when `text` states any generic count (digit run or count word). */
function hasCountToken(text: string): boolean {
  const haystack = normalize(text);
  for (const token of tokenize(text)) {
    if (COUNT_WORDS[token] !== undefined) return true;
  }
  for (const match of haystack.matchAll(/\d+/g)) {
    if (!measureUnitFollows(haystack, match.index + match[0].length))
      return true;
  }
  return false;
}

/**
 * True when a negation token precedes the FIRST removal verb, i.e. the message
 * denies the removal rather than requesting it. Fail-closed: a sentence that
 * negates before naming the removal may never clear a line.
 */
function negationPrecedesRemoval(text: string): boolean {
  const tokens = tokenize(text);
  const firstRemoval = tokens.findIndex((token) => REMOVAL_VERBS.has(token));
  if (firstRemoval <= 0) return false;
  for (let index = 0; index < firstRemoval; index += 1) {
    if (NEGATION_TOKENS.has(tokens[index])) return true;
  }
  return false;
}

/**
 * Whole-line removal must be explicitly stated in the CURRENT message: a
 * removal verb AND a whole-line object (a generic line word OR a server-trusted
 * product/variant label), with no partial count and no preceding negation. This
 * keeps the model from deleting a line off a bare product or dosage
 * confirmation. `trustedLabels` must come from the verified selection, never
 * from the model.
 */
function hasWholeLineRemovalEvidence(
  text: string,
  trustedLabels: readonly string[],
): boolean {
  const tokens = tokenize(text);
  if (!tokens.some((token) => REMOVAL_VERBS.has(token))) return false;
  if (negationPrecedesRemoval(text)) return false;
  const haystack = normalize(text);
  const namedObject = trustedLabels.some((label) => {
    const needle = normalize(label).trim();
    return needle.length > 0 && findWholeToken(haystack, needle) !== -1;
  });
  if (!tokens.some((token) => WHOLE_LINE_OBJECTS.has(token)) && !namedObject)
    return false;
  return !hasCountToken(text);
}

/**
 * Parse a single count from an already-normalized citation. Fails closed when
 * a count is ambiguous, negative, a dosage, or there are several counts.
 */
function parseCitationCount(citation: string): ParsedCount {
  if (NEGATIVE_NUMBER.test(citation)) return { status: 'invalid' };

  const counts: number[] = [];
  let invalid = false;
  for (const match of citation.matchAll(/\d+/g)) {
    const value = Number(match[0]);
    if (
      !Number.isSafeInteger(value) ||
      measureUnitFollows(citation, match.index + match[0].length)
    ) {
      invalid = true;
      continue;
    }
    counts.push(value);
  }

  for (const token of tokenize(citation)) {
    const word = COUNT_WORDS[token];
    if (word !== undefined) counts.push(word);
  }

  if (invalid) return { status: 'invalid' };
  if (counts.length === 0) return { status: 'none' };
  if (counts.length > 1) return { status: 'invalid' };
  return { status: 'ok', value: counts[0] };
}

/**
 * Resolve the explicit quantity from the citation, or report none/invalid. A
 * model number without a citation is never trusted, including `set` zero; the
 * only exception is the whole-line `remove` zero, which the removal-evidence
 * check grounds independently.
 */
function resolveEvidence(input: CartQuantityEvidenceInput): ResolvedEvidence {
  const { text, operation, quantity, quantityText } = input;

  if (quantityText !== null) {
    if (typeof quantityText !== 'string') return { status: 'invalid' };
    const citation = normalize(quantityText).trim();
    if (citation.length === 0) return { status: 'invalid' };
    const haystack = normalize(text);
    const matchIndex = findWholeToken(haystack, citation);
    if (matchIndex === -1) return { status: 'invalid' };
    // Judge the citation in context: a count immediately followed by a
    // measurement unit in the real turn is a dosage, not a quantity.
    if (measureUnitFollows(haystack, matchIndex + citation.length))
      return { status: 'invalid' };
    const parsed = parseCitationCount(citation);
    if (parsed.status !== 'ok') return { status: 'invalid' };
    if (quantity !== null) {
      if (!Number.isSafeInteger(quantity) || quantity !== parsed.value)
        return { status: 'invalid' };
    }
    return { status: 'ok', value: parsed.value };
  }

  if (quantity !== null) {
    if (!Number.isSafeInteger(quantity)) return { status: 'invalid' };
    // A whole-line `remove` may state zero with no count token to cite; the
    // removal itself is independently grounded by the removal-evidence check.
    if (quantity === 0 && operation === 'remove')
      return { status: 'ok', value: 0 };
    return { status: 'invalid' };
  }

  return { status: 'none' };
}

/** Whether a resolved count is legal for the operation. */
function countAllowed(operation: CartOperation, value: number): boolean {
  if (operation === 'remove') return value === 0;
  if (operation === 'add' || operation === 'subtract') return value > 0;
  return value >= 0;
}

/**
 * Narrow deterministic guard: an explicit quantity in an obvious "add"
 * sentence cannot be legitimized as a `set`. Only the add-vs-set direction is
 * checked, and only when the model cited explicit evidence. A clear set verb or
 * total marker disables the check; a generic "solo" does not. This is not
 * general intent classification; if broader verb reasoning is ever needed, it
 * belongs in the model contract, not here.
 */
function contradictsSet(input: CartQuantityEvidenceInput): boolean {
  if (input.operation !== 'set') return false;
  const tokens = tokenize(input.text);
  if (tokens.some((token) => SET_MARKERS.has(token))) return false;
  return tokens.some((token) => ADD_VERBS.has(token));
}

function hasMatchingPending(
  input: CartQuantityEvidenceInput,
): input is CartQuantityEvidenceInput & {
  pending: MinimalCartQuantityIntent;
} {
  const { pending, productId, operation, continuation } = input;
  if (continuation !== true) return false;
  if (pending === undefined || pending === null) return false;
  if (typeof pending !== 'object') return false;
  if (pending.productId !== productId) return false;
  return pending.operation === operation;
}

/**
 * Ground a proposed cart quantity against the current user text and a pending
 * request. Returns a ready intent, a quantity request, or a fail-closed
 * `invalid_evidence`. Pure: no I/O, no cart access, no mutation.
 */
export function groundCartQuantity(
  input: CartQuantityEvidenceInput,
): CartQuantityGroundingResult {
  if (input === null || typeof input !== 'object')
    return { kind: 'invalid_evidence' };
  const { text, productId, operation } = input;
  if (typeof text !== 'string') return { kind: 'invalid_evidence' };
  if (typeof productId !== 'string' || productId.length === 0)
    return { kind: 'invalid_evidence' };
  if (!OPERATIONS.has(operation)) return { kind: 'invalid_evidence' };

  const evidence = resolveEvidence(input);
  if (evidence.status === 'invalid') return { kind: 'invalid_evidence' };

  // Whole-line removal is authorized only by explicit current-message removal
  // evidence, never by a bare confirmation or a model-chosen operation alone.
  if (operation === 'remove') {
    if (evidence.status === 'ok' && evidence.value !== 0)
      return { kind: 'invalid_evidence' };
    const trustedLabels: string[] = [];
    if (typeof input.productName === 'string')
      trustedLabels.push(input.productName);
    if (typeof input.variantName === 'string')
      trustedLabels.push(input.variantName);
    if (!hasWholeLineRemovalEvidence(text, trustedLabels))
      return { kind: 'invalid_evidence' };
    return {
      kind: 'ready',
      intent: { productId, operation: 'remove', quantity: 0 },
    };
  }

  if (evidence.status === 'ok' && contradictsSet(input))
    return { kind: 'invalid_evidence' };

  if (evidence.status === 'ok') {
    if (!countAllowed(operation, evidence.value))
      return { kind: 'invalid_evidence' };
    return {
      kind: 'ready',
      intent: { productId, operation, quantity: evidence.value },
    };
  }

  if (hasMatchingPending(input)) {
    const carried = input.pending.quantity;
    if (
      typeof carried === 'number' &&
      Number.isSafeInteger(carried) &&
      countAllowed(operation, carried)
    ) {
      return {
        kind: 'ready',
        intent: { productId, operation, quantity: carried },
      };
    }
  }

  return { kind: 'quantity_required', intent: { productId, operation } };
}
