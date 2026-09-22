import { parseMexicanWhatsAppPhone as parse } from './mexican-whatsapp-phone';

type Rec = Record<string, unknown>;
const SECRET = 'svc_super_secret_token_value';
const PHONE = '5512345678';
const MODERN = `52${PHONE}`;
const LEGACY = `521${PHONE}`;
const EXPECTED = { phoneCountryCode: '52', phone: PHONE };
// prettier-ignore
const deepFrozen = (v: unknown): boolean => { if (typeof v !== 'object' || v === null) return true; if (!Object.isFrozen(v)) return false; return Object.values(v as Rec).every(deepFrozen); };
// prettier-ignore
function boom(): never { throw new Error('x'); }
const HOSTILE: object = new Proxy({}, { get: boom });
const revoked = Proxy.revocable({}, {});
revoked.revoke();
const REVOKED: object = revoked.proxy;
// prettier-ignore
const fullwidth = (digits: string): string => digits.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)));
// prettier-ignore
const coerceBait = { toString: boom, valueOf: boom, [Symbol.toPrimitive]: boom };

describe('SQ-5B2B1 accepted sender shapes', () => {
  it('normalizes the current 52 plus ten digits shape', () => {
    expect(parse(MODERN)).toEqual(EXPECTED);
  });

  it('normalizes the legacy 521 plus ten digits shape to the same output', () => {
    const modern = parse(MODERN);
    const legacy = parse(LEGACY);
    expect(legacy).toEqual(EXPECTED);
    expect(legacy).toEqual(modern);
    expect(legacy).not.toBe(modern);
  });

  it('returns a fresh exact-key deeply frozen object', () => {
    const out = parse(MODERN);
    expect(out).toEqual(EXPECTED);
    expect(deepFrozen(out)).toBe(true);
    // prettier-ignore
    expect(Object.keys(out as unknown as Rec)).toEqual(['phoneCountryCode', 'phone']);
    expect(out?.phoneCountryCode).toBe('52');
    expect(out?.phone).toBe(PHONE);
  });

  it('is deterministic across repeated calls without sharing a reference', () => {
    const first = parse(MODERN);
    const second = parse(MODERN);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(parse(LEGACY)).toEqual(second);
  });

  it('keeps all ten digits exactly, including internal and repeated zeros', () => {
    const phone = '5000000005';
    expect(parse(`52${phone}`)).toEqual({ phoneCountryCode: '52', phone });
    expect(parse(`521${phone}`)).toEqual({ phoneCountryCode: '52', phone });
    expect(parse(`52${phone}`)?.phone).toHaveLength(10);
  });

  it('accepts a ten-digit phone beginning with 1 but rejects one beginning with 0', () => {
    // '521' + nine digits is length 12, i.e. still `52` + ten digits.
    expect(parse('521551234567')).toEqual({
      phoneCountryCode: '52',
      phone: '1551234567',
    });
    // prettier-ignore
    expect(parse('520123456789')).toBeNull();
    // prettier-ignore
    expect(parse('5210123456789')).toBeNull();
  });
});

describe('SQ-5B2B1 rejected shapes', () => {
  // prettier-ignore
  it.each<string>([
    '', ' ', '   ', '5', '52', '521', '52551234567',
    '52' + '1'.repeat(11) + '9',
    '52' + fullwidth(PHONE), fullwidth(MODERN), fullwidth(LEGACY),
    `52${PHONE} `, ` 52${PHONE}`, `52 ${PHONE}`, `52${PHONE}\t`,
    `+52${PHONE}`, `+52${PHONE}`.replace('52', '521'), `52-${PHONE}`,
    `52.${PHONE}`, `52(${PHONE})`, `52_${PHONE}`, `52${PHONE}\n`,
    '520123456789', '5210123456789', '0525512345678', '5255123456789',
    '15512345678', '545512345678', '535512345678', '515512345678',
    '335512345678', '52155123456789',
  ])('returns null for %p', (value) => {
    expect(parse(value)).toBeNull();
  });

  it('rejects non-primitive and coercible values without reading properties', () => {
    const log: string[] = [];
    // prettier-ignore
    const spy = new Proxy({}, { get: (_t, key) => { log.push(String(key)); return SECRET; } });
    const spyFunction = new Proxy(boom, { get: boom });
    // prettier-ignore
    const values: unknown[] = [undefined, null, 5215512345678, 5215512345678n, true, false, Symbol('wa'), {}, [], [`52${PHONE}`], () => MODERN, new String(MODERN), HOSTILE, spy, spyFunction, REVOKED, coerceBait, new Date(0)];
    for (const value of values) {
      expect(() => parse(value)).not.toThrow();
      expect(parse(value)).toBeNull();
    }
    expect(log).toEqual([]);
  });

  it('never reflects a secret sentinel through its output', () => {
    const bait = { token: SECRET, phone: MODERN, nested: { secret: SECRET } };
    expect(parse(bait)).toBeNull();
    expect(JSON.stringify(parse(bait))).not.toContain(SECRET);
    expect(parse(`52${SECRET}`)).toBeNull();
    expect(JSON.stringify(parse(`52${SECRET}`))).not.toContain(SECRET);
    const stateful = new Proxy({}, { get: () => MODERN });
    expect(parse(stateful)).toBeNull();
  });
});
