import {
  DEFAULT_CUSTOMER_STYLE,
  applyCustomerStyle,
  customerStyleDirective,
  detectCustomerStyle,
  explicitStyleSignal,
  limitCustomerEmojis,
  type CustomerStyle,
} from './customer-style';

const style = (over: Partial<CustomerStyle> = {}): CustomerStyle => ({
  ...DEFAULT_CUSTOMER_STYLE,
  ...over,
});

describe('detectCustomerStyle', () => {
  it('defaults to usted, no emojis and a neutral tone', () => {
    expect(detectCustomerStyle([])).toEqual({
      register: 'usted',
      emojis: false,
      tone: 'neutral',
    });
    expect(DEFAULT_CUSTOMER_STYLE).toEqual(detectCustomerStyle([]));
  });

  describe('register', () => {
    it.each<[string, string[], CustomerStyle['register']]>([
      ['a bare question is neutral', ['¿cuánto cuesta?'], 'usted'],
      ['a bare greeting is neutral', ['hola'], 'usted'],
      ['tienes', ['¿tienes croquetas para cachorro?'], 'tu'],
      ['puedes', ['¿me puedes decir el precio?'], 'tu'],
      ['quieres', ['¿quieres que te mande la foto?'], 'tu'],
      ['me mandas', ['¿me mandas el catálogo?'], 'tu'],
      ['agrégamelos', ['sí ese, agrégamelos porfa'], 'tu'],
      ['agrégame', ['Agrégame uno'], 'tu'],
      ['agrega', ['agrega otra'], 'tu'],
      ['mándame', ['mándame el precio'], 'tu'],
      [
        'a bare -ar verb stays neutral',
        ['¿cambia el precio con envío?'],
        'usted',
      ],
      ['usted enclitic stays usted', ['agrégueme uno, por favor'], 'usted'],
      ['oye', ['oye, una pregunta'], 'tu'],
      ['tú', ['y tú qué me recomiendas'], 'tu'],
      ['te', ['te pregunto algo'], 'tu'],
      ['tu possessive', ['¿a qué hora abre tu tienda?'], 'tu'],
      ['usted', ['¿usted tiene arena para gato?'], 'usted'],
      ['me puede', ['¿me puede decir el precio?'], 'usted'],
      ['le agradecería', ['le agradecería la información'], 'usted'],
      ['disculpe', ['disculpe, ¿tienen correas?'], 'usted'],
      [
        'an usted marker wins inside the same message',
        ['oye, ¿usted tiene correas?'],
        'usted',
      ],
      [
        'the latest explicit tú signal wins',
        ['¿me puede ayudar?', 'gracias', '¿tienes el de 15 kg?'],
        'tu',
      ],
      [
        'the latest explicit usted signal wins',
        ['¿tienes croquetas?', '¿me puede dar el precio?'],
        'usted',
      ],
      [
        'neutral turns keep the last explicit signal',
        ['¿tienes croquetas?', 'ok', 'la de 2 kg'],
        'tu',
      ],
      [
        'a product photo block never decides the register',
        [
          '¿Tienen este producto?\n[Imagen enviada por el cliente: croquetas. Si no hay coincidencia exacta, ofrezca productos similares; pida una foto de la etiqueta.]',
        ],
        'usted',
      ],
    ])('%s', (_name, texts, register) => {
      expect(detectCustomerStyle(texts).register).toBe(register);
    });

    // F4: present-tense tú verbs from a curated list, never an -as/-es suffix.
    it.each<[string, CustomerStyle['register']]>([
      ['ok y cuál me recomiendas? 🐱', 'tu'],
      ['¿qué me recomiendas para un cachorro?', 'tu'],
      ['¿me das el precio?', 'tu'],
      ['¿cuánto me cobras el envío?', 'tu'],
      ['¿sabes si llega mañana?', 'tu'],
      ['¿me mandas la foto?', 'tu'],
      ['¿qué me sugieres?', 'tu'],
      ['¿cuál prefieres tú para gato?', 'tu'],
      ['¿lo haces a domicilio?', 'tu'],
      ['¿conoces la marca Nupec?', 'tu'],
      ['¿me ayudas con un pedido?', 'tu'],
      ['quiero más croquetas', 'usted'],
      ['¿el tanque de gas?', 'usted'],
      ['un atlas de razas', 'usted'],
      ['ya compré tres veces', 'usted'],
      ['hace dos meses', 'usted'],
      ['las entregas son en la tarde?', 'usted'],
      ['¿tienen croquetas de 15 kg?', 'usted'],
    ])('%s → %s', (text, register) => {
      expect(detectCustomerStyle([text]).register).toBe(register);
    });
  });

  describe('emojis', () => {
    it.each<[string, string[], boolean]>([
      ['none', ['hola', '¿tienen correas?'], false],
      ['in the latest message', ['hola 😊'], true],
      ['skin-tone and ZWJ sequences', ['va 👍🏽'], true],
      [
        'only one of the last three, not the latest',
        ['hola 🐶', 'ok', 'la de 2 kg'],
        false,
      ],
      [
        'eval buy-new-customer: one of three, latest bare "ok"',
        ['a domicilio porfa', 'Sí, por favor 🙏', 'ok'],
        false,
      ],
      [
        'two of the last three, latest without',
        ['hola 🐶', 'sí 👍', 'la de 2 kg'],
        true,
      ],
      ['latest only', ['hola', 'ok', 'va 👍'], true],
      [
        'two emojis older than the last three messages',
        ['hola 🐶', 'sí 👍', 'ok', 'la de 2 kg', 'gracias'],
        false,
      ],
    ])('%s', (_name, texts, emojis) => {
      expect(detectCustomerStyle(texts).emojis).toBe(emojis);
    });
  });

  describe('limitCustomerEmojis agrees with the detected style', () => {
    it.each<[string, string[], string, string]>([
      [
        'strips a 🐾 when the latest message has none',
        ['a domicilio porfa', 'Sí, por favor 🙏', 'ok'],
        '¡Perfecto! Espero tu comprobante. 🐾',
        '¡Perfecto! Espero tu comprobante.',
      ],
      [
        'keeps model emojis when the latest message has one',
        ['ok', 'va 👍'],
        '¡Listo! 🐾',
        '¡Listo! 🐾',
      ],
      [
        'keeps model emojis when two of the last three have one',
        ['hola 🐶', 'sí 👍', 'la de 2 kg'],
        '¡Listo! 🐾',
        '¡Listo! 🐾',
      ],
    ])('%s', (_name, texts, text, expected) => {
      expect(limitCustomerEmojis(text, detectCustomerStyle(texts))).toBe(
        expected,
      );
    });
  });

  describe('tone', () => {
    it.each<[string, string[], CustomerStyle['tone']]>([
      ['neutral', ['¿tienen arena para gato?'], 'neutral'],
      ['buenos días', ['Buenos días, ¿tienen arena para gato?'], 'formal'],
      ['buenas tardes', ['Buenas tardes'], 'formal'],
      ['le agradecería', ['Le agradecería el precio'], 'formal'],
      ['favor de', ['favor de enviarme el precio'], 'formal'],
      ['slang', ['jajaja va'], 'casual'],
      ['porfa', ['mándame el precio porfa'], 'casual'],
      ['emoji', ['¿tienen correas? 🐶'], 'casual'],
      ['exclamations', ['¡¡qué bien!!'], 'casual'],
      [
        'the latest non-neutral message wins',
        ['Buenos días', 'jaja ok'],
        'casual',
      ],
      [
        'a later neutral message keeps the earlier tone',
        ['Buenos días', 'la de 2 kg'],
        'formal',
      ],
    ])('%s', (_name, texts, tone) => {
      expect(detectCustomerStyle(texts).tone).toBe(tone);
    });
  });
});

