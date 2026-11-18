import {
  INTERACTIVE_FULFIL_DELIVERY_TEXT,
  INTERACTIVE_FULFIL_PICKUP_TEXT,
  fulfilmentChoiceButtons,
  interactiveReplyText,
  parseInteractiveReplyId,
} from './customer-reply';
import { isCheckoutStartRequest } from './minimal-checkout-start';

describe('isCheckoutStartRequest (retest S4, N15)', () => {
  it.each([
    'quiero comprar',
    'Quiero comprar.',
    'quiero comprar 🙌',
    'Quiero comprar',
    'Seguir con la compra',
    'sí, quiero comprar por favor',
    'ok quiero comprarlo',
    'lo quiero comprar',
    'quiero hacer mi pedido',
    'continuar con la compra',
  ])('«%s» starts checkout', (text) => {
    expect(isCheckoutStartRequest(text)).toBe(true);
  });

  it.each([
    'quiero comprar para recoger en tienda',
    'envíamelo a mi casa',
    'quiero comprar croquetas nupec',
    'quiero comprar, envío a domicilio',
    '¿puedo comprar en tienda?',
    'Envío a domicilio',
    'Recoger en tienda',
    'quiero pagar',
    'sí',
  ])('«%s» is not a bare checkout start', (text) => {
    expect(isCheckoutStartRequest(text)).toBe(false);
  });
});

describe('delivery-or-pickup buttons', () => {
  it('are bound to the cart reference and parse back to their mode', () => {
    const interactive = fulfilmentChoiceButtons('ref1', 'prompt');
    expect(interactive).toEqual({
      type: 'buttons',
      buttons: [
        { id: 'fulfil_delivery:ref1', title: 'Envío a domicilio' },
        { id: 'fulfil_pickup:ref1', title: 'Recoger en tienda' },
      ],
      prompt: 'prompt',
    });
    expect(parseInteractiveReplyId('fulfil_delivery:ref1')).toEqual({
      kind: 'fulfilment',
      mode: 'delivery',
      reference: 'ref1',
    });
    expect(parseInteractiveReplyId('fulfil_pickup:ref1')).toEqual({
      kind: 'fulfilment',
      mode: 'pickup',
      reference: 'ref1',
    });
    expect(interactiveReplyText('fulfil_pickup:ref1', 'x')).toBe(
      INTERACTIVE_FULFIL_PICKUP_TEXT,
    );
    expect(interactiveReplyText('fulfil_delivery:ref1', 'x')).toBe(
      INTERACTIVE_FULFIL_DELIVERY_TEXT,
    );
  });

  it('a bare id without the cart reference is not honoured', () => {
    expect(parseInteractiveReplyId('fulfil_pickup')).toBeNull();
    expect(parseInteractiveReplyId('fulfil_delivery:')).toBeNull();
  });
});
