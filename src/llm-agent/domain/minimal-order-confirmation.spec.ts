import type { MinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_DECLINED_REPLY,
  MINIMAL_ORDER_CONFIRMATION_TTL_MS,
  MINIMAL_ORDER_SUMMARY_CLOSING,
  MINIMAL_ORDER_SUMMARY_HEADING,
  MinimalOrderConfirmation,
  evaluateMinimalOrder,
  evaluateMinimalPickupOrder,
  renderMinimalOrderSummary,
  sameMinimalOrder,
  type MinimalOrderQuote,
  type MinimalOrderSnapshot,
} from './minimal-order-confirmation';
import {
  applyCustomerRegister,
  applyCustomerStyle,
  type CustomerStyle,
} from './customer-style';

const SENDER = '5215550001111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const EVENT = (messageId: string, overrides: Record<string, string> = {}) => ({
  receivingPhoneNumberId: '123456789012345',
  senderId: SENDER,
  messageId,
  ...overrides,
});

const savedDraft = (): MinimalCheckoutDraft => ({
  schemaVersion: 1,
  senderId: SENDER,
  revision: 3,
  sourceCustomerId: CUSTOMER,
  customer: { firstName: 'Ana', lastName: 'Pérez' },
  address: {
    kind: 'saved',
    snapshot: {
      id: ADDRESS,
      version: '2026-10-01T00:00:00.000Z',
      label: 'Casa',
      street: 'Av. Juárez',
      exteriorNumber: '10',
      interiorNumber: null,
      zipCode: '06000',
      neighborhood: 'Centro',
      municipality: 'Cuauhtémoc',
      city: null,
      state: 'Ciudad de México',
      visualReferences: null,
      carrierPhone: null,
    },
  },
});
const newDraft = (): MinimalCheckoutDraft => ({
  ...savedDraft(),
  sourceCustomerId: null,
  address: {
    kind: 'new',
    fields: {
      label: null,
      street: 'Calle 5',
      exteriorNumber: 'S/N',
      interiorNumber: null,
      zipCode: '06700',
      neighborhood: 'Roma',
      municipality: null,
      city: 'CDMX',
      state: 'Ciudad de México',
      visualReferences: null,
      carrierPhone: null,
    },
  },
});
const quote = (
  overrides: Partial<MinimalOrderQuote> = {},
): MinimalOrderQuote => ({
  items: [
    {
      productId: PRODUCT,
      variantId: VARIANT,
      name: 'Ibuprofeno',
      variantName: '500 mg',
      quantity: 2,
      unitPriceCents: 1500,
      finalPriceCents: 2700,
    },
  ],
  totalCents: 2700,
  promotionEvaluationStatus: 'fully_evaluated',
  ...overrides,
});

const eligible = (): MinimalOrderSnapshot => {
  const verdict = evaluateMinimalOrder({
    confirmedDraft: savedDraft(),
    quote: quote(),
  });
  if (!verdict.ok) throw new Error('expected eligible order');
  return verdict.snapshot;
};

