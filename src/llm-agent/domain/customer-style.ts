/**
 * S2 tone mirroring: the customer's register (usted/tú), emoji use and
 * formality, read from their own recent messages, and the pure rules that
 * apply it to the LLM prompt and to the server-owned fixed replies.
 *
 * Start with usted; the latest explicit signal wins. Fixed replies are
 * written in usted; the tú variants come from the curated phrase pairs
 * below (whole phrases of the real copy, never a word-level regex), so
 * amounts, folios, CLABE and interpolated data are never rewritten.
 */

export type CustomerRegister = 'usted' | 'tu';
export type CustomerTone = 'formal' | 'neutral' | 'casual';

export interface CustomerStyle {
  register: CustomerRegister;
  emojis: boolean;
  tone: CustomerTone;
}

export const DEFAULT_CUSTOMER_STYLE: CustomerStyle = Object.freeze({
  register: 'usted',
  emojis: false,
  tone: 'neutral',
});

/** Emojis are read from the last 1-3 customer messages. */
const EMOJI_WINDOW = 3;
const TONE_WINDOW = 3;

const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_SEQUENCE =
  /[ \t]*\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

const USTED_MARKERS = [
  /\busted(es)?\b/,
  /\ble agradec\w*/,
  /\b(me|nos) (puede|podria)\b/,
  /\bdisculpe\b/,
  /\boiga\b/,
  /\b(seria|sea) tan amable\b/,
];
const TU_MARKERS = [
  /\b(tu|tus|ti|te|contigo)\b/,
  /\b(tienes|puedes|podrias|quieres|sabes|manejas|vendes|mandas|envias|haces|cobras|aceptas|ocupas|necesitas|crees)\b/,
  /\b(oye|dime|dame|disculpa|checa|fijate|ponme|agrega|ensename)\b/,
  // Tú imperatives of -ar verbs with enclitics: agrégame, mándamelos, pásalo.
  /\b(agrega|manda|pasa|quita|aparta|cotiza|muestra|envia|ayuda|avisa|confirma|regala|cambia)(?:(?:me|te|nos)(?:lo|la|los|las)?|lo|la|los|las)\b/,
];
const FORMAL_MARKERS = [
  /\bbuen(os|as) (dias|tardes|noches)\b/,
  /\busted(es)?\b/,
  /\ble agradec\w*/,
  /\bfavor de\b/,
  /\bestimad[oa]s?\b/,
  /\bcordial\w*/,
  /\batentamente\b/,
  /\bdisculpe\b/,
];
const CASUAL_MARKERS = [
  /\b(ja){2,}\w*/,
  /\b(je){2,}\w*/,
  /\b(porfa|porfis|plis|pls|xfa|holi\w*|wey|guey|oye|sale|chido)\b/,
  /\bq(ue)? onda\b/,
  /\bhola{2,}\b/,
  /!.*!/,
];

