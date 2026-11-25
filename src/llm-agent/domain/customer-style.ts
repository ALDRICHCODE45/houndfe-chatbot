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

import { TITLE_EMOJI_LINE } from './whatsapp-format';

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

/**
 * Emojis are allowed only when the customer's latest message has one, or at
 * least 2 of their last 3 do; a single emoji further back is not a style.
 */
const EMOJI_WINDOW = 3;
const EMOJI_WINDOW_MIN = 2;
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
  // Curated present-tense tú verbs; never an -as/-es suffix (más, gas, veces).
  /\b(tienes|puedes|podrias|quieres|sabes|manejas|vendes|mandas|envias|haces|cobras|aceptas|ocupas|necesitas|crees)\b/,
  /\b(recomiendas|recomendarias|das|sugieres|aconsejas|conoces|ayudas|prefieres|dices|pides|traes|llevas|buscas|ofreces)\b/,
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

/** The customer's own words of a turn (the synthetic image block removed). */
export function customerOwnText(text: string): string {
  return text.replace(SYNTHETIC_IMAGE_BLOCK, '');
}

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

/** The emoji rule over the customer's own messages, oldest first. */
export function customerAllowsEmojis(userTexts: readonly string[]): boolean {
  const recent = userTexts
    .slice(-EMOJI_WINDOW)
    .map((raw) => EMOJI.test(raw.replace(SYNTHETIC_IMAGE_BLOCK, '')));
  return (
    recent.at(-1) === true || recent.filter(Boolean).length >= EMOJI_WINDOW_MIN
  );
}

/**
 * Style of the customer's own messages, oldest first. S1: `seed` is the
 * stored profile style; it fills the register and tone until this session
 * shows an explicit signal. Emojis always follow this session's messages.
 */
export function detectCustomerStyle(
  userTexts: readonly string[],
  seed?: CustomerStyle | null,
): CustomerStyle {
  const texts = userTexts.map((raw) => ({
    raw: raw.replace(SYNTHETIC_IMAGE_BLOCK, ''),
    text: normalize(raw),
  }));
  let register: CustomerRegister =
    seed?.register ?? DEFAULT_CUSTOMER_STYLE.register;
  for (const { text } of texts) register = registerSignal(text) ?? register;
  const emojis = customerAllowsEmojis(texts.map(({ raw }) => raw));
  let tone: CustomerTone = seed?.tone ?? DEFAULT_CUSTOMER_STYLE.tone;
  for (const { raw, text } of texts.slice(-TONE_WINDOW).reverse()) {
    const signal = toneSignal(raw, text);
    if (signal !== 'neutral') {
      tone = signal;
      break;
    }
  }
  return { register, emojis, tone };
}

