import {
  INTERACTIVE_BACKORDER_WAIT_TEXT,
  interactiveReplyText,
  parseInteractiveReplyId,
} from './customer-reply';

const ID = '8c1d0000-1111-4222-8333-444455556666';

/** Restock backorder S7: the «Seguir esperando» button of the ETA notices. */
describe('backorder wait button', () => {
  it('parses the id to the backorder it answers', () => {
    expect(parseInteractiveReplyId(`backorder_wait:${ID}`)).toEqual({
      kind: 'backorder_wait',
      reference: ID,
    });
  });

  it.each([
    'backorder_wait',
    'backorder_wait:',
    'backorder_wait:not-a-uuid',
    `backorder_wait:${ID}:extra`,
    `backorder_wait:yes:${ID}`,
  ])('rejects the forged or truncated id %j', (id) => {
    expect(parseInteractiveReplyId(id)).toBeNull();
  });

  it('does not disturb the other backorder ids', () => {
    expect(parseInteractiveReplyId(`backorder_confirm:${ID}`)).toEqual({
      kind: 'backorder_confirm',
      reference: ID,
    });
    expect(parseInteractiveReplyId(`backorder_cancel:pick:${ID}`)).toEqual({
      kind: 'backorder_cancel',
      action: 'pick',
      reference: ID,
    });
  });

  it('a tap stands for a neutral text, whatever the title says', () => {
    expect(
      interactiveReplyText(`backorder_wait:${ID}`, 'Seguir esperando'),
    ).toBe(INTERACTIVE_BACKORDER_WAIT_TEXT);
    expect(INTERACTIVE_BACKORDER_WAIT_TEXT).toBe('Seguir esperando');
  });
});
