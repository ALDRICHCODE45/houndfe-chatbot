import type {
  CatalogItemResponse,
  StockCheckResponse,
  StockStatus,
} from '../../../src/chatbot-api/domain/dtos/catalog.dto';

/**
 * Small pet-store catalog for the conversation eval. Prices are integer MXN
 * cents. Covers variants, every stock status and a product > $500 so the
 * shipping credit rule has something to apply to.
 */
export interface FixtureVariant {
  variantId: string;
  option: string;
  value: string;
  priceCents: number;
  status: StockStatus;
  quantity: number | null;
}

export interface FixtureProduct {
  productId: string;
  name: string;
  brand: string | null;
  description: string;
  /** Used when the product has no variants. */
  priceCents: number | null;
  status: StockStatus;
  quantity: number | null;
  variants: FixtureVariant[];
}

const id = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vid = (p: number, v: number) =>
  `b0000000-0000-4000-8000-${String(p * 100 + v).padStart(12, '0')}`;

const plain = (
  n: number,
  name: string,
  brand: string | null,
  description: string,
  priceCents: number,
  status: StockStatus,
  quantity: number | null,
): FixtureProduct => ({
  productId: id(n),
  name,
  brand,
  description,
  priceCents,
  status,
  quantity,
  variants: [],
});

const withVariants = (
  n: number,
  name: string,
  brand: string | null,
  description: string,
  option: string,
  variants: Array<[string, number, StockStatus, number | null]>,
): FixtureProduct => {
  const list = variants.map(([value, priceCents, status, quantity], i) => ({
    variantId: vid(n, i + 1),
    option,
    value,
    priceCents,
    status,
    quantity,
  }));
  const total = list.reduce((sum, v) => sum + (v.quantity ?? 0), 0);
  return {
    productId: id(n),
    name,
    brand,
    description,
    priceCents: null,
    status: total === 0 ? 'out_of_stock' : 'available',
    quantity: total,
    variants: list,
  };
};

export const CATALOG: FixtureProduct[] = [
  plain(
    1,
    'Croquetas Naturales Sin Grano de Salmón y Camote para Perros Adultos de Raza Grande 18 kg',
    'Nupec',
    'Alimento seco para perro adulto raza grande, sin grano, salmón y camote.',
    159900,
    'available',
    8,
  ),
  withVariants(
    2,
    'Croquetas Pro Plan Adulto Raza Mediana',
    'Pro Plan',
    'Alimento seco para perro adulto de raza mediana, pollo y arroz.',
    'Tamaño',
    [
      ['3 kg', 64900, 'available', 12],
      ['7.5 kg', 129900, 'low_stock', 2],
      ['15 kg', 219900, 'out_of_stock', 0],
    ],
  ),
  withVariants(
    3,
    'Croquetas Royal Canin Mini Adult para Perro',
    'Royal Canin',
    'Alimento seco para perro adulto de raza pequeña.',
    'Tamaño',
    [
      ['2 kg', 52900, 'available', 9],
      ['4 kg', 94900, 'available', 5],
    ],
  ),
  plain(
    4,
    'Croquetas Dog Chow Cachorro Raza Pequeña 4 kg',
    'Purina Dog Chow',
    'Alimento seco para cachorro de raza pequeña.',
    38900,
    'out_of_stock',
    0,
  ),
  plain(
    5,
    'Croquetas Whiskas Gato Adulto Sabor Pescado 3 kg',
    'Whiskas',
    'Alimento seco para gato adulto sabor pescado.',
    32900,
    'available',
    15,
  ),
  plain(
    6,
    'Croquetas Royal Canin Indoor para Gato 1.5 kg',
    'Royal Canin',
    'Alimento seco para gato adulto que vive en interiores.',
    49900,
    'low_stock',
    3,
  ),
  withVariants(
    7,
    "Croquetas Hill's Science Diet Gato Adulto Esterilizado",
    "Hill's",
    'Alimento seco para gato adulto esterilizado, control de peso.',
    'Tamaño',
    [
      ['1.6 kg', 54900, 'available', 6],
      ['3.2 kg', 98900, 'out_of_stock', 0],
    ],
  ),
  withVariants(
    8,
    'Arena para Gato Aglomerante Sin Aroma',
    "Pet's Choice",
    'Arena aglomerante de bentonita, sin aroma.',
    'Peso',
    [
      ['10 kg', 21900, 'available', 20],
      ['20 kg', 38900, 'available', 10],
    ],
  ),
  plain(
    9,
    'Arena para Gato de Sílice 3.8 L',
    "Pet's Choice",
    'Arena de cristales de sílice, control de olores.',
    17900,
    'low_stock',
    2,
  ),
  withVariants(
    10,
    'Juguete Kong Classic para Perro',
    'Kong',
    'Juguete de hule resistente rellenable con premios.',
    'Tamaño',
    [
      ['Chico', 24900, 'available', 7],
      ['Mediano', 32900, 'available', 4],
      ['Grande', 42900, 'out_of_stock', 0],
    ],
  ),
  plain(
    11,
    'Pelota de Hule con Sonido para Perro',
    null,
    'Pelota de hule con chillido, 7 cm.',
    8900,
    'not_managed',
    null,
  ),
  withVariants(
    12,
    'Collar Ajustable de Nylon para Perro',
    null,
    'Collar de nylon con hebilla de liberación rápida.',
    'Talla',
    [
      ['Chica', 14900, 'available', 10],
      ['Mediana', 14900, 'available', 8],
      ['Grande', 14900, 'low_stock', 1],
    ],
  ),
  plain(
    13,
    'Collar con Cascabel para Gato',
    null,
    'Collar elástico de seguridad con cascabel.',
    7900,
    'available',
    25,
  ),
];

