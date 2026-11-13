/**
 * T8 / S6: deterministic detector for a CLEAR "I want to talk to a person"
 * message (Spanish, tú and usted). It runs before the LLM turn, so it is
 * conservative on purpose: every pattern is anchored at the start of the
 * message, which excludes negations ("no quiero hablar con una persona"),
 * narration ("hablé con una persona ayer") and other uses of the word
 * ("para cuántas personas", "persona moral"). Anything it does not match goes
 * to the normal agent turn.
 *
 * Rules (on text lowercased, accent-stripped, punctuation removed):
 *  1. At most MAX_WORDS words.
 *  2. Optional greeting/filler and wanting verbs ("hola", "por favor",
 *     "quiero", "necesito", "me gustaría", "puedo", ...), nothing else.
 *  3. Then one of:
 *     A. talk verb + "con" + target: "hablar con una persona".
 *     B. transfer verb + "con" + target: "pásame con alguien".
 *     C. attend verb + indefinite target: "que me atienda un asesor".
 *     D. wanting verb + strong target: "necesito un asesor".
 *     E. the strong target alone: "un humano", "persona real" (a bare
 *        "humano" needs its article).
 *  4. Plain "persona" only appears after a talk/transfer/attend verb; a bare
 *     "una persona" is never enough.
 *  5. The target may be followed only by courtesy words or by a "porque",
 *     "para", "es que", ... clause (the customer explaining why).
 *  6. "No quiero hablar con un bot" before the ask is skipped, so "no quiero
 *     hablar con un robot, quiero una persona" matches.
 */

const MAX_WORDS = 30;
const MAX_CHARS = 300;

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------- pieces

const FILLER =
  '(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches|oye|oiga|disculpa|disculpe|perdon|mira|ok|okay|pues|entonces|mejor|ya|gracias|por favor|porfa|porfavor|favor de|si|quiero|quisiera|necesito|requiero|prefiero|deseo|busco|me gustaria|me gustaria poder|podria|podrian|puedo|puede|puedes|podemos|ahora|ahorita|le pido|te pido)\\s+)*';

const ARTICLE = '(?:(?:una|un|alguna|algun)\\s+)?';
const COURTESY =
  '(?:\\s+(?:por favor|porfa|porfavor|ahorita|ahora|ya|gracias|mejor|real|de verdad))*';
const ORG =
  '(?:\\s+(?:del equipo|de ventas|de atencion(?: a clientes?| al cliente)?|de servicio(?: a clientes?)?|de la tienda|de houndfe))?';

/** Strong targets: unambiguous even without a talk verb. */
const STRONG =
  '(?:persona real|persona de verdad|persona humana|humano|humana|asesor|asesora|agente humano|ejecutivo|ejecutiva|representante|alguien del equipo|alguien de atencion(?: a clientes?| al cliente)?|atencion humana|atencion personalizada)';

/** Strong targets that also stand alone without an article. */
const STRONG_BARE =
  '(?:persona real|persona de verdad|asesor|asesora|agente humano|ejecutivo|ejecutiva|representante|atencion humana|atencion personalizada)';

/** Targets after a talk/transfer/attend verb ("persona" is allowed here). */
const TARGET =
  `(?:${ARTICLE}(?:persona(?:\\s+(?:real|de verdad|humana))?|humano|humana|asesor|asesora|agente(?:\\s+humano)?|ejecutivo|ejecutiva|vendedor|vendedora|representante|operador|operadora|empleado|empleada)${ORG}` +
  `|alguien${ORG}(?:\\s+real)?` +
  '|(?:el|la)\\s+(?:encargado|encargada|gerente|dueno|duena|responsable))';

const TAIL_CLAUSE =
  '(?:\\s+(?:porque|para|es que|ya que|sobre|acerca|por|que|pues|ya|y)\\b.*)?';
const END = `${COURTESY}${TAIL_CLAUSE}$`;

const TALK_VERB =
  '(?:hablar|platicar|conversar|comunicarme|comunicarnos|contactar|chatear|escribir|escribirle)';
const TRANSFER_VERB =
  '(?:pasame|pasenme|pasanos|me pasas|me pasa|me pasan|me puedes pasar|me puede pasar|me podrias pasar|me podria pasar|me podrian pasar|puedes pasarme|puede pasarme|podrias pasarme|podria pasarme|podrian pasarme|comunicame|comunicanos|me comunicas|me comunica|me puedes comunicar|me puede comunicar|me podrian comunicar|conectame|me conectas|me conecta|transfiereme|transferirme|me transfieres|me transfiere|me puedes transferir|me puede transferir|que me pase|que me comunique|que me conecte)';
const ATTEND_VERB =
  '(?:que me atienda|que me atiendan|que me conteste|que me responda|que me ayude|me puede atender|me puedes atender|me pueden atender|me podria atender|me podrian atender|me puede ayudar|me puedes ayudar|me pueden ayudar|atiendame|atiendanme|atiendeme)';
const WANT_VERB =
  '(?:quiero|quisiera|necesito|requiero|prefiero|deseo|busco|me gustaria)';

const BOT_REJECTION = new RegExp(
  '^no (?:quiero|me gusta|puedo|deseo|prefiero|me sirve) (?:hablar|platicar|chatear|seguir hablando) con (?:un |una |el |la )?(?:bot|robot|chatbot|maquina|ia|inteligencia artificial|programa)\\s+(.+)$',
);

const PATTERNS: readonly RegExp[] = [
  // A. talk verb + target
  new RegExp(`^${FILLER}${TALK_VERB} (?:con|a) ${TARGET}${END}`),
  // B. transfer verb + target
  new RegExp(`^${FILLER}${TRANSFER_VERB} (?:con|a) ${TARGET}${END}`),
  // C. attend verb + indefinite target
  new RegExp(
    `^${FILLER}${ATTEND_VERB} (?:una|un|alguna|algun) (?:persona(?:\\s+(?:real|de verdad))?|humano|asesor|asesora|agente humano)${ORG}${END}`,
  ),
  // D. wanting verb (+ optional "hablar con") + strong target
  new RegExp(
    `^${FILLER}${WANT_VERB} (?:hablar con )?${ARTICLE}${STRONG}${ORG}${END}`,
  ),
  // E. the strong target alone; a bare "humano" needs its article.
  new RegExp(`^(?:(?:un|una)\\s+${STRONG}|${STRONG_BARE})${COURTESY}$`),
];

const AFTER_REJECTION: RegExp = new RegExp(
  `^${FILLER}${WANT_VERB} (?:una )?persona${COURTESY}$`,
);

function matches(normalized: string): boolean {
  return PATTERNS.some((pattern) => pattern.test(normalized));
}

/** True only for a clear, short request to talk to a person. */
export function isTalkToHumanRequest(text: string): boolean {
  if (typeof text !== 'string' || text.length > MAX_CHARS) return false;
  const normalized = normalize(text);
  if (normalized === '') return false;
  if (normalized.split(' ').length > MAX_WORDS) return false;
  if (matches(normalized)) return true;
  const rejection = BOT_REJECTION.exec(normalized);
  if (rejection === null) return false;
  const rest = rejection[1];
  return matches(rest) || AFTER_REJECTION.test(rest);
}
