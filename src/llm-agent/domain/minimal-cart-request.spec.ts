import { groundCartQuantity } from './minimal-cart-quantity';
import {
  addRequestForm,
  conversationalAddForm,
  mentionsPhrase,
  nameCoverage,
  offersCartAdd,
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
