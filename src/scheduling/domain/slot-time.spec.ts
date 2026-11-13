import {
  atTime,
  formatClock,
  formatDay,
  formatWhen,
  slotLabel,
  zonedParts,
} from './slot-time';

const MX = 'America/Mexico_City'; // UTC-6, no DST since 2022
const TJ = 'America/Tijuana'; // PST/PDT (DST)

// Thursday 2026-11-12 09:00 in Mexico City.
const NOW = '2026-11-12T15:00:00.000Z';

describe('formatClock (12 h "9:30 a. m.", plain spaces)', () => {
  it.each<[string, string, string, string]>([
    ['morning', '2026-11-13T15:00:00Z', MX, '9:00 a. m.'],
    ['half past', '2026-11-13T15:30:00Z', MX, '9:30 a. m.'],
    ['two-digit hour', '2026-11-13T16:00:00Z', MX, '10:00 a. m.'],
    ['afternoon', '2026-11-12T22:30:00Z', MX, '4:30 p. m.'],
    ['noon', '2026-11-12T18:00:00Z', MX, '12:00 p. m.'],
    ['midnight', '2026-11-13T06:00:00Z', MX, '12:00 a. m.'],
    ['one in the afternoon', '2026-11-12T19:00:00Z', MX, '1:00 p. m.'],
    [
      'an offset-carrying ISO instant',
      '2026-11-12T16:00:00-06:00',
      MX,
      '4:00 p. m.',
    ],
  ])('%s', (_name, iso, zone, expected) => {
    expect(formatClock(iso, zone)).toBe(expected);
  });

  it('never emits U+202F / U+00A0 or "a.m." without the inner space', () => {
    for (const iso of ['2026-11-13T15:00:00Z', '2026-11-12T22:30:00Z']) {
      const out = formatClock(iso, MX);
      expect(out).not.toMatch(/[\u00a0\u202f]/);
      expect(out).toMatch(/^\d{1,2}:\d{2} [ap]\. m\.$/);
    }
  });

  it('follows the zone DST rules (Tijuana: PDT in July, PST in December)', () => {
    expect(formatClock('2026-07-15T16:00:00Z', TJ)).toBe('9:00 a. m.');
    expect(formatClock('2026-12-15T17:00:00Z', TJ)).toBe('9:00 a. m.');
    // Fall back (2026-11-01 09:00 PST = 17:00Z) and the day before (PDT).
    expect(formatClock('2026-11-01T17:00:00Z', TJ)).toBe('9:00 a. m.');
    expect(formatClock('2026-10-31T16:00:00Z', TJ)).toBe('9:00 a. m.');
  });

  it('is DST-free for Mexico City across the year', () => {
    expect(formatClock('2026-07-15T15:00:00Z', MX)).toBe('9:00 a. m.');
    expect(formatClock('2026-12-15T15:00:00Z', MX)).toBe('9:00 a. m.');
  });

  it('rejects an invalid instant or zone', () => {
    expect(() => formatClock('not-a-date', MX)).toThrow(RangeError);
    expect(() => formatClock(NOW, 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('formatDay ("hoy", "mañana" or "el lunes 16 de noviembre")', () => {
  it.each<[string, string, string, string]>([
    ['today', '2026-11-12T22:00:00Z', MX, 'hoy'],
    ['today, first minute of the local day', '2026-11-12T06:00:00Z', MX, 'hoy'],
    ['tomorrow', '2026-11-13T15:30:00Z', MX, 'mañana'],
    [
      'monday after the weekend',
      '2026-11-16T15:00:00Z',
      MX,
      'el lunes 16 de noviembre',
    ],
    ['wednesday', '2026-11-18T15:00:00Z', MX, 'el miércoles 18 de noviembre'],
    ['saturday', '2026-11-14T15:00:00Z', MX, 'el sábado 14 de noviembre'],
    ['next month', '2026-12-01T15:00:00Z', MX, 'el martes 1 de diciembre'],
    [
      'yesterday is not "hoy"',
      '2026-11-11T22:00:00Z',
      MX,
      'el miércoles 11 de noviembre',
    ],
  ])('%s', (_name, iso, zone, expected) => {
    expect(formatDay(iso, zone, NOW)).toBe(expected);
  });

  it('computes hoy/mañana in the branch zone, not in UTC', () => {
    // 2026-11-13T04:00Z is still Nov 12 22:00 in Mexico City.
    const lateNow = '2026-11-13T04:00:00Z';
    // Same UTC date as `now`, but Nov 13 locally → mañana.
    expect(formatDay('2026-11-13T07:00:00Z', MX, lateNow)).toBe('mañana');
    // Different UTC date, same local date → hoy.
    expect(formatDay('2026-11-13T05:00:00Z', MX, lateNow)).toBe('hoy');
    // Early UTC `now` is the previous local day.
    const earlyNow = '2026-11-12T03:00:00Z'; // Nov 11 21:00 local
    expect(formatDay('2026-11-12T18:00:00Z', MX, earlyNow)).toBe('mañana');
  });

  it('accepts `now` as a Date', () => {
    expect(formatDay('2026-11-13T15:30:00Z', MX, new Date(NOW))).toBe('mañana');
  });

  it('crosses the spring-forward boundary in a DST zone (Tijuana 2026-03-08)', () => {
    const now = '2026-03-07T20:00:00Z'; // Mar 7 12:00 PST
    // 16:30Z on Mar 8 is 9:30 PDT (UTC-7) → mañana at 9:30.
    expect(formatDay('2026-03-08T16:30:00Z', TJ, now)).toBe('mañana');
    expect(formatClock('2026-03-08T16:30:00Z', TJ)).toBe('9:30 a. m.');
    expect(formatDay('2026-03-09T16:30:00Z', TJ, now)).toBe(
      'el lunes 9 de marzo',
    );
  });

  it('uses the zone of the API: the same instant lands on different days', () => {
    // 2026-11-13T05:00Z is Nov 12 23:00 in Mexico City but already Nov 13 in
    // Tokyo (14:00).
    const now = '2026-11-13T00:00:00Z';
    expect(formatDay('2026-11-13T05:00:00Z', MX, now)).toBe('hoy');
    expect(formatDay('2026-11-13T05:00:00Z', 'Asia/Tokyo', now)).toBe('hoy');
    expect(
      formatDay('2026-11-13T05:00:00Z', 'Asia/Tokyo', '2026-11-12T10:00:00Z'),
    ).toBe('mañana');
    expect(formatDay('2026-11-13T05:00:00Z', MX, '2026-11-12T10:00:00Z')).toBe(
      'hoy',
    );
  });
});

describe('formatWhen ("{cuándo}": "hoy a las 4:00 p. m.")', () => {
  it.each<[string, string, string]>([
    ['today', '2026-11-12T22:00:00Z', 'hoy a las 4:00 p. m.'],
    ['tomorrow', '2026-11-13T15:00:00Z', 'mañana a las 9:00 a. m.'],
    [
      'within the week uses the bare weekday',
      '2026-11-16T15:00:00Z',
      'el lunes a las 9:00 a. m.',
    ],
    [
      'six days ahead is still a bare weekday',
      '2026-11-18T15:00:00Z',
      'el miércoles a las 9:00 a. m.',
    ],
    [
      'seven days ahead needs the date (same weekday)',
      '2026-11-19T15:00:00Z',
      'el jueves 19 de noviembre a las 9:00 a. m.',
    ],
    [
      'one o’clock takes the singular article',
      '2026-11-13T19:00:00Z',
      'mañana a la 1:00 p. m.',
    ],
  ])('%s', (_name, iso, expected) => {
    expect(formatWhen(iso, MX, NOW)).toBe(expected);
  });
});

describe('atTime', () => {
  it.each<[string, string]>([
    ['9:30 a. m.', 'a las 9:30 a. m.'],
    ['10:00 a. m.', 'a las 10:00 a. m.'],
    ['12:00 p. m.', 'a las 12:00 p. m.'],
    ['1:00 p. m.', 'a la 1:00 p. m.'],
    ['1:30 a. m.', 'a la 1:30 a. m.'],
    ['11:00 a. m.', 'a las 11:00 a. m.'],
  ])('%s → %s', (clock, expected) => {
    expect(atTime(clock)).toBe(expected);
  });
});

describe('slotLabel', () => {
  it('bundles day and clock for one slot', () => {
    expect(slotLabel('2026-11-13T15:30:00Z', MX, NOW)).toEqual({
      day: 'mañana',
      time: '9:30 a. m.',
    });
  });
});

describe('zonedParts', () => {
  it('exposes the local calendar fields (weekday 0 = Sunday)', () => {
    expect(zonedParts('2026-11-13T04:00:00Z', MX)).toMatchObject({
      year: 2026,
      month: 11,
      day: 12,
      hour: 22,
      minute: 0,
      weekday: 4,
    });
  });

  it('reads midnight as hour 0, never 24', () => {
    expect(zonedParts('2026-11-13T06:00:00Z', MX).hour).toBe(0);
  });
});
