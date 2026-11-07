/**
 * Shared deterministic reading of a customer's reply to a pending
 * confirmation (order summary, delivery data, RESTOCK question).
 *
 * Pure and conservative: only a whole message from a closed lexicon counts.
 * A false accept can create an order, so anything carrying a correction, a
 * condition, a question or extra content is `null` and stays with the
 * existing flow. No substring matching and no model inference.
 */
export type ConfirmationReply = 'accept' | 'decline';

const POLITE = ['por favor', 'porfa', 'porfavor', 'gracias', 'muchas gracias'];

const ACCEPT_CORE = [
  'si',
  'sip',
  'simon',
  'claro',
  'claro que si',
  'por supuesto',
  'va',
  'sale',
  'vale',
  'ok',
  'okay',
  'okey',
  'dale',
  'de acuerdo',
  'correcto',
  'es correcto',
  'asi es',
  'exacto',
  'confirmo',
  'confirmado',
  'adelante',
  'perfecto',
  'listo',
  'esta bien',
];

const DECLINE_CORE = [
  'no',
  'nel',
  'cancelar',
  'cancela',
  'no quiero',
  'mejor no',
  'ahorita no',
  'todavia no',
  'no por ahora',
  'por ahora no',
];

/** Fold runs of one repeated letter ("siii", "okkk", "claroo"). */
const collapse = (text: string): string => text.replace(/([a-z])\1+/g, '$1');

const withSuffixes = (
  phrases: readonly string[],
  suffixes: readonly string[],
) =>
  phrases.flatMap((phrase) => [
    phrase,
    ...suffixes.map((suffix) => `${phrase} ${suffix}`),
  ]);

const ACCEPT = new Set(
  withSuffixes(
    [...ACCEPT_CORE, ...ACCEPT_CORE.map((core) => `si ${core}`)],
    POLITE,
  ).map(collapse),
);
const DECLINE = new Set(
  withSuffixes(DECLINE_CORE, ['gracias', 'muchas gracias']).map(collapse),
);

const PICTOGRAPH = /\p{Extended_Pictographic}/gu;
/** Emoji glue that never carries meaning on its own. */
const EMOJI_GLUE = /\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3/gu;
const ACCEPT_EMOJI = new Set(['👍', '✅', '✔']);
const DECLINE_EMOJI = new Set(['👎']);
const MAX_LENGTH = 80;

/**
 * `accept` / `decline` for a whole-message affirmative or refusal (case,
 * accents, surrounding punctuation, emojis and newlines tolerated), else
 * `null`.
 */
export function classifyConfirmationReply(
  raw: unknown,
): ConfirmationReply | null {
  try {
    if (typeof raw !== 'string' || raw.length > MAX_LENGTH) return null;
    // A question is never consent ("¿sí incluye envío?").
    if (/[?¿]/.test(raw)) return null;
    const decomposed = raw.normalize('NFD');
    const emojis = decomposed.match(PICTOGRAPH) ?? [];
    const text = collapse(
      decomposed
        .replace(PICTOGRAPH, ' ')
        .replace(EMOJI_GLUE, '')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    );
    const thumbsUp = emojis.some((emoji) => ACCEPT_EMOJI.has(emoji));
    const thumbsDown = emojis.some((emoji) => DECLINE_EMOJI.has(emoji));
    if (text === '') {
      if (emojis.length === 0 || (thumbsUp && thumbsDown)) return null;
      if (emojis.every((emoji) => ACCEPT_EMOJI.has(emoji))) return 'accept';
      if (emojis.every((emoji) => DECLINE_EMOJI.has(emoji))) return 'decline';
      return null;
    }
    if (ACCEPT.has(text)) return thumbsDown ? null : 'accept';
    if (DECLINE.has(text)) return thumbsUp ? null : 'decline';
    return null;
  } catch {
    return null;
  }
}
