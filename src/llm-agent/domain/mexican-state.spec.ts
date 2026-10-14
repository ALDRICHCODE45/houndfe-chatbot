import { MEXICAN_STATES, toMexicanState } from './mexican-state';

const CANONICAL = [
  'Aguascalientes',
  'Baja California',
  'Baja California Sur',
  'Campeche',
  'Chiapas',
  'Chihuahua',
  'Ciudad de México',
  'Coahuila',
  'Colima',
  'Durango',
  'Estado de México',
  'Guanajuato',
  'Guerrero',
  'Hidalgo',
  'Jalisco',
  'Michoacán',
  'Morelos',
  'Nayarit',
  'Nuevo León',
  'Oaxaca',
  'Puebla',
  'Querétaro',
  'Quintana Roo',
  'San Luis Potosí',
  'Sinaloa',
  'Sonora',
  'Tabasco',
  'Tamaulipas',
  'Tlaxcala',
  'Veracruz',
  'Yucatán',
  'Zacatecas',
];

describe('S4 deterministic Mexican states', () => {
  it('pins the backend exact 32 values', () =>
    expect(MEXICAN_STATES).toEqual(CANONICAL));
  it.each(CANONICAL)('maps canonical and normalized %s', (state) => {
    expect(toMexicanState(state)).toBe(state);
    expect(
      toMexicanState(
        `  ${state.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/ /g, '   ')}  `,
      ),
    ).toBe(state);
  });
  it.each([
    ['CDMX', 'Ciudad de México'],
    ['Ciudad de Mexico', 'Ciudad de México'],
    ['DF', 'Ciudad de México'],
    ['Distrito Federal', 'Ciudad de México'],
    ['Edomex', 'Estado de México'],
    ['Edo. Mex.', 'Estado de México'],
    ['Estado de Mexico', 'Estado de México'],
    ['Coahuila de Zaragoza', 'Coahuila'],
    ['Veracruz de Ignacio de la Llave', 'Veracruz'],
    ['Michoacán de Ocampo', 'Michoacán'],
  ])('maps alias %s', (text, state) =>
    expect(toMexicanState(text)).toBe(state),
  );
  it.each([
    '',
    'Mexico City',
    'Baja',
    'Nuevo',
    'Texas',
    'CDMX norte',
    'Queretar',
    'México (state)',
    'México',
    'Mexico',
  ])('rejects %s without guessing', (text) =>
    expect(toMexicanState(text)).toBeNull(),
  );
});
