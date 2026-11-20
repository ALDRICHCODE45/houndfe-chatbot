import {
  backorderFolioIn,
  classifyBackorderRequest,
} from './backorder-requests';

describe('classifyBackorderRequest (restock backorder S8: cancel and status)', () => {
  describe('cancel with explicit backorder wording', () => {
    it.each([
      'cancela mi pedido por reposición',
      'Cancela lo que aparté',
      'ya no quiero lo que aparté',
      'quiero cancelar el pedido que agendé',
      'cancela el pedido BO-000012',
      'anula mi pedido apartado',
      'ya no quiero el pedido por reposición',
      'por favor cancela lo que me apartaron',
      '¿puedes cancelar lo que aparté?',
    ])('%s', (text) => {
      expect(classifyBackorderRequest(text)).toEqual({
        kind: 'cancel',
        explicit: true,
      });
    });
  });

  describe('cancel with generic wording (needs the caller to rule out other orders)', () => {
    it.each([
      'ya no quiero el pedido',
      'cancela mi pedido',
      'quiero cancelar mi pedido',
      'ya no quiero mi pedido',
    ])('%s', (text) => {
      expect(classifyBackorderRequest(text)).toEqual({
        kind: 'cancel',
        explicit: false,
      });
    });
  });

  describe('never a backorder cancel', () => {
    it.each([
      // Bare refusals belong to the confirmation gates.
      'cancela',
      'cancelar',
      'no',
      'ya no',
      // Cart removal and product talk.
      'quita las croquetas del carrito',
      'quita el pedido',
      'elimina el producto',
      'ya no quiero las croquetas',
      'ya no quiero ese producto',
      // Negated, a policy question, a previous order.
      'no quiero cancelar mi pedido',
      'no cancele mi pedido por reposición',
      '¿se puede cancelar mi pedido?',
      'cancela el pedido anterior',
      'cuánto cuesta cancelar',
      '',
    ])('%j', (text) => {
      expect(classifyBackorderRequest(text)).toBeNull();
    });

    it('a negation before a comma does not poison the next clause', () => {
      expect(
        classifyBackorderRequest('no, cancela mi pedido por reposición'),
      ).toEqual({ kind: 'cancel', explicit: true });
    });

    it('non-text and over-long input are never a request', () => {
      expect(classifyBackorderRequest(undefined)).toBeNull();
      expect(classifyBackorderRequest(42)).toBeNull();
      expect(
        classifyBackorderRequest(
          `cancela mi pedido por reposición ${'x '.repeat(100)}`,
        ),
      ).toBeNull();
    });
  });

  describe('status with explicit backorder wording', () => {
    it.each([
      '¿cómo va mi pedido por reposición?',
      '¿ya llegó lo que aparté?',
      '¿cuándo llega lo que aparté?',
      'ya llegó lo que agendé',
      '¿en qué va el pedido BO-000012?',
      '¿cómo va lo que me apartaron?',
      'estatus de mi pedido por reposición',
      'ver mi pedido por reposición',
      'muéstrame lo que aparté',
    ])('%s', (text) => {
      expect(classifyBackorderRequest(text)).toEqual({
        kind: 'status',
        explicit: true,
      });
    });
  });

  describe('status with generic wording', () => {
    it.each([
      '¿cómo va mi pedido?',
      '¿ya llegó mi pedido?',
      '¿cuándo llega mi pedido?',
    ])('%s', (text) => {
      expect(classifyBackorderRequest(text)).toEqual({
        kind: 'status',
        explicit: false,
      });
    });
  });

  describe('never a backorder status', () => {
    it.each([
      'ya llegó',
      '¿ya llegaron las croquetas?',
      '¿cuándo llega el envío?',
      '¿cómo pago?',
      'quiero ver mi pedido',
      'ver mi pedido',
      'muéstrame mi carrito',
      'mi resumen',
      '¿cómo va el carrito?',
      'apártame otro por reposición',
    ])('%s', (text) => {
      expect(classifyBackorderRequest(text)).toBeNull();
    });
  });
});

describe('backorderFolioIn', () => {
  it.each([
    ['cancela el BO-000012', 'BO-000012'],
    ['la bo 12', null],
    ['cancela bo000345 por favor', 'BO-000345'],
    ['el segundo', null],
  ])('%j → %j', (text, folio) => {
    expect(backorderFolioIn(text)).toBe(folio);
  });
});
