import type { SkydropxQuotationPayload } from './skydropx-quotation.client';
import { mapSkydropxQuotationRequest } from './skydropx-request.mapper';

type Rec = Record<string, unknown>;
const SECRET = 'SECRET_SENTINEL_7f';
const map = mapSkydropxQuotationRequest;
const ok = (value: unknown): SkydropxQuotationPayload => {
  const out = map(value);
  if (out === null) throw new Error('expected a wire payload');
  return out;
};
const addr = (over: Rec = {}): Rec => ({
  countryCode: 'MX',
  postalCode: '64000',
  state: 'Nuevo León',
  municipality: 'Monterrey',
  neighborhood: 'Centro (Área 1)',
  ...over,
});
const pac = (over: Rec = {}): Rec => ({
  lengthCm: 20,
  widthCm: 15,
  heightCm: 10,
  weightGrams: 2500,
  ...over,
});
const req = (over: Rec = {}): Rec => ({
  origin: addr({
    postalCode: '06000',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
  }),
  destination: addr(),
  parcels: [pac()],
  ...over,
});
const boom = (): never => {
  throw new Error('boom');
};
const once = <T>(first: T, second: T): (() => T) => {
  let used = false;
  return () => {
    if (used) return second;
    used = true;
    return first;
  };
};
const FORBIDDEN =
  'package package_type mass_unit dimension_unit package_protected declared_value requested_carriers order_id template_id tax_id street name phone email token apiKey'.split(
    ' ',
  );
class Req {}
class Addr {}
class Parc {}

