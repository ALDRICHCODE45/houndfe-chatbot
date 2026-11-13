import { parseSlotChoice } from './slot-choice';

const MX = 'America/Mexico_City';
const TJ = 'America/Tijuana';
// Thursday 2026-11-12 09:00 in Mexico City.
const NOW = '2026-11-12T15:00:00.000Z';

// Offered: 1 hoy 4:00 p. m., 2 mañana 9:30 a. m., 3 mañana 10:00 a. m.
const SLOTS = [
  { startsAt: '2026-11-12T22:00:00.000Z' },
  { startsAt: '2026-11-13T15:30:00.000Z' },
  { startsAt: '2026-11-13T16:00:00.000Z' },
];

const parse = (text: string, slots = SLOTS) =>
  parseSlotChoice(text, slots, { timeZone: MX, now: NOW });

const pick = (index: number, slots = SLOTS) => ({
  kind: 'slot',
  index,
  startsAt: slots[index].startsAt,
});
const UNCLEAR = { kind: 'unclear' };

describe('parseSlotChoice — by number', () => {
  it.each<[string, number]>([
    ['1', 0],
    ['2', 1],
    ['3', 2],
    [' 2 ', 1],
    ['2.', 1],
    ['2)', 1],
    ['la 2', 1],
    ['La 3', 2],
    ['el 1', 0],
    ['opción 2', 1],
    ['OPCION 3', 2],
    ['número 1', 0],
    ['#2', 1],
    ['la 2 por favor', 1],
    ['si, la 2', 1],
    ['la 2 está bien', 1],
    ['me quedo con la 3', 2],
    ['la dos', 1],
    ['tres', 2],
    ['la primera', 0],
    ['la segunda', 1],
    ['la tercera', 2],
    ['el primero', 0],
    ['2️⃣', 1],
  ])('%j → option %i', (text, index) => {
    expect(parse(text)).toEqual(pick(index));
  });

  it('an option that was not offered is unclear', () => {
    expect(parse('3', SLOTS.slice(0, 2))).toEqual(UNCLEAR);
    expect(parse('la tercera', SLOTS.slice(0, 1))).toEqual(UNCLEAR);
    expect(parse('0')).toEqual(UNCLEAR);
    expect(parse('4')).toEqual(UNCLEAR);
  });
});