describe('shipping summary and exact binding', () => {
  const withShipping = (customerChargeCents: number) => ({
    ...eligible(),
    shipping: { quoteId: 'quote-1', customerChargeCents },
  });
  it('[S2,S3] presents the backend charge and the charge-inclusive total', () => {
    const summary = renderMinimalOrderSummary(withShipping(5000));
    expect(summary).toContain('Total de productos: $27.00');
    expect(summary).toContain('*Envío:* $50.00');
    expect(summary).toContain('*Total a pagar: $77.00*');
    expect(summary).not.toContain('MXN');
    expect(summary).not.toContain('no está incluido');
    expect(summary).toContain(MINIMAL_ORDER_SUMMARY_CLOSING);
  });
  it('[S3] presents a zero charge as shipping without cost and still ends with the total to pay', () => {
    const summary = renderMinimalOrderSummary(withShipping(0));
    // Products total equals the total to pay: shown once only.
    expect(summary).not.toContain('Total de productos');
    expect(summary).toContain('*Envío:* sin costo');
    expect(summary).toContain('*Total a pagar: $27.00*');
    expect(summary).not.toContain('no está incluido');
  });
  it.each([
    ['charged', withShipping(5000), '*Total a pagar: $77.00*'],
    ['free', withShipping(0), '*Total a pagar: $27.00*'],
    [
      'pickup',
      { ...eligible(), shipping: { mode: 'pickup' as const } },
      '*Total a pagar: $27.00*',
    ],
  ])(
    '[S3] %s: «Total a pagar» is the last line before the SÍ prompt',
    (_name, snapshot, total) => {
      const lines = renderMinimalOrderSummary(snapshot).split('\n');
      expect(lines.slice(-3)).toEqual([
        total,
        '',
        MINIMAL_ORDER_SUMMARY_CLOSING,
      ]);
      expect(
        lines.filter((line) => line.includes('Total a pagar')),
      ).toHaveLength(1);
    },
  );
  it('[S3] shows the shipping charge and the ETA exactly once', () => {
    const summary = renderMinimalOrderSummary({
      ...eligible(),
      shipping: {
        quoteId: 'quote-1',
        customerChargeCents: 0,
        eta: { days: 1 },
      },
    });
    expect(summary.match(/Llega en/g)).toHaveLength(1);
    expect(summary.match(/Envío/g)).toHaveLength(1);
  });
  it('[S3,S7] shows carrier, charge, credit and the ETA line', () => {
    const summary = renderMinimalOrderSummary({
      ...eligible(),
      shipping: {
        quoteId: 'quote-1',
        customerChargeCents: 3000,
        creditCents: 12000,
        option: { carrier: 'Envíos Perros', service: 'Estándar' },
        eta: { days: 3 },
      },
    });
    expect(summary.split('\n').slice(-9)).toEqual([
      'Centro, C.P. 06000, Cuauhtémoc, Ciudad de México',
      '',
      '*Total de productos: $27.00*',
      '*Envío:* Envíos Perros Estándar — $30.00',
      'Usted tiene un crédito de $120.00 por sus productos (ya descontado del envío)',
      'Llega en aproximadamente 3 días hábiles.',
      '*Total a pagar: $57.00*',
      '',
      MINIMAL_ORDER_SUMMARY_CLOSING,
    ]);
  });
  it('[S7] a STOCK_PENDING eta says delivery depends on restock; no credit line at zero', () => {
    const summary = renderMinimalOrderSummary({
      ...eligible(),
      shipping: {
        quoteId: 'quote-1',
        customerChargeCents: 3000,
        creditCents: 0,
        option: null,
        eta: { days: null, reason: 'STOCK_PENDING' },
      },
    });
    expect(summary).toContain('*Envío:* $30.00\n');
    expect(summary).not.toContain('crédito');
    expect(summary).toContain(
      'La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.',
    );
    expect(summary).not.toContain('Llega en');
  });
  it('[S4] pickup says the customer picks it up in store with no shipping cost', () => {
    const snapshot: MinimalOrderSnapshot = {
      ...eligible(),
      shippingAddressId: '',
      draft: null,
      customer: { firstName: 'Ana', lastName: 'Pérez' },
      shipping: { mode: 'pickup' },
    };
    const summary = renderMinimalOrderSummary(snapshot);
    expect(summary).toBe(
      [
        '*Resumen de su pedido* 🧾',
        '',
        '*Productos*',
        '• Ibuprofeno — 500 mg',
        '   2 × $15.00 = *$27.00*',
        '',
        '*Datos del cliente*',
        'Ana Pérez',
        '',
        '*Envío:* recoge en tienda — sin costo',
        '*Total a pagar: $27.00*',
        '',
        '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.',
      ].join('\n'),
    );
    expect(sameMinimalOrder(snapshot, structuredClone(snapshot))).toBe(true);
    expect(sameMinimalOrder(snapshot, withShipping(0))).toBe(false);
    expect(sameMinimalOrder(snapshot, eligible())).toBe(false);
  });
  it.each([
    { customerChargeCents: 6000 },
    { quoteId: 'quote-2' },
    { creditCents: 100 },
    { option: { carrier: 'Otro', service: 'Ground' } },
    { eta: { days: 5 } },
  ])('[S2] changed quote content invalidates exact consent (%j)', (change) => {
    const snapshot = withShipping(5000);
    expect(sameMinimalOrder(snapshot, structuredClone(snapshot))).toBe(true);
    expect(
      sameMinimalOrder(snapshot, {
        ...snapshot,
        shipping: { ...snapshot.shipping, ...change },
      }),
    ).toBe(false);
    expect(sameMinimalOrder(snapshot, eligible())).toBe(false);
  });
});

