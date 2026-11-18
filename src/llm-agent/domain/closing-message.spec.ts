import {
  CLOSING_REPLY,
  isClosingMessage,
  isFarewellOrClosingReply,
} from './closing-message';
import { applyCustomerStyle, DEFAULT_CUSTOMER_STYLE } from './customer-style';

const TU = { ...DEFAULT_CUSTOMER_STYLE, register: 'tu' as const };

describe('S6 closing messages (answered without the LLM)', () => {
  it.each([
    'gracias',
    'Gracias',
    'muchas gracias',
    'ok',
    'OK',
    'va',
    'perfecto',
    'listo',
    '👍',
    '🙏',
    '👍🏽',
    'gracias, buen día',
    'Gracias, buen dia!',
    'nos vemos',
    'ok gracias',
    'Listo, gracias 🙏',
    'perfecto muchas gracias!!',
    'va, gracias 👍',
    'Muchas gracias 😊',
    'gracias.',
    '  ok  ',
  ])('%p is a pure closing', (text) => {
    expect(isClosingMessage(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'hola',
    'ok, quiero 2',
    'gracias, ¿tienen croquetas?',
    'listo, ya pagué',
    'perfecto, ¿cuánto es el envío?',
    'va a llegar hoy?',
    'ok?',
    'gracias pero no',
    'jajaja',
    '😊',
    'quiero hablar con alguien',
  ])('%p is not a pure closing', (text) => {
    expect(isClosingMessage(text)).toBe(false);
  });

  it('has the exact fixed reply, tú-styled', () => {
    expect(CLOSING_REPLY).toBe('¡Con gusto! Aquí estoy si necesita algo más.');
    expect(applyCustomerStyle(CLOSING_REPLY, TU)).toBe(
      '¡Con gusto! Aquí estoy si necesitas algo más.',
    );
  });

  it.each([
    CLOSING_REPLY,
    applyCustomerStyle(CLOSING_REPLY, TU),
    '¡Gracias por su compra! Que tenga un excelente día.',
    'Con gusto, que tengas buen día 🙂',
    'Hasta luego, gracias por escribirnos.',
    '¡Que esté muy bien!',
  ])('%p counts as a previous farewell/closing', (text) => {
    expect(isFarewellOrClosingReply(text)).toBe(true);
  });

  it.each([
    null,
    'Encontré estas opciones:\n• *Croquetas*: $99.00 MXN',
    'Listo, actualicé su carrito.',
    'Ya le pregunté al equipo, le aviso por aquí en cuanto me respondan.',
  ])('%p is not a farewell', (text) => {
    expect(isFarewellOrClosingReply(text)).toBe(false);
  });
});

describe('S6 review R3: an opening greeting is not a closing (goes to the model)', () => {
  it.each([
    'Buenas tardes',
    'buenos días',
    'Buenas noches!',
    'buen día',
    'Buen dia 😊',
    'buenas tardes, buen día',
  ])('%p alone is a greeting, not a closing', (text) => {
    expect(isClosingMessage(text)).toBe(false);
  });

  it.each([
    'gracias, buen día',
    'muchas gracias, buenas noches',
    'ok, buenas tardes 👍',
    'que tenga buen día',
  ])('%p (with a closing word or farewell form) is still a closing', (text) => {
    expect(isClosingMessage(text)).toBe(true);
  });
});
