import {
  backorderCancelButtons,
  backorderCancelPick,
  INTERACTIVE_LIMITS,
  interactiveReplyText,
  parseInteractiveReplyId,
} from './customer-reply';

const ID = '8c1d0000-1111-4222-8333-444455556666';
const OTHER = '9c1d0000-1111-4222-8333-444455556666';

/** Restock backorder S8: the buttons and rows of the customer cancel. */
describe('backorder cancel buttons', () => {
  it('has the two approved buttons, bound to the backorder', () => {
    const interactive = backorderCancelButtons(ID, '¿Cancelo su pedido BO-1?');
    expect(interactive).toEqual({
      type: 'buttons',
      buttons: [
        { id: `backorder_cancel:yes:${ID}`, title: 'Sí, cancelar' },
        { id: `backorder_cancel:no:${ID}`, title: 'No' },
      ],
      prompt: '¿Cancelo su pedido BO-1?',
    });
  });

  it('parses the ids to the action and the backorder they answer', () => {
    for (const action of ['yes', 'no', 'pick'] as const)
      expect(
        parseInteractiveReplyId(`backorder_cancel:${action}:${ID}`),
      ).toEqual({ kind: 'backorder_cancel', action, reference: ID });
  });

  it.each([
    'backorder_cancel',
    'backorder_cancel:',
    'backorder_cancel:yes',
    'backorder_cancel:yes:',
    `backorder_cancel:maybe:${ID}`,
    `backorder_cancel:yes:${ID}:extra`,
    'backorder_cancel:yes:not-a-uuid',
  ])('rejects the forged or truncated id %j', (id) => {
    expect(parseInteractiveReplyId(id)).toBeNull();
  });

  it('does not disturb the offer ids', () => {
    expect(parseInteractiveReplyId(`backorder:schedule:${ID}`)).toEqual({
      kind: 'backorder',
      action: 'schedule',
      reference: ID,
    });
  });

  it('a tapped yes is the neutral «SÍ», a tapped no is «No», a pick keeps its title', () => {
    expect(
      interactiveReplyText(`backorder_cancel:yes:${ID}`, 'Sí, cancelar'),
    ).toBe('SÍ');
    expect(interactiveReplyText(`backorder_cancel:no:${ID}`, 'No')).toBe('No');
    expect(
      interactiveReplyText(`backorder_cancel:pick:${ID}`, 'BO-000012'),
    ).toBe('BO-000012');
  });
});

describe('backorder cancel pick', () => {
  const row = (id: string, folio: string) => ({
    id,
    folio,
    description: '2 × Croquetas Adulto Raza Grande 18 kg con extras de más',
  });

  it('two or three backorders are reply buttons titled by folio', () => {
    const pick = backorderCancelPick(
      [row(ID, 'BO-000012'), row(OTHER, 'BO-000013')],
      'prompt',
    );
    expect(pick).toEqual({
      type: 'buttons',
      buttons: [
        { id: `backorder_cancel:pick:${ID}`, title: 'BO-000012' },
        { id: `backorder_cancel:pick:${OTHER}`, title: 'BO-000013' },
      ],
      prompt: 'prompt',
    });
  });

  it('more than three become a list (max 10 rows, limits respected)', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row(
        `${String(index).padStart(8, '0')}-1111-4222-8333-444455556666`,
        `BO-0000${String(index).padStart(2, '0')}`,
      ),
    );
    const pick = backorderCancelPick(rows, 'prompt');
    expect(pick?.type).toBe('list');
    if (pick?.type !== 'list') return;
    expect(pick.rows).toHaveLength(INTERACTIVE_LIMITS.rows);
    for (const item of pick.rows) {
      expect(item.title.length).toBeLessThanOrEqual(
        INTERACTIVE_LIMITS.rowTitle,
      );
      expect((item.description ?? '').length).toBeLessThanOrEqual(
        INTERACTIVE_LIMITS.rowDescription,
      );
      expect(item.id.length).toBeLessThanOrEqual(INTERACTIVE_LIMITS.id);
    }
    expect(pick.buttonText.length).toBeLessThanOrEqual(
      INTERACTIVE_LIMITS.listButtonText,
    );
  });

  it('fewer than two is not a pick', () => {
    expect(backorderCancelPick([row(ID, 'BO-000012')], 'p')).toBeNull();
  });
});