describe('new address S2/S3/S4/S6', () => {
  it.each([null, CUSTOMER])(
    'enables new address for customer %s',
    (sourceCustomerId) => {
      const draft = { ...newDraft(), sourceCustomerId };
      const verdict = evaluateMinimalOrder({
        confirmedDraft: draft,
        quote: quote(),
      });
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) throw new Error('new eligibility');
      expect(renderMinimalOrderSummary(verdict.snapshot)).toContain(
        'Guardaremos esta dirección con su pedido.',
      );
      expect(renderMinimalOrderSummary(verdict.snapshot)).toContain('Calle 5');
      const changed = structuredClone(verdict.snapshot);
      if (changed.draft === null) throw new Error('draft');
      changed.draft.customer.firstName = 'Otro';
      expect(sameMinimalOrder(verdict.snapshot, changed)).toBe(false);
    },
  );
  it('blocks unmappable confirmed new state', () => {
    const draft = newDraft();
    if (draft.address.kind !== 'new') throw new Error('fixture');
    draft.address.fields.state = 'Texas';
    expect(
      evaluateMinimalOrder({
        confirmedDraft: draft,
        quote: quote(),
      }),
    ).toEqual({ ok: false, reason: 'invalid_state' });
  });
});

describe('evaluateMinimalOrder', () => {
  it('builds a snapshot for a unique customer, saved address and evaluated cart', () => {
    expect(
      evaluateMinimalOrder({ confirmedDraft: savedDraft(), quote: quote() }),
    ).toEqual({
      ok: true,
      snapshot: {
        customerId: CUSTOMER,
        shippingAddressId: ADDRESS,
        draft: savedDraft(),
        items: quote().items,
        totalCents: 2700,
      },
    });
  });

  it.each([
    ['cart_unverified', { confirmedDraft: savedDraft(), quote: null }],
    [
      'empty_cart',
      {
        confirmedDraft: savedDraft(),
        quote: quote({ items: [], totalCents: 0 }),
      },
    ],
    [
      'promotion_review',
      {
        confirmedDraft: savedDraft(),
        quote: quote({ promotionEvaluationStatus: 'needs_human_review' }),
      },
    ],
    ['delivery_unconfirmed', { confirmedDraft: null, quote: quote() }],
    [
      'new_address_unsupported',
      {
        confirmedDraft: { ...savedDraft(), sourceCustomerId: null },
        quote: quote(),
      },
    ],
  ] as const)('rejects %s', (reason, input) => {
    expect(evaluateMinimalOrder(input)).toEqual({ ok: false, reason });
  });

  it('detaches the snapshot from its inputs', () => {
    const draft = savedDraft();
    const items = quote();
    const verdict = evaluateMinimalOrder({
      confirmedDraft: draft,
      quote: items,
    });
    draft.customer.firstName = 'Otro';
    (items.items[0] as { quantity: number }).quantity = 99;
    expect(verdict).toMatchObject({
      ok: true,
      snapshot: {
        draft: { customer: { firstName: 'Ana' } },
        items: [{ quantity: 2 }],
      },
    });
  });
});

