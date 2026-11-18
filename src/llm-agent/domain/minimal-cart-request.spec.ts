import { groundCartQuantity } from './minimal-cart-quantity';
import {
  addRequestForm,
  conversationalAddForm,
  countOutsidePresentations,
  mentionsPhrase,
  nameCoverage,
  offersCartAdd,
  presentationMentions,
  presentationPickForm,
  statedUnitCount,
} from './minimal-cart-request';

describe('statedUnitCount', () => {
  it.each([
    ['Agrégame uno', 1],
    ['dame dos', 2],
    ['quiero 2', 2],
    ['sí pero cambia la cantidad a 2', 2],
    ['Agrégueme un par', 2],
    ['Deseo comprar una arena de sílice para gato.', 1],
    ['quiero 2 de la de 10 kg', 2],
  ])('"%s" → %d', (text, value) => {
    expect(statedUnitCount(text)).toEqual({ status: 'ok', value });
  });

  it.each([
    'Sí, agréguela por favor.',
    'la de 10kg',
    'Arena 3.8 L',
    'croquetas de 18 kg',
  ])('"%s" states no unit count', (text) => {
    expect(statedUnitCount(text)).toEqual({ status: 'none' });
  });

  it('a presentation number is not a count', () => {
    expect(statedUnitCount('quiero la de 20', new Set(['20']))).toEqual({
      status: 'none',
    });
  });

  it('several counts are ambiguous', () => {
    expect(statedUnitCount('agrega una y quita dos')).toEqual({
      status: 'ambiguous',
    });
  });
});

describe('addRequestForm', () => {
  it.each([
    ['agrégalo', 'singular'],
    ['Sí, agréguela por favor.', 'singular'],
    ['Agrégueme al carrito', 'singular'],
    ['me lo llevo', 'singular'],
    ['sí ese, agrégamelos porfa', 'plural'],
    ['agrega todos', 'singular'],
    ['los quiero', 'plural'],
  ])('"%s" → %s', (text, form) => {
    expect(addRequestForm(text)).toBe(form);
  });

  it.each(['no lo agregues', 'Prefiero recogerlo en tienda.', 'Sí.'])(
    '"%s" is not an add request',
    (text) => {
      expect(addRequestForm(text)).toBeNull();
    },
  );
});

describe('conversationalAddForm', () => {
  it('a bare affirmative answers a cart offer', () => {
    expect(conversationalAddForm('sí', '¿Se lo agrego al carrito?')).toBe(
      'singular',
    );
    expect(
      conversationalAddForm('claro 👍', '¿Desea que se las agregue?'),
    ).toBe('singular');
  });

  it('a bare affirmative to another question is not an add', () => {
    expect(conversationalAddForm('sí', '¿Buscaba esa presentación?')).toBe(
      null,
    );
    expect(conversationalAddForm('sí', 'Lo agregué al carrito.')).toBeNull();
  });

  it('offersCartAdd needs a question with an add verb', () => {
    expect(offersCartAdd('¿Te lo agrego al carrito?')).toBe(true);
    expect(offersCartAdd(null)).toBe(false);
  });
});

describe('name matching', () => {
  it('scores a product name by its significant words', () => {
    const reply =
      'Encontré Arena para Gato de Sílice 3.8 L en nuestro catálogo.';
    expect(nameCoverage(reply, 'Arena para Gato de Sílice 3.8 L')).toBe(1);
    expect(
      nameCoverage(reply, 'Arena para Gato Aglomerante Sin Aroma'),
    ).toBeLessThan(0.6);
  });

  it('matches a presentation label as a phrase', () => {
    expect(mentionsPhrase('la de 10kg porfa', '10 kg')).toBe(true);
    expect(mentionsPhrase('talla mediana', 'Mediana')).toBe(true);
    expect(mentionsPhrase('la de 20 kg', '10 kg')).toBe(false);
  });
});

describe('"un par" citation', () => {
  it('grounds two units, never the one of its article', () => {
    const base = {
      text: 'Agrégueme un par',
      productId: '11111111-1111-4111-8111-111111111111',
      operation: 'add' as const,
      quantityText: 'un par',
      continuation: false,
    };
    expect(groundCartQuantity({ ...base, quantity: 2 })).toEqual({
      kind: 'ready',
      intent: { productId: base.productId, operation: 'add', quantity: 2 },
    });
    expect(groundCartQuantity({ ...base, quantity: 1 }).kind).toBe(
      'invalid_evidence',
    );
  });
});

describe('presentationPickForm (retest S5, N14)', () => {
  const OPTIONS =
    'Croquetas Nupec: 2 kg $349.00, 8 kg $999.00, 20 kg $1899.00. ¿Cuál le gustaría llevar?';
  it.each([
    ['quiero el de 2 kg', '2 kg', null],
    ['quiero el de 2kg porfa', '2 kg', null],
    ['la de 7 piezas', '7 piezas', OPTIONS],
    ['el de 20 kg por favor', '20 kg', OPTIONS],
  ])('"%s" picks one unit of %s', (text, label, previous) => {
    expect(presentationPickForm(text, label, previous)).toBe('singular');
  });

  it.each([
    ['¿y el de 2 kg cuánto cuesta?', '2 kg', OPTIONS],
    ['no quiero el de 2 kg', '2 kg', OPTIONS],
    ['quiero los de 2 kg', '2 kg', OPTIONS],
    ['las de 7 piezas', '7 piezas', OPTIONS],
    ['la de 7 piezas', '7 piezas', 'Tiene 7 y 14 piezas.'],
    ['quiero el de 8 kg', '2 kg', OPTIONS],
  ])('"%s" is not a one-unit pick of %s', (text, label, previous) => {
    expect(presentationPickForm(text, label, previous)).toBeNull();
  });
});

