/**
 * Unit 14 T4: deterministic matchers for the customer's messages about their
 * appointment ("¿a qué hora quedé?", change it, cancel it). Conservative on
 * purpose: every pattern is ANCHORED over the whole (normalized) message, only
 * greetings / politeness may surround it, and a message that does more than
 * one thing ("quiero cambiar mi cita pero antes dime…") is not an intent; it
 * goes to the agent. Accent- and case-insensitive; no name or phone is ever
 * looked at.
 */

export type AppointmentIntent = 'what_time' | 'change' | 'cancel';

const MAX_LENGTH = 80;

/** Lowercase, no accents, no keycap/variation marks, no light punctuation. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ⃣️]/g, '')
    .replace(/[¿?¡!,;:.()[\]"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEAD =
  '(?:(?:hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|oye|oiga|disculpe|disculpa|perdon|una pregunta|pues|entonces|lo siento|bueno)\\s+)*';
const TRAIL = '(?:\\s+(?:por favor|porfa|pf|gracias|muchas gracias|please))*';

const anchored = (...cores: string[]): RegExp =>
  new RegExp(`^${LEAD}(?:${cores.join('|')})${TRAIL}$`);

const VERB =
  '(?:cambiar|mover|reagendar|reprogramar|modificar|posponer|adelantar|recorrer)';
const WANT =
  '(?:quiero|queria|quisiera|necesito|me gustaria|deseo|favor de|voy a querer)(?: poder)?';
const OWN = '(?:mi |la |el )?';
const OTHER_TIME =
  '(?: (?:para|a|por) (?:otro|otra) (?:dia|hora|horario|fecha))?';

const WHAT_TIME = anchored(
  'a que hora (?:quede|quedamos|quedo|me toca|me escriben|me van a escribir|me atienden|me van a atender|me hablan|me llaman|es mi cita|es la cita|era mi cita|era la cita|fue mi cita)(?: con ustedes)?',
  '(?:cuando|que dia(?: y a que hora)?|que dia y hora) (?:es|era|fue) (?:mi|la) cita',
  '(?:en )?que (?:horario|hora) quede',
);

const CHANGE = anchored(
  `${WANT} ${VERB} ${OWN}cita${OTHER_TIME}`,
  `${WANT} ${VERB} (?:la hora|el horario|el dia|la fecha) de (?:mi|la) cita`,
  `la (?:puedo|podria|podemos) ${VERB}`,
  `(?:puedo|podria|podemos|se puede|se podria|es posible) ${VERB}la`,
  `(?:puedo|podria|podemos|se puede|se podria|es posible|puedes|pueden) ${VERB} (?:mi |la )?cita`,
  `${VERB} (?:mi |la )?cita${OTHER_TIME}`,
  '(?:reagendar|reprogramar)(?: mi cita| la cita)?',
);

// Every cancel phrasing must NAME the appointment ("cita"): a bare "ya no voy
// a poder" / "ya no puedo ir" may be about a pickup, an order or a delivery,
// so it goes to the agent.
const CANCEL = anchored(
  `(?:(?:${WANT}|voy a) )?(?:cancelar|cancela|cancele|cancelen|anular|anula)(?: me)? (?:mi |la |esa |el )?cita`,
  'ya no (?:quiero|necesito|voy a necesitar) (?:mi |la |esa )?cita',
  '(?:ya )?no (?:voy a poder|puedo|podre|podremos|podemos) (?:ir|asistir|llegar|atender) a (?:mi|la|esa) cita',
);

/** Which appointment intent the whole message is, or null. */
export function parseAppointmentIntent(text: string): AppointmentIntent | null {
  if (typeof text !== 'string' || text.length > MAX_LENGTH * 2) return null;
  const normalized = normalize(text);
  if (normalized === '' || normalized.length > MAX_LENGTH) return null;
  if (CANCEL.test(normalized)) return 'cancel';
  if (CHANGE.test(normalized)) return 'change';
  if (WHAT_TIME.test(normalized)) return 'what_time';
  return null;
}

const CONFIRM_STARTERS: ReadonlySet<string> = new Set([
  'claro',
  'ok',
  'okay',
  'va',
  'dale',
  'simon',
  'andale',
  'aja',
  'cambiarla',
  'cambiala',
]);
const CONFIRM_FILLERS: ReadonlySet<string> = new Set([
  'quiero',
  'cambiar',
  'la',
  'por',
  'favor',
  'porfa',
  'gracias',
  'pues',
]);
const MAX_CONFIRM_WORDS = 6;

const isYes = (word: string): boolean => /^si+$/.test(word);

/**
 * The customer's answer "yes" to «¿Quiere cambiarla?»: only a handful of
 * affirmative words (and politeness), never a sentence. Any "no" or any other
 * word makes it not a confirmation.
 */
export function isChangeConfirmation(text: string): boolean {
  if (typeof text !== 'string' || text.length > MAX_LENGTH * 2) return false;
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_CONFIRM_WORDS) return false;
  let affirmative = false;
  for (const word of words) {
    if (isYes(word) || CONFIRM_STARTERS.has(word)) affirmative = true;
    else if (!CONFIRM_FILLERS.has(word)) return false;
  }
  return affirmative;
}
