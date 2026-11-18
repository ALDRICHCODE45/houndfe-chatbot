import {
  isOrderSummaryRequest,
  isPayRemainderRequest,
  isPaymentQuestion,
} from './minimal-order-requests';

describe('isPayRemainderRequest (retest S3)', () => {
  it.each([
    'me faltó pagar el resto',
    'Me faltó pagar el resto',
    '¿cómo pago lo que falta?',
    'necesito transferir la diferencia',
    'quiero hacer otro pago',
    'voy a hacer otra transferencia',
    'me falta por pagar',
    'te debo el restante',
    'tengo que depositar más',
  ])('recognises %j', (text) => {
    expect(isPayRemainderRequest(text)).toBe(true);
  });

  it.each([
    '¿A qué cuenta le transfiero?',
    'Transferencia',
    'quiero pagar por transferencia',
    'ya pagué',
    'me faltó una croqueta',
    'gracias',
    undefined,
  ])('ignores %j', (text) => {
    expect(isPayRemainderRequest(text)).toBe(false);
  });
});

describe('isOrderSummaryRequest (S5)', () => {
  it.each([
    'Muéstrame el resumen de mi pedido',
    'muestrame el resumen de mi pedido por favor',
    'mi resumen',
    'Mi resumen?',
    'ver mi pedido',
    'Quiero ver mi pedido',
    'resumen de mi compra',
    'Enséñame mi pedido',
    'ver el pedido',
  ])('treats %j as a request for the current order summary', (text) => {
    expect(isOrderSummaryRequest(text)).toBe(true);
  });

  it.each([
    'mi pedido anterior',
    'Quiero lo mismo que la vez pasada',
    'lo mismo de la última vez',
    '¿qué pedí la última vez?',
    'repetir mi último pedido',
    'muéstrame el resumen de mi pedido anterior',
    'ver mi último pedido',
    'lo de siempre',
    'Quiero revisar mi compra',
    'Muéstrame mi carrito',
    '¿me puedes revisar mi pedido?',
    'Hola, buenas tardes',
    'quiero croquetas',
    'cuánto cuesta el resumen de vitaminas para perro con muchas palabras extra que no vienen al caso y siguen y siguen y siguen',
  ])('does not treat %j as a current-summary request', (text) => {
    expect(isOrderSummaryRequest(text)).toBe(false);
  });
});

describe('isPaymentQuestion (S6)', () => {
  it.each([
    '¿Cómo pago?',
    'como puedo pagar',
    'a qué cuenta transfiero',
    'me pasa la CLABE',
    'los datos de pago por favor',
    'dame el número de cuenta',
    'formas de pago',
    'Transferencia',
    'quiero pagar por transferencia',
  ])('recognises %j', (text) => {
    expect(isPaymentQuestion(text)).toBe(true);
  });

  it.each(['quiero croquetas', 'ver mi pedido', 'gracias', 'sí'])(
    'ignores %j',
    (text) => {
      expect(isPaymentQuestion(text)).toBe(false);
    },
  );
});

describe('isOrderSummaryRequest scope', () => {
  it('ignores a product-related "resumen" that is not about the order', () => {
    expect(isOrderSummaryRequest('dame un resumen de las vitaminas')).toBe(
      false,
    );
  });
});