describe('mapSkydropxQuotationRequest', () => {
  it('maps a canonical request to an exact fresh frozen wire payload', () => {
    const origin = addr({ postalCode: '06000' });
    const input = { origin, destination: addr(), parcels: [pac()] };
    const out = ok(input);
    expect(out).toEqual({
      quotation: {
        address_from: {
          country_code: 'MX',
          postal_code: '06000',
          area_level1: 'Nuevo León',
          area_level2: 'Monterrey',
          area_level3: 'Centro (Área 1)',
        },
        address_to: {
          country_code: 'MX',
          postal_code: '64000',
          area_level1: 'Nuevo León',
          area_level2: 'Monterrey',
          area_level3: 'Centro (Área 1)',
        },
        parcels: [{ length: 20, width: 15, height: 10, weight: 2.5 }],
      },
    });
    expect(out).not.toBe(input);
    expect(out.quotation.address_from).not.toBe(origin);
    origin.postalCode = '99999';
    origin.neighborhood = 'Otro';
    input.parcels[0].weightGrams = 1;
    input.parcels.push(pac());
    expect(out.quotation.address_from.postal_code).toBe('06000');
    expect(out.quotation.parcels).toHaveLength(1);
    expect(out.quotation.parcels[0].weight).toBe(2.5);
    expect(Object.isFrozen(out.quotation.parcels[0])).toBe(true);
    expect(Reflect.set(out.quotation.address_from, 'country_code', 'US')).toBe(
      false,
    );
    expect(() =>
      (out.quotation.parcels as unknown as unknown[]).push(pac()),
    ).toThrow();
  });

  it('preserves order, dimensions, and gram-to-kg boundaries exactly', () => {
    const out = ok(
      req({
        parcels: [
          pac({ lengthCm: 1, widthCm: 2, heightCm: 3, weightGrams: 1 }),
          pac({ lengthCm: 40, widthCm: 50, heightCm: 60, weightGrams: 999 }),
          pac({ weightGrams: 1000 }),
          pac({ weightGrams: 1001 }),
          pac({ weightGrams: 25000 }),
        ],
      }),
    );
    expect(out.quotation.parcels).toEqual([
      { length: 1, width: 2, height: 3, weight: 0.001 },
      { length: 40, width: 50, height: 60, weight: 0.999 },
      { length: 20, width: 15, height: 10, weight: 1 },
      { length: 20, width: 15, height: 10, weight: 1.001 },
      { length: 20, width: 15, height: 10, weight: 25 },
    ]);
  });

  it('maps exact address keys including Unicode catalog values', () => {
    const out = ok(
      req({
        origin: addr({
          state: 'Nuevo León',
          municipality: 'Monterrey',
          neighborhood: 'Centro (Área 1)',
        }),
      }),
    );
    expect(out.quotation.address_from).toEqual({
      country_code: 'MX',
      postal_code: '64000',
      area_level1: 'Nuevo León',
      area_level2: 'Monterrey',
      area_level3: 'Centro (Área 1)',
    });
  });

  it('rejects primitives, classes, invalid fields, and sparse arrays', () => {
    const sparseTrailing = new Array(2) as unknown[];
    sparseTrailing[0] = pac();
    const sparseLeading = new Array(2) as unknown[];
    sparseLeading[1] = pac();
    const invalid: unknown[] = [
      undefined,
      null,
      0,
      NaN,
      '',
      'request',
      true,
      [],
      [req()],
      {},
      () => undefined,
      Symbol('x'),
      new Req(),
      new Addr(),
      new Parc(),
      req({ origin: null }),
      req({ destination: undefined }),
      req({ origin: new Addr() }),
      req({ parcels: [] }),
      req({ parcels: 'x' }),
      req({ parcels: [undefined] }),
      req({ parcels: new Parc() }),
      req({ parcels: sparseTrailing }),
      req({ parcels: sparseLeading }),
      req({ origin: addr({ countryCode: 'mx' }) }),
      req({ origin: addr({ countryCode: 'MEX' }) }),
      req({ origin: addr({ postalCode: ' 64000' }) }),
      req({ origin: addr({ postalCode: 'x'.repeat(13) }) }),
      req({ origin: addr({ state: '' }) }),
      req({ parcels: [pac({ lengthCm: 0 })] }),
      req({ parcels: [pac({ widthCm: -1 })] }),
      req({ parcels: [pac({ heightCm: 1.5 })] }),
      req({ parcels: [pac({ weightGrams: 0 })] }),
      req({ parcels: [pac({ weightGrams: NaN })] }),
    ];
    for (const value of invalid) expect(map(value)).toBeNull();
  });

  it('fails closed on throwing getters and hostile proxy traps', () => {
    const throwingParcels = req();
    Object.defineProperty(throwingParcels, 'parcels', { get: boom });
    const throwingState = addr();
    Object.defineProperty(throwingState, 'state', { get: boom });
    const hostile: unknown[] = [
      throwingParcels,
      req({ origin: throwingState }),
      new Proxy({}, { getPrototypeOf: boom }),
      new Proxy({}, { get: boom }),
    ];
    for (const value of hostile) {
      expect(() => map(value)).not.toThrow();
      expect(map(value)).toBeNull();
    }
  });

  it('reads each field, container length, and element exactly once', () => {
    const stateful = addr();
    Object.defineProperty(stateful, 'postalCode', {
      get: once('06000', 'mutated'),
    });
    const fieldOut = ok(req({ origin: stateful }));
    expect(fieldOut.quotation.address_from.postal_code).toBe('06000');

    const lengthGetter = once(1, 0);
    const lengthProxy = new Proxy([pac()], {
      get: (target, prop, receiver) =>
        prop === 'length'
          ? lengthGetter()
          : (Reflect.get(target, prop, receiver) as unknown),
    });
    expect(ok(req({ parcels: lengthProxy })).quotation.parcels).toHaveLength(1);

    const indexGetter = once(pac(), null);
    const indexProxy = new Proxy([pac()], {
      get: (target, prop, receiver) =>
        prop === '0'
          ? indexGetter()
          : (Reflect.get(target, prop, receiver) as unknown),
    });
    const indexOut = ok(req({ parcels: indexProxy }));
    expect(indexOut.quotation.parcels[0].length).toBe(20);
  });

  it('strips sentinels and every forbidden provider field', () => {
    const out = ok(
      req({
        token: SECRET,
        apiKey: SECRET,
        package: { weight_unit: SECRET },
        origin: addr({
          name: SECRET,
          phone: SECRET,
          street: SECRET,
          email: SECRET,
        }),
        parcels: [
          pac({
            declared_value: SECRET,
            package_type: SECRET,
            mass_unit: SECRET,
          }),
        ],
      }),
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    for (const key of FORBIDDEN) expect(json).not.toContain(`"${key}"`);
  });
});
