import { checkExpectedReply, checkReply } from '../../../scripts/eval/checks';
import { SCENARIOS, type ScenarioTurn } from '../../../scripts/eval/scenarios';

/** The eval's duplicate-line heuristic (scripts/eval/checks.ts). */
const duplicate = (reply: string) =>
  checkReply({
    customerText: 'Buen día, ¿qué arenas tienen?',
    reply,
    expected: 'usted',
    refusal: 'forbidden',
    expectPersona: false,
  }).find((result) => result.check === 'duplicate-line');

describe('eval duplicate-line check', () => {
  it('ignores a short attribute line repeated across a product list', () => {
    const reply = [
      '1. **Arena para Gato de Sílice 3.8 L**',
      "   - **Marca:** Pet's Choice",
      '   - **Precio:** $179.00',
      '2. **Arena para Gato Aglomerante Sin Aroma**',
      "   - **Marca:** Pet's Choice",
      '   - **Precio:** $219.00',
    ].join('\n');
    expect(duplicate(reply)?.severity).toBe('pass');
  });

  it('ignores a repeated label-only line', () => {
    const reply = [
      'Pro Plan Adulto',
      'Variantes:',
      '• 3 kg — $649.00',
      'Dog Chow Adulto',
      'Variantes:',
      '• 4 kg — $389.00',
    ].join('\n');
    expect(duplicate(reply)?.severity).toBe('pass');
  });

  it('ignores repeated image-markdown lines', () => {
    const image = '![Imagen](https://cdn.example.test/products/a.jpg)';
    const link = '[Imagen](https://cdn.example.test/products/a.jpg)';
    const reply = ['A', image, link, 'B', image, link].join('\n');
    expect(duplicate(reply)?.severity).toBe('pass');
  });

  it('still flags a long repeated line ending with a colon', () => {
    const line = 'Estas son las presentaciones que encontré en catálogo:';
    expect(duplicate(`${line}\nA\n${line}`)?.severity).toBe('fail');
  });

  it('still flags a repeated full sentence', () => {
    const sentence =
      'Le agregué 1 unidad; si desea otra cantidad, dígame cuántas.';
    expect(duplicate(`${sentence}\n\nTu carrito:\n${sentence}`)).toMatchObject({
      severity: 'fail',
    });
  });
});

describe('eval emoji check (same rule as limitCustomerEmojis)', () => {
  const emoji = (recentCustomerTexts: string[], reply: string) =>
    checkReply({
      customerText: recentCustomerTexts.at(-1) ?? '',
      recentCustomerTexts,
      reply,
      expected: 'tu',
      refusal: 'forbidden',
      expectPersona: false,
    }).find((result) => result.check === 'emoji');

  it.each<[string, string[], string, 'pass' | 'warn' | 'fail']>([
    [
      'fails a 🐾 after one emoji two messages back',
      ['a domicilio porfa', 'Sí, por favor 🙏', 'ok'],
      'Espero tu comprobante. 🐾',
      'fail',
    ],
    [
      'passes an emoji when two of the last three had one',
      ['hola 🐶', 'sí 👍', 'la de 2 kg'],
      'Listo 🐾',
      'pass',
    ],
    [
      'passes an emoji when the latest message has one',
      ['ok', 'va 👍'],
      'Listo 🐾',
      'pass',
    ],
    [
      'warns when the latest message has an emoji and the reply none',
      ['ok', 'va 👍'],
      'Listo',
      'warn',
    ],
    [
      'passes no emoji when emojis are not allowed',
      ['hola 🐶', 'ok', 'la de 2 kg'],
      'Listo',
      'pass',
    ],
  ])('%s', (_name, texts, reply, severity) => {
    expect(emoji(texts, reply)?.severity).toBe(severity);
  });

  // Message formatting F3b-fix H1: the S3 title emojis go to every customer.
  const noEmojiCustomer = ['hola', 'ok', 'la de 2 kg'];
  it.each<[string, string, 'pass' | 'fail']>([
    [
      'passes a 🧾 closing a *Title* line for a customer without emojis',
      '*Resumen de tu pedido* 🧾\n\n*Productos*\n• Arena — 3.8 L',
      'pass',
    ],
    [
      'passes a 🚚 closing a *Title* line for a customer without emojis',
      '*Envío a domicilio* 🚚\nDHL Express — *$120.00*',
      'pass',
    ],
    [
      'passes a ✅ closing a *Title* line for a customer without emojis',
      '*¡Pedido registrado!* ✅\n*Folio:* A-12',
      'pass',
    ],
    [
      'fails another emoji closing a *Title* line',
      '*Listo* 🐾\nTe aviso.',
      'fail',
    ],
    [
      'fails a title emoji that does not close a *Title* line',
      'Listo, pedido registrado ✅',
      'fail',
    ],
    [
      'fails a body emoji next to a kept title emoji',
      '*¡Pedido registrado!* ✅\nGracias 🐾',
      'fail',
    ],
  ])('%s', (_name, reply, severity) => {
    expect(emoji(noEmojiCustomer, reply)?.severity).toBe(severity);
  });
});