/** The product-photo synthetic block is app text, not the customer's voice. */
const SYNTHETIC_IMAGE_BLOCK = /\n?\[Imagen enviada por el cliente:[\s\S]*$/;

function normalize(text: string): string {
  return text
    .replace(SYNTHETIC_IMAGE_BLOCK, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const matches = (patterns: readonly RegExp[], text: string): number =>
  patterns.filter((pattern) => pattern.test(text)).length;

function registerSignal(text: string): CustomerRegister | null {
  if (matches(USTED_MARKERS, text) > 0) return 'usted';
  if (matches(TU_MARKERS, text) > 0) return 'tu';
  return null;
}

function toneSignal(raw: string, text: string): CustomerTone {
  const formal = matches(FORMAL_MARKERS, text);
  const casual = matches(CASUAL_MARKERS, text) + (EMOJI.test(raw) ? 1 : 0);
  if (formal > casual) return 'formal';
  if (casual > formal) return 'casual';
  return 'neutral';
}

/** Style of the customer's own messages, oldest first. */
export function detectCustomerStyle(
  userTexts: readonly string[],
): CustomerStyle {
  const texts = userTexts.map((raw) => ({
    raw: raw.replace(SYNTHETIC_IMAGE_BLOCK, ''),
    text: normalize(raw),
  }));
  let register: CustomerRegister = DEFAULT_CUSTOMER_STYLE.register;
  for (const { text } of texts) register = registerSignal(text) ?? register;
  const emojis = texts.slice(-EMOJI_WINDOW).some(({ raw }) => EMOJI.test(raw));
  let tone: CustomerTone = DEFAULT_CUSTOMER_STYLE.tone;
  for (const { raw, text } of texts.slice(-TONE_WINDOW).reverse()) {
    const signal = toneSignal(raw, text);
    if (signal !== 'neutral') {
      tone = signal;
      break;
    }
  }
  return { register, emojis, tone };
}

const TONE_REPLY: Record<CustomerTone, string> = {
  casual: 'tono cercano y cálido, sin jerga',
  neutral: 'tono cordial y profesional',
  formal: 'tono profesional y sobrio',
};

/** Per-turn prompt directive for the detected style. */
export function customerStyleDirective(style: CustomerStyle): string {
  const tu = style.register === 'tu';
  return (
    `Estilo del cliente: ${tu ? 'tutea' : 'de usted'}, ` +
    `${style.emojis ? 'usa emojis' : 'sin emojis'}, tono ${style.tone}. ` +
    `Responde ${tu ? 'de tú (tú, te, tu; nunca usted ni voseo)' : 'de usted (usted, le, su; nunca de tú)'}, ` +
    `${style.emojis ? 'con 1 emoji natural como máximo por mensaje y nunca más emojis que el cliente' : 'sin emojis'}, ` +
    `${TONE_REPLY[style.tone]}. Mantén este estilo en todo el mensaje.`
  );
}

/**
 * Curated usted → tú phrase pairs for the fixed customer copy, applied in
 * order (longer phrases first). A phrase that is not listed stays in usted:
 * a missing pair degrades to the safe default, never to broken grammar.
 */
const TU_PHRASES: ReadonlyArray<readonly [string, string]> = [
  // Whole clauses whose verbs depend on context.
  [
    'Si vuelve a pedir el resumen y responde SÍ',
    'Si vuelves a pedir el resumen y respondes SÍ',
  ],
  [
    'Puede revisar su carrito y pedir de nuevo el resumen cuando quiera.',
    'Puedes revisar tu carrito y pedir de nuevo el resumen cuando quieras.',
  ],
  [
    'elija de nuevo el producto o su presentación',
    'elige de nuevo el producto o la presentación',
  ],
  [
    'Cuando haga la transferencia, envíe aquí',
    'Cuando hagas la transferencia, envía aquí',
  ],
  [
    'Ya estoy atendiendo su consulta; por favor espere',
    'Ya estoy atendiendo tu consulta; por favor espera',
  ],
  ['Listo, usted recoge su pedido', 'Listo, recoges tu pedido'],
  [
    'No pude registrar que recoge su pedido',
    'No pude registrar que recoges tu pedido',
  ],
  ['no puedo cambiar cómo lo recibe.', 'no puedo cambiar cómo lo recibes.'],
  ['cómo recibirá su pedido', 'cómo recibirás tu pedido'],
  ['después deberá confirmar', 'después deberás confirmar'],
  ['necesito que confirme', 'necesito que confirmes'],
  ['para que lo confirme de nuevo', 'para que lo confirmes de nuevo'],
  ['Confirme sus datos de entrega:', 'Confirma tus datos de entrega:'],
  ['Usted tiene un crédito de', 'Tienes un crédito de'],
  ['sin costo para usted', 'sin costo para ti'],
  ['Usted paga', 'Pagas'],
  ['Si está de acuerdo', 'Si estás de acuerdo'],
  ['Tengo un pedido suyo', 'Tengo un pedido tuyo'],
  ['el nombre del producto que busca?', 'el nombre del producto que buscas?'],
  // Questions.
  ['¿Me confirma o corrige', '¿Me confirmas o corriges'],
  ['¿Me confirma', '¿Me confirmas'],
  ['¿Me los comparte', '¿Me los compartes'],
  ['¿Me lo comparte?', '¿Me lo compartes?'],
  ['¿Me puede', '¿Me puedes'],
  [
    '¿puede indicarme de nuevo qué desea?',
    '¿puedes indicarme de nuevo qué quieres?',
  ],
  ['¿Le parece?', '¿Te parece?'],
  ['¿Quiere que consulte', '¿Quieres que consulte'],
  ['¿Qué dato quiere corregir?', '¿Qué dato quieres corregir?'],
  ['qué quiere cambiar', 'qué quieres cambiar'],
  ['¿Desea cambiar', '¿Quieres cambiar'],
  ['unidades desea agregar', 'unidades quieres agregar'],
  ['presentación desea agregar', 'presentación quieres agregar'],
  ['¿Qué producto desea?', '¿Qué producto quieres?'],
  ['Si desea comprar', 'Si quieres comprar'],
  // Imperatives and usted verb forms.
  ['Dígame', 'Dime'],
  ['dígame', 'dime'],
  ['Pídame', 'Pídeme'],
  ['Responda "SÍ"', 'Responde "SÍ"'],
  ['responda SÍ', 'responde SÍ'],
  ['Pida de nuevo', 'Pide de nuevo'],
  ['pida de nuevo', 'pide de nuevo'],
  ['pida otra vez', 'pide otra vez'],
  ['Revise ', 'Revisa '],
  ['revise ', 'revisa '],
  ['Comuníquese', 'Comunícate'],
  ['comuníquese', 'comunícate'],
  ['Agregue ', 'Agrega '],
  ['elija ', 'elige '],
  ['quítelo', 'quítalo'],
  ['quite ese producto', 'quita ese producto'],
  ['ajuste la cantidad', 'ajusta la cantidad'],
  ['vuelva a pedir', 'vuelve a pedir'],
  ['Confírmela', 'Confírmala'],
  ['Intente de nuevo', 'Intenta de nuevo'],
  ['intente de nuevo', 'intenta de nuevo'],
  ['Indique ', 'Indica '],
  ['escríbame', 'escríbeme'],
  ['Envíenos', 'Envíanos'],
  ['Recójalo', 'Recógelo'],
  ['Puede intentarlo', 'Puedes intentarlo'],
  ['Puede pedirme', 'Puedes pedirme'],
  ['Puede pedírmelo', 'Puedes pedírmelo'],
  ['Puede recoger', 'Puedes recoger'],
  ['puede recoger', 'puedes recoger'],
  ['Puede solicitar', 'Puedes solicitar'],
  ['si prefiere', 'si prefieres'],
  // Object pronouns.
  ['haberle entendido', 'haberte entendido'],
  ['Le mostraré', 'Te mostraré'],
  ['le mostraré', 'te mostraré'],
  ['mostrarle', 'mostrarte'],
  ['le muestro', 'te muestro'],
  ['le cotizo', 'te cotizo'],
  ['Le avisamos', 'Te avisamos'],
  ['le avisamos', 'te avisamos'],
  ['darle', 'darte'],
  ['se la comparto', 'te la comparto'],
  ['se la confirmamos', 'te la confirmamos'],
  // Possessives (always the customer's own things in this copy).
  ['Su carrito', 'Tu carrito'],
  ['su carrito', 'tu carrito'],
  ['Su pedido', 'Tu pedido'],
  ['su pedido', 'tu pedido'],
  ['Sus datos', 'Tus datos'],
  ['sus datos', 'tus datos'],
  ['Su dirección', 'Tu dirección'],
  ['su dirección', 'tu dirección'],
  ['sus direcciones', 'tus direcciones'],
  ['su código postal', 'tu código postal'],
  ['Su envío', 'Tu envío'],
  ['su cotización', 'tu cotización'],
  ['sus productos', 'tus productos'],
  ['su comprobante', 'tu comprobante'],
  ['Su consulta', 'Tu consulta'],
  ['su consulta', 'tu consulta'],
  ['su teléfono', 'tu teléfono'],
  ['su nombre', 'tu nombre'],
  ['su imagen', 'tu imagen'],
  ['su mensaje', 'tu mensaje'],
];

function toTu(text: string): string {
  let out = text;
  for (const [usted, tu] of TU_PHRASES) out = out.split(usted).join(tu);
  return out;
}

function limitEmojis(text: string, keep: number): string {
  let seen = 0;
  let changed = false;
  const out = text.replace(EMOJI_SEQUENCE, (emoji) => {
    seen += 1;
    if (seen <= keep) return emoji;
    changed = true;
    return '';
  });
  return changed ? out.replace(/^[ \t]+/gm, '').trim() : text;
}

/**
 * A server-owned customer reply in the customer's style: usted copy is kept
 * byte-identical for usted customers, converted with the curated phrase
 * pairs for tú customers; emojis are stripped for customers who use none and
 * capped at one existing emoji otherwise (none is ever added).
 */
export function applyCustomerStyle(text: string, style: CustomerStyle): string {
  const registered = style.register === 'tu' ? toTu(text) : text;
  return limitEmojis(registered, style.emojis ? 1 : 0);
}

/** Emoji guard only, for model-authored text the prompt already styled. */
export function limitCustomerEmojis(
  text: string,
  style: CustomerStyle,
): string {
  return style.emojis ? text : limitEmojis(text, 0);
}
