import {
  applyCustomerStyle,
  DEFAULT_CUSTOMER_STYLE,
  type CustomerStyle,
} from '../../llm-agent/domain/customer-style';
import {
  alreadyBookedText,
  bookedOutOfWindowText,
  bookedText,
  cancelledText,
  noSlotsText,
  notUnderstoodText,
  offerText,
  rescheduleOfferText,
  rescheduledText,
  reminderText,
  slotTakenText,
  staffChangedText,
  whatTimeText,
} from './scheduling-copy';

const TU: CustomerStyle = { ...DEFAULT_CUSTOMER_STYLE, register: 'tu' };
const USTED: CustomerStyle = DEFAULT_CUSTOMER_STYLE;

const SLOT = { day: 'mañana', time: '9:30 a. m.' };
const SLOTS = [
  { day: 'hoy', time: '4:00 p. m.' },
  { day: 'mañana', time: '9:30 a. m.' },
  { day: 'el lunes 16 de noviembre', time: '10:00 a. m.' },
];

describe('S3 texts (usted), byte-identical with the placeholders filled', () => {
  it('offer', () => {
    expect(offerText('hoy a las 4:00 p. m.', SLOTS)).toBe(
      'Ahorita nuestro equipo no está disponible (abrimos hoy a las 4:00 p. m.). ¿Quiere que una persona le atienda en alguno de estos horarios?\n' +
        '1. hoy a las 4:00 p. m.\n' +
        '2. mañana a las 9:30 a. m.\n' +
        '3. el lunes 16 de noviembre a las 10:00 a. m.\n' +
        'Responda con el número.',
    );
  });

  it('offer with one or two slots numbers only what exists', () => {
    expect(offerText('mañana a las 9:00 a. m.', SLOTS.slice(0, 1))).toBe(
      'Ahorita nuestro equipo no está disponible (abrimos mañana a las 9:00 a. m.). ¿Quiere que una persona le atienda en alguno de estos horarios?\n' +
        '1. hoy a las 4:00 p. m.\n' +
        'Responda con el número.',
    );
    expect(offerText('x', SLOTS.slice(0, 2))).toContain('\n2. mañana');
    expect(offerText('x', SLOTS.slice(0, 2))).not.toContain('3.');
  });

  it('offer rejects an empty or oversized list', () => {
    expect(() => offerText('x', [])).toThrow(RangeError);
    expect(() => offerText('x', [...SLOTS, ...SLOTS])).toThrow(RangeError);
  });

  it('reschedule offer', () => {
    expect(rescheduleOfferText(SLOTS)).toBe(
      'Estos son los horarios disponibles para su cita:\n' +
        '1. hoy a las 4:00 p. m.\n' +
        '2. mañana a las 9:30 a. m.\n' +
        '3. el lunes 16 de noviembre a las 10:00 a. m.\n' +
        'Responda con el número.',
    );
  });

  it('reschedule offer numbers only the slots given and rejects 0 or more than 3', () => {
    expect(rescheduleOfferText(SLOTS.slice(0, 1))).toBe(
      'Estos son los horarios disponibles para su cita:\n' +
        '1. hoy a las 4:00 p. m.\n' +
        'Responda con el número.',
    );
    expect(rescheduleOfferText(SLOTS.slice(0, 2))).not.toContain('3.');
    expect(() => rescheduleOfferText([])).toThrow(RangeError);
    expect(() => rescheduleOfferText([...SLOTS, ...SLOTS])).toThrow(RangeError);
    expect(rescheduleOfferText([{ day: 'hoy', time: '1:00 p. m.' }])).toContain(
      '\n1. hoy a la 1:00 p. m.\n',
    );
  });

  it('not understood', () => {
    expect(notUnderstoodText()).toBe(
      'No entendí qué horario prefiere. Responda con el número de la opción.',
    );
  });

  it('booked', () => {
    expect(bookedText(SLOT)).toBe(
      'Listo, quedó agendado para mañana a las 9:30 a. m. A esa hora una persona del equipo le escribe por aquí.',
    );
  });

  it('booked out of window', () => {
    expect(bookedOutOfWindowText(SLOT)).toBe(
      'Listo, quedó agendado para mañana a las 9:30 a. m. A esa hora le escribimos; cuando le llegue el mensaje, respóndanos para continuar.',
    );
  });

  it('slot taken lists the remaining slots', () => {
    expect(slotTakenText(SLOTS)).toBe(
      'Ese horario se acaba de ocupar. Estos siguen disponibles:\n' +
        '1. hoy a las 4:00 p. m.\n' +
        '2. mañana a las 9:30 a. m.\n' +
        '3. el lunes 16 de noviembre a las 10:00 a. m.',
    );
  });

  it('no slots', () => {
    expect(noSlotsText('mañana a las 9:00 a. m.')).toBe(
      'Por ahora no tenemos horarios disponibles en los próximos días. Ya dejé su solicitud y le escriben en cuanto abramos (mañana a las 9:00 a. m.).',
    );
  });

  it('already booked', () => {
    expect(alreadyBookedText(SLOT)).toBe(
      'Ya tiene una cita para mañana a las 9:30 a. m. ¿Quiere cambiarla?',
    );
  });

  it('rescheduled', () => {
    expect(rescheduledText(SLOT)).toBe(
      'Listo, cambié su cita para mañana a las 9:30 a. m.',
    );
  });

  it('cancelled', () => {
    expect(cancelledText()).toBe(
      'Listo, cancelé su cita. Si necesita algo más, aquí sigo para ayudarle.',
    );
  });

  it('what time', () => {
    expect(whatTimeText(SLOT)).toBe(
      'Su cita es mañana a las 9:30 a. m. Una persona del equipo le escribe por aquí a esa hora.',
    );
  });

  it('reminder', () => {
    expect(reminderText('9:30 a. m.')).toBe(
      'Le recuerdo que a las 9:30 a. m. una persona del equipo le atiende por aquí.',
    );
  });

  it('staff changed', () => {
    expect(staffChangedText(SLOT)).toBe(
      'El equipo cambió su cita para mañana a las 9:30 a. m.',
    );
  });

  it('uses the singular article only for one o’clock', () => {
    const one = { day: 'hoy', time: '1:00 p. m.' };
    expect(bookedText(one)).toContain(
      'quedó agendado para hoy a la 1:00 p. m.',
    );
    expect(reminderText('1:00 p. m.')).toBe(
      'Le recuerdo que a la 1:00 p. m. una persona del equipo le atiende por aquí.',
    );
    expect(offerText('x', [one])).toContain('\n1. hoy a la 1:00 p. m.\n');
  });
});