describe('eval register check (T7: a pet\u2019s «su/sus» is not usted)', () => {
  const register = (reply: string, expected: 'tu' | 'usted' = 'tu') =>
    checkReply({
      customerText: 'Y Bruno ya no está, falleció la semana pasada',
      reply,
      expected,
      refusal: 'forbidden',
      expectPersona: false,
    }).find((result) => result.check === 'register');

  it.each([
    [
      'live eval: «sus datos» of the pet in a tú reply passes',
      'Lamento mucho lo de Bruno, te acompaño en este momento. Ya dejé de recordar sus datos. Aquí estoy para lo que necesites con Max o cualquier otra cosa.',
      'pass',
    ],
    [
      '«su alimento» of the pet in a tú reply passes',
      'Para Max te recomiendo cuidar su alimento.',
      'pass',
    ],
    [
      'a real usted marker next to tú is still mixed',
      '¿Le agrego una bolsa a tu carrito?',
      'warn',
    ],
    [
      'only usted markers (su included) to a tú customer still fails',
      'Con gusto, ¿qué busca para su perro?',
      'fail',
    ],
  ])('%s', (_name, reply, severity) => {
    expect(register(reply)?.severity).toBe(severity);
  });
});

describe('eval scenario expectations (T7 live eval)', () => {
  const scenario = (id: string) => {
    const found = SCENARIOS.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(id);
    return found.turns.map(
      (raw): ScenarioTurn => (typeof raw === 'string' ? { text: raw } : raw),
    );
  };

  it.each([
    ['¡Hola! ¿Qué producto o información estás buscando?', true],
    ['¡Hola! ¿Qué quieres para Luna?', true],
    ['Hola, ¿buscas algo en especial?', true],
    ['Hola, ¿qué necesitas hoy?', true],
    ['¡Hola, Mariana!', true],
    ['¡Hola! ¿Qué producto está buscando?', false],
    ['Buenas tardes, ¿en qué le ayudo?', false],
  ])(
    'returning-customer after the restart: %j matches the tú expectation → %s',
    (reply, matches) => {
      const turn = scenario('returning-customer').find(
        (candidate) => candidate.restartBefore === true,
      );
      expect(checkExpectedReply(reply, turn?.expectReply)).toHaveLength(
        matches ? 0 : 1,
      );
    },
  );

  it('pets-which-pet: the «(para Max)» check is on the «sí, agrégala» turn, after the add question', () => {
    const turns = scenario('pets-which-pet');
    expect(turns.map((turn) => turn.text)).toEqual([
      'Hola, busco croquetas para mi perro',
      'para Max',
      'Quiero una bolsa de las croquetas de salmón y camote de 18 kg',
      'sí, agrégala',
    ]);
    expect(turns[2].requireReply).toBeUndefined();
    expect(String(turns[3].requireReply)).toBe(String(/\(para Max\)/));
  });
});
