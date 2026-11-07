import { checkReply } from '../../../scripts/eval/checks';

/** The eval's duplicate-line heuristic (scripts/eval/checks.ts). */
const duplicate = (reply: string) =>
  checkReply({
    customerText: 'Buen día, ¿qué arenas tienen?',
    reply,
    expected: 'usted',
    refusal: 'forbidden',
    expectPersona: false,
  }).find((result) => result.check === 'duplicate-line');

describe('eval duplicate-line check', () => {
  it('ignores a short attribute line repeated across a product list', () => {
    const reply = [
      '1. **Arena para Gato de Sílice 3.8 L**',
      "   - **Marca:** Pet's Choice",
      '   - **Precio:** $179.00',
      '2. **Arena para Gato Aglomerante Sin Aroma**',
      "   - **Marca:** Pet's Choice",
      '   - **Precio:** $219.00',
    ].join('\n');
    expect(duplicate(reply)?.severity).toBe('pass');
  });

  it('still flags a repeated full sentence', () => {
    const sentence =
      'Le agregué 1 unidad; si desea otra cantidad, dígame cuántas.';
    expect(duplicate(`${sentence}\n\nTu carrito:\n${sentence}`)).toMatchObject({
      severity: 'fail',
    });
  });
});