describe('tú variants through the curated phrase pairs', () => {
  const cases: Array<[string, () => string, string]> = [
    [
      'offer',
      () => offerText('hoy a las 4:00 p. m.', SLOTS),
      'Ahorita nuestro equipo no está disponible (abrimos hoy a las 4:00 p. m.). ¿Quieres que una persona te atienda en alguno de estos horarios?\n' +
        '1. hoy a las 4:00 p. m.\n' +
        '2. mañana a las 9:30 a. m.\n' +
        '3. el lunes 16 de noviembre a las 10:00 a. m.\n' +
        'Responde con el número.',
    ],
    [
      'reschedule offer',
      () => rescheduleOfferText(SLOTS),
      'Estos son los horarios disponibles para tu cita:\n' +
        '1. hoy a las 4:00 p. m.\n' +
        '2. mañana a las 9:30 a. m.\n' +
        '3. el lunes 16 de noviembre a las 10:00 a. m.\n' +
        'Responde con el número.',
    ],
    [
      'not understood',
      () => notUnderstoodText(),
      'No entendí qué horario prefieres. Responde con el número de la opción.',
    ],
    [
      'booked',
      () => bookedText(SLOT),
      'Listo, quedó agendado para mañana a las 9:30 a. m. A esa hora una persona del equipo te escribe por aquí.',
    ],
    [
      'booked out of window',
      () => bookedOutOfWindowText(SLOT),
      'Listo, quedó agendado para mañana a las 9:30 a. m. A esa hora te escribimos; cuando te llegue el mensaje, respóndenos para continuar.',
    ],
    [
      'slot taken',
      () => slotTakenText(SLOTS),
      'Ese horario se acaba de ocupar. Estos siguen disponibles:\n' +
        '1. hoy a las 4:00 p. m.\n' +
        '2. mañana a las 9:30 a. m.\n' +
        '3. el lunes 16 de noviembre a las 10:00 a. m.',
    ],
    [
      'no slots',
      () => noSlotsText('mañana a las 9:00 a. m.'),
      'Por ahora no tenemos horarios disponibles en los próximos días. Ya dejé tu solicitud y te escriben en cuanto abramos (mañana a las 9:00 a. m.).',
    ],
    [
      'already booked',
      () => alreadyBookedText(SLOT),
      'Ya tienes una cita para mañana a las 9:30 a. m. ¿Quieres cambiarla?',
    ],
    [
      'rescheduled',
      () => rescheduledText(SLOT),
      'Listo, cambié tu cita para mañana a las 9:30 a. m.',
    ],
    [
      'cancelled',
      () => cancelledText(),
      'Listo, cancelé tu cita. Si necesitas algo más, aquí sigo para ayudarte.',
    ],
    [
      'what time',
      () => whatTimeText(SLOT),
      'Tu cita es mañana a las 9:30 a. m. Una persona del equipo te escribe por aquí a esa hora.',
    ],
    [
      'reminder',
      () => reminderText('9:30 a. m.'),
      'Te recuerdo que a las 9:30 a. m. una persona del equipo te atiende por aquí.',
    ],
    [
      'staff changed',
      () => staffChangedText(SLOT),
      'El equipo cambió tu cita para mañana a las 9:30 a. m.',
    ],
  ];

  it.each(cases)('%s', (_name, build, expected) => {
    expect(applyCustomerStyle(build(), TU)).toBe(expected);
  });

  it.each(cases)('%s keeps no usted marker in tú', (_name, build) => {
    expect(applyCustomerStyle(build(), TU)).not.toMatch(
      /\b(usted|su|sus|le|les|quiere|prefiere|tiene|responda|respóndanos|necesita|ayudarle)\b/i,
    );
  });

  it.each(cases)(
    '%s stays byte-identical for usted customers',
    (_name, build) => {
      expect(applyCustomerStyle(build(), USTED)).toBe(build());
    },
  );

  it('never rewrites the interpolated day/time pieces', () => {
    const slot = { day: 'el sábado 14 de noviembre', time: '1:00 p. m.' };
    expect(applyCustomerStyle(bookedText(slot), TU)).toBe(
      'Listo, quedó agendado para el sábado 14 de noviembre a la 1:00 p. m. A esa hora una persona del equipo te escribe por aquí.',
    );
  });
});
