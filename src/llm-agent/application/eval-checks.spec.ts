import { checkReply } from '../../../scripts/eval/checks';

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
});
