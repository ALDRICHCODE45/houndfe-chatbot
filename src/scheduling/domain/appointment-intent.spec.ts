import {
  isChangeConfirmation,
  parseAppointmentIntent,
} from './appointment-intent';

describe('parseAppointmentIntent (unit 14 T4: conservative, anchored)', () => {
  describe('what time is my appointment', () => {
    it.each([
      '¿a qué hora quedé?',
      'A que hora quede',
      'a qué hora quedamos?',
      '¿Cuándo es mi cita?',
      'cuando es mi cita',
      '¿a qué hora es mi cita?',
      'a que hora es la cita',
      'Hola, ¿a qué hora es mi cita?',
      'oye a qué hora quedé por favor',
      '¿qué día y a qué hora es mi cita?',
      '¿a qué hora me escriben?',
      'a que hora me atienden',
      'A QUÉ HORA QUEDÉ',
      '  a que hora quede   ',
    ])('%s', (text) => {
      expect(parseAppointmentIntent(text)).toBe('what_time');
    });
  });

  describe('change the appointment', () => {
    it.each([
      'quiero cambiar mi cita',
      'Quisiera cambiar mi cita, por favor',
      'necesito mover mi cita',
      'quiero reagendar mi cita',
      'quiero reprogramar la cita',
      '¿la puedo mover?',
      '¿puedo cambiar mi cita?',
      '¿se puede cambiar la cita?',
      '¿puedo cambiarla?',
      'cambiar mi cita',
      'reagendar',
      'quiero cambiar la hora de mi cita',
      'quiero cambiar mi cita para otro día',
      'me gustaría cambiar mi cita',
      'hola, quiero cambiar mi cita',
    ])('%s', (text) => {
      expect(parseAppointmentIntent(text)).toBe('change');
    });
  });

  describe('cancel the appointment', () => {
    it.each([
      'cancela mi cita',
      'Cancela mi cita por favor',
      'quiero cancelar mi cita',
      'cancelar la cita',
      'favor de cancelar mi cita',
      'ya no voy a poder ir a la cita',
      'Ya no voy a poder ir a mi cita',
      'ya no podré asistir a la cita',
      'ya no puedo ir a la cita',
      'no voy a poder asistir a mi cita',
      'ya no quiero la cita',
      'ya no necesito mi cita',
      'hola, ya no voy a poder ir a la cita',
    ])('%s', (text) => {
      expect(parseAppointmentIntent(text)).toBe('cancel');
    });
  });

  describe('everything else goes to the agent', () => {
    it.each([
      '',
      '   ',
      'hola',
      '1',
      'sí',
      'cancelar mi pedido',
      'cancela mi pedido',
      'quiero cambiar mi pedido',
      'quiero cambiar de producto',
      'cancela',
      'cancelar',
      'ya no quiero el producto',
      'ya no tengo dinero',
      '¿a qué hora abren?',
      '¿a qué hora cierran?',
      '¿cuándo llega mi pedido?',
      '¿a qué hora es la entrega?',
      'no entiendo mi cita',
      'tengo una cita con el doctor a las 5, ¿tienen croquetas?',
      'quiero cambiar mi cita pero primero dime si tienen croquetas',
      'mi cita es mañana, no cancela nada',
      'si no es mucha molestia, ¿a qué hora quedé?, y de paso quiero comprar croquetas para mi perro',
      'cuándo es la cita del perro con el veterinario',
      'cambiar',
      'mover',
      'quiero cancelar',
      // F4: generic phrasings that do not mention the appointment (a pickup,
      // an order or a delivery may be what the customer cannot attend).
      'ya no voy a poder',
      'Ya no voy a poder ir',
      'ya no puedo ir',
      'ya no puedo ir a recoger mi pedido',
      'ya no podré',
      'ya no podré asistir',
      'ya no podemos ir',
      'ya no voy a ir',
      'no voy a poder ir',
      'no voy a poder asistir',
      'hola, ya no voy a poder',
      'ya no voy a poder pasar por mi pedido',
    ])('%j', (text) => {
      expect(parseAppointmentIntent(text)).toBeNull();
    });

    it('a very long message is never an intent', () => {
      expect(
        parseAppointmentIntent(`quiero cambiar mi cita ${'x'.repeat(200)}`),
      ).toBeNull();
    });
  });
});

describe('isChangeConfirmation (the "sí" after «¿Quiere cambiarla?»)', () => {
  it.each([
    'sí',
    'Si',
    'sii',
    'sí, por favor',
    'si quiero',
    'sí quiero cambiarla',
    'claro',
    'ok',
    'va',
    'dale',
    'sí gracias',
    '¡Sí!',
    'cámbiala',
    'cambiarla',
  ])('%s', (text) => {
    expect(isChangeConfirmation(text)).toBe(true);
  });

  it.each([
    '',
    'no',
    'no gracias',
    'sí, pero no',
    'ya no',
    'mejor no',
    'hola',
    '1',
    'sí quiero croquetas de pollo para perro adulto',
    'si no me atienden cancelo',
    'cancélala',
    'no, déjala así',
  ])('%j is not', (text) => {
    expect(isChangeConfirmation(text)).toBe(false);
  });
});
