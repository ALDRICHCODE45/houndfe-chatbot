import {
  normalizeDeliveryZoneIntake,
  normalizeDeliveryZoneRequester,
  type DeliveryZoneIntakeInput,
} from './human-decisions-delivery-zone.dto';

const SOURCE = '6f1c2b8e-3a4d-4e5f-9a0b-1c2d3e4f5a6b';
const REQUESTER = 'c41b2c3d-1111-4222-8333-444455556666';
const DECISION = '8a2f0000-1111-4222-8333-444455556666';

const intake = (
  patch: Partial<Record<keyof DeliveryZoneIntakeInput, unknown>> = {},
): Record<string, unknown> => ({
  sourceRequestId: SOURCE,
  type: 'DELIVERY_ZONE',
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
  phoneCountryCode: '52',
  phone: '5512345678',
  conversationRef: 'wa:5215512345678',
  lastCustomerMessageAt: '2026-11-05T10:00:00.000Z',
  ...patch,
});

function without(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

const snapshot = {
  branchName: 'Sucursal Centro',
  zipCode: '06700',
  state: 'Ciudad de México',
  municipality: 'Cuauhtémoc',
  neighborhood: 'Roma Norte',
};
const pending = (patch: Record<string, unknown> = {}) => ({
  id: REQUESTER,
  sourceRequestId: SOURCE,
  type: 'DELIVERY_ZONE',
  status: 'PENDING',
  version: 1,
  createdAt: '2026-11-05T10:01:00.000Z',
  decisionId: DECISION,
  snapshot,
  resolution: null,
  applyBefore: null,
  ...patch,
});
const resolved = (
  resolution: Record<string, unknown>,
  patch: Record<string, unknown> = {},
) =>
  pending({
    status: 'RESOLVED',
    version: 2,
    resolution: { resolvedAt: '2026-11-05T18:00:00.000Z', ...resolution },
    applyBefore: '2026-11-06T18:00:00.000Z',
    ...patch,
  });

describe('normalizeDeliveryZoneIntake', () => {
  it('accepts the exact contract body', () => {
    expect(normalizeDeliveryZoneIntake(intake())).toEqual(intake());
  });

  it('collapses whitespace in the place names', () => {
    expect(
      normalizeDeliveryZoneIntake(intake({ neighborhood: '  Roma   Norte ' })),
    ).toEqual(intake());
  });

  it.each([
    ['extra key', { ...intake(), extra: 1 }],
    ['missing key', without(intake(), 'phone')],
    ['wrong type', intake({ type: 'RESTOCK' })],
    ['non-uuid source', intake({ sourceRequestId: 'abc' })],
    ['4-digit zip', intake({ zipCode: '0670' })],
    ['blank state', intake({ state: '   ' })],
    ['121-char municipality', intake({ municipality: 'a'.repeat(121) })],
    ['control char', intake({ neighborhood: 'Roma\u0000' })],
    ['+ in country code', intake({ phoneCountryCode: '+52' })],
    ['non-digit phone', intake({ phone: '55-1234' })],
    ['long conversationRef', intake({ conversationRef: 'x'.repeat(201) })],
    ['non-UTC instant', intake({ lastCustomerMessageAt: '2026-11-05' })],
  ])('rejects %s', (_label, value) => {
    expect(normalizeDeliveryZoneIntake(value)).toBeNull();
  });
});

describe('normalizeDeliveryZoneRequester', () => {
  it('parses PENDING with null resolution and applyBefore', () => {
    expect(normalizeDeliveryZoneRequester(pending())).toEqual(pending());
  });

  it('rejects PENDING carrying a resolution or applyBefore', () => {
    expect(
      normalizeDeliveryZoneRequester(
        pending({ applyBefore: '2026-11-06T18:00:00.000Z' }),
      ),
    ).toBeNull();
    expect(
      normalizeDeliveryZoneRequester(
        pending({
          resolution: {
            source: 'VALIDATION',
            zoneType: 'FREE',
            resolvedAt: '2026-11-05T18:00:00.000Z',
          },
        }),
      ),
    ).toBeNull();
  });

  it('parses RESOLVED SURCHARGE with surcharge and eta', () => {
    const value = resolved({
      source: 'VALIDATION',
      zoneType: 'SURCHARGE',
      surchargeCents: 4500,
      etaDays: 2,
    });
    expect(normalizeDeliveryZoneRequester(value)).toEqual(value);
  });

  it('parses RESOLVED FREE with surcharge and eta omitted', () => {
    const value = resolved({ source: 'VALIDATION', zoneType: 'FREE' });
    const parsed = normalizeDeliveryZoneRequester(value);
    expect(parsed).toEqual(value);
    expect(parsed?.resolution).not.toHaveProperty('surchargeCents');
    expect(parsed?.resolution).not.toHaveProperty('etaDays');
  });

  it.each(['DENIED', 'CARRIER_ONLY'])(
    'parses RESOLVED %s without surcharge or eta',
    (zoneType) => {
      const value = resolved({ source: 'VALIDATION', zoneType });
      expect(normalizeDeliveryZoneRequester(value)).toEqual(value);
    },
  );

  it.each(['DENIED', 'CARRIER_ONLY'])(
    'rejects RESOLVED %s carrying a surcharge or eta',
    (zoneType) => {
      expect(
        normalizeDeliveryZoneRequester(
          resolved({ source: 'VALIDATION', zoneType, surchargeCents: 100 }),
        ),
      ).toBeNull();
      expect(
        normalizeDeliveryZoneRequester(
          resolved({ source: 'VALIDATION', zoneType, etaDays: 2 }),
        ),
      ).toBeNull();
    },
  );

  it('parses an EXISTING_ZONE resolution with a null decisionId', () => {
    const value = resolved(
      { source: 'EXISTING_ZONE', zoneType: 'FREE', etaDays: 1 },
      { decisionId: null },
    );
    expect(normalizeDeliveryZoneRequester(value)).toEqual(value);
  });

  it.each([
    ['null surcharge', { surchargeCents: null }],
    ['negative eta', { etaDays: -1 }],
    ['unknown zoneType', { zoneType: 'MAYBE' }],
    ['unknown source', { source: 'HUMAN' }],
    ['extra resolution key', { note: 'x' }],
  ])('rejects RESOLVED with %s', (_label, patch) => {
    expect(
      normalizeDeliveryZoneRequester(
        resolved({ source: 'VALIDATION', zoneType: 'SURCHARGE', ...patch }),
      ),
    ).toBeNull();
  });

  it('rejects applyBefore that is not resolvedAt + 24h', () => {
    expect(
      normalizeDeliveryZoneRequester(
        resolved(
          { source: 'VALIDATION', zoneType: 'FREE' },
          { applyBefore: '2026-11-05T19:00:00.000Z' },
        ),
      ),
    ).toBeNull();
  });

  it('rejects RESOLVED with version 1 and an unknown status', () => {
    expect(
      normalizeDeliveryZoneRequester(
        resolved({ source: 'VALIDATION', zoneType: 'FREE' }, { version: 1 }),
      ),
    ).toBeNull();
    expect(
      normalizeDeliveryZoneRequester(pending({ status: 'OPEN' })),
    ).toBeNull();
  });

  it('rejects extra or missing top-level and snapshot keys', () => {
    expect(normalizeDeliveryZoneRequester({ ...pending(), x: 1 })).toBeNull();
    expect(
      normalizeDeliveryZoneRequester(without(pending(), 'decisionId')),
    ).toBeNull();
    expect(
      normalizeDeliveryZoneRequester(
        pending({ snapshot: { ...snapshot, phone: '5512345678' } }),
      ),
    ).toBeNull();
  });
});
