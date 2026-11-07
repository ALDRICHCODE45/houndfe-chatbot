/**
 * Pure reading of a conversational cart request (F6, live eval 2026-11-07).
 *
 * The strict quantity grounding (`minimal-cart-quantity.ts`) only trusts a
 * count the model cites literally. Real customers answer an offer with
 * "Sí, agréguela", "quiero 2" or "agrégamelos" and the model often omits the
 * citation. These helpers read, from the customer's OWN words and the bot's
 * previous message, what the request says:
 *
 *   - `statedUnitCount`: the single unit count in the current text (digits,
 *     `un`/`una`/`uno`…`diez`, `un par`), ignoring measurements, decimals and
 *     presentation numbers; several counts are ambiguous.
 *   - `addRequestForm`: an add command without a count ("agrégalo",
 *     "agréguela", "agrégamelos"), singular or plural.
 *   - `offersCartAdd`: the bot's previous message asked whether to add.
 *   - `nameCoverage` / `mentionsPhrase`: whether a server-owned product or
 *     presentation label appears in a text.
 *
 * No I/O, no model input; the caller decides what a reading authorizes.
 */
import { classifyConfirmationReply } from './confirmation-reply';
import { NEGATION_TOKENS } from './minimal-cart-quantity';

const COUNT_WORDS: Readonly<Record<string, number>> = {
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

const MEASURE_UNITS: ReadonlySet<string> = new Set([
  'mg',
  'mcg',
  'g',
  'gr',
  'grs',
  'gramo',
  'gramos',
  'kg',
  'kilo',
  'kilos',
  'ml',
  'l',
  'lt',
  'litro',
  'litros',
  'oz',
  'lb',
  'cm',
  'mm',
]);

const STOPWORDS: ReadonlySet<string> = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'para',
  'con',
  'sin',
  'y',
  'en',
  'por',
]);

/** Lowercase, accentless words; digits split from letters ("10kg" → "10 kg"). */
export function cartWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)[.,](\d)/g, '$1_$2')
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 0);
}

export type StatedUnitCount =
  | { status: 'ok'; value: number }
  | { status: 'none' }
  | { status: 'ambiguous' };

/**
 * The single unit count the customer stated in `text`. Numbers followed by a
 * measurement unit, decimals ("3.8 L") and numbers listed in
 * `presentationNumbers` (the digits of the product's presentation labels)
 * are never counts.
 */
export function statedUnitCount(
  text: string,
  presentationNumbers: ReadonlySet<string> = new Set(),
): StatedUnitCount {
  const words = cartWords(text);
  const counts: number[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const next = words[index + 1];
    if (word === 'un' && next === 'par') {
      counts.push(2);
      index += 1;
      continue;
    }
    if (/^\d+$/.test(word)) {
      if (next !== undefined && MEASURE_UNITS.has(next)) continue;
      if (presentationNumbers.has(word)) continue;
      const value = Number(word);
      if (Number.isSafeInteger(value)) counts.push(value);
      continue;
    }
    const value = COUNT_WORDS[word];
    if (value !== undefined) counts.push(value);
  }
  if (counts.length === 0) return { status: 'none' };
  if (counts.length > 1) return { status: 'ambiguous' };
  return { status: 'ok', value: counts[0] };
}

/** agregar / añadir / meter / incluir, any person or clitic form. */
const ADD_VERB = /^(agreg|anad|met[ae]|inclu)[a-z]*$/;
const PLURAL_CLITIC = /(los|las)$/;
const KEEP_PHRASES = [
  ['lo', 'quiero'],
  ['la', 'quiero'],
  ['me', 'lo', 'llevo'],
  ['me', 'la', 'llevo'],
];
const KEEP_PLURAL_PHRASES = [
  ['los', 'quiero'],
  ['las', 'quiero'],
  ['me', 'los', 'llevo'],
  ['me', 'las', 'llevo'],
];

function hasPhrase(words: readonly string[], phrase: readonly string[]) {
  return words.some((_, index) =>
    phrase.every((part, offset) => words[index + offset] === part),
  );
}

/**
 * `singular` / `plural` when the current text asks to add the product being
 * discussed (an add verb, "lo quiero", "me lo llevo"); `null` otherwise or
 * when a negation precedes the verb ("no lo agregues").
 */
export function addRequestForm(text: string): 'singular' | 'plural' | null {
  const words = cartWords(text);
  const verbIndex = words.findIndex((word) => ADD_VERB.test(word));
  if (verbIndex !== -1) {
    if (words.slice(0, verbIndex).some((word) => NEGATION_TOKENS.has(word)))
      return null;
    const verb = words[verbIndex];
    const object = words[verbIndex - 1];
    if (
      PLURAL_CLITIC.test(verb) ||
      object === 'los' ||
      object === 'las' ||
      object === 'todos' ||
      object === 'todas'
    )
      return 'plural';
    return 'singular';
  }
  if (words.some((word) => NEGATION_TOKENS.has(word))) return null;
  if (KEEP_PLURAL_PHRASES.some((phrase) => hasPhrase(words, phrase)))
    return 'plural';
  if (KEEP_PHRASES.some((phrase) => hasPhrase(words, phrase)))
    return 'singular';
  return null;
}

/** The bot's message asked whether to add something to the cart. */
export function offersCartAdd(assistantText: string | null): boolean {
  if (assistantText === null || !/[?¿]/.test(assistantText)) return false;
  return cartWords(assistantText).some((word) => ADD_VERB.test(word));
}

/**
 * `addRequestForm`, plus a bare affirmative ("sí", "claro", "va") that
 * answers a cart offer in the bot's previous message.
 */
export function conversationalAddForm(
  text: string,
  previousAssistantText: string | null,
): 'singular' | 'plural' | null {
  const form = addRequestForm(text);
  if (form !== null) return form;
  return classifyConfirmationReply(text) === 'accept' &&
    offersCartAdd(previousAssistantText)
    ? 'singular'
    : null;
}

const fold = (word: string) =>
  word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;

/** Share (0..1) of a product name's significant words present in `text`. */
export function nameCoverage(text: string, name: string): number {
  const significant = [
    ...new Set(
      cartWords(name)
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
        .map(fold),
    ),
  ];
  if (significant.length === 0) return 0;
  const present = new Set(cartWords(text).map(fold));
  return (
    significant.filter((word) => present.has(word)).length / significant.length
  );
}

/** True when every word of `phrase` appears contiguously in `text`. */
export function mentionsPhrase(text: string, phrase: string): boolean {
  const needle = cartWords(phrase).map(fold);
  if (needle.length === 0) return false;
  return hasPhrase(cartWords(text).map(fold), needle);
}
