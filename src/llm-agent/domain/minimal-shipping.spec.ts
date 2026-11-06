import { createHash } from 'node:crypto';
import type { ShippingQuoteResponse } from '../../chatbot-api/domain/dtos/shipping-quote.dto';
import {
  buildMinimalShippingQuote,
  isShippingCurrent,
  minimalShippingDestination,
  minimalShippingQuoteSchema,
} from './minimal-shipping';

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const ADDRESS = '22222222-2222-4222-8222-222222222222';
const VERSION = '2026-06-22T12:00:00.000Z';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const EXPIRES = '2026-11-05T12:30:00.000Z';
const lines = [
  {
    productId: PRODUCT,
    quantity: 2,
    unitPriceCents: 50001,
    finalPriceCents: 100002,
  },
];
const response = (
  overrides: Record<string, unknown> = {},
): ShippingQuoteResponse => ({
  quoteId: 'quote-1',
  expiresAt: EXPIRES,
  zoneStatus: 'CARRIER_ONLY',
  option: { carrier: 'Envíos Perros', service: 'Estándar', etaDays: 3 },
  costCents: 30000,
  creditCents: 24000,
  customerChargeCents: 6000,
  currency: 'MXN',
  eta: { days: 3, reason: null },
  ...overrides,
});
const savedAddress = {
  kind: 'saved' as const,
  snapshot: {
    id: ADDRESS,
    version: VERSION,
    label: 'Casa',
    street: 'Juárez',
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
};
const newFields = {
  label: null,
  street: 'Juárez',
  exteriorNumber: '10',
  interiorNumber: null,
  zipCode: '06000',
  neighborhood: 'Centro',
  municipality: null,
  city: 'Cuauhtémoc',
  state: 'Ciudad de México',
  visualReferences: null,
  carrierPhone: null,
};
function record(overrides: Record<string, unknown> = {}) {
  const built = buildMinimalShippingQuote({
    response: response(overrides),
    cartLines: lines,
    destination: minimalShippingDestination(savedAddress),
  });
  if (built === null) throw new Error('valid fixture rejected');
  return built;
}
const context = () => ({
  cartLines: structuredClone(lines),
  address: savedAddress,
  nowMs: NOW,
});

describe('Minimal shipping backend quote record (U3)', () => {
  it('[S2,S3] stores the backend-signed quote as returned, with cart and destination pins', () => {
    expect(record({ eta: { days: null, reason: 'STOCK_PENDING' } })).toEqual({
      quoteId: 'quote-1',
      expiresAt: EXPIRES,
      zoneStatus: 'CARRIER_ONLY',
      option: { carrier: 'Envíos Perros', service: 'Estándar', etaDays: 3 },
      costCents: 30000,
      creditCents: 24000,
      customerChargeCents: 6000,
      currency: 'MXN',
      eta: { days: null, reason: 'STOCK_PENDING' },
      destinationPin: { kind: 'saved', addressId: ADDRESS, version: VERSION },
      cartPin: lines,
    });
    expect(record()).toHaveProperty('eta', { days: 3, reason: null });
    expect(record()).not.toHaveProperty('approval');
  });

  it.each(['FREE', 'SURCHARGE', 'CARRIER_ONLY', 'PENDING', 'DENIED'] as const)(
    'stores a %s quote',
    (zoneStatus) => {
      const undeliverable = zoneStatus === 'PENDING' || zoneStatus === 'DENIED';
      const built = record({
        zoneStatus,
        ...(undeliverable
          ? {
              quoteId: null,
              expiresAt: null,
              option: null,
              costCents: 0,
              creditCents: 0,
              customerChargeCents: 0,
            }
          : {}),
      });
      expect(built.zoneStatus).toBe(zoneStatus);
      expect(isShippingCurrent(built, context())).toBe(
        undeliverable ? 'undeliverable' : 'current',
      );
    },
  );

  it('rejects a deliverable zone without quoteId and records that fail the strict schema', () => {
    expect(
      buildMinimalShippingQuote({
        response: response({ quoteId: null }),
        cartLines: lines,
        destination: minimalShippingDestination(savedAddress),
      }),
    ).toBeNull();
    expect(
      buildMinimalShippingQuote({
        response: response(),
        cartLines: [],
        destination: minimalShippingDestination(savedAddress),
      }),
    ).toBeNull();
    expect(
      minimalShippingQuoteSchema.safeParse({
        ...record(),
        approval: { state: 'approved' },
      }).success,
    ).toBe(false);
  });

  it('[U1b] rejects a stored deliverable quote without expiresAt', () => {
    expect(
      minimalShippingQuoteSchema.safeParse({ ...record(), expiresAt: null })
        .success,
    ).toBe(false);
  });

  it('[U1b] still reads a stored quote from before eta.reason was always present', () => {
    expect(
      minimalShippingQuoteSchema.safeParse({ ...record(), eta: { days: 3 } })
        .success,
    ).toBe(true);
    expect(
      minimalShippingQuoteSchema.safeParse({ ...record(), eta: null }).success,
    ).toBe(true);
  });

  it('[S2] uses the backend expiresAt; at or after it the quote is expired', () => {
    expect(
      isShippingCurrent(record(), {
        ...context(),
        nowMs: Date.parse(EXPIRES) - 1,
      }),
    ).toBe('current');
    expect(
      isShippingCurrent(record(), { ...context(), nowMs: Date.parse(EXPIRES) }),
    ).toBe('expired');
    expect(isShippingCurrent(record(), { ...context(), nowMs: NaN })).toBe(
      'expired',
    );
  });

  it('a cart change after the quote is stale', () => {
    for (const cartLines of [
      [{ ...lines[0], quantity: 3, finalPriceCents: 150003 }],
      [{ ...lines[0], finalPriceCents: 90000 }],
      [{ ...lines[0], variantId: VARIANT }],
      [...lines, { ...lines[0], productId: VARIANT }],
    ])
      expect(isShippingCurrent(record(), { ...context(), cartLines })).toBe(
        'stale',
      );
  });

  it('an address change after the quote is stale', () => {
    expect(
      isShippingCurrent(record(), {
        ...context(),
        address: {
          ...savedAddress,
          snapshot: { ...savedAddress.snapshot, version: EXPIRES },
        },
      }),
    ).toBe('stale');
    const fresh = buildMinimalShippingQuote({
      response: response(),
      cartLines: lines,
      destination: minimalShippingDestination({
        kind: 'new',
        fields: newFields,
      }),
    })!;
    expect(
      isShippingCurrent(fresh, {
        ...context(),
        address: { kind: 'new', fields: newFields },
      }),
    ).toBe('current');
    expect(
      isShippingCurrent(fresh, {
        ...context(),
        address: { kind: 'new', fields: { ...newFields, zipCode: '06001' } },
      }),
    ).toBe('stale');
  });

  it('binds NEW quotes to canonical confirmed fields', () => {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          newFields.street,
          newFields.exteriorNumber,
          newFields.interiorNumber,
          newFields.zipCode,
          newFields.neighborhood,
          newFields.municipality,
          newFields.city,
          newFields.state,
        ]),
      )
      .digest('hex');
    expect(
      minimalShippingDestination({ kind: 'new', fields: newFields }),
    ).toEqual({ kind: 'new', fingerprint });
  });
});