describe('renderMinimalOrderSummary', () => {
  it.each([
    ['Oferta', '_Promoción Oferta: ahorra $3.00_'],
    ['Promoción 2x1', '_Promoción 2x1: ahorra $3.00_'],
    [null, '_Descuento: ahorra $3.00_'],
    ['', '_Descuento: ahorra $3.00_'],
    ['   ', '_Descuento: ahorra $3.00_'],
  ])(
    '[message-formatting S2] renders the promotion as an indented italic line (title %j)',
    (title, promotion) => {
      const snapshot = eligible();
      const items = snapshot.items.map((item) => ({
        ...item,
        appliedPromotionTitle: title,
        discountAmountCents: 300,
      }));
      expect(renderMinimalOrderSummary({ ...snapshot, items })).toBe(
        [
          '*Resumen de su pedido* 🧾',
          '',
          '*Productos*',
          '• Ibuprofeno — 500 mg',
          '   2 × $15.00 = *$27.00*',
          `   ${promotion}`,
          '',
          '*Entrega*',
          'Ana Pérez',
          'Av. Juárez 10',
          'Centro, C.P. 06000, Cuauhtémoc, Ciudad de México',
          '',
          '*Total de productos: $27.00*',
          '',
          MINIMAL_ORDER_SUMMARY_CLOSING,
        ].join('\n'),
      );
    },
  );

  it('[S5] keeps a zero-discount summary byte-identical even with a title', () => {
    const snapshot = eligible();
    expect(
      renderMinimalOrderSummary({
        ...snapshot,
        items: snapshot.items.map((item) => ({
          ...item,
          appliedPromotionTitle: 'Not applied',
          discountAmountCents: 0,
        })),
      }),
    ).toBe(renderMinimalOrderSummary(snapshot));
  });

  it('lists items, total and delivery address without a shipping block', () => {
    expect(renderMinimalOrderSummary(eligible())).toBe(
      [
        '*Resumen de su pedido* 🧾',
        '',
        '*Productos*',
        '• Ibuprofeno — 500 mg',
        '   2 × $15.00 = *$27.00*',
        '',
        '*Entrega*',
        'Ana Pérez',
        'Av. Juárez 10',
        'Centro, C.P. 06000, Cuauhtémoc, Ciudad de México',
        '',
        '*Total de productos: $27.00*',
        '',
        MINIMAL_ORDER_SUMMARY_CLOSING,
      ].join('\n'),
    );
  });
});

