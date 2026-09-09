import { parseAmount } from './amount-parser';
describe('parseAmount', () => {
  it.each([
    ['$1,234.50', 123450],
    ['1,234.50', 123450],
    ['1234', 123400],
    ['1234.50', 123450],
    ['1234 pesos con 50 centavos', 123450],
    ['  1234 PESO CON 05 Centavo  ', 123405],
    ['1,234 PESOS CON 5 CENTAVOS', 123405],
  ])('parses exactly one bounded amount %j', (text, cents) => {
    expect(parseAmount(text)).toEqual({ kind: 'parsed', cents });
  });
  it.each([
    ['1234,50', 'none'],
    ['12,34.50', 'none'],
    ['12,34.50 y 1234', 'none'],
    ['1234,50 y 999', 'none'],
    ['-1234.50 y 999', 'none'],
    ['1234 pesos con 50 centavosx', 'none'],
    ['1234 pesos con 50 centavos2', 'none'],
    ['1234 pesos con 50 centavos,50', 'none'],
    ['ñ1234 pesos con 50 centavos', 'none'],
    ['abc1234', 'none'],
    ['1234abc', 'none'],
    ['1234.5', 'none'],
    ['1234.505', 'none'],
    ['0', 'none'],
    ['$0.00', 'none'],
    ['-1234.50', 'none'],
    ['99999999999999999999', 'none'],
    ['sin monto', 'none'],
    ['$1,234.50 y 999', 'multiple'],
    ['1234 pesos 50', 'multiple'],
    ['2 pesos con 5 centavos o 9', 'multiple'],
  ])('rejects %j with kind %s', (text, kind) => {
    expect(parseAmount(text)).toEqual({ kind });
  });
  it('is deterministic and integer-valued in cents', () => {
    expect(parseAmount('$1,234.50')).toEqual(parseAmount('$1,234.50'));
    expect(parseAmount('$1,234.50')).toMatchObject({ cents: 123450 });
  });
});
