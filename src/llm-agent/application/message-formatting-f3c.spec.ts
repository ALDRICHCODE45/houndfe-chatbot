import type { CheckoutPickupLocation } from '../../chatbot-api/domain/dtos/checkout.dto';
import {
  etaUnavailableNotice,
  etaUpdatedNotice,
  expiredNotice,
  lostNotice,
  reminderNotice,
  reservedNotice,
  cancelledNotice,
} from '../../backorders/domain/backorder-notices';
import {
  pickupExpiredReviewText,
  pickupExpiredText,
  pickupExtendedText,
  pickupReminderText,
} from '../../pay-in-store/domain/pay-in-store-copy';
import { renderNotificationText } from '../../receipt-media/infrastructure/receipt-media-notification.worker';
import {
  backorderAddedReply,
  backorderScheduledReply,
} from '../domain/backorder-copy';
import {
  DEFAULT_CUSTOMER_STYLE,
  applyCustomerStyle,
  type CustomerStyle,
} from '../domain/customer-style';
import { minimalZoneResumeShippingSentence } from '../domain/minimal-shipping';
import { minimalCheckoutReply } from './minimal-checkout-preflight';

/**
 * Message formatting F3c (odd/tasks/message-formatting.md S2, S4): receipt
 * notices, pay-in-store pickup notices, backorder notices and replies in the
 * WhatsApp layout (bold folio, deadlines and amounts, facts on their own
 * lines) with «$1,250.00» amounts. Meta templates are not touched here.
 */

const usted: CustomerStyle = DEFAULT_CUSTOMER_STYLE; // emojis: false
const tu: CustomerStyle = { register: 'tu', emojis: false, tone: 'neutral' };

describe('message formatting F3c: receipt notices (S2, S4)', () => {
  const render = (
    templateKey: Parameters<typeof renderNotificationText>[0]['templateKey'],
    templateArgs: Record<string, unknown>,
    style?: CustomerStyle,
  ) => renderNotificationText({ templateKey, templateArgs } as never, style);

  it('received with a different amount: both amounts on their own lines (usted)', () => {
    expect(
      render('RECEIPT_ATTACHED_PENDING', {
        folio: 'F-0042',
        extractedAmountCents: 140050,
        totalCents: 150000,
      }),
    ).toBe(
      [
        'Recibimos su comprobante del pedido *F-0042*. Lo estamos revisando y le avisamos en cuanto se confirme.',
        '',
        '*Monto en el comprobante:* $1,400.50',
        '*Total de su pedido:* $1,500.00',
        'Lo revisamos igual.',
      ].join('\n'),
    );
  });

  it('received with a different amount (tú)', () => {
    expect(
      render(
        'RECEIPT_ATTACHED_PENDING',
        { folio: 'F-0042', extractedAmountCents: 140050, totalCents: 150000 },
        tu,
      ),
    ).toBe(
      [
        'Recibimos tu comprobante del pedido *F-0042*. Lo estamos revisando y te avisamos en cuanto quede confirmado.',
        '',
        '*Monto en el comprobante:* $1,400.50',
        '*Total de tu pedido:* $1,500.00',
        'Lo revisamos igual.',
      ].join('\n'),
    );
  });

  it('partial payment: the pending balance in its own bold line (usted and tú)', () => {
    const args = { folio: 'F-0042', debtCents: 150000 };
    expect(render('RECEIPT_PAYMENT_PARTIAL', args)).toBe(
      [
        'Confirmamos un pago de su pedido *F-0042*.',
        '*Saldo pendiente:* $1,500.00',
        '',
        'Puede enviarnos el comprobante del resto cuando lo tenga.',
      ].join('\n'),
    );
    expect(render('RECEIPT_PAYMENT_PARTIAL', args, tu)).toBe(
      [
        'Confirmamos un pago de tu pedido *F-0042*.',
        '*Saldo pendiente:* $1,500.00',
        '',
        'Puedes enviarnos el comprobante del resto cuando lo tengas.',
      ].join('\n'),
    );
  });

  it('confirmed, already paid and rejected: bold folio, question apart', () => {
    expect(render('RECEIPT_PAYMENT_CONFIRMED', { folio: 'F-0042' })).toBe(
      '¡Listo! Confirmamos su pago del pedido *F-0042*. Gracias por su compra.',
    );
    expect(render('RECEIPT_SALE_ALREADY_PAID', { folio: 'F-0042' })).toBe(
      'Su pedido *F-0042* ya está pagado.',
    );
    expect(
      render(
        'RECEIPT_PAYMENT_REJECTED',
        { folio: 'F-0042', reason: 'el monto no coincide con su pedido.' },
        tu,
      ),
    ).toBe(
      [
        'No pudimos confirmar tu comprobante del pedido *F-0042*: el monto no coincide con su pedido.',
        '',
        '¿Me puedes enviar otro comprobante?',
      ].join('\n'),
    );
  });

  it('expired pay-in-store hold: bold folio, the offer apart (usted and tú)', () => {
    const args = { folio: 'F-0042', payInStoreHold: true };
    expect(render('RECEIPT_SALE_NOT_PAYABLE', args)).toBe(
      [
        'Su pedido *F-0042* se canceló porque venció el plazo para recogerlo y pagarlo en tienda, así que no pudimos aplicar este comprobante.',
        '',
        'Si todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.',
      ].join('\n'),
    );
    expect(render('RECEIPT_SALE_NOT_PAYABLE', args, tu)).toBe(
      [
        'Tu pedido *F-0042* se canceló porque venció el plazo para recogerlo y pagarlo en tienda, así que no pudimos aplicar este comprobante.',
        '',
        'Si todavía lo quieres, con gusto te ayudo a pedirlo de nuevo.',
      ].join('\n'),
    );
  });

  it('never says «MXN»', () => {
    expect(
      render('RECEIPT_PAYMENT_PARTIAL', { folio: null, debtCents: 5 }),
    ).toContain('*Saldo pendiente:* $0.05\n');
  });
});