describe('order summary S2 layout (message formatting F2b)', () => {
  const TU: CustomerStyle = { register: 'tu', emojis: false, tone: 'neutral' };
  const USTED: CustomerStyle = {
    register: 'usted',
    emojis: false,
    tone: 'neutral',
  };
  /** Promotion + pet (T5a) + backorder (T5b), charged shipping with credit/ETA. */
  const threeItems = (): MinimalOrderSnapshot => {
    const draft = savedDraft();
    if (draft.address.kind !== 'saved') throw new Error('fixture');
    draft.address.snapshot.interiorNumber = '4';
    return {
      ...eligible(),
      draft,
      items: [
        {
          productId: PRODUCT,
          name: 'Croquetas Nupec Adulto',
          variantName: '15 kg',
          quantity: 1,
          unitPriceCents: 125000,
          finalPriceCents: 112500,
          appliedPromotionTitle: 'Buen Fin',
          discountAmountCents: 12500,
          pet: { id: 'pet-1', name: 'Max' },
        },
        {
          productId: PRODUCT,
          variantId: VARIANT,
          name: 'Collar',
          variantName: 'Collar Mediana',
          quantity: 2,
          unitPriceCents: 15000,
          finalPriceCents: 30000,
        },
        {
          productId: PRODUCT,
          name: 'Arena',
          variantName: '10 kg',
          quantity: 1,
          unitPriceCents: 48000,
          finalPriceCents: 48000,
          backorder: {
            id: 'bo-1',
            folio: 'BO-000012',
            productName: 'Arena',
            variantName: '10 kg',
            reservedUntil: '2026-12-01T00:00:00.000Z',
          },
        },
      ],
      totalCents: 190500,
      shipping: {
        quoteId: 'quote-1',
        customerChargeCents: 5000,
        creditCents: 12000,
        option: { carrier: 'DHL', service: 'Express' },
        eta: { days: 2 },
      },
    };
  };
  const threeItemsUsted = [
    '*Resumen de su pedido* 🧾',
    '',
    '*Productos*',
    '• Croquetas Nupec Adulto — 15 kg (para Max)',
    '   1 × $1,250.00 = *$1,125.00*',
    '   _Promoción Buen Fin: ahorra $125.00_',
    '• Collar — Mediana',
    '   2 × $150.00 = *$300.00*',
    '• Arena — 10 kg (pedido apartado BO-000012)',
    '   1 × $480.00 = *$480.00*',
    '',
    '*Entrega*',
    'Ana Pérez',
    'Av. Juárez 10, int. 4',
    'Centro, C.P. 06000, Cuauhtémoc, Ciudad de México',
    '',
    '*Total de productos: $1,905.00*',
    '*Envío:* DHL Express — $50.00',
    'Usted tiene un crédito de $120.00 por sus productos (ya descontado del envío)',
    'Llega en aproximadamente 2 días hábiles.',
    '*Total a pagar: $1,955.00*',
    '',
    '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.',
  ].join('\n');

  it('[S2,S3,S4] renders the exact usted summary: promotion, pet, backorder, credit and ETA', () => {
    const summary = renderMinimalOrderSummary(threeItems());
    expect(summary).toBe(threeItemsUsted);
    // Usted customers without emojis receive it byte-identical (S3 title kept).
    expect(applyCustomerStyle(summary, USTED)).toBe(threeItemsUsted);
  });

  it('[S2,S3] renders the exact tú summary with the title emoji and the item indentation', () => {
    expect(
      applyCustomerStyle(renderMinimalOrderSummary(threeItems()), TU),
    ).toBe(
      threeItemsUsted
        .replace('Resumen de su pedido', 'Resumen de tu pedido')
        .replace(
          'Usted tiene un crédito de $120.00 por sus productos',
          'Tienes un crédito de $120.00 por tus productos',
        )
        .replace(
          '¿Está todo bien? Responda *SÍ* para crear el pedido, o dígame qué cambiar.',
          '¿Está todo bien? Responde *SÍ* para crear el pedido, o dime qué cambiar.',
        ),
    );
  });

  it('[S3] keeps the title emoji for a customer with emojis, and caps body emojis as before', () => {
    const styled = applyCustomerStyle(
      `😊😊 Listo\n\n${renderMinimalOrderSummary(threeItems())}`,
      { ...USTED, emojis: true },
    );
    expect(styled.startsWith('😊 Listo\n\n*Resumen de su pedido* 🧾\n')).toBe(
      true,
    );
    expect(styled).toContain('\n   1 × $1,250.00 = *$1,125.00*\n');
  });

  it('[S2] new and corrected addresses keep their note inside the delivery block (usted and tú)', () => {
    const verdict = evaluateMinimalOrder({
      confirmedDraft: newDraft(),
      quote: quote(),
    });
    if (!verdict.ok) throw new Error('fixture');
    const summary = renderMinimalOrderSummary({
      ...verdict.snapshot,
      shipping: { quoteId: 'q', customerChargeCents: 0 },
    });
    const block = [
      '*Entrega*',
      'Ana Pérez',
      'Calle 5 S/N',
      'Roma, C.P. 06700, CDMX, Ciudad de México',
      'Guardaremos esta dirección con su pedido.',
      '',
      '*Envío:* sin costo',
      '*Total a pagar: $27.00*',
    ].join('\n');
    expect(summary).toContain(block);
    expect(applyCustomerStyle(summary, TU)).toContain(
      block.replace('con su pedido.', 'con tu pedido.'),
    );
  });

  it('[S2] the tú pickup summary is fully converted', () => {
    const pickup = evaluateMinimalPickupOrder({
      quote: quote(),
      customerId: CUSTOMER,
      customer: { firstName: 'Ana', lastName: null },
    });
    if (!pickup.ok) throw new Error('fixture');
    expect(
      applyCustomerStyle(renderMinimalOrderSummary(pickup.snapshot), TU),
    ).toBe(
      [
        '*Resumen de tu pedido* 🧾',
        '',
        '*Productos*',
        '• Ibuprofeno — 500 mg',
        '   2 × $15.00 = *$27.00*',
        '',
        '*Datos del cliente*',
        'Ana',
        '',
        '*Envío:* recoge en tienda — sin costo',
        '*Total a pagar: $27.00*',
        '',
        '¿Está todo bien? Responde *SÍ* para crear el pedido, o dime qué cambiar.',
      ].join('\n'),
    );
  });

  it('[S2] the tú STOCK_PENDING ETA line is converted', () => {
    const summary = renderMinimalOrderSummary({
      ...eligible(),
      shipping: {
        quoteId: 'q',
        customerChargeCents: 0,
        eta: { days: null, reason: 'STOCK_PENDING' },
      },
    });
    expect(applyCustomerStyle(summary, TU)).toContain(
      '\nLa fecha de entrega depende de la reposición de existencias; te la confirmamos en cuanto la tengamos.\n',
    );
  });

  it('[S2] the heading constant is found after styling, in usted and tú', () => {
    expect(MINIMAL_ORDER_SUMMARY_HEADING).toBe('*Resumen de su pedido*');
    const summary = renderMinimalOrderSummary(threeItems());
    expect(summary.startsWith(MINIMAL_ORDER_SUMMARY_HEADING)).toBe(true);
    expect(applyCustomerStyle(summary, USTED)).toContain(
      MINIMAL_ORDER_SUMMARY_HEADING,
    );
    expect(applyCustomerStyle(summary, TU)).toContain(
      applyCustomerRegister(MINIMAL_ORDER_SUMMARY_HEADING, TU),
    );
  });

  it('[S2] a usual 3-item delivery summary stays under the 1024-char interactive body limit', () => {
    const summary = renderMinimalOrderSummary(threeItems());
    expect(summary.length).toBeLessThan(1024);
  });
});

