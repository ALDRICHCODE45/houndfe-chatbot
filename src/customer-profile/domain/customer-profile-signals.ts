import { customerOwnText } from '../../llm-agent/domain/customer-style';

/**
 * Deterministic customer-memory signals read from the customer's own text:
 * an explicit "call me X" and the "forget my data" request. Conservative on
 * purpose — a missed name costs nothing, a wrong one is remembered for days.
 */

const WORD = "\\p{L}[\\p{L}'-]{1,29}";
const END = '(?=\\s*(?:[.,;:!¡?¿]|$|por favor|porfa|gracias|\\s+y\\s))';
/** "llámame / me llamo / mi nombre es": up to two words. */
const NAMED = new RegExp(
  `(?:^|[^\\p{L}])(?:ll[aá]m[ae]me|me llamo|mi nombre es)\\s+(${WORD})(?:\\s+(${WORD}))?${END}`,
  'iu',
);
/** "dime / dígame / puedes decirme": one word only ("dime cuánto cuesta"). */
const CALL_ME = new RegExp(
  `(?:^|[^\\p{L}])(?:dime|d[ií]game|(?:me )?puedes? decirme|me puedes? decir)\\s+(${WORD})${END}`,
  'iu',
);
const NOT_A_NAME = new Set([
  'que',
  'cuanto',
  'cuantos',
  'cuantas',
  'cual',
  'cuales',
  'como',
  'donde',
  'cuando',
  'si',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'lo',
  'le',
  'me',
  'te',
  'se',
  'nos',
  'por',
  'para',
  'precio',
  'precios',
  'mas',
  'algo',
  'todo',
  'eso',
  'esto',
  'ese',
  'esa',
  'hola',
  'gracias',
  'favor',
  'porfa',
  'no',
  'ok',
  'bien',
  'tu',
  'su',
  'mi',
  'de',
  'del',
  'con',
  'sin',
  'y',
  'o',
  'ya',
  'ahora',
  'pues',
  'oye',
  'atencion',
]);

const fold = (word: string): string =>
  word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const capitalize = (word: string): string =>
  word.charAt(0).toLocaleUpperCase('es-MX') + word.slice(1);

/** The name the customer explicitly asked to be called, or `null`. */
export function explicitPreferredName(text: string): string | null {
  const own = customerOwnText(text);
  const named = NAMED.exec(own);
  if (named !== null) {
    const words = [named[1], named[2]].filter(
      (word): word is string => word !== undefined,
    );
    // "me llamo la atención": a leading stop word means it is no name.
    if (NOT_A_NAME.has(fold(words[0]))) return null;
    const kept =
      words[1] !== undefined && NOT_A_NAME.has(fold(words[1]))
        ? [words[0]]
        : words;
    return kept.map(capitalize).join(' ');
  }
  const callMe = CALL_ME.exec(own);
  if (callMe !== null && !NOT_A_NAME.has(fold(callMe[1])))
    return capitalize(callMe[1]);
  return null;
}

const FORGET =
  /\b(?:olvid(?:a|ate|ar|en|es|ese)|borr(?:a|ar|en|es)|elimin(?:a|ar|en|es))\b[^.?!]{0,30}?\bmis datos\b/;
const CHECKOUT_DATA = /\bmis datos de (?:entrega|envio)\b/;

/** "olvida / borra / elimina mis datos" (never "mis datos de entrega"). */
export function isForgetMyDataRequest(text: string): boolean {
  const folded = fold(customerOwnText(text));
  return FORGET.test(folded) && !CHECKOUT_DATA.test(folded);
}