describe('customerStyleDirective', () => {
  it('mirrors a tú, emoji, casual customer', () => {
    const directive = customerStyleDirective(
      style({ register: 'tu', emojis: true, tone: 'casual' }),
    );
    expect(directive).toContain(
      'Estilo del cliente: tutea, usa emojis, tono casual.',
    );
    expect(directive).toContain('Responde de tú');
    expect(directive).toContain('1 emoji natural como máximo por mensaje');
    expect(directive).toContain('tono cercano');
    expect(directive).not.toContain('Responde de usted');
  });

  it('keeps a serious usted customer sober and without emojis', () => {
    const directive = customerStyleDirective(
      style({ register: 'usted', emojis: false, tone: 'formal' }),
    );
    expect(directive).toContain(
      'Estilo del cliente: de usted, sin emojis, tono formal.',
    );
    expect(directive).toContain('Responde de usted');
    expect(directive).toContain('sin emojis');
    expect(directive).toContain('tono profesional y sobrio');
    expect(directive).not.toContain('Responde de tú');
  });
});

describe('applyCustomerStyle', () => {
  const USTED_MARKERS = /\b(usted|su|sus|le|suyo|desea|envíe|puede|dígame)\b/i;

  it('keeps usted copy byte-identical when the customer writes usted', () => {
    const text =
      'Su pedido quedó registrado. Cuando haga la transferencia, envíe aquí la foto de su comprobante.';
    expect(applyCustomerStyle(text, style({ emojis: true }))).toBe(text);
  });

  it('converts usted copy to consistent tú grammar', () => {
    const tu = applyCustomerStyle(
      'Su pedido quedó registrado.\n\nCuando haga la transferencia, envíe aquí la foto de su comprobante.',
      style({ register: 'tu' }),
    );
    expect(tu).toBe(
      'Tu pedido quedó registrado.\n\nCuando hagas la transferencia, envía aquí la foto de tu comprobante.',
    );
    expect(tu).not.toMatch(USTED_MARKERS);
  });

  it.each([
    [
      'Le comparto la respuesta del equipo:',
      'Te comparto la respuesta del equipo:',
    ],
    [
      'El equipo cerró su consulta. Si necesita algo más, escríbame por aquí.',
      'El equipo cerró tu consulta. Si necesitas algo más, escríbeme por aquí.',
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
    [
      'Todavía no tengo respuesta del equipo; sigue pendiente y le aviso en cuanto la tenga.',
      'Todavía no tengo respuesta del equipo; sigue pendiente y te aviso en cuanto la tenga.',
    ],
    // Live conversation (unit 11) notices, S5.
    [
      'Le atiende Ana del equipo HoundFe.',
      'Te atiende Ana del equipo HoundFe.',
    ],
    [
      'Le atiende una persona del equipo HoundFe.',
      'Te atiende una persona del equipo HoundFe.',
    ],
    [
      'Ahora le atiende Luis, del equipo HoundFe.',
      'Ahora te atiende Luis, del equipo HoundFe.',
    ],
    [
      'Ahora le atiende otra persona del equipo HoundFe.',
      'Ahora te atiende otra persona del equipo HoundFe.',
    ],
    [
      'Listo, terminó la atención con el equipo. Si necesita algo más, aquí sigo para ayudarle.',
      'Listo, terminó la atención con el equipo. Si necesitas algo más, aquí sigo para ayudarte.',
    ],
    [
      'Seguimos por aquí, ¿en qué le ayudo?',
      'Seguimos por aquí, ¿en qué te ayudo?',
    ],
    // Talk-to-human flow (S5/S6).
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
  ])('converts the human-request copy %j to tú', (usted, tu) => {
    expect(applyCustomerStyle(usted, style({ register: 'tu' }))).toBe(tu);
    expect(applyCustomerStyle(usted, style())).toBe(usted);
  });

  it('never rewrites amounts, folios or interpolated data', () => {
    const tu = applyCustomerStyle(
      'Su pedido quedó registrado con folio A-12. Total a pagar: $1,250.00 MXN.\nCLABE: 012345678901234567',
      style({ register: 'tu' }),
    );
    expect(tu).toBe(
      'Tu pedido quedó registrado con folio A-12. Total a pagar: $1,250.00 MXN.\nCLABE: 012345678901234567',
    );
  });

  it('strips emojis when the customer uses none', () => {
    expect(
      applyCustomerStyle(
        '¡Listo! 😊 Ya quedó registrada su consulta. ¡Gracias!',
        style(),
      ),
    ).toBe('¡Listo! Ya quedó registrada su consulta. ¡Gracias!');
    expect(
      applyCustomerStyle(
        'Por ahora no tenemos «Collar» 😕. ¿Quiere que consulte?',
        style(),
      ),
    ).toBe('Por ahora no tenemos «Collar». ¿Quiere que consulte?');
    expect(applyCustomerStyle('😊 Hola 👍🏽', style())).toBe('Hola');
  });

  it('keeps at most one existing emoji and never adds one', () => {
    expect(
      applyCustomerStyle('¡Hola! 😊✨ Claro 🐶', style({ emojis: true })),
    ).toBe('¡Hola! 😊 Claro');
    expect(
      applyCustomerStyle('Su carrito está vacío.', style({ emojis: true })),
    ).toBe('Su carrito está vacío.');
  });

  it('keeps the refusal literal byte-identical in every style', () => {
    const refusal = 'esa función aún no está disponible';
    for (const register of ['usted', 'tu'] as const) {
      for (const emojis of [true, false]) {
        expect(applyCustomerStyle(refusal, style({ register, emojis }))).toBe(
          refusal,
        );
      }
    }
  });
});

describe('S1 stored style seed', () => {
  const seed: CustomerStyle = { register: 'tu', emojis: true, tone: 'casual' };

  it('a fresh session starts with the stored register and tone', () => {
    expect(detectCustomerStyle(['hola'], seed)).toEqual({
      register: 'tu',
      // Emojis always follow this session's own messages (S5).
      emojis: false,
      tone: 'casual',
    });
  });

  it('the current explicit signal wins over the seed', () => {
    expect(
      detectCustomerStyle(['Buenas tardes, ¿usted me puede ayudar?'], seed),
    ).toMatchObject({ register: 'usted', tone: 'formal' });
  });

  it('without a seed nothing changes', () => {
    expect(detectCustomerStyle(['hola'])).toEqual(DEFAULT_CUSTOMER_STYLE);
  });
});

describe('explicitStyleSignal', () => {
  it('reports only explicit register and tone signals', () => {
    expect(explicitStyleSignal('hola')).toEqual({});
    expect(explicitStyleSignal('oye, ¿tienes croquetas? jaja')).toEqual({
      register: 'tu',
      tone: 'casual',
    });
    expect(explicitStyleSignal('Disculpe, ¿usted tiene arena?')).toEqual({
      register: 'usted',
      tone: 'formal',
    });
  });

  it('ignores the synthetic product-image block', () => {
    expect(
      explicitStyleSignal(
        'esto\n[Imagen enviada por el cliente: tienes usted]',
      ),
    ).toEqual({});
  });
});
