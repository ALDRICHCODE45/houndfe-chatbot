import type { CatalogItemResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  deriveAvailability,
  type ItemAvailability,
} from './minimal-catalog-availability';
import { MAX_CATALOG_OPTIONS } from './minimal-catalog-relevance';
import {
  fold,
  significantQueryWords,
} from './minimal-catalog-search-broadening';

/**
 * S13: code-rendered catalog options. The model decides WHAT to search; the
 * customer-facing options message (order, labels, agotado line, closing and
 * restock offer) is built here from the search result. Pure, no I/O.
 *
 * Classification (S13b) uses only data the bot has: the significant query
 * words (T4 filler rules, category words such as "croquetas" kept) split
 * into brand tokens (a word of some result item's `brand`) and type tokens
 * (the rest). Each item is:
 *   - exact: backend `match: 'all'`, or every token in name/brand/description
 *     (a `match: 'partial'` item is never exact);
 *   - same_type: a type token in name/description;
 *   - brand_only: a brand token in its brand (or name), no type token;
 *   - other: nothing matches (never offered);
 *   - contradicts (checked first): the query names a life stage or species
 *     and the item's name/description names only the opposing one
 *     (adult croquetas for "croquetas para cachorro"). Never offered, never
 *     counted, never mentioned.
 */

export type CatalogOptionClass =
  | 'exact'
  | 'same_type'
  | 'brand_only'
  | 'other'
  | 'contradicts';

/**
 * S10/S13: opposing attribute groups, as folded singular stems. "7+" is
 * matched on the raw text (it is not a word).
 */
const CONTRADICTION_GROUPS: ReadonlyArray<
  readonly [ReadonlySet<string>, ReadonlySet<string>]
> = [
  [
    new Set(['cachorro', 'puppy', 'junior', 'gatito', 'kitten']),
    new Set(['adulto', 'adult', 'senior', '7+']),
  ],
  [new Set(['perro', 'canino', 'dog']), new Set(['gato', 'felino', 'cat'])],
];

/** Attribute stems in a text, plus the "7+" marker. */
function attributeStems(text: string | null | undefined): Set<string> {
  const out = stems(text);
  if (typeof text === 'string' && /(?<![\p{N}])7\s*\+/u.test(text))
    out.add('7+');
  return out;
}

const hasAny = (set: ReadonlySet<string>, terms: ReadonlySet<string>) =>
  [...terms].some((term) => set.has(term));

/** The item names only the opposing side of a group the query asked for. */
function contradicts(
  query: ReadonlySet<string>,
  item: Partial<CatalogItemResponse>,
): boolean {
  const text = new Set([
    ...attributeStems(item.name),
    ...attributeStems(item.description),
  ]);
  return CONTRADICTION_GROUPS.some(([a, b]) =>
    [
      [a, b],
      [b, a],
    ].some(
      ([asked, opposing]) =>
        hasAny(query, asked) &&
        !hasAny(query, opposing) &&
        hasAny(text, opposing) &&
        !hasAny(text, asked),
    ),
  );
}

/** S13c/d: fixed copy (usted; tú via customer-style phrase pairs). */
export const CATALOG_EXACT_OPENING = 'Encontré estas opciones:';
export const CATALOG_ALTERNATIVES_OPENING =
  ' no tengo, pero tengo estas opciones:';
export const CATALOG_CHOOSE_QUESTION = '¿Cuál le gustaría llevar?';
/**
 * One available option and a cart: the existing cart offer copy, so a bare
 * "sí" keeps adding it (cart grounding reads an add verb in the question).
 */
export const CATALOG_ADD_QUESTION = '¿Se lo agrego al carrito?';
export const CATALOG_RESTOCK_LEAD = 'Y si la que busca es ';
export const CATALOG_RESTOCK_TAIL =
  ', con gusto le averiguo cuándo nos vuelve a llegar.';
export const CATALOG_RESTOCK_QUESTION =
  '¿Quiere que le pregunte al equipo cuándo vuelve a llegar?';
/** S13f: replaces the choose question when more relevant products exist. */
export const CATALOG_NARROWING_QUESTION =
  'Tengo más opciones. ¿Qué marca, tamaño o presentación busca?';