describe('a presentation number is never the cited count (retest S5)', () => {
  it('«la de 7 piezas» citing "7" is rejected', () => {
    expect(
      groundCartQuantity({
        text: 'la de 7 piezas',
        productId: 'p',
        productName: 'Premios Dentales para Perro',
        variantName: 'Premios Dentales para Perro 7 piezas',
        operation: 'add',
        quantity: 7,
        quantityText: '7',
        continuation: false,
      }).kind,
    ).toBe('invalid_evidence');
  });

  it('«quiero 2 de 7 piezas» citing "2" adds two', () => {
    expect(
      groundCartQuantity({
        text: 'quiero 2 de 7 piezas',
        productId: 'p',
        productName: 'Premios Dentales para Perro',
        variantName: 'Premios Dentales para Perro 7 piezas',
        operation: 'add',
        quantity: 2,
        quantityText: '2',
        continuation: false,
      }),
    ).toEqual({
      kind: 'ready',
      intent: { productId: 'p', operation: 'add', quantity: 2 },
    });
  });
});

describe('presentationMentions (presentation pick grounding S2)', () => {
  const WHISKAS = ['Sobre 85 g', 'Caja 12 sobres'];
  const named = (text: string, labels: string[], short = true) =>
    presentationMentions(text, labels, short).map(({ index }) => labels[index]);

  it.each([
    ['quisiera whiskas, la caja de 12 sobres por favor.', 'Caja 12 sobres'],
    ['Quisiera la caja de 12 sobres de whiskas', 'Caja 12 sobres'],
    ['una CAJA de 12 SOBRES', 'Caja 12 sobres'],
    ['el sobre de 85 gramos', 'Sobre 85 g'],
    ['el sobre de 85 gr', 'Sobre 85 g'],
    ['la de 12', 'Caja 12 sobres'],
    ['el sobre', 'Sobre 85 g'],
    ['la caja', 'Caja 12 sobres'],
  ])('"%s" names %s', (text, label) => {
    expect(named(text, WHISKAS)).toEqual([label]);
  });

  it.each([
    ['la de 2 kilos', ['2 kg', '8 kg', '20 kg'], '2 kg'],
    ['el de 20 kilogramos', ['2 kg', '8 kg', '20 kg'], '20 kg'],
    ['la de 7 piezas', ['7 piezas', '14 piezas'], '7 piezas'],
    ['la de 7 pzas', ['7 piezas', '14 piezas'], '7 piezas'],
  ])('"%s" names one of %j', (text, labels, label) => {
    expect(named(text, labels)).toEqual([label]);
  });

  it('two presentations matching a short reference stay ambiguous', () => {
    expect(
      named('la de 12', ['Caja 12 sobres', 'Paquete 12 latas']),
    ).toHaveLength(2);
  });

  it.each(['quiero el de whiskas', 'quiero whiskas', 'quiero 12'])(
    '"%s" names no presentation',
    (text) => {
      expect(named(text, WHISKAS)).toEqual([]);
    },
  );

  it('short references only when asked (the bot listing uses full labels)', () => {
    expect(named('la de 12', WHISKAS, false)).toEqual([]);
  });
});

describe('countOutsidePresentations', () => {
  const WHISKAS = ['Sobre 85 g', 'Caja 12 sobres'];
  it.each([
    ['quiero 2 cajas de 12 sobres', WHISKAS, 2],
    ['dos cajas de 12 sobres', WHISKAS, 2],
    ['quiero 2 bolsas de 8 kg', ['2 kg', '8 kg'], 2],
    ['dos bolsas de 2 kg', ['2 kg', '8 kg'], 2],
  ])('"%s" → %d', (text, labels, value) => {
    expect(countOutsidePresentations(text, labels)).toEqual({
      status: 'ok',
      value,
    });
  });

  it.each([
    ['la de 12', WHISKAS],
    ['quisiera whiskas, la caja de 12 sobres por favor.', WHISKAS],
    ['el sobre de 85 gramos', WHISKAS],
    ['quiero 12 sobres', WHISKAS],
  ])('"%s" states no count', (text, labels) => {
    expect(countOutsidePresentations(text, labels)).toEqual({ status: 'none' });
  });
});

describe('presentationPickForm with natural wordings', () => {
  it.each([
    ['quisiera whiskas, la caja de 12 sobres por favor.', 'Caja 12 sobres'],
    ['quiero el sobre de 85 gramos', 'Sobre 85 g'],
    ['quiero la de 12', 'Caja 12 sobres'],
  ])('"%s" is a one-unit pick of %s', (text, label) => {
    expect(presentationPickForm(text, label, null)).toBe('singular');
  });

  it.each([
    ['quiero las cajas de 12 sobres', 'Caja 12 sobres'],
    ['quiero cajas de 12 sobres', 'Caja 12 sobres'],
    ['¿la caja de 12 sobres cuánto cuesta?', 'Caja 12 sobres'],
    ['no quiero la caja de 12 sobres', 'Caja 12 sobres'],
  ])('"%s" is not a one-unit pick', (text, label) => {
    expect(presentationPickForm(text, label, null)).toBeNull();
  });
});
