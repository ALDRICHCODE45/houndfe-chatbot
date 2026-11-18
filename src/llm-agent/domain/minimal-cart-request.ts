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
 *     phrase appears in a text.
 *   - `presentationMentions` / `countOutsidePresentations`: which
 *     presentation a customer names in natural words («la caja de 12
 *     sobres», «la de 12», «el sobre») and the counts left once those
 *     presentation numbers are set aside.
 *   - `distinctiveMatches`: which of several shown products the customer's
 *     words single out (a word or presentation only that product has).
 *   - `asksCartChoice` / `requestsCartChange`: the bot asked which product or
 *     presentation to add; the text asks for any cart change at all.
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

/** Words that say the customer wants the thing named («quiero», «dame»…). */
const WANT_WORDS: ReadonlySet<string> = new Set([
  'quiero',
  'quisiera',
  'queria',
  'dame',
  'deme',
  'damelo',
  'demelo',
  'damela',
  'demela',
  'llevo',
  'llevare',
  'mandame',
  'mandeme',
  'ocupo',
  'necesito',
  'prefiero',
]);

/** The bot's message offered to add or asked which option to take. */
export function offersCartChoice(assistantText: string | null): boolean {
  if (assistantText === null) return false;
  return (
    offersCartAdd(assistantText) ||
    asksCartChoice(assistantText) ||
    mentionsPhrase(assistantText, 'cual le gustaria llevar') ||
    mentionsPhrase(assistantText, 'cual te gustaria llevar')
  );
}

/**
 * Retest S5 (N14): `singular` when `text` picks ONE presentation (`label`,
 * already found in the text by the caller) without a count — «quiero el de
 * 2 kg», «la de 7 piezas» — as a purchase: a want word, or an answer to the
 * bot's add offer / options question. A question, a negation or a plural
 * article («los de 2 kg») is never a default unit; `null` otherwise.
 */
export function presentationPickForm(
  text: string,
  label: string,
  previousAssistantText: string | null,
): 'singular' | null {
  if (/[?¿]/.test(text)) return null;
  const words = cartWords(text).map(fold);
  if (words.some((word) => NEGATION_TOKENS.has(word))) return null;
  const [mention] = presentationMentions(text, [label], true);
  if (mention === undefined) return null;
  const at = mention.at;
  // «los de 2 kg» / «las de 7 piezas» / «las cajas de 12 sobres» ask for
  // several: the count is asked.
  const article = words[at - 1] === 'de' ? words[at - 2] : words[at - 1];
  if (article === 'los' || article === 'las') return null;
  // Without a singular article, a plural head word («cajas de 12 sobres»)
  // asks for several too.
  const head = cartWords(text)[at];
  if (
    article !== 'la' &&
    article !== 'el' &&
    UNIT_SPELLINGS[head] === undefined &&
    fold(head) !== head
  )
    return null;
  return words.some((word) => WANT_WORDS.has(word)) ||
    offersCartChoice(previousAssistantText)
    ? 'singular'
    : null;
}

const fold = (word: string) =>
  word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;

/**
 * Connector words a customer puts inside a presentation name («la caja de 12
 * sobres» for «Caja 12 sobres»); they never distinguish a presentation.
 */
const PRESENTATION_CONNECTORS: ReadonlySet<string> = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
]);

/** Articles that open a short presentation reference («la de 12», «el sobre»). */
const PRESENTATION_ARTICLES: ReadonlySet<string> = new Set([
  'la',
  'el',
  'los',
  'las',
]);

/** Unit spellings folded to one form (g/gr/gramos, kg/kilo/kilos…). */
const UNIT_SPELLINGS: Readonly<Record<string, string>> = {
  gr: 'g',
  grs: 'g',
  gramo: 'g',
  gramos: 'g',
  kilo: 'kg',
  kilos: 'kg',
  kilogramo: 'kg',
  kilogramos: 'kg',
  kgs: 'kg',
  mililitro: 'ml',
  mililitros: 'ml',
  lt: 'l',
  lts: 'l',
  litro: 'l',
  litros: 'l',
  pz: 'pieza',
  pza: 'pieza',
  pzas: 'pieza',
  pzs: 'pieza',
};

const presentationWord = (word: string): string =>
  UNIT_SPELLINGS[word] ?? fold(word);

/** A label's words without connectors, units and plurals folded. */
function presentationWords(label: string): string[] {
  return cartWords(label)
    .filter((word) => !PRESENTATION_CONNECTORS.has(word))
    .map(presentationWord);
}

/** One presentation found in a text and the word index it starts at. */
export type PresentationMention = { index: number; at: number };

/**
 * Which of a product's presentation `labels` the text names (presentation
 * pick grounding, S2). Matching ignores connector words, accents, case,
 * singular/plural and unit spellings: «la caja de 12 sobres» names «Caja 12
 * sobres», «el sobre de 85 gramos» names «Sobre 85 g». When no label is named
 * in full and `short` is set, a short reference after an article also names
 * one: its head word («el sobre» → «Sobre 85 g») or its number, with the
 * label's next word if any («la de 12» → «Caja 12 sobres»). Every match is
 * returned; the caller treats several as ambiguous.
 */
