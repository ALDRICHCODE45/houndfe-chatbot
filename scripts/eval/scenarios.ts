import type { FixtureCustomer } from './fixtures/fake-api';

/**
 * Whether the literal refusal phrase ("esa función aún no está disponible")
 * may appear: `forbidden` (default) for supported flows, `allowed` where
 * either a redirect or the refusal is acceptable, `expected` for a function
 * the bot does not support.
 */
export type RefusalExpectation = 'forbidden' | 'allowed' | 'expected';

export interface ScenarioTurn {
  text: string;
  refusal?: RefusalExpectation;
  /** The reply must present the business as a pet store. */
  expectPersona?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  customer: FixtureCustomer;
  turns: Array<string | ScenarioTurn>;
  /** Orders that must exist at the end (checked exactly). */
  expectOrders?: number;
}

/**
 * Same shape as `buildProductImageTurnText` (src/product-image, T4): caption,
 * newline, then the bracketed description with suggested searches and the
 * no-match guidance. Keep in sync if T4 changes the format.
 */
export function imageTurn(
  caption: string,
  description: string,
  queries: string[],
): string {
  return (
    `${caption}\n` +
    `[Imagen enviada por el cliente: ${description}. ` +
    `Búsquedas sugeridas: ${queries.map((q) => `"${q}"`).join('; ')}. ` +
    'Si no hay coincidencia exacta, ofrezca productos similares reales del catálogo (misma marca, mismo tipo o tamaño parecido) y aclare que no es el mismo; ' +
    'si la imagen no permite identificarlo, pida una foto de la etiqueta o el nombre.]'
  );
}

const existing = (zip: '03100' | '04000' | '12000'): FixtureCustomer => ({
  kind: 'existing',
  firstName: 'Mariana',
  zip,
});

