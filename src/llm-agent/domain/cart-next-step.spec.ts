import {
  cartNextStepButtons,
  interactiveReplyText,
  parseInteractiveReplyId,
} from './customer-reply';
import { applyCustomerStyle, DEFAULT_CUSTOMER_STYLE } from './customer-style';

/**
 * S2 (N1): the cart summary invites the customer to continue. Two reply
 * buttons, both bound to the cart they were sent with.
 */
describe('cart next-step buttons (S2)', () => {
  it('has exactly the two owner-approved buttons, bound to the cart reference', () => {
    expect(cartNextStepButtons('abc123', '¿Seguimos?')).toEqual({
      type: 'buttons',
      buttons: [
        { id: 'cart_continue:abc123', title: 'Seguir con la compra' },
        { id: 'cart_add:abc123', title: 'Agregar algo más' },
      ],
      prompt: '¿Seguimos?',
    });
  });

  it('keeps every title within the Meta limit and unchanged in tú', () => {
    const tu = { ...DEFAULT_CUSTOMER_STYLE, register: 'tu' as const };
    const interactive = cartNextStepButtons('abc123', 'x');
    if (interactive.type !== 'buttons') throw new Error('buttons');
    for (const button of interactive.buttons) {
      expect(button.title.length).toBeLessThanOrEqual(20);
      expect(applyCustomerStyle(button.title, tu)).toBe(button.title);
    }
  });

  it('parses both ids and requires the cart reference', () => {
    expect(parseInteractiveReplyId('cart_continue:abc123')).toEqual({
      kind: 'cart_continue',
      reference: 'abc123',
    });
    expect(parseInteractiveReplyId('cart_add:abc123')).toEqual({
      kind: 'cart_add_more',
      reference: 'abc123',
    });
    for (const id of [
      'cart_continue',
      'cart_add',
      'cart_continue:',
      'cart_add:',
    ])
      expect(parseInteractiveReplyId(id)).toBeNull();
  });

  it('a tap on «Seguir con la compra» stands for «Quiero comprar»; «Agregar algo más» for its title', () => {
    expect(
      interactiveReplyText('cart_continue:abc123', 'Seguir con la compra'),
    ).toBe('Quiero comprar');
    expect(interactiveReplyText('cart_add:abc123', 'Agregar algo más')).toBe(
      'Agregar algo más',
    );
  });
});