const OTHER_BRAND_LABEL = ' (de otra marca)';
const DESCRIPTION_MAX = 90;
/** Presentations listed per option line; the rest are counted. */
const PRESENTATIONS_MAX = 6;

const RANK: Record<
  Exclude<CatalogOptionClass, 'other' | 'contradicts'>,
  number
> = {
  exact: 0,
  same_type: 1,
  brand_only: 2,
};

/** Folded, singular-ish token for comparisons ("Croquetas" → "croqueta"). */
function stem(word: string): string {
  const folded = fold(word);
  return folded.length > 3 && folded.endsWith('s')
    ? folded.slice(0, -1)
    : folded;
}

function stems(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof text !== 'string') return out;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) out.add(stem(match[0]));
  return out;
}

/** Stems of every brand word among the result items. */
function brandStems(
  items: readonly Partial<CatalogItemResponse>[],
): Set<string> {
  const out = new Set<string>();
  for (const item of items) for (const s of stems(item.brand)) out.add(s);
  return out;
}

interface QueryTokens {
  brand: string[];
  type: string[];
  /** Life-stage / species stems the query states (S10 contradictions). */
  attributes: Set<string>;
}

function queryTokens(q: string, brands: ReadonlySet<string>): QueryTokens {
  const brand: string[] = [];
  const type: string[] = [];
  for (const { word } of significantQueryWords(q)) {
    const s = stem(word);
    const bucket = brands.has(s) ? brand : type;
    if (!bucket.includes(s)) bucket.push(s);
  }
  return { brand, type, attributes: attributeStems(q) };
}

function classify(
  tokens: QueryTokens,
  item: Partial<CatalogItemResponse>,
): CatalogOptionClass {
  const all = [...tokens.brand, ...tokens.type];
  if (all.length === 0) return 'other';
  if (contradicts(tokens.attributes, item)) return 'contradicts';
  const name = stems(item.name);
  const description = stems(item.description);
  const brand = stems(item.brand);
  const everywhere = new Set([...name, ...description, ...brand]);
  if (
    item.match !== 'partial' &&
    (item.match === 'all' || all.every((t) => everywhere.has(t)))
  )
    return 'exact';
  if (tokens.type.some((t) => name.has(t) || description.has(t)))
    return 'same_type';
  if (tokens.brand.some((t) => brand.has(t) || name.has(t)))
    return 'brand_only';
  return 'other';
}

/** S13b: the class of one item for query `q` among the result `items`. */
export function classifyCatalogItem(
  q: string,
  item: Partial<CatalogItemResponse>,
  items: readonly Partial<CatalogItemResponse>[],
): CatalogOptionClass {
  return classify(queryTokens(q, brandStems([...items, item])), item);
}

export interface CatalogOption {
  item: CatalogItemResponse;
  cls: Exclude<CatalogOptionClass, 'other' | 'contradicts'>;
  availability: ItemAvailability;
  agotado: boolean;
  /** A brand was requested and this item's brand is a different one. */
  otherBrand: boolean;
}

export interface CatalogOptionsPlan {
  /** The customer's significant words as asked ("Croquetas Pedigree"). */
  requested: string;
  /** Offered options in render order (≤ 3, available first). */
  options: CatalogOption[];
  /** Relevant products not shown (S13f narrowing question). */
  moreResults: number;
  /**
   * Some items contradicted a stated life stage / species. With no option
   * left the section is «{lo pedido} no tengo.» alone (no false match).
   */
  contradicted: boolean;
}

/** "croquetas de pedigree" → "Croquetas de Pedigree" (brand casing kept). */
function requestedPhrase(
  q: string,
  items: readonly Partial<CatalogItemResponse>[],
): string {
  const words = significantQueryWords(q);
  const span = q.slice(words[0].start, words[words.length - 1].end);
  const brandCase = new Map<string, string>();
  for (const item of items)
    for (const match of (item.brand ?? '').matchAll(/[\p{L}\p{N}]+/gu))
      brandCase.set(stem(match[0]), match[0]);
  const cased = span.replace(
    /[\p{L}\p{N}]+/gu,
    (word) => brandCase.get(stem(word)) ?? word,
  );
  return cased.charAt(0).toUpperCase() + cased.slice(1);
}

