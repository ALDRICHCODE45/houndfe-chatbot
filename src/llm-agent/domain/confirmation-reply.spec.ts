import { classifyConfirmationReply } from './confirmation-reply';

/** Accent, case, emoji, punctuation and newline decorations of one reply. */
const variants = (text: string): string[] => [
  text,
  text.toUpperCase(),
  `  ${text}  `,
  `${text}!`,
  `¡${text}!`,
  `${text}.`,
  `${text}..`,
  `${text}...`,
  `${text}…`,
  `${text} 🙏`,
  `${text} 😊`,
  `${text} 👍🏽`,
  `${text}\n`,
  `\n${text}\r\n`,
];

describe('classifyConfirmationReply', () => {
  const accepts = [
    'si',
    'sí',
    'Sí',
    'sip',
    'sii',
    'siii',
    'simón',
    'claro',
    'claro que sí',
    'por supuesto',
    'va',
    'sale',
    'vale',
    'ok',
    'okay',
    'okey',
    'ok gracias',
    'dale',
    'de acuerdo',
    'correcto',
    'es correcto',
    'así es',
    'exacto',
    'confirmo',
    'confirmado',
    'adelante',
    'perfecto',
    'listo',
    'está bien',
    'sí, por favor',
    'si por favor',
    'Sí, por favor 🙏',
    'sí gracias',
    'sí, porfa',
    'sí, confirmo',
    'sí, está bien',
    'sí, correcto',
    'sí, adelante',
    'si si',
    'claro, gracias',
    'sí, muchas gracias',
    'okkk',
    'claroo',
  ];

  it.each(accepts)('accepts %j with every decoration', (text) => {
    for (const variant of variants(text)) {
      expect([variant, classifyConfirmationReply(variant)]).toEqual([
        variant,
        'accept',
      ]);
    }
  });

  const declines = [
    'no',
    'No',
    'noo',
    'no gracias',
    'no, gracias',
    'no, muchas gracias',
    'mejor no',
    'nel',
    'cancelar',
    'cancela',
    'no quiero',
    'ahorita no',
    'todavía no',
    'no por ahora',
    'por ahora no',
  ];

  it.each(declines)('declines %j with every decoration', (text) => {
    for (const variant of variants(text)) {
      // A thumbs-up decoration contradicts a refusal; covered below.
      if (variant.includes('👍')) continue;
      expect([variant, classifyConfirmationReply(variant)]).toEqual([
        variant,
        'decline',
      ]);
    }
  });

  it.each([
    ['👍', 'accept'],
    ['👍🏻', 'accept'],
    ['👍👍', 'accept'],
    ['✅', 'accept'],
    [' ✅ \n', 'accept'],
    ['👎', 'decline'],
    ['👎🏾', 'decline'],
  ] as const)('reads a lone emoji %j as %s', (text, verdict) => {
    expect(classifyConfirmationReply(text)).toBe(verdict);
  });

  it.each([
    // Corrections, conditions or extra content.
    'sí, pero quite uno',
    'si pero cambia la direccion',
    'sí y agrega otro',
    'Sí\nquite uno',
    'no, la dirección es otra',
    'no, mejor dos',
    'sí, 2 piezas',
    'claro pero sin envío',
    'ok y el envío?',
    // Questions.
    '¿sí incluye envío?',
    '¿sí?',
    'ok?',
    '¿Confirmado?',
    // Polite refusal stays ambiguous.
    'no, por favor',
    // Contradictions and unrelated emojis.
    'sí 👎',
    'no 👍',
    '👍👎',
    '🙏',
    '😊',
    '❤️',
    // Unrelated or hostile text.
    '',
    '   ',
    '\n',
    '.',
    '!!!',
    'hola',
    'gracias',
    'por favor',
    'sin',
    'sino',
    'nop nop nop nop',
    'si '.repeat(40),
    'quiero comprar',
    '<script>sí</script>',
  ])('returns null for %j', (text) => {
    expect(classifyConfirmationReply(text)).toBeNull();
  });

  it.each([undefined, null, 1, {}, ['sí']])(
    'returns null for non-string %p',
    (raw) => {
      expect(classifyConfirmationReply(raw)).toBeNull();
    },
  );
});
