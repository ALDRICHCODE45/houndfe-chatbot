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
 *     and the item's name/description names only the opposing one / only
 *     other species (adult croquetas for "croquetas para cachorro", fish
 *     food for "alimento para aves"). Never offered, never counted, never
 *     mentioned.
 *   - mismatch (L33, checked next): the query names a species AND a type
 *     word, and the item lacks one of them ("Jaula para aves" for
 *     "alimento para aves"). Treated exactly like contradicts.
 */

export type CatalogOptionClass =
  | 'exact'
  | 'same_type'
  | 'brand_only'
  | 'other'
  | 'contradicts'
  | 'mismatch';

const stemSet = (words: readonly string[]) => new Set(words.map(stem));

/**
 * S10/S13: opposing life-stage groups, as folded singular stems. "7+" is
 * matched on the raw text (it is not a word).
 */
const STAGE_GROUPS: ReadonlyArray<
  readonly [ReadonlySet<string>, ReadonlySet<string>]
> = [
  [
    new Set(['cachorro', 'puppy', 'junior', 'gatito', 'kitten']),
    new Set(['adulto', 'adult', 'senior', '7+']),
  ],
];

/**
 * L33: species groups (folded singular stems). An item naming only species
 * of other groups contradicts the requested one. gatito/kitten and puppy
 * also name their species ("Para gatitos" is cat food).
 */
const SPECIES_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  stemSet(['perro', 'perros', 'canino', 'caninos', 'dog', 'dogs', 'puppy']),
  stemSet([
    'gato',
    'gatos',
    'felino',
    'felinos',
    'cat',
    'cats',
    'gatito',
    'gatitos',
    'kitten',
  ]),
  stemSet([
    'ave',
    'aves',
    'pájaro',
    'pájaros',
    'pajaro',
    'pajaros',
    'perico',
    'pericos',
    'canario',
    'canarios',
    'bird',
    'birds',
  ]),
  stemSet(['pez', 'peces', 'fish']),
  stemSet([
    'roedor',
    'roedores',
    'hámster',
    'hámsters',
    'hamster',
    'hamsters',
    'cuyo',
    'cuyos',
  ]),
  stemSet(['conejo', 'conejos']),
  stemSet(['reptil', 'reptiles', 'tortuga', 'tortugas']),
];
const SPECIES_STEMS: ReadonlySet<string> = new Set(
  SPECIES_GROUPS.flatMap((group) => [...group]),
);

/**
 * L33: generic food words, interchangeable for the species + type check
 * («croquetas para perro» keeps «Alimento seco para perros»).
 */
const FOOD_STEMS: ReadonlySet<string> = stemSet([
  'alimento',
  'comida',
  'croqueta',
]);

/** Attribute stems in a text, plus the "7+" marker. */
function attributeStems(text: string | null | undefined): Set<string> {
  const out = stems(text);
  if (typeof text === 'string' && /(?<![\p{N}])7\s*\+/u.test(text))
    out.add('7+');
  return out;
}

const hasAny = (set: ReadonlySet<string>, terms: ReadonlySet<string>) =>
  [...terms].some((term) => set.has(term));

const itemTextStems = (item: Partial<CatalogItemResponse>) =>
  new Set([...attributeStems(item.name), ...attributeStems(item.description)]);

/** Species groups a stem set names. */
const speciesGroups = (set: ReadonlySet<string>) =>
  SPECIES_GROUPS.filter((group) => hasAny(set, group));

/**
 * The item names only the opposing side of a life-stage group the query
 * asked for, or only species other than the requested ones.
 */