const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.\s]/g, ' ');

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'para',
  'con',
  'sin',
  'y',
  'en',
  'un',
  'una',
  'que',
  'tienen',
  'tiene',
  'hay',
  'me',
  'mi',
  'por',
  'favor',
]);

const tokens = (value: string) =>
  normalize(value)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    // Light plural folding: "croquetas" ~ "croqueta", "perros" ~ "perro".
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));

/** Token-overlap search, best matches first; mirrors a fuzzy backend search. */
export function searchFixture(q: string, limit = 10): FixtureProduct[] {
  const query = tokens(q);
  if (query.length === 0) return [];
  return CATALOG.map((product) => {
    const haystack = new Set(
      tokens(
        `${product.name} ${product.brand ?? ''} ${product.description} ${product.variants
          .map((v) => v.value)
          .join(' ')}`,
      ),
    );
    const score = query.filter((t) => haystack.has(t)).length;
    return { product, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.product);
}

export function findProduct(productId: string): FixtureProduct | undefined {
  return CATALOG.find((p) => p.productId === productId);
}

export function unitPrice(
  productId: string,
  variantId?: string | null,
): number {
  const product = findProduct(productId);
  if (product === undefined) throw new Error(`unknown product ${productId}`);
  if (variantId) {
    const variant = product.variants.find((v) => v.variantId === variantId);
    if (variant === undefined) throw new Error(`unknown variant ${variantId}`);
    return variant.priceCents;
  }
  return (
    product.priceCents ?? Math.min(...product.variants.map((v) => v.priceCents))
  );
}

export function toCatalogItem(product: FixtureProduct): CatalogItemResponse {
  const prices = product.variants.map((v) => v.priceCents);
  return {
    productId: product.productId,
    name: product.name,
    brand: product.brand,
    imageUrl: null,
    description: product.description,
    price: {
      priceCents: product.priceCents,
      fromPriceCents: prices.length > 0 ? Math.min(...prices) : null,
      promoPriceCents: null,
      promotionEvaluationStatus: 'needs_human_review',
    },
    stock: { status: product.status, quantity: product.quantity },
    packageInfo: { weightGrams: null, dimensions: null },
    variants: product.variants.map((v) => ({
      variantId: v.variantId,
      name: `${product.name} ${v.value}`,
      option: v.option,
      value: v.value,
      priceCents: v.priceCents,
      stock: { status: v.status, quantity: v.quantity },
    })),
  };
}

export function toStockCheck(product: FixtureProduct): StockCheckResponse {
  return {
    productId: product.productId,
    name: product.name,
    stock: { status: product.status, quantity: product.quantity },
    variants: product.variants.map((v) => ({
      variantId: v.variantId,
      name: `${product.name} ${v.value}`,
      option: v.option,
      value: v.value,
      stock: { status: v.status, quantity: v.quantity },
    })),
  };
}
