import { isTalkToHumanRequest } from './talk-to-human-intent';

/**
 * T8 / S6: a deterministic matcher for CLEAR requests to talk to a person.
 * Conservative on purpose: anything ambiguous goes to the normal agent turn.
 */
describe('isTalkToHumanRequest', () => {
  it.each([
    'quiero hablar con una persona',
    'Quiero hablar con una persona.',
    'QUIERO HABLAR CON UNA PERSONA',
    'quisiera hablar con una persona, por favor',
    'Quiero hablar con un humano',
    'quiero hablar con un asesor',
    'quiero hablar con una asesora',
    'necesito hablar con alguien',
    'puedo hablar con alguien del equipo?',
    '¿Puedo hablar con una persona real?',
    'me gustaría hablar con una persona de verdad',
    'Me gustaria hablar con un agente humano',
    'pásame con una persona',
    'pasame con alguien',
    'pásame con alguien por favor',
    'me pasas con un asesor',
    '¿Me puede pasar con una persona?',
    'me podrian pasar con un asesor',
    'comunícame con una persona',
    'me comunica con un asesor por favor',
    'necesito un asesor',
    'quiero un asesor',
    'necesito un humano',
    'prefiero hablar con una persona',
    'hola, quiero hablar con una persona',
    'Buenas tardes, quisiera hablar con alguien',
    'quiero que me atienda una persona',
    'que me atienda un asesor',
    'me puede atender una persona',
    'hablar con una persona',
    'hablar con el encargado',
    'quiero hablar con el gerente',
    'un asesor',
    'un humano',
    'asesor por favor',
    'persona real',
    'una persona real',
    'atención humana',
    'quiero hablar con una persona porque mi pedido llegó mal',
    'quiero hablar con una persona para aclarar una duda',
    'no quiero hablar con un robot, quiero una persona',
    'no quiero hablar con el bot quiero hablar con una persona',
    // usted and tú
    'quisiera que me pase con alguien',
    'me pasas con alguien del equipo',
    'puedes pasarme con una persona',
    'puede pasarme con un asesor',
    // accents and spacing
    '  pasame   con   ALGUIEN  ',
    'Quiero hablar con una PERSONA!!',
  ])('matches %j', (text) => {
    expect(isTalkToHumanRequest(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'hola',
    'una persona',
    'persona',
    'para cuántas personas es',
    'somos 3 personas',
    '¿para cuántas personas alcanza?',
    'para una persona',
    'quiero factura como persona moral',
    'soy persona física, necesito factura',
    'persona moral',
    'necesito una persona que recoja el pedido',
    'la persona que atiende me dijo que sí',
    'mi persona de confianza va a recoger',
    'no quiero hablar con una persona',
    'no necesito un asesor',
    'no quiero hablar con alguien',
    'dile a la persona que ya pagué',
    'hablé con una persona ayer y me dijo que sí',
    'quiero hablar de mi pedido',
    'quiero hablar contigo',
    'quiero 2 bolsas de croquetas',
    'necesito hablar con el veterinario',
    'el asesor me dijo que costaba 200',
    'tengo un asesor financiero',
    'humano',
    'es un humano muy amable',
    'quiero comprar croquetas para mi perro, la verdad no sé cuál elegir y necesito que me ayuden, o si hay alguien del equipo que sepa de alimentos para cachorros de raza grande',
    'pásame el precio',
    'pasame con el costo del envío',
    'me pasas la lista de precios',
  ])('does not match %j', (text) => {
    expect(isTalkToHumanRequest(text)).toBe(false);
  });

  it('never matches a long message (it goes to the agent)', () => {
    const long = `quiero hablar con una persona ${'y mas texto '.repeat(30)}`;
    expect(isTalkToHumanRequest(long)).toBe(false);
  });

  it('is false for non-string input', () => {
    expect(isTalkToHumanRequest(undefined as unknown as string)).toBe(false);
    expect(isTalkToHumanRequest(null as unknown as string)).toBe(false);
  });
});