describe('message formatting F3c: pay-in-store pickup notices (S2)', () => {
  const HOLD_UNTIL = '2026-11-19T18:30:00.000Z'; // 12:30 p. m. local
  const NOW = new Date('2026-11-19T15:30:00.000Z');
  const LOCATION = {
    name: 'Sucursal Centro',
    address: { formatted: 'Av. Juárez 123, Centro, C.P. 06000.' },
    hours: { summary: 'Lunes a sábado: 09:00–18:00' },
  } as CheckoutPickupLocation;

  it('reminder: bold folio and deadline, the store block on its own lines (usted and tú)', () => {
    const text = pickupReminderText({
      folio: 'B-0042',
      holdUntil: HOLD_UNTIL,
      location: LOCATION,
      now: NOW,
    });
    expect(applyCustomerStyle(text, usted)).toBe(
      [
        'Le recordamos que su pedido *B-0042* está apartado hasta *hoy a las 12:30 p. m.*',
        '',
        'Páselo a recoger y pagar en *Sucursal Centro*',
        'Av. Juárez 123, Centro, C.P. 06000',
        '*Horario:* Lunes a sábado: 09:00–18:00',
      ].join('\n'),
    );
    expect(applyCustomerStyle(text, tu)).toBe(
      [
        'Te recordamos que tu pedido *B-0042* está apartado hasta *hoy a las 12:30 p. m.*',
        '',
        'Pásalo a recoger y pagar en *Sucursal Centro*',
        'Av. Juárez 123, Centro, C.P. 06000',
        '*Horario:* Lunes a sábado: 09:00–18:00',
      ].join('\n'),
    );
  });

  it('reminder: unknown store → the branch name, else «la tienda.»', () => {
    const base = { folio: 'B-0042', holdUntil: HOLD_UNTIL, now: NOW };
    expect(
      pickupReminderText({
        ...base,
        location: null,
        branchName: 'Sucursal Norte.',
      }),
    ).toMatch(/\n\nPáselo a recoger y pagar en \*Sucursal Norte\*$/);
    expect(pickupReminderText({ ...base, location: null })).toMatch(
      /\n\nPáselo a recoger y pagar en la tienda\.$/,
    );
  });

  it('expired, extended and expired review: bold folio and deadline', () => {
    expect(pickupExpiredText('B-0042')).toBe(
      'Su pedido *B-0042* se canceló porque venció el plazo para recogerlo y pagarlo en tienda.\n\nSi todavía lo quiere, con gusto le ayudo a pedirlo de nuevo.',
    );
    expect(
      applyCustomerStyle(
        pickupExtendedText({ folio: 'B-0042', holdUntil: HOLD_UNTIL }),
        tu,
      ),
    ).toBe(
      'Te ampliamos el plazo de tu pedido *B-0042*: ahora puedes recogerlo y pagarlo hasta el *jueves 19 de noviembre a las 12:30 p. m.*',
    );
    expect(pickupExpiredReviewText('B-0042')).toBe(
      'El plazo de su pedido *B-0042* venció.\n\nComo tiene un pago registrado, alguien del equipo le va a contactar para cerrarlo.',
    );
    expect(pickupExpiredText(null)).toMatch(/^Su pedido se canceló/);
  });
});

