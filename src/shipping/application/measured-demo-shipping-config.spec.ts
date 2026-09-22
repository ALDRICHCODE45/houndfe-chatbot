import {
  MAX_MEASURED_DEMO_PROFILE_JSON_CODE_UNITS as MAX,
  MEASURED_DEMO_SHIPPING_CONFIG as TOKEN,
  resolveMeasuredDemoShippingConfig as resolve,
  type MeasuredDemoShippingConfigSource as Source,
} from './measured-demo-shipping-config';

type Rec = Record<string, unknown>;
const SECRET = 'svc_secret_profile_value';
const UUID = '11111111-1111-1111-1111-111111111111';

const K = {
  profile: 'shippingQuotes.measuredDemoParcelProfileJson',
  postal: 'shippingQuotes.skydropx.originPostalCode',
  state: 'shippingQuotes.skydropx.originState',
  municipality: 'shippingQuotes.skydropx.originMunicipality',
  neighborhood: 'shippingQuotes.skydropx.originNeighborhood',
};

// prettier-ignore
const MEASUREMENT = { weightGrams: 500, lengthCm: 10, widthCm: 20, heightCm: 30 };
const PROFILE: Rec = {
  version: 1,
  items: [
    { productId: UUID, variantId: null, quantity: 1, measurement: MEASUREMENT },
  ],
  parcel: MEASUREMENT,
};
const PROFILE_JSON = JSON.stringify(PROFILE);
// prettier-ignore
const ORIGIN = { postalCode: '06000', state: 'CDMX', municipality: 'Cuauhtemoc', neighborhood: 'Centro' };
const VALUES: Rec = {
  [K.profile]: PROFILE_JSON,
  [K.postal]: ORIGIN.postalCode,
  [K.state]: ORIGIN.state,
  [K.municipality]: ORIGIN.municipality,
  [K.neighborhood]: ORIGIN.neighborhood,
};
const EXPECTED_READS = {
  [K.profile]: 1,
  [K.postal]: 1,
  [K.state]: 1,
  [K.municipality]: 1,
  [K.neighborhood]: 1,
};
// prettier-ignore
const source = (overrides: Rec = {}): Source => ({ get: (key: string) => ({ ...VALUES, ...overrides })[key] });
// prettier-ignore
const counting = (values: Rec, log: Rec = {}): Source => ({ get: (key: string) => { log[key] = ((log[key] as number) ?? 0) + 1; return values[key]; } });
// prettier-ignore
const deepFrozen = (v: unknown): boolean => { if (typeof v !== 'object' || v === null) return true; if (!Object.isFrozen(v)) return false; return Object.values(v as Rec).every(deepFrozen); };
// prettier-ignore
function boom(): never { throw new Error('hostile'); }
const rev = Proxy.revocable({}, {});
rev.revoke();
const REVOKED = rev.proxy;
// prettier-ignore
const throwing = { get: () => { throw new Error('get threw'); } } as unknown as Source;
// prettier-ignore
const shieldThrows = new Proxy({ get: (key: string) => VALUES[key] }, { get: boom });

describe('SQ-5B2A resolveMeasuredDemoShippingConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves a fresh exact-key deeply frozen config and origin', () => {
    const out = resolve(source());
    expect(out!.profile).toEqual(PROFILE);
    expect(out!.origin).toEqual(ORIGIN);
    // prettier-ignore
    expect(Object.keys(out as unknown as Rec)).toEqual(['profile', 'origin']);
    // prettier-ignore
    expect(Object.keys(out!.origin)).toEqual(['postalCode', 'state', 'municipality', 'neighborhood']);
    expect(deepFrozen(out)).toBe(true);
  });

  it('reads each declared path once, strips extras/secrets, and never logs', () => {
    const consoleLog = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const log: Rec = {};
    const profileWithSecrets = JSON.stringify({
      ...PROFILE,
      secret: SECRET,
      items: [{ ...(PROFILE.items as Rec[])[0], secret: SECRET }],
    });
    const out = resolve(
      counting({ ...VALUES, [K.profile]: profileWithSecrets }, log),
    );
    expect(log).toEqual(EXPECTED_READS);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('fails closed without throwing when a stateful source injects a secret on re-read', () => {
    const seen: Rec = {};
    const stateful: Source = {
      get: (key: string) => {
        seen[key] = ((seen[key] as number) ?? 0) + 1;
        return seen[key] === 1 ? VALUES[key] : SECRET;
      },
    };
    const out = resolve(stateful);
    expect(out!.profile).toEqual(PROFILE);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('trims accepted origin whitespace while keeping exact values', () => {
    const out = resolve(
      source({ [K.postal]: ' 06000 ', [K.state]: '  CDMX  ' }),
    );
    expect(out!.origin.postalCode).toBe('06000');
    expect(out!.origin.state).toBe('CDMX');
  });

  it('accepts exactly the raw profile code-unit cap and rejects one over', () => {
    const head = JSON.stringify(PROFILE);
    const exact = head + ' '.repeat(MAX - head.length);
    expect(exact.length).toBe(MAX);
    expect(resolve(source({ [K.profile]: exact }))).not.toBeNull();
    expect(resolve(source({ [K.profile]: exact + ' ' }))).toBeNull();
  });

  // prettier-ignore
  it('exports a unique symbol token', () => expect(typeof TOKEN).toBe('symbol'));

  // prettier-ignore
  it.each<[string, unknown]>([
    ['null', null], ['undefined', undefined], ['primitive', 42], ['string', 'config'],
    ['missing get', {}], ['non-callable get', { get: 1 }], ['throwing get', throwing],
    ['shield that throws', shieldThrows], ['revoked proxy', REVOKED],
  ])('fails closed without throwing for a %s source', (_l, value) => {
    expect(() => resolve(value as Source)).not.toThrow();
    expect(resolve(value as Source)).toBeNull();
  });

  // prettier-ignore
  it.each<[string, unknown]>([
    ['absent', undefined], ['null', null], ['number', 42], ['blank', '   '],
    ['non-json', '{not json'], ['empty object', '{}'],
    ['wrong version', JSON.stringify({ ...PROFILE, version: 2 })],
    ['parcel mismatch', JSON.stringify({ ...PROFILE, parcel: { ...MEASUREMENT, weightGrams: 501 } })],
    ['oversized json', JSON.stringify(PROFILE) + ' '.repeat(MAX)],
  ])('fails closed for a %s profile value', (_l, profile) => {
    expect(resolve(source({ [K.profile]: profile }))).toBeNull();
  });

  // prettier-ignore
  it.each<[string, Rec]>([
    ['missing postal', { [K.postal]: undefined }], ['nonstring postal', { [K.postal]: 6000 }],
    ['short postal', { [K.postal]: '600' }], ['long postal', { [K.postal]: '060000' }],
    ['nondigit postal', { [K.postal]: '06a00' }], ['blank state', { [K.state]: '   ' }],
    ['missing state', { [K.state]: undefined }], ['nonstring state', { [K.state]: 1 }],
    ['long state', { [K.state]: 'a'.repeat(101) }],
    ['long municipality', { [K.municipality]: 'a'.repeat(101) }],
    ['long neighborhood', { [K.neighborhood]: 'a'.repeat(101) }],
  ])('fails closed for %s', (_l, override) => {
    expect(resolve(source(override))).toBeNull();
  });
});