/** S1: the explicit register/tone signals of one message (none → {}). */
export function explicitStyleSignal(
  text: string,
): Partial<Pick<CustomerStyle, 'register' | 'tone'>> {
  const raw = text.replace(SYNTHETIC_IMAGE_BLOCK, '');
  const normalized = normalize(raw);
  const register = registerSignal(normalized);
  const tone = toneSignal(raw, normalized);
  return {
    ...(register === null ? {} : { register }),
    ...(tone === 'neutral' ? {} : { tone }),
  };
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
  // Cost protection phase 1: budget spent, number limited, closing reply.
  [
    'En este momento no puedo atenderle por aquí; ya le avisé al equipo y le escriben en cuanto puedan.',
    'En este momento no puedo atenderte por aquí; ya le avisé al equipo y te escriben en cuanto puedan.',
  ],
  [
    'Estamos revisando sus mensajes; en un momento le atiende alguien del equipo.',
    'Estamos revisando tus mensajes; en un momento te atiende alguien del equipo.',
  ],
  [
    '¡Con gusto! Aquí estoy si necesita algo más.',
    '¡Con gusto! Aquí estoy si necesitas algo más.',
  ],
  // Whole clauses whose verbs depend on context.
  // Human requests: team answers, staff cancel notice and the askTeam copy.
  [
    'Le comparto la respuesta del equipo:',
    'Te comparto la respuesta del equipo:',
  ],
  [
    'El equipo cerró su consulta. Si necesita algo más, escríbame por aquí.',
    'El equipo cerró tu consulta. Si necesitas algo más, escríbeme por aquí.',
  ],
  [
    'Todavía no tengo respuesta del equipo; sigue pendiente y le aviso en cuanto la tenga.',
    'Todavía no tengo respuesta del equipo; sigue pendiente y te aviso en cuanto la tenga.',
  ],
  [
    'Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan.',
    'Ya le pregunté al equipo, te aviso por aquí en cuanto me respondan.',
  ],
  [
    'Ya tiene varias consultas abiertas con el equipo; en cuanto respondan le aviso por aquí.',
    'Ya tienes varias consultas abiertas con el equipo; en cuanto respondan te aviso por aquí.',
  ],
  [
    'El equipo ya tiene sus consultas recientes; por favor espere un poco antes de enviar otra.',
    'El equipo ya tiene tus consultas recientes; por favor espera un poco antes de enviar otra.',
  ],
  [
    'Estoy registrando su consulta con el equipo; le aviso por aquí.',
    'Estoy registrando tu consulta con el equipo; te aviso por aquí.',
  ],
  // Talk-to-human flow: the request is created, queued out of hours, or
  // still being registered (owner-approved whole sentences).
  [
    'Con gusto, ya le pedí a una persona del equipo que le atienda. En cuanto alguien esté disponible, le escribe por aquí.',
    'Con gusto, ya le pedí a una persona del equipo que te atienda. En cuanto alguien esté disponible, te escribe por aquí.',
  ],
  [
    'Nuestro equipo atiende de lunes a sábado de 9 a 19 h. Ya dejé su solicitud y le escriben en cuanto abramos.',
    'Nuestro equipo atiende de lunes a sábado de 9 a 19 h. Ya dejé tu solicitud y te escriben en cuanto abramos.',
  ],
  [
    'Estoy registrando su solicitud para que le atienda una persona del equipo; le aviso por aquí.',
    'Estoy registrando tu solicitud para que te atienda una persona del equipo; te aviso por aquí.',
  ],
  // Live conversation (unit 11) notices: start, reassignment, end, resume.
  // The staff first name sits between the phrases and is never rewritten.
  ['Ahora le atiende ', 'Ahora te atiende '],
  ['Le atiende ', 'Te atiende '],
  [
    'Si necesita algo más, aquí sigo para ayudarle.',
    'Si necesitas algo más, aquí sigo para ayudarte.',
  ],
  [
    'Seguimos por aquí, ¿en qué le ayudo?',
    'Seguimos por aquí, ¿en qué te ayudo?',
  ],
  // Scheduled conversations (unit 14, owner-approved S3 copy). Phrase-level
  // on purpose: these texts interpolate day/time pieces, so the pairs only
  // cover the fixed usted wording around them.
  [
    '¿Quiere que una persona le atienda en alguno',
    '¿Quieres que una persona te atienda en alguno',
  ],
  ['Responda con el número', 'Responde con el número'],
  ['qué horario prefiere', 'qué horario prefieres'],
  ['le escribe por aquí', 'te escribe por aquí'],
  ['le atiende por aquí', 'te atiende por aquí'],
  ['A esa hora le escribimos', 'A esa hora te escribimos'],
  ['cuando le llegue el mensaje', 'cuando te llegue el mensaje'],
  ['respóndanos', 'respóndenos'],
  [
    'Ya dejé su solicitud y le escriben en cuanto abramos',
    'Ya dejé tu solicitud y te escriben en cuanto abramos',
  ],
  ['Ya tiene una cita', 'Ya tienes una cita'],
  ['¿Quiere cambiarla?', '¿Quieres cambiarla?'],
  ['Le recuerdo que', 'Te recuerdo que'],
  ['Su cita', 'Tu cita'],
  ['su cita', 'tu cita'],
  // Live conversation safety notice (contract rule 8, owner-approved).
  [
    'Tenemos una falla técnica, en cuanto se resuelva le respondemos.',
    'Tenemos una falla técnica, en cuanto se resuelva te respondemos.',
  ],
  // S4 interactive prompts and the change-button reply.
  // Retest S4 (N15): delivery-or-pickup question at checkout start.
  [
    '¿Se lo enviamos a su dirección o prefiere recogerlo en tienda?',
    '¿Te lo enviamos a tu dirección o prefieres recogerlo en tienda?',
  ],
  ['¿Confirma su pedido?', '¿Confirmas tu pedido?'],
  // Message formatting F2b: the S2 order summary closing («¿Está todo
  // bien?» reads the same in tú) and its bold SÍ.
  [
    '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.',
    '¿Está todo bien? Responde *SÍ* para crear el pedido, o dime qué cambiar.',
  ],
  // Message formatting F3a: the delivery-data SÍ line (before the short
  // «Responda *SÍ*» pair, which it contains).
  [
    'Responda *SÍ* para confirmar estos datos, o dígame qué quiere cambiar.',
    'Responde *SÍ* para confirmar estos datos, o dime qué quieres cambiar.',
  ],
  ['Responda *SÍ*', 'Responde *SÍ*'],
  ['dígame qué cambiar', 'dime qué cambiar'],
  ['Claro, ¿qué desea cambiar?', 'Claro, ¿qué quieres cambiar?'],
  ['¿Qué desea hacer?', '¿Qué quieres hacer?'],
  // S2 reorder offer, its buttons and replies.
  ['Su último pedido', 'Tu último pedido'],
  ['Lo último que pidió para ', 'Lo último que pediste para '],
  ['Sí, agréguelo', 'Sí, agrégalo'],
  [
    '¿Desea agregar algo más o seguimos con su compra?',
    '¿Quieres agregar algo más o seguimos con tu compra?',
  ],
  ['¿Qué producto busca?', '¿Qué producto buscas?'],
  // S13 code-rendered catalog options: closing and restock offer.
  ['¿Cuál le gustaría llevar?', '¿Cuál te gustaría llevar?'],
  ['¿Se lo agrego al carrito?', '¿Te lo agrego al carrito?'],
  ['Y si la que busca es ', 'Y si la que buscas es '],
  [', con gusto le averiguo cuándo', ', con gusto te averiguo cuándo'],
  // L26 dead end: longer pair first, so its «te busco» wins over the short one.
  [
    '¿Quiere que le pregunte al equipo si lo pueden conseguir, o le busco otra cosa?',
    '¿Quieres que le pregunte al equipo si lo pueden conseguir, o te busco otra cosa?',
  ],
  ['¿Quiere que le pregunte al equipo', '¿Quieres que le pregunte al equipo'],
  // S2 cart summary «Agregar algo más» reply.
  [
    'Claro, ¿qué producto desea agregar?',
    'Claro, ¿qué producto quieres agregar?',
  ],
  // S1 "olvida mis datos" confirmation.
  ['tenía guardados de usted', 'tenía guardados de ti'],
  ['Sus pedidos', 'Tus pedidos'],
  // S1 later notices: receipt outcomes, zone resolved, restock, expiration.
  [
    '¿Desea continuar con la compra o prefiere que le ayude con alguna otra consulta?',
    '¿Quieres continuar con la compra o prefieres que te ayude con alguna otra consulta?',
  ],
  [
    'Si quería enviarnos su comprobante, mándelo de nuevo; si no, dígame en qué le ayudo.',
    'Si querías enviarnos tu comprobante, mándalo de nuevo; si no, dime en qué te ayudo.',
  ],
  ['Escríbanos y le ayudamos.', 'Escríbenos y te ayudamos.'],
  [
    'si cree que es un error, escríbanos.',
    'si crees que es un error, escríbenos.',
  ],
  ['Por favor envíelo de nuevo', 'Por favor envíalo de nuevo'],
  ['Su PDF está protegido', 'Tu PDF está protegido'],
  ['¿Nos envía una captura', '¿Nos envías una captura'],
  ['Confirmamos su pago', 'Confirmamos tu pago'],
  // Retest S3 (N19): payment request while a receipt is in review.
  [
    'no hace falta que vuelva a pagar. Le aviso en cuanto quede confirmado.',
    'no hace falta que vuelvas a pagar. Te aviso en cuanto quede confirmado.',
  ],
  ['Gracias por su compra', 'Gracias por tu compra'],
  // Third-person verbs that read as usted markers in the tú copy.
  ['en cuanto se confirme.', 'en cuanto quede confirmado.'],
  ['contados desde su confirmación', 'contados desde esa confirmación'],
  ['puede enviarnos el comprobante', 'puedes enviarnos el comprobante'],
  ['Puede enviarnos el comprobante', 'Puedes enviarnos el comprobante'],
  ['cuando lo tenga.', 'cuando lo tengas.'],
  ['¡Que esté muy bien!', '¡Que estés muy bien!'],
  // Restock backorder S1: the offer closing of the estimate message first
  // (the longer phrase), then its short button body and the shorter phrases
  // of the answering turn (ask the count, confirm, already scheduled, stock
  // came back) that the closing contains.
  [
    '¿Quiere que se lo apartemos en cuanto llegue? Le aviso y no paga nada hasta entonces.',
    '¿Quieres que te lo apartemos en cuanto llegue? Te aviso y no pagas nada hasta entonces.',
  ],
  ['¿Quiere que se lo apartemos?', '¿Quieres que te lo apartemos?'],
  ['¿Cuántas piezas le aparto?', '¿Cuántas piezas te aparto?'],
  [
    '¿Cuántas piezas le agrego al carrito?',
    '¿Cuántas piezas te agrego al carrito?',
  ],
  ['Ya tiene agendado', 'Ya tienes agendado'],
  // Restock backorder S8 (T6): cancel question, status lines, several orders.
  [
    'Tiene varios pedidos por reposición',
    'Tienes varios pedidos por reposición',
  ],
  ['¿Cuál pedido desea cancelar?', '¿Cuál pedido quieres cancelar?'],
  ['¿Cuál desea cancelar?', '¿Cuál quieres cancelar?'],
  ['Se lo tenemos apartado', 'Te lo tenemos apartado'],
  ['se lo tenemos apartado', 'te lo tenemos apartado'],
  ['Le aviso en cuanto llegue', 'Te aviso en cuanto llegue'],
  ['le aviso en cuanto llegue', 'te aviso en cuanto llegue'],
  // Restock backorder T5b (S6): confirm, checkout refusals and reschedule.
  [
    '¿Quiere que se lo agende de nuevo? Quedaría al final de la fila de espera.',
    '¿Quieres que te lo agende de nuevo? Quedaría al final de la fila de espera.',
  ],
  ['Sigue primero en la fila', 'Sigues primero en la fila'],
  ['ya no se lo tenemos apartado', 'ya no te lo tenemos apartado'],
  ['el equipo le va a llamar', 'el equipo te va a llamar'],
  ['Pida ayuda al equipo', 'Pide ayuda al equipo'],
  ['Si quiere, dígame', 'Si quieres, dime'],
  ['el equipo le ayuda', 'el equipo te ayuda'],
  ['no paga nada hasta entonces', 'no pagas nada hasta entonces'],
  ['La fecha puede variar.', 'La fecha podría variar.'],
  ['Disculpe, no pude consultar', 'Disculpa, no pude consultar'],
  ['Elija una opción', 'Elige una opción'],
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
  ['¿Cómo desea pagar?', '¿Cómo deseas pagar?'],
  // Pay in store S3: the hold answer, its failure and the feed notices.
  // Phrase-level: folio, dates and the store sit between the phrases.
  ['Listo, le apartamos su pedido', 'Listo, te apartamos tu pedido'],
  ['Páselo a recoger y pagar en ', 'Pásalo a recoger y pagar en '],
  [
    'Si no pasa antes de esa fecha, el pedido se cancela.',
    'Si no pasas antes de esa fecha, el pedido se cancela.',
  ],
  [
    'No pude apartar su pedido en este momento; puede pagar por transferencia o intentarlo de nuevo en unos minutos.',
    'No pude apartar tu pedido en este momento; puedes pagar por transferencia o intentarlo de nuevo en unos minutos.',
  ],
  ['Le recordamos que su pedido', 'Te recordamos que tu pedido'],
  [
    'Si todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.',
    'Si todavía lo quieres, con gusto te ayudo a pedirlo de nuevo.',
  ],
  ['Le ampliamos el plazo de su pedido', 'Te ampliamos el plazo de tu pedido'],
  // pay-in-store-templates S3: a shortened deadline and the expired hold
  // with a payment registered.
  ['Actualizamos el plazo de su pedido', 'Actualizamos el plazo de tu pedido'],
  ['El plazo de su pedido', 'El plazo de tu pedido'],
  [
    'Como tiene un pago registrado, alguien del equipo le va a contactar para cerrarlo.',
    'Como tienes un pago registrado, alguien del equipo te va a contactar para cerrarlo.',
  ],
  [': ahora puede recogerlo y pagarlo', ': ahora puedes recogerlo y pagarlo'],
  [
    'ya le avisé al equipo y se los comparto',
    'ya te avisé al equipo y te los comparto',
  ],
  [
    'Los datos de pago de su nuevo pedido se los comparto en cuanto lo confirme.',
    'Los datos de pago de tu nuevo pedido te los comparto en cuanto lo confirmes.',
  ],
  [
    'Ya estoy atendiendo su consulta; por favor espere',
    'Ya estoy atendiendo tu consulta; por favor espera',
  ],
  ['Listo, usted recoge su pedido', 'Listo, recoges tu pedido'],
  [
    'Le agregué 1 unidad; si desea otra cantidad',
    'Te agregué 1 unidad; si quieres otra cantidad',
  ],
  ['¿A cuál producto se refiere', '¿A cuál producto te refieres'],
  [
    'No pude registrar que recoge su pedido',
    'No pude registrar que recoges tu pedido',
  ],
  ['no puedo cambiar cómo lo recibe.', 'no puedo cambiar cómo lo recibes.'],
  ['cómo recibirá su pedido', 'cómo recibirás tu pedido'],
  ['después deberá confirmar', 'después deberás confirmar'],
  ['necesito que confirme', 'necesito que confirmes'],
  ['para que lo confirme de nuevo', 'para que lo confirmes de nuevo'],
  // Message formatting F3a: the bold delivery-data heading (no colon).
  ['Confirme sus datos de entrega', 'Confirma tus datos de entrega'],
  ['Usted tiene un crédito de', 'Tienes un crédito de'],
  ['sin costo para usted', 'sin costo para ti'],
  ['Usted paga', 'Pagas'],
  ['Si está de acuerdo', 'Si estás de acuerdo'],
  ['Tengo un pedido suyo', 'Tengo un pedido tuyo'],
  ['el nombre del producto que busca?', 'el nombre del producto que buscas?'],
  ['presentación busca?', 'presentación buscas?'],
  ['Disculpe, no alcancé', 'Disculpa, no alcancé'],
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

/**
 * Keeps the first `keep` emojis and drops the rest. Message formatting S3:
 * with `keepTitleEmojis` (server-owned copy only, F2-fix G3) a title emoji
 * closing a bold title line (`TITLE_EMOJI_LINE`) is never dropped nor
 * counted; model text never gets that exemption. S2: only the whitespace a
 * removed leading emoji left at the start of its own line is trimmed, so
 * item indentation survives.
 */
function limitEmojis(
  text: string,
  keep: number,
  keepTitleEmojis: boolean,
): string {
  let seen = 0;
  let changed = false;
  const lines = text.split('\n').map((line) => {
    const titleEmoji = keepTitleEmojis
      ? (TITLE_EMOJI_LINE.exec(line)?.[1] ?? '')
      : '';
    const body = line.slice(0, line.length - titleEmoji.length);
    let leadingRemoved = false;
    const out = body.replace(EMOJI_SEQUENCE, (emoji, offset: number) => {
      seen += 1;
      if (seen <= keep) return emoji;
      changed = true;
      if (offset === 0) leadingRemoved = true;
      return '';
    });
    return (leadingRemoved ? out.replace(/^[ \t]+/, '') : out) + titleEmoji;
  });
  return changed ? lines.join('\n').trim() : text;
}

/**
 * A server-owned customer reply in the customer's style: usted copy is kept
 * byte-identical for usted customers, converted with the curated phrase
 * pairs for tú customers; emojis are stripped for customers who use none and
 * capped at one existing emoji otherwise (none is ever added).
 */
export function applyCustomerStyle(text: string, style: CustomerStyle): string {
  const registered = style.register === 'tu' ? toTu(text) : text;
  return limitEmojis(registered, style.emojis ? 1 : 0, true);
}

/**
 * S4: register only (usted/tú), emojis untouched. For interactive button
 * titles, whose emoji is part of the control, not decoration.
 */
export function applyCustomerRegister(
  text: string,
  style: CustomerStyle,
): string {
  return style.register === 'tu' ? toTu(text) : text;
}

/**
 * Emoji guard only, for model-authored text the prompt already styled. The
 * S3 title-emoji exemption is server copy only (F2-fix G3): a model line
 * «*Listo* ✅» loses its ✅ for a customer who uses no emojis.
 */
export function limitCustomerEmojis(
  text: string,
  style: CustomerStyle,
): string {
  return style.emojis ? text : limitEmojis(text, 0, false);
}
