import { customerAllowsEmojis } from '../../src/llm-agent/domain/customer-style';
import type { RefusalExpectation } from './scenarios';

/** Deterministic reply heuristics; no LLM judge. */
export type Severity = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  check: string;
  severity: Severity;
  detail?: string;
}

export type Register = 'usted' | 'tu';

export const REFUSAL_PHRASE = 'esa función aún no está disponible';

const EMOJI = /\p{Extended_Pictographic}/u;

// Word boundaries that understand accented letters (\b is ASCII-only).
const words = (list: string[]) =>
  new RegExp(`(?<![\\p{L}])(?:${list.join('|')})(?![\\p{L}])`, 'giu');

const CUSTOMER_TU = words([
  'tú',
  'tienes',
  'puedes',
  'quieres',
  'sabes',
  'eres',
  'dime',
  'dame',
  'oye',
  'checa',
  'agrégame',
  'agregame',
  'agrégamelos',
  'agregamelos',
  'agrégalo',
  'mándame',
  'mandame',
  'pásame',
  'ponme',
  'cambia',
  'quita',
  'recomiendas',
  'porfa',
  'te',
  'tu',
]);
const CUSTOMER_USTED = words([
  'usted',
  'podría',
  'dígame',
  'agrégueme',
  'agréguela',
  'agréguelo',
  'agregue',
  'disculpe',
  'le agradezco',
  'recomienda',
]);

const BOT_TU = words([
  'tú',
  'te',
  'ti',
  'contigo',
  'tu',
  'tus',
  'tienes',
  'puedes',
  'quieres',
  'deseas',
  'prefieres',
  'gustas',
  'buscabas',
  'dime',
  'escríbeme',
  'confírmame',
  'responde',
  'elige',
  'avísame',
  'ayudarte',
  'ofrecerte',
  'mostrarte',
  'enviarte',
  'agregarte',
  'confirmarte',
  'recomendarte',
  'indicarte',
  'darte',
  'pasarte',
]);
const BOT_USTED = words([
  'usted',
  'le',
  'su',
  'sus',
  'dígame',
  'escríbame',
  'responda',
  'confirme',
  'elija',
  'desea',
  'prefiere',
  'gusta',
  'buscaba',
  'ayudarle',
  'ofrecerle',
  'mostrarle',
  'enviarle',
  'agregarle',
  'confirmarle',
  'recomendarle',
  'indicarle',
  'darle',
]);

const SLANG = words([
  'vos',
  'tenés',
  'querés',
  'podés',
  'sos',
  'decí',
  'mirá',
  'fijate',
  'che',
  'vosotros',
  'tenéis',
  'queréis',
  'podéis',
  'güey',
  'wey',
  'chido',
  'neta',
  'chela',
  'órale',
  'chale',
  'carnal',
  'bro',
  'chamba',
  'padrísimo',
  'pa',
]);

const PERSONA_WRONG = /tecnolog[ií]a|retail|punto de venta|Hound Technologies/i;
const PERSONA_PET = /mascota/i;
const LEAK =
  /selectionRef|cartSelectionRef|productId|variantId|quoteId|\bJSON\b|herramienta|Primero registra la venta/i;

const INTENT_CLAIM = /registr\w* la intenci[oó]n/i;
const VAGUE_OPTIONS = /varias opciones/i;
const LIST_LINE = /^\s*(?:[-•*]|\d+[.)])\s+\S/m;
/** A short "label: value" list item, e.g. `- **Marca:** Pet's Choice`. */
const ATTRIBUTE_LINE = /^(?:[-•*]|\d+[.)])\s+\**[^:.!?]{1,30}:\**\s*\S.{0,50}$/;

const count = (re: RegExp, text: string) => (text.match(re) ?? []).length;

export const hasEmoji = (text: string) => EMOJI.test(text);

/** Sticky customer register: starts usted, follows the latest marker. */
export function nextRegister(
  current: Register,
  customerText: string,
): Register {
  const tu = count(CUSTOMER_TU, customerText);
  const usted = count(CUSTOMER_USTED, customerText);
  if (tu > usted) return 'tu';
  if (usted > tu) return 'usted';
  return current;
}