describe('order summary fixes (message formatting F2-fix)', () => {
  const withItem = (
    item: Partial<MinimalOrderSnapshot['items'][number]>,
  ): MinimalOrderSnapshot => {
    const snapshot = eligible();
    return {
      ...snapshot,
      items: snapshot.items.map((line) => ({ ...line, ...item })),
    };
  };

  it('[F2-fix G1] catalog names and promotion titles with * _ ~ never break the bold/italic markup', () => {
    const summary = renderMinimalOrderSummary(
      withItem({
        name: 'Croquetas *Premium* _Light_',
        variantName: '~15 kg~',
        appliedPromotionTitle: '2x1_Mayo',
        discountAmountCents: 300,
        pet: { id: 'pet-1', name: 'Max_*' },
      }),
    );
    expect(summary).toContain(
      [
        '• Croquetas Premium Light — 15 kg (para Max)',
        '   2 × $15.00 = *$27.00*',
        '   _Promoción 2x1 Mayo: ahorra $3.00_',
      ].join('\n'),
    );
  });

  it('[F2-fix G1] customer and address values with markup characters are shown plain', () => {
    const draft = savedDraft();
    if (draft.address.kind !== 'saved') throw new Error('fixture');
    draft.customer.firstName = '*Ana*';
    draft.address.snapshot.street = 'Calle_Uno';
    const summary = renderMinimalOrderSummary({ ...eligible(), draft });
    expect(summary).toContain('\nAna Pérez\nCalle Uno 10\n');
  });

  it.each([
    ['Promoción Buen Fin', '_Promoción Buen Fin: ahorra $3.00_'],
    ['Promociones de invierno', '_Promociones de invierno: ahorra $3.00_'],
    ['PROMOCION 2x1', '_PROMOCION 2x1: ahorra $3.00_'],
    ['promo verano', '_promo verano: ahorra $3.00_'],
    ['Promo', '_Promo: ahorra $3.00_'],
    ['Promotores', '_Promoción Promotores: ahorra $3.00_'],
    ['Buen Fin', '_Promoción Buen Fin: ahorra $3.00_'],
  ])(
    '[F2-fix G2] never doubles the promotion prefix (title %j)',
    (title, line) => {
      expect(
        renderMinimalOrderSummary(
          withItem({ appliedPromotionTitle: title, discountAmountCents: 300 }),
        ),
      ).toContain(`\n   ${line}\n`);
    },
  );

  it('[F2-fix G4] «Total de productos» is bold whether or not shipping is charged', () => {
    const charged = renderMinimalOrderSummary({
      ...eligible(),
      shipping: { quoteId: 'q', customerChargeCents: 5000 },
    });
    expect(charged).toContain('\n*Total de productos: $27.00*\n');
    expect(renderMinimalOrderSummary(eligible())).toContain(
      '\n*Total de productos: $27.00*\n',
    );
  });

  it('[F2-fix G4] a pickup without a customer name leaves no empty «Datos del cliente» section', () => {
    const pickup = evaluateMinimalPickupOrder({
      quote: quote(),
      customerId: CUSTOMER,
      customer: { firstName: ' ', lastName: null },
    });
    if (!pickup.ok) throw new Error('fixture');
    expect(renderMinimalOrderSummary(pickup.snapshot)).toBe(
      [
        '*Resumen de su pedido* 🧾',
        '',
        '*Productos*',
        '• Ibuprofeno — 500 mg',
        '   2 × $15.00 = *$27.00*',
        '',
        '*Envío:* recoge en tienda — sin costo',
        '*Total a pagar: $27.00*',
        '',
        MINIMAL_ORDER_SUMMARY_CLOSING,
      ].join('\n'),
    );
  });
});

