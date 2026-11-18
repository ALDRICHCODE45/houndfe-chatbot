/**
 * S6 (odd/tasks/cost-and-abuse-phase1.md): pure closing/acknowledgement
 * messages («gracias», «ok», «👍», «gracias, buen día»…) are answered without
 * the LLM. Conservative on purpose: anything with a question mark or a word
 * outside the closing vocabulary goes to the model as before.
 */

/** The fixed reply (usted; the tú pair lives in customer-style). */
export const CLOSING_REPLY = '¡Con gusto! Aquí estoy si necesita algo más.';

const EMOJI =
  /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const SKIN_TONE_OR_VS = /(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F)/gu;
/** A lone emoji closes only when it is a thumbs-up or folded hands. */
const CLOSING_EMOJIS: ReadonlySet<string> = new Set(['👍', '🙏']);

const DAY_WORDS = ['dia', 'tarde', 'noche', 'fin de semana'];
const DAY_ADJECTIVES = ['buen', 'bonito', 'excelente', 'lindo', 'feliz'];

/** Normalized (lowercase, no accents) closing phrases. */
const PHRASES: readonly string[] = [
  'gracias',
  'muchas gracias',
  'mil gracias',
  'muchisimas gracias',
  'ok',
  'okay',
  'oki',
  'okis',
  'va',
  'vale',
  'sale',
  'perfecto',
  'listo',
  'excelente',
  'genial',
  'entendido',
  'enterado',
  'igualmente',
  'saludos',
  'adios',
  'bye',
  'nos vemos',
  'hasta luego',
  'hasta pronto',
  'muy amable',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  ...DAY_ADJECTIVES.flatMap((adjective) =>
    DAY_WORDS.flatMap((word) => [
      `${adjective} ${word}`,
      `que tenga ${adjective} ${word}`,
      `que tengas ${adjective} ${word}`,
      `que tenga un ${adjective} ${word}`,
      `que tengas un ${adjective} ${word}`,
    ]),
  ),
];
const PHRASE_TOKENS = PHRASES.map((phrase) => phrase.split(' ')).sort(
  (a, b) => b.length - a.length,
);
/** Review R3: these also open a conversation, so alone they are a greeting
 *  for the model, never a closing («Buenas tardes» → greeting). */
const GREETING_PHRASES: ReadonlySet<string> = new Set([
  'buenos dias',
  'buenas tardes',
  'buenas noches',
  ...DAY_ADJECTIVES.flatMap((adjective) =>
    DAY_WORDS.map((word) => `${adjective} ${word}`),
  ),
]);

const stripAccents = (text: string) =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normalized = (text: string) => stripAccents(text.toLowerCase());

/** Words of the text with emojis and punctuation removed. */
function words(text: string): string[] {
  return normalized(text.replace(EMOJI, ' '))
    .replace(/[.,;:!¡…~\-_*"'()]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** True when the tokens are a sequence of closing phrases only. */
function onlyClosingPhrases(tokens: readonly string[]): boolean {
  let at = 0;
  let closingWord = false;
  outer: while (at < tokens.length) {
    for (const phrase of PHRASE_TOKENS) {
      if (phrase.every((token, i) => tokens[at + i] === token)) {
        if (!GREETING_PHRASES.has(phrase.join(' '))) closingWord = true;
        at += phrase.length;
        continue outer;
      }
    }
    return false;
  }
  return closingWord;
}

/**
 * A pure closing or acknowledgement: closing phrases combined with emojis
 * and punctuation, or a lone 👍/🙏. Never a question.
 */
export function isClosingMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || /[?¿]/.test(trimmed)) return false;
  const tokens = words(trimmed);
  if (tokens.length > 0) return onlyClosingPhrases(tokens);
  const emojis: string[] = trimmed.match(EMOJI) ?? [];
  return (
    emojis.length > 0 &&
    emojis.every((emoji) =>
      CLOSING_EMOJIS.has(emoji.replace(SKIN_TONE_OR_VS, '')),
    )
  );
}

const FAREWELL_PATTERNS: readonly RegExp[] = [
  /aqui estoy si necesitas? algo mas/,
  /\bque (?:tenga|tengas) (?:un |una )?(?:muy )?(?:buen|buena|bonito|bonita|excelente|lindo|linda|feliz|gran)\b/,
  /\bque (?:este|estes) muy bien\b/,
  /\bhasta (?:luego|pronto)\b/,
  /\bnos vemos\b/,
  /\bgracias por (?:su|tu) compra\b/,
  /\bgracias por escribirnos\b/,
  /\ba (?:sus|tus) ordenes\b/,
];

/** The bot's previous message already closed the conversation. */
export function isFarewellOrClosingReply(text: string | null): boolean {
  if (text === null) return false;
  const plain = normalized(text.replace(EMOJI, ' '));
  return FAREWELL_PATTERNS.some((pattern) => pattern.test(plain));
}
