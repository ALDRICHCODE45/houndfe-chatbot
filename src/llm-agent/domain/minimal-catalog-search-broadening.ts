/**
 * S7: deterministic search broadening for the minimal route.
 *
 * The backend matches the whole query as a substring, so "croquetas pedigree"
 * finds nothing although "Pedigree Dentastix" exists. When a multi-word query
 * returns 0 results the route retries with its significant words alone. The
 * first search is always authoritative: any result means no retry, so the
 * behaviour stays correct if the backend later adds token matching.
 */

/** Hard bound on extra backend calls per customer query. */
export const MAX_BROADEN_CALLS = 3;

/**
 * Words that carry no product identity. Species words (perro, gato, ...) are
 * deliberately NOT here: they appear in product names and often are the only
 * thing that matches ("alimento para gato" → "Inaba Churu ... para Gato").
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  // articles, prepositions, conjunctions
  'a',
  'al',
  'con',
  'de',
  'del',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'o',
  'para',
  'por',
  'sin',
  'un',
  'una',
  'unas',
  'unos',
  'y',
  // request filler
  'busco',
  'buscando',
  'dame',
  'favor',
  'hay',
  'me',
  'mi',
  'necesito',
  'ocupo',
  'quiero',
  'quisiera',
  'tiene',
  'tienen',
  'tienes',
  'vende',
  'venden',
  'que',
  'algun',
  'alguna',
  'algo',
  'marca',
  'producto',
  'productos',
  // generic product-category words that fail as exact substrings
  'alimento',
  'alimentos',
  'comida',
  'croqueta',
  'croquetas',
]);

const UNIT_WORDS: ReadonlySet<string> = new Set([
  'g',
  'gr',
  'grs',
  'kg',
  'kgs',
  'mg',
  'ml',
  'l',
  'lt',
  'lts',
  'pza',
  'pzas',
]);

const MIN_WORD_LENGTH = 3;

function fold(word: string): string {
  return word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function isSignificant(word: string): boolean {
  const folded = fold(word);
  return (
    folded.length >= MIN_WORD_LENGTH &&
    !/^\p{N}+$/u.test(folded) &&
    !GENERIC_WORDS.has(folded) &&
    !UNIT_WORDS.has(folded)
  );
}

/**
 * Broader queries to try, in order, after a 0-result multi-word query: all
 * significant words together (original order) when there are two or more,
 * then each significant word alone, longest first (ties by position, the
 * longest word is the most brand-like). Never the original query; at most
 * {@link MAX_BROADEN_CALLS}. Single-word queries never broaden.
 */
export function broadenedQueries(q: string): string[] {
  const all = words(q);
  if (all.length < 2) return [];
  const original = all.join(' ');
  const significant: string[] = [];
  for (const word of all) {
    if (isSignificant(word) && !significant.includes(word))
      significant.push(word);
  }
  const alone = significant
    .map((word, index) => ({ word, index }))
    .sort((a, b) => b.word.length - a.word.length || a.index - b.index)
    .map(({ word }) => word);
  const candidates =
    significant.length >= 2 ? [significant.join(' '), ...alone] : alone;
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate === original || out.includes(candidate)) continue;
    out.push(candidate);
    if (out.length === MAX_BROADEN_CALLS) break;
  }
  return out;
}

export interface BroadenedSearchInfo {
  originalQuery: string;
  /** Broader queries actually sent to the backend, in order. */
  attempted: string[];
  /** The retry that produced the results, or null when none did. */
  matchedQuery: string | null;
}

export interface BroadenedSearchResult<T> {
  items: T[];
  /** null when the first search answered (no retry happened). */
  broadened: BroadenedSearchInfo | null;
}

/**
 * Runs `search(q)` and, only when it returns 0 results, the bounded broader
 * retries. Stops at the first retry with results; items are merged deduped by
 * productId keeping first-seen (backend) order. A retry error propagates, so
 * the caller treats it exactly like an error of the original search.
 */
export async function searchWithBroadening<T extends { productId: string }>(
  search: (q: string) => Promise<T[]>,
  q: string,
): Promise<BroadenedSearchResult<T>> {
  const first = await search(q);
  if (first.length > 0) return { items: first, broadened: null };
  const queries = broadenedQueries(q);
  if (queries.length === 0) return { items: first, broadened: null };
  const merged: T[] = [];
  const seen = new Set<string>();
  const attempted: string[] = [];
  let matchedQuery: string | null = null;
  for (const query of queries) {
    attempted.push(query);
    const found = await search(query);
    for (const item of found) {
      if (seen.has(item.productId)) continue;
      seen.add(item.productId);
      merged.push(item);
    }
    if (merged.length > 0) {
      matchedQuery = query;
      break;
    }
  }
  return {
    items: merged,
    broadened: { originalQuery: q, attempted, matchedQuery },
  };
}