describe('sameMinimalOrder', () => {
  it.each([
    { appliedPromotionTitle: 'Renamed offer', discountAmountCents: 300 },
    { appliedPromotionTitle: 'Oferta', discountAmountCents: 400 },
  ])('[S5] binds displayed promotion metadata to consent (%j)', (change) => {
    const snapshot = eligible();
    const discounted = {
      ...snapshot,
      items: snapshot.items.map((item) => ({
        ...item,
        appliedPromotionTitle: 'Oferta',
        discountAmountCents: 300,
      })),
    };
    expect(sameMinimalOrder(discounted, structuredClone(discounted))).toBe(
      true,
    );
    expect(
      sameMinimalOrder(discounted, {
        ...discounted,
        items: discounted.items.map((item) => ({ ...item, ...change })),
      }),
    ).toBe(false);
  });

  it('matches only identical content', () => {
    const changed = eligible();
    (changed as { totalCents: number }).totalCents = 2800;
    expect(sameMinimalOrder(eligible(), eligible())).toBe(true);
    expect(sameMinimalOrder(eligible(), changed)).toBe(false);
  });
});

describe('MinimalOrderConfirmation', () => {
  let now = 1_000;
  const make = () => new MinimalOrderConfirmation({ now: () => now });
  beforeEach(() => {
    now = 1_000;
  });

  const offer = (confirmation: MinimalOrderConfirmation) => {
    const prepared = confirmation.prepare({
      senderId: SENDER,
      inboundEvent: EVENT('wamid.offer'),
      snapshot: eligible(),
    });
    if (prepared.kind !== 'offer') throw new Error('expected offer');
    return prepared;
  };

  it('offers the server-owned summary only with a trusted inbound identity', () => {
    const confirmation = make();
    expect(
      confirmation.prepare({
        senderId: SENDER,
        inboundEvent: undefined,
        snapshot: eligible(),
      }),
    ).toEqual({ kind: 'blocked', reason: 'identity_unbound' });
    const prepared = offer(confirmation);
    expect(prepared.reply).toBe(renderMinimalOrderSummary(eligible()));
  });

  it('turns a strict armed SÍ into a one-shot candidate', () => {
    const confirmation = make();
    offer(confirmation).onSent();
    const consumed = confirmation.consume({
      senderId: SENDER,
      text: ' Sí. ',
      inboundEvent: EVENT('wamid.yes'),
    });
    expect(consumed).toMatchObject({
      kind: 'candidate',
      snapshot: eligible(),
    });
    expect(typeof (consumed as { reference: unknown }).reference).toBe(
      'string',
    );
    expect(
      confirmation.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT('wamid.yes2'),
      }),
    ).toBeNull();
    expect(confirmation.status(SENDER)).toBeNull();
  });

  it('never confirms an unarmed, foreign-phone or expired offer', () => {
    const confirmation = make();
    offer(confirmation);
    const yes = (messageId: string, extra: Record<string, string> = {}) =>
      confirmation.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT(messageId, extra),
      });
    expect(yes('wamid.1')).toEqual({
      kind: 'handled',
      reply: MINIMAL_ORDER_AMBIGUOUS_REPLY,
    });
    offer(confirmation).onSent();
    expect(
      yes('wamid.2', { receivingPhoneNumberId: '999999999999999' }),
    ).toEqual({ kind: 'handled', reply: MINIMAL_ORDER_AMBIGUOUS_REPLY });
    offer(confirmation).onSent();
    now += MINIMAL_ORDER_CONFIRMATION_TTL_MS;
    expect(yes('wamid.3')).toEqual({
      kind: 'handled',
      reply: MINIMAL_ORDER_AMBIGUOUS_REPLY,
    });
    expect(confirmation.status(SENDER)).toBeNull();
  });

  it('drops the offer after a rejected affirmative so a later SÍ cannot sell', () => {
    const yes = (
      confirmation: MinimalOrderConfirmation,
      messageId: string,
      extra: Record<string, string> = {},
    ) =>
      confirmation.consume({
        senderId: SENDER,
        text: 'SÍ',
        inboundEvent: EVENT(messageId, extra),
      });
    const unarmed = make();
    const early = offer(unarmed);
    expect(yes(unarmed, 'wamid.1')).toEqual({
      kind: 'handled',
      reply: MINIMAL_ORDER_AMBIGUOUS_REPLY,
    });
    early.onSent();
    expect(yes(unarmed, 'wamid.2')).toBeNull();
    expect(unarmed.status(SENDER)).toBeNull();

    const foreign = make();
    offer(foreign).onSent();
    expect(
      yes(foreign, 'wamid.3', { receivingPhoneNumberId: '999999999999999' }),
    ).toEqual({ kind: 'handled', reply: MINIMAL_ORDER_AMBIGUOUS_REPLY });
    expect(yes(foreign, 'wamid.4')).toBeNull();
    expect(foreign.status(SENDER)).toBeNull();
  });

  it('leaves mixed or unrelated text to other routes and drops the offer', () => {
    for (const text of [
      'Sí, pero quite uno',
      'sí y agrega otro',
      '¿sí incluye envío?',
      'SÍ\nquite uno',
    ]) {
      const confirmation = make();
      offer(confirmation).onSent();
      expect(
        confirmation.consume({
          senderId: SENDER,
          text,
          inboundEvent: EVENT('wamid.x'),
        }),
      ).toBeNull();
      expect(confirmation.status(SENDER)).toBeNull();
      // A later SÍ answers something else, never the dropped summary.
      expect(
        confirmation.consume({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: EVENT('wamid.later'),
        }),
      ).toBeNull();
    }
  });

  it.each(['Sí, por favor 🙏', 'claro', 'ok', 'okay', 'va', 'SÍ\nSÍ', 'si!'])(
    'turns the natural affirmative %j into the one-shot candidate',
    (text) => {
      const confirmation = make();
      offer(confirmation).onSent();
      expect(
        confirmation.consume({
          senderId: SENDER,
          text,
          inboundEvent: EVENT('wamid.yes'),
        }),
      ).toMatchObject({ kind: 'candidate', snapshot: eligible() });
      expect(confirmation.status(SENDER)).toBeNull();
    },
  );

  it.each(['no', 'no gracias', 'Mejor no.', '👎'])(
    'declines on %j without a candidate and drops the offer',
    (text) => {
      const confirmation = make();
      offer(confirmation).onSent();
      expect(
        confirmation.consume({
          senderId: SENDER,
          text,
          inboundEvent: EVENT('wamid.no'),
        }),
      ).toEqual({ kind: 'handled', reply: MINIMAL_ORDER_DECLINED_REPLY });
      expect(confirmation.status(SENDER)).toBeNull();
      expect(
        confirmation.consume({
          senderId: SENDER,
          text: 'SÍ',
          inboundEvent: EVENT('wamid.later'),
        }),
      ).toBeNull();
    },
  );

  it('re-offers on an origin replay without confirming', () => {
    const confirmation = make();
    offer(confirmation).onSent();
    const replay = confirmation.consume({
      senderId: SENDER,
      text: 'SÍ',
      inboundEvent: EVENT('wamid.offer'),
    });
    expect(replay).toMatchObject({
      kind: 'reoffer',
      reply: renderMinimalOrderSummary(eligible()),
    });
  });

  it('a replaced offer callback cannot arm the new offer', () => {
    const confirmation = make();
    const first = offer(confirmation);
    offer(confirmation);
    first.onSent();
    expect(confirmation.status(SENDER)).toMatchObject({ armed: false });
  });

  it('ignores another sender', () => {
    const confirmation = make();
    offer(confirmation).onSent();
    expect(
      confirmation.consume({
        senderId: '5215550002222',
        text: 'SÍ',
        inboundEvent: EVENT('wamid.y', { senderId: '5215550002222' }),
      }),
    ).toBeNull();
  });

  it('cancel drops the pending offer', () => {
    const confirmation = make();
    offer(confirmation).onSent();
    confirmation.cancel(SENDER);
    expect(confirmation.status(SENDER)).toBeNull();
  });
});
