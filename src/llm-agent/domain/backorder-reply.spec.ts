import {
  INTERACTIVE_LIMITS,
  interactiveReplyText,
  parseInteractiveReplyId,
} from './customer-reply';
import {
  applyCustomerStyle,
  DEFAULT_CUSTOMER_STYLE,
  explicitStyleSignal,
} from './customer-style';
import {
  BACKORDER_OFFER_CLOSING,
  backorderOfferButtons,
} from '../../backorders/domain/backorder-offer';

const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

/** Restock backorder S1: the two buttons under the estimate message. */
describe('backorder offer buttons', () => {
  it('has exactly the two approved buttons, bound to the decision', () => {
    expect(backorderOfferButtons(DECISION)).toEqual([
      { id: `backorder:schedule:${DECISION}`, title: 'Sí, apártamelo' },
      { id: `backorder:decline:${DECISION}`, title: 'No, gracias' },
    ]);
  });

  it('keeps every title within the Meta limit and every id within the id limit', () => {
    for (const button of backorderOfferButtons(DECISION)) {
      expect(button.title.length).toBeLessThanOrEqual(
        INTERACTIVE_LIMITS.buttonTitle,
      );
      expect(button.id.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.id);
    }
  });

  it('parses both ids to the action and the decision they answer', () => {
    expect(parseInteractiveReplyId(`backorder:schedule:${DECISION}`)).toEqual({
      kind: 'backorder',
      action: 'schedule',
      reference: DECISION,
    });
    expect(parseInteractiveReplyId(`backorder:decline:${DECISION}`)).toEqual({
      kind: 'backorder',
      action: 'decline',
      reference: DECISION,
    });
  });

  it.each([
    'backorder',
    'backorder:',
    'backorder:schedule',
    'backorder:schedule:',
    `backorder:other:${DECISION}`,
    `backorder::${DECISION}`,
    `backorder:schedule:${DECISION}:extra`,
    'backorder:schedule:not-a-uuid',
  ])('rejects the forged or truncated id %j', (id) => {
    expect(parseInteractiveReplyId(id)).toBeNull();
  });

  it('does not disturb the existing ids', () => {
    expect(parseInteractiveReplyId('cart_continue:abc')).toEqual({
      kind: 'cart_continue',
      reference: 'abc',
    });
  });

  it('the tapped yes is the neutral «SÍ»: the title «apártamelo» would read as tú to the style detector', () => {
    expect(
      interactiveReplyText(`backorder:schedule:${DECISION}`, 'Sí, apártamelo'),
    ).toBe('SÍ');
    expect(explicitStyleSignal('Sí, apártamelo').register).toBe('tu');
    expect(explicitStyleSignal('SÍ').register).toBeUndefined();
    expect(
      interactiveReplyText(`backorder:decline:${DECISION}`, 'No, gracias'),
    ).toBe('No, gracias');
  });

  it('the offer closing has a tú variant with no usted markers', () => {
    const tu = { ...DEFAULT_CUSTOMER_STYLE, register: 'tu' as const };
    expect(applyCustomerStyle(BACKORDER_OFFER_CLOSING, tu)).toBe(
      '¿Quieres que te lo apartemos en cuanto llegue? Te aviso y no pagas nada hasta entonces.',
    );
    expect(
      applyCustomerStyle(BACKORDER_OFFER_CLOSING, DEFAULT_CUSTOMER_STYLE),
    ).toBe(BACKORDER_OFFER_CLOSING);
  });
});
