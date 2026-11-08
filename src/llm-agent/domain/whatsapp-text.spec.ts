import { toWhatsAppText } from './whatsapp-text';

describe('toWhatsAppText', () => {
  it.each<[string, string, string]>([
    [
      'double-asterisk bold',
      'Le recomiendo **Pro Plan**.',
      'Le recomiendo *Pro Plan*.',
    ],
    ['double-underscore bold', 'Precio: __$649.00__', 'Precio: *$649.00*'],
    ['keeps WhatsApp bold', 'Es *muy* rico', 'Es *muy* rico'],
    ['keeps snake_case and __ inside words', 'ref a__b__c', 'ref a__b__c'],
    [
      'removes an inline image',
      'Mire ![Imagen](https://cdn.example.test/p/1.jpg) aquí',
      'Mire aquí',
    ],
    [
      'drops a line left empty by an image',
      'Croquetas\n![Imagen](https://cdn.example.test/p/1.jpg)\nPrecio: $649.00',
      'Croquetas\nPrecio: $649.00',
    ],
    [
      'drops a bullet that only held an image',
      'Croquetas\n- ![foto](https://cdn.example.test/p/1.jpg)\nFin',
      'Croquetas\nFin',
    ],
    [
      'link becomes its label',
      'Vea [nuestro catálogo](https://houndfe.example/catalogo).',
      'Vea nuestro catálogo.',
    ],
    [
      'an image link to the catalog host disappears',
      'Precio: $649.00\n[Imagen](https://cdn.example.test/products/a.jpg)',
      'Precio: $649.00',
    ],
    [
      'keeps a bare https link when the label is the url',
      'Rastreo: [https://track.example/1](https://track.example/1)',
      'Rastreo: https://track.example/1',
    ],
    [
      'drops a bare image url labelled with itself',
      'Foto: [https://cdn.example.test/p/1.png](https://cdn.example.test/p/1.png)',
      'Foto:',
    ],
    ['strips heading hashes', '## Opciones\nA', 'Opciones\nA'],
    ['collapses 3+ blank lines', 'A\n\n\n\nB', 'A\n\nB'],
    ['normalizes dash bullets', '- uno\n- dos', '• uno\n• dos'],
    ['normalizes asterisk and plus bullets', '* uno\n+ dos', '• uno\n• dos'],
    ['normalizes "1)" lists to "1."', '1) uno\n2) dos', '1. uno\n2. dos'],
    [
      'trims nested indentation to two spaces',
      '1. Pro Plan\n   - Precio: $649.00\n      - Marca: Purina',
      '1. Pro Plan\n  • Precio: $649.00\n  • Marca: Purina',
    ],
    [
      'drops Markdown hard-break trailing spaces',
      '- **Pro Plan 3 kg**  \n  Precio: $649.00  ',
      '• *Pro Plan 3 kg*\n  Precio: $649.00',
    ],
    [
      'leaves plain text untouched',
      'Folio A-12 · CLABE 012345678901234567 · Total $1,299.00',
      'Folio A-12 · CLABE 012345678901234567 · Total $1,299.00',
    ],
  ])('%s', (_name, input, expected) => {
    expect(toWhatsAppText(input)).toBe(expected);
  });

  it('formats the live-eval product list', () => {
    const input = [
      'Encontré varias opciones de croquetas Pro Plan:',
      '',
      '- **Croquetas Pro Plan Adulto Raza Mediana 3 kg**  ',
      '  Precio: $649.00  ',
      '  [Imagen](https://cdn.example.test/products/a0000000-0000-4000-8000-000000000002.jpg)',
      '',
      '- **Croquetas Pro Plan Adulto Raza Mediana 7.5 kg**  ',
      '  Precio: $1,299.00  ',
      '  ![Imagen](https://cdn.example.test/products/a0000000-0000-4000-8000-000000000002.jpg)',
      '',
      '',
      '',
      '¿Le gustaría alguna de estas presentaciones?',
    ].join('\n');
    expect(toWhatsAppText(input)).toBe(
      [
        'Encontré varias opciones de croquetas Pro Plan:',
        '',
        '• *Croquetas Pro Plan Adulto Raza Mediana 3 kg*',
        '  Precio: $649.00',
        '',
        '• *Croquetas Pro Plan Adulto Raza Mediana 7.5 kg*',
        '  Precio: $1,299.00',
        '',
        '¿Le gustaría alguna de estas presentaciones?',
      ].join('\n'),
    );
  });
});