/**
 * S13b: classifies every search item and picks the options to present:
 * available before agotado, then exact → same_type → brand_only (stable in
 * backend order), at most {@link MAX_CATALOG_OPTIONS}. `null` when nothing is
 * classifiable (no significant word or no relevant item): the model answers
 * as before.
 */
export function planCatalogOptions(
  q: string,
  items: readonly CatalogItemResponse[],
): CatalogOptionsPlan | null {
  if (significantQueryWords(q).length === 0) return null;
  const tokens = queryTokens(q, brandStems(items));
  const relevant: CatalogOption[] = [];
  let contradicted = false;
  for (const item of items) {
    const cls = classify(tokens, item);
    if (cls === 'contradicts') contradicted = true;
    if (cls === 'other' || cls === 'contradicts') continue;
    const availability = deriveAvailability(item);
    const itemBrand = stems(item.brand);
    relevant.push({
      item,
      cls,
      availability,
      agotado: availability.status === 'out_of_stock',
      otherBrand:
        tokens.brand.length > 0 && !tokens.brand.some((t) => itemBrand.has(t)),
    });
  }
  if (relevant.length === 0)
    return contradicted
      ? {
          requested: requestedPhrase(q, items),
          options: [],
          moreResults: 0,
          contradicted,
        }
      : null;
  const ordered = relevant
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        Number(a.option.agotado) - Number(b.option.agotado) ||
        RANK[a.option.cls] - RANK[b.option.cls] ||
        a.index - b.index,
    )
    .map(({ option }) => option);
  return {
    requested: requestedPhrase(q, items),
    options: ordered.slice(0, MAX_CATALOG_OPTIONS),
    moreResults: Math.max(0, ordered.length - MAX_CATALOG_OPTIONS),
    contradicted,
  };
}