function contradicts(
  query: ReadonlySet<string>,
  item: Partial<CatalogItemResponse>,
): boolean {
  const text = itemTextStems(item);
  const stage = STAGE_GROUPS.some(([a, b]) =>
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
  if (stage) return true;
  const asked = speciesGroups(query);
  const named = speciesGroups(text);
  return (
    asked.length > 0 &&
    named.length > 0 &&
    !named.some((group) => asked.includes(group))
  );
}

/**
 * L33: the query names a species AND a type word (any significant word that
 * is neither a brand nor a species): the item must name a requested species
 * (unless it is of a requested brand) AND carry a type word (food words
 * interchangeable). A backend `match: 'all'` is trusted.
 */
function speciesTypeCheck(
  tokens: QueryTokens,
  item: Partial<CatalogItemResponse>,
): 'inactive' | 'pass' | 'fail' {
  const asked = speciesGroups(new Set(tokens.type));
  const types = tokens.type.filter((t) => !SPECIES_STEMS.has(t));
  if (asked.length === 0 || types.length === 0) return 'inactive';
  if (item.match === 'all') return 'pass';
  const text = itemTextStems(item);
  const itemBrand = stems(item.brand);
  const brandExempt = tokens.brand.some((t) => itemBrand.has(t));
  const speciesOk =
    brandExempt || speciesGroups(text).some((group) => asked.includes(group));
  const typeOk = types.some(
    (t) =>
      text.has(t) ||
      (FOOD_STEMS.has(t) && [...FOOD_STEMS].some((f) => text.has(f))),
  );
  return speciesOk && typeOk ? 'pass' : 'fail';
}

/** S13c/d: fixed copy (usted; tú via customer-style phrase pairs). */
export const CATALOG_EXACT_OPENING = 'Encontré estas opciones:';
/** Owner 2026-11-17: nothing offerable (all results contradict the request). */
export const CATALOG_NOTHING_TAIL =
  ' no tengo por ahora. ¿Quiere que le pregunte al equipo si lo pueden conseguir, o le busco otra cosa?';
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
/** L31: one emoji on the closing when the customer style allows emojis. */
export const CATALOG_CLOSING_EMOJI = '😊';
const OTHER_BRAND_LABEL = ' (de otra marca)';
const DESCRIPTION_MAX = 90;
/** Presentations listed per option line; the rest are counted. */
const PRESENTATIONS_MAX = 6;

type OfferedClass = Exclude<
  CatalogOptionClass,
  'other' | 'contradicts' | 'mismatch'
>;

const RANK: Record<OfferedClass, number> = {
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
  const speciesType = speciesTypeCheck(tokens, item);
  if (speciesType === 'fail') return 'mismatch';
  const name = stems(item.name);
  const description = stems(item.description);
  const brand = stems(item.brand);
  const everywhere = new Set([...name, ...description, ...brand]);
  if (
    item.match !== 'partial' &&
    (item.match === 'all' || all.every((t) => everywhere.has(t)))
  )
    return 'exact';
  if (
    speciesType === 'pass' ||
    tokens.type.some((t) => name.has(t) || description.has(t))
  )
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
  cls: OfferedClass;
  availability: ItemAvailability;
  agotado: boolean;
  /** A brand was requested and this item's brand is a different one. */
  otherBrand: boolean;
  /**
   * L31: a brand was requested and this item is that brand's product of the
   * requested type (or the brand alone when no type was asked).
   */
  brandMatch: boolean;
}

export interface CatalogOptionsPlan {
  /** The customer's significant words as asked ("Croquetas Pedigree"). */
  requested: string;
  /** L31: the query names a brand token (a word of some result's brand). */
  brandRequested: boolean;
  /** Offered options in render order (≤ 3, available first). */
  options: CatalogOption[];
  /** Relevant products not shown (S13f narrowing question). */
  moreResults: number;
  /**
   * Some items contradicted a stated life stage / species, or missed a
   * species + type request (L33 mismatch). With no option left the section
   * is the «{lo pedido} no tengo por ahora…» dead end (no false match).
   */
  contradicted: boolean;
}

/**
 * L31: the span of the customer's own message that carries the query's
 * significant words, first to last, connectors between them kept
 * ("croquetas para cachorro tienen?" for q "croquetas cachorro" →
 * "croquetas para cachorro"). `null` when the message does not carry every
 * significant query word (the model rephrased or the turn is about something
 * else): the model query is used instead.
 */
function customerSpan(q: string, customerText: string | undefined) {
  if (typeof customerText !== 'string') return null;
  const wanted = new Set(significantQueryWords(q).map((w) => stem(w.word)));
  const hits = significantQueryWords(customerText).filter((w) =>
    wanted.has(stem(w.word)),
  );
  const found = new Set(hits.map((w) => stem(w.word)));
  if (hits.length === 0 || [...wanted].some((s) => !found.has(s))) return null;
  return customerText.slice(hits[0].start, hits[hits.length - 1].end);
}

/** "croquetas de pedigree" → "Croquetas de Pedigree" (brand casing kept). */
function requestedPhrase(
  q: string,
  items: readonly Partial<CatalogItemResponse>[],
  customerText?: string,
): string {
  const words = significantQueryWords(q);
  const span =
    customerSpan(q, customerText) ??
    q.slice(words[0].start, words[words.length - 1].end);
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
 * as before. `customerText` (the customer's own message of this turn) words
 * {lo pedido} when it carries the query's words (L31).
 */
export function planCatalogOptions(
  q: string,
  items: readonly CatalogItemResponse[],
  customerText?: string,
): CatalogOptionsPlan | null {
  if (significantQueryWords(q).length === 0) return null;
  const tokens = queryTokens(q, brandStems(items));
  const relevant: CatalogOption[] = [];
  let contradicted = false;
  for (const item of items) {
    const cls = classify(tokens, item);
    if (cls === 'contradicts' || cls === 'mismatch') contradicted = true;
    if (cls === 'other' || cls === 'contradicts' || cls === 'mismatch')
      continue;
    const availability = deriveAvailability(item);
    const itemBrand = stems(item.brand);
    const hasBrand = tokens.brand.some((t) => itemBrand.has(t));
    const itemText = new Set([...stems(item.name), ...stems(item.description)]);
    const hasType =
      tokens.type.length === 0 || tokens.type.some((t) => itemText.has(t));
    relevant.push({
      item,
      cls,
      availability,
      agotado: availability.status === 'out_of_stock',
      otherBrand: tokens.brand.length > 0 && !hasBrand,
      brandMatch:
        tokens.brand.length > 0 && (cls === 'exact' || (hasBrand && hasType)),
    });
  }
  const requested = requestedPhrase(q, items, customerText);
  const brandRequested = tokens.brand.length > 0;
  if (relevant.length === 0)
    return contradicted
      ? {
          requested,
          brandRequested,
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
    requested,
    brandRequested,
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
    /**
     * L31: the customer style allows emojis (CustomerStyle.emojis): the
     * message ends with exactly one emoji on its closing question.
     */
    emoji?: boolean;
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
  const nothingOffered = sections.every(
    (section) => section.plan.options.length === 0,
  );
  const blocks: string[] = [];
  for (const { plan, options } of sections) {
    if (plan.options.length === 0) {
      // Only contradicting items: say so, list none of them. When nothing at
      // all is offerable the reply keeps the customer in the conversation
      // (owner 2026-11-17): ask the team, or search something else.
      blocks.push(
        nothingOffered
          ? `${plan.requested}${style(CATALOG_NOTHING_TAIL)}`
          : `${plan.requested} no tengo.`,
      );
      continue;
    }
    const exact = options.some((option) => option.cls === 'exact');
    const available = options.filter((option) => !option.agotado);
    const agotado = options.filter((option) => option.agotado);
    const lines: string[] = [];
    if (available.length > 0) {
      // L31: «no tengo» only for a requested brand that no available option
      // offers in the requested type; anything else is what was asked.
      const brandMissing =
        plan.brandRequested && !available.some((option) => option.brandMatch);
      lines.push(
        brandMissing
          ? `${plan.requested}${style(CATALOG_ALTERNATIVES_OPENING)}`
          : style(CATALOG_EXACT_OPENING),
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
  const text = blocks.join('\n\n');
  return {
    text:
      opts.emoji === true && text.length > 0
        ? `${text} ${CATALOG_CLOSING_EMOJI}`
        : text,
    restockOffer: target?.subject ?? null,
    restockAcceptsYes: target !== null && !addOffer,
    shown: all.map((option) => option.item),
  };
}
