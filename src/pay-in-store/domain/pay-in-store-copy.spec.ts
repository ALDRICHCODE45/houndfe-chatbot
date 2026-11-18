import type { CheckoutPickupLocation } from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  PAY_IN_STORE_TEMPLATES,
  payInStoreDateTime,
  payInStoreHeldReply,
  payInStoreStoreText,
  payInStoreTemplateStoreText,
  pickupExpiredReviewText,
  pickupExtendedText,
  pickupReminderDeadline,
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

/**
 * odd/tasks/pay-in-store-templates.md S2–S4: the direction of a staff
 * deadline change, the expired-with-payment notice, the store text fallback
 * and the template names / parameters.
 */
describe('pay in store copy: direction, expired review, templates', () => {
  const NEW = '2026-11-19T20:00:00.000Z'; // 2:00 p. m. local
  const EARLIER = '2026-11-19T18:00:00.000Z';
  const LATER = '2026-11-20T18:00:00.000Z';
  const EXTENDED =
    'Le ampliamos el plazo de su pedido B-1: ahora puede recogerlo y pagarlo hasta el jueves 19 de noviembre a las 2:00 p. m.';
  const UPDATED =
    'Actualizamos el plazo de su pedido B-1: ahora puede recogerlo y pagarlo hasta el jueves 19 de noviembre a las 2:00 p. m.';

  it.each<[string, Partial<Parameters<typeof pickupExtendedText>[0]>, string]>([
    ['direction EXTENDED', { direction: 'EXTENDED' }, EXTENDED],
    [
      'direction EXTENDED even with a later previous deadline',
      { direction: 'EXTENDED', previousHoldUntil: LATER },
      EXTENDED,
    ],
    ['no direction, no previous deadline', {}, EXTENDED],
    [
      'no direction, an earlier previous deadline',
      { previousHoldUntil: EARLIER },
      EXTENDED,
    ],
    [
      'no direction, the same previous deadline',
      { previousHoldUntil: NEW },
      EXTENDED,
    ],
    ['direction SHORTENED', { direction: 'SHORTENED' }, UPDATED],
    [
      'no direction, a later previous deadline',
      { previousHoldUntil: LATER },
      UPDATED,
    ],
  ])('%s', (_name, patch, text) => {
    expect(pickupExtendedText({ folio: 'B-1', holdUntil: NEW, ...patch })).toBe(
      text,
    );
  });

  it('expired review: the exact text, «su pedido» without a folio', () => {
    expect(pickupExpiredReviewText('B-1')).toBe(
      'El plazo de su pedido B-1 venció. Como tiene un pago registrado, alguien del equipo le va a contactar para cerrarlo.',
    );
    expect(pickupExpiredReviewText(null)).toBe(
      'El plazo de su pedido venció. Como tiene un pago registrado, alguien del equipo le va a contactar para cerrarlo.',
    );
  });

  const LOCATION: CheckoutPickupLocation = {
    name: 'Sucursal Centro',
    address: {
      addressLine1: 'Av. Juárez 123',
      addressLine2: null,
      neighborhood: 'Centro',
      municipality: 'Cuauhtémoc',
      state: 'Ciudad de México',
      postalCode: '06000',
      formatted: 'Av. Juárez 123, Centro, C.P. 06000.',
    },
    hours: {
      timeZone: 'America/Mexico_City',
      days: [],
      summary: 'Lunes a sábado: 09:00–18:00',
    },
  };

  it('the store text falls back to branchName, then «la tienda»', () => {
    expect(payInStoreStoreText(null, 'Sucursal Norte')).toBe('Sucursal Norte');
    expect(payInStoreStoreText(null, null)).toBe('la tienda');
    expect(payInStoreStoreText(null, '  ')).toBe('la tienda');
    // The stored location wins over the branch name.
    expect(payInStoreStoreText(LOCATION, 'Sucursal Norte')).toBe(
      'Sucursal Centro: Av. Juárez 123, Centro, C.P. 06000. Horario: Lunes a sábado: 09:00–18:00',
    );
  });

  it('the template store text is the branch name + address (no hours)', () => {
    expect(payInStoreTemplateStoreText(LOCATION, 'Sucursal Norte')).toBe(
      'Sucursal Centro: Av. Juárez 123, Centro, C.P. 06000',
    );
    expect(
      payInStoreTemplateStoreText({ ...LOCATION, address: null }, null),
    ).toBe('Sucursal Centro');
    expect(payInStoreTemplateStoreText(null, 'Sucursal Norte')).toBe(
      'Sucursal Norte',
    );
    expect(payInStoreTemplateStoreText(null, null)).toBe('la tienda');
  });

  it('the reminder deadline is the free-text one («hoy a las …»)', () => {
    expect(
      pickupReminderDeadline(NEW, new Date('2026-11-19T16:00:00.000Z')),
    ).toBe('hoy a las 2:00 p. m.');
  });

  it('the template names are the ones given to the owner (es_MX)', () => {
    expect(PAY_IN_STORE_TEMPLATES).toEqual({
      languageCode: 'es_MX',
      reminder: 'apartado_recordatorio',
      expired: 'apartado_vencido',
      updated: 'apartado_plazo_actualizado',
    });
  });
});
