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
    expect(describeError(undefined)).toBe('unknown error');
    expect(describeError({ a: 1 })).toBe('unknown error');
    expect(describeError(null)).toBe('unknown error');
  });
});