const mxn = (cents: number) => `$${(cents / 100).toFixed(2)} MXN`;
const isCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function shortDescription(item: CatalogItemResponse): string | null {
  const raw = typeof item.description === 'string' ? item.description : '';
  const first = raw
    .split(/\n|(?<=[.!?])\s/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (first.length === 0 || fold(first) === fold(item.name)) return null;
  const bounded =
    first.length > DESCRIPTION_MAX
      ? `${first.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
      : first;
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`;
}

function priceText(option: CatalogOption): string | null {
  const { item, availability } = option;
  const variants = Array.isArray(item.variants) ? item.variants : [];
  if (variants.length > 0) {
    const status = new Map(
      availability.variants.map((v) => [v.variantId, v.status]),
    );
    const listed = variants
      .slice(0, PRESENTATIONS_MAX)
      .map((variant) => {
        const price = isCents(variant.priceCents)
          ? ` ${mxn(variant.priceCents)}`
          : '';
        const gone =
          status.get(variant.variantId) === 'out_of_stock' ? ' (agotada)' : '';
        return `${variant.name}${price}${gone}`;
      })
      .join(', ');
    const rest = variants.length - PRESENTATIONS_MAX;
    return rest > 0 ? `${listed} y ${rest} presentaciones más` : listed;
  }
  if (isCents(item.price?.priceCents)) return mxn(item.price.priceCents);
  if (isCents(item.price?.fromPriceCents))
    return `desde ${mxn(item.price.fromPriceCents)}`;
  return null;
}

/** S13e: bold name, short description, presentations with prices. */
function optionLine(option: CatalogOption): string {
  const label = `• *${option.item.name}*${option.otherBrand ? OTHER_BRAND_LABEL : ''}`;
  const detail = [shortDescription(option.item), priceText(option)]
    .filter((part): part is string => part !== null)
    .join(' ');
  return detail.length === 0 ? label : `${label}: ${detail}`;
}

/** The exact product name, plus its presentations when it has several. */
function agotadoName(option: CatalogOption): string {
  const names = option.availability.agotadoPresentations;
  if (names.length < 2) return option.item.name;
  const list = `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return `${option.item.name} (${list})`;
}

export interface CatalogRestockOffer {
  productId: string;
  variantId?: string;
  name: string;
}

/** A restock subject the existing flow can prepare (no presentation choice). */
function restockSubject(option: CatalogOption): CatalogRestockOffer | null {
  const variants = Array.isArray(option.item.variants)
    ? option.item.variants
    : [];
  if (variants.length > 1) return null;
  return {
    productId: option.item.productId,
    ...(variants.length === 1 ? { variantId: variants[0].variantId } : {}),
    name: option.item.name,
  };
}

export interface RenderedCatalogOptions {
  text: string;
  /** The ONE agotado product the closing offers to ask about, if any. */
  restockOffer: CatalogRestockOffer | null;
  /**
   * The restock offer is the message's only yes/no question, so a bare "sí"
   * accepts it (false when the closing also offers a cart add).
   */
  restockAcceptsYes: boolean;
  /** Every product the text presents, in order (registry/photos/cart). */
  shown: CatalogItemResponse[];
}

/**
 * S13a/c/d/e/f: the customer-facing options message for one turn's catalog
 * reads (one section per search, products deduped across sections, one
 * closing). `style` styles ONLY the fixed copy (usted/tú via customer-style);
 * product names and descriptions are data and never rewritten.
 */
export function renderCatalogOptions(
  plans: readonly CatalogOptionsPlan[],
  opts: {
    restockAvailable: boolean;
    style: (fixed: string) => string;
    /** A cart exists: one available option closes with the add offer. */
    cartAvailable?: boolean;
  },
): RenderedCatalogOptions {
  const { style } = opts;
  const seen = new Set<string>();
  const sections = plans
    .map((plan) => ({
      plan,
      options: plan.options.filter((option) => {
        if (seen.has(option.item.productId)) return false;
        seen.add(option.item.productId);
        return true;
      }),
    }))
    .filter(
      (section) =>
        section.options.length > 0 || section.plan.options.length === 0,
    );
  const all = sections.flatMap((section) => section.options);
  const anyAvailable = all.some((option) => !option.agotado);
  const target = opts.restockAvailable
    ? (all
        .filter((option) => option.agotado)
        .map((option) => ({ option, subject: restockSubject(option) }))
        .find((candidate) => candidate.subject !== null) ?? null)
    : null;
  const blocks: string[] = [];
  for (const { plan, options } of sections) {
    if (plan.options.length === 0) {
      // Only contradicting items: say so, list none of them.
      blocks.push(`${plan.requested} no tengo.`);
      continue;
    }
    const exact = options.some((option) => option.cls === 'exact');
    const available = options.filter((option) => !option.agotado);
    const agotado = options.filter((option) => option.agotado);
    const lines: string[] = [];
    if (available.length > 0) {
      lines.push(
        exact
          ? style(CATALOG_EXACT_OPENING)
          : `${plan.requested}${style(CATALOG_ALTERNATIVES_OPENING)}`,
      );
      lines.push(...available.map(optionLine));
      lines.push(
        ...agotado.map(
          (option) =>
            `Además, tengo ${agotadoName(option)}, pero está agotado.`,
        ),
      );
    } else {
      if (!exact) lines.push(`${plan.requested} no tengo.`);
      lines.push(
        ...agotado
          .filter((option) => option !== target?.option)
          .map((option) => `${agotadoName(option)} está agotado.`),
      );
    }
    if (lines.length > 0) blocks.push(lines.join('\n'));
  }
  let closing: string | null;
  let addOffer = false;
  if (anyAvailable) {
    const narrowing = sections.some((section) => section.plan.moreResults > 0);
    const availableOptions = all.filter((option) => !option.agotado);
    addOffer =
      !narrowing &&
      opts.cartAvailable === true &&
      availableOptions.length === 1 &&
      (availableOptions[0].item.variants?.length ?? 0) <= 1;
    let question = CATALOG_CHOOSE_QUESTION;
    if (narrowing) question = CATALOG_NARROWING_QUESTION;
    else if (addOffer) question = CATALOG_ADD_QUESTION;
    closing = style(question);
    if (target !== null)
      closing += ` ${style(CATALOG_RESTOCK_LEAD)}${target.option.item.name}${style(CATALOG_RESTOCK_TAIL)}`;
  } else {
    closing =
      target === null
        ? null
        : `${agotadoName(target.option)} está agotado. ${style(CATALOG_RESTOCK_QUESTION)}`;
  }
  if (closing !== null) blocks.push(closing);
  return {
    text: blocks.join('\n\n'),
    restockOffer: target?.subject ?? null,
    restockAcceptsYes: target !== null && !addOffer,
    shown: all.map((option) => option.item),
  };
}
