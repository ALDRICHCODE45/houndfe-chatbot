import {
  interactiveReplyText,
  paymentMethodButtons,
  parseInteractiveReplyId,
} from './customer-reply';
import {
  matchPaymentMethod,
  PAYMENT_METHODS,
  paymentMethodsFor,
} from './payment-methods';

const SALE = '55555555-5555-4555-8555-555555555555';

describe('payment methods', () => {
  it('offers one button per listed method, bound to the sale', () => {
    expect(paymentMethodButtons(SALE, 'p')).toEqual({
      type: 'buttons',
      buttons: PAYMENT_METHODS.map((m) => ({
        id: `pay:${m.id}:${SALE}`,
        title: m.title,
      })),
      prompt: 'p',
    });
    expect(PAYMENT_METHODS.map((m) => m.title)).toEqual(['Transferencia']);
  });

  it('parses its own ids and rejects malformed or unknown ones', () => {
    expect(parseInteractiveReplyId(`pay:transfer:${SALE}`)).toEqual({
      kind: 'payment_method',
      method: 'transfer',
      reference: SALE,
    });
    for (const id of [
      'pay',
      'pay:transfer',
      'pay:transfer:',
      `pay::${SALE}`,
      `pay:unknown:${SALE}`,
    ])
      expect(parseInteractiveReplyId(id)).toBeNull();
    expect(interactiveReplyText(`pay:transfer:${SALE}`, 'Transferencia')).toBe(
      'Transferencia',
    );
  });

  it.each(['transferencia', 'Por transferencia', 'pagar con Transferencia!'])(
    'matches %p',
    (text) => expect(matchPaymentMethod(text)?.id).toBe('transfer'),
  );

  it.each(['sí', 'ya hice la transferencia', 'cuál es la clabe', 12])(
    'does not match %p',
    (text) => expect(matchPaymentMethod(text)).toBeNull(),
  );

  describe('pay in store (S3)', () => {
    const both = paymentMethodsFor({ payInStore: true });

    it('adds «Pagar en tienda» only when pay in store applies', () => {
      expect(paymentMethodsFor({ payInStore: false })).toEqual(PAYMENT_METHODS);
      expect(both.map((m) => [m.id, m.title])).toEqual([
        ['transfer', 'Transferencia'],
        ['in_store', 'Pagar en tienda'],
      ]);
      expect(paymentMethodButtons(SALE, 'p', both)).toEqual({
        type: 'buttons',
        buttons: [
          { id: `pay:transfer:${SALE}`, title: 'Transferencia' },
          { id: `pay:in_store:${SALE}`, title: 'Pagar en tienda' },
        ],
        prompt: 'p',
      });
    });

    it('parses the in-store button id', () => {
      expect(parseInteractiveReplyId(`pay:in_store:${SALE}`)).toEqual({
        kind: 'payment_method',
        method: 'in_store',
        reference: SALE,
      });
    });

    it.each([
      'en tienda',
      'Pagar en tienda',
      'pago en la tienda',
      'prefiero pagar en la tienda',
      'en la sucursal',
    ])('matches %p only among the offered methods', (text) => {
      expect(matchPaymentMethod(text, both)?.id).toBe('in_store');
      expect(matchPaymentMethod(text)).toBeNull();
    });

    it('transfer still matches with both offered', () =>
      expect(matchPaymentMethod('por transferencia', both)?.id).toBe(
        'transfer',
      ));
  });
});
