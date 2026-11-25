import type { ChatbotApiClient } from '../../chatbot-api/domain/chatbot-api.client';
import type { ConversationStore } from '../../conversation/domain/conversation-store';
import { normalizeMinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import { payInStoreHeldReply } from '../../pay-in-store/domain/pay-in-store-copy';
import {
  DEFAULT_CUSTOMER_STYLE,
  applyCustomerStyle,
  type CustomerStyle,
} from '../domain/customer-style';
import { renderMinimalCheckoutConfirmation } from '../domain/minimal-checkout-confirmation';
import { minimalItemLines } from '../domain/minimal-order-confirmation';
import {
  minimalPickupReply,
  minimalShippingReply,
} from './minimal-catalog-agent.service';
import { minimalOrderCreatedReply } from './minimal-order.service';
import {
  MINIMAL_PAYMENT_QUESTION,
  MinimalPaymentService,
  minimalPaymentInstructions,
} from './minimal-payment.service';

/**
 * Message formatting F3b (odd/tasks/message-formatting.md S2–S4): payment
 * question and bank details, pay-in-store hold, shipping quote (🚚) and
 * order created (✅) in the WhatsApp layout with «$1,250.00» amounts.
 */

const usted: CustomerStyle = DEFAULT_CUSTOMER_STYLE; // emojis: false
const tu: CustomerStyle = { register: 'tu', emojis: false, tone: 'neutral' };

const BANK = {
  bankName: 'BBVA',
  beneficiary: 'HoundFe SA de CV',
  clabe: '012180001234567891',
  accountNumber: '0123456789',
};
const STORE = {
  name: 'Sucursal Centro',
  address: { formatted: 'Av. Juárez 123, Centro.' },
  hours: { summary: 'Lunes a sábado: 09:00–18:00' },
} as never;
const HOLD_UNTIL = '2026-11-19T18:30:00.000Z'; // 12:30 p. m. local

describe('message formatting F3b: bank details (S2, S4)', () => {
  it('renders the transfer block with bold labels, one per line (usted)', () => {
    expect(applyCustomerStyle(minimalPaymentInstructions(BANK), usted)).toBe(
      [
        '*Pago por transferencia*',
        '*Banco:* BBVA',
        '*Beneficiario:* HoundFe SA de CV',
        '*CLABE:* 012180001234567891',
        '*Cuenta:* 0123456789',
        '',
        'Cuando haga la transferencia, envíe aquí la foto de su comprobante.',
      ].join('\n'),
    );
  });

  it('renders the transfer block in tú with the CLABE untouched', () => {
    expect(applyCustomerStyle(minimalPaymentInstructions(BANK), tu)).toBe(
      [
        '*Pago por transferencia*',
        '*Banco:* BBVA',
        '*Beneficiario:* HoundFe SA de CV',
        '*CLABE:* 012180001234567891',
        '*Cuenta:* 0123456789',
        '',
        'Cuando hagas la transferencia, envía aquí la foto de tu comprobante.',
      ].join('\n'),
    );
  });

  it('[F3b-fix H2] shows bank values exactly as configured (no plain())', () => {
    const block = minimalPaymentInstructions({
      ...BANK,
      beneficiary: 'Hound_Fe SA de CV',
      accountNumber: '****6789',
    });
    expect(block).toContain('\n*Beneficiario:* Hound_Fe SA de CV\n');
    expect(block).toContain('\n*Cuenta:* ****6789\n');
    expect(applyCustomerStyle(block, tu)).toContain('\n*Cuenta:* ****6789\n');
  });

  it('[F3b-fix H2] a missing or empty bank value omits its line', () => {
    expect(
      minimalPaymentInstructions({
        ...BANK,
        accountNumber: '',
        beneficiary: '   ',
        clabe: null as unknown as string,
      }),
    ).toBe(
      [
        '*Pago por transferencia*',
        '*Banco:* BBVA',
        '',
        'Cuando haga la transferencia, envíe aquí la foto de su comprobante.',
      ].join('\n'),
    );
  });

  it('keeps the payment question short', () => {
    expect(MINIMAL_PAYMENT_QUESTION).toBe(
      'Para terminar solo falta el pago. ¿Cómo desea pagar?',
    );
  });
});

describe('message formatting F3b: payment replies show «$1,250.00» (S4)', () => {
  const SALE = '55555555-5555-4555-8555-555555555555';
  const service = (placedSale: Record<string, unknown>) => {
    const store = {
      get: jest.fn(() =>
        Promise.resolve({
          data: {
            minimalCart: { items: [], idempotencyKey: '', placedSale },
          },
        }),
      ),
    } as unknown as ConversationStore;
    const api = {
      getPaymentDetails: jest.fn(() =>
        Promise.resolve({
          id: 'pd',
          ...BANK,
          isActive: true,
          updatedAt: '2026-10-01T00:00:00.000Z',
        }),
      ),
    } as unknown as ChatbotApiClient;
    return new MinimalPaymentService(api, store);
  };

  it('payment lead and bank details', async () => {
    const reply = await service({
      saleId: SALE,
      folio: 'B-0042',
      totalCents: 125000,
    }).paymentDetails('s');
    expect(reply?.reply).toBe(
      [
        'Pedido con folio B-0042. Total a pagar: $1,250.00.',
        '',
        minimalPaymentInstructions(BANK),
      ].join('\n'),
    );
  });

  it('already-paid status', async () => {
    const reply = await service({
      saleId: SALE,
      folio: 'B-0042',
      totalCents: 125000,
      paid: true,
    }).placedOrderStatus('s');
    expect(reply?.reply).toBe(
      'Pedido con folio B-0042. Total: $1,250.00.\nSu pedido ya está pagado.',
    );
  });
});

describe('message formatting F3b: pay-in-store hold (S2)', () => {
  it('usted: folio, deadline and store in bold, store place on its own lines', () => {
    expect(
      applyCustomerStyle(
        payInStoreHeldReply({
          folio: 'B-0042',
          holdUntil: HOLD_UNTIL,
          location: STORE,
        }),
        usted,
      ),
    ).toBe(
      [
        'Listo, le apartamos su pedido *B-0042* hasta el *jueves 19 de noviembre a las 12:30 p. m.*',
        '',
        'Páselo a recoger y pagar en *Sucursal Centro*',
        'Av. Juárez 123, Centro',
        '*Horario:* Lunes a sábado: 09:00–18:00',
        '',
        'Si no pasa antes de esa fecha, el pedido se cancela.',
      ].join('\n'),
    );
  });

  it('tú render', () => {
    expect(
      applyCustomerStyle(
        payInStoreHeldReply({
          folio: 'B-0042',
          holdUntil: HOLD_UNTIL,
          location: STORE,
        }),
        tu,
      ),
    ).toBe(
      [
        'Listo, te apartamos tu pedido *B-0042* hasta el *jueves 19 de noviembre a las 12:30 p. m.*',
        '',
        'Pásalo a recoger y pagar en *Sucursal Centro*',
        'Av. Juárez 123, Centro',
        '*Horario:* Lunes a sábado: 09:00–18:00',
        '',
        'Si no pasas antes de esa fecha, el pedido se cancela.',
      ].join('\n'),
    );
  });

  it('no folio and no known store', () => {
    expect(
      payInStoreHeldReply({
        folio: null,
        holdUntil: HOLD_UNTIL,
        location: null,
      }),
    ).toBe(
      [
        'Listo, le apartamos su pedido hasta el *jueves 19 de noviembre a las 12:30 p. m.*',
        '',
        'Páselo a recoger y pagar en la tienda.',
        '',
        'Si no pasa antes de esa fecha, el pedido se cancela.',
      ].join('\n'),
    );
  });

  it('a store without address or hours, name made safe (plain)', () => {
    expect(
      payInStoreHeldReply({
        folio: 'B-1',
        holdUntil: HOLD_UNTIL,
        location: { name: 'Sucursal *Norte*', address: null, hours: null },
      }),
    ).toContain('Páselo a recoger y pagar en *Sucursal Norte*\n\nSi no pasa');
  });

  it('[F3b-fix H3] a name emptied by plain() reads «la tienda», address and hours kept', () => {
    expect(
      payInStoreHeldReply({
        folio: 'B-1',
        holdUntil: HOLD_UNTIL,
        location: {
          name: '**',
          address: { formatted: 'Av. Juárez 123, Centro.' },
          hours: { summary: 'Lunes a sábado: 09:00–18:00' },
        } as never,
      }),
    ).toContain(
      [
        '',
        'Páselo a recoger y pagar en la tienda',
        'Av. Juárez 123, Centro',
        '*Horario:* Lunes a sábado: 09:00–18:00',
        '',
      ].join('\n'),
    );
  });
});

describe('message formatting F3b: shipping quote (S2, S3, S4)', () => {
  const quoted = {
    kind: 'quoted' as const,
    zoneStatus: 'SURCHARGE' as const,
    costCents: 5000,
    creditCents: 12000,
    customerChargeCents: 0,
    option: { carrier: 'DHL', service: 'Express', etaDays: 3 },
    eta: { days: 3 },
    zipCode: '06600',
  } as never;
  const charged = {
    ...(quoted as object),
    costCents: 25000,
    creditCents: 12000,
    customerChargeCents: 13000,
  } as never;

  it('usted: 🚚 title, carrier line, credit, bold amount to pay, ETA', () => {
    expect(applyCustomerStyle(minimalShippingReply(charged), usted)).toBe(
      [
        '*Envío a domicilio* 🚚',
        'DHL Express — $250.00',
        'Usted tiene un crédito de $120.00 por sus productos.',
        '*Usted paga: $130.00*',
        'Llega en aproximadamente 3 días hábiles.',
      ].join('\n'),
    );
  });

  it('tú render keeps the 🚚 title emoji for a customer without emojis', () => {
    expect(applyCustomerStyle(minimalShippingReply(charged), tu)).toBe(
      [
        '*Envío a domicilio* 🚚',
        'DHL Express — $250.00',
        'Tienes un crédito de $120.00 por tus productos.',
        '*Pagas: $130.00*',
        'Llega en aproximadamente 3 días hábiles.',
      ].join('\n'),
    );
  });

  it('free zone: title and the free sentence', () => {
    expect(
      minimalShippingReply({
        ...(quoted as object),
        zoneStatus: 'FREE',
      } as never),
    ).toBe(
      [
        '*Envío a domicilio* 🚚',
        'Su envío al código postal 06600 no tiene costo.',
        'Llega en aproximadamente 3 días hábiles.',
      ].join('\n'),
    );
  });

  it('no credit line without credit; no carrier → cost line', () => {
    expect(
      minimalShippingReply({
        ...(charged as object),
        creditCents: 0,
        customerChargeCents: 125000,
        costCents: 125000,
        option: null,
        eta: null,
      } as never),
    ).toBe(
      [
        '*Envío a domicilio* 🚚',
        'Costo: $1,250.00',
        '*Usted paga: $1,250.00*',
      ].join('\n'),
    );
  });

  it('carrier and service names go through plain()', () => {
    expect(
      minimalShippingReply({
        ...(charged as object),
        option: { carrier: '*DHL*', service: 'Express_Plus', etaDays: 3 },
      } as never),
    ).toContain('\nDHL Express Plus — $250.00\n');
  });

  it('pickup reply stays a single line without emoji', () => {
    expect(minimalPickupReply({ kind: 'pickup' })).toBe(
      'Listo, usted recoge su pedido en tienda, sin costo de envío.',
    );
  });
});

describe('message formatting F3b: order created (S2, S3, S4)', () => {
  const sale = { saleId: 's', folio: 'A-12', totalCents: 125000 };

  it('usted: ✅ title, folio, total with shipping included', () => {
    expect(
      applyCustomerStyle(
        minimalOrderCreatedReply(sale, { customerChargeCents: 8000 }, null),
        usted,
      ),
    ).toBe(
      [
        '*¡Pedido registrado!* ✅',
        '*Folio:* A-12',
        '*Total a pagar:* $1,250.00 (envío incluido)',
      ].join('\n'),
    );
  });

  it('tú: the same block, ✅ kept for a customer without emojis', () => {
    expect(
      applyCustomerStyle(
        minimalOrderCreatedReply(sale, { customerChargeCents: 8000 }, null),
        tu,
      ),
    ).toBe(
      [
        '*¡Pedido registrado!* ✅',
        '*Folio:* A-12',
        '*Total a pagar:* $1,250.00 (envío incluido)',
      ].join('\n'),
    );
  });

  it('pickup: place and hours on their own lines (usted and tú)', () => {
    const reply = minimalOrderCreatedReply(sale, { mode: 'pickup' }, STORE);
    expect(applyCustomerStyle(reply, usted)).toBe(
      [
        '*¡Pedido registrado!* ✅',
        '*Folio:* A-12',
        '*Total a pagar:* $1,250.00 (recoge en tienda, sin costo de envío)',
        '',
        'Recójalo en *Sucursal Centro*',
        'Av. Juárez 123, Centro',
        '*Horario:* Lunes a sábado: 09:00–18:00',
      ].join('\n'),
    );
    expect(applyCustomerStyle(reply, tu)).toContain(
      '\nRecógelo en *Sucursal Centro*\n',
    );
  });

  it('[F3b-fix H3] pickup: a name emptied by plain() reads «la tienda», same as the hold', () => {
    const location = {
      name: '~~',
      address: { formatted: 'Av. Juárez 123, Centro.' },
      hours: null,
    } as never;
    expect(minimalOrderCreatedReply(sale, { mode: 'pickup' }, location)).toBe(
      [
        '*¡Pedido registrado!* ✅',
        '*Folio:* A-12',
        '*Total a pagar:* $1,250.00 (recoge en tienda, sin costo de envío)',
        '',
        'Recójalo en la tienda',
        'Av. Juárez 123, Centro',
      ].join('\n'),
    );
    expect(
      minimalOrderCreatedReply(
        sale,
        { mode: 'pickup' },
        {
          name: 'Sucursal Centro.',
          address: null,
          hours: null,
        },
      ),
    ).toMatch(/\nRecójalo en \*Sucursal Centro\*$/);
  });

  it('free shipping, no shipping and no folio', () => {
    expect(
      minimalOrderCreatedReply(sale, { customerChargeCents: 0 }, null),
    ).toBe(
      [
        '*¡Pedido registrado!* ✅',
        '*Folio:* A-12',
        '*Total a pagar:* $1,250.00 (envío sin costo)',
      ].join('\n'),
    );
    expect(
      minimalOrderCreatedReply({ ...sale, folio: null }, undefined, null),
    ).toBe(
      [
        '*¡Pedido registrado!* ✅',
        '*Total de productos:* $1,250.00',
        'El envío no está incluido y se coordinará por separado.',
      ].join('\n'),
    );
  });
});

describe('message formatting F3b: values emptied by plain() (F2a advisories)', () => {
  it('a pet name made only of markers leaves no «(para )»', () => {
    const [first] = minimalItemLines({
      name: 'Croquetas',
      quantity: 1,
      unitPriceCents: 1000,
      finalPriceCents: 1000,
      pet: { name: '***' },
    });
    expect(first).toBe('• Croquetas');
  });

  it('a customer name made only of markers leaves no bare «*Nombre:*»', () => {
    const draft = normalizeMinimalCheckoutDraft(
      {
        schemaVersion: 1,
        senderId: '5215550001111',
        revision: 0,
        sourceCustomerId: null,
        customer: { firstName: '**', lastName: '~' },
        address: {
          kind: 'new',
          fields: {
            label: null,
            street: 'Av. Reforma',
            exteriorNumber: '123',
            interiorNumber: null,
            zipCode: '06600',
            neighborhood: 'Juárez',
            municipality: null,
            city: 'Ciudad de México',
            state: 'Ciudad de México',
            visualReferences: null,
            carrierPhone: null,
          },
        },
      },
      '5215550001111',
    )!;
    expect(renderMinimalCheckoutConfirmation(draft)).not.toMatch(
      /^\*Nombre:\*\s*$/m,
    );
  });
});