describe('message formatting F3c: backorder notices (S2, S4)', () => {
  const reserved = {
    firstName: 'Ana',
    folio: 'BO-000012',
    quantity: 2,
    label: 'Croquetas *Nupec* (18 kg)',
    finalPriceCents: 109900,
    referencePriceCents: 119900,
    deadline: 'el 21 de noviembre a las 9:00 a. m.',
  };

  it('reserved (usted): bold folio, item block, «$1,099.00», bold deadline, question apart', () => {
    expect(reservedNotice(reserved, usted)).toBe(
      [
        '¡Buenas noticias, Ana! Ya llegó su pedido *BO-000012*.',
        '',
        '• Croquetas Nupec (18 kg)',
        '   2 × $1,099.00 = *$2,198.00*',
        '   _Bajó de precio, antes $1,199.00_',
        '',
        'Se lo apartamos hasta *el 21 de noviembre a las 9:00 a. m.*',
        '',
        '¿Lo confirmamos?',
      ].join('\n'),
    );
  });

  it('reserved (tú), no price drop, no name; no style → usted', () => {
    const plainCase = {
      ...reserved,
      firstName: null,
      referencePriceCents: null,
    };
    expect(reservedNotice(plainCase, tu)).toBe(
      [
        '¡Buenas noticias! Ya llegó tu pedido *BO-000012*.',
        '',
        '• Croquetas Nupec (18 kg)',
        '   2 × $1,099.00 = *$2,198.00*',
        '',
        'Te lo apartamos hasta *el 21 de noviembre a las 9:00 a. m.*',
        '',
        '¿Lo confirmamos?',
      ].join('\n'),
    );
    expect(reservedNotice(plainCase, null)).toContain(
      'Se lo apartamos hasta *el 21 de noviembre',
    );
  });

  it('reminder: bold folio and deadline, the question apart (usted and tú)', () => {
    const input = {
      folio: 'BO-000012',
      deadline: 'el 21 de noviembre a las 9:00 a. m.',
    };
    expect(reminderNotice(input, usted)).toBe(
      'Le recuerdo que su pedido *BO-000012* sigue apartado hasta *el 21 de noviembre a las 9:00 a. m.*\n\n¿Lo confirmamos?',
    );
    expect(reminderNotice(input, tu)).toBe(
      'Te recuerdo que tu pedido *BO-000012* sigue apartado hasta *el 21 de noviembre a las 9:00 a. m.*\n\n¿Lo confirmamos?',
    );
  });

  it('ETA updated: folio, item and date on their own lines (usted and tú)', () => {
    const input = {
      firstName: 'Ana',
      folio: 'BO-000012',
      quantity: 2,
      label: 'Collar',
      estimateDate: '27 de noviembre',
    };
    expect(etaUpdatedNotice(input, usted)).toBe(
      [
        'Ana, le actualizo su pedido *BO-000012*:',
        '• 2 × Collar',
        'El equipo nos confirmó que llega aprox. el *27 de noviembre*.',
        '',
        'Se lo aparto en cuanto llegue y le aviso; sigue sin pagar nada hasta entonces. Con gusto se lo tengo listo.',
        '',
        '¿Seguimos con su pedido?',
      ].join('\n'),
    );
    expect(
      etaUpdatedNotice({ ...input, firstName: null, estimateDate: null }, tu),
    ).toBe(
      [
        'Te actualizo tu pedido *BO-000012*:',
        '• 2 × Collar',
        'El equipo está confirmando la nueva fecha de llegada.',
        '',
        'Te lo aparto en cuanto llegue y te aviso; sigue sin pagar nada hasta entonces. Con gusto te lo tengo listo.',
        '',
        '¿Seguimos con tu pedido?',
      ].join('\n'),
    );
  });

  it('expired, lost, ETA unavailable and cancelled: bold folio, question apart', () => {
    expect(
      expiredNotice(
        { folio: 'BO-1', productName: 'Collar', offerReschedule: true },
        tu,
      ),
    ).toBe(
      'Se venció el apartado de tu pedido *BO-1* (Collar).\n\n¿Quieres que te lo vuelva a agendar?',
    );
    expect(
      lostNotice(
        {
          firstName: null,
          productName: 'Collar',
          folio: 'BO-1',
          estimateDate: '27 de noviembre',
        },
        usted,
      ),
    ).toBe(
      'Una disculpa: el lote que le apartamos de Collar caducó y no tenemos otro vigente.\n\nSu pedido *BO-1* sigue en primer lugar; le aviso en cuanto llegue (aprox. 27 de noviembre).',
    );
    expect(
      etaUnavailableNotice(
        { firstName: 'Ana', productName: 'Collar', folio: 'BO-1' },
        tu,
      ),
    ).toBe(
      'Ana, el proveedor todavía no nos confirma fecha para Collar (pedido *BO-1*).\n\nTu lugar sigue apartado: en cuanto llegue te lo separo y te aviso.\n\n¿Seguimos con tu pedido?',
    );
    expect(cancelledNotice({ folio: 'BO-1', reason: null }, tu)).toBe(
      'El equipo canceló tu pedido *BO-1*.',
    );
  });

  it('a product or first name never breaks the markup (plain)', () => {
    expect(
      lostNotice(
        {
          firstName: '*Ana*',
          productName: 'Collar_Rojo',
          folio: 'BO-1',
          estimateDate: null,
        },
        usted,
      ),
    ).toMatch(/^Una disculpa, Ana: el lote que le apartamos de Collar Rojo /);
  });
});