export const SCENARIOS: Scenario[] = [
  {
    id: 'formal',
    title: 'Serious formal customer (usted, no emojis)',
    customer: existing('03100'),
    turns: [
      'Buenas tardes. Quisiera saber si manejan croquetas para perro de raza grande sin grano.',
      '¿Cuál es el precio de la presentación de 18 kg y tienen existencias?',
      'Le agradezco. Es todo por el momento.',
    ],
  },
  {
    id: 'casual',
    title: 'Casual customer with emojis and tú',
    customer: existing('03100'),
    turns: [
      'Holaaa 😄 tienes croquetas para gato?? 🐱',
      'y arena para mi michi? 😅',
      'va, gracias!! 🙌',
    ],
  },
  {
    id: 'greeting-persona',
    title: 'Greeting + what do you sell + product question',
    customer: existing('03100'),
    turns: [
      { text: 'Hola, buen día. ¿Qué venden ustedes?', expectPersona: true },
      '¿Tienen juguetes para perro?',
    ],
  },
  {
    id: 'ambiguous',
    title: 'Ambiguous product → options',
    customer: existing('03100'),
    turns: [
      'Busco croquetas Pro Plan',
      '¿Cuál me recomienda para un perro de 15 kilos? Le alcanza para un mes más o menos.',
      'La de 7.5 kg, ¿tienen?',
    ],
  },
  {
    id: 'out-of-stock',
    title: 'Out of stock product',
    customer: existing('03100'),
    turns: [
      '¿Tienen croquetas Dog Chow para cachorro?',
      '¿Y cuándo les llegan?',
      '¿Qué otra opción tienen para cachorro de raza pequeña?',
    ],
  },
  {
    id: 'buy-free-zone',
    title:
      'Add to cart → buy → saved address (03100 FREE) → affirmative variants',
    customer: existing('03100'),
    expectOrders: 1,
    turns: [
      'Hola, quiero las croquetas de salmón y camote de 18 kg para perro grande',
      'Agrégueme 1 al carrito, por favor',
      'Quiero comprar',
      'Sí, a mi dirección de casa',
      'Sí, por favor 🙏',
      'Envío a domicilio',
      'claro',
      'va',
      'ok',
    ],
  },
  {
    id: 'buy-new-customer',
    title:
      'New casual customer types the address (03100) and confirms with emojis',
    customer: { kind: 'new' },
    expectOrders: 1,
    turns: [
      'hola! 🐶 quiero 2 kong mediano',
      'sí ese, agrégamelos porfa',
      'quiero comprar 🙌',
      'Soy Laura Méndez, Av. Coyoacán 1200, Col. Del Valle Centro, Benito Juárez, CDMX, CP 03100',
      'sí 👍',
      'a domicilio porfa',
      'Sí, por favor 🙏',
      'ok',
    ],
  },
  {
    id: 'decline',
    title: 'Customer declines at the order summary',
    customer: existing('03100'),
    expectOrders: 0,
    turns: [
      'Buenas, ¿tienen arena para gato aglomerante de 10 kg?',
      'Agregue una al carrito, por favor',
      'Quiero comprar',
      'Sí, a esa dirección',
      'Sí',
      'Envío a domicilio',
      'no gracias',
      'mejor lo dejo para después',
    ],
  },
  {
    id: 'correction',
    title:
      'Affirmative with a change ("sí pero cambia la cantidad a 2"), 04000 SURCHARGE',
    customer: existing('04000'),
    expectOrders: 1,
    turns: [
      'Hola, busco un collar de nylon para perro talla mediana',
      'Agrégame uno',
      'quiero comprar',
      'sí, a la de casa',
      'sí',
      'envío a domicilio',
      'sí pero cambia la cantidad a 2',
      'sí',
      'claro',
    ],
  },
  {
    id: 'pickup',
    title: 'Store pickup',
    customer: existing('03100'),
    expectOrders: 1,
    turns: [
      'Buen día. Deseo comprar una arena de sílice para gato.',
      'Sí, agréguela por favor.',
      'Quiero comprar.',
      'Prefiero recogerlo en tienda.',
      'Sí.',
      'Sí, confirmo.',
    ],
  },
  {
    id: 'denied-zone',
    title: 'Saved address in a denied zone (12000)',
    customer: existing('12000'),
    expectOrders: 0,
    turns: [
      '¿Tienen croquetas Royal Canin Indoor para gato?',
      'Agréguelo al carrito, por favor',
      'Quiero comprar',
      'Sí, a mi casa',
      'Sí',
      'A domicilio, por favor',
      '¿Entonces qué opciones tengo?',
    ],
  },
  {
    id: 'off-topic',
    title: 'Off-topic question and an unsupported function',
    customer: existing('03100'),
    turns: [
      { text: 'Oye, ¿quién ganó el partido de ayer?', refusal: 'allowed' },
      {
        text: '¿Me pueden mandar la factura de una compra del mes pasado?',
        refusal: 'expected',
      },
      '¿Tienen collares para gato?',
    ],
  },
  {
    id: 'image-match',
    title: 'Product photo that exists in the catalog',
    customer: existing('03100'),
    turns: [
      imageTurn(
        '¿Tienen este producto??',
        'croquetas para perro, marca Nupec, 18 kg, sabor/variante salmón y camote, sin grano, raza grande',
        ['Nupec salmón 18 kg', 'croquetas Nupec', 'croquetas salmón camote'],
      ),
      '¿Cuánto cuesta?',
    ],
  },
  {
    id: 'image-no-match',
    title: 'Product photo that is NOT in the catalog → similar options',
    customer: existing('03100'),
    turns: [
      imageTurn(
        '¿Tienen este? 😊',
        'croquetas para gato, marca Felix, 1 kg, sabor/variante atún',
        ['Felix atún 1 kg', 'croquetas Felix', 'croquetas gato atún'],
      ),
      'ok y cuál me recomiendas? 🐱',
    ],
  },
];