describe('parseSlotChoice — by time and/or day (only offered slots)', () => {
  it.each<[string, number]>([
    ['la de las 10', 2],
    ['la de las 10:00', 2],
    ['la de las 10 am', 2],
    ['el de mañana a las 9:30', 1],
    ['mañana 9:30', 1],
    ['Mañana 9:30 AM', 1],
    ['manana a las 9:30', 1],
    ['mañana a las 9 y media', 1],
    ['9.30', 1],
    ['9h30', 1],
    ['9:30 a.m.', 1],
    ['9:30 a. m.', 1],
    ['las 4', 0],
    ['a las 4 de la tarde', 0],
    ['4 pm', 0],
    ['4:00 p. m.', 0],
    ['16:00', 0],
    ['16 hrs', 0],
    ['hoy a las 4', 0],
    ['la de hoy', 0],
    ['hoy', 0],
    ['mañana a las 10', 2],
    ['mañana por la mañana a las 10', 2],
    ['las 10 de la mañana', 2],
    ['quiero la de las 10, por favor', 2],
  ])('%j → option %i', (text, index) => {
    expect(parse(text)).toEqual(pick(index));
  });

  it('does not book a time that was not offered', () => {
    expect(parse('las 9')).toEqual(UNCLEAR); // 9:00 ≠ 9:30
    expect(parse('mañana 11:00')).toEqual(UNCLEAR);
    expect(parse('las 5')).toEqual(UNCLEAR);
    expect(parse('hoy a las 10')).toEqual(UNCLEAR); // 10 offered mañana, not hoy
    expect(parse('4 am')).toEqual(UNCLEAR);
    expect(parse('10 de la noche')).toEqual(UNCLEAR);
    expect(parse('25:00')).toEqual(UNCLEAR);
    expect(parse('9:75')).toEqual(UNCLEAR);
  });

  it('is unclear when a reply matches several offered slots', () => {
    expect(parse('mañana')).toEqual(UNCLEAR); // 9:30 and 10:00
    expect(parse('las 9 y media o las 10')).toEqual(UNCLEAR);
  });

  it('resolves a weekday only when a single offered slot falls on it', () => {
    const slots = [
      { startsAt: '2026-11-16T15:00:00.000Z' }, // lunes 9:00
      { startsAt: '2026-11-17T15:00:00.000Z' }, // martes 9:00
      { startsAt: '2026-11-17T17:00:00.000Z' }, // martes 11:00
    ];
    expect(parse('el lunes', slots)).toEqual(pick(0, slots));
    expect(parse('lunes a las 9', slots)).toEqual(pick(0, slots));
    expect(parse('martes', slots)).toEqual(UNCLEAR);
    expect(parse('el martes a las 11', slots)).toEqual(pick(2, slots));
    expect(parse('miércoles', slots)).toEqual(UNCLEAR);
  });

  it('handles "pasado mañana"', () => {
    const slots = [
      { startsAt: '2026-11-13T15:00:00.000Z' }, // mañana
      { startsAt: '2026-11-14T15:00:00.000Z' }, // pasado mañana
    ];
    expect(parse('pasado mañana', slots)).toEqual(pick(1, slots));
    expect(parse('mañana', slots)).toEqual(pick(0, slots));
  });

  it('reads "a la 1" as a time, not as option 1', () => {
    const slots = [
      { startsAt: '2026-11-12T19:00:00.000Z' }, // hoy 1:00 p. m.
      { startsAt: '2026-11-12T22:00:00.000Z' }, // hoy 4:00 p. m.
    ];
    expect(parse('a la 1', slots)).toEqual(pick(0, slots));
    expect(parse('a la una', slots)).toEqual(pick(0, slots));
    expect(parse('1', slots)).toEqual(pick(0, slots));
    expect(parse('2', slots)).toEqual(pick(1, slots));
    expect(parse('la 2', slots)).toEqual(pick(1, slots));
  });

  it('matches in the branch zone, including across DST', () => {
    // Tijuana, Sun 2026-03-08 spring forward: now Sat 12:00 PST.
    const now = '2026-03-07T20:00:00.000Z';
    const slots = [
      { startsAt: '2026-03-08T16:30:00.000Z' }, // mañana 9:30 PDT
      { startsAt: '2026-03-09T16:30:00.000Z' }, // lunes 9:30 PDT
    ];
    const ctx = { timeZone: TJ, now };
    expect(parseSlotChoice('mañana 9:30', slots, ctx)).toEqual(pick(0, slots));
    expect(parseSlotChoice('el lunes a las 9:30', slots, ctx)).toEqual(
      pick(1, slots),
    );
    // The UTC hour (16:30) is not the local one.
    expect(parseSlotChoice('16:30', slots, ctx)).toEqual(UNCLEAR);
  });
});

describe('parseSlotChoice — unclear', () => {
  it.each([
    '',
    '   ',
    'ok',
    'sí',
    'hola',
    'no',
    'no puedo a las 10',
    'ninguna',
    'ninguno me sirve',
    'no, la 2',
    'otro horario',
    'más tarde',
    '¿a qué hora abren?',
    'cancela',
    'la 2 o la 3',
    'x'.repeat(200),
  ])('%j', (text) => {
    expect(parse(text)).toEqual(UNCLEAR);
  });

  it('is unclear with no offered slots', () => {
    expect(parse('1', [])).toEqual(UNCLEAR);
    expect(parse('mañana 9:30', [])).toEqual(UNCLEAR);
  });
});