export function presentationMentions(
  text: string,
  labels: readonly string[],
  short = false,
): PresentationMention[] {
  const words = cartWords(text).map(presentationWord);
  // Content words with their original index, connectors dropped.
  const content = words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => !PRESENTATION_CONNECTORS.has(word));
  const needles = labels.map(presentationWords);
  const full = needles.flatMap((needle, index) => {
    if (needle.length === 0) return [];
    const start = content.findIndex((_, from) =>
      needle.every((part, offset) => content[from + offset]?.word === part),
    );
    return start === -1 ? [] : [{ index, at: content[start].index }];
  });
  if (full.length > 0 || !short) return full;
  const found = new Map<number, number>();
  words.forEach((word, at) => {
    if (!PRESENTATION_ARTICLES.has(word)) return;
    let from = at + 1;
    if (words[from] === 'de') from += 1;
    const run: string[] = [];
    for (
      let cursor = from;
      cursor < words.length && !PRESENTATION_CONNECTORS.has(words[cursor]);
      cursor += 1
    )
      run.push(words[cursor]);
    if (run.length === 0) return;
    needles.forEach((needle, index) => {
      if (needle.length === 0 || found.has(index)) return;
      const byHead = run[0] === needle[0] && !/^\d+$/.test(run[0]);
      const number = /^\d+$/.test(run[0]) ? needle.indexOf(run[0]) : -1;
      const byNumber =
        number !== -1 && (run.length === 1 || run[1] === needle[number + 1]);
      if (byHead || byNumber) found.set(index, at + 1);
    });
  });
  return [...found].map(([index, at]) => ({ index, at }));
}

/**
 * The unit counts the customer stated, leaving out numbers that name a
 * presentation: a number followed by a measurement unit, by the word that
 * follows it in one of the `labels` («12 sobres»), or closing a short
 * reference («la de 12»). Several counts are ambiguous.
 */
export function countOutsidePresentations(
  text: string,
  labels: readonly string[],
): StatedUnitCount {
  const words = cartWords(text);
  const folded = words.map(presentationWord);
  const needles = labels.map(presentationWords);
  const roles = new Set<number>();
  folded.forEach((word, index) => {
    if (!/^\d+$/.test(word)) return;
    let next = index + 1;
    while (PRESENTATION_CONNECTORS.has(folded[next] ?? '')) next += 1;
    const followed = needles.some((needle) => {
      const at = needle.indexOf(word);
      return (
        at !== -1 &&
        needle[at + 1] !== undefined &&
        needle[at + 1] === folded[next]
      );
    });
    const closesReference =
      folded[index - 1] === 'de' &&
      PRESENTATION_ARTICLES.has(folded[index - 2] ?? '') &&
      needles.some((needle) => needle.includes(word));
    if (followed || closesReference) roles.add(index);
  });
  const kept = words.filter((_, index) => !roles.has(index)).join(' ');
  return statedUnitCount(kept);
}

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

const significantWords = (name: string): string[] => [
  ...new Set(
    cartWords(name)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
      .map(fold),
  ),
];

/** A shown product: its name and its presentation labels. */
export type ShownCandidate = { name: string; labels: readonly string[] };

/**
 * Indexes of the candidates `text` singles out: it contains a name word
 * ("sílice", "salmón") or a presentation label ("20 kg") that no other
 * candidate has. Words every candidate shares ("arena", "gato") never count.
 */
export function distinctiveMatches(
  text: string,
  candidates: readonly ShownCandidate[],
): number[] {
  const words = candidates.map((candidate) => significantWords(candidate.name));
  const labels = candidates.map((candidate) =>
    candidate.labels.map((label) => cartWords(label).map(fold).join(' ')),
  );
  const present = new Set(cartWords(text).map(fold));
  return candidates.flatMap((candidate, index) => {
    const others = (pick: (other: number) => readonly string[]) =>
      new Set(
        candidates.flatMap((_, other) => (other === index ? [] : pick(other))),
      );
    const otherWords = others((other) => words[other]);
    const otherLabels = others((other) => labels[other]);
    const byWord = words[index].some(
      (word) => !otherWords.has(word) && present.has(word),
    );
    const byLabel = candidate.labels.some(
      (label, at) =>
        labels[index][at].length > 0 &&
        !otherLabels.has(labels[index][at]) &&
        presentationMentions(text, [label], true).length > 0,
    );
    return byWord || byLabel ? [index] : [];
  });
}

/** The bot's message is the server question about which product/presentation to add. */
export function asksCartChoice(assistantText: string | null): boolean {
  if (assistantText === null) return false;
  return (
    mentionsPhrase(assistantText, 'a cual producto') ||
    mentionsPhrase(assistantText, 'presentacion desea agregar') ||
    mentionsPhrase(assistantText, 'presentacion quieres agregar')
  );
}

/** Removal and "one more" words that ask for a cart change without a verb. */
const CHANGE_WORDS: ReadonlySet<string> = new Set([
  'quita',
  'quitar',
  'quitale',
  'quitame',
  'quitalo',
  'quitala',
  'elimina',
  'eliminar',
  'saca',
  'sacar',
  'borra',
  'borrar',
  'cambia',
  'cambiar',
  'cambiala',
  'cambialo',
  'deja',
  'dejame',
  'dejala',
  'dejalo',
  'ajusta',
  'otra',
  'otro',
  'cantidad',
  'carrito',
]);

/**
 * True when `text` asks for any cart change: a unit count, an add request
 * (including a yes to a cart offer) or a change/removal word. "Quiero
 * comprar.", "Prefiero recogerlo en tienda." or a yes to another question
 * do not.
 */
export function requestsCartChange(
  text: string,
  previousAssistantText: string | null,
): boolean {
  return (
    statedUnitCount(text).status !== 'none' ||
    requestsCartAction(text, previousAssistantText)
  );
}

/**
 * True when `text` asks for a cart change in words (an add request or a
 * change/removal word), ignoring bare numbers: in a pet statement ("es una
 * labrador de 3 años") the numbers describe the pet, not units.
 */
export function requestsCartAction(
  text: string,
  previousAssistantText: string | null,
): boolean {
  return (
    conversationalAddForm(text, previousAssistantText) !== null ||
    cartWords(text).some((word) => CHANGE_WORDS.has(word))
  );
}
