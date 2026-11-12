import { createHash } from 'node:crypto';
import {
  describeError,
  fingerprintMessageId,
  sanitizeErrorText,
} from './log-safe';

const PHONE = '5215550001111';
// Meta's real shape: `wamid.` + base64 of a protobuf-like blob that embeds the
// sender wa_id as ASCII digits (here: 0x1c 0x18 0x0c + "5215550001111").
const REAL_SHAPED = `wamid.${Buffer.concat([
  Buffer.from([0x1c, 0x18, 0x0d]),
  Buffer.from(PHONE),
]).toString('base64')}`;

describe('fingerprintMessageId', () => {
  it('the fixture really embeds the phone (premise of the helper)', () => {
    const decoded = Buffer.from(
      REAL_SHAPED.slice('wamid.'.length),
      'base64',
    ).toString('latin1');
    expect(decoded).toContain(PHONE);
  });

  it('is stable for the same id and differs between ids', () => {
    expect(fingerprintMessageId(REAL_SHAPED)).toBe(
      fingerprintMessageId(REAL_SHAPED),
    );
    expect(fingerprintMessageId('wamid.AAAA')).not.toBe(
      fingerprintMessageId('wamid.BBBB'),
    );
  });

  it('is short, non-reversible and carries no phone digits or raw id', () => {
    const fp = fingerprintMessageId(REAL_SHAPED);
    expect(fp).toMatch(/^wamid#[0-9a-f]{8}$/);
    expect(fp).not.toContain(PHONE);
    expect(fp).not.toContain(PHONE.slice(-4));
    expect(fp).not.toContain(REAL_SHAPED.slice(6, 14));
  });

  it('handles absent ids without throwing', () => {
    expect(fingerprintMessageId(null)).toBe('wamid#(none)');
    expect(fingerprintMessageId(undefined)).toBe('wamid#(none)');
    expect(fingerprintMessageId('')).toBe('wamid#(none)');
  });
});

describe('sanitizeErrorText', () => {
  it('removes digit runs of 8 or more but keeps short numbers', () => {
    const out = sanitizeErrorText(
      `Meta 131030: recipient ${PHONE} not allowed (status 400, code 7)`,
    );
    expect(out).not.toContain(PHONE);
    expect(out).not.toMatch(/\d{8}/);
    expect(out).toContain('400');
    expect(out).toContain('131030');
  });

  it('removes wa: conversation refs entirely', () => {
    const out = sanitizeErrorText(`conflict for wa:${PHONE} and wa:…1111`);
    expect(out).not.toContain('wa:');
    expect(out).not.toContain('1111');
  });

  it('removes a +-prefixed formatted phone', () => {
    const out = sanitizeErrorText('to +52 155 5000 1111 failed');
    expect(out).not.toMatch(/155/);
    expect(out).not.toMatch(/5000/);
  });

  it('replaces embedded wamid ids with their fingerprint', () => {
    const out = sanitizeErrorText(`message ${REAL_SHAPED} rejected`);
    expect(out).not.toContain(REAL_SHAPED);
    expect(out).not.toContain(REAL_SHAPED.slice(6));
    expect(out).toContain(fingerprintMessageId(REAL_SHAPED));
  });

  it('keeps a fingerprint whose 8 hex chars are all digits intact', () => {
    let id = '';
    for (let n = 0; n < 100_000 && id === ''; n++) {
      const candidate = `wamid.AllDigits${n}`;
      if (
        /^\d{8}$/.test(
          createHash('sha256').update(candidate).digest('hex').slice(0, 8),
        )
      )
        id = candidate;
    }
    expect(id).not.toBe('');
    const fp = fingerprintMessageId(id);
    expect(fp).toMatch(/^wamid#\d{8}$/);
    expect(sanitizeErrorText(`message ${id} rejected`)).toBe(
      `message ${fp} rejected`,
    );
    expect(sanitizeErrorText(`${fp} then ${fp} 12`)).toBe(
      `${fp} then ${fp} 12`,
    );
  });

  it.each([
    ['52 155 5000 1111'],
    ['52-155-5000-1111'],
    ['(55) 5000.1111'],
    ['52.155.5000.1111'],
    ['521 555 000 1111'],
  ])('masks a separated phone without + (%s)', (phone) => {
    const out = sanitizeErrorText(`to ${phone} failed`);
    expect(out).toBe('to [number] failed');
  });

  it.each([
    ['price 1,250.00 MXN', 'price 1,250.00 MXN'],
    ['total $12,345.67 and 3 items', 'total $12,345.67 and 3 items'],
    ['date 2026-11-12', 'date 2026-11-12'],
    ['on 2026-11-12 10 items', 'on 2026-11-12 10 items'],
    ['at 2026-11-12 14:30:05', 'at 2026-11-12 14:30:05'],
    ['time 10:30 or 9.45', 'time 10:30 or 9.45'],
    ['status 400, code 7', 'status 400, code 7'],
    ['version 1.2.3 build 45', 'version 1.2.3 build 45'],
  ])('keeps ordinary numbers (%s)', (input, expected) => {
    expect(sanitizeErrorText(input)).toBe(expected);
  });

  it('truncates long text', () => {
    const out = sanitizeErrorText('x'.repeat(1000));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses whitespace/newlines so one error stays one log line', () => {
    expect(sanitizeErrorText('a\n  b\tc')).toBe('a b c');
  });
});

describe('describeError', () => {
  it('prints name and sanitized message for Error instances', () => {
    const out = describeError(new TypeError(`boom for wa:${PHONE}`));
    expect(out.startsWith('TypeError: ')).toBe(true);
    expect(out).not.toContain(PHONE);
  });

  it('sanitizes non-Error values and never throws on odd input', () => {
    expect(describeError(`raw ${PHONE}`)).not.toContain(PHONE);
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(null)).toBe('null');
    expect(describeError(42)).toBe('42');
    expect(describeError({ a: 1 })).toBe('[object Object]');
  });

  it('sanitizes the stringified form of non-Error values', () => {
    const value = {
      toString: () => `failed for wa:${PHONE} / +52 155 5000 1111`,
    };
    const out = describeError(value);
    expect(out).not.toContain(PHONE);
    expect(out).not.toMatch(/5000/);
  });

  it('falls back to a constant when String(value) throws', () => {
    const hostile = {
      toString: () => {
        throw new Error('nope');
      },
    };
    expect(describeError(hostile)).toBe('unknown error');
    expect(describeError(Object.create(null))).toBe('unknown error');
  });
});
