import { statedPurchaseCount } from './backorder-quantity';

/** Restock backorder S14: what counts as «la que dijo al pedir». */
describe('statedPurchaseCount', () => {
  it.each([
    ['quiero 3 bolsas de croquetas', 3],
    ['me das 2 collares', 2],
    ['necesito cuatro latas', 4],
    ['quiero un par de collares', 2],
    ['quiero 2 croquetas de 18 kg', 2],
    ['dame 12', 12],
  ])('%j states %i units', (text, count) => {
    expect(statedPurchaseCount(text)).toBe(count);
  });

  it.each([
    [
      'one unit is the countless default («una» is mostly an article)',
      'quiero una bolsa de croquetas',
    ],
    ['no count', 'tienen croquetas?'],
    ['a measurement', 'busco croquetas de 18 kg'],
    ['a price', 'croquetas de 300 pesos'],
    ['an age', 'tengo un perro de 10 años'],
    ['several counts', 'quiero 2 o 3 bolsas'],
    ['not asking to buy', 'tengo 2 perros'],
    ['out of range', 'quiero 1500 bolsas'],
    ['empty', ''],
  ])('%s → none', (_label, text) => {
    expect(statedPurchaseCount(text)).toBeUndefined();
  });
});