export function checkReply(input: {
  customerText: string;
  /** The customer's messages so far, oldest first (default: this one). */
  recentCustomerTexts?: readonly string[];
  reply: string;
  expected: Register;
  refusal: RefusalExpectation;
  expectPersona: boolean;
}): CheckResult[] {
  const { customerText, reply, expected, refusal, expectPersona } = input;
  const out: CheckResult[] = [];
  if (reply.trim() === '') {
    return [{ check: 'empty', severity: 'fail', detail: 'empty reply' }];
  }

  // Same rule as the service's emoji guard (customer-style.ts).
  const customerEmoji = hasEmoji(customerText);
  const emojiAllowed = customerAllowsEmojis(
    input.recentCustomerTexts ?? [customerText],
  );
  const botEmoji = hasEmoji(reply);
  if (!emojiAllowed && botEmoji)
    out.push({
      check: 'emoji',
      severity: 'fail',
      detail: 'emoji while the customer has no recent emoji style',
    });
  else if (customerEmoji && !botEmoji)
    out.push({
      check: 'emoji',
      severity: 'warn',
      detail: 'customer used emojis, reply has none',
    });
  else out.push({ check: 'emoji', severity: 'pass' });

  const tu = count(BOT_TU, reply);
  const usted = count(BOT_USTED, reply);
  if (expected === 'tu' && usted > 0 && tu === 0)
    out.push({
      check: 'register',
      severity: 'fail',
      detail: 'usted to a tú customer',
    });
  else if (expected === 'usted' && tu > 0 && usted === 0)
    out.push({
      check: 'register',
      severity: 'fail',
      detail: 'tú to an usted customer',
    });
  else if (tu > 0 && usted > 0)
    out.push({
      check: 'register',
      severity: 'warn',
      detail: `mixed tú/usted (expected ${expected})`,
    });
  else out.push({ check: 'register', severity: 'pass' });

  const slang = reply.match(SLANG);
  out.push(
    slang === null
      ? { check: 'slang', severity: 'pass' }
      : {
          check: 'slang',
          severity: 'fail',
          detail: `slang/voseo: ${slang.join(', ')}`,
        },
  );

  const refused = reply.toLowerCase().includes(REFUSAL_PHRASE);
  if (refused && refusal === 'forbidden')
    out.push({
      check: 'refusal',
      severity: 'fail',
      detail: 'refusal phrase on a supported request',
    });
  else if (!refused && refusal === 'expected')
    out.push({
      check: 'refusal',
      severity: 'warn',
      detail: 'expected the literal refusal phrase',
    });
  else out.push({ check: 'refusal', severity: 'pass' });

  if (PERSONA_WRONG.test(reply))
    out.push({
      check: 'persona',
      severity: 'fail',
      detail: 'technology/retail persona',
    });
  else if (expectPersona && !PERSONA_PET.test(reply))
    out.push({
      check: 'persona',
      severity: 'fail',
      detail: 'does not present the pet store',
    });
  else out.push({ check: 'persona', severity: 'pass' });

  // F7: the cart is server-confirmed; an "intention" claim means no write.
  out.push(
    INTENT_CLAIM.test(reply)
      ? {
          check: 'cart-claim',
          severity: 'fail',
          detail: 'claims a registered intention instead of a cart change',
        }
      : { check: 'cart-claim', severity: 'pass' },
  );

  // F8: "varias opciones" must come with the options themselves.
  out.push(
    VAGUE_OPTIONS.test(reply) && !LIST_LINE.test(reply)
      ? {
          check: 'options',
          severity: 'warn',
          detail: 'mentions several options without listing them',
        }
      : { check: 'options', severity: 'pass' },
  );

  const lines = reply
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // A list attribute ("- **Marca:** Pet's Choice") may legitimately repeat
  // across products; only repeated sentences/paragraphs are duplicates.
  const repeated = lines.find(
    (line, i) => !ATTRIBUTE_LINE.test(line) && lines.indexOf(line) !== i,
  );
  out.push(
    repeated === undefined
      ? { check: 'duplicate-line', severity: 'pass' }
      : {
          check: 'duplicate-line',
          severity: 'fail',
          detail: `repeated line: ${repeated.slice(0, 60)}`,
        },
  );

  const leak = reply.match(LEAK);
  out.push(
    leak === null
      ? { check: 'leak', severity: 'pass' }
      : {
          check: 'leak',
          severity: 'fail',
          detail: `internal/operator text: ${leak[0]}`,
        },
  );
  return out;
}

export function checkOrders(
  expected: number | undefined,
  actual: number,
): CheckResult {
  if (expected === undefined) return { check: 'orders', severity: 'pass' };
  if (expected === actual) return { check: 'orders', severity: 'pass' };
  return {
    check: 'orders',
    severity: 'fail',
    detail:
      expected === 0
        ? `order created on decline/denied (${actual})`
        : `expected ${expected} order(s), got ${actual}`,
  };
}
