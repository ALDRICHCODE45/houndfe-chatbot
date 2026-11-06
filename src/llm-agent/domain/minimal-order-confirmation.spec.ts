import type { MinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import {
  MINIMAL_ORDER_AMBIGUOUS_REPLY,
  MINIMAL_ORDER_CONFIRMATION_TTL_MS,
  MinimalOrderConfirmation,
  evaluateMinimalOrder,
  renderMinimalOrderSummary,
  sameMinimalOrder,
  type MinimalOrderQuote,
  type MinimalOrderSnapshot,
} from './minimal-order-confirmation';

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
    expect(summary).toContain('Total de productos: $27.00 MXN');
    expect(summary).toContain('Envío: $50.00 MXN');
    expect(summary).toContain('Total a pagar: $77.00 MXN');
    expect(summary).not.toContain('no está incluido');
    expect(summary).toContain(
      'Responda "SÍ" para crear el pedido, o dígame qué quiere cambiar.',
    );
  });
  it('[S3] presents a zero charge as shipping without cost and no extra total', () => {
    const summary = renderMinimalOrderSummary(withShipping(0));
    expect(summary).toContain('Total de productos: $27.00 MXN');
    expect(summary).toContain('Envío: sin costo para usted');
    expect(summary).not.toContain('Total a pagar');
    expect(summary).not.toContain('no está incluido');
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
    expect(summary).toContain('Envío con Envíos Perros (Estándar): $30.00 MXN');
    expect(summary).toContain(
      'Usted tiene un crédito de $120.00 MXN por sus productos',
    );
    expect(summary).toContain('Llega en aproximadamente 3 días hábiles');
    expect(summary).toContain('Total a pagar: $57.00 MXN');
    expect(summary).toContain('Entrega a: Ana Pérez, Av. Juárez 10');
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
    expect(summary).toContain('Envío: $30.00 MXN');
    expect(summary).not.toContain('crédito');
    expect(summary).toContain(
      'La fecha de entrega depende de la reposición de existencias; se la confirmamos en cuanto la tengamos.',
    );
    expect(summary).not.toContain('Llega en');
  });
  it('[S4] pickup says the customer picks it up in store with no shipping cost', () => {
    const snapshot: MinimalOrderSnapshot = {
      ...eligible(),
      shipping: { mode: 'pickup' },
    };
    const summary = renderMinimalOrderSummary(snapshot);
    expect(summary).toContain('Recoge en tienda (sin costo de envío)');
    expect(summary).toContain('Total de productos: $27.00 MXN');
    expect(summary).not.toContain('Entrega a:');
    expect(summary).not.toContain('Total a pagar');
    expect(summary).not.toContain('no está incluido');
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
    ['Oferta', 'promoción: Oferta, ahorro'],
    [null, 'descuento: ahorro'],
    ['', 'descuento: ahorro'],
    ['   ', 'descuento: ahorro'],
  ])('[S5] renders the exact discounted summary (title %j)', (title, label) => {
    const snapshot = eligible();
    const items = snapshot.items.map((item) => ({
      ...item,
      appliedPromotionTitle: title,
      discountAmountCents: 300,
    }));
    expect(renderMinimalOrderSummary({ ...snapshot, items })).toBe(
      [
        'Resumen de su pedido:',
        `• Ibuprofeno — 500 mg: 2 × $15.00 MXN; importe $27.00 MXN (${label} $3.00 MXN)`,
        'Total de productos: $27.00 MXN',
        'Entrega a: Ana Pérez, Av. Juárez 10, Centro, C.P. 06000, Cuauhtémoc, Ciudad de México',
        'El envío no está incluido en este total y se coordinará por separado.',
        '',
        'Responda "SÍ" para crear el pedido, o dígame qué quiere cambiar.',
      ].join('\n'),
    );
  });

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

  it('lists items, total, delivery address and the no-shipping notice', () => {
    expect(renderMinimalOrderSummary(eligible())).toBe(
      [
        'Resumen de su pedido:',
        '• Ibuprofeno — 500 mg: 2 × $15.00 MXN; importe $27.00 MXN',
        'Total de productos: $27.00 MXN',
        'Entrega a: Ana Pérez, Av. Juárez 10, Centro, C.P. 06000, Cuauhtémoc, Ciudad de México',
        'El envío no está incluido en este total y se coordinará por separado.',
        '',
        'Responda "SÍ" para crear el pedido, o dígame qué quiere cambiar.',
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
    for (const text of ['Sí, pero quite uno', 'no', 'SÍ\nSÍ', 'okay']) {
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