describe('message formatting F3c: backorder replies (S2, S4)', () => {
  const NOW = new Date('2026-11-20T12:00:00.000Z');

  it('scheduled: bold folio, item block, ETA apart (usted and tú)', () => {
    const reply = backorderScheduledReply(
      {
        folio: 'BO-000012',
        quantity: 2,
        productName: 'Collar',
        variantName: null,
        referencePriceCents: 114900,
        estimatedAt: '2026-11-27T18:00:00.000Z',
      },
      NOW,
    );
    expect(applyCustomerStyle(reply, usted)).toBe(
      [
        'Listo, quedó agendado su pedido *BO-000012*:',
        '• Collar',
        '   2 × $1,149.00 = *$2,298.00*',
        '',
        'Le aviso en cuanto llegue (aprox. el 27 de noviembre); no paga nada hasta entonces.',
      ].join('\n'),
    );
    expect(applyCustomerStyle(reply, tu)).toBe(
      [
        'Listo, quedó agendado tu pedido *BO-000012*:',
        '• Collar',
        '   2 × $1,149.00 = *$2,298.00*',
        '',
        'Te aviso en cuanto llegue (aprox. el 27 de noviembre); no pagas nada hasta entonces.',
      ].join('\n'),
    );
  });

  it('added to the cart: bold folio, item block, bold deadline (usted and tú)', () => {
    const reply = backorderAddedReply(
      {
        folio: 'BO-000012',
        quantity: 2,
        productName: 'Collar',
        variantName: 'Rojo',
        finalPriceCents: 109900,
        reservedUntil: '2026-11-21T15:00:00.000Z',
      },
      NOW,
    );
    expect(applyCustomerStyle(reply, usted)).toBe(
      [
        'Listo, su pedido apartado *BO-000012* ya está en su carrito:',
        '• Collar (Rojo)',
        '   2 × $1,099.00 = *$2,198.00*',
        '',
        'Se lo tenemos apartado hasta *el 21 de noviembre a las 9:00 a. m.*',
      ].join('\n'),
    );
    expect(applyCustomerStyle(reply, tu)).toBe(
      [
        'Listo, tu pedido apartado *BO-000012* ya está en tu carrito:',
        '• Collar (Rojo)',
        '   2 × $1,099.00 = *$2,198.00*',
        '',
        'Te lo tenemos apartado hasta *el 21 de noviembre a las 9:00 a. m.*',
      ].join('\n'),
    );
  });
});

describe('message formatting F3c: «$1,250.00» in the remaining amounts (S4)', () => {
  it('zone resume shipping sentence', () => {
    expect(
      minimalZoneResumeShippingSentence({
        eta: { days: 3 },
        option: null,
        customerChargeCents: 125000,
      }),
    ).toBe(
      'el envío cuesta $1,250.00 y llega en aproximadamente 3 días hábiles',
    );
  });

  it('checkout preflight subtotal', () => {
    expect(
      minimalCheckoutReply({
        ok: true,
        status: 'incomplete',
        productsSubtotalCents: 125000,
      } as never),
    ).toMatch(/^Revisión de compra: subtotal de productos \$1,250\.00\. /);
  });
});
