import {
  payInStoreDateTime,
  payInStoreHeldReply,
  pickupExtendedText,
  pickupReminderText,
} from './pay-in-store-copy';

/**
 * Follow-ups S5 (odd/tasks/cost-and-pay-followups.md): 1 o'clock takes the
 * singular article («a la 1:00»), every other hour the plural («a las 2:00»),
 * in the reminder and in every «{fecha y hora}» text. Mexico City is UTC-6.
 */
describe('pay in store copy: «a la 1:00» / «a las 2:00» (S5)', () => {
  const ONE_PM = '2026-11-19T19:00:00.000Z'; // 1:00 p. m. local
  const ONE_AM = '2026-11-19T07:15:00.000Z'; // 1:15 a. m. local
  const TWO_PM = '2026-11-19T20:00:00.000Z'; // 2:00 p. m. local
  const MORNING = new Date('2026-11-19T16:00:00.000Z'); // 10:00 a. m. local

  it('reminder: singular at 1 o’clock', () => {
    expect(
      pickupReminderText({
        folio: 'B-0042',
        holdUntil: ONE_PM,
        location: null,
        now: MORNING,
      }),
    ).toBe(
      'Le recordamos que su pedido B-0042 está apartado hasta hoy a la 1:00 p. m. Páselo a recoger y pagar en la tienda.',
    );
    expect(
      pickupReminderText({
        folio: 'B-0042',
        holdUntil: ONE_AM,
        location: null,
        now: new Date('2026-11-19T06:00:00.000Z'),
      }),
    ).toContain('hasta hoy a la 1:15 a. m.');
  });

  it('reminder: plural for every other hour', () => {
    expect(
      pickupReminderText({
        folio: 'B-0042',
        holdUntil: TWO_PM,
        location: null,
        now: MORNING,
      }),
    ).toContain('hasta hoy a las 2:00 p. m.');
  });

  it('«{fecha y hora}» in the hold reply and the extension notice', () => {
    expect(payInStoreDateTime(ONE_PM)).toBe(
      'jueves 19 de noviembre a la 1:00 p. m.',
    );
    expect(payInStoreDateTime(TWO_PM)).toBe(
      'jueves 19 de noviembre a las 2:00 p. m.',
    );
    expect(
      payInStoreHeldReply({ folio: 'B-1', holdUntil: ONE_PM, location: null }),
    ).toContain('hasta el jueves 19 de noviembre a la 1:00 p. m. Páselo');
    expect(pickupExtendedText({ folio: 'B-1', holdUntil: ONE_PM })).toBe(
      'Le ampliamos el plazo de su pedido B-1: ahora puede recogerlo y pagarlo hasta el jueves 19 de noviembre a la 1:00 p. m.',
    );
  });
});
