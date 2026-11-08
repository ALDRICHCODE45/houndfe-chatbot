import {
  explicitPreferredName,
  isForgetMyDataRequest,
} from './customer-profile-signals';

describe('explicitPreferredName', () => {
  it.each([
    ['dime Pepe', 'Pepe'],
    ['Llámame Ana, por favor', 'Ana'],
    ['llamame ana', 'Ana'],
    ['Hola, me llamo Ana Luisa', 'Ana Luisa'],
    ['me llamo Ana y busco croquetas', 'Ana'],
    ['Mi nombre es Jorge.', 'Jorge'],
    ['Puedes decirme Toño', 'Toño'],
    ['Dígame Lupita por favor', 'Lupita'],
  ])('%p → %p', (text, name) => {
    expect(explicitPreferredName(text)).toBe(name);
  });

  it.each([
    'dime cuánto cuesta',
    'dime el precio',
    'dime si tienes croquetas',
    'dime qué tienes',
    'hola, busco croquetas para mi perro',
    'soy de Monterrey',
    'me llamo la atención ese collar',
    'dime',
  ])('ignores %p', (text) => {
    expect(explicitPreferredName(text)).toBeNull();
  });

  it('ignores the synthetic product-image block', () => {
    expect(
      explicitPreferredName(
        'tienen esto?\n[Imagen enviada por el cliente: dime Pepe]',
      ),
    ).toBeNull();
  });
});

describe('isForgetMyDataRequest', () => {
  it.each([
    'olvida mis datos',
    'Olvídate de mis datos por favor',
    'borra mis datos',
    'Quiero que borres mis datos',
    'eliminen mis datos personales',
    'BORRA MIS DATOS!!',
  ])('%p is a forget request', (text) => {
    expect(isForgetMyDataRequest(text)).toBe(true);
  });

  it.each([
    'borra mis datos de entrega',
    'cambia mis datos de envío',
    'mis datos están bien',
    'olvida el collar',
  ])('%p is not', (text) => {
    expect(isForgetMyDataRequest(text)).toBe(false);
  });
});
